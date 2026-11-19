// 扫码配对（worker/sync-pair.ts、docs/sync-api.md「扫码配对」）：一次性码过期、复用、错码不作废、未登录不能生成；
// 兑换成功即启用同步，换到的令牌能用于 /api/sync/v1；网页凭码查结果，失败不丢码。只用虚构数据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import type { Env } from '../worker/env.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { syncState } from '../worker/sync-mode.ts';
import { createPairCode, PAIR_TTL_MS, pairStatus, redeemPairCode } from '../worker/sync-pair.ts';
import { loadState } from '../worker/store.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
hook.deregister();

async function fresh(dev = true) {
  const env = { DB: openD1(':memory:'), ...(dev ? { DEV_BYPASS_AUTH: '1' } : {}) } as unknown as Env;
  await ensureMigrated(env);
  await loadState(env);
  return env;
}
const call = (env: Env, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://example.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }), env);
const redeem = (env: Env, code: string, name = 'Fictional iPhone') => call(env, '/api/sync/v1/pair/redeem', { code, name });
const pairRows = async (env: Env) => Number(((await env.DB.prepare('SELECT count(*) AS n FROM sync_pair').first()) as { n: number }).n);

test('网页会话生成配对码 → App 兑换：拿到令牌、同步启用、令牌可用于 /api/sync/v1，码只能用一次', async () => {
  const env = await fresh();
  const created = await call(env, '/api/sync/pair');
  assert.equal(created.status, 200);
  const { code, expiresAt, ttlMs } = (await created.json()) as { code: string; expiresAt: string; ttlMs: number };
  assert.equal(ttlMs, PAIR_TTL_MS);
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - PAIR_TTL_MS) < 5000);
  // 只存哈希
  const stored = (await env.DB.prepare('SELECT hash FROM sync_pair').first()) as { hash: string };
  assert.notEqual(stored.hash, code.replace(/-/g, ''));
  assert.equal((await syncState(env)).mode, 'off');

  // 小写、空格输入也认
  const r = await redeem(env, ` ${code.toLowerCase().replace(/-/g, ' ')} `);
  assert.equal(r.status, 200);
  const got = (await r.json()) as { token: string; id: string; name: string };
  assert.match(got.token, /^cal_sync_/);
  assert.equal(got.name, 'Fictional iPhone');
  assert.equal((await syncState(env)).mode, 'tokens');
  assert.equal((await syncState(env)).triggers, 12);

  const sync = await worker.fetch(
    new Request('https://example.test/api/sync/v1/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${got.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, reqId: 'r', installId: 'fictional-install', ledgerId: null, drEpoch: null, register: true, cookie: null, ackedMid: 0, mutations: [] }),
    }),
    env,
  );
  assert.equal(sync.status, 200);
  assert.equal(((await sync.json()) as { full: boolean }).full, true);
  const list = (await (await worker.fetch(new Request('https://example.test/api/sync/tokens'), env)).json()) as Array<{ id: string }>;
  assert.deepEqual(
    list.map((x) => x.id),
    [got.id],
  );

  // 网页凭码查到的是这个码换出的令牌
  const st = await call(env, '/api/sync/pair/status', { code });
  assert.deepEqual(await st.json(), { status: 'connected', device: { id: got.id, name: 'Fictional iPhone' } });

  // 复用
  const again = await redeem(env, code);
  assert.equal(again.status, 401);
  assert.equal(((await again.json()) as { code: string }).code, 'invalid_code');
});

test('过期：5 分钟后兑换 410 code_expired，查询为 expired；不是当前码 401', async () => {
  const env = await fresh();
  const t0 = Date.now();
  const { code } = await createPairCode(env, t0);
  await assert.rejects(redeemPairCode(env, code, 'x', t0 + PAIR_TTL_MS), { status: 410, code: 'code_expired' });
  assert.deepEqual(await pairStatus(env, code, t0 + PAIR_TTL_MS), { status: 'expired' });
  await assert.rejects(redeemPairCode(env, 'DDDD-DDDD-DDDD', 'x', t0 + PAIR_TTL_MS), { status: 401, code: 'invalid_code' });
  assert.equal((await syncState(env)).mode, 'off');
});

test('错码不作废主人的码：未登录的人连错多少次，正确码仍可兑换（不设全局错次上限）', async () => {
  const env = await fresh();
  const a = await createPairCode(env);
  for (let i = 0; i < 20; i++) assert.equal((await redeem(env, 'AAAA-AAAA-AAAA')).status, 401);
  assert.deepEqual((await pairStatus(env, a.code)).status, 'pending');
  assert.equal((await redeem(env, a.code)).status, 200);
});

test('至多一个码：新码覆盖旧码，旧码 401、查询为 invalid', async () => {
  const env = await fresh();
  const a = await createPairCode(env);
  const b = await createPairCode(env);
  assert.equal(await pairRows(env), 1);
  assert.equal((await redeem(env, a.code)).status, 401);
  assert.deepEqual(await pairStatus(env, a.code), { status: 'invalid' });
  assert.equal((await redeem(env, b.code)).status, 200);
});

test('查询只认这个码换出的令牌：别处手动签发不算连上；查询要网页登录', async () => {
  const env = await fresh();
  const { code } = await createPairCode(env);
  assert.equal((await call(env, '/api/sync/tokens', { name: 'Manual' })).status, 200);
  const st = (await (await call(env, '/api/sync/pair/status', { code })).json()) as { status: string; expiresAt?: string };
  assert.equal(st.status, 'pending');
  assert.ok(st.expiresAt);
  assert.equal((await call(env, '/api/sync/pair/status', {})).status, 400);
  const anon = await fresh(false);
  const c2 = await createPairCode(anon);
  assert.equal((await call(anon, '/api/sync/pair/status', { code: c2.code }, { origin: 'https://example.test' })).status, 401);
});

test('兑换失败不丢码：令牌批次出错时 503 pair_failed，码仍有效，重试成功', async () => {
  const env = await fresh();
  const { code } = await createPairCode(env);
  const batch = env.DB.batch.bind(env.DB);
  let fail = true;
  env.DB.batch = (async (s: D1PreparedStatement[]) => {
    if (fail) {
      fail = false;
      throw new Error('D1_ERROR: fictional storage hiccup');
    }
    return batch(s);
  }) as typeof env.DB.batch;
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await redeem(env, code);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { code: string }).code, 'pair_failed');
  } finally {
    console.error = orig;
  }
  assert.equal((await pairStatus(env, code)).status, 'pending');
  assert.equal((await syncState(env)).mode, 'off');
  assert.equal((await redeem(env, code)).status, 200);
});

test('并发兑换同一个码：只有一个拿到令牌', async () => {
  const env = await fresh();
  const { code } = await createPairCode(env);
  const rs = await Promise.all([redeem(env, code, 'A'), redeem(env, code, 'B'), redeem(env, code, 'C')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 401, 401]);
  const n = Number(((await env.DB.prepare('SELECT count(*) AS n FROM sync_tokens').first()) as { n: number }).n);
  assert.equal(n, 1);
});

test('未登录不能生成配对码；兑换不需要登录但要合法请求体', async () => {
  const env = await fresh(false);
  const r = await call(env, '/api/sync/pair', {}, { origin: 'https://example.test' });
  assert.equal(r.status, 401);
  assert.equal(await pairRows(env), 0);
  assert.equal((await call(env, '/api/sync/v1/pair/redeem', { name: 'x' })).status, 400);
  assert.equal((await worker.fetch(new Request('https://example.test/api/sync/v1/pair/redeem', { method: 'POST', body: 'not json' }), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://example.test/api/sync/v1/pair/redeem'), env)).status, 405);
  // 有码时未登录也能兑换（App 侧）
  const { code } = await createPairCode(env);
  assert.equal((await redeem(env, code)).status, 200);
});

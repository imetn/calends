// 现有写路径的并发守卫（sync-design 5.3，worker/write-guard.ts）：网页 REST、MCP 写工具的「读 → 计算 → 写」
// 在别处抢先写入时整段重读重算一次，仍冲突返回 409 / 工具错误；网页编辑旧快照带 If-Match 时不覆盖别处的写入。
// 只用虚构数据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import type { Env } from '../worker/env.ts';
import type { Subscription } from './types.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { createSyncToken } from '../worker/sync-auth.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { getRev, loadState } from '../worker/store.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
const { runSync, parseSyncRequest } = await import('../worker/sync.ts');
hook.deregister();

const DAY = '2026-03-10';
type Stmt = { sql: string };

/** 虚构账本；race(n) 让接下来 n 次带守卫的提交之前先有一次「别处的写入」（直接 SQL，涨序号） */
async function fixture() {
  const db = openD1(':memory:');
  const env = { DB: db, DEV_BYPASS_AUTH: '1' } as unknown as Env;
  await ensureMigrated(env);
  await loadState(env);
  const sub = { id: 's1', name: 'Fictional', price: 9, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-05', notes: 'old' };
  await db.prepare('INSERT INTO subscriptions (id, data) VALUES (?1, ?2)').bind('s1', JSON.stringify(sub)).run();
  let races = 0;
  let rival = (): void => {
    db.prepare("UPDATE subscriptions SET data = json_set(data, '$.account', 'rival') WHERE id = 's1'").exec();
  };
  const batch = db.batch.bind(db);
  db.batch = async (stmts: Stmt[]) => {
    if (races > 0 && stmts[0]?.sql.includes('write_cas') && stmts[0].sql.includes("key = 'rev'")) {
      races--;
      rival();
    }
    return batch(stmts as never);
  };
  const web = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://example.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } }), env);
  const raw = async (id = 's1') =>
    JSON.parse(((await db.prepare('SELECT data FROM subscriptions WHERE id = ?1').bind(id).first()) as { data: string }).data) as Subscription & {
      account?: string;
    };
  return {
    env,
    db,
    web,
    raw,
    race: (n: number, fn?: () => void) => {
      races = n;
      if (fn) rival = fn;
    },
    get pending() {
      return races;
    },
  };
}

test('网页 REST：读改写期间别处抢先写入 → 整段重算一次，两边的改动都在', async () => {
  const f = await fixture();
  const cur = (await (await f.web('/api/state')).json()) as { subscriptions: Subscription[] };
  const s1 = cur.subscriptions.find((x) => x.id === 's1')!;
  f.race(1);
  // 不带 If-Match（旧网页）：行为不变，仍成功；重算后服务端在新快照上执行
  const r = await f.web('/api/subscriptions/s1', { method: 'PUT', body: JSON.stringify({ ...s1, name: 'Renamed' }) });
  assert.equal(r.status, 200);
  assert.equal(f.pending, 0);
  assert.equal((await f.raw()).name, 'Renamed');
});

test('网页 REST：每次提交前都被抢先 → 409 write_conflict，账本不被这次请求改动', async () => {
  const f = await fixture();
  const before = await getRev(f.env);
  f.race(5);
  const r = await f.web('/api/settings', { method: 'PUT', body: JSON.stringify({ notifyHour: 7 }) });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { code: string; error: string };
  assert.equal(body.code, 'write_conflict');
  assert.ok(body.error.length > 0);
  assert.equal(f.pending, 3, '只重算一次：两次提交各被抢先一次');
  assert.notEqual((await loadState(f.env)).settings.notifyHour, 7);
  assert.equal(await getRev(f.env), before + 2, '只有两次「别处的写入」涨了序号');
});

test('网页 REST：设置的读改写不再盖掉并发写入的其他字段', async () => {
  const f = await fixture();
  f.race(1, () => {
    f.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('settings', '{\"timezone\":\"Asia/Tokyo\"}') ON CONFLICT(key) DO UPDATE SET value = json_set(value, '$.timezone', 'Asia/Tokyo')",
      )
      .exec();
  });
  const r = await f.web('/api/settings', { method: 'PUT', body: JSON.stringify({ notifyHour: 7 }) });
  assert.equal(r.status, 200);
  const s = (await loadState(f.env)).settings;
  assert.equal(s.notifyHour, 7);
  assert.equal(s.timezone, 'Asia/Tokyo');
});

test('审查 P1-3 反例：网页用旧快照保存改名（带 If-Match）→ 409，同步写入的备注保留', async () => {
  const f = await fixture();
  const cur = (await (await f.web('/api/state')).json()) as { subscriptions: Subscription[] };
  const stale = cur.subscriptions.find((x) => x.id === 's1')!;
  assert.equal(stale.notes, 'old');
  // 同步写入备注
  const { token } = await createSyncToken(f.env, 'Fictional phone');
  assert.ok(token);
  const base = { protocol: 1, installId: 'install-a' };
  const reg = await runSync(f.env, parseSyncRequest({ ...base, reqId: 'r0', register: true }));
  const { ledgerId, drEpoch, cookie } = reg.body as Record<string, unknown>;
  const pushed = await runSync(
    f.env,
    parseSyncRequest({
      ...base,
      reqId: 'r1',
      ledgerId,
      drEpoch,
      cookie,
      ackedMid: 0,
      mutations: [{ mid: 1, op: { name: 'patch@1', target: 'sub/s1', at: { date: DAY }, fields: { notes: { from: 'old', to: 'sync note' } } } }],
    }),
  );
  assert.deepEqual((pushed.body as { rejections: unknown[] }).rejections, []);
  assert.equal((await f.raw()).notes, 'sync note');
  // 网页拿旧快照改名
  const r = await f.web('/api/subscriptions/s1', {
    method: 'PUT',
    headers: { 'if-match': JSON.stringify(stale.updatedAt ?? '-') },
    body: JSON.stringify({ ...stale, name: 'Renamed' }),
  });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code: string }).code, 'write_conflict');
  const now = await f.raw();
  assert.equal(now.notes, 'sync note');
  assert.equal(now.name, 'Fictional');
  // 按最新快照重做则成功，且 If-Match 换成新的 updatedAt
  const fresh = ((await (await f.web('/api/state')).json()) as { subscriptions: Subscription[] }).subscriptions.find((x) => x.id === 's1')!;
  const ok = await f.web('/api/subscriptions/s1', {
    method: 'PUT',
    headers: { 'if-match': JSON.stringify(fresh.updatedAt) },
    body: JSON.stringify({ ...fresh, name: 'Renamed' }),
  });
  assert.equal(ok.status, 200);
  const saved = (await ok.json()) as Subscription;
  assert.equal(saved.notes, 'sync note');
  // 同一条连续保存：用上一次返回的 updatedAt 作 If-Match
  const again = await f.web('/api/subscriptions/s1', {
    method: 'PUT',
    headers: { 'if-match': JSON.stringify(saved.updatedAt) },
    body: JSON.stringify({ ...saved, name: 'Renamed twice' }),
  });
  assert.equal(again.status, 200);
});

test('If-Match：记录已被别处删除 → 409，不把旧快照写回来；没有 updatedAt 的旧记录用 "-"', async () => {
  const f = await fixture();
  const stale = (await f.raw()) as Subscription;
  assert.equal(stale.updatedAt, undefined);
  // "-" 与仍没有 updatedAt 的记录相符
  const r1 = await f.web('/api/subscriptions/s1', { method: 'PUT', headers: { 'if-match': '"-"' }, body: JSON.stringify({ ...stale, name: 'A' }) });
  assert.equal(r1.status, 200);
  // 已有 updatedAt 后再用 "-" 不符
  const r2 = await f.web('/api/subscriptions/s1', { method: 'PUT', headers: { 'if-match': '"-"' }, body: JSON.stringify({ ...stale, name: 'B' }) });
  assert.equal(r2.status, 409);
  await f.db.prepare("DELETE FROM subscriptions WHERE id = 's1'").run();
  const r3 = await f.web('/api/subscriptions/s1', { method: 'PUT', headers: { 'if-match': '"x"' }, body: JSON.stringify({ ...stale, name: 'C' }) });
  assert.equal(r3.status, 409);
  assert.equal(await f.db.prepare("SELECT 1 FROM subscriptions WHERE id = 's1'").first(), null);
});

test('MCP 写工具：被抢先一次重算后成功，持续被抢先返回工具错误；读工具不受影响', async () => {
  const f = await fixture();
  const { token } = await createToken(f.env, 'Fictional MCP', 'write');
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await worker.fetch(
      new Request('https://example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      f.env,
    );
    return ((await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  f.race(1);
  const ok = await call('update_subscription', { subscription: 's1', set: { notes: 'mcp note' } });
  assert.equal(ok.isError, undefined);
  const now = await f.raw();
  assert.equal(now.notes, 'mcp note');
  assert.equal(now.account, 'rival', '重算在新快照上执行，别处写入的字段保留');
  f.race(5);
  const bad = await call('update_subscription', { subscription: 's1', set: { notes: 'lost' } });
  assert.equal(bad.isError, true);
  assert.equal(f.pending, 3);
  assert.equal((await f.raw()).notes, 'mcp note');
  f.race(0);
  const read = await call('list_subscriptions', {});
  assert.equal(read.isError, undefined);
});

test('守卫作用域外（定时任务、迁移、恢复）不加守卫语句', async () => {
  const f = await fixture();
  const seen: string[] = [];
  const batch = f.db.batch;
  f.db.batch = async (stmts: Stmt[]) => {
    seen.push(stmts[0]?.sql ?? '');
    return batch(stmts);
  };
  const { putKv } = await import('../worker/store.ts');
  await putKv(f.env, 'prefs', { theme: 'dark' });
  assert.ok(!seen.some((s) => s.includes('write_cas')));
});

// App 同步接口（docs/sync-api.md）的服务器侧单元测试：路由与鉴权、整请求校验、批量与逐个执行同口径、
// 提交守卫与重算、代际轮换、按库迁移。只用虚构数据；完整时序与故障用例见 scripts/sync-contract.test.mjs。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import type { Env } from '../worker/env.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { loadState, replaceAll } from '../worker/store.ts';
import { contentHash } from './sync-check.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
const { runSync, parseSyncRequest, disasterRecovery } = await import('../worker/sync.ts');
hook.deregister();

const DAY = '2026-03-10';

async function fixture() {
  const env = { DB: openD1(':memory:'), DEV_BYPASS_AUTH: '1' } as unknown as Env;
  await ensureMigrated(env);
  await loadState(env);
  const { token } = await createToken(env, 'Fixture sync', 'write');
  const { token: readToken } = await createToken(env, 'Fixture read', 'read');
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) =>
    worker.fetch(
      new Request(`https://example.test/api/sync/v1/${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      }),
      env,
    );
  const meta = async () =>
    Object.fromEntries(((await env.DB.prepare('SELECT key, value FROM sync_meta').all()).results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  return { env, token, readToken, call, meta };
}

type Body = Record<string, unknown> & { objects?: Array<[string, unknown]>; rejections?: Array<{ mid: number; code: string }> };

/** 一台虚构设备：注册后按序推送操作 */
async function device(env: Env, installId = 'install-a') {
  let ledgerId: string | null = null;
  let drEpoch: string | null = null;
  let cookie: unknown = null;
  let mid = 0;
  const send = async (body: Record<string, unknown>, opts = {}) => {
    const r = await runSync(env, parseSyncRequest({ protocol: 1, reqId: `r${mid}`, installId, ledgerId, drEpoch, cookie, ...body }), opts);
    const b = r.body as Body;
    if (r.status === 200 && !b.gone && !b.ledgerMismatch) {
      ledgerId = b.ledgerId as string;
      drEpoch = b.drEpoch as string;
      cookie = b.cookie;
    }
    return { status: r.status, body: b };
  };
  const reg = await send({ register: true });
  assert.equal(reg.status, 200);
  return {
    send,
    push: (ops: Array<Record<string, unknown>>, opts = {}) => send({ ackedMid: mid, mutations: ops.map((op) => ({ mid: ++mid, op: { at: { date: DAY }, ...op } })) }, opts),
    get mid() {
      return mid;
    },
    get cookie() {
      return cookie;
    },
  };
}

test('hello 可匿名，鉴权后带规模与 ledgerId；同步只认写权限 Bearer，网页 Cookie 与只读令牌都 401', async () => {
  const f = await fixture();
  const anon = await (await f.call('hello')).json();
  assert.equal(anon.protocol, 1);
  assert.equal(anon.ops['create_subscription'][0], 1);
  assert.equal(anon.ledgerId, undefined);
  const authed = await (await f.call('hello', { token: f.token })).json();
  assert.deepEqual(authed.counts, { sub: 0, method: 0, people: 0 });
  assert.match(authed.ledgerId, /^[0-9a-f]{16,}$/);
  const body = JSON.stringify({ protocol: 1, installId: 'x', register: true });
  // DEV_BYPASS_AUTH 让网页接口免登录，同步接口仍不认
  assert.equal((await f.call('sync', { method: 'POST', body })).status, 401);
  assert.equal((await f.call('sync', { method: 'POST', body, token: f.readToken })).status, 401);
  assert.equal((await f.call('sync', { method: 'POST', body, token: 'sub_fictional_wrong' })).status, 401);
  assert.equal((await f.call('sync', { method: 'POST', body, token: f.token })).status, 200);
  assert.equal((await f.call('sync', { method: 'GET', token: f.token })).status, 405);
  assert.equal((await f.call('nope', { token: f.token })).status, 404);
});

test('整请求校验：格式 400、协议 426、操作版本 426、超量 413、注册不带操作、未绑定账本不许写', async () => {
  const f = await fixture();
  const post = async (b: unknown) => {
    const r = await f.call('sync', { method: 'POST', body: JSON.stringify(b), token: f.token });
    return [r.status, (await r.json()).code];
  };
  const op = (name: string) => ({ mid: 1, op: { name, at: { date: DAY } } });
  assert.deepEqual(await post([]), [400, 'invalid_request']);
  assert.deepEqual(await post({ protocol: 2, installId: 'x' }), [426, 'server_too_old']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('noop@2')] }), [426, 'op_version']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('get_state@1')] }), [426, 'op_version']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: Array.from({ length: 301 }, (_, i) => ({ ...op('noop@1'), mid: i + 1 })) }), [413, 'too_many_mutations']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('noop@1'), op('noop@1')] }), [400, 'invalid_request']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', register: true, mutations: [op('noop@1')] }), [400, 'register_with_mutations']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('noop@1')] }), [400, 'ledger_required']);
});

test('注册、推送、拉取：恰好一次，重发不重复执行，拒绝不写数据但推进编号', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const create = { name: 'create_subscription@1', args: { id: 's1', name: 'Fictional Svc', price: 9.99, currency: 'USD', cycle: { unit: 'month' }, start: DAY, force: true } };
  const pay = { name: 'record_payment@1', target: 'sub/s1', args: { subscription: 's1', date: DAY, amount: 9.99 } };
  const r1 = await a.push([create, pay]);
  assert.equal(r1.body.lastMutationId, 2);
  assert.deepEqual(r1.body.rejections, []);
  assert.ok(r1.body.objects!.some(([k]) => k === 'sub/s1'));
  // 响应丢失后重发同一批：已执行的跳过
  const again = await a.send({ ackedMid: 0, mutations: [{ mid: 1, op: { ...create, at: { date: DAY } } }, { mid: 2, op: { ...pay, at: { date: DAY } } }] });
  assert.equal(again.body.lastMutationId, 2);
  const s = (await loadState(f.env)).subscriptions[0];
  assert.equal(s.payments?.length, 1);
  // 目标已删：拒绝、不写数据、编号推进
  const r2 = await a.push([{ name: 'delete@1', target: 'sub/s1' }, { name: 'patch@1', target: 'sub/s1', fields: { name: { from: 'Fictional Svc', to: 'X' } } }]);
  assert.equal(r2.body.lastMutationId, 4);
  assert.deepEqual(
    r2.body.rejections!.map((r) => [r.mid, r.code]),
    [[4, 'target_deleted']],
  );
  assert.equal((await loadState(f.env)).subscriptions.length, 0);
  // 增量拉取带回删除标记
  assert.deepEqual(r2.body.objects!.find(([k]) => k === 'sub/s1'), ['sub/s1', null]);
  // 编号缺口：本批不执行，告知期望编号
  const gap = await a.send({ ackedMid: 4, mutations: [{ mid: 7, op: { name: 'noop@1' } }] });
  assert.equal(gap.body.expected, 5);
  assert.equal(gap.body.lastMutationId, 4);
});

test('批量执行与逐个调用 MCP 写工具结果一致（同一 JSON 文本）', async () => {
  const steps: Array<[string, Record<string, unknown>]> = [
    ['update_payment_method', { action: 'create', id: 'm1', set: { name: 'Fictional Card', kind: 'prepaid', currency: 'USD', balance: 100 } }],
    ['create_subscription', { id: 's1', name: 'Fictional Svc', price: 12, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', method: 'm1', force: true }],
    ['record_payment', { subscription: 's1', date: '2026-02-05', amount: 12, allow_duplicate: true }],
    ['update_payment_method', { method: 'm1', top_up: { amount: 50, date: DAY } }],
    ['update_subscription', { subscription: 's1', set: { notes: 'fictional note', tags: ['x'] } }],
    ['change_price', { subscription: 's1', amount: 15, from: '2026-03-05' }],
    ['save_person', { action: 'create', id: 'p1', set: { name: 'Fictional Person' } }],
    ['update_settings', { set: { weekStart: 1, remindDays: 5 } }],
  ];
  const dump = async (env: Env) => ({
    subs: (await env.DB.prepare('SELECT id, data FROM subscriptions ORDER BY id').all()).results,
    methods: (await env.DB.prepare('SELECT id, data FROM methods ORDER BY id').all()).results,
    kv: (await env.DB.prepare("SELECT key, value FROM kv WHERE key IN ('settings', 'people') ORDER BY key").all()).results,
  });
  const strip = (rows: Awaited<ReturnType<typeof dump>>) => JSON.parse(JSON.stringify(rows).replace(/"updatedAt\\":\\"[^\\]+\\"/g, '"updatedAt\\":\\"T\\"'));

  const one = await fixture();
  const tools = new Map(TOOLS.map((x) => [x.name, x]));
  for (const [name, args] of steps) await tools.get(name)!.run(args, { env: one.env, access: { client: 'mcp', scope: 'write' }, today: DAY });

  const batch = await fixture();
  const a = await device(batch.env);
  const r = await a.push(steps.map(([name, args]) => ({ name: `${name}@1`, args })));
  assert.deepEqual(r.body.rejections, []);
  assert.deepEqual(strip(await dump(batch.env)), strip(await dump(one.env)));
});

test('提交守卫：读算写之间账本被改则重算；一直被改 3 次后 503，不留半截写入', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([{ name: 'create_subscription@1', args: { id: 's1', name: 'Fictional Svc', price: 5, currency: 'USD', cycle: { unit: 'month' }, start: DAY, force: true } }]);
  let n = 0;
  const bump = async () => {
    n++;
    await f.env.DB.prepare('INSERT INTO subscriptions (id, data) VALUES (?1, ?2)').bind(`web${n}`, JSON.stringify({ id: `web${n}`, name: `Web ${n}`, price: 1, currency: 'USD' })).run();
  };
  // 第一次提交前网页插一条：重算后成功，两边都在
  let first = true;
  const once = await a.push([{ name: 'patch@1', target: 'sub/s1', fields: { notes: { from: null, to: 'n1' } } }], {
    beforeCommit: async () => {
      if (first) {
        first = false;
        await bump();
      }
    },
  });
  assert.equal(once.status, 200);
  assert.equal(once.body.lastMutationId, 2);
  assert.equal((await loadState(f.env)).subscriptions.find((s) => s.id === 's1')?.notes, 'n1');
  // 每次都被抢先：503，本安装的编号与数据都没动
  const busy = await a.push([{ name: 'patch@1', target: 'sub/s1', fields: { notes: { from: 'n1', to: 'n2' } } }], { beforeCommit: bump });
  assert.equal(busy.status, 503);
  assert.equal(((await f.env.DB.prepare("SELECT last_mutation_id AS n FROM sync_clients WHERE install_id = 'install-a'").first()) as { n: number }).n, 2);
  assert.equal((await loadState(f.env)).subscriptions.find((s) => s.id === 's1')?.notes, 'n1');
  assert.equal(((await f.env.DB.prepare('SELECT count(*) AS n FROM sync_cas').first()) as { n: number }).n, 0);
});

test('整体替换（导入覆盖、恢复备份、import_ledger、灾备）换代际；同值写入不涨序号', async () => {
  const f = await fixture();
  const head = async () => ((await f.env.DB.prepare('SELECT seq FROM sync_head').first()) as { seq: number }).seq;
  const g0 = (await f.meta()).generation;
  await replaceAll(f.env, [], [], 'merge');
  assert.equal((await f.meta()).generation, g0);
  await replaceAll(f.env, [], [], 'replace');
  const g1 = (await f.meta()).generation;
  assert.notEqual(g1, g0);

  const a = await device(f.env);
  await a.push([{ name: 'update_settings@1', args: { set: { weekStart: 1 } } }]);
  const h = await head();
  await a.push([{ name: 'update_settings@1', args: { set: { weekStart: 1 } } }]);
  assert.equal(await head(), h, '同值写入不涨');

  const settings = (await loadState(f.env)).settings as unknown as Record<string, unknown>;
  const r = await a.push([{ name: 'import_ledger@1', recoveryId: 'rec-1', objects: [['sub/s9', { id: 's9', name: 'Imported', price: 3, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: DAY }]] }]);
  assert.deepEqual(r.body.rejections, []);
  const g2 = (await f.meta()).generation;
  assert.notEqual(g2, g1);
  assert.deepEqual(
    (await loadState(f.env)).subscriptions.map((s) => s.id),
    ['s9'],
  );
  // 私有设置字段原地保留
  assert.equal(((await loadState(f.env)).settings as unknown as Record<string, unknown>).aiEnabled, settings.aiEnabled);

  const epoch = (await f.meta()).drEpoch;
  await disasterRecovery(f.env);
  const m = await f.meta();
  assert.notEqual(m.generation, g2);
  assert.notEqual(m.drEpoch, epoch);
  const after = await a.push([{ name: 'noop@1' }]);
  assert.ok(after.body.gone, '灾备后旧安装作废');
});

test('replace 期望哈希：不符 expect_failed，相符执行；设置按同步投影计算', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([{ name: 'save_person@1', args: { action: 'create', id: 'p1', set: { name: 'Fictional A' } } }]);
  const people = (await loadState(f.env)).people;
  const bad = await a.push([{ name: 'replace@1', target: 'kv/people', expect: { hash: 'f'.repeat(64) }, doc: [] }]);
  assert.equal(bad.body.rejections![0].code, 'expect_failed');
  const ok = await a.push([{ name: 'replace@1', target: 'kv/people', expect: { hash: await contentHash(people) }, doc: [] }]);
  assert.deepEqual(ok.body.rejections, []);
  assert.deepEqual((await loadState(f.env)).people, []);
});

test('自动迁移按库各自完成：同一进程两个库互不影响', async () => {
  const a = { DB: openD1(':memory:') } as unknown as Env;
  const b = { DB: openD1(':memory:') } as unknown as Env;
  await ensureMigrated(a);
  await ensureMigrated(b);
  for (const env of [a, b]) assert.ok(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_objects'").first());
  const ids = await Promise.all(
    [a, b].map(async (env) => ((await env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'ledgerId'").first()) as { value: string }).value),
  );
  assert.notEqual(ids[0], ids[1]);
});

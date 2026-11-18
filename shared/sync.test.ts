// App 同步接口（docs/sync-api.md）的服务器侧单元测试：路由与鉴权、整请求校验、批量与逐个执行同口径、
// 提交守卫与重算、代际轮换、按库迁移。只用虚构数据；完整时序与故障用例见 scripts/sync-contract.test.mjs。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import type { Env } from '../worker/env.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { createSyncToken } from '../worker/sync-auth.ts';
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
const { runSync, parseSyncRequest, disasterRecovery, changesSince } = await import('../worker/sync.ts');
const { SYNC_INTENTS } = await import('../worker/sync-ops.ts');
hook.deregister();

const DAY = '2026-03-10';

async function fixture() {
  const env = { DB: openD1(':memory:'), DEV_BYPASS_AUTH: '1' } as unknown as Env;
  await ensureMigrated(env);
  await loadState(env);
  const { token } = await createSyncToken(env, 'Fixture sync');
  const { token: mcpToken } = await createToken(env, 'Fixture MCP write', 'write');
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
    Object.fromEntries(
      ((await env.DB.prepare('SELECT key, value FROM sync_meta').all()).results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
    );
  return { env, token, mcpToken, readToken, call, meta };
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
    push: (ops: Array<Record<string, unknown>>, opts = {}) =>
      send({ ackedMid: mid, mutations: ops.map((op) => ({ mid: ++mid, op: { at: { date: DAY }, ...op } })) }, opts),
    get mid() {
      return mid;
    },
    get cookie() {
      return cookie;
    },
  };
}

test('hello 可匿名，鉴权后带规模与 ledgerId；同步只认同步令牌，网页 Cookie 与 MCP 令牌（含写权限）都 401', async () => {
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
  // 审查 P1-1：旧 MCP 写令牌不得获得同步（整本导入、清空）权限，hello 也不带规模
  assert.equal((await f.call('sync', { method: 'POST', body, token: f.mcpToken })).status, 401);
  assert.equal((await (await f.call('hello', { token: f.mcpToken })).json()).ledgerId, undefined);
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
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: Array.from({ length: 301 }, (_, i) => ({ ...op('noop@1'), mid: i + 1 })) }), [
    413,
    'too_many_mutations',
  ]);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('noop@1'), op('noop@1')] }), [400, 'invalid_request']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', register: true, mutations: [op('noop@1')] }), [400, 'register_with_mutations']);
  assert.deepEqual(await post({ protocol: 1, installId: 'x', mutations: [op('noop@1')] }), [400, 'ledger_required']);
});

test('注册、推送、拉取：恰好一次，重发不重复执行，拒绝不写数据但推进编号', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const create = {
    name: 'create_subscription@1',
    args: { id: 's1', name: 'Fictional Svc', price: 9.99, currency: 'USD', cycle: { unit: 'month' }, start: DAY, force: true },
  };
  const pay = { name: 'record_payment@1', target: 'sub/s1', args: { subscription: 's1', date: DAY, amount: 9.99 } };
  const r1 = await a.push([create, pay]);
  assert.equal(r1.body.lastMutationId, 2);
  assert.deepEqual(r1.body.rejections, []);
  assert.ok(r1.body.objects!.some(([k]) => k === 'sub/s1'));
  // 响应丢失后重发同一批：已执行的跳过
  const again = await a.send({
    ackedMid: 0,
    mutations: [
      { mid: 1, op: { ...create, at: { date: DAY } } },
      { mid: 2, op: { ...pay, at: { date: DAY } } },
    ],
  });
  assert.equal(again.body.lastMutationId, 2);
  const s = (await loadState(f.env)).subscriptions[0];
  assert.equal(s.payments?.length, 1);
  // 目标已删：拒绝、不写数据、编号推进
  const r2 = await a.push([
    { name: 'delete@1', target: 'sub/s1' },
    { name: 'patch@1', target: 'sub/s1', fields: { name: { from: 'Fictional Svc', to: 'X' } } },
  ]);
  assert.equal(r2.body.lastMutationId, 4);
  assert.deepEqual(
    r2.body.rejections!.map((r) => [r.mid, r.code]),
    [[4, 'target_deleted']],
  );
  assert.equal((await loadState(f.env)).subscriptions.length, 0);
  // 增量拉取带回删除标记
  assert.deepEqual(
    r2.body.objects!.find(([k]) => k === 'sub/s1'),
    ['sub/s1', null],
  );
  // 编号缺口：本批不执行，告知期望编号
  const gap = await a.send({ ackedMid: 4, mutations: [{ mid: 7, op: { name: 'noop@1' } }] });
  assert.equal(gap.body.expected, 5);
  assert.equal(gap.body.lastMutationId, 4);
});

test('批量执行与逐个调用 MCP 写工具结果一致（同一 JSON 文本）', async () => {
  const steps: Array<[string, Record<string, unknown>]> = [
    ['update_payment_method', { action: 'create', id: 'm1', set: { name: 'Fictional Card', kind: 'prepaid', currency: 'USD', balance: 100 } }],
    [
      'create_subscription',
      { id: 's1', name: 'Fictional Svc', price: 12, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', method: 'm1', force: true },
    ],
    ['record_payment', { subscription: 's1', date: '2026-02-05', amount: 12, allow_duplicate: true }],
    ['update_payment_method', { method: 'm1', top_up: { amount: 50, date: DAY } }],
    ['update_subscription', { subscription: 's1', set: { notes: 'fictional note', tags: ['x'] } }],
    ['change_price', { subscription: 's1', amount: 15, from: '2026-03-05' }],
    ['save_person', { action: 'create', id: 'p1', set: { name: 'Fictional Person' } }],
    ['update_settings', { set: { weekStart: 1, remindDays: 5 } }],
  ];
  // 同步路径上修改类意图要带 target 与冻结的期望（docs/sync-api.md「意图保护」）
  const guards: Record<number, Record<string, unknown>> = {
    4: { target: 'sub/s1', expect: { notes: null, tags: [] } },
    5: { target: 'sub/s1', expect: { price: 12, priceHistory: null, phases: null } },
    7: { target: 'kv/settings', expect: { weekStart: null, remindDays: null } },
  };
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
  const r = await a.push(steps.map(([name, args], i) => ({ name: `${name}@1`, args, ...guards[i] })));
  assert.deepEqual(r.body.rejections, []);
  assert.deepEqual(strip(await dump(batch.env)), strip(await dump(one.env)));
});

test('提交守卫：读算写之间账本被改则重算；一直被改 3 次后 503，不留半截写入', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([
    { name: 'create_subscription@1', args: { id: 's1', name: 'Fictional Svc', price: 5, currency: 'USD', cycle: { unit: 'month' }, start: DAY, force: true } },
  ]);
  let n = 0;
  const bump = async () => {
    n++;
    await f.env.DB.prepare('INSERT INTO subscriptions (id, data) VALUES (?1, ?2)')
      .bind(`web${n}`, JSON.stringify({ id: `web${n}`, name: `Web ${n}`, price: 1, currency: 'USD' }))
      .run();
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
  const r = await a.push([
    {
      name: 'import_ledger@1',
      recoveryId: 'rec-1',
      objects: [['sub/s9', { id: 's9', name: 'Imported', price: 3, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: DAY }]],
    },
  ]);
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

// —— 第 2 轮审查（Codex M1）的反例，逐条回归 ——

const SUB = (id = 's1', extra: Record<string, unknown> = {}) => ({
  name: 'create_subscription@1',
  args: { id, name: 'Fictional Svc', price: 10, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', force: true, ...extra },
});
const rawSub = async (env: Env, id = 's1') =>
  JSON.parse(((await env.DB.prepare('SELECT data FROM subscriptions WHERE id = ?1').bind(id).first()) as { data: string }).data) as Record<string, unknown>;
const setAi = (env: Env, on: boolean) =>
  env.DB.prepare(
    "INSERT INTO kv (key, value) VALUES ('settings', json_object('aiEnabled', json(?1))) ON CONFLICT(key) DO UPDATE SET value = json_set(kv.value, '$.aiEnabled', json(?1))",
  )
    .bind(String(on))
    .run();
const codes = (r: { body: Body }) => r.body.rejections!.map((x) => x.code);

test('审查 P1-1：AI 关闭时 MCP 写令牌不能经同步 import_ledger 清空账本；同步令牌进不了 /mcp；同步不受 AI 开关影响', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([SUB()]);
  await setAi(f.env, false);
  const rpc = (token: string) =>
    worker.fetch(
      new Request('https://example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      f.env,
    );
  assert.equal((await rpc(f.mcpToken)).status, 403);
  // 反例：同一 MCP 令牌注册同步并发 import_ledger(objects: []) —— 现在注册就 401，账本不动
  const body = JSON.stringify({ protocol: 1, installId: 'evil', register: true });
  assert.equal((await f.call('sync', { method: 'POST', body, token: f.mcpToken })).status, 401);
  assert.equal((await loadState(f.env)).subscriptions.length, 1);
  // 同步令牌不是 MCP 令牌：AI 打开时也进不了 /mcp
  await setAi(f.env, true);
  assert.equal((await rpc(f.token)).status, 401);
  assert.equal((await rpc(f.mcpToken)).status, 200);
  // AI 开关不影响同步
  await setAi(f.env, false);
  assert.equal((await f.call('sync', { method: 'POST', body: JSON.stringify({ protocol: 1, installId: 'app', register: true }), token: f.token })).status, 200);
});

test('审查 P1-1：同步令牌由网页签发、列出、吊销；吊销后立即 401；明文只返回一次、库里只存哈希', async () => {
  const f = await fixture();
  const web = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://example.test${path}`, { ...init, headers: { 'content-type': 'application/json', origin: 'https://example.test' } }),
      f.env,
    );
  const created = (await (await web('/api/sync/tokens', { method: 'POST', body: JSON.stringify({ name: 'Fictional iPhone' }) })).json()) as {
    token: string;
    item: { id: string; name: string; hash?: string };
  };
  assert.match(created.token, /^cal_sync_/);
  assert.equal(created.item.hash, undefined);
  const list = (await (await web('/api/sync/tokens')).json()) as Array<{ id: string; name: string; hash?: string }>;
  assert.ok(list.some((x) => x.id === created.item.id && x.name === 'Fictional iPhone' && x.hash === undefined));
  const stored = JSON.stringify((await f.env.DB.prepare('SELECT * FROM sync_tokens').all()).results);
  assert.ok(stored.includes(created.item.id) && !stored.includes(created.token));
  assert.equal(await f.env.DB.prepare("SELECT value FROM kv WHERE key = 'syncTokens'").first(), null);
  const body = JSON.stringify({ protocol: 1, installId: 'x', register: true });
  assert.equal((await f.call('sync', { method: 'POST', body, token: created.token })).status, 200);
  await web(`/api/sync/tokens/${created.item.id}`, { method: 'DELETE' });
  assert.equal((await f.call('sync', { method: 'POST', body, token: created.token })).status, 401);
  // 同步令牌的存储不进账本代际（kv.rev 不涨）
  const rev = ((await f.env.DB.prepare("SELECT value FROM kv WHERE key = 'rev'").first()) as { value: string }).value;
  await web('/api/sync/tokens', { method: 'POST', body: JSON.stringify({ name: 'Another' }) });
  assert.equal(((await f.env.DB.prepare("SELECT value FROM kv WHERE key = 'rev'").first()) as { value: string }).value, rev);
});

test('审查 P1-2：同步操作是显式白名单；save_subscription 等整条保存不在内，新增写工具不会自动加入', async () => {
  const f = await fixture();
  const ops = (await (await f.call('hello')).json()).ops as Record<string, unknown>;
  const writes = TOOLS.filter((x) => x.write).map((x) => x.name);
  assert.equal(ops.save_subscription, undefined);
  assert.deepEqual(
    writes.filter((n) => !ops[n]),
    ['save_subscription'],
  );
  assert.deepEqual(Object.keys(ops).sort(), [...SYNC_INTENTS, 'noop', 'patch', 'create', 'delete', 'replace', 'set_member', 'fx_fill', 'import_ledger'].sort());
  // 反例：先记一笔付款，再用付款前的快照 save_subscription@1 改名 —— 现在整请求 426，付款仍在
  const a = await device(f.env);
  await a.push([SUB(), { name: 'record_payment@1', target: 'sub/s1', args: { subscription: 's1', date: '2026-02-05', amount: 10 } }]);
  const snapshot = { id: 's1', name: 'Renamed', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-05' };
  const r = await f.call('sync', {
    method: 'POST',
    token: f.token,
    body: JSON.stringify({
      protocol: 1,
      installId: 'install-a',
      mutations: [{ mid: 3, op: { name: 'save_subscription@1', at: { date: DAY }, args: { record: snapshot } } }],
    }),
  });
  assert.equal(r.status, 426);
  assert.equal((await r.json()).code, 'op_version');
  assert.ok(((await rawSub(f.env)).payments as unknown[]).length >= 1);
});

test('审查 P1-4：同日转让 [10,20]，按内容定位删 20、带旧序号 0 —— 删的是 20；缺定位拒绝，不回退序号', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const transfer = (amount: number) => ({
    name: 'record_transfer@1',
    target: 'sub/s1',
    args: { subscription: 's1', kind: 'buy', date: '2026-01-05', amount, currency: 'USD' },
  });
  await a.push([SUB(), transfer(10), transfer(20)]);
  const del = (locate: unknown) => ({
    name: 'record_transfer@1',
    target: 'sub/s1',
    args: { subscription: 's1', delete: { date: '2026-01-05', index: 0 } },
    ...(locate ? { locate } : {}),
  });
  const missing = await a.push([del(null)]);
  assert.deepEqual(codes(missing), ['invalid']);
  const wrongCount = await a.push([del({ date: '2026-01-05', match: { amount: 20 }, count: 2 })]);
  assert.deepEqual(codes(wrongCount), ['expect_failed']);
  const r = await a.push([del({ date: '2026-01-05', match: { amount: 20 }, count: 1 })]);
  assert.deepEqual(r.body.rejections, []);
  assert.deepEqual(
    ((await rawSub(f.env)).transfers as Array<{ amount: number }>).map((x) => x.amount),
    [10],
  );
  const gone = await a.push([del({ date: '2026-01-05', match: { amount: 20 }, count: 1 })]);
  assert.deepEqual(codes(gone), ['target_deleted']);
  // 改写同理：按内容找到 10 改成 15
  const rep = await a.push([
    {
      ...transfer(15),
      args: { ...transfer(15).args, replace: { date: '2026-01-05', index: 7 } },
      locate: { date: '2026-01-05', match: { amount: 10 }, count: 1 },
    },
  ]);
  assert.deepEqual(rep.body.rejections, []);
  assert.deepEqual(
    ((await rawSub(f.env)).transfers as Array<{ amount: number }>).map((x) => x.amount),
    [15],
  );
});

test('审查 P1-4：付款改写与删除、充值改删都按内容与冻结笔数定位；读数、指标、状态、余额缺期望即拒绝', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const pay = (amount: number) => ({ name: 'record_payment@1', target: 'sub/s1', args: { subscription: 's1', date: '2026-02-05', amount } });
  await a.push([SUB(), pay(10), pay(3)]);
  const amounts = async () => ((await loadState(f.env)).subscriptions[0].payments ?? []).filter((p) => p.date === '2026-02-05').map((p) => p.amount);
  // 改写 3 → 4，设备序号 0 被忽略
  const rep = await a.push([
    { ...pay(4), args: { ...pay(4).args, replace: { date: '2026-02-05', index: 0 } }, locate: { date: '2026-02-05', match: { amount: 3 }, count: 1 } },
  ]);
  assert.deepEqual(rep.body.rejections, []);
  assert.deepEqual((await amounts()).sort(), [10, 4].sort());
  assert.deepEqual(codes(await a.push([{ ...pay(5), args: { ...pay(5).args, replace: { date: '2026-02-05', index: 0 } } }])), ['invalid']);
  // 删除 10：缺定位 invalid，按内容删
  assert.deepEqual(codes(await a.push([{ name: 'delete_payment@1', target: 'sub/s1', args: { subscription: 's1', date: '2026-02-05', index: 0 } }])), [
    'invalid',
  ]);
  const del = await a.push([
    { name: 'delete_payment@1', target: 'sub/s1', args: { subscription: 's1', index: 0 }, locate: { date: '2026-02-05', match: { amount: 10 }, count: 1 } },
  ]);
  assert.deepEqual(del.body.rejections, []);
  assert.deepEqual(await amounts(), [4]);

  // 充值：同日 10、20，删 20（设备序号 0 是旧的）
  const top = (amount: number) => ({ name: 'update_payment_method@1', target: 'method/m1', args: { method: 'm1', top_up: { amount, date: '2026-02-01' } } });
  await a.push([
    {
      name: 'update_payment_method@1',
      target: 'method/m1',
      args: { action: 'create', id: 'm1', set: { name: 'Fictional Wallet', kind: 'prepaid', currency: 'USD' } },
    },
    top(10),
    top(20),
  ]);
  const tops = async () => ((await loadState(f.env)).methods[0].topUps ?? []).map((x) => x.amount);
  const topDel = (locate?: unknown) => ({
    name: 'update_payment_method@1',
    target: 'method/m1',
    args: { method: 'm1', top_up_action: 'delete', top_up_index: 0 },
    ...(locate ? { locate } : {}),
  });
  assert.deepEqual(codes(await a.push([topDel()])), ['invalid']);
  assert.deepEqual((await a.push([topDel({ date: '2026-02-01', match: { amount: 20 }, count: 1 })])).body.rejections, []);
  assert.deepEqual(await tops(), [10]);

  // 余额、状态、指标、读数：缺期望 invalid
  assert.deepEqual(codes(await a.push([{ name: 'update_payment_method@1', target: 'method/m1', args: { method: 'm1', balance: 50 } }])), ['invalid']);
  assert.deepEqual(codes(await a.push([{ name: 'set_status@1', target: 'sub/s1', args: { subscription: 's1', status: 'paused' } }])), ['invalid']);
  assert.deepEqual(codes(await a.push([{ name: 'set_meters@1', target: 'sub/s1', args: { subscription: 's1', meters: [{ name: 'Power', unit: 'kWh' }] } }])), [
    'invalid',
  ]);
  const meters = await a.push([
    { name: 'set_meters@1', target: 'sub/s1', args: { subscription: 's1', meters: [{ id: 'kwh', name: 'Power', unit: 'kWh' }] }, expect: { meters: null } },
  ]);
  assert.deepEqual(meters.body.rejections, []);
  const reading = (value: number, expect?: unknown) => ({
    name: 'add_readings@1',
    target: 'sub/s1',
    args: { subscription: 's1', readings: [{ date: '2026-02-01', values: { kwh: value } }] },
    ...(expect !== undefined ? { expect: { readings: expect } } : {}),
  });
  assert.deepEqual(codes(await a.push([reading(100)])), ['invalid']);
  assert.deepEqual((await a.push([reading(100, [{ date: '2026-02-01', absent: true }])])).body.rejections, []);
  const r1 = (await rawSub(f.env)).readings as Array<Record<string, unknown>>;
  // 另一台设备随后改成 120；本机按旧值 100 的期望再改 → expect_failed，不覆盖
  const b = await device(f.env, 'install-b');
  await b.push([reading(120, [r1[0]])]);
  assert.deepEqual(codes(await a.push([reading(130, [r1[0]])])), ['expect_failed']);
  assert.equal(((await rawSub(f.env)).readings as Array<{ values: Record<string, number> }>)[0].values.kwh, 120);
});

test('审查 P2：import_ledger 同日期汇率以副本为准（含来源）；fx_fill 仍服务器优先', async () => {
  const f = await fixture();
  await f.env.DB.prepare("INSERT INTO fx_daily (date, rates, source) VALUES ('2026-03-01', '{\"EUR\":0.8}', 'ecb')").run();
  const a = await device(f.env);
  const fill = await a.push([{ name: 'fx_fill@1', date: '2026-03-01', rates: { EUR: 0.7 }, source: 'app' }]);
  assert.deepEqual(fill.body.rejections, []);
  const fx = async () => (await f.env.DB.prepare("SELECT rates, source FROM fx_daily WHERE date = '2026-03-01'").first()) as { rates: string; source: string };
  assert.deepEqual(JSON.parse((await fx()).rates), { EUR: 0.8 });
  const r = await a.push([{ name: 'import_ledger@1', recoveryId: 'rec-fx', objects: [['fx/2026-03-01', { rates: { EUR: 0.9 }, source: 'device' }]] }]);
  assert.deepEqual(r.body.rejections, []);
  assert.deepEqual(JSON.parse((await fx()).rates), { EUR: 0.9 });
  assert.equal((await fx()).source, 'device');
});

test('审查 P2：补丁清空按字段转换 —— 试用到期、提醒天数、续费提前天数、文本、图标都能清空', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const set = {
    trialEnd: '2026-01-20',
    remindDays: 3,
    notes: 'fictional',
    url: 'https://example.test/x',
    icon: 'https://example.test/i.png',
    cancelLeadDays: 2,
  };
  for (const [field, value] of Object.entries(set)) {
    const id = `s-${field}`;
    await a.push([SUB(id)]);
    const put = await a.push([{ name: 'patch@1', target: `sub/${id}`, fields: { [field]: { from: null, to: value } } }]);
    assert.deepEqual(put.body.rejections, [], field);
    assert.deepEqual((await rawSub(f.env, id))[field], value, field);
    const clear = await a.push([{ name: 'patch@1', target: `sub/${id}`, fields: { [field]: { from: value, to: null } } }]);
    assert.deepEqual(clear.body.rejections, [], `${field} clear`);
    const after = (await rawSub(f.env, id))[field];
    assert.ok(after === undefined || after === 0, `${field} cleared: ${JSON.stringify(after)}`);
    // 再发一次同样的清空：已达成，不报 field_changed
    assert.deepEqual((await a.push([{ name: 'patch@1', target: `sub/${id}`, fields: { [field]: { from: value, to: null } } }])).body.rejections, []);
  }
  // 名称不能清空
  assert.deepEqual(codes(await a.push([{ name: 'patch@1', target: 'sub/s-notes', fields: { name: { from: 'Fictional Svc', to: null } } }])), ['invalid']);
});

test('审查 P2：同 id 新建区分未提供与明确 null —— 服务器绑卡 m、新建明确 method:null → id_conflict；余额同理', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([
    {
      name: 'update_payment_method@1',
      target: 'method/m',
      args: { action: 'create', id: 'm', set: { name: 'Fictional Card', kind: 'credit', currency: 'USD' } },
    },
    SUB('s1', { method: 'm' }),
  ]);
  assert.deepEqual(codes(await a.push([SUB('s1', { method: null })])), ['id_conflict']);
  assert.deepEqual((await a.push([SUB('s1')])).body.rejections, [], '未提供 method 不比较');
  assert.deepEqual((await a.push([SUB('s1', { method: 'm' })])).body.rejections, []);
  const wallet = (balance: unknown) => ({
    name: 'update_payment_method@1',
    target: 'method/w',
    args: { action: 'create', id: 'w', set: { name: 'Fictional Wallet', kind: 'prepaid', currency: 'USD', ...(balance === undefined ? {} : { balance }) } },
  });
  await a.push([wallet(50)]);
  assert.deepEqual(codes(await a.push([wallet(null)])), ['id_conflict']);
  assert.deepEqual(codes(await a.push([wallet(60)])), ['id_conflict']);
  assert.deepEqual((await a.push([wallet(50)])).body.rejections, []);
});

test('审查 P2：分页按 UTF-8 字节 —— 三条各 30 万汉字的记录不进同一页', async () => {
  const f = await fixture();
  const note = '账'.repeat(300_000);
  for (const id of ['s1', 's2', 's3'])
    await f.env.DB.prepare('INSERT INTO subscriptions (id, data) VALUES (?1, ?2)')
      .bind(id, JSON.stringify({ id, name: 'Fictional', price: 1, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: DAY, notes: note }))
      .run();
  // 每条约 0.9 MB（UTF-8）而 UTF-16 长度只有 0.3M：按字节装页时 2 MiB 只容两条
  const first = await changesSince(f.env, null);
  const subs = first.objects.filter(([k]) => k.startsWith('sub/'));
  assert.equal(subs.length, 2);
  assert.equal(first.more, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(first.objects)).length <= 2 * 1024 * 1024);
  const rest = await changesSince(f.env, first.cookie);
  assert.equal(rest.objects.filter(([k]) => k.startsWith('sub/')).length, 1);
});

// —— 第 3 轮审查 ——

test('审查 R3 P1-4：白名单逐个归类；修改、删除已有内容的意图缺期望或定位一律 invalid（先于目标查找）', async () => {
  const { requiredExpect } = await import('../worker/sync-ops.ts');
  const f = await fixture();
  const a = await device(f.env);
  const S = { subscription: 's1' };
  // [名称, 参数, target, 缺的保护]
  const guarded: Array<[string, Record<string, unknown>, string, string]> = [
    ['update_subscription', { ...S, set: { notes: 'x' } }, 'sub/s1', 'expect.notes'],
    ['update_subscription', { ...S, set: { end: '2026-09-01' } }, 'sub/s1', 'expect.end'],
    ['change_price', { ...S, amount: 3, from: '2026-03-05' }, 'sub/s1', 'expect.price'],
    ['change_price', { ...S, action: 'edit', phase: '2026-01-05', original_from: '2026-01-05', amount: 3 }, 'sub/s1', 'expect.price'],
    ['change_price', { ...S, action: 'remove', phase: '2026-01-05', original_from: '2026-03-05' }, 'sub/s1', 'expect.price'],
    ['change_plan', { ...S, action: 'edit', at: '2026-01-05', set: { price: 3 } }, 'sub/s1', 'expect.price'],
    ['change_plan', { ...S, action: 'switch', at: '2026-04-05', set: { price: 3 } }, 'sub/s1', 'expect.price'],
    ['set_status', { ...S, status: 'paused' }, 'sub/s1', 'expect.status'],
    ['set_meters', { ...S, meters: [] }, 'sub/s1', 'expect.meters'],
    ['add_readings', { ...S, readings: [] }, 'sub/s1', 'expect.readings'],
    ['set_share', { ...S, role: 'owner', seats: 3 }, 'sub/s1', 'expect.share'],
    ['set_share', { ...S, role: 'none' }, 'sub/s1', 'expect.share'],
    ['set_proxy', { ...S, for_name: 'Fictional' }, 'sub/s1', 'expect.proxy'],
    ['set_proxy', { ...S, action: 'remove' }, 'sub/s1', 'expect.proxy'],
    ['save_share_member', { ...S, member: 'mb1', fee: 5 }, 'sub/s1', 'expect.member'],
    ['remove_share_member', { ...S, member: 'mb1' }, 'sub/s1', 'expect.member'],
    ['record_receivable', { ...S, member: 'mb1', action: 'update', id: 'r1', amount: 1 }, 'sub/s1', 'expect.record'],
    ['record_receivable', { ...S, member: 'mb1', action: 'delete', id: 'r1' }, 'sub/s1', 'expect.record'],
    ['record_receivable', { ...S, kind: 'proxy', action: 'update', id: 'r1', amount: 1 }, 'sub/s1', 'expect.record'],
    ['record_receivable', { ...S, action: 'charged', charge: '2026-02-05', charged_amount: 3 }, 'sub/s1', 'expect.charged'],
    ['record_payment', { ...S, date: '2026-02-05', amount: 1, replace: { date: '2026-02-05', index: 0 } }, 'sub/s1', 'locate'],
    ['delete_payment', { ...S, date: '2026-02-05', index: 0 }, 'sub/s1', 'locate'],
    ['record_transfer', { ...S, date: '2026-02-05', amount: 1, replace: { date: '2026-02-05', index: 0 } }, 'sub/s1', 'locate'],
    ['record_transfer', { ...S, delete: { date: '2026-02-05', index: 0 } }, 'sub/s1', 'locate'],
    ['update_payment_method', { method: 'm1', set: { name: 'X' } }, 'method/m1', 'expect.name'],
    ['update_payment_method', { method: 'm1', name: 'X' }, 'method/m1', 'expect.name'],
    ['update_payment_method', { method: 'm1', balance: 5 }, 'method/m1', 'expect.balance'],
    ['update_payment_method', { method: 'm1', set: { balanceAsOf: '2026-02-01' } }, 'method/m1', 'expect.balance'],
    ['update_payment_method', { method: 'm1', top_up_action: 'update', top_up_index: 0, top_up: { amount: 1 } }, 'method/m1', 'locate'],
    ['update_payment_method', { method: 'm1', top_up_action: 'delete', top_up_index: 0 }, 'method/m1', 'locate'],
    ['save_category', { action: 'update', category: 'Video', set: { name: 'Films' } }, 'kv/settings', 'expect.categories'],
    ['save_category', { action: 'delete', category: 'Video' }, 'kv/settings', 'expect.categories'],
    ['save_category', { action: 'reorder', order: ['Video'] }, 'kv/settings', 'expect.categories'],
    ['save_person', { action: 'update', person: 'p1', set: { note: 'x' } }, 'kv/people', 'expect.note'],
    ['update_settings', { set: { weekStart: 1 } }, 'kv/settings', 'expect.weekStart'],
  ];
  // 新建、追加、整条删除：不要求期望（追加的恰好一次由 mid 保证；整条删除对已删目标视为达成）
  const free: Array<[string, Record<string, unknown>]> = [
    ['create_subscription', { id: 'x' }],
    ['record_payment', { ...S, date: '2026-02-05', amount: 1 }],
    ['record_transfer', { ...S, date: '2026-02-05', amount: 1 }],
    ['delete_subscription', S],
    ['record_receivable', { ...S, member: 'mb1', periods: ['2026-02-05'] }],
    ['record_receivable', { ...S, member: 'mb1', action: 'waive', periods: ['2026-02-05'] }],
    ['save_share_member', { ...S, name: 'New member' }],
    ['update_payment_method', { action: 'create', id: 'x', set: {} }],
    ['update_payment_method', { action: 'delete', method: 'm1' }],
    ['update_payment_method', { method: 'm1', top_up: { amount: 1 } }],
    ['save_category', { action: 'create', set: { name: 'New' } }],
    ['save_person', { action: 'create', set: { name: 'New' } }],
    ['save_person', { action: 'delete', person: 'p1' }],
  ];
  // 白名单里每个工具都已归类：新增同步意图必须先在 requiredExpect 与这张表里声明
  const covered = new Set([...guarded.map((g) => g[0]), ...free.map((g) => g[0])]);
  assert.deepEqual(
    SYNC_INTENTS.filter((n) => !covered.has(n)),
    [],
  );
  for (const [name, args] of free) assert.equal(requiredExpect(name, args), undefined, `${name} ${JSON.stringify(args)}`);
  for (const [name, args, target, missing] of guarded) {
    const r = await a.push([{ name: `${name}@1`, target, args }]);
    assert.deepEqual(codes(r), ['invalid'], `${name} ${JSON.stringify(args)}`);
    const detail = (r.body.rejections as Array<{ detail: string }>)[0].detail;
    assert.ok(detail.includes(missing), `${name}: ${detail}`);
  }
});

test('审查 R3 P1-4 反例：代付收款 rc1=30，旧设备不带期望改成 10 → invalid；期望不符 expect_failed；相符才改，删除同理', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([SUB()]);
  const proxy = await a.push([{ name: 'set_proxy@1', target: 'sub/s1', args: { subscription: 's1', for_name: 'Fictional Friend' }, expect: { proxy: null } }]);
  assert.deepEqual(proxy.body.rejections, []);
  const rec = await a.push([
    { name: 'record_receivable@1', target: 'sub/s1', args: { subscription: 's1', kind: 'proxy', id: 'rc1', amount: 30, date: '2026-02-06', count: 1 } },
  ]);
  assert.deepEqual(rec.body.rejections, []);
  type Receipt = { id: string; amount: number };
  const receipt = async () => ((await rawSub(f.env)).proxy as { receipts?: Receipt[] } | undefined)?.receipts?.find((x) => x.id === 'rc1');
  const seen = await receipt();
  assert.equal(seen?.amount, 30);
  const upd = (expect?: unknown) => ({
    name: 'record_receivable@1',
    target: 'sub/s1',
    args: { subscription: 's1', kind: 'proxy', action: 'update', id: 'rc1', amount: 10 },
    ...(expect !== undefined ? { expect: { record: expect } } : {}),
  });
  assert.deepEqual(codes(await a.push([upd()])), ['invalid']);
  assert.deepEqual(codes(await a.push([upd({ ...seen, amount: 25 })])), ['expect_failed']);
  assert.equal((await receipt())?.amount, 30);
  assert.deepEqual((await a.push([upd(seen)])).body.rejections, []);
  const now = await receipt();
  assert.equal(now?.amount, 10);
  // 删除：期望仍是旧内容（30）→ expect_failed；按新内容删除成功；再删一次已达成
  const del = (expect: unknown) => ({
    name: 'record_receivable@1',
    target: 'sub/s1',
    args: { subscription: 's1', kind: 'proxy', action: 'delete', id: 'rc1' },
    expect: { record: expect },
  });
  assert.deepEqual(codes(await a.push([del(seen)])), ['expect_failed']);
  assert.deepEqual((await a.push([del(now)])).body.rejections, []);
  assert.equal(await receipt(), undefined);
  assert.deepEqual((await a.push([del(now)])).body.rejections, []);
});

test('审查 R3 P2-5：只改余额日期也要冻结 balance + balanceAsOf；不符 expect_failed', async () => {
  const f = await fixture();
  const a = await device(f.env);
  const mk = await a.push([
    {
      name: 'update_payment_method@1',
      target: 'method/m1',
      args: { action: 'create', id: 'm1', set: { name: 'Fictional Wallet', kind: 'prepaid', currency: 'USD', balance: 40, balanceAsOf: '2026-01-01' } },
    },
  ]);
  assert.deepEqual(mk.body.rejections, []);
  const asOf = (expect?: Record<string, unknown>) => ({
    name: 'update_payment_method@1',
    target: 'method/m1',
    args: { method: 'm1', set: { balanceAsOf: '2026-02-01' } },
    ...(expect ? { expect } : {}),
  });
  assert.deepEqual(codes(await a.push([asOf()])), ['invalid']);
  assert.deepEqual(codes(await a.push([asOf({ balance: 40 })])), ['invalid']);
  assert.deepEqual(codes(await a.push([asOf({ balance: 40, balanceAsOf: '2025-12-01' })])), ['expect_failed']);
  const raw = async () => JSON.parse(((await f.env.DB.prepare("SELECT data FROM methods WHERE id = 'm1'").first()) as { data: string }).data);
  assert.equal((await raw()).balanceAsOf, '2026-01-01');
  assert.deepEqual((await a.push([asOf({ balance: 40, balanceAsOf: '2026-01-01' })])).body.rejections, []);
  assert.equal((await raw()).balanceAsOf, '2026-02-01');
});

test('审查 R3 P2-7：logoWide、order 与工具 schema 一致不可清空：to:null 先判 invalid 不动数据，给具体值可改', async () => {
  const { METHOD_FIELDS } = await import('./ledger-edit.ts');
  const f = await fixture();
  const a = await device(f.env);
  await a.push([
    {
      name: 'update_payment_method@1',
      target: 'method/m1',
      args: { action: 'create', id: 'm1', set: { name: 'Fictional Card', kind: 'credit', currency: 'USD', logoWide: true, order: 3 } },
    },
  ]);
  const raw = async () => JSON.parse(((await f.env.DB.prepare("SELECT data FROM methods WHERE id = 'm1'").first()) as { data: string }).data);
  const props = (METHOD_FIELDS as { properties: Record<string, { type: unknown }> }).properties;
  for (const [field, from, to] of [
    ['logoWide', true, false],
    ['order', 3, 0],
  ] as const) {
    assert.ok(!JSON.stringify(props[field].type).includes('null'), `${field} 在工具 schema 里不可空`);
    const cleared = await a.push([{ name: 'patch@1', target: 'method/m1', fields: { [field]: { from, to: null } } }]);
    assert.deepEqual(codes(cleared), ['invalid'], field);
    assert.equal((await raw())[field], from, field);
    const set = await a.push([{ name: 'patch@1', target: 'method/m1', fields: { [field]: { from, to } } }]);
    assert.deepEqual(set.body.rejections, [], field);
    assert.equal((await raw())[field], to, field);
  }
});

test('审查 R3 P1-1：签发 B 读到旧状态后暂停、期间吊销 A，再放行 B → A 仍 401、B 可用；两个并发吊销互不恢复', async () => {
  const { revokeSyncToken, listSyncTokens, authenticateSync } = await import('../worker/sync-auth.ts');
  const f = await fixture();
  const auth = (token: string) => authenticateSync(new Request('https://example.test/', { headers: { authorization: `Bearer ${token}` } }), f.env);
  const A = await createSyncToken(f.env, 'Fictional A');
  const C = await createSyncToken(f.env, 'Fictional C');
  // 确定交错：拦下签发 B 的写入语句，等吊销 A 完成后再执行
  const db = f.env.DB;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  const prepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    if (!/INSERT INTO sync_tokens/.test(sql)) return stmt;
    const bind = stmt.bind.bind(stmt);
    return Object.assign(stmt, {
      bind: (...v: unknown[]) => {
        const b = bind(...v);
        const run = b.run.bind(b);
        return Object.assign(b, {
          run: async () => {
            held = true;
            await gate;
            return run();
          },
        });
      },
    });
  };
  const creating = createSyncToken(f.env, 'Fictional B');
  const isHeld = () => held;
  for (let i = 0; i < 200 && !isHeld(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(held, 'B 的写入已被拦下');
  await revokeSyncToken(f.env, A.item.id);
  release();
  const B = await creating;
  (db as { prepare: unknown }).prepare = prepare;
  assert.equal(await auth(A.token), undefined, '吊销的 A 不被签发 B 恢复');
  assert.ok(await auth(B.token));
  // 两个并发吊销：各删各的行
  await Promise.all([revokeSyncToken(f.env, B.item.id), revokeSyncToken(f.env, C.item.id)]);
  assert.equal(await auth(B.token), undefined);
  assert.equal(await auth(C.token), undefined);
  const left = (await listSyncTokens(f.env)).map((x) => x.name);
  assert.ok(!left.includes('Fictional A') && !left.includes('Fictional B') && !left.includes('Fictional C'), left.join());
});

test('审查 R3 P1-1：0010 迁移把旧 kv 里的同步令牌搬进新表并删除旧键', async () => {
  const env = { DB: openD1(':memory:') } as unknown as Env;
  // 先只迁到 0009，模拟升级前已经签发过（kv 形态的）令牌
  const { MIGRATIONS } = await import('../worker/migrations.gen.ts');
  const before = MIGRATIONS.filter((m: { name: string }) => m.name < '0010');
  for (const m of before) for (const sql of m.statements) await env.DB.prepare(sql).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)').run();
  for (const m of before) await env.DB.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?1, ?2)').bind(m.name, 'T').run();
  const legacy = [{ id: 'old1', name: 'Fictional Old', hash: 'h-old1', prefix: 'cal_sync_abcd', createdAt: '2026-01-01T00:00:00.000Z' }];
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('syncTokens', ?1), ('syncTokenUse', ?2)")
    .bind(JSON.stringify(legacy), JSON.stringify({ old1: '2026-02-01T00:00:00.000Z' }))
    .run();
  await ensureMigrated(env);
  const rows = (await env.DB.prepare('SELECT * FROM sync_tokens').all()).results;
  assert.deepEqual(rows, [
    {
      id: 'old1',
      name: 'Fictional Old',
      hash: 'h-old1',
      prefix: 'cal_sync_abcd',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: '2026-02-01T00:00:00.000Z',
    },
  ]);
  assert.equal(await env.DB.prepare("SELECT value FROM kv WHERE key IN ('syncTokens', 'syncTokenUse')").first(), null);
});

test('审查 R3 收口 P1：record_receivable 的 record / waive 只新建；id 已存在（代付或合租成员下）一律 id_conflict，数据不动', async () => {
  const f = await fixture();
  const a = await device(f.env);
  await a.push([SUB()]);
  assert.deepEqual(
    (await a.push([{ name: 'set_proxy@1', target: 'sub/s1', args: { subscription: 's1', for_name: 'Fictional Friend' }, expect: { proxy: null } }])).body
      .rejections,
    [],
  );
  const R = (extra: Record<string, unknown>) => ({
    name: 'record_receivable@1',
    args: { subscription: 's1', kind: 'proxy', date: '2026-02-06', count: 1, ...extra },
  });
  assert.deepEqual((await a.push([R({ id: 'rc1', amount: 30 })])).body.rejections, []);
  type Rec = { id: string; amount?: number };
  const recs = async () => {
    const p = (await rawSub(f.env)).proxy as { receipts?: Rec[]; waivers?: Rec[] };
    return { receipts: p.receipts ?? [], waivers: p.waivers ?? [] };
  };
  const before = await recs();
  // action × 目标已存在：record（缺省与显式）、waive 都拒绝；新 id 照常新建
  for (const extra of [
    { id: 'rc1', amount: 10 },
    { id: 'rc1', action: 'record', amount: 10 },
    { id: 'rc1', action: 'waive' },
  ]) {
    assert.deepEqual(codes(await a.push([R(extra)])), ['id_conflict'], JSON.stringify(extra));
    assert.deepEqual(await recs(), before);
  }
  assert.deepEqual((await a.push([R({ id: 'rc2', action: 'waive', date: '2026-03-06' })])).body.rejections, []);
  assert.ok((await recs()).waivers.some((x) => x.id === 'rc2'));
  // 别处的 id（代付下已有）也不能借合租成员 record 新建同 id
  await a.push([
    { name: 'set_share@1', target: 'sub/s1', args: { subscription: 's1', role: 'owner', seats: 2 }, expect: { share: null } },
    { name: 'save_share_member@1', target: 'sub/s1', args: { subscription: 's1', name: 'Fictional Member', id: 'mb1', fee: 5 } },
  ]);
  const share = (await rawSub(f.env)).share as { members?: Array<{ id: string }> } | undefined;
  assert.equal(share?.members?.length, 1);
  const mid = share!.members![0].id;
  assert.deepEqual(codes(await a.push([{ name: 'record_receivable@1', args: { subscription: 's1', member: mid, id: 'rc1', date: '2026-02-06', count: 1 } }])), [
    'id_conflict',
  ]);
});

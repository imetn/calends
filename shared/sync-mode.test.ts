// App 同步默认休眠（worker/sync-mode.ts、docs/sync-api.md「休眠、启用与停用」）：
// 未启用时业务写入不碰同步表、同步接口 409；第一个令牌启用并补登完整；吊销最后一个停用；再次启用换代际，旧 cookie 只会整份重拉；
// 旧版 0009（触发器一直开着）的库迁移：有令牌、无令牌、托管三种情况。只用虚构数据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import type { Env } from '../worker/env.ts';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { createSyncToken, revokeSyncToken } from '../worker/sync-auth.ts';
import { SYNC_TRIGGERS, enableSql, isCasError, syncState } from '../worker/sync-mode.ts';
import { loadState, upsert } from '../worker/store.ts';
import { withWriteGuard } from '../worker/write-guard.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
const { runSync, parseSyncRequest } = await import('../worker/sync.ts');
const { enableSync } = await import('../worker/hosting.ts');
hook.deregister();

const DAY = '2026-03-10';
const sub = (id: string, name: string) => ({ id, name, price: 5, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-05' });

const count = async (env: Env, sql: string) => Number(((await env.DB.prepare(sql).first()) as { n: number }).n);
const objects = (env: Env) => count(env, 'SELECT count(*) AS n FROM sync_objects');
const triggers = (env: Env) => count(env, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'`);
const meta = async (env: Env, key: string) => ((await env.DB.prepare('SELECT value FROM sync_meta WHERE key = ?1').bind(key).first()) as { value: string } | null)?.value;
const head = (env: Env) => count(env, 'SELECT seq AS n FROM sync_head');

async function fresh() {
  const env = { DB: openD1(':memory:'), DEV_BYPASS_AUTH: '1' } as unknown as Env;
  await ensureMigrated(env);
  await loadState(env);
  return env;
}

/** 虚构设备：注册后可推送、拉取；cookie 跨请求保留 */
function device(env: Env, installId = 'install-a') {
  const s = { ledgerId: null as string | null, drEpoch: null as string | null, cookie: null as unknown, mid: 0 };
  const send = async (body: Record<string, unknown>) => {
    const r = await runSync(env, parseSyncRequest({ protocol: 1, reqId: 'r', installId, ledgerId: s.ledgerId, drEpoch: s.drEpoch, cookie: s.cookie, ...body }));
    const b = r.body as Record<string, unknown> & { objects?: Array<[string, unknown]> };
    if (r.status === 200 && !b.gone && !b.ledgerMismatch) {
      s.ledgerId = b.ledgerId as string;
      s.drEpoch = b.drEpoch as string;
      s.cookie = b.cookie;
    }
    return { status: r.status, body: b };
  };
  /** 拉到 more = false，合并所有页 */
  const pullAll = async () => {
    const pages = [];
    for (;;) {
      const r = await send({ ackedMid: s.mid });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      pages.push(r.body);
      if (!r.body.more) break;
    }
    return { full: pages[0].full as boolean, keys: pages.flatMap((p) => (p.objects ?? []).map(([k, d]) => (d === null ? `-${k}` : k))) };
  };
  return {
    s,
    send,
    pullAll,
    register: () => send({ register: true }),
    push: (ops: Array<Record<string, unknown>>) => send({ ackedMid: s.mid, mutations: ops.map((op) => ({ mid: ++s.mid, op: { at: { date: DAY }, ...op } })) }),
  };
}

test('休眠：业务写入不产生 sync_objects、不装触发器；同步 409 sync_disabled；写守卫照常工作', async () => {
  const env = await fresh();
  assert.deepEqual(await syncState(env), { mode: 'off', triggers: 0 });
  await upsert(env, 'subscriptions', 's1', sub('s1', 'Fictional Music'));
  await upsert(env, 'methods', 'm1', { id: 'm1', name: 'Fictional Card', currency: 'USD' });
  // 写守卫只依赖 kv.rev 与 write_cas：在守卫作用域里写入照常提交
  await withWriteGuard(env, () => upsert(env, 'subscriptions', 's2', sub('s2', 'Fictional Video')));
  const web = await worker.fetch(
    new Request('https://example.test/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ weekStart: 1 }) }),
    env,
  );
  assert.equal(web.status, 200);
  assert.equal(await objects(env), 0);
  assert.equal(await head(env), 0);
  assert.equal(await triggers(env), 0);
  const r = await device(env).register();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sync_disabled');
  // 经 HTTP：没有令牌就是 401（令牌只能在启用后存在）
  const http = await worker.fetch(new Request('https://example.test/api/sync/v1/sync', { method: 'POST', body: '{}' }), env);
  assert.equal(http.status, 401);
});

test('第一个令牌启用：补登全部对象、序号 1..n、首连全量完整；之后增量正确', async () => {
  const env = await fresh();
  for (const i of [1, 2, 3]) await upsert(env, 'subscriptions', `s${i}`, sub(`s${i}`, `Fictional ${i}`));
  await upsert(env, 'methods', 'm1', { id: 'm1', name: 'Fictional Card', currency: 'USD' });
  await env.DB.prepare("INSERT INTO fx_daily (date, rates, source) VALUES ('2026-03-01', '{\"USD\":1}', 'fictional')").run();
  const genBefore = await meta(env, 'generation');
  const { token } = await createSyncToken(env, 'Fictional phone');
  assert.deepEqual(await syncState(env), { mode: 'tokens', triggers: SYNC_TRIGGERS.length });
  assert.notEqual(await meta(env, 'generation'), genBefore);
  // 补登 = 当前全部账本对象，按 sub、method、kv、fx 逐个编号
  const rows = (sql: string) => env.DB.prepare(sql).all().then((r) => (r.results as Array<{ k: string }>).map((x) => x.k));
  const expected = [
    ...(await rows("SELECT 'sub/' || id AS k FROM subscriptions ORDER BY id")),
    ...(await rows("SELECT 'method/' || id AS k FROM methods ORDER BY id")),
    ...(await rows("SELECT 'kv/' || key AS k FROM kv WHERE key IN ('settings', 'people') ORDER BY key")),
    ...(await rows("SELECT 'fx/' || date AS k FROM fx_daily ORDER BY date")),
  ];
  assert.ok(expected.includes('sub/s3') && expected.includes('method/m1') && expected.includes('fx/2026-03-01'));
  assert.deepEqual(await rows("SELECT kind || '/' || id AS k FROM sync_objects ORDER BY seq"), expected);
  assert.equal(await head(env), expected.length);
  assert.deepEqual(
    ((await env.DB.prepare('SELECT seq FROM sync_objects ORDER BY seq').all()).results as Array<{ seq: number }>).map((r) => r.seq),
    Array.from({ length: expected.length }, (_, i) => i + 1),
  );
  // 第二个令牌不再重建
  const gen = await meta(env, 'generation');
  await createSyncToken(env, 'Fictional tablet');
  assert.equal(await meta(env, 'generation'), gen);

  // 经 HTTP 用令牌注册、全量拉取
  const post = (body: unknown) =>
    worker.fetch(
      new Request('https://example.test/api/sync/v1/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
    );
  const reg = await (await post({ protocol: 1, installId: 'install-http', register: true })).json();
  assert.equal(reg.full, true);
  assert.deepEqual((reg.objects as Array<[string, unknown]>).map(([k]) => k), expected);

  // 增量：一次网页写入、一次删除，各推进一个序号
  const d = device(env);
  await d.register();
  await d.pullAll();
  const h = await head(env);
  await upsert(env, 'subscriptions', 's4', sub('s4', 'Fictional 4'));
  const { remove } = await import('../worker/store.ts');
  await remove(env, 'subscriptions', 's1');
  assert.equal(await head(env), h + 2);
  const inc = await d.pullAll();
  assert.equal(inc.full, false);
  assert.deepEqual(inc.keys.sort(), ['-sub/s1', 'sub/s4']);
  // 同步自己的写入也走触发器
  const pushed = await d.push([{ name: 'patch@1', target: 'sub/s2', fields: { notes: { from: null, to: 'n' } } }]);
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.body.rejections, []);
  assert.deepEqual((pushed.body.objects ?? []).map(([k]) => k), ['sub/s2']);
});

test('吊销最后一个令牌停用；再次启用换代际，旧 cookie 只得到 full 整份，执行编号仍去重', async () => {
  const env = await fresh();
  await upsert(env, 'subscriptions', 's1', sub('s1', 'Fictional 1'));
  const a = await createSyncToken(env, 'Fictional A');
  const b = await createSyncToken(env, 'Fictional B');
  const d = device(env);
  await d.register();
  await d.pullAll();
  const pushed = await d.push([{ name: 'patch@1', target: 'sub/s1', fields: { notes: { from: null, to: 'first' } } }]);
  assert.equal(pushed.body.lastMutationId, 1);
  const ledgerId = await meta(env, 'ledgerId');
  const drEpoch = await meta(env, 'drEpoch');

  await revokeSyncToken(env, a.item.id);
  assert.equal((await syncState(env)).mode, 'tokens', '还剩一个令牌，保持启用');
  await revokeSyncToken(env, b.item.id);
  assert.deepEqual(await syncState(env), { mode: 'off', triggers: 0 });
  assert.equal(await objects(env), 0);
  // 停用期间：同步 409；网页写入不进同步表
  assert.equal((await d.send({ ackedMid: d.s.mid })).status, 409);
  await upsert(env, 'subscriptions', 's2', sub('s2', 'Fictional 2'));
  await env.DB.prepare("UPDATE subscriptions SET data = json_set(data, '$.notes', 'while-off') WHERE id = 's1'").run();
  assert.equal(await objects(env), 0);

  // 重新启用：ledgerId、drEpoch、安装记录保留，代际换新
  await createSyncToken(env, 'Fictional C');
  assert.equal(await meta(env, 'ledgerId'), ledgerId);
  assert.equal(await meta(env, 'drEpoch'), drEpoch);
  const again = await d.pullAll();
  assert.equal(again.full, true, '旧 cookie 不得增量');
  assert.deepEqual(again.keys.filter((k) => k.startsWith('sub/')).sort(), ['sub/s1', 'sub/s2']);
  // 重发停用前已执行的 mid=1：跳过，不重复执行；编号接着 2
  const replay = await d.send({ ackedMid: 0, mutations: [{ mid: 1, op: { name: 'patch@1', at: { date: DAY }, target: 'sub/s1', fields: { notes: { from: null, to: 'first' } } } }] });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.lastMutationId, 1);
  assert.equal((await loadState(env)).subscriptions.find((s) => s.id === 's1')?.notes, 'while-off');
});

test('吊销最后一个令牌：删令牌与停用同批提交，停用批次失败时令牌也不删，不会出现「无令牌却仍启用」', async () => {
  const env = await fresh();
  const a = await createSyncToken(env, 'Fictional A');
  const batch = env.DB.batch.bind(env.DB);
  const seen: string[][] = [];
  env.DB.batch = (async (s: D1PreparedStatement[]) => {
    const sql = s.map((x) => (x as unknown as { sql: string }).sql);
    seen.push(sql);
    if (sql.some((q) => q.startsWith('DROP TRIGGER'))) throw new Error('D1_ERROR: fictional storage hiccup');
    return batch(s);
  }) as typeof env.DB.batch;
  await assert.rejects(revokeSyncToken(env, a.item.id), /fictional storage hiccup/);
  env.DB.batch = batch;
  assert.ok(seen[0].some((q) => q.startsWith('DELETE FROM sync_tokens')) && seen[0].some((q) => q.startsWith('DROP TRIGGER')), '同一批次');
  assert.equal(await count(env, 'SELECT count(*) AS n FROM sync_tokens'), 1, '整批回滚，令牌还在');
  assert.deepEqual(await syncState(env), { mode: 'tokens', triggers: SYNC_TRIGGERS.length });
  await revokeSyncToken(env, a.item.id);
  assert.equal(await count(env, 'SELECT count(*) AS n FROM sync_tokens'), 0);
  assert.deepEqual(await syncState(env), { mode: 'off', triggers: 0 });
});

test('吊销：还有别的令牌只删这一个；并发吊销最后两个令牌最终停用；吊销不存在的 id 不停用', async () => {
  const env = await fresh();
  const a = await createSyncToken(env, 'Fictional A');
  const b = await createSyncToken(env, 'Fictional B');
  await revokeSyncToken(env, 'no-such-id');
  assert.equal((await syncState(env)).mode, 'tokens');
  await Promise.all([revokeSyncToken(env, a.item.id), revokeSyncToken(env, b.item.id)]);
  assert.equal(await count(env, 'SELECT count(*) AS n FROM sync_tokens'), 0);
  assert.deepEqual(await syncState(env), { mode: 'off', triggers: 0 });
  // 0013 迁移成 tokens 却没有令牌的旧开发库（只有 sync_clients）：吊销不存在的 id 不会把它停用
  const old = await fresh();
  await old.DB.batch(enableSql('tokens').map((q) => old.DB.prepare(q)));
  await revokeSyncToken(old, 'no-such-id');
  assert.equal((await syncState(old)).mode, 'tokens');
});

test('isCasError 只认 sync_cas 的核对失败（D1、托管 d1-adapter、node:sqlite 与 App 的实测文案），其他约束失败照常抛', () => {
  assert.ok(isCasError(new Error('D1_ERROR: CHECK constraint failed: ok = 1: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)')));
  assert.ok(isCasError(new Error('D1_ERROR: batch statement 0 failed: CHECK constraint failed: ok = 1: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)')));
  assert.ok(isCasError(new Error('CHECK constraint failed: ok = 1')));
  assert.ok(isCasError(new Error('CHECK constraint failed: sync_cas')));
  assert.ok(!isCasError(new Error('CHECK constraint failed: id = 1')));
  assert.ok(!isCasError(new Error('CHECK constraint failed: ok = 10')));
  assert.ok(!isCasError(new Error('UNIQUE constraint failed: sync_tokens.hash')));
  assert.ok(!isCasError('CHECK constraint failed: ok = 1'));
});

test('鉴权 hello 带 syncEnabled；休眠时 hello 仍 200', async () => {
  const env = await fresh();
  const { syncHello } = await import('../worker/hosting.ts');
  assert.equal(((await syncHello(env, true)) as { syncEnabled: boolean }).syncEnabled, false);
  assert.equal('syncEnabled' in (await syncHello(env, false)), false);
  const hello = await worker.fetch(new Request('https://example.test/api/sync/v1/hello'), env);
  assert.equal(hello.status, 200);
  await createSyncToken(env, 'Fictional A');
  assert.equal(((await syncHello(env, true)) as { syncEnabled: boolean }).syncEnabled, true);
});

test('灾备后重新核对托管启用：恢复的库回到休眠时，enableSync 不被旧记忆跳过', async () => {
  const env = await fresh();
  const { disasterRecovery } = await import('../worker/hosting.ts');
  await enableSync(env);
  assert.equal((await syncState(env)).mode, 'hosted');
  // 模拟物理回滚到一份尚未启用托管的快照
  await env.DB.batch([...SYNC_TRIGGERS.map((n) => env.DB.prepare(`DROP TRIGGER ${n}`)), env.DB.prepare("UPDATE sync_meta SET value = 'off' WHERE key = 'mode'")]);
  await enableSync(env);
  assert.equal((await syncState(env)).mode, 'off', '同一进程里记忆生效，没有重查');
  await disasterRecovery(env);
  await enableSync(env);
  assert.deepEqual(await syncState(env), { mode: 'hosted', triggers: SYNC_TRIGGERS.length });
});

test('停用与提交交错：停用换代际，停用前算好的提交被守卫拒绝，重算后 409，不写入不完整的进度', async () => {
  const env = await fresh();
  await upsert(env, 'subscriptions', 's1', sub('s1', 'Fictional 1'));
  const tk = await createSyncToken(env, 'Fictional');
  const d = device(env);
  await d.register();
  await d.pullAll();
  const r = await runSync(
    env,
    parseSyncRequest({
      protocol: 1,
      installId: 'install-a',
      ledgerId: d.s.ledgerId,
      drEpoch: d.s.drEpoch,
      cookie: d.s.cookie,
      mutations: [{ mid: 1, op: { name: 'patch@1', at: { date: DAY }, target: 'sub/s1', fields: { notes: { from: null, to: 'x' } } } }],
    }),
    { beforeCommit: () => revokeSyncToken(env, tk.item.id) },
  );
  assert.equal(r.status, 409);
  assert.equal((r.body as { code: string }).code, 'sync_disabled');
  assert.equal((await loadState(env)).subscriptions.find((s) => s.id === 's1')?.notes, undefined);
  assert.equal(await count(env, "SELECT last_mutation_id AS n FROM sync_clients WHERE install_id = 'install-a'"), 0);
});

/** 旧版 0009：表 + 触发器 + 补登全部写在迁移里（本分支改动前，calends-cloud 的库已按它迁移过） */
async function legacyDb(seed: (db: { exec: (sql: string) => void }) => void) {
  const DB = openD1(':memory:');
  const env = { DB } as unknown as Env;
  await env.DB.prepare(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  ).run();
  const exec = (sql: string) => void env.DB.batch([env.DB.prepare(sql)]);
  for (const m of MIGRATIONS.filter((m) => m.name < '0012')) {
    await env.DB.batch(m.statements.map((s) => env.DB.prepare(s)));
    if (m.name.startsWith('0009')) {
      // 旧版 0009 的触发器与补登（不含 mode：旧库没有这个键）
      for (const s of enableSql('tokens').filter((s) => !s.includes("'mode'"))) await env.DB.batch([env.DB.prepare(s)]);
    }
    await env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(m.name).run();
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('s1', ?1)").bind(JSON.stringify(sub('s1', 'Fictional 1'))),
    env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('s2', ?1)").bind(JSON.stringify(sub('s2', 'Fictional 2'))),
  ]);
  seed({ exec });
  await new Promise((r) => setTimeout(r, 0));
  return env;
}

test('旧库迁移：有同步令牌 → tokens，触发器、对象表与代际原样保留，已连接设备照常增量', async () => {
  const env = await legacyDb(({ exec }) => exec("INSERT INTO sync_tokens (id, name, hash, prefix, created_at) VALUES ('t1', 'Fictional', 'h', 'cal_sync_x', '2026-01-01')"));
  assert.equal(await triggers(env), 12);
  const before = { gen: await meta(env, 'generation'), head: await head(env), objects: await objects(env) };
  assert.equal(before.objects, 2);
  await ensureMigrated(env);
  assert.deepEqual(await syncState(env), { mode: 'tokens', triggers: 12 });
  assert.deepEqual({ gen: await meta(env, 'generation'), head: await head(env), objects: await objects(env) }, before);
  await upsert(env, 'subscriptions', 's3', sub('s3', 'Fictional 3'));
  assert.equal(await head(env), before.head + 1);
});

test('旧库迁移：没有令牌也没有安装 → off，卸触发器、清空对象表；之后写入不进同步表', async () => {
  const env = await legacyDb(() => {});
  assert.equal(await triggers(env), 12);
  await ensureMigrated(env);
  assert.deepEqual(await syncState(env), { mode: 'off', triggers: 0 });
  assert.equal(await objects(env), 0);
  await upsert(env, 'subscriptions', 's3', sub('s3', 'Fictional 3'));
  assert.equal(await objects(env), 0);
  assert.equal(await head(env), 0);
});

test('旧库迁移（托管）：连接过设备的库保持启用，enableSync 只改为 hosted、不换代际；吊销令牌不会停用托管', async () => {
  const env = await legacyDb(({ exec }) => exec("INSERT INTO sync_clients (install_id, last_mutation_id, last_seen, gone, owner) VALUES ('i1', 3, '2026-01-01', 0, 'fam-1')"));
  const gen = await meta(env, 'generation');
  await enableSync(env);
  assert.deepEqual(await syncState(env), { mode: 'hosted', triggers: 12 });
  assert.equal(await meta(env, 'generation'), gen);
  assert.equal(await objects(env), 2);
  // 自部署令牌的签发与吊销不影响 hosted
  const t = await createSyncToken(env, 'Fictional');
  await revokeSyncToken(env, t.item.id);
  assert.deepEqual(await syncState(env), { mode: 'hosted', triggers: 12 });
  // 幂等
  await enableSync(env);
  assert.equal(await meta(env, 'generation'), gen);
});

test('旧库迁移（托管）：从未连接过设备的库先休眠，enableSync 启用并补登完整，首连全量拿到全部对象', async () => {
  const env = await legacyDb(() => {});
  await enableSync(env);
  assert.deepEqual(await syncState(env), { mode: 'hosted', triggers: 12 });
  assert.equal(await objects(env), 2);
  const reg = await device(env).register();
  assert.equal(reg.status, 200);
  assert.equal(reg.body.full, true);
  assert.deepEqual((reg.body.objects ?? []).map(([k]) => k).filter((k) => k.startsWith('sub/')), ['sub/s1', 'sub/s2']);
});

test('新库托管：provision 时 enableSync 直接启用，不依赖 sync_tokens', async () => {
  const env = { DB: openD1(':memory:') } as unknown as Env;
  await enableSync(env);
  assert.deepEqual(await syncState(env), { mode: 'hosted', triggers: 12 });
  assert.equal(await count(env, 'SELECT count(*) AS n FROM sync_tokens'), 0);
  assert.equal((await device(env).register()).status, 200);
});

// 同步与写守卫的 workerd 层（Miniflare + 真实 D1 + 真实 HTTP）：补 node:sqlite 契约层证明不了的部分。
// - D1 的 CHECK 失败报文能被守卫识别；条件更新命中 0 行、后续语句失败时整批回滚
// - 同步只认同步令牌（真实 HTTP 鉴权）；同一进程多个库各自迁移
// - 两份相同同步请求并发：只执行一次；网页并发读改写：成功的都留下，冲突的返回 409
// - 独立期望结果对拍：同步批量结果 == 经 /mcp 逐个调用工具的结果；失败操作的保存点 == 只执行成功操作的结果
// 只用虚构数据。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'calends-workerd-'));
const ORIGIN = 'https://calends.test';

// 测试入口：原样转发给 worker/index.ts，另加几个只在测试里存在的探针路由
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  `import worker from ${JSON.stringify(join(root, 'worker/index.ts'))};
import { ensureMigrated } from ${JSON.stringify(join(root, 'worker/migrate.ts'))};
import { isConflictError } from ${JSON.stringify(join(root, 'worker/write-guard.ts'))};
const out = (v) => Response.json(v);
// 守卫探针：给 D1 套一层，只在测试里存在。认出守卫批（首条写 sync_cas）后可以
// - 屏障：凑齐 n 个守卫批再一起放行（它们都读到了同一个旧序号）
// - 抢写：本请求的前 k 个守卫批提交前，先由「别处」写一笔（让这次 CAS 必然失败）
// 并统计守卫批次数与 CAS 失败次数。
const INTERFERE = {
  tz: "UPDATE kv SET value = json_set(value, '$.timezone', 'Asia/Tokyo') WHERE key = 'settings'",
  note: "UPDATE subscriptions SET data = json_set(data, '$.notes', 'from sync', '$.updatedAt', 'sync-' || hex(randomblob(4))) WHERE id = 'wb1'",
};
const sqlOf = new WeakMap();
let barrier = null;
let stats = { guarded: 0, conflicts: 0 };
const tag = (stmt, sql) => {
  sqlOf.set(stmt, sql);
  const bind = stmt.bind.bind(stmt);
  stmt.bind = (...a) => tag(bind(...a), sql);
  return stmt;
};
const probeDb = (db, interfere, times) => {
  let left = times;
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql) => tag(t.prepare(sql), sql);
      if (k === 'batch')
        return async (stmts) => {
          const guarded = (sqlOf.get(stmts[0]) ?? '').includes('sync_cas');
          if (guarded) {
            stats.guarded++;
            if (barrier && barrier.left > 0) {
              const b = barrier;
              await new Promise((r) => {
                b.waiting.push(r);
                if (--b.left === 0) b.waiting.splice(0).forEach((f) => f());
              });
            }
            if (left > 0 && interfere) {
              left--;
              await t.prepare(INTERFERE[interfere]).run();
            }
          }
          try {
            return await t.batch(stmts);
          } catch (e) {
            if (guarded && isConflictError(e)) stats.conflicts++;
            throw e;
          }
        };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
};
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === '/__probe/barrier') {
      barrier = { left: Number(u.searchParams.get('n')), waiting: [] };
      stats = { guarded: 0, conflicts: 0 };
      return out({ ok: true });
    }
    if (u.pathname === '/__probe/stats') {
      const s = stats;
      stats = { guarded: 0, conflicts: 0 };
      return out(s);
    }
    const interfere = req.headers.get('x-probe-interfere');
    if (interfere || barrier?.left) {
      const times = Number(req.headers.get('x-probe-times') ?? 1);
      return worker.fetch(req, { ...env, DB: probeDb(env.DB, interfere, times) }, ctx);
    }
    if (u.pathname === '/__probe/migrate') {
      const db = u.searchParams.get('db') === '2' ? env.DB2 : env.DB;
      await ensureMigrated({ ...env, DB: db });
      const names = (await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map((r) => r.name);
      return out({ names });
    }
    if (u.pathname === '/__probe/batch') {
      const kind = u.searchParams.get('kind');
      await ensureMigrated(env);
      await env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('probe', '{\\"id\\":\\"probe\\",\\"v\\":0}') ON CONFLICT(id) DO UPDATE SET data = excluded.data").run();
      const write = env.DB.prepare("UPDATE subscriptions SET data = '{\\"id\\":\\"probe\\",\\"v\\":1}' WHERE id = 'probe'");
      const stmts =
        kind === 'zero-rows'
          ? [write, env.DB.prepare("UPDATE sync_clients SET last_mutation_id = 9 WHERE install_id = 'ghost'"), env.DB.prepare('INSERT INTO sync_cas (ok) SELECT changes() = 1'), env.DB.prepare('DELETE FROM sync_cas')]
          : kind === 'later-fails'
            ? [write, env.DB.prepare('INSERT INTO no_such_table (x) VALUES (1)')]
            : [write, env.DB.prepare('UPDATE sync_clients SET last_mutation_id = 9 WHERE 0'), env.DB.prepare('INSERT INTO sync_cas (ok) SELECT changes() = 0'), env.DB.prepare('DELETE FROM sync_cas')];
      let error = null;
      try {
        await env.DB.batch(stmts);
      } catch (e) {
        error = { message: String(e?.message ?? e), conflict: isConflictError(e) };
      }
      const row = await env.DB.prepare("SELECT data FROM subscriptions WHERE id = 'probe'").first();
      return out({ error, data: JSON.parse(row.data), cas: (await env.DB.prepare('SELECT count(*) AS n FROM sync_cas').first()).n });
    }
    return worker.fetch(req, env, ctx);
  },
};
`,
);

let mfA;
let mfB;

before(async () => {
  await build({
    entryPoints: [entry],
    outfile: join(dir, 'worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    loader: { '.json': 'json' },
    logLevel: 'warning',
  });
  const opts = (name) => ({
    workers: [
      {
        name: 'calends',
        modules: true,
        // scriptPath 在 Miniflare 5 beta 下启动失败（internal error），直接传源码
        script: readFileSync(join(dir, 'worker.mjs'), 'utf8'),
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: `${name}-db`, DB2: `${name}-db2` },
        // 网页接口免登录（同步接口仍只认同步令牌）；不发匿名统计
        bindings: { DEV_BYPASS_AUTH: '1', CALENDS_TELEMETRY: '0', SITE_URL: ORIGIN },
      },
    ],
  });
  // Miniflare 5 改了配置形状；这里写的是 v4 形状，经官方转换函数换成当前形状
  mfA = new Miniflare(convertV4MiniflareOptions({ logRequests: false, ...opts('a') }));
  mfB = new Miniflare(convertV4MiniflareOptions({ logRequests: false, ...opts('b') }));
  await Promise.all([mfA.ready, mfB.ready]);
});

after(async () => {
  await Promise.all([mfA?.dispose(), mfB?.dispose()]);
  rmSync(dir, { recursive: true, force: true });
});

const call = async (mf, path, { method = 'GET', body, token, headers = {} } = {}) => {
  const r = await mf.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
};

const syncToken = async (mf) => (await call(mf, '/api/sync/tokens', { method: 'POST', body: { name: 'Fictional phone' } })).body.token;
const mcpToken = async (mf) => (await call(mf, '/api/mcp/tokens', { method: 'POST', body: { name: 'Fictional agent', scope: 'write' } })).body.token;

/** 一台虚构设备，走真实 HTTP */
async function device(mf, token, installId) {
  let st = { ledgerId: null, drEpoch: null, cookie: null };
  let mid = 0;
  const send = async (extra) => {
    const r = await call(mf, '/api/sync/v1/sync', { method: 'POST', token, body: { protocol: 1, reqId: `r${Math.random()}`, installId, ...st, ...extra } });
    if (r.status === 200 && !r.body.gone && !r.body.ledgerMismatch) st = { ledgerId: r.body.ledgerId, drEpoch: r.body.drEpoch, cookie: r.body.cookie };
    return r;
  };
  const reg = await send({ register: true });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return {
    send,
    body: (ops, at) => ({ ackedMid: mid, mutations: ops.map((op) => ({ mid: ++mid, op: { at: { date: at }, ...op } })) }),
    push: (ops, at) => send({ ackedMid: mid, mutations: ops.map((op) => ({ mid: ++mid, op: { at: { date: at }, ...op } })) }),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

const dump = async (mf) => {
  const db = await mf.getD1Database('DB');
  const strip = (s) => s.replace(/"updatedAt":"[^"]+"/g, '"updatedAt":"T"');
  return {
    subs: (await db.prepare('SELECT id, data FROM subscriptions ORDER BY id').all()).results.map((r) => [r.id, strip(r.data)]),
    methods: (await db.prepare('SELECT id, data FROM methods ORDER BY id').all()).results.map((r) => [r.id, r.data]),
    kv: (await db.prepare("SELECT key, value FROM kv WHERE key IN ('settings', 'people') ORDER BY key").all()).results.map((r) => [r.key, r.value]),
  };
};

const resetLedger = async (mf) => {
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('DELETE FROM subscriptions'),
    db.prepare('DELETE FROM methods'),
    db.prepare("DELETE FROM kv WHERE key IN ('settings', 'people')"),
  ]);
};

test('D1：守卫识别 CHECK 失败；条件更新命中 0 行、后续语句失败都整批回滚', async () => {
  const zero = (await call(mfA, '/__probe/batch?kind=zero-rows')).body;
  assert.ok(zero.error, '命中 0 行必须失败');
  assert.equal(zero.error.conflict, true, `D1 报文应被识别为冲突：${zero.error.message}`);
  assert.equal(zero.data.v, 0, '前面的写入回滚');
  assert.equal(zero.cas, 0);
  const later = (await call(mfA, '/__probe/batch?kind=later-fails')).body;
  assert.ok(later.error);
  assert.equal(later.error.conflict, false, '非守卫错误不当作冲突');
  assert.equal(later.data.v, 0, '后续语句失败，前面的写入回滚');
  const ok = (await call(mfA, '/__probe/batch?kind=ok')).body;
  assert.equal(ok.error, null);
  assert.equal(ok.data.v, 1);
  assert.equal(ok.cas, 0, '守卫表提交后清空');
});

test('D1：同一进程里两个库各自迁移', async () => {
  const one = (await call(mfB, '/__probe/migrate?db=1')).body.names;
  const two = (await call(mfB, '/__probe/migrate?db=2')).body.names;
  assert.ok(one.includes('0009_sync.sql'), one.join());
  assert.deepEqual(two, one);
});

test('真实 HTTP 鉴权：同步只认同步令牌；MCP 写令牌、网页免登录都 401；同步令牌进不了 /mcp', async () => {
  const sync = await syncToken(mfA);
  const mcp = await mcpToken(mfA);
  assert.match(sync, /^cal_sync_/);
  const body = { protocol: 1, reqId: 'x', installId: 'auth-probe', register: true };
  assert.equal((await call(mfA, '/api/sync/v1/sync', { method: 'POST', body })).status, 401);
  assert.equal((await call(mfA, '/api/sync/v1/sync', { method: 'POST', body, token: mcp })).status, 401);
  assert.equal((await call(mfA, '/api/sync/v1/sync', { method: 'POST', body, token: 'cal_sync_fictional' })).status, 401);
  assert.equal((await call(mfA, '/api/sync/v1/sync', { method: 'POST', body, token: sync })).status, 200);
  const anon = await call(mfA, '/api/sync/v1/hello');
  assert.equal(anon.body.ledgerId, undefined);
  assert.equal((await call(mfA, '/api/sync/v1/hello', { token: mcp })).body.ledgerId, undefined);
  assert.match((await call(mfA, '/api/sync/v1/hello', { token: sync })).body.ledgerId, /^[0-9a-f]+$/);
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await call(mfA, '/mcp', { method: 'POST', body: rpc, token: sync })).status, 401);
  // 吊销后下次请求 401
  const list = (await call(mfA, '/api/sync/tokens')).body;
  const id = list.find((k) => sync.startsWith(k.prefix))?.id ?? list[list.length - 1].id;
  assert.equal((await call(mfA, `/api/sync/tokens/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(mfA, '/api/sync/v1/sync', { method: 'POST', body, token: sync })).status, 401);
});

test('并发：两份相同的同步请求同时到达，只执行一次', async () => {
  await resetLedger(mfA);
  const token = await syncToken(mfA);
  const a = await device(mfA, token, 'twin');
  const day = today();
  const create = {
    name: 'create_subscription@1',
    args: { id: 'tw1', name: 'Fictional Twin', price: 4, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', force: true },
  };
  assert.deepEqual((await a.push([create], day)).body.rejections, []);
  const req = a.body(
    [{ name: 'record_payment@1', target: 'sub/tw1', args: { subscription: 'tw1', date: '2026-02-05', amount: 4, allow_duplicate: true } }],
    day,
  );
  const [r1, r2] = await Promise.all([a.send(req), a.send(req)]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.lastMutationId, 2);
  assert.equal(r2.body.lastMutationId, 2);
  const db = await mfA.getD1Database('DB');
  const sub = JSON.parse((await db.prepare("SELECT data FROM subscriptions WHERE id = 'tw1'").first()).data);
  const pays = JSON.stringify(sub).match(/"2026-02-05"/g) ?? [];
  assert.equal(pays.length, 1, `付款只记一次：${JSON.stringify(sub)}`);
});

test('并发：多台设备同时改同一字段（同一旧值）→ 只有一台生效，其余整批拒绝，不留半批', async () => {
  await resetLedger(mfA);
  const token = await syncToken(mfA);
  const day = today();
  const seed = await device(mfA, token, 'seed');
  const create = {
    name: 'create_subscription@1',
    args: { id: 'cc1', name: 'Fictional Race', price: 5, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', notes: 'base', force: true },
  };
  assert.deepEqual((await seed.push([create], day)).body.rejections, []);
  const devs = await Promise.all([1, 2, 3, 4, 5].map((n) => device(mfA, token, `racer-${n}`)));
  // 每台一批两条：改备注（同一旧值）+ 改账号；批内第二条依赖第一条成功才算「不留半批」
  const rs = await Promise.all(
    devs.map((d, i) =>
      d.push(
        [
          { name: 'patch@1', target: 'sub/cc1', fields: { notes: { from: 'base', to: `v${i + 1}` } } },
          { name: 'patch@1', target: 'sub/cc1', fields: { notes: { from: `v${i + 1}`, to: `w${i + 1}` } } },
        ],
        day,
      ),
    ),
  );
  const won = rs.flatMap((r, i) => (r.status === 200 && r.body.rejections.length === 0 ? [i + 1] : []));
  assert.equal(won.length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.rejections?.length])));
  for (const [i, r] of rs.entries()) {
    if (won.includes(i + 1)) continue;
    // 输家：要么 503 整批未提交，要么两条都被拒（第一条旧值不符，第二条因此也不符）
    if (r.status === 200) assert.equal(r.body.rejections.length, 2, JSON.stringify(r.body));
    else assert.equal(r.status, 503);
  }
  const db = await mfA.getD1Database('DB');
  const sub = JSON.parse((await db.prepare("SELECT data FROM subscriptions WHERE id = 'cc1'").first()).data);
  assert.equal(sub.notes, `w${won[0]}`);
});

const stats = async () => (await call(mfA, '/__probe/stats')).body;

test('并发（确定屏障）：两个网页设置请求读到同一旧序号 → 一个 CAS 失败后重算成功，两处改动都留下', async () => {
  await resetLedger(mfA);
  await stats();
  // 网页现在的请求形状：只发改动字段（ledger-writes.ts saveSettings）
  await call(mfA, '/__probe/barrier?n=2');
  const rs = await Promise.all([
    call(mfA, '/api/settings', { method: 'PUT', body: { notifyHour: 7 } }),
    call(mfA, '/api/settings', { method: 'PUT', body: { weekStart: 1 } }),
  ]);
  assert.deepEqual(
    rs.map((r) => r.status),
    [200, 200],
    JSON.stringify(rs.map((r) => r.body)),
  );
  const st = await stats();
  assert.equal(st.conflicts, 1, `恰好一次 CAS 失败：${JSON.stringify(st)}`);
  assert.equal(st.guarded, 3, '两次首提交 + 一次重算');
  const settings = (await call(mfA, '/api/state')).body.settings;
  assert.equal(settings.notifyHour, 7);
  assert.equal(settings.weekStart, 1);
});

test('并发（确定抢写）：网页设置提交前别处改了时区 → 首次 CAS 失败、重算成功且不盖掉时区；连续两次被抢 → 409', async () => {
  await resetLedger(mfA);
  await call(mfA, '/api/settings', { method: 'PUT', body: { timezone: 'UTC', notifyHour: 9 } });
  await stats();
  const once = await call(mfA, '/api/settings', { method: 'PUT', body: { notifyHour: 7 }, headers: { 'x-probe-interfere': 'tz' } });
  assert.equal(once.status, 200, JSON.stringify(once.body));
  assert.deepEqual(await stats(), { guarded: 2, conflicts: 1 });
  let settings = (await call(mfA, '/api/state')).body.settings;
  assert.equal(settings.timezone, 'Asia/Tokyo', '别处的改动留下');
  assert.equal(settings.notifyHour, 7);
  await call(mfA, '/api/settings', { method: 'PUT', body: { timezone: 'UTC' } });
  await stats();
  const twice = await call(mfA, '/api/settings', {
    method: 'PUT',
    body: { notifyHour: 5 },
    headers: { 'x-probe-interfere': 'tz', 'x-probe-times': '2' },
  });
  assert.equal(twice.status, 409, JSON.stringify(twice.body));
  assert.equal(twice.body.code, 'write_conflict');
  assert.deepEqual(await stats(), { guarded: 2, conflicts: 2 });
  settings = (await call(mfA, '/api/state')).body.settings;
  assert.equal(settings.timezone, 'Asia/Tokyo');
  assert.equal(settings.notifyHour, 7, '409 时这次改动不落库');
});

test('并发（确定抢写）：订阅整条替换带冻结版本 If-Match，提交前同步改了备注 → 重算发现版本变了 409，同步备注保留；不带 If-Match 的旧请求仍是旧覆盖语义', async () => {
  await resetLedger(mfA);
  const base = {
    id: 'wb1',
    name: 'Fictional Web',
    price: 6,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-05',
    status: 'active',
    notes: 'base',
  };
  const created = await call(mfA, '/api/subscriptions/wb1', { method: 'PUT', body: base });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const frozen = created.body.updatedAt;
  assert.ok(frozen);
  await stats();
  // 网页请求形状：草稿正文（不带 updatedAt）+ If-Match 草稿打开时的版本
  const draft = { ...created.body, updatedAt: undefined, price: 7 };
  const r = await call(mfA, '/api/subscriptions/wb1', {
    method: 'PUT',
    body: draft,
    headers: { 'if-match': JSON.stringify(frozen), 'x-probe-interfere': 'note' },
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(await stats(), { guarded: 1, conflicts: 1 }, '首次 CAS 失败；重算时 If-Match 已不符，不再提交');
  const db = await mfA.getD1Database('DB');
  const row = async () => JSON.parse((await db.prepare("SELECT data FROM subscriptions WHERE id = 'wb1'").first()).data);
  assert.equal((await row()).notes, 'from sync');
  assert.equal((await row()).price, 6);
  // 按新版本重开草稿：成功
  const now = await row();
  const ok = await call(mfA, '/api/subscriptions/wb1', {
    method: 'PUT',
    body: { ...now, updatedAt: undefined, price: 7 },
    headers: { 'if-match': JSON.stringify(now.updatedAt) },
  });
  assert.equal(ok.status, 200);
  assert.equal((await row()).notes, 'from sync');
  // 保证边界（docs/sync-api.md）：不带 If-Match 的旧客户端整条覆盖，守卫重算也只会重放旧正文
  const legacy = await call(mfA, '/api/subscriptions/wb1', { method: 'PUT', body: { ...draft, notes: 'legacy' }, headers: { 'x-probe-interfere': 'note' } });
  assert.equal(legacy.status, 200);
  assert.equal((await row()).notes, 'legacy');
});

test('对拍：同步批量（含失败操作）== 经 /mcp 逐个调用成功的那些工具', async () => {
  await Promise.all([resetLedger(mfA), resetLedger(mfB)]);
  const day = today();
  const PRICE0 = { price: 12, priceHistory: null, phases: null };
  const steps = [
    [
      'update_payment_method',
      { action: 'create', id: 'xm1', set: { name: 'Fictional Card', kind: 'prepaid', currency: 'USD', balance: 100 } },
      'method/xm1',
      true,
    ],
    [
      'create_subscription',
      { id: 'xs1', name: 'Fictional Svc', price: 12, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', method: 'xm1', force: true },
      null,
      true,
    ],
    ['record_payment', { subscription: 'xs1', date: '2026-02-05', amount: 12, allow_duplicate: true }, 'sub/xs1', true],
    // 失败：订阅不存在（保存点回滚，不影响后面）
    ['record_payment', { subscription: 'ghost', date: '2026-02-05', amount: 1 }, 'sub/ghost', false],
    ['update_subscription', { subscription: 'xs1', set: { notes: 'fictional note', tags: ['x'] } }, 'sub/xs1', true, { notes: null, tags: [] }],
    // 失败：价格非法
    ['change_price', { subscription: 'xs1', amount: -5, from: '2026-03-05' }, 'sub/xs1', false, PRICE0],
    ['change_price', { subscription: 'xs1', amount: 15, from: '2026-03-05' }, 'sub/xs1', true, PRICE0],
    ['save_person', { action: 'create', id: 'xp1', set: { name: 'Fictional Person' } }, null, true],
    ['update_settings', { set: { weekStart: 1, remindDays: 5 } }, 'kv/settings', true, { weekStart: null, remindDays: null }],
  ];
  const a = await device(mfA, await syncToken(mfA), 'oracle');
  const r = await a.push(
    steps.map(([name, args, target, , expect]) => ({ name: `${name}@1`, args, ...(target ? { target } : {}), ...(expect ? { expect } : {}) })),
    day,
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rejected = r.body.rejections.map((x) => x.mid).sort((x, y) => x - y);
  const expectFail = steps.flatMap(([, , , ok], i) => (ok ? [] : [i + 1]));
  assert.deepEqual(rejected, expectFail, JSON.stringify(r.body.rejections));

  // 独立路径：另一个实例经 /mcp 逐个调用成功的工具
  const mcp = await mcpToken(mfB);
  for (const [name, args, , ok] of steps) {
    if (!ok) continue;
    const res = await call(mfB, '/mcp', {
      method: 'POST',
      token: mcp,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    assert.equal(res.body.result?.isError, undefined, `${name}: ${JSON.stringify(res.body)}`);
  }
  const [x, y] = await Promise.all([dump(mfA), dump(mfB)]);
  assert.deepEqual(x.subs, y.subs);
  assert.deepEqual(x.methods, y.methods);
  // settings 里的 languageSeen 等由请求语言写入，只比对账务相关部分
  const pick = (rows) =>
    rows.map(([k, v]) => {
      const o = JSON.parse(v);
      return k === 'settings' ? [k, { weekStart: o.weekStart, remindDays: o.remindDays }] : [k, o.map((p) => ({ ...p, createdAt: 'T' }))];
    });
  assert.deepEqual(pick(x.kv), pick(y.kv));
});

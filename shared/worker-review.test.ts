// Worker / MCP 审查修复的回归用例：真 Worker 入口 + 内存 SQLite（事务语义与 D1 batch 一致），全部虚构数据，不访问网络。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { getKv, loadState, putKv, upsert } from '../worker/store.ts';
import type { Env } from '../worker/env.ts';
import { createToken, listTokens } from '../worker/ai/mcp.ts';
import { DEFAULT_SETTINGS, type Subscription } from './types.ts';
import { todayIn } from './billing.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
const { saveChat } = await import('../worker/ai/assistant.ts');
const { toolContent } = await import('../worker/ai/assistant.ts');
hook.deregister();

globalThis.fetch = (() => {
  throw new Error('External network disabled in tests');
}) as typeof fetch;

function fixture(extra: Partial<Env> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const writes: string[] = [];
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      sql,
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        if (!/^\s*(SELECT|CREATE TABLE IF NOT EXISTS d1_migrations)/i.test(sql)) writes.push(sql);
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        if (!/^\s*(SELECT|CREATE TABLE IF NOT EXISTS d1_migrations)/i.test(sql)) writes.push(sql);
        const query = db.prepare(sql);
        if (query.columns().length) return { results: query.all(...args) };
        return { results: [], meta: { changes: Number(query.run(...args).changes) } };
      },
    };
    return stmt;
  };
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const stmt of stmts) results.push(await stmt.run());
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    DEV_BYPASS_AUTH: '1',
    ...extra,
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}, e: Env = env) =>
    worker.fetch(new Request(`https://example.test${path}`, { headers: { 'content-type': 'application/json' }, ...init }), e);
  return { db, env, request, writes };
}

const today = todayIn('UTC');
const sub = (id: string, name: string, extra: Partial<Subscription> = {}): Subscription => ({
  id,
  name,
  category: 'Test',
  tags: [],
  price: 10,
  currency: 'USD',
  start: today,
  cycle: { unit: 'month', every: 1 },
  status: 'active',
  ...extra,
});

async function ledger(extra: Partial<Env> = {}) {
  const f = fixture(extra);
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, categories: [{ name: 'Test' }] });
  const write = (await createToken(f.env, 'Fictional writer', 'write')).token;
  const rpc = async (body: unknown, token = write) => {
    const res = await worker.fetch(
      new Request('https://example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      f.env,
    );
    return res.json();
  };
  const call = async (name: string, args: object) => {
    const r = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
    };
    return r.result;
  };
  return { ...f, write, rpc, call };
}

test('W-2 MCP 鉴权只单独记最后使用时间，不重写令牌列表（吊销的令牌不会被并发请求写回）', async () => {
  const f = await ledger();
  const before = await getKv(f.env, 'mcpTokens');
  const other = await createToken(f.env, 'Second', 'read');
  const listed = await getKv(f.env, 'mcpTokens');
  await f.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
  // 列表只因管理接口变化
  assert.deepEqual(await getKv(f.env, 'mcpTokens'), listed);
  assert.notDeepEqual(before, listed);
  const tokens = await listTokens(f.env);
  assert.ok(tokens.find((x) => x.name === 'Fictional writer')?.lastUsedAt);
  assert.equal(tokens.find((x) => x.id === other.item.id)?.lastUsedAt, undefined);
  // 吊销后用旧令牌请求：被拒绝，也不会把它写回列表
  const { revokeToken } = await import('../worker/ai/mcp.ts');
  await revokeToken(f.env, tokens.find((x) => x.name === 'Fictional writer')!.id);
  const r = await worker.fetch(
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${f.write}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    }),
    f.env,
  );
  assert.equal(r.status, 401);
  assert.deepEqual(
    (await listTokens(f.env)).map((x) => x.id),
    [other.item.id],
  );
});

test('W-4 MCP 批量请求按顺序执行：后一个写入能看到前一个的结果', async () => {
  const f = await ledger();
  const out = (await f.rpc([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_subscription',
        arguments: { id: 'batch1', name: 'Fictional batch', category: 'Test', price: 5, currency: 'USD', cycle: { unit: 'month' } },
      },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_subscription', arguments: { subscription: 'batch1', set: { notes: 'second' } } } },
  ])) as Array<{ id: number; result: { isError?: boolean; content: Array<{ text: string }> } }>;
  assert.deepEqual(
    out.map((x) => [x.id, !!x.result.isError]),
    [
      [1, false],
      [2, false],
    ],
  );
  assert.equal((await loadState(f.env, false)).subscriptions.find((s) => s.id === 'batch1')?.notes, 'second');
});

test('W-5 破坏性工具只认 id 或完整名称；成员查找重名时报错而不是挑第一个', async () => {
  const f = await ledger();
  await upsert(f.env, 'subscriptions', 'n1', sub('n1', 'Fictional Netflix Premium'));
  await upsert(
    f.env,
    'subscriptions',
    'c1',
    sub('c1', 'Fictional Car', {
      share: {
        role: 'owner',
        seats: 5,
        members: [
          { id: 'm1', name: 'Alex', share: 2, fee: 2, feeCurrency: 'USD' },
          { id: 'm2', name: 'alex', share: 2, fee: 2, feeCurrency: 'USD' },
          { id: 'm3', name: 'Alexandra', share: 2, fee: 2, feeCurrency: 'USD' },
        ],
      },
    }),
  );
  // 子串唯一命中：读工具照常可用，删除被拒绝
  assert.ok(!(await f.call('get_subscription', { subscription: 'netflix' })).isError);
  const del = await f.call('delete_subscription', { subscription: 'netflix' });
  assert.equal(del.isError, true);
  assert.match(del.content[0].text, /netflix/);
  assert.ok((await loadState(f.env, false)).subscriptions.some((s) => s.id === 'n1'));
  for (const [name, args] of [
    ['set_share', { subscription: 'Car', role: 'none', dry_run: true }],
    ['change_plan', { subscription: 'netflix', action: 'remove', at: today, dry_run: true }],
    ['delete_payment', { subscription: 'netflix', date: today, dry_run: true }],
    ['set_proxy', { subscription: 'netflix', action: 'remove', dry_run: true }],
  ] as const) {
    const r = await f.call(name, args);
    assert.equal(r.isError, true, `${name}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  // 完整名称（不分大小写）可以
  assert.ok(!(await f.call('delete_subscription', { subscription: 'fictional netflix premium', dry_run: true })).isError);
  // 成员：完整名称重名 → 报错；id → 精确
  const amb = await f.call('remove_share_member', { subscription: 'c1', member: 'ALEX', dry_run: true });
  assert.equal(amb.isError, true);
  assert.ok(!(await f.call('remove_share_member', { subscription: 'c1', member: 'm2', dry_run: true })).isError);
  assert.equal((await f.call('remove_share_member', { subscription: 'c1', member: 'Alexa', dry_run: true })).isError, true);
  assert.equal((await f.call('save_share_member', { subscription: 'c1', member: 'alex', note: 'x', dry_run: true })).isError, true);
});

test('W-6 备份恢复在一个事务里：中途失败时原账本保持不变', async () => {
  const f = fixture();
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, displayName: 'Original ledger' });
  await upsert(f.env, 'subscriptions', 'keep', sub('keep', 'Fictional keep'));
  const r = await f.request('/api/backup', {
    method: 'POST',
    body: JSON.stringify({
      format: 'calends-backup',
      version: 3,
      subscriptions: [sub('new', 'Fictional replacement')],
      methods: [],
      people: [],
      settings: { ...DEFAULT_SETTINGS, displayName: 'Replaced' },
      // 缺 source：写入这一行会失败
      fxDaily: [{ date: '2026-01-01', rates: { USD: 1 } }],
    }),
  });
  assert.equal(r.status, 500);
  const st = await loadState(f.env, false);
  assert.deepEqual(
    st.subscriptions.map((s) => s.id),
    ['keep'],
  );
  assert.equal(st.settings.displayName, 'Original ledger');
});

test('W-7 对话按 UTF-8 字节限长；超长工具结果截断后仍是合法 JSON', async () => {
  const f = fixture();
  // 70 万个汉字约 2.1 MB，超出 D1 单行上限
  await assert.rejects(saveChat(f.env, 'c1', { turns: [], history: [{ role: 'user', content: '汉'.repeat(700_000) }] }), /too large/);
  await saveChat(f.env, 'c2', { turns: [], history: [{ role: 'user', content: 'a'.repeat(1000) }] });
  const big = JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ i, name: `Fictional ${i}` })) });
  const out = toolContent(big);
  const parsed = JSON.parse(out);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.original_chars, big.length);
  assert.equal(toolContent('{"a":1}'), '{"a":1}');
});

test('W-8 导入不再接受 settings；支付方式与网页、MCP 同一套校验', async () => {
  const f = fixture();
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, displayName: 'Before import' });
  const r = await f.request('/api/import', {
    method: 'POST',
    body: JSON.stringify({ subscriptions: [], methods: [], settings: { displayName: 'Injected', baseCurrency: 'ZZZ' }, mode: 'merge' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await loadState(f.env, false)).settings.displayName, 'Before import');
  const bad = await f.request('/api/import', {
    method: 'POST',
    body: JSON.stringify({ subscriptions: [], methods: [{ id: 'w', name: 'Fictional wallet', kind: 'credit', currency: 'ZZZ' }], mode: 'merge' }),
  });
  assert.equal(bad.status, 400);
  const put = await f.request('/api/methods/w2', { method: 'PUT', body: JSON.stringify({ id: 'w2', name: 'Fictional', kind: 'credit', currency: 'ZZZ' }) });
  assert.equal(put.status, 400);
  // 已存的旧币种（汇率表里已经没有）改名照样能存
  await upsert(f.env, 'methods', 'old', { id: 'old', name: 'Old', kind: 'credit', currency: 'XYZ' });
  const keep = await f.request('/api/methods/old', {
    method: 'PUT',
    body: JSON.stringify({ id: 'old', name: 'Old renamed', kind: 'credit', currency: 'XYZ' }),
  });
  assert.equal(keep.status, 200);
});

test('W-9 非法 JSON 请求体返回 400 而不是 500', async () => {
  const f = fixture();
  for (const [path, method] of [
    ['/api/subscriptions/x', 'PUT'],
    ['/api/methods/x', 'PUT'],
    ['/api/settings', 'PUT'],
    ['/api/import', 'POST'],
    ['/api/mcp/tokens', 'POST'],
    ['/api/assistant/apply', 'POST'],
  ] as const) {
    const r = await f.request(path, { method, body: '{not json' });
    assert.equal(r.status, 400, path);
  }
});

test('W-10 未登录访问 /api/public 不写库（未公开时直接 404）', async () => {
  for (const publicView of [false, true]) {
    const f = fixture({ DEV_BYPASS_AUTH: undefined });
    await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, publicView });
    // 旧数据：成员还没关联到人，loadState 默认会建档写回
    await upsert(
      f.env,
      'subscriptions',
      'legacy',
      sub('legacy', 'Fictional legacy', { share: { role: 'owner', seats: 3, members: [{ id: 'm', name: 'Fictional member', share: 3 }] } }),
    );
    f.writes.length = 0;
    const r = await f.request('/api/public');
    assert.equal(r.status, publicView ? 200 : 404);
    assert.deepEqual(f.writes, []);
  }
});

test('W-11 并发请求各用各的语言，不会被另一个请求切换的语言串掉', async () => {
  const f = fixture();
  const put = (locale: string) =>
    f.request('/api/subscriptions/a', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-locale': locale },
      body: JSON.stringify({ id: 'b' }),
    });
  const [zh, en, ja] = await Promise.all([put('zh-CN'), put('en'), put('ja')]);
  const msg = async (r: Response) => ((await r.json()) as { error: string }).error;
  const zhMsg = await msg(zh);
  const enMsg = await msg(en);
  const jaMsg = await msg(ja);
  assert.match(zhMsg, /[一-鿿]/);
  assert.match(enMsg, /^[\x20-\x7e]+$/);
  assert.match(jaMsg, /[぀-ヿ一-鿿]/);
  assert.notEqual(zhMsg, jaMsg);
});

test('W-12 取不到访客 IP 时连续输错不会把站长锁在门外；有 IP 时照常限速', async () => {
  const f = fixture({ DEV_BYPASS_AUTH: undefined, SETUP_TOKEN: 'fictional-setup' });
  const login = (password: string, ip?: string) =>
    f.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
      body: JSON.stringify({ password }),
    });
  const setup = await f.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ setupToken: 'fictional-setup', password: 'correct-horse' }) });
  assert.equal(setup.status, 200);
  for (let i = 0; i < 6; i++) assert.equal((await login('wrong-password')).status, 401);
  assert.equal((await login('correct-horse')).status, 200);
  for (let i = 0; i < 6; i++) assert.equal((await login('wrong-password', '203.0.113.5')).status, 401);
  assert.equal((await login('correct-horse', '203.0.113.5')).status, 429);
  assert.equal((await login('correct-horse', '203.0.113.6')).status, 200);
});

test('W-13 一次性登录挑战被并发请求取用时只有一个能拿到', async () => {
  const f = fixture();
  const { takeChallenge } = (await import('../worker/auth.ts')) as { takeChallenge?: (env: Env, id: string, kind: string) => Promise<string | undefined> };
  assert.ok(takeChallenge);
  f.db
    .prepare('INSERT INTO auth_challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)')
    .run('c1', 'fictional-challenge', 'login', Date.now() + 60_000);
  const got = await Promise.all([takeChallenge(f.env, 'c1', 'login'), takeChallenge(f.env, 'c1', 'login')]);
  assert.deepEqual(got.filter(Boolean), ['fictional-challenge']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges').get()!.n, 0);
});

test('W-13 日历订阅令牌定长比对，猜错的请求不读整本账也不写库', async () => {
  const f = fixture({ DEV_BYPASS_AUTH: undefined });
  const token = 'a'.repeat(32);
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, icsToken: token });
  await upsert(
    f.env,
    'subscriptions',
    'legacy',
    sub('legacy', 'Fictional legacy', { share: { role: 'owner', seats: 3, members: [{ id: 'm', name: 'Fictional member', share: 3 }] } }),
  );
  f.writes.length = 0;
  assert.equal((await f.request(`/cal/${'b'.repeat(32)}.ics`)).status, 404);
  const ok = await f.request(`/cal/${token}.ics`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /BEGIN:VCALENDAR/);
  assert.deepEqual(f.writes, []);
});

test('W-13 日历文本里的单独 CR 也被转义，不能注入新属性', async () => {
  const { buildIcs } = await import('../worker/ics.ts');
  const { FALLBACK_FX } = await import('./billing.ts');
  const ics = buildIcs(
    {
      subscriptions: [sub('i', 'Fictional\rX-INJECTED:1', { category: 'Cat\r\nX-OTHER:2' })],
      methods: [],
      settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' },
      fx: FALLBACK_FX,
    },
    'https://example.test',
  );
  const lines = ics.split('\r\n');
  assert.ok(lines.every((l) => !l.includes('\r') && !l.includes('\n')));
  assert.ok(!lines.some((l) => /^(X-INJECTED|X-OTHER)/.test(l)));
  assert.ok(lines.some((l) => l.includes('Fictional\\nX-INJECTED')));
});

test('W-14 工具入参运行时校验 pattern、maxItems，nullable 处理数组类型', async () => {
  const { nullable, validateToolInput } = await import('./tool-schema.ts');
  const { applyLocale } = await import('../worker/i18n.ts');
  applyLocale('en');
  assert.deepEqual(nullable({ type: ['string', 'number'] }).type, ['string', 'number', 'null']);
  assert.deepEqual(nullable({ type: 'string' }).type, ['string', 'null']);
  const s = nullable({ type: ['string', 'number'] });
  validateToolInput(s, 'x');
  validateToolInput(s, 1);
  validateToolInput(s, null);
  assert.throws(() => validateToolInput({ type: 'string', pattern: '^[A-Z]{3}$' }, 'usd'));
  validateToolInput({ type: 'string', pattern: '^[A-Z]{3}$' }, 'USD');
  assert.throws(() => validateToolInput({ type: 'array', items: { type: 'string' }, maxItems: 2 }, ['a', 'b', 'c']));
  assert.throws(() => validateToolInput({ type: 'array', minItems: 1 }, []));
  // 实际目录：record_receivable.periods 最多 240 项
  const f = await ledger();
  const r = await f.call('record_receivable', { subscription: 'x', periods: Array.from({ length: 241 }, () => '2026-01-01'), dry_run: true });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /periods/);
});

test('W-15 订阅 updatedAt 由存储层统一写入：网页保存、MCP 账本工具、分类改名都会更新', async () => {
  const f = await ledger();
  await upsert(f.env, 'subscriptions', 'u1', sub('u1', 'Fictional stamp', { updatedAt: '2000-01-01T00:00:00.000Z' }));
  const stampOf = async () => (await loadState(f.env, false)).subscriptions.find((s) => s.id === 'u1')!.updatedAt!;
  const first = await stampOf();
  assert.notEqual(first, '2000-01-01T00:00:00.000Z');
  // 直接写一个旧时间，再经 MCP save_category 改名（ledger-tools 的写入管线）
  f.db.prepare('UPDATE subscriptions SET data = json_set(data, ?, ?) WHERE id = ?').run('$.updatedAt', '2000-01-01T00:00:00.000Z', 'u1');
  const r = await f.call('save_category', { action: 'update', category: 'Test', set: { name: 'Renamed' } });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.notEqual(await stampOf(), '2000-01-01T00:00:00.000Z');
  f.db.prepare('UPDATE subscriptions SET data = json_set(data, ?, ?) WHERE id = ?').run('$.updatedAt', '2000-01-01T00:00:00.000Z', 'u1');
  const put = await f.request('/api/categories', { method: 'PUT', body: JSON.stringify({ categories: [{ name: 'Again' }], renames: { Renamed: 'Again' } }) });
  assert.equal(put.status, 200);
  assert.notEqual(await stampOf(), '2000-01-01T00:00:00.000Z');
});

test('W-19 MCP 读工具与提醒遇到缺汇率给 null + incomplete，不当成 0', async () => {
  const f = await ledger();
  const past = `${Number(today.slice(0, 4)) - 1}-01-15`;
  // XYZ 没有任何汇率：既不在当前汇率表，也没有历史汇率
  f.db
    .prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)')
    .run('x1', JSON.stringify(sub('x1', 'Fictional exotic', { currency: 'XYZ', price: 100, start: past, payments: [{ date: past, amount: 100 }] })));
  await upsert(f.env, 'subscriptions', 'u1', sub('u1', 'Fictional usd', { start: past }));
  const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
  const detail = json(await f.call('get_subscription', { subscription: 'x1' }));
  assert.equal(detail.spent_total.amount, null);
  assert.equal(detail.spent_total.incomplete, true);
  assert.deepEqual(detail.spent_total.fx_missing, ['XYZ']);
  assert.ok(detail.charges.every((c: { amount: { converted: unknown } }) => c.amount.converted === null));
  const charges = json(await f.call('list_charges', { period: 'custom', from: past, to: today }));
  assert.equal(charges.total, null);
  assert.equal(charges.incomplete, true);
  assert.deepEqual(charges.fx_missing, ['XYZ']);
  const usdOnly = json(await f.call('list_charges', { period: 'custom', from: past, to: today, subscription: 'u1' }));
  assert.equal(usdOnly.incomplete, false);
  assert.ok(usdOnly.total > 0);
  const preview = json(await f.call('save_subscription', { subscription: { ...detail.record, notes: 'x' }, dry_run: true }));
  assert.equal(preview.computed.after.spent_total.amount, null);
  assert.equal(preview.computed.after.spent_total.incomplete, true);

  const { buildMonthly } = await import('../worker/notify.ts');
  const st = await loadState(f.env, false);
  const first = `${today.slice(0, 7)}-01`;
  const d = buildMonthly({ ...st, settings: { ...st.settings, monthlyDigest: true } }, first);
  assert.ok(d);
  assert.equal(d.stats?.[0].value, '—');
});

test('W-16 刷新汇率：上游非 2xx 时报汇率接口错误（502），当前汇率表不变', async () => {
  const f = fixture();
  const fx = { base: 'USD', rates: { USD: 1, CNY: 7 }, fetchedAt: '2026-01-01T00:00:00.000Z' };
  await putKv(f.env, 'fx', fx);
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<html>rate limited</html>', { status: 429 })) as typeof fetch;
  try {
    const r = await f.request('/api/fx/refresh', { method: 'POST' });
    assert.equal(r.status, 502);
    assert.doesNotMatch(((await r.json()) as { error: string }).error, /Unexpected token|JSON/);
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(await getKv(f.env, 'fx'), fx);
});

test('W-20 买断合租沿用内部周期 1200：MCP 新增成员、改备注、改规则都不报 bill_every 无效', async () => {
  const f = await ledger();
  await upsert(
    f.env,
    'subscriptions',
    'life',
    sub('life', 'Fictional Lifetime Car', {
      cycle: { unit: 'lifetime', every: 1 },
      share: { role: 'owner', seats: 4, members: [{ id: 'm', name: 'Fictional member', share: 3, billEvery: 1200, fee: 3, feeCurrency: 'USD' }] },
    }),
  );
  for (const [name, args] of [
    ['save_share_member', { subscription: 'life', name: 'New fictional member', dry_run: true }],
    ['save_share_member', { subscription: 'life', member: 'm', note: 'Harmless note change', dry_run: true }],
    ['set_share', { subscription: 'life', role: 'owner', rule: { fee: 4 }, dry_run: true }],
  ] as const) {
    const r = await f.call(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  // 显式传入的周期仍按 1–120 校验
  assert.equal((await f.call('save_share_member', { subscription: 'life', member: 'm', bill_every: 1200, dry_run: true })).isError, true);
});

test('W-21 新成员 follow_rule=true 时忽略附带的 fee：从加入日起收仍按车的季度规则收完整一期', async () => {
  const f = await ledger();
  const share = { role: 'owner', seats: 5, since: '2026-01-01', collectFrom: '2026-01-01', rule: { fee: 30, currency: 'USD', billEvery: 3 }, members: [] };
  await upsert(f.env, 'subscriptions', 'quarter', sub('quarter', 'Fictional quarterly car', { start: '2026-01-01', share } as Partial<Subscription>));
  const firsts = [];
  for (const extra of [{}, { fee: 999 }]) {
    const r = await f.call('save_share_member', {
      subscription: 'quarter',
      name: 'Fictional member',
      follow_rule: true,
      collect_day: 'joined',
      joined: '2026-02-01',
      dry_run: true,
      ...extra,
    });
    assert.ok(!r.isError, JSON.stringify(r).slice(0, 300));
    firsts.push((r.structuredContent as { member: { first_collection: unknown } }).member.first_collection);
  }
  assert.deepEqual(firsts[1], firsts[0]);
  assert.deepEqual(firsts[0], { from: '2026-02-01', until: '2026-04-30', next: '2026-05-01', amount: 30, currency: 'USD', partial: false });
});

test('W-17 写入管线重构前的行为基线：清退出日连带清退款，删除与账本工具的草稿叠加', async () => {
  const f = await ledger();
  const past = `${Number(today.slice(0, 4)) - 1}-01-01`;
  await upsert(
    f.env,
    'subscriptions',
    'car',
    sub('car', 'Fictional Car', {
      start: past,
      share: {
        role: 'owner',
        seats: 4,
        members: [
          {
            id: 'm1',
            name: 'Fictional member',
            share: 2,
            fee: 2,
            feeCurrency: 'USD',
            joined: past,
            left: today,
            leaveRefund: { date: today, amount: 1, currency: 'USD' },
          },
        ],
      },
    }),
  );
  const cleared = await f.call('save_share_member', { subscription: 'car', member: 'm1', left: null });
  assert.ok(!cleared.isError, JSON.stringify(cleared));
  const m = (await loadState(f.env, false)).subscriptions.find((s) => s.id === 'car')!.share!.members[0];
  assert.equal(m.left, undefined);
  assert.equal(m.leaveRefund, undefined);

  // 助手的草稿叠加：同一轮里先删订阅、再建分类、再建订阅，后面的工具看得到前面的草稿，且都不写库
  const { TOOLS } = await import('../worker/ai/mcp-tools.ts');
  const run = (name: string, args: object, ctx: object) => TOOLS.find((x) => x.name === name)!.run({ ...args, dry_run: true }, ctx as never);
  const ctx = { env: f.env, overlay: new Map(), access: { client: 'assistant', scope: 'write' } };
  const rev = (await loadState(f.env, false)).rev;
  await run('delete_subscription', { subscription: 'car' }, ctx);
  await run('save_category', { action: 'create', set: { name: 'Draft category' } }, ctx);
  await run('update_payment_method', { action: 'create', id: 'draftw', set: { name: 'Draft wallet', kind: 'credit', currency: 'USD' } }, ctx);
  const created = (await run(
    'create_subscription',
    { name: 'Draft sub', price: 1, currency: 'USD', cycle: { unit: 'month' }, category: 'Draft category', method: 'draftw' },
    ctx,
  )) as { subscription: { id: string; method_id: string; category: string } };
  assert.equal(created.subscription.category, 'Draft category');
  assert.equal(created.subscription.method_id, 'draftw');
  const list = (await TOOLS.find((x) => x.name === 'list_subscriptions')!.run({ status: 'all' }, ctx as never)) as { items: Array<{ id: string }> };
  assert.deepEqual(list.items.map((x) => x.id).sort(), [created.subscription.id].sort());
  assert.equal((await loadState(f.env, false)).rev, rev);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { getRev, loadState, putKv, upsert } from '../worker/store.ts';
import type { Env } from '../worker/env.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import type { ToolCtx } from '../worker/ai/tool-kit.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { ASSISTANT_TOOLS, apply, chat, enrichDraft } from '../worker/ai/assistant.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { addDays, memberRate, runwayFor, todayIn } from './billing.ts';
import { SUBSCRIPTION_SCHEMA } from './subscription-schema.ts';
import { validateToolInput } from './tool-schema.ts';
const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
// 直接调用工具（不经请求）时没有请求作用域，用全局语言
const { applyLocale } = await import('../worker/i18n.ts');
applyLocale('en');
hook.deregister();
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const queries: string[] = [];
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        queries.push(sql);
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        queries.push(sql);
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        queries.push(sql);
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
    BASE_PATH: '/ledger',
  } as unknown as Env;
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    worker.fetch(
      new Request(`https://example.test/ledger/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      auth ? env : { ...env, DEV_BYPASS_AUTH: undefined },
    );
  return { db, env, queries, request };
}

const sub = (): Subscription => ({
  id: 's',
  name: 'Fictional subscription',
  category: 'Test',
  tags: [],
  price: 10,
  currency: 'USD',
  start: todayIn('UTC'),
  cycle: { unit: 'month', every: 1 },
  status: 'active',
  methodId: 'wallet',
  share: {
    role: 'owner',
    seats: 4,
    members: [
      {
        id: 'member',
        personId: 'person',
        name: 'Fictional person',
        share: 3,
        fee: 3,
        feeCurrency: 'USD',
        receipts: [{ id: 'r1', date: todayIn('UTC'), amount: 3, currency: 'USD', periods: [todayIn('UTC')] }],
      },
    ],
  },
  proxy: {
    personId: 'person',
    forName: 'Fictional person',
    receipts: [{ id: 'p1', date: todayIn('UTC'), amount: 9, currency: 'USD', periods: [todayIn('UTC')] }],
    charged: [{ charge: todayIn('UTC'), amount: 10 }],
  },
});
async function setup() {
  const f = fixture();
  await putKv(f.env, 'settings', {
    ...DEFAULT_SETTINGS,
    categories: [{ name: 'Test' }, { name: 'Other' }],
    channels: [{ id: 'channel', name: 'Fictional channel', kind: 'webhook', enabled: false, config: { token: 'SECRET', url: 'https://private.example.test' } }],
    icsToken: 'SECRET',
  });
  await upsert(f.env, 'methods', 'wallet', {
    id: 'wallet',
    name: 'Fictional wallet',
    kind: 'prepaid',
    currency: 'USD',
    balance: 100,
    balanceAsOf: todayIn('UTC'),
    topUps: [{ date: todayIn('UTC'), amount: 100, cost: 95, costCurrency: 'USD' }],
  });
  await upsert(f.env, 'methods', 'target', { id: 'target', name: 'Target wallet', kind: 'credit', currency: 'USD' });
  await putKv(f.env, 'people', [
    { id: 'person', name: 'Fictional person' },
    { id: 'target', name: 'Target person' },
  ]);
  await upsert(f.env, 'subscriptions', 's', sub());
  const write = (await createToken(f.env, 'Fictional writer', 'write')).token;
  const read = (await createToken(f.env, 'Fictional reader', 'read')).token;
  const rpc = async (method: string, params: object, token = write) => {
    const response = await worker.fetch(
      new Request('https://example.test/ledger/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  await rpc('ping', {}, write);
  await rpc('ping', {}, read);
  const call = (name: string, args: object, token = write) => rpc('tools/call', { name, arguments: args }, token);
  return { ...f, write, read, call, rpc, snapshot: () => loadState(f.env, false) };
}

const mutations: Array<[string, object, (st: AppState) => unknown]> = [
  [
    'update_subscription',
    { subscription: 's', set: { remind_days: null, method: null } },
    (st) => st.subscriptions[0].remindDays === undefined && st.subscriptions[0].methodId === undefined,
  ],
  ['save_share_member', { subscription: 's', member: 'member', fee_currency: 'CNY' }, (st) => st.subscriptions[0].share?.members[0].feeCurrency === 'CNY'],
  [
    'set_share',
    { subscription: 's', role: 'owner', collect_from: null, since: null },
    (st) => st.subscriptions[0].share?.collectFrom === undefined && st.subscriptions[0].share?.since === undefined,
  ],
  [
    'set_status',
    { subscription: 's', action: 'trial', trial_end: '2026-12-01' },
    (st) => st.subscriptions[0].status === 'trial' && st.subscriptions[0].trialEnd === '2026-12-01',
  ],
  [
    'record_payment',
    { subscription: 's', date: todayIn('UTC'), amount: 11, replace: { date: todayIn('UTC'), index: 0 } },
    (st) => st.subscriptions[0].payments?.length === 1 && st.subscriptions[0].payments[0].amount === 11,
  ],
  [
    'update_payment_method',
    { action: 'create', id: 'new', set: { name: 'New wallet', kind: 'appstore', currency: 'USD', balance: 0 } },
    (st) => st.methods.find((m) => m.id === 'new')?.balance === 0,
  ],
  [
    'update_payment_method',
    { method: 'wallet', set: { kind: 'phone', logo: 'https://example.test/logo.png', notes: 'Revised', currency: 'CNY', phone: '+1000', order: 2 } },
    (st) => st.methods.find((m) => m.id === 'wallet')?.currency === 'CNY',
  ],
  [
    'update_payment_method',
    { method: 'wallet', top_up_action: 'update', top_up_index: 0, top_up: { amount: 120, note: 'Revised' } },
    (st) => st.methods.find((m) => m.id === 'wallet')?.topUps?.[0].amount === 120 && st.methods.find((m) => m.id === 'wallet')?.balance === 100,
  ],
  [
    'update_payment_method',
    { method: 'wallet', top_up_action: 'delete', top_up_index: 0 },
    (st) => st.methods.find((m) => m.id === 'wallet')?.topUps?.length === 0,
  ],
  [
    'update_payment_method',
    { method: 'wallet', action: 'delete', migrate_to: 'target' },
    (st) => !st.methods.some((m) => m.id === 'wallet') && st.subscriptions[0].methodId === 'target',
  ],
  [
    'save_category',
    { action: 'create', set: { name: 'Created', icon: 'bot', color: 'c1' } },
    (st) => st.settings.categories?.some((c) => c.name === 'Created'),
  ],
  [
    'save_category',
    { action: 'update', category: 'Test', set: { name: 'Renamed', icon: 'wrench', color: '#123456' } },
    (st) => st.subscriptions[0].category === 'Renamed',
  ],
  ['save_category', { action: 'delete', category: 'Test', migrate_to: 'Other' }, (st) => st.subscriptions[0].category === 'Other'],
  ['save_person', { action: 'create', id: 'new', set: { name: 'New person', color: 'green' } }, (st) => st.people?.some((p) => p.id === 'new')],
  ['save_person', { action: 'update', person: 'person', set: { color: '#A1B2C3' } }, (st) => st.people?.find((p) => p.id === 'person')?.color === '#a1b2c3'],
  [
    'save_person',
    { action: 'update', person: 'person', set: { name: 'Renamed', contactVia: 'Email', contact: 'fiction@example.test' } },
    (st) => st.subscriptions[0].proxy?.forName === 'Renamed' && st.subscriptions[0].share?.members[0].name === 'Renamed',
  ],
  [
    'save_person',
    { action: 'delete', person: 'person', migrate_to: 'target' },
    (st) => !st.people?.some((p) => p.id === 'person') && st.subscriptions[0].proxy?.personId === 'target',
  ],
  ['set_proxy', { subscription: 's', person: 'target', note: 'Revised' }, (st) => st.subscriptions[0].proxy?.personId === 'target'],
  ['set_proxy', { subscription: 's', action: 'remove' }, (st) => !st.subscriptions[0].proxy],
  [
    'update_settings',
    {
      set: { baseCurrency: 'CNY', signedAmounts: false, remindDays: 7, publicView: true, publicHidden: ['s'] },
      channel_enabled: [{ id: 'channel', enabled: true }],
      prefs: { theme: 'dark' },
    },
    (st) => st.settings.baseCurrency === 'CNY' && st.settings.channels?.[0].config.token === 'SECRET' && st.prefs?.theme === 'dark',
  ],
  [
    'record_receivable',
    { action: 'update', subscription: 's', kind: 'share', member: 'member', id: 'r1', amount: 0 },
    (st) =>
      st.subscriptions[0].share?.members[0].receipts?.[0].amount === 0 && st.subscriptions[0].share?.members[0].receipts?.[0].periods[0] === todayIn('UTC'),
  ],
  [
    'record_receivable',
    { action: 'delete', subscription: 's', kind: 'share', member: 'member', id: 'r1' },
    (st) => st.subscriptions[0].share?.members[0].receipts?.length === 0,
  ],
  [
    'record_receivable',
    { action: 'charged', subscription: 's', kind: 'proxy', charge: todayIn('UTC'), charged_amount: 12, charged_currency: 'USD' },
    (st) => st.subscriptions[0].proxy?.charged?.[0].amount === 12 && st.subscriptions[0].proxy?.charged?.[0].currency === 'USD',
  ],
  ['record_receivable', { action: 'delete', subscription: 's', kind: 'proxy', id: 'p1' }, (st) => st.subscriptions[0].proxy?.receipts?.length === 0],
  [
    'record_receivable',
    // 免收下一期
    { action: 'waive', subscription: 's', kind: 'proxy' },
    (st) => st.subscriptions[0].proxy?.waivers?.length === 1 && st.subscriptions[0].proxy.waivers[0].periods[0] > todayIn('UTC'),
  ],
  [
    'record_receivable',
    // 预收：一笔覆盖接下来 3 期（今天这期已收，跳过），按期均摊
    { subscription: 's', kind: 'proxy', amount: 30, currency: 'USD', count: 3 },
    (st) => {
      const r = st.subscriptions[0].proxy?.receipts?.find((x) => x.amount === 30);
      return !!r && r.periods.length === 3 && r.periods.every((k) => k > todayIn('UTC'));
    },
  ],
  [
    'update_subscription',
    { subscription: 's', set: { icon: '🌱', show_on_public: true, bonus: { from: '2026-11-01', until: '2026-11-10' } } },
    (st) => st.subscriptions[0].showOnPublic === true,
  ],
  [
    'save_subscription',
    { subscription: { ...sub(), share: undefined, proxy: undefined, notes: 'Replaced in full' } },
    (st) => st.subscriptions[0].notes === 'Replaced in full' && !st.subscriptions[0].share && !st.subscriptions[0].proxy,
  ],
  [
    'change_plan',
    { subscription: 's', action: 'edit', at: todayIn('UTC'), set: { price: 15, priceHistory: [{ from: todayIn('UTC'), amount: 15 }], nextDue: '2026-12-01' } },
    (st) => st.subscriptions[0].phases?.[0].price === 15,
  ],
];
for (const [name, args, verify] of mutations)
  test(`${name} ${JSON.stringify(args)}: MCP preview, permission denial, save and reread`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const before = await f.snapshot();
    const preview = await f.call(name, { ...args, dry_run: true });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    assert.equal(preview.structuredContent.dry_run, true);
    assert.deepEqual(await f.snapshot(), before);
    const denied = await f.call(name, args, f.read);
    assert.equal(denied.isError, true);
    assert.deepEqual(await f.snapshot(), before);
    const saved = await f.call(name, args);
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    const after = await f.snapshot();
    assert.ok(verify(after), JSON.stringify(after));
    assert.ok(after.rev! > before.rev!);
  });

test('every new read tool and connection catalogue: read token visibility, titles, secrets, all writes denied', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  const listed = await f.rpc('tools/list', {}, f.read);
  assert.equal(listed.tools.length, TOOLS.filter((x) => !x.write).length);
  assert.equal(TOOLS.length, 36);
  assert.deepEqual(
    ASSISTANT_TOOLS.map((x) => x.name),
    TOOLS.map((x) => x.name),
  );
  for (const tool of TOOLS.filter((x) => x.write)) {
    assert.equal((await f.call(tool.name, {}, f.read)).isError, true);
    assert.ok((tool.inputSchema.properties as object).hasOwnProperty('dry_run'));
  }
  const settings = await f.call('get_settings', {}, f.read);
  assert.equal(settings.isError, undefined);
  assert.doesNotMatch(JSON.stringify(settings), /SECRET|private.example/);
  for (const name of ['save_category', 'save_person', 'get_settings', 'update_settings', 'set_proxy']) {
    const response = await f.request('mcp/tools');
    const metadata = (await response.json()).find((x: { name: string }) => x.name === name);
    assert.ok(metadata.title && metadata.title !== `mcp.tool.${name}`);
  }
  assert.deepEqual(await f.snapshot(), before);
});

test('delete references block and report exact links; missing indices/unknown security fields never write', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  for (const [name, args] of [
    ['update_payment_method', { action: 'delete', method: 'wallet' }],
    ['save_category', { action: 'delete', category: 'Test' }],
    ['save_person', { action: 'delete', person: 'person' }],
  ] as const) {
    const r = await f.call(name, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /s|Fictional/);
  }
  for (const [name, args] of [
    ['record_receivable', { action: 'delete', subscription: 's', kind: 'share', member: 'member', index: 88 }],
    ['record_receivable', { action: 'delete', subscription: 's', kind: 'proxy', charge: '2000-01-01' }],
    ['update_payment_method', { method: 'wallet', top_up_action: 'delete', top_up_index: 100 }],
    ['update_settings', { set: { maxSessions: 1 } }],
    ['update_settings', { set: { aiEnabled: false } }],
    ['update_settings', { set: { channels: [] } }],
    ['update_settings', { channel_enabled: [{ id: 'channel', enabled: true, config: { token: 'overwrite' } }] }],
    ['save_person', { action: 'create', set: { name: '' } }],
    ['update_payment_method', { action: 'create', set: { name: 'Invalid', kind: 'prepaid', currency: 'ZZZ' } }],
    ['save_category', { action: 'create', set: { name: 'Test' } }],
    ['update_settings', { set: { remindDays: null } }],
  ] as const) {
    const r = await f.call(name, args);
    assert.equal(r.isError, true, JSON.stringify([name, args, r]));
  }
  assert.deepEqual(await f.snapshot(), before);
});

test('legacy people read during dry_run cannot write an implicit migration; a failed read never replaces state', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const legacy = sub();
  delete legacy.share!.members[0].personId;
  delete legacy.proxy!.personId;
  await upsert(f.env, 'subscriptions', 's', legacy);
  await putKv(f.env, 'people', []);
  const revision = await getRev(f.env);
  assert.equal((await f.call('update_settings', { set: { remindDays: 5 }, dry_run: true })).isError, undefined);
  assert.equal(await getRev(f.env), revision);
  const before = await f.snapshot();
  const original = f.env.DB.batch;
  f.env.DB.batch = async () => {
    throw new Error('Fictional read failure');
  };
  assert.equal((await f.call('save_category', { action: 'create', set: { name: 'Unsafe replacement' } })).isError, true);
  f.env.DB.batch = original;
  assert.deepEqual(await f.snapshot(), before);
});

test('multi-entity migrations roll back atomically when a later write fails', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  f.db.exec("CREATE TRIGGER fictional_fail BEFORE DELETE ON methods BEGIN SELECT RAISE(ABORT, 'Fictional write failure'); END");
  assert.equal((await f.call('update_payment_method', { action: 'delete', method: 'wallet', migrate_to: 'target' })).isError, true);
  assert.deepEqual(await f.snapshot(), before);
});

const categoryWrite = (tool: string, category: string, extra: object = {}) =>
  tool === 'create_subscription'
    ? { name: 'New fictional subscription', price: 12, currency: 'USD', cycle: { unit: 'month' }, category, ...extra }
    : { subscription: 's', set: { category }, ...extra };

for (const tool of ['create_subscription', 'update_subscription']) {
  test(`strict category references: ${tool} rejects unknown names without any writes`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const before = await f.snapshot();
    for (const dry_run of [false, true]) {
      for (const category of ['Typo category', 'Tes', '']) {
        const r = await f.call(tool, categoryWrite(tool, category, { dry_run }));
        assert.equal(r.isError, true, JSON.stringify(r));
        assert.match(r.content[0].text, /Test/);
        assert.match(r.content[0].text, /Other/);
        assert.deepEqual(await f.snapshot(), before);
      }
    }
  });

  test(`strict category references: ${tool} explicitly creates and references a validated category atomically`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const before = await f.snapshot();
    const args = categoryWrite(tool, 'New category', { create_category: true, category_icon: 'book', category_color: '#aabbcc' });
    const ctx: ToolCtx = { env: f.env, overlay: new Map() };
    const preview = (await TOOLS.find((x) => x.name === tool)!.run({ ...args, dry_run: true }, ctx)) as any;
    assert.deepEqual(preview.created_category, { name: 'New category', icon: 'book', color: '#aabbcc' });
    assert.match(preview.category_notice, /New category/);
    assert.equal(preview.after.category, 'New category');
    assert.deepEqual(await f.snapshot(), before);
    const rpcPreview = await f.call(tool, { ...args, dry_run: true });
    assert.equal(rpcPreview.isError, undefined, JSON.stringify(rpcPreview));
    assert.deepEqual(rpcPreview.structuredContent.created_category, preview.created_category);
    assert.equal((await f.call(tool, args, f.read)).isError, true);
    assert.deepEqual(await f.snapshot(), before);
    const later = await TOOLS.find((x) => x.name === 'update_subscription')!.run({ subscription: 's', set: { category: 'NEW CATEGORY' }, dry_run: true }, ctx);
    assert.equal((later as any).after.category, 'New category');
    assert.deepEqual(await f.snapshot(), before);

    // Settings are written after subscriptions in saveLedgerEdit: both must roll back.
    f.db.exec("CREATE TRIGGER fictional_category_fail BEFORE UPDATE ON kv WHEN NEW.key = 'settings' BEGIN SELECT RAISE(ABORT, 'Fictional write failure'); END");
    assert.equal((await f.call(tool, args)).isError, true);
    assert.deepEqual(await f.snapshot(), before);
    f.db.exec('DROP TRIGGER fictional_category_fail');
    const result = await f.call(tool, args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(result.structuredContent.created_category, preview.created_category);
    const saved = await f.snapshot();
    assert.deepEqual(saved.settings.categories?.at(-1), preview.created_category);
    assert.equal(saved.subscriptions.find((s) => s.id === result.structuredContent.after.id)?.category, 'New category');
    assert.equal((await f.call('list_categories', {})).structuredContent.items.filter((c: any) => c.name === 'New category').length, 1);
  });

  test(`strict category references: ${tool} matches codes, case and localized aliases while retaining historical names`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const st = await f.snapshot();
    await putKv(f.env, 'settings', { ...st.settings, categories: [{ name: 'Renamed tools', preset: 'tools' }, { name: 'Custom' }] });
    // Test is now a historical subscription category absent from the registry.
    const before = await f.snapshot();
    for (const [category, expected] of [
      ['tools', 'Renamed tools'],
      ['rEnAmEd ToOlS', 'Renamed tools'],
      ['tOoLs', 'Renamed tools'],
      ['工具', 'Renamed tools'],
      ['oUtIlS', 'Renamed tools'],
      ['ツール', 'Renamed tools'],
      ['custom', 'Custom'],
      ['TEST', 'Test'],
    ]) {
      const r = await f.call(tool, categoryWrite(tool, category, { create_category: true, dry_run: true }));
      assert.equal(r.isError, undefined, JSON.stringify(r));
      assert.equal(r.structuredContent.after.category, expected);
      assert.equal(r.structuredContent.created_category, undefined);
      assert.deepEqual(await f.snapshot(), before);
    }
    const saved = await f.call(tool, categoryWrite(tool, 'TEST'));
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    assert.equal(saved.structuredContent.after.category, 'Test');
    assert.deepEqual((await f.snapshot()).settings.categories, before.settings.categories);
  });

  test(`strict category references: ${tool} rejects ambiguity even with explicit creation`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const st = await f.snapshot();
    await putKv(f.env, 'settings', {
      ...st.settings,
      categories: [{ name: 'Mixed' }, { name: 'MIXED' }, { name: 'First', preset: 'tools' }, { name: 'Second', preset: 'tools' }],
    });
    const before = await f.snapshot();
    for (const category of ['mixed', 'tools', 'OUTILS']) {
      for (const create_category of [false, true]) {
        const r = await f.call(tool, categoryWrite(tool, category, { create_category }));
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, category === 'mixed' ? /Mixed.*MIXED/ : /First.*Second/);
        assert.deepEqual(await f.snapshot(), before);
      }
    }
    const exact = await f.call(tool, categoryWrite(tool, 'Mixed', { dry_run: true }));
    assert.equal(exact.isError, undefined, JSON.stringify(exact));
    assert.equal(exact.structuredContent.after.category, 'Mixed');
  });

  test(`strict category references: ${tool} shares save_category validation and leaves no failed drafts`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const before = await f.snapshot();
    for (const name of [' ', 'x'.repeat(41)]) {
      assert.equal((await f.call(tool, categoryWrite(tool, name, { create_category: true }))).isError, true);
      assert.deepEqual(await f.snapshot(), before);
    }
    const ctx: ToolCtx = { env: f.env, overlay: new Map() };
    const invalid = tool === 'create_subscription' ? { method: 'Missing wallet' } : { set: { category: 'New category', method: 'Missing wallet' } };
    await assert.rejects(() =>
      TOOLS.find((x) => x.name === tool)!.run(categoryWrite(tool, 'New category', { create_category: true, dry_run: true, ...invalid }), ctx),
    );
    assert.equal(ctx.draftState, undefined);
    assert.equal(ctx.overlay!.size, 0);
    // Existing save_category drops invalid optional icon/color values; inline creation must do the same.
    const fields = { name: 'Cleaned category', icon: 'x'.repeat(33), color: 'invalid' };
    const registry = await f.call('save_category', { action: 'create', set: fields, dry_run: true });
    const inline = await f.call(
      tool,
      categoryWrite(tool, fields.name, { create_category: true, category_icon: fields.icon, category_color: fields.color, dry_run: true }),
    );
    assert.equal(inline.isError, undefined, JSON.stringify(inline));
    assert.deepEqual(inline.structuredContent.created_category, registry.structuredContent.after.at(-1));
    assert.deepEqual(await f.snapshot(), before);
  });
}

test('strict category references: assistant enrichment preserves unknown/localized inputs and confirmation creates only on apply', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  for (const category of ['Typo category', '工具']) {
    const args = categoryWrite('create_subscription', category, { icon: 'https://example.test/icon.png', url: 'https://example.test' });
    assert.equal((await enrichDraft(args)).args.category, category);
    const enriched = await enrichDraft({ set: { category } });
    assert.equal((enriched.args.set as any).category, category);
  }
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test', model: 'fictional' });
  const args = categoryWrite('create_subscription', 'Assistant category', {
    create_category: true,
    category_icon: 'book',
    category_color: 'c3',
    icon: 'https://example.test/icon.png',
    url: 'https://example.test',
    dry_run: false,
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const delta =
      calls++ === 0
        ? { tool_calls: [{ index: 0, id: 'category-call', type: 'function', function: { name: 'create_subscription', arguments: JSON.stringify(args) } }] }
        : { content: 'Draft ready.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const stream = await (await chat(f.env, { text: 'Create a subscription and category', history: [] }, new AbortController().signal)).text();
  const proposal = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .find((e) => e.type === 'proposal');
  assert.ok(proposal, stream);
  assert.equal(proposal.preview.created_category.name, 'Assistant category');
  assert.equal(proposal.args.create_category, true);
  assert.deepEqual(await f.snapshot(), before);
  await apply(f.env, { tool: proposal.tool, args: proposal.args });
  const after = await f.snapshot();
  assert.ok(after.settings.categories?.some((c) => c.name === 'Assistant category' && c.icon === 'book' && c.color === 'c3'));
  assert.equal(after.subscriptions.find((s) => s.id === proposal.args.id)?.category, 'Assistant category');
});

test('strict category references: omitted category uses an existing Tools category and never recreates a removed default', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const args = { name: 'Fictional default category', price: 12, currency: 'USD', cycle: { unit: 'month' }, dry_run: true };
  const before = await f.snapshot();
  assert.equal((await f.call('create_subscription', args)).isError, true);
  assert.equal((await f.call('create_subscription', { ...args, create_category: true })).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  await putKv(f.env, 'settings', { ...before.settings, categories: [{ name: 'Renamed tools', preset: 'tools' }] });
  const withDefault = await f.snapshot();
  const preview = await f.call('create_subscription', args);
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.after.category, 'Renamed tools');
  assert.deepEqual(await f.snapshot(), withDefault);
});

test('assistant draft dependencies cover wallets/categories/people/settings; stable ids apply in order', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const ctx: ToolCtx = { env: f.env, overlay: new Map() };
  const before = await f.snapshot();
  const tool = (name: string) => TOOLS.find((x) => x.name === name)!;
  const wallet = (await tool('update_payment_method').run(
    { action: 'create', set: { name: 'Draft wallet', kind: 'credit', currency: 'USD' }, dry_run: true },
    ctx,
  )) as any;
  const person = (await tool('save_person').run({ action: 'create', set: { name: 'Draft person' }, dry_run: true }, ctx)) as any;
  await tool('save_category').run({ action: 'create', set: { name: 'Draft category' }, dry_run: true }, ctx);
  const create = {
    id: 'draftsub',
    name: 'Draft subscription',
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: todayIn('UTC'),
    method: wallet.created.id,
    category: 'Draft category',
  };
  await tool('create_subscription').run({ ...create, dry_run: true }, ctx);
  await tool('set_proxy').run({ subscription: 'draftsub', person: person.created.id, dry_run: true }, ctx);
  assert.equal(ctx.overlay!.get('draftsub')!.proxy!.personId, person.created.id);
  assert.deepEqual(await f.snapshot(), before);
  await apply(f.env, {
    tool: 'update_payment_method',
    args: { action: 'create', id: wallet.created.id, set: { name: 'Draft wallet', kind: 'credit', currency: 'USD' } },
  });
  await apply(f.env, { tool: 'save_person', args: { action: 'create', id: person.created.id, set: { name: 'Draft person' } } });
  await apply(f.env, { tool: 'save_category', args: { action: 'create', set: { name: 'Draft category' } } });
  await apply(f.env, { tool: 'create_subscription', args: create });
  await apply(f.env, { tool: 'set_proxy', args: { subscription: 'draftsub', person: person.created.id } });
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 'draftsub')?.proxy?.personId, person.created.id);
});

// Provider is fictional and intercepted; no external AI or notification endpoint is used.
test('actual assistant chat forces new writes to proposals; only confirmed apply mutates', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test', model: 'fictional' });
  const before = await f.snapshot();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const delta =
      calls++ === 0
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call1',
                type: 'function',
                function: { name: 'update_settings', arguments: JSON.stringify({ set: { signedAmounts: false }, dry_run: false }) },
              },
            ],
          }
        : { content: 'Draft ready.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const response = await chat(f.env, { text: 'Change signs', history: [] }, new AbortController().signal);
  const stream = await response.text();
  assert.match(stream, /proposal/);
  assert.deepEqual(await f.snapshot(), before);
  await apply(f.env, { tool: 'update_settings', args: { set: { signedAmounts: false } } });
  assert.equal((await f.snapshot()).settings.signedAmounts, false);
});

test('assistant pins member id when adding by person without a name; later receipt applies to that same member', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test', model: 'fictional' });
  const before = await f.snapshot();
  let round = 0;
  let memberId = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let delta: object;
    if (round++ === 0)
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'member-call',
            type: 'function',
            function: { name: 'save_share_member', arguments: JSON.stringify({ subscription: 's', person: 'target', fee: 2, bill_every: 1 }) },
          },
        ],
      };
    else if (round === 2) {
      const result = JSON.parse(request.messages.at(-1).content);
      memberId = result.preview.member.id;
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'receipt-call',
            type: 'function',
            function: { name: 'record_receivable', arguments: JSON.stringify({ subscription: 's', kind: 'share', member: memberId, amount: 2 }) },
          },
        ],
      };
    } else delta = { content: 'Drafts ready.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const stream = await chat(f.env, { text: 'Add the target person and record their payment' }, new AbortController().signal).text();
  const proposals = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((e) => e.type === 'proposal');
  assert.equal(proposals.length, 2, stream);
  assert.equal(proposals[0].args.id, memberId);
  assert.deepEqual(await f.snapshot(), before);
  for (const p of proposals) await apply(f.env, p);
  const member = (await f.snapshot()).subscriptions[0].share!.members.find((m) => m.id === memberId)!;
  assert.equal(member.personId, 'target');
  assert.equal(member.receipts?.[0].amount, 2);
});

test('价格历史 MCP：编辑、删除、起始价保护、预览及只读权限', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = {
    ...sub(),
    start: '2022-01-15',
    price: 15,
    currency: 'USD',
    share: undefined,
    proxy: undefined,
    phases: [
      {
        start: '2022-01-15',
        end: '2025-12-31',
        price: 200,
        currency: 'TRY',
        cycle: { unit: 'month', every: 1 },
        region: 'TR',
        priceHistory: [
          { from: '2022-01-15', amount: 40 },
          { from: '2023-01-15', amount: 60 },
          { from: '2024-01-15', amount: 120 },
          { from: '2025-01-15', amount: 200 },
        ],
        payments: [{ date: '2022-01-15', amount: 39, note: 'Actual' }],
      },
      { start: '2026-01-01', price: 15, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'US' },
    ],
  };
  await upsert(f.env, 'subscriptions', 's', s);
  const phases = s.phases!;
  for (const args of [
    { action: 'edit', phase: s.start, original_from: '2024-01-15', from: '2024-02-15', amount: 130 },
    { action: 'remove', phase: s.start, original_from: '2023-01-15' },
    { action: 'edit', phase: s.start, original_from: s.start, amount: 35 },
  ]) {
    const before = await f.snapshot();
    const preview = await f.call('change_price', { subscription: 's', ...args, dry_run: true });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    assert.ok(preview.structuredContent.affected_estimated_charges > 0);
    assert.deepEqual(await f.snapshot(), before);
    const denied = await f.call('change_price', { subscription: 's', ...args }, f.read);
    assert.equal(denied.isError, true);
    assert.deepEqual(await f.snapshot(), before);
    const saved = await f.call('change_price', { subscription: 's', ...args });
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    const actual = (await f.snapshot()).subscriptions[0];
    assert.deepEqual(actual.phases![0].payments, phases[0].payments);
    assert.deepEqual(actual.phases![1], phases[1]);
    assert.equal(actual.price, 15);
  }
  const revised = (await f.snapshot()).subscriptions[0];
  assert.deepEqual(revised.phases![0].priceHistory, [
    { from: '2022-01-15', amount: 35 },
    { from: '2024-02-15', amount: 130 },
    { from: '2025-01-15', amount: 200 },
  ]);
  const before = await f.snapshot();
  for (const args of [
    { action: 'remove', phase: s.start, original_from: s.start },
    { action: 'edit', phase: s.start, original_from: '2025-01-15', from: '2024-02-15', amount: 90 },
    { action: 'edit', phase: s.start, original_from: '2025-01-15', from: '2026-01-01', amount: 90 },
    { action: 'edit', original_from: '2025-01-15', amount: 90 },
  ]) {
    const failed = await f.call('change_price', { subscription: 's', ...args });
    assert.equal(failed.isError, true, JSON.stringify(failed));
    assert.deepEqual(await f.snapshot(), before);
  }
  const planArgs = {
    subscription: 's',
    action: 'edit',
    at: s.start,
    set: {
      priceHistory: [
        { from: '2025-01-15', amount: 180 },
        { from: s.start, amount: 32 },
      ],
    },
  };
  const preview = await f.call('change_plan', { ...planArgs, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.ok(preview.structuredContent.affected_estimated_charges > 0);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('change_plan', planArgs, f.read)).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('change_plan', planArgs)).isError, undefined);
  const after = (await f.snapshot()).subscriptions[0];
  assert.equal(after.phases![0].price, 180);
  assert.deepEqual(after.phases![0].priceHistory, [
    { from: s.start, amount: 32 },
    { from: '2025-01-15', amount: 180 },
  ]);
  assert.deepEqual(after.phases![0].payments, phases[0].payments);
  assert.deepEqual(after.phases![1], phases[1]);
});

test('renewal rules: MCP create/update preview, read scope, dates, validation and API history', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  const args = {
    name: 'Fictional domain',
    category: 'Test',
    price: 12,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'year', every: 1 },
    chargeLeadDays: 30,
    cancelLeadDays: 1,
  };
  const preview = await f.call('create_subscription', { ...args, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('create_subscription', args, f.read)).isError, true);
  const saved = await f.call('create_subscription', args);
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  const domain = (await f.snapshot()).subscriptions.find((s) => s.name === args.name)!;
  const detail = await f.call('get_subscription', { subscription: domain.id }, f.read);
  assert.equal(detail.structuredContent.next_charge, '2026-12-02');
  assert.equal(detail.structuredContent.service_expires, '2027-01-01');
  assert.equal(detail.structuredContent.cancel_by, '2026-12-01');
  const patch = { subscription: domain.id, set: { chargeLeadDays: 10, cancelLeadDays: 2 } };
  const original = await f.snapshot();
  assert.equal((await f.call('update_subscription', { ...patch, dry_run: true })).isError, undefined);
  assert.deepEqual(await f.snapshot(), original);
  assert.equal((await f.call('update_subscription', patch, f.read)).isError, true);
  assert.equal((await f.call('update_subscription', patch)).isError, undefined);
  const updated = (await f.snapshot()).subscriptions.find((s) => s.id === domain.id)!;
  assert.equal(updated.renewalHistory?.[0].chargeLeadDays, 30);
  assert.equal(updated.renewalHistory?.at(-1)?.chargeLeadDays, 10);
  for (const value of [-1, 1.5, 3661]) {
    assert.equal((await f.call('update_subscription', { subscription: domain.id, set: { chargeLeadDays: value } })).isError, true);
    assert.equal((await f.call('create_subscription', { ...args, name: `Invalid ${value}`, chargeLeadDays: value })).isError, true);
  }
  const response = await f.request(`subscriptions/${domain.id}`, 'PUT', { ...updated, cancelLeadDays: 7, renewalHistory: undefined });
  assert.equal(response.status, 200, await response.clone().text());
  const apiRecord = await response.json();
  assert.equal(apiRecord.renewalHistory[0].chargeLeadDays, 30);
  assert.equal(apiRecord.renewalHistory.at(-1).cancelLeadDays, 7);
  const denied = await f.request(`subscriptions/${domain.id}`, 'PUT', updated, false);
  assert.equal(denied.status, 401);
});

const avatarPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('private person avatar: authenticated API, MCP permissions/preview/removal, masking and backup round-trip', async () => {
  const f = await setup();
  try {
    const avatar = avatarPng;
    const args = { action: 'update', person: 'person', avatar_base64: avatar.split(',')[1], mime: 'image/png' };
    const rev = await getRev(f.env);
    const snapshot = JSON.stringify(await f.snapshot());
    assert.equal((await f.call('save_person', { ...args, dry_run: true })).isError, undefined);
    assert.equal(await getRev(f.env), rev);
    assert.equal(JSON.stringify(await f.snapshot()), snapshot);
    assert.equal((await f.call('save_person', args, f.read)).isError, true);
    assert.equal((await f.call('save_person', args)).isError, undefined);
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, avatar);
    const rows = await f.call('list_people', {});
    assert.ok(JSON.stringify(rows).includes('has_avatar'));
    assert.ok(!JSON.stringify(rows).includes('data:image'));
    assert.ok(!JSON.stringify(rows).includes(args.avatar_base64));
    const changedRev = await getRev(f.env);
    for (const invalid of [
      { avatar_url: 'http://example.test/a.png' },
      { avatar_url: 'https://example.test/a.png' },
      { avatar_url: 'file:///a.png' },
      { avatar_base64: 'A'.repeat(90_000), mime: 'image/png' },
      { avatar_base64: args.avatar_base64, mime: 'image/svg+xml' },
      { avatar: null, avatar_base64: args.avatar_base64, mime: 'image/png' },
      { mime: 'image/png' },
    ])
      assert.equal((await f.call('save_person', { action: 'update', person: 'person', ...invalid })).isError, true);
    assert.equal(await getRev(f.env), changedRev);
    assert.equal((await f.request('people/person', 'PUT', { id: 'person', name: 'Fictional person', avatar }, false)).status, 401);
    assert.equal((await f.request('people/person', 'PUT', { id: 'person', name: 'Fictional person', avatar: 'https://example.test/a.png' })).status, 400);
    assert.equal((await f.request('people/person', 'PUT', { id: 'person', name: 'Fictional person', avatar })).status, 200);
    await putKv(f.env, 'settings', { ...(await f.snapshot()).settings, publicView: true });
    await upsert(f.env, 'subscriptions', 'public-sharing', { ...sub(), id: 'public-sharing', proxy: undefined });
    const publicResponse = await f.request('public', 'GET', undefined, false);
    assert.equal(publicResponse.status, 200);
    const publicState = await publicResponse.json();
    assert.equal(publicState.people, undefined);
    assert.equal(publicState.subscriptions.length, 1);
    assert.equal(publicState.subscriptions[0].share, undefined);
    assert.ok(!JSON.stringify(publicState).includes(avatar));
    assert.ok(!JSON.stringify(publicState).includes('personId'));
    const backup = await (await f.request('backup')).json();
    assert.equal(backup.people.find((p: { id: string }) => p.id === 'person').avatar, avatar);
    const { parseBackup } = await import('../worker/backup.ts');
    assert.equal(parseBackup({ subscriptions: [], version: 2 }).people.length, 0);
    const malformed = structuredClone(backup);
    malformed.people[0].avatar = 'http://example.test/a.png';
    assert.equal((await f.request('backup', 'POST', malformed)).status, 400);
    assert.equal((await f.call('save_person', { action: 'update', person: 'person', avatar: null, dry_run: true })).isError, undefined);
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, avatar);
    assert.equal((await f.call('save_person', { action: 'update', person: 'person', avatar: null })).isError, undefined);
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, undefined);
    assert.equal((await f.request('backup', 'POST', backup)).status, 200);
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, avatar);
    assert.equal((await f.request('people/person', 'PUT', { id: 'person', name: 'Fictional person' })).status, 200);
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, undefined);
    await apply(f.env, { tool: 'save_person', args });
    assert.equal((await f.snapshot()).people?.find((p) => p.id === 'person')?.avatar, avatar);
  } finally {
    f.db.close();
  }
});

test('accounts belong to person × plan: API/MCP persistence, independent updates, preview, permissions and public privacy', async () => {
  const f = await setup();
  try {
    const make = (id: string, name: string, account: string): Subscription => ({
      ...sub(),
      id,
      name,
      proxy: undefined,
      share: { ...sub().share!, members: [{ ...sub().share!.members[0], account }] },
    });
    for (const s of [make('youtube', 'YouTube', 'alex@example.test'), make('spotify', 'Spotify', '+65 8000 0000')]) {
      assert.equal((await f.request(`subscriptions/${s.id}`, 'PUT', s, false)).status, 401);
      assert.equal((await f.request(`subscriptions/${s.id}`, 'PUT', s)).status, 200);
    }
    const accounts = async () => {
      const result = await f.call('list_people', {}, f.read);
      assert.equal(result.isError, undefined);
      const person = result.structuredContent.people.find((p: { person_id: string }) => p.person_id === 'person');
      assert.ok(!('account' in person.record));
      assert.ok(!('account' in person.in.find((i: { kind: string }) => i.kind === 'proxy')));
      return Object.fromEntries(
        person.in.filter((i: { kind: string }) => i.kind === 'share').map((i: { subscription_id: string; account?: string }) => [i.subscription_id, i.account]),
      );
    };
    assert.deepEqual(await accounts(), { s: null, youtube: 'alex@example.test', spotify: '+65 8000 0000' });
    // The fixture also has a share membership and a proxy relationship on s.
    const patch = { subscription: 'youtube', member: 'member', account: '  user / arbitrary ID #42  ' };
    const before = await f.snapshot();
    const rev = await getRev(f.env);
    assert.equal((await f.call('save_share_member', { ...patch, dry_run: true })).isError, undefined);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(await getRev(f.env), rev);
    assert.equal((await f.call('save_share_member', patch, f.read)).isError, true);
    assert.equal((await f.call('save_share_member', patch)).isError, undefined);
    assert.equal((await accounts()).youtube, 'user / arbitrary ID #42');
    assert.equal((await accounts()).spotify, '+65 8000 0000');
    assert.equal(
      (await f.call('save_person', { action: 'update', person: 'person', set: { name: 'Alex', contact: 'alex-contact@example.test', contactVia: '邮箱' } }))
        .isError,
      undefined,
    );
    assert.equal((await accounts()).youtube, 'user / arbitrary ID #42');
    assert.equal((await accounts()).spotify, '+65 8000 0000');
    assert.equal((await f.call('save_person', { action: 'update', person: 'person', set: { account: 'wrong scope' } })).isError, true);
    await putKv(f.env, 'settings', { ...(await f.snapshot()).settings, publicView: true });
    const response = await f.request('public', 'GET', undefined, false);
    assert.equal(response.status, 200);
    const publicState = await response.json();
    assert.equal(publicState.subscriptions.length, 2);
    for (const s of publicState.subscriptions) {
      assert.equal(s.account, undefined);
      assert.equal(s.share, undefined);
    }
    const serialized = JSON.stringify(publicState);
    for (const secret of ['alex@example.test', '+65 8000 0000', 'user / arbitrary ID #42', 'alex-contact@example.test'])
      assert.ok(!serialized.includes(secret));
    assert.equal((await f.call('save_share_member', { ...patch, account: '  ' })).isError, undefined);
    const cleared = (await f.snapshot()).subscriptions.find((s) => s.id === 'youtube')!.share!.members[0];
    assert.equal(cleared.account, undefined);
    assert.equal((await accounts()).youtube, null);
    assert.equal((await accounts()).spotify, '+65 8000 0000');
  } finally {
    f.db.close();
  }
});

test('collect_day=joined: MCP pins the anchor only for whole first periods and moves it with the join date', async () => {
  const f = await setup();
  try {
    const plan = async () => (await f.call('get_carpool', { subscription: 's' }, f.read)).structuredContent.plans[0];
    const member = async (id: string) =>
      (await f.snapshot()).subscriptions.find((s) => s.id === 's')!.share!.members.find((m) => m.id === id || m.name === id)!;
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', seats: 8 })).isError, undefined);
    // 实际保存：钉在加入日，之前给的首期方式不再适用；不分摊的不钉；改加入日时基准日跟着挪
    assert.equal(
      (await f.call('save_share_member', { subscription: 's', name: 'Own day', joined: '2026-10-20', collect_day: 'joined', first_period: 'full' })).isError,
      undefined,
    );
    assert.equal((await member('Own day')).anchor, '2026-10-20');
    assert.equal((await member('Own day')).firstPeriod, undefined);
    assert.equal((await f.call('save_share_member', { subscription: 's', member: 'Own day', joined: '2026-10-25' })).isError, undefined);
    assert.equal((await member('Own day')).anchor, '2026-10-25');
    assert.equal(
      (await f.call('save_share_member', { subscription: 's', name: 'Free rider', joined: '2026-10-20', exempt: true, collect_day: 'joined' })).isError,
      undefined,
    );
    assert.equal((await member('Free rider')).anchor, undefined);
    // 加入日就在车的收款日上：首期本来完整，不钉
    const carAnchor = (await plan()).collect_from as string;
    const onDay = `2026-10-${carAnchor.slice(8, 10)}`;
    assert.equal((await f.call('save_share_member', { subscription: 's', name: 'On day', joined: onDay, collect_day: 'joined' })).isError, undefined);
    assert.equal((await member('On day')).anchor, undefined);
  } finally {
    f.db.close();
  }
});

test('carpool collection rule: MCP reads, sets, follows and customizes member fees', async () => {
  const f = await setup();
  try {
    const plan = async () => (await f.call('get_carpool', { subscription: 's' }, f.read)).structuredContent.plans[0];
    const member = async (id: string) =>
      (await f.snapshot()).subscriptions.find((s) => s.id === 's')!.share!.members.find((m) => m.id === id || m.name === id)!;
    let p = await plan();
    assert.deepEqual(p.rule, { fee: 3, currency: 'USD', every_months: 1, stored: false });
    assert.equal(p.members[0].follows_rule, true);
    assert.equal(p.members[0].overdue_days, 0);

    // 新成员没给收费标准时按车的规则
    assert.equal((await f.call('save_share_member', { subscription: 's', name: 'Newcomer' })).isError, undefined);
    assert.equal((await member('Newcomer')).fee, 3);
    assert.equal((await member('Newcomer')).feeCurrency, 'USD');
    // issue #9：新成员从加入日起收，基准日钉在加入日；非法取值报错
    const ownDay = await f.call('save_share_member', { subscription: 's', name: 'Own day', joined: '2026-10-20', collect_day: 'joined', dry_run: true });
    assert.equal(ownDay.isError, undefined);
    assert.deepEqual(ownDay.structuredContent.member.first_collection, {
      from: '2026-10-20',
      until: '2026-11-19',
      next: '2026-11-20',
      amount: 3,
      currency: 'USD',
      partial: false,
    });
    const carDay = await f.call('save_share_member', { subscription: 's', name: 'Car day', joined: '2026-10-20', dry_run: true });
    assert.equal(carDay.structuredContent.member.first_collection.partial, true);
    assert.equal((await f.call('save_share_member', { subscription: 's', name: 'Bad', collect_day: 'x', dry_run: true })).isError, true);

    // 预览不写入
    const before = await f.snapshot();
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { fee: 4 }, dry_run: true })).isError, undefined);
    assert.deepEqual(await f.snapshot(), before);

    const set = await f.call('set_share', { subscription: 's', role: 'owner', rule: { fee: 4 } });
    assert.equal(set.isError, undefined);
    assert.deepEqual(set.structuredContent.rule, { fee: 4, currency: 'USD', every_months: 1, stored: true });
    assert.equal((await member('member')).fee, 4);
    assert.equal((await member('Newcomer')).fee, 4);
    // 收款记录不受改规则影响
    assert.equal((await member('member')).receipts?.length, 1);

    // 单独改收费 → 自定义，之后改车的规则不再影响他
    const custom = await f.call('save_share_member', { subscription: 's', member: 'member', fee: 5 });
    assert.equal(custom.structuredContent.member.custom, true);
    assert.equal(custom.structuredContent.member.follows_rule, false);
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { fee: 6, bill_every: 3 } })).isError, undefined);
    assert.equal((await member('member')).fee, 5);
    assert.equal((await member('Newcomer')).fee, 6);
    assert.equal((await member('Newcomer')).billEvery, 3);

    // 改回跟随车
    const follow = await f.call('save_share_member', { subscription: 's', member: 'member', follow_rule: true });
    assert.equal(follow.structuredContent.member.follows_rule, true);
    assert.equal((await member('member')).fee, 6);
    assert.equal((await member('member')).custom, undefined);
    p = await plan();
    assert.ok(p.members.every((m: { follows_rule: boolean }) => m.follows_rule));

    // 只读令牌不能改规则；非法周期报错
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { fee: 1 } }, f.read)).isError, true);
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { bill_every: 121 } })).isError, true);
    assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { bill_every: 1.5 } })).isError, true);
    // 自定义周期：任意整月数（双月、两年）
    const bimonthly = await f.call('set_share', { subscription: 's', role: 'owner', rule: { bill_every: 2 } });
    assert.deepEqual(bimonthly.structuredContent.rule.every_months, 2);
    assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', bill_every: 24, dry_run: true })).isError, undefined);
    assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', bill_every: 0, dry_run: true })).isError, true);
  } finally {
    f.db.close();
  }
});

test('future custom fees are classified at their effective date, before later car-rule edits', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const from = addDays(today, 40);
  const s = { ...sub(), start: '2025-01-01', share: { ...sub().share!, rule: { fee: 3, currency: 'USD', billEvery: 1 } } };
  await upsert(f.env, 'subscriptions', 's', s);
  const edit = { subscription: 's', member: 'member', fee: 100, bill_every: 12, fee_from: from };
  const before = await f.snapshot();
  assert.equal((await f.call('save_share_member', { ...edit, dry_run: true })).isError, undefined);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('save_share_member', edit, f.read)).isError, true);
  assert.equal((await f.call('save_share_member', edit)).isError, undefined);
  let saved = (await f.snapshot()).subscriptions[0];
  assert.equal(saved.share!.members[0].custom, true);
  assert.equal(memberRate(saved, saved.share!.members[0], today).amount, 3);
  assert.equal(memberRate(saved, saved.share!.members[0], from).amount, 100);
  const custom = structuredClone(saved.share!.members[0]);
  assert.equal((await f.call('set_share', { subscription: 's', role: 'owner', rule: { fee: 4 } })).isError, undefined);
  saved = (await f.snapshot()).subscriptions[0];
  assert.deepEqual(saved.share!.members[0], custom);
  assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', fee: 4, bill_every: 1, fee_from: from })).isError, undefined);
  assert.equal((await f.snapshot()).subscriptions[0].share!.members[0].custom, undefined);
});

test('follow_rule ignores explicit fee fields without losing the old fee baseline or receipts', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const s = { ...sub(), start: '2025-01-01', share: { ...sub().share!, rule: { fee: 6, currency: 'USD', billEvery: 3 } } };
  await upsert(f.env, 'subscriptions', 's', s);
  assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', follow_rule: true, fee: 6, bill_every: 3 })).isError, undefined);
  const saved = (await f.snapshot()).subscriptions[0];
  const m = saved.share!.members[0];
  assert.deepEqual(memberRate(saved, m, addDays(today, -1)), { amount: 3, currency: 'USD', billEvery: 1 });
  assert.deepEqual(memberRate(saved, m, today), { amount: 6, currency: 'USD', billEvery: 3 });
  assert.deepEqual(m.receipts, s.share.members[0].receipts);
});

test('MCP overdue days match the UI for exempt and departed members with no unpaid periods', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s = sub();
  s.start = '2025-01-01';
  s.share!.members = [
    { id: 'exempt', name: 'Exempt', share: 0, fee: 0, exempt: true, joined: '2025-01-01' },
    {
      id: 'left',
      name: 'Departed settled',
      share: 3,
      fee: 3,
      left: '2025-06-01',
      joined: '2025-01-01',
      receipts: [{ id: 'r', date: '2025-01-01', amount: 15, currency: 'USD', periods: ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01'] }],
    },
    { id: 'arrears', name: 'Departed owing', share: 3, fee: 3, left: '2025-06-01', joined: '2025-01-01' },
  ];
  await upsert(f.env, 'subscriptions', 's', s);
  const result = await f.call('get_carpool', { subscription: 's' });
  const rows = result.structuredContent.plans[0].members;
  assert.equal(rows.find((m: { id: string }) => m.id === 'exempt').overdue_days, 0);
  assert.equal(rows.find((m: { id: string }) => m.id === 'left').overdue_days, 0);
  assert.ok(rows.find((m: { id: string }) => m.id === 'arrears').overdue_days > 0);
});

test('assistant car-rule and member drafts compose without saving; confirmation preserves dates and receipts', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
  const before = await f.snapshot();
  const today = todayIn('UTC');
  const from = addDays(today, 40);
  const edits = [
    { name: 'set_share', args: { subscription: 's', role: 'owner', rule: { fee: 6, bill_every: 3 }, rule_from: from } },
    { name: 'save_share_member', args: { subscription: 's', member: 'member', fee: 100, bill_every: 12, follow_rule: false } },
    { name: 'save_share_member', args: { subscription: 's', member: 'member', fee: 100, bill_every: 12, follow_rule: false, fee_from: from } },
    { name: 'save_share_member', args: { subscription: 's', name: 'Carol' } },
  ];
  let round = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const delta =
      round++ === 0
        ? {
            tool_calls: edits.map((e, index) => ({
              index,
              id: `car-${index}`,
              type: 'function',
              function: { name: e.name, arguments: JSON.stringify({ ...e.args, dry_run: false }) },
            })),
          }
        : { content: 'Drafts ready.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const stream = await chat(f.env, { text: 'Change the rule, customize a member, and add Carol' }, new AbortController().signal).text();
  const proposals = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((e) => e.type === 'proposal');
  assert.equal(proposals.length, 4, stream);
  assert.ok(proposals.every((p) => p.preview.dry_run === true));
  assert.deepEqual(await f.snapshot(), before);
  for (const p of proposals) {
    const response = await f.request('assistant/apply', 'POST', p);
    assert.equal(response.status, 200);
  }
  const s = (await f.snapshot()).subscriptions[0];
  const m = s.share!.members.find((m) => m.id === 'member')!;
  assert.deepEqual(memberRate(s, m, today), { amount: 100, currency: 'USD', billEvery: 12 });
  assert.deepEqual(memberRate(s, m, from), { amount: 100, currency: 'USD', billEvery: 12 });
  assert.equal(m.custom, true);
  assert.deepEqual(m.receipts, before.subscriptions[0].share!.members[0].receipts);
  const carol = s.share!.members.find((m) => m.name === 'Carol')!;
  assert.equal(carol.id, proposals[3].args.id);
  assert.deepEqual(memberRate(s, carol, today), { amount: 6, currency: 'USD', billEvery: 3 });
});

test('下车退款 MCP：预览无写入、读令牌拒绝写、实际退款保留收款、查询与清除一致', async () => {
  const f = await setup();
  try {
    const s = sub();
    s.proxy = undefined;
    s.start = '2026-01-01';
    const m = s.share!.members[0];
    Object.assign(m, {
      joined: '2026-01-01',
      receipts: [{ id: 'r1', date: '2026-01-01', amount: 31, currency: 'USD', periods: ['2026-01-01'] }],
    });
    await upsert(f.env, 'subscriptions', s.id, s);
    const args = { subscription: 's', member: 'member', left: '2026-01-16', leave_refund: { amount: 12.34, note: 'Private actual settlement' } };
    const before = await f.snapshot();
    const rev = await getRev(f.env);
    const preview = await f.call('save_share_member', { ...args, dry_run: true });
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent.suggested_refund.amount, 16);
    assert.equal(preview.structuredContent.unused_days, 16);
    assert.deepEqual(preview.structuredContent.member.leave_refund, { amount: 12.34, currency: 'USD', date: args.left, note: args.leave_refund.note });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(await getRev(f.env), rev);
    assert.equal((await f.call('save_share_member', args, f.read)).isError, true);
    assert.equal((await f.call('save_share_member', args)).isError, undefined);
    const saved = (await f.snapshot()).subscriptions[0];
    assert.deepEqual(saved.share!.members[0].receipts, m.receipts);
    const car = (await f.call('get_carpool', { subscription: 's' }, f.read)).structuredContent.plans[0];
    assert.equal(car.to_date.received, 18.66);
    assert.equal(car.members[0].leave_refund.amount, 12.34);
    assert.equal((await f.call('get_subscription', { subscription: 's' }, f.read)).structuredContent.share.members[0].leave_refund.amount, 12.34);
    const people = (await f.call('list_people', {}, f.read)).structuredContent.people;
    assert.equal(people.find((p: { person_id: string }) => p.person_id === 'person').in[0].leave_refund.amount, 12.34);
    await putKv(f.env, 'settings', { ...(await f.snapshot()).settings, publicView: true });
    const pub = await (await f.request('public', 'GET', undefined, false)).json();
    assert.ok(!JSON.stringify(pub).includes('Private actual settlement'));
    assert.equal(pub.subscriptions[0].share, undefined);
    const backup = await (await f.request('backup')).json();
    assert.equal(backup.subscriptions[0].share.members[0].leaveRefund.amount, 12.34);
    assert.equal((await f.request('backup', 'POST', backup)).status, 200);
    assert.deepEqual((await f.snapshot()).subscriptions[0].share!.members[0].leaveRefund, saved.share!.members[0].leaveRefund);
    assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', leave_refund: null })).isError, undefined);
    assert.equal((await f.snapshot()).subscriptions[0].share!.members[0].leaveRefund, undefined);
    assert.equal((await f.call('save_share_member', args)).isError, undefined);
    assert.equal((await f.call('save_share_member', { subscription: 's', member: 'member', left: null })).isError, undefined);
    const cleared = (await f.snapshot()).subscriptions[0].share!.members[0];
    assert.equal(cleared.left, undefined);
    assert.equal(cleared.leaveRefund, undefined);
    assert.deepEqual(cleared.receipts, m.receipts);
    // HTTP save clears an existing leave settlement as well.
    assert.equal((await f.call('save_share_member', args)).isError, undefined);
    const http = (await f.snapshot()).subscriptions[0];
    delete http.share!.members[0].left;
    assert.equal((await f.request('subscriptions/s', 'PUT', http)).status, 200);
    assert.equal((await f.snapshot()).subscriptions[0].share!.members[0].leaveRefund, undefined);
  } finally {
    f.db.close();
  }
});

test('退款校验贯穿 MCP、HTTP 和备份导入：正金额、有效币种日期、先设退出且不早于加入', async () => {
  const f = await setup();
  try {
    const s = sub();
    s.start = '2026-01-01';
    s.share!.members[0].joined = '2026-01-01';
    await upsert(f.env, 'subscriptions', s.id, s);
    const before = await f.snapshot();
    for (const patch of [
      { leave_refund: { amount: 1 } },
      { left: '2026-01-16', leave_refund: { amount: 0 } },
      { left: '2026-01-16', leave_refund: { amount: -1 } },
      { left: '2026-01-16', leave_refund: { amount: 1, date: '2025-12-31' } },
      { left: '2026-01-16', leave_refund: { amount: 1, date: '2026-02-30' } },
      { left: '2026-01-16', leave_refund: { amount: 1, currency: 'ZZZ' } },
      { left: null, leave_refund: { amount: 1 } },
    ]) {
      const r = await f.call('save_share_member', { subscription: 's', member: 'member', ...patch, dry_run: true });
      assert.equal(r.isError, true, JSON.stringify(patch));
      assert.ok(!JSON.stringify(r).includes('core.subError.refund'), 'refund errors must be translated in the Worker bundle');
      assert.deepEqual(await f.snapshot(), before);
    }
    for (const r of [
      { amount: 0, date: '2026-01-16', currency: 'USD' },
      { amount: 1, date: '2025-01-01', currency: 'USD' },
      { amount: 1, date: 'wrong', currency: 'USD' },
    ]) {
      const invalid = structuredClone(s);
      Object.assign(invalid.share!.members[0], { left: '2026-01-16', leaveRefund: r });
      assert.equal((await f.request('subscriptions/s', 'PUT', invalid)).status, 400);
      assert.equal((await f.request('backup', 'POST', { subscriptions: [invalid] })).status, 400);
    }
  } finally {
    f.db.close();
  }
});

test('助手下车退款必须确认，确认参数固定预览日期币种并保留实际金额', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s = sub();
  s.start = '2026-01-01';
  s.share!.members[0].joined = '2026-01-01';
  s.share!.members[0].left = '2026-10-01';
  await upsert(f.env, 'subscriptions', s.id, s);
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test', model: 'fictional' });
  const before = await f.snapshot();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const delta =
      calls++ === 0
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'refund-call',
                type: 'function',
                function: {
                  name: 'save_share_member',
                  arguments: JSON.stringify({ subscription: 's', member: 'member', leave_refund: { amount: 1.23 }, dry_run: false }),
                },
              },
            ],
          }
        : { content: 'Draft ready.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const stream = await chat(f.env, { text: 'Record the actual refund' }, new AbortController().signal).text();
  const proposal = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .find((e) => e.type === 'proposal');
  assert.ok(proposal, stream);
  assert.deepEqual(proposal.args.leave_refund, { amount: 1.23, date: '2026-10-01', currency: 'USD' });
  assert.deepEqual(await f.snapshot(), before);
  await apply(f.env, proposal);
  assert.deepEqual((await f.snapshot()).subscriptions[0].share!.members[0].leaveRefund, proposal.args.leave_refund);
});

test('record_payment：单笔支付方式可指定、改写时保留、null 清除，读工具按单笔方式汇总', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), start: '2026-01-05', share: undefined, proxy: undefined, payments: [{ date: '2026-01-05', amount: 10 }] };
  await upsert(f.env, 'subscriptions', 's', s);
  const pays = async () => (await f.snapshot()).subscriptions.find((x) => x.id === 's')!.payments!;
  // 指定这一笔用另一张卡
  let r = await f.call('record_payment', { subscription: 's', replace: { date: '2026-01-05', index: 0 }, date: '2026-01-05', amount: 10, method: 'target' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal((await pays())[0].methodId, 'target');
  // 只改金额：沿用这一笔原来的支付方式，不被悄悄丢掉
  r = await f.call('record_payment', { subscription: 's', replace: { date: '2026-01-05', index: 0 }, date: '2026-01-05', amount: 11 });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal((await pays())[0].amount, 11);
  assert.equal((await pays())[0].methodId, 'target');
  // 扣款明细的支付方式按单笔记录
  const list = JSON.stringify(
    await f.call('list_charges', { subscription: 's', period: 'custom', from: '2026-01-01', to: '2026-01-31', include_projected: false }),
  );
  assert.match(list, /Target wallet/);
  // null 清除，回到所属方案的支付方式
  r = await f.call('record_payment', { subscription: 's', replace: { date: '2026-01-05', index: 0 }, date: '2026-01-05', amount: 11, method: null });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal((await pays())[0].methodId, undefined);
});

// Same service names are not a business identity: these are two intentional accounts.
test('MCP account identity: search, contextual candidates, independent creation and unchanged read permissions', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const original = { ...sub(), id: 'personal', name: 'ChatGPT', account: 'personal@example.test', region: 'US', share: undefined, proxy: undefined };
  await upsert(f.env, 'subscriptions', original.id, original);
  const args = { name: 'ChatGPT', start: original.start, account: 'work@example.test', price: 20, currency: 'USD', cycle: { unit: 'month' }, category: 'Test' };
  const before = await f.snapshot();
  const preview = await f.call('create_subscription', { ...args, dry_run: true });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.after.account, args.account);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('create_subscription', args, f.read)).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  const saved = await f.call('create_subscription', args);
  assert.equal(saved.isError, undefined);
  const listed = await f.call('list_subscriptions', { query: 'work@example.test' }, f.read);
  assert.equal(listed.structuredContent.items.length, 1);
  assert.equal(listed.structuredContent.items[0].account, args.account);
  const ambiguity = await f.call('get_subscription', { subscription: 'ChatGPT' });
  assert.equal(ambiguity.isError, true);
  assert.match(ambiguity.content[0].text, /personal@example.test/);
  assert.match(ambiguity.content[0].text, /work@example.test/);
  assert.match(ambiguity.content[0].text, /Fictional wallet/);
  const duplicate = await f.call('create_subscription', { ...args, account: ' WORK@example.test ' });
  assert.equal(duplicate.isError, true);
  assert.equal((await f.snapshot()).subscriptions.filter((s) => s.name === 'ChatGPT').length, 2);
  const fromId = await f.call('update_subscription', { subscription: saved.structuredContent.after.id, set: { notes: 'Work account only' } });
  assert.equal(fromId.isError, undefined);
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 'personal')?.notes, original.notes);
});

test('MCP initialization and get_settings expose connection scope without credentials or extra tools', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const count = TOOLS.length;
  for (const [token, scope] of [
    [f.read, 'read'],
    [f.write, 'write'],
  ] as const) {
    const before = await f.snapshot();
    const initialized = await f.rpc('initialize', { protocolVersion: '2025-06-18' }, token);
    const context = JSON.parse(initialized.instructions.split('\n').at(-1));
    assert.equal(context.scope, scope);
    assert.equal(context.client, 'mcp');
    const settings = await f.call('get_settings', {}, token);
    assert.deepEqual(settings.structuredContent.connection, context);
    assert.ok(context.timezone && context.today && context.base_currency);
    const tools = await f.rpc('tools/list', {}, token);
    assert.deepEqual(
      context.tools.map((x) => x.name),
      tools.tools.map((x) => x.name),
    );
    if (scope === 'read') assert.ok(context.tools.every((x) => x.read_only));
    assert.equal(context.writes_require_confirmation, false);
    assert.ok(!JSON.stringify(settings).includes('SECRET'));
    assert.ok(!JSON.stringify(settings).includes(token));
    assert.deepEqual(await f.snapshot(), before);
  }
  assert.equal(TOOLS.length, count);
});

test('MCP 读取导入订阅：标出导入边界，累计支出只从边界算起并注明历史不完整', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), start: '2024-03-01', cycle: { unit: 'year', every: 1 }, estimateFrom: '2026-10-24', share: undefined, proxy: undefined };
  await upsert(f.env, 'subscriptions', 's', s);
  const r = await f.call('get_subscription', { subscription: 's' }, f.read);
  assert.ok(!r.isError, JSON.stringify(r));
  const text = JSON.stringify(r.structuredContent);
  assert.match(text, /"estimate_from":"2026-10-24"/);
  assert.match(text, /"history_complete":false/);
  assert.match(text, /"from":"2026-10-24"/);
});

test('save_subscription runs the same full-record pipeline as PUT: validation, renewal history and member exit cleanup', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const past = addDays(today, -60);
  const base: Subscription = { ...sub(), start: past, proxy: undefined, payments: [{ date: past, amount: 10 }] };
  await upsert(f.env, 'subscriptions', 's', base);
  // 同一份不合格记录：两条路径给出同一个错误，都不写入
  const bad = {
    ...base,
    payments: [
      {
        date: past,
        amount: 10,
        funding: [
          { methodId: 'wallet', amount: 6 },
          { methodId: 'target', amount: 3 },
        ],
      },
    ],
  };
  const before = await f.snapshot();
  const put = await f.request('subscriptions/s', 'PUT', bad);
  assert.equal(put.status, 400);
  const putError = (await put.json()).error;
  const mcp = await f.call('save_subscription', { subscription: bad });
  assert.equal(mcp.isError, true);
  assert.match(JSON.stringify(mcp), new RegExp(putError));
  assert.deepEqual(await f.snapshot(), before);
  // 续费规则修改：两条路径记下同样的生效日历史；成员退出日被清掉时退款一起清掉
  const left = { ...base.share!.members[0], left: addDays(today, -1), leaveRefund: { date: addDays(today, -1), amount: 1, currency: 'USD' } };
  await upsert(f.env, 'subscriptions', 's', { ...base, share: { ...base.share!, members: [left] } });
  const edit = { ...base, chargeLeadDays: 3, share: { ...base.share!, members: [{ ...left, left: undefined }] } };
  const viaPut = await (await f.request('subscriptions/s', 'PUT', edit)).json();
  await upsert(f.env, 'subscriptions', 's', { ...base, share: { ...base.share!, members: [left] } });
  const viaMcp = await f.call('save_subscription', { subscription: edit });
  assert.equal(viaMcp.isError, undefined, JSON.stringify(viaMcp));
  const saved = (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  assert.deepEqual(saved.renewalHistory, viaPut.renewalHistory);
  assert.equal(saved.share?.members[0].leaveRefund, undefined);
  assert.equal(viaPut.share.members[0].leaveRefund, undefined);
});

test('save_subscription: dry_run diff and computed preview, unknown stop date, explicit empty method, unknown method rejected', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, categories: [{ name: 'Test' }], defaultMethodId: 'wallet' });
  const today = todayIn('UTC');
  const p1 = addDays(today, -200);
  const p2 = addDays(today, -100);
  const record = {
    name: 'Fictional history',
    price: 9,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: p1,
    status: 'cancelled',
    category: 'Test',
    methodId: null,
    phases: [
      { start: p1, price: 5, currency: 'USD', cycle: { unit: 'year', every: 1 }, payments: [{ date: p1, amount: 5, methodId: 'target' }] },
      {
        start: p2,
        price: 9,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        methodId: 'target',
        payments: [
          {
            date: p2,
            amount: 9,
            funding: [
              { methodId: 'wallet', amount: 4 },
              { methodId: 'target', amount: 5 },
            ],
          },
        ],
      },
    ],
  };
  const before = await f.snapshot();
  const preview = await f.call('save_subscription', { subscription: record, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.deepEqual(await f.snapshot(), before);
  const pv = preview.structuredContent;
  assert.equal(pv.computed.before, null);
  assert.equal(pv.computed.after.status, 'ended');
  assert.equal(pv.computed.after.next_charge, null);
  assert.equal(pv.computed.after.spent_total.charges, 2);
  assert.equal(pv.computed.after.spent_total.amount, 14);
  assert.ok(pv.changes.some((c: { path: string }) => c.path === 'phases'));
  const saved = await f.call('save_subscription', { subscription: { ...record, id: pv.subscription.id } });
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  const stored = (await f.snapshot()).subscriptions.find((x) => x.id === pv.subscription.id)!;
  // 明确为空：不套默认支付方式；停用日期不详时不编造 end / stop
  // 与网页端 PUT 一样整条照存：顶层不自动改写
  assert.equal(stored.methodId, undefined);
  assert.equal(stored.phases![0].methodId, undefined);
  assert.equal(stored.end, undefined);
  assert.equal(stored.stop, undefined);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.phases![1].payments![0].funding?.length, 2);
  // 替换时的字段级差异
  const diff = await f.call('save_subscription', { subscription: { ...stored, notes: 'n' }, dry_run: true });
  assert.deepEqual(diff.structuredContent.changes, [{ path: 'notes', before: null, after: 'n' }]);
  assert.equal(diff.structuredContent.computed.before.spent_total.amount, 14);
  const unknown = await f.call('save_subscription', { subscription: { ...stored, methodId: 'missing' }, dry_run: true });
  assert.equal(unknown.isError, true);
});

test('set_status never assumes today for an existing subscription; at=null records an undated stop', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const past = addDays(today, -40);
  await upsert(f.env, 'subscriptions', 's', { ...sub(), start: past, share: undefined, proxy: undefined, payments: [{ date: past, amount: 10 }] });
  for (const args of [{ action: 'cancel' }, { action: 'cancel', immediate: true }, { action: 'terminate' }]) {
    const r = await f.call('set_status', { subscription: 's', ...args, dry_run: true });
    assert.equal(r.isError, true, JSON.stringify(r));
  }
  assert.equal((await f.call('set_status', { subscription: 's', action: 'terminate', at: null, reason: 'x' })).isError, true);
  const r = await f.call('set_status', { subscription: 's', action: 'cancel', at: null });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const s = (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  assert.equal(s.status, 'cancelled');
  assert.equal(s.end, undefined);
  assert.equal(s.stop, undefined);
  assert.equal(s.payments?.length, 1);
  const detail = await f.call('get_subscription', { subscription: 's' });
  assert.equal(detail.structuredContent.status, 'ended');
  assert.equal(detail.structuredContent.next_charge, null);
  // 今天才开始、还没付过钱的订阅仍可省略 at（就是今天）
  await upsert(f.env, 'subscriptions', 'n', { ...sub(), id: 'n', start: today, share: undefined, proxy: undefined });
  const fresh = await f.call('set_status', { subscription: 'n', action: 'cancel', dry_run: true });
  assert.equal(fresh.isError, undefined, JSON.stringify(fresh));
});

test('create_subscription: stopped statuses, method=null without default, per-payment method/kind/settled/funding', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, categories: [{ name: 'Test' }], defaultMethodId: 'wallet' });
  const today = todayIn('UTC');
  const d1 = addDays(today, -90);
  const d2 = addDays(today, -60);
  const r = await f.call('create_subscription', {
    name: 'Fictional stopped',
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: d1,
    category: 'Test',
    method: null,
    status: 'cancelled',
    payments: [
      { date: d1, amount: 10, method: 'target', settled: { amount: 11, currency: 'USD' } },
      {
        date: d2,
        amount: 10,
        funding: [
          { method: 'wallet', amount: 6 },
          { method: 'Target wallet', amount: 4 },
        ],
      },
      { date: d2, amount: 2, kind: 'refund' },
    ],
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const s = (await f.snapshot()).subscriptions.find((x) => x.name === 'Fictional stopped')!;
  assert.equal(s.methodId, undefined);
  assert.equal(s.status, 'cancelled');
  assert.equal(s.end, undefined);
  assert.equal(s.payments![0].methodId, 'target');
  assert.deepEqual(s.payments![0].settled, { amount: 11, currency: 'USD' });
  assert.deepEqual(s.payments![1].funding, [
    { methodId: 'wallet', amount: 6 },
    { methodId: 'target', amount: 4 },
  ]);
  assert.equal(s.payments![2].amount, -2);
  assert.equal(s.payments![2].kind, 'refund');
  // 省略 method 仍套默认
  const dflt = await f.call('create_subscription', {
    name: 'Fictional default',
    price: 1,
    currency: 'USD',
    cycle: { unit: 'month' },
    category: 'Test',
    dry_run: true,
  });
  assert.equal(dflt.structuredContent.after.methodId, 'wallet');
  const ended = await f.call('create_subscription', {
    name: 'Fictional ended',
    price: 1,
    currency: 'USD',
    cycle: { unit: 'month' },
    category: 'Test',
    start: d1,
    status: 'terminated',
    end: d2,
    dry_run: true,
  });
  assert.equal(ended.isError, undefined, JSON.stringify(ended));
  assert.equal(ended.structuredContent.subscription.status, 'terminated');
});

test('record_payment funding: split saved, reduces each wallet balance, rejects mismatched totals and method+funding', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  await upsert(f.env, 'subscriptions', 's', { ...sub(), share: undefined, proxy: undefined, methodId: 'target' });
  await upsert(f.env, 'methods', 'wallet', {
    id: 'wallet',
    name: 'Fictional wallet',
    kind: 'prepaid',
    currency: 'USD',
    balance: 100,
    balanceAsOf: addDays(today, -1),
  });
  const mismatch = await f.call('record_payment', {
    subscription: 's',
    amount: 10,
    funding: [
      { method: 'wallet', amount: 3 },
      { method: 'target', amount: 3 },
    ],
  });
  assert.equal(mismatch.isError, true);
  const both = await f.call('record_payment', {
    subscription: 's',
    amount: 10,
    method: 'wallet',
    funding: [
      { method: 'wallet', amount: 5 },
      { method: 'target', amount: 5 },
    ],
  });
  assert.equal(both.isError, true);
  const ok = await f.call('record_payment', {
    subscription: 's',
    date: today,
    amount: 10,
    replace: { date: today, index: 0 },
    funding: [
      { method: 'wallet', amount: 4 },
      { method: 'target', amount: 6 },
    ],
  });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  const st = await f.snapshot();
  assert.equal(st.subscriptions[0].payments![0].funding?.length, 2);
  // 钱包按拆分里自己的那一份扣：100 − 4
  assert.equal(
    runwayFor(
      st.methods.find((m) => m.id === 'wallet')!,
      st,
      today,
    )?.current,
    96,
  );
  const charges = JSON.stringify(await f.call('list_charges', { subscription: 's', period: 'today', include_projected: false }));
  assert.match(charges, /"funding"/);
});

test('record_transfer：dry_run 不写入、读令牌拒绝、记录/改写/删除，get_subscription 给出转让与净成本', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), start: '2026-01-05', share: undefined, proxy: undefined, payments: [{ date: '2026-01-05', amount: 10 }] };
  await upsert(f.env, 'subscriptions', 's', s);
  const transfers = async () => (await f.snapshot()).subscriptions.find((x) => x.id === 's')!.transfers;
  const args = { subscription: 's', kind: 'buy', date: '2026-01-05', amount: 100, currency: 'USD', note: 'Fictional premium' };
  const before = await f.snapshot();
  const preview = await f.call('record_transfer', { ...args, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.dry_run, true);
  assert.deepEqual(preview.structuredContent.after.transfers, [{ kind: 'buy', date: '2026-01-05', amount: 100, currency: 'USD', note: 'Fictional premium' }]);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('record_transfer', args, f.read)).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('record_transfer', { ...args, amount: 0 })).isError, true);
  assert.equal((await f.call('record_transfer', { ...args, kind: 'gift' })).isError, true);
  assert.equal((await f.call('record_transfer', args)).isError, undefined);
  let r = await f.call('record_transfer', { subscription: 's', kind: 'sell', date: '2026-02-01', amount: 30 });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal((await transfers())?.length, 2);
  // 改写：按日期与同日序号定位，缺省币种取订阅币种
  r = await f.call('record_transfer', { subscription: 's', replace: { date: '2026-02-01', index: 0 }, kind: 'sell', date: '2026-02-01', amount: 40 });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual((await transfers())?.[1], { kind: 'sell', date: '2026-02-01', amount: 40, currency: 'USD' });
  const detail = (await f.call('get_subscription', { subscription: 's' }, f.read)).structuredContent;
  assert.equal(detail.transfers.length, 2);
  assert.equal(detail.net_cost.bought, 100);
  assert.equal(detail.net_cost.sold, 40);
  assert.equal(detail.net_cost.net, Math.round((detail.net_cost.service + 100 - 40) * 100) / 100);
  assert.equal(detail.net_cost.holding_until, '2026-02-01');
  assert.equal((await f.call('record_transfer', { subscription: 's', delete: { date: '2026-03-01', index: 0 } })).isError, true);
  r = await f.call('record_transfer', { subscription: 's', delete: { date: '2026-01-05', index: 0 }, dry_run: true });
  assert.equal((await transfers())?.length, 2);
  r = await f.call('record_transfer', { subscription: 's', delete: { date: '2026-01-05', index: 0 } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(
    (await transfers())?.map((x) => x.kind),
    ['sell'],
  );
  // 代付是别人的订阅：不能记转让
  await upsert(f.env, 'subscriptions', 'p', { ...sub(), id: 'p', share: undefined });
  assert.equal((await f.call('record_transfer', { ...args, subscription: 'p' })).isError, true);
});

test('PUT /api/subscriptions 校验转让并原样保存；备份导出带上转让', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), share: undefined, proxy: undefined };
  const bad = await f.request('subscriptions/s', 'PUT', { ...s, transfers: [{ kind: 'buy', date: s.start, amount: -1, currency: 'USD' }] });
  assert.equal(bad.status, 400);
  const transfers = [{ kind: 'sell' as const, date: s.start, amount: 25, currency: 'EUR', note: 'Fictional buyer' }];
  const ok = await f.request('subscriptions/s', 'PUT', { ...s, transfers });
  assert.equal(ok.status, 200);
  assert.deepEqual((await f.snapshot()).subscriptions.find((x) => x.id === 's')?.transfers, transfers);
  const backup = await (await f.request('backup')).json();
  assert.deepEqual(backup.subscriptions.find((x: Subscription) => x.id === 's').transfers, transfers);
});

test('set_meters / add_readings：dry_run 不写入、读令牌拒绝、增改删与合并，get_subscription 给出用量与单价', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  // 每月 1 日扣 10 USD，从 2026-01-01 起
  const s: Subscription = { ...sub(), start: '2026-01-01', share: undefined, proxy: undefined };
  await upsert(f.env, 'subscriptions', 's', s);
  const stored = async () => (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  const before = await f.snapshot();
  const args = {
    subscription: 's',
    meters: [
      { name: 'Traffic', unit: 'GB' },
      { name: 'Counter', unit: 'kWh', kind: 'reading' },
    ],
  };
  // 没有指标时不能记读数
  assert.equal((await f.call('add_readings', { subscription: 's', readings: [{ date: '2026-01-15', values: { Traffic: 1 } }] })).isError, true);
  const preview = await f.call('set_meters', { ...args, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.dry_run, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('set_meters', args, f.read)).isError, true);
  assert.equal((await f.call('set_meters', { subscription: 's' })).isError, true);
  assert.equal((await f.call('set_meters', { subscription: 's', meters: [{ unit: 'GB' }] })).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  let r = await f.call('set_meters', args);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const meters = (await stored()).meters!;
  assert.deepEqual(
    meters.map((m) => [m.name, m.unit, m.kind]),
    [
      ['Traffic', 'GB', undefined],
      ['Counter', 'kWh', 'reading'],
    ],
  );
  // 预览给出的 id 与确认写入一致
  assert.deepEqual(
    preview.structuredContent.after.meters.map((m: { id: string }) => m.id),
    meters.map((m) => m.id),
  );
  const [gb, kwh] = meters.map((m) => m.id);
  // 按名称改单位，不新增
  r = await f.call('set_meters', { subscription: 's', meters: [{ name: 'TRAFFIC', unit: 'TB' }] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal((await stored()).meters?.length, 2);
  assert.deepEqual((await stored()).meters?.[0], { id: gb, name: 'TRAFFIC', unit: 'TB' });

  const readings = [
    { date: '2026-01-15', values: { Traffic: 3, [kwh]: 100 } },
    { date: '2026-02-15', values: { Traffic: 5, Counter: 140 }, note: 'Fictional note' },
  ];
  const before2 = await f.snapshot();
  assert.equal((await f.call('add_readings', { subscription: 's', readings, dry_run: true })).structuredContent.dry_run, true);
  assert.equal((await f.call('add_readings', { subscription: 's', readings }, f.read)).isError, true);
  assert.equal((await f.call('add_readings', { subscription: 's', readings: [{ date: '2026-01-15', values: { Nope: 1 } }] })).isError, true);
  assert.equal((await f.call('add_readings', { subscription: 's', readings: [{ date: '2026-01-15', values: { Traffic: '3' } }] })).isError, true);
  assert.deepEqual(await f.snapshot(), before2);
  r = await f.call('add_readings', { subscription: 's', readings });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(
    (await stored()).readings?.map((x) => [x.date, x.values, x.note]),
    [
      ['2026-01-15', { [gb]: 3, [kwh]: 100 }, undefined],
      ['2026-02-15', { [gb]: 5, [kwh]: 140 }, 'Fictional note'],
    ],
  );
  // 同一天合并：null 删掉一个数值，其他保留
  r = await f.call('add_readings', { subscription: 's', readings: [{ date: '2026-02-15', values: { Traffic: null, Counter: 150 } }] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const feb = (await stored()).readings!.find((x) => x.date === '2026-02-15')!;
  assert.deepEqual(feb.values, { [kwh]: 150 });
  assert.equal(feb.note, 'Fictional note');

  const detail = (await f.call('get_subscription', { subscription: 's' }, f.read)).structuredContent;
  const counter = detail.meters.find((m: { name: string }) => m.name === 'Counter');
  assert.equal(counter.kind, 'reading');
  assert.equal(counter.total_usage, 50);
  assert.equal(counter.readings.length, 2);
  assert.equal(counter.readings[1].usage, 50);
  assert.equal(counter.readings[1].cost, 10);
  assert.equal(counter.readings[1].unit_price, 0.2);
  assert.deepEqual(counter.latest_unit_price, { date: '2026-02-15', amount: 0.2, currency: 'USD' });
  const traffic = detail.meters.find((m: { id: string }) => m.id === gb);
  assert.equal(traffic.total_usage, 3);

  // 删除读数：dry_run 不动，确认后删掉
  assert.equal((await f.call('add_readings', { subscription: 's', delete: ['missing'] })).isError, true);
  await f.call('add_readings', { subscription: 's', delete: [feb.id], dry_run: true });
  assert.equal((await stored()).readings?.length, 2);
  r = await f.call('add_readings', { subscription: 's', delete: [feb.id] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal((await stored()).readings?.length, 1);

  // 删除指标：历史数值一起清掉，空记录删除
  r = await f.call('set_meters', { subscription: 's', remove: [gb, kwh] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal((await stored()).meters, undefined);
  assert.equal((await stored()).readings, undefined);
});

test('PUT /api/subscriptions 校验业务数据并原样保存，备份带上读数', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), share: undefined, proxy: undefined };
  const meters = [{ id: 'gb', name: 'Traffic', unit: 'GB' }];
  const bad = await f.request('subscriptions/s', 'PUT', { ...s, meters, readings: [{ id: 'r', date: s.start, values: { other: 1 } }] });
  assert.equal(bad.status, 400);
  const readings = [{ id: 'r', date: s.start, values: { gb: 2.5 }, note: 'Fictional reading' }];
  const ok = await f.request('subscriptions/s', 'PUT', { ...s, meters, readings });
  assert.equal(ok.status, 200);
  const saved = (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  assert.deepEqual(saved.meters, meters);
  assert.deepEqual(saved.readings, readings);
  const backup = await (await f.request('backup')).json();
  assert.deepEqual(backup.subscriptions.find((x: Subscription) => x.id === 's').readings, readings);
});

test('MCP 改开始日与网页 movePhaseStart 一致：默认保留扣款锚点，shift_billing 才平移', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const s: Subscription = { ...sub(), start: '2026-01-15', share: undefined, proxy: undefined };
  await upsert(f.env, 'subscriptions', 's', s);
  const days = (r: { structuredContent: { next_charges: Array<{ date: string }> } }) => r.structuredContent.next_charges.map((c) => c.date.slice(8));
  const before = await f.snapshot();
  for (const [tool, args] of [
    ['update_subscription', { subscription: 's', set: { start: '2026-01-10' } }],
    ['change_plan', { subscription: 's', action: 'edit', at: '2026-01-15', set: { start: '2026-01-10' } }],
  ] as const) {
    const kept = await f.call(tool, { ...args, dry_run: true });
    assert.equal(kept.isError, undefined, JSON.stringify(kept));
    assert.deepEqual(new Set(days(kept)), new Set(['15']), tool);
    assert.equal(kept.structuredContent.after.start, '2026-01-10');
    const shifted = await f.call(tool, { ...args, shift_billing: true, dry_run: true });
    assert.equal(shifted.isError, undefined, JSON.stringify(shifted));
    assert.deepEqual(new Set(days(shifted)), new Set(['10']), tool);
  }
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('update_subscription', { subscription: 's', set: { notes: 'x' }, shift_billing: true, dry_run: true })).isError, true);
  const saved = await f.call('update_subscription', { subscription: 's', set: { start: '2026-01-10' } });
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  const stored = (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  assert.equal(stored.start, '2026-01-10');
  assert.equal(stored.billingStart, '2026-01-15');
  assert.equal((await f.call('get_subscription', { subscription: 's' })).structuredContent.next_charge.slice(8), '15');
});

test('set_status edit=true 修改已有停用：日期、不续费/立即停用、原因、退款，被服务商停用不能改成取消', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const past = addDays(today, -40);
  const stopAt = addDays(past, 20);
  await upsert(f.env, 'subscriptions', 's', { ...sub(), start: past, share: undefined, proxy: undefined, payments: [{ date: past, amount: 10 }] });
  const stored = async () => (await f.snapshot()).subscriptions.find((x) => x.id === 's')!;
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: stopAt, edit: true })).isError, true, 'not stopped yet');
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: stopAt, refund: { amount: 2 } })).isError, undefined);
  // 未带 edit 仍然拒绝重复停用
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: addDays(stopAt, 1) })).isError, true);
  const before = await f.snapshot();
  const moved = addDays(stopAt, 2);
  const preview = await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: moved, edit: true, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.after.stop.date, moved);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: moved, edit: true }, f.read)).isError, true);
  assert.deepEqual(await f.snapshot(), before);
  // 只改日期：退款保留
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, at: moved, edit: true })).isError, undefined);
  let s = await stored();
  assert.equal(s.stop?.date, moved);
  assert.deepEqual(
    s.payments?.filter((p) => p.kind === 'refund').map((p) => p.amount),
    [-2],
  );
  // 改退款金额，再清除
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, edit: true, refund: { amount: 3 } })).isError, undefined);
  s = await stored();
  assert.equal(s.stop?.date, moved);
  assert.deepEqual(
    s.payments?.filter((p) => p.kind === 'refund').map((p) => p.amount),
    [-3],
  );
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, edit: true, refund: null })).isError, undefined);
  assert.equal(
    (await stored()).payments?.some((p) => p.kind === 'refund'),
    false,
  );
  // 立即停用 → 到期不续
  const r = await f.call('set_status', { subscription: 's', action: 'cancel', edit: true });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  s = await stored();
  assert.equal(s.stop, undefined);
  assert.equal(s.status, 'cancelled');
  assert.equal(s.end, moved);
  // 改为被服务商停用并写原因，之后可改原因，但不能改成取消
  assert.equal((await f.call('set_status', { subscription: 's', action: 'terminate', at: moved, reason: 'Fictional policy', edit: true })).isError, undefined);
  assert.equal((await stored()).stop?.kind, 'terminate');
  assert.equal((await f.call('set_status', { subscription: 's', action: 'terminate', reason: 'Revised policy', edit: true })).isError, undefined);
  assert.equal((await stored()).stop?.reason, 'Revised policy');
  const blocked = await f.snapshot();
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', immediate: true, edit: true })).isError, true);
  assert.equal((await f.call('set_status', { subscription: 's', action: 'cancel', edit: true })).isError, true);
  assert.equal((await f.call('set_status', { subscription: 's', action: 'pause', edit: true })).isError, true);
  assert.deepEqual(await f.snapshot(), blocked);
  // 日期不详的停用：必须补上日期
  await upsert(f.env, 'subscriptions', 'u', { ...sub(), id: 'u', start: past, share: undefined, proxy: undefined, payments: [{ date: past, amount: 10 }] });
  assert.equal((await f.call('set_status', { subscription: 'u', action: 'cancel', at: null })).isError, undefined);
  assert.equal((await f.call('set_status', { subscription: 'u', action: 'cancel', immediate: true, edit: true })).isError, true);
  assert.equal((await f.call('set_status', { subscription: 'u', action: 'cancel', at: null, edit: true })).isError, true);
  const dated = await f.call('set_status', { subscription: 'u', action: 'cancel', immediate: true, at: stopAt, edit: true });
  assert.equal(dated.isError, undefined, JSON.stringify(dated));
  assert.equal((await f.snapshot()).subscriptions.find((x) => x.id === 'u')?.stop?.date, stopAt);
});

test('create_subscription 与 update_subscription 图标同一套校验：emoji、网址、站内路径都保存，非法值报错不静默丢弃', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const base = { price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: todayIn('UTC'), category: 'Test', method: null };
  for (const [i, icon] of ['🎬', '👨‍👩‍👧', 'http://example.test/a.png', 'https://example.test/a.png', '/ai/claude.svg'].entries()) {
    const r = await f.call('create_subscription', { ...base, name: `Fictional icon ${i}`, icon });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal((await f.snapshot()).subscriptions.find((s) => s.name === `Fictional icon ${i}`)?.icon, icon);
  }
  const before = await f.snapshot();
  for (const icon of ['javascript:alert(1)', 'ftp://example.test/a.png', 'not an icon at all', '//evil.test/a.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const created = await f.call('create_subscription', { ...base, name: 'Fictional bad icon', icon });
    assert.equal(created.isError, true, icon);
    const updated = await f.call('update_subscription', { subscription: 's', set: { icon } });
    assert.equal(updated.isError, true, icon);
  }
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('update_subscription', { subscription: 's', set: { icon: '🌱' } })).isError, undefined);
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 's')?.icon, '🌱');
  assert.equal((await f.call('update_subscription', { subscription: 's', set: { icon: null } })).isError, undefined);
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 's')?.icon, undefined);
});

test('save_share_member / set_proxy 给新名字建档或复用同名人：预览说明将新建谁，确认后同一个 id，person=null 不关联', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  const preview = await f.call('save_share_member', { subscription: 's', name: 'Fictional newcomer', fee: 3, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.created_person.name, 'Fictional newcomer');
  assert.match(preview.structuredContent.person_notice, /Fictional newcomer/);
  assert.deepEqual(await f.snapshot(), before);
  const saved = await f.call('save_share_member', { subscription: 's', name: 'Fictional newcomer', fee: 3, id: preview.structuredContent.member.id });
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  let st = await f.snapshot();
  const person = st.people?.find((p) => p.name === 'Fictional newcomer');
  assert.equal(person?.id, preview.structuredContent.created_person.id);
  assert.equal(st.subscriptions[0].share?.members.find((m) => m.name === 'Fictional newcomer')?.personId, person?.id);
  // 同名（不分大小写）的人只有一个：直接关联，不重复建档
  const same = await f.call('save_share_member', { subscription: 's', name: 'target PERSON', fee: 3 });
  assert.equal(same.isError, undefined, JSON.stringify(same));
  assert.equal(same.structuredContent.created_person, undefined);
  st = await f.snapshot();
  assert.equal(st.subscriptions[0].share?.members.find((m) => m.name === 'target PERSON')?.personId, 'target');
  assert.equal(st.people?.length, 3);
  // 代付：新名字建档，同名关联，person=null 保持不关联
  await upsert(f.env, 'subscriptions', 'p', { ...sub(), id: 'p', share: undefined, proxy: undefined });
  const proxyPreview = await f.call('set_proxy', { subscription: 'p', for_name: 'Fictional recipient', dry_run: true });
  assert.equal(proxyPreview.structuredContent.created_person.name, 'Fictional recipient');
  assert.equal(proxyPreview.structuredContent.after.personId, proxyPreview.structuredContent.created_person.id);
  assert.equal((await f.call('set_proxy', { subscription: 'p', for_name: 'Target person' })).isError, undefined);
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 'p')?.proxy?.personId, 'target');
  assert.equal((await f.call('set_proxy', { subscription: 'p', for_name: 'Unlinked recipient', person: null })).isError, undefined);
  st = await f.snapshot();
  assert.equal(st.subscriptions.find((s) => s.id === 'p')?.proxy?.personId, undefined);
  assert.equal(st.people?.length, 3);
});

test('full-record MCP schema explains and saves gift, early renewal and stopped service without losing payment ownership', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const sample = structuredClone((SUBSCRIPTION_SCHEMA.examples as Array<Record<string, unknown>>)[0]);
  sample.id = 'gift-history';
  sample.category = 'Test';
  validateToolInput(SUBSCRIPTION_SCHEMA, sample);
  const before = await f.snapshot();
  const preview = await f.call('save_subscription', { subscription: sample, dry_run: true });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.deepEqual(await f.snapshot(), before);
  const r = await apply(f.env, { tool: 'save_subscription', args: { subscription: sample } });
  assert.equal(r.verification.status, 'verified');
  const saved = (await f.snapshot()).subscriptions.find((s) => s.id === 'gift-history')!;
  assert.equal(saved.phases?.[1].start, '2026-02-19');
  assert.equal(saved.phases?.[1].payments?.[0].date, '2026-02-06');
  assert.equal(saved.phases?.[1].nextDue, '2027-02-19');
  assert.equal(saved.end, '2026-07-17');
  assert.equal(saved.payments, undefined);
  const bad = { ...sample, stop: { date: '2026-07-17', immediate: true } };
  assert.throws(() => validateToolInput(SUBSCRIPTION_SCHEMA, bad, 'arguments.subscription'), /subscription.stop.kind/);
  const wrongDate = structuredClone(sample) as unknown as Subscription;
  wrongDate.phases![1].payments![0].date = 'not-a-date';
  assert.throws(() => validateToolInput(SUBSCRIPTION_SCHEMA, wrongDate, 'arguments.subscription'), /subscription.phases\[1\].payments\[0\].date/);
});

const modelReply = (delta: object) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
const eventsOf = (stream: string) =>
  stream
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
const functionCall = (id: string, name: string, args: object) => ({
  tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('assistant done reports unresolved failures even when the model claims full completion', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
  const before = await f.snapshot();
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    modelReply(
      n++ === 0
        ? functionCall('bad', 'update_subscription', { subscription: 's', set: { start: 'bad-date' } })
        : { content: 'Everything was saved successfully.' },
    ),
  );
  const es = eventsOf(await chat(f.env, { text: 'Fix date' }, new AbortController().signal).text());
  const done = es.find((e) => e.type === 'done');
  assert.equal(done.outcome.status, 'partial');
  assert.equal(done.outcome.failures.length, 1);
  assert.equal(done.outcome.drafts, 0);
  assert.match(done.messages.at(-1).content, /not.*fully completed/);
  assert.deepEqual(await f.snapshot(), before);
});

test('reordered JSON keys do not repeat a person deletion against the draft overlay', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
  await putKv(f.env, 'people', [
    { id: 'old', name: 'Old' },
    { id: 'new', name: 'New' },
  ]);
  const before = await f.snapshot();
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    modelReply(
      [
        functionCall('delete', 'save_person', { action: 'delete', person: 'Old', migrate_to: 'New' }),
        functionCall('repeat', 'save_person', { action: 'delete', migrate_to: 'New', person: 'Old' }),
        { content: 'One draft ready for confirmation.' },
      ][n++],
    ),
  );
  const es = eventsOf(await chat(f.env, { text: 'Merge Old into New' }, new AbortController().signal).text());
  assert.equal(es.filter((e) => e.type === 'proposal').length, 1);
  assert.equal(
    es.some((e) => e.type === 'tool' && e.status === 'error'),
    false,
  );
  assert.equal(es.find((e) => e.type === 'done').outcome.status, 'complete');
  assert.deepEqual(await f.snapshot(), before);
});

test('failed drafts can retry after their missing dependency is drafted, and only successful operations count', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
  const before = await f.snapshot();
  let n = 0;
  const target = { subscription: 's', set: { method: 'new-wallet' } };
  t.mock.method(globalThis, 'fetch', async () =>
    modelReply(
      [
        functionCall('first', 'update_subscription', target),
        functionCall('wallet', 'update_payment_method', {
          action: 'create',
          id: 'new-wallet',
          set: { name: 'Fictional new wallet', kind: 'credit', currency: 'USD' },
        }),
        functionCall('retry', 'update_subscription', target),
        { content: 'Two drafts ready for confirmation.' },
      ][n++],
    ),
  );
  const es = eventsOf(await chat(f.env, { text: 'Change wallet' }, new AbortController().signal).text());
  assert.equal(es.find((e) => e.type === 'done').outcome.status, 'complete');
  const proposals = es.filter((e) => e.type === 'proposal');
  assert.equal(proposals.length, 2);
  assert.deepEqual(await f.snapshot(), before);
  for (const p of proposals) assert.equal((await apply(f.env, p)).verification.status, 'verified');
  assert.equal((await f.snapshot()).subscriptions.find((s) => s.id === 's')?.methodId, 'new-wallet');
});

for (const summaryFails of [false, true])
  test(`assistant budget ends with a limit outcome and a tool-free closing attempt (provider closing failure=${summaryFails})`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
    const before = await f.snapshot();
    let n = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      n++;
      if (request.tools) return modelReply(functionCall('read-' + n, 'get_settings', {}));
      return summaryFails ? new Response('{}', { status: 503 }) : modelReply({ content: 'The tool limit was reached; no changes were saved.' });
    });
    const es = eventsOf(await chat(f.env, { text: 'Read settings' }, new AbortController().signal).text());
    assert.equal(n, 13);
    assert.equal(es.find((e) => e.type === 'done').outcome.status, 'limit');
    assert.equal(
      es.some((e) => e.type === 'error'),
      false,
    );
    assert.deepEqual(await f.snapshot(), before);
  });

test('confirmation reports a committed but unverified write when read-back is unavailable', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const driver = f.env.DB as unknown as { prepare(sql: string): { run: () => Promise<unknown> } };
  const prepare = driver.prepare.bind(driver);
  let committed = false;
  t.mock.method(driver, 'prepare', (sql: string) => {
    if (committed && /^SELECT/i.test(sql)) throw new Error('Fictional read-back unavailable');
    const stmt = prepare(sql);
    if (/^INSERT INTO subscriptions\b/i.test(sql)) {
      const run = stmt.run.bind(stmt);
      stmt.run = async () => {
        const out = await run();
        committed = true;
        return out;
      };
    }
    return stmt;
  });
  const response = await f.request('assistant/apply', 'POST', { tool: 'update_subscription', args: { subscription: 's', set: { notes: 'Committed once' } } });
  assert.equal(response.status, 200);
  const r = await response.json();
  assert.equal(committed, true);
  assert.equal(r.verification.status, 'unverified');
  const row = f.db.prepare("SELECT data FROM subscriptions WHERE id='s'").get() as { data: string };
  assert.equal(JSON.parse(row.data).notes, 'Committed once');
});

for (const [name, args] of mutations)
  test(`assistant confirmation read-back: ${name} ${JSON.stringify(args)}`, async (t) => {
    const f = await setup();
    t.after(() => f.db.close());
    const result = await apply(f.env, { tool: name, args: structuredClone(args) });
    assert.equal(result.verification.status, 'verified', JSON.stringify(result.verification));
  });

test('startup route accepts real navigation paths, rejects labels, and preserves unchanged legacy values', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const before = await f.snapshot();
  const bad = await f.call('update_settings', { set: { startPage: 'subscriptions' } });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad), /startPage/);
  const web = await f.request('settings', 'PUT', { startPage: 'subscriptions' });
  assert.equal(web.status, 400);
  assert.deepEqual(await f.snapshot(), before);
  const saved = await apply(f.env, { tool: 'update_settings', args: { set: { startPage: 'list' } } });
  assert.equal(saved.verification.status, 'verified');
  assert.equal((await f.snapshot()).settings.startPage, 'list');
  await putKv(f.env, 'settings', { ...(await f.snapshot()).settings, startPage: 'legacy-unknown' });
  const unchanged = await f.call('update_settings', { set: { remindDays: 8 } });
  assert.equal(unchanged.isError, undefined, JSON.stringify(unchanged));
  assert.equal((await f.snapshot()).settings.startPage, 'legacy-unknown');
});

test('assistant clears malformed-argument failure after the same tool successfully retries', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  await putKv(f.env, 'assistant', { apiKey: 'fictional', baseUrl: 'https://fictional.example.test' });
  const before = await f.snapshot();
  let n = 0;
  const bad = functionCall('bad-json', 'update_settings', {});
  bad.tool_calls[0].function.arguments = '{broken JSON';
  t.mock.method(globalThis, 'fetch', async () =>
    modelReply([bad, functionCall('fixed-json', 'update_settings', { set: { remindDays: 6 } }), { content: 'Draft ready.' }][n++]),
  );
  const es = eventsOf(await chat(f.env, { text: 'Set reminders' }, new AbortController().signal).text());
  assert.equal(es.filter((e) => e.type === 'proposal').length, 1);
  assert.deepEqual(es.find((e) => e.type === 'done').outcome, { status: 'complete', drafts: 1, failures: [] });
  assert.deepEqual(await f.snapshot(), before);
});

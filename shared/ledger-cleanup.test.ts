// 网页删除的引用清理、悬空引用自愈、网页与 MCP 写入校验一致。全部用内存 SQLite 与虚构数据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { getKv, loadState, putKv, upsert } from '../worker/store.ts';
import type { Env } from '../worker/env.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { addDays, FALLBACK_FX, todayIn } from './billing.ts';
import { checkSettings, deleteMethodData, pruneSettingsRefs, settingsEdit, subRefsError } from './ledger-edit.ts';
import { DEFAULT_SETTINGS, type AppState, type Settings, type Subscription } from './types.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
// 纯函数直接调用时没有请求作用域，用全局语言
const { applyLocale } = await import('../worker/i18n.ts');
applyLocale('en');
hook.deregister();

function memoryEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
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
  return { db, env };
}

const today = todayIn('UTC');
const record = (o: Partial<Subscription> = {}): Subscription => ({
  id: 's',
  name: 'Fictional notes app',
  category: 'Test',
  tags: [],
  price: 10,
  currency: 'USD',
  start: addDays(today, -60),
  cycle: { unit: 'month', every: 1 },
  status: 'active',
  methodId: 'wallet',
  ...o,
});
// 订阅、阶段、单笔扣款、拆分来源都指向 wallet；另一条订阅不引用
const referenced = (): Subscription =>
  record({
    phases: [
      {
        start: addDays(today, -60),
        price: 10,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        methodId: 'wallet',
        payments: [
          { date: addDays(today, -60), amount: 10, methodId: 'wallet' },
          {
            date: addDays(today, -30),
            amount: 10,
            funding: [
              { methodId: 'wallet', amount: 4 },
              { methodId: 'other', amount: 6 },
            ],
          },
        ],
      },
    ],
  });

async function setup(settings: Partial<Settings> = {}) {
  const f = memoryEnv();
  await putKv(f.env, 'settings', { ...DEFAULT_SETTINGS, categories: [{ name: 'Test' }], ...settings });
  for (const [id, name] of [
    ['wallet', 'Fictional wallet'],
    ['other', 'Fictional other card'],
    ['target', 'Fictional target card'],
  ])
    await upsert(f.env, 'methods', id, { id, name, kind: 'credit', currency: 'USD' });
  await upsert(f.env, 'subscriptions', 's', referenced());
  await upsert(f.env, 'subscriptions', 'plain', record({ id: 'plain', name: 'Fictional plain plan', methodId: undefined }));
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const res = await worker.fetch(
      new Request(`https://example.test/ledger/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      f.env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const token = (await createToken(f.env, 'Fictional writer', 'write')).token;
  const call = async (name: string, args: object) => {
    const res = await worker.fetch(
      new Request('https://example.test/ledger/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      f.env,
    );
    return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
  };
  // 读库里的原始设置，不经 loadState 的内存剔除
  const rawSettings = async () => (await getKv<Settings>(f.env, 'settings'))!;
  const rawSub = async (id: string) =>
    JSON.parse((f.db.prepare('SELECT data FROM subscriptions WHERE id = ?').get(id) as { data: string }).data) as Subscription;
  return { ...f, request, call, rawSettings, rawSub };
}

test('网页删订阅同时清掉公开页隐藏 id，之后 MCP update_settings 仍可用', async (t) => {
  const f = await setup({ publicHidden: ['s', 'plain'] });
  t.after(() => f.db.close());
  assert.equal((await f.request('subscriptions/s', 'DELETE')).status, 200);
  assert.deepEqual((await f.rawSettings()).publicHidden, ['plain']);
  const r = await f.call('update_settings', { set: { signedAmounts: false } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal((await f.rawSettings()).signedAmounts, false);
});

test('已有悬空 publicHidden / defaultMethodId 时 update_settings 仍能改别的字段，并顺手写回干净的值', async (t) => {
  const f = await setup({ publicHidden: ['ghost', 'plain'], defaultMethodId: 'gone' });
  t.after(() => f.db.close());
  const r = await f.call('update_settings', { set: { remindDays: 5 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const saved = await f.rawSettings();
  assert.equal(saved.remindDays, 5);
  assert.deepEqual(saved.publicHidden, ['plain']);
  assert.equal(saved.defaultMethodId, undefined);
  // 本次新加的非法值仍然拒绝
  assert.equal((await f.call('update_settings', { set: { publicHidden: ['plain', 'nope'] } })).isError, true);
  assert.equal((await f.call('update_settings', { set: { defaultMethodId: 'nope' } })).isError, true);
});

test('读取时剔除悬空默认支付方式：create_subscription 不再套用已删除的卡', async (t) => {
  const f = await setup({ defaultMethodId: 'gone' });
  t.after(() => f.db.close());
  const r = await f.call('create_subscription', {
    name: 'Fictional new tool',
    price: 3,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: today,
    category: 'Test',
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const created = (await loadState(f.env, false)).subscriptions.find((s) => s.name === 'Fictional new tool')!;
  assert.equal(created.methodId, undefined);
  assert.equal((await loadState(f.env, false)).settings.defaultMethodId, undefined);
  // 只在内存里剔除，读取不改库
  assert.equal((await f.rawSettings()).defaultMethodId, 'gone');
});

test('网页删卡：有引用时必须选迁移或清空；迁移覆盖订阅、阶段、单笔、拆分来源与默认支付方式', async (t) => {
  const f = await setup({ defaultMethodId: 'wallet' });
  t.after(() => f.db.close());
  const refused = await f.request('methods/wallet', 'DELETE');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'in_use');
  assert.equal((await f.request('methods/wallet?into=wallet', 'DELETE')).status, 400);
  assert.equal((await f.request('methods/wallet?into=missing', 'DELETE')).status, 400);
  assert.ok(f.db.prepare("SELECT 1 FROM methods WHERE id = 'wallet'").get());

  const moved = await f.request('methods/wallet?into=target', 'DELETE');
  assert.equal(moved.status, 200);
  assert.equal(f.db.prepare("SELECT 1 FROM methods WHERE id = 'wallet'").get(), undefined);
  const s = await f.rawSub('s');
  assert.equal(s.methodId, 'target');
  assert.equal(s.phases![0].methodId, 'target');
  assert.equal(s.phases![0].payments![0].methodId, 'target');
  assert.deepEqual(s.phases![0].payments![1].funding, [
    { methodId: 'target', amount: 4 },
    { methodId: 'other', amount: 6 },
  ]);
  assert.equal((await f.rawSettings()).defaultMethodId, 'target');
  assert.ok(!JSON.stringify(s).includes('"wallet"'));
  // 之后 MCP 的设置与整条保存都不受影响
  assert.equal((await f.call('update_settings', { set: { remindDays: 2 } })).isError, undefined);
  const detail = await f.call('get_subscription', { subscription: 's' });
  const saved = await f.call('save_subscription', { subscription: detail.structuredContent.record });
  assert.equal(saved.isError, undefined, saved.content[0].text);
});

test('网页删卡选择清空：所有层级引用去掉，含它的拆分付款不再拆分，其余订阅不动', async (t) => {
  const f = await setup({ defaultMethodId: 'wallet' });
  t.after(() => f.db.close());
  const plainBefore = await f.rawSub('plain');
  assert.equal((await f.request('methods/wallet?clear=1', 'DELETE')).status, 200);
  const s = await f.rawSub('s');
  assert.equal(s.methodId, undefined);
  assert.equal(s.phases![0].methodId, undefined);
  assert.equal(s.phases![0].payments![0].methodId, undefined);
  assert.equal(s.phases![0].payments![1].funding, undefined);
  assert.equal(s.phases![0].payments![1].amount, 10);
  assert.equal((await f.rawSettings()).defaultMethodId, undefined);
  assert.deepEqual(await f.rawSub('plain'), plainBefore);
});

test('旧版删卡留下的悬空 methodId：原样保存放行，新写入不存在的卡被拒（网页 PUT 与 MCP 一致）', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  // 模拟旧版网页删卡：方式删了，单笔与拆分里的引用留着
  f.db.prepare("DELETE FROM methods WHERE id = 'wallet'").run();
  const detail = await f.call('get_subscription', { subscription: 's' });
  assert.equal(detail.isError, undefined, detail.content[0].text);
  const asIs = await f.call('save_subscription', { subscription: detail.structuredContent.record, dry_run: true });
  assert.equal(asIs.isError, undefined, asIs.content[0].text);
  assert.equal((await f.call('update_subscription', { subscription: 's', set: { remind_days: 3 } })).isError, undefined);
  const put = await f.request('subscriptions/s', 'PUT', { ...(await f.rawSub('s')), notes: 'Fictional note' });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // 新引入的不存在支付方式：两条路径都拒绝
  const bad = { ...(await f.rawSub('plain')), methodId: 'missing' };
  assert.equal((await f.request('subscriptions/plain', 'PUT', bad)).status, 400);
  assert.equal((await f.call('save_subscription', { subscription: bad })).isError, true);
  // 新引入的不可用币种：两条路径都拒绝
  const zzz = { ...(await f.rawSub('plain')), currency: 'ZZZ' };
  assert.equal((await f.request('subscriptions/plain', 'PUT', zzz)).status, 400);
  assert.equal((await f.call('save_subscription', { subscription: zzz })).isError, true);
});

test('PUT /api/settings 与 update_settings 同一套校验：只拦本次改动的非法值，原样回传的旧值可保存并被清理', async (t) => {
  const f = await setup({ publicHidden: ['ghost'], defaultMethodId: 'gone' });
  t.after(() => f.db.close());
  const cur = await f.rawSettings();
  // 网页总是回传整份设置（包括悬空的旧值）
  const ok = await f.request('settings', 'PUT', { ...cur, remindDays: 4 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = await f.rawSettings();
  assert.equal(saved.remindDays, 4);
  assert.deepEqual(saved.publicHidden, []);
  assert.equal(saved.defaultMethodId, undefined);
  for (const patch of [
    { baseCurrency: 'ZZZ' },
    { collectCurrency: 'ZZZ' },
    { timezone: 'Not/AZone' },
    { language: 'xx' },
    { defaultMethodId: 'nope' },
    { publicHidden: ['nope'] },
  ]) {
    assert.equal((await f.request('settings', 'PUT', { ...saved, ...patch })).status, 400, JSON.stringify(patch));
    assert.equal((await f.call('update_settings', { set: patch })).isError, true, JSON.stringify(patch));
  }
  assert.equal((await f.request('settings', 'PUT', { ...saved, defaultMethodId: 'target', publicHidden: ['plain'] })).status, 200);
});

test('纯函数：只校验改动字段、清理悬空引用、旧值放行', () => {
  const st: AppState = {
    subscriptions: [record()],
    methods: [{ id: 'target', name: 'Fictional target card', kind: 'credit', currency: 'USD' }],
    settings: { ...DEFAULT_SETTINGS, publicHidden: ['ghost', 's'], defaultMethodId: 'gone' },
    fx: FALLBACK_FX,
  };
  const r = settingsEdit(st, { remindDays: 9 });
  assert.equal(r.settings.remindDays, 9);
  assert.deepEqual(r.settings.publicHidden, ['s']);
  assert.equal(r.settings.defaultMethodId, undefined);
  assert.throws(() => settingsEdit(st, { publicHidden: ['ghost', 's', 'new-ghost'] }));
  assert.doesNotThrow(() => checkSettings(st, st.settings, { ...st.settings, remindDays: 1 }));
  assert.equal(pruneSettingsRefs(DEFAULT_SETTINGS, [], []), DEFAULT_SETTINGS);
  // 引用校验：记录里原有的悬空卡、旧币种放行，新的拒绝
  const old = record({ methodId: 'gone', currency: 'XXX' });
  assert.equal(subRefsError(st, old, { ...old, price: 11 }), undefined);
  assert.match(subRefsError(st, old, { ...old, methodId: 'missing' }) ?? '', /missing/);
  assert.match(subRefsError(st, undefined, old) ?? '', /gone/);
  assert.match(subRefsError(st, record({ methodId: 'target' }), record({ methodId: 'target', currency: 'ZZZ' })) ?? '', /ZZZ/);
  // 清空模式不要求迁移目标；省略时仍要求
  assert.throws(() => deleteMethodData({ ...st, settings: { ...DEFAULT_SETTINGS, defaultMethodId: 'target' } }, 'target'));
  assert.equal(deleteMethodData({ ...st, settings: { ...DEFAULT_SETTINGS, defaultMethodId: 'target' } }, 'target', null).settings.defaultMethodId, undefined);
});

test('共用用量：网页 PUT、DELETE、导入与 MCP 同一套引用校验，关联方看到来源的数，来源没了不说成 0', async (t) => {
  const f = await setup();
  t.after(() => f.db.close());
  const today = todayIn('UTC');
  const start = addDays(today, -100);
  const base = { ...(await f.rawSub('plain')), start, share: undefined, proxy: undefined };
  const owner = {
    ...base,
    id: 'owner',
    name: 'Fictional insurance',
    meters: [{ id: 'km', name: 'Mileage', unit: 'km' }],
    readings: [
      { id: 'k1', date: addDays(today, -60), values: { km: 800 } },
      { id: 'k2', date: addDays(today, -30), values: { km: 900 } },
    ],
  };
  const linker = { ...base, id: 'linker', name: 'Fictional charger', meters: [{ id: 'kwh', name: 'Power', unit: 'kWh' }] };
  assert.equal((await f.request('subscriptions/owner', 'PUT', owner)).status, 200);
  assert.equal((await f.request('subscriptions/linker', 'PUT', linker)).status, 200);

  // 网页 PUT 指向不存在的来源、MCP 预览不写入
  const dangling = { ...linker, meters: [{ id: 'lk', name: 'x', unit: 'km', link: { subId: 'owner', meterId: 'none' } }] };
  assert.equal((await f.request('subscriptions/linker', 'PUT', dangling)).status, 400);
  const link = { subscription: 'linker', meters: [{ link: { subscription: 'owner', meter: 'Mileage' } }] };
  assert.equal((await f.call('set_meters', { ...link, dry_run: true })).isError ?? false, false);
  assert.equal(((await f.rawSub('linker')) as { meters: unknown[] }).meters.length, 1);
  assert.equal((await f.call('set_meters', link)).isError ?? false, false);
  const stored = (await f.rawSub('linker')) as { meters: Array<{ id: string; name: string; link?: unknown }>; readings?: unknown };
  const lk = stored.meters.find((m) => m.link)!;
  assert.deepEqual(lk.link, { subId: 'owner', meterId: 'km' });
  assert.equal(stored.readings, undefined);

  // 关联方不能自己记数、不能改关联指标；来源记的数两边都看得到
  assert.equal((await f.call('add_readings', { subscription: 'linker', readings: [{ date: today, values: { [lk.id]: 1 } }] })).isError, true);
  assert.equal((await f.call('set_meters', { subscription: 'linker', meters: [{ id: lk.id, unit: 'mi' }] })).isError, true);
  const meters = async () =>
    JSON.parse((await f.call('get_subscription', { subscription: 'linker' })).content[0].text).meters as Array<Record<string, unknown>>;
  const shared = (await meters()).find((m) => m.id === lk.id)!;
  assert.equal(shared.total_usage, 1700);
  assert.equal(shared.unit, 'km');
  assert.deepEqual(shared.linked_from, { subscription_id: 'owner', subscription: 'Fictional insurance', meter_id: 'km' });

  // 年付按月记：MCP 的单价与详情页同一口径，是摊到已记录时段的费用 ÷ 用量，不是首条摊整笔
  const annual = {
    ...owner,
    id: 'annual',
    name: 'Fictional annual',
    price: 3650,
    currency: 'CNY',
    cycle: { unit: 'year', every: 1 },
    payments: undefined,
    phases: undefined,
  };
  assert.equal((await f.request('subscriptions/annual', 'PUT', annual)).status, 200);
  const annualMeter = JSON.parse((await f.call('get_subscription', { subscription: 'annual' })).content[0].text).meters[0];
  assert.equal(annualMeter.latest_unit_price.date, addDays(today, -30));
  assert.ok(annualMeter.latest_unit_price.amount > 0.41 && annualMeter.latest_unit_price.amount < 0.42, String(annualMeter.latest_unit_price.amount));
  assert.equal((await f.request('subscriptions/annual', 'DELETE')).status, 200);

  // 同一次调用里给自有指标改名、再用旧名新建：各归各的
  await f.call('set_meters', {
    subscription: 'linker',
    meters: [
      { id: 'kwh', name: 'Energy' },
      { name: 'Power', unit: 'W' },
    ],
  });
  const renamedOwn = ((await f.rawSub('linker')) as { meters: Array<{ id: string; name: string; link?: unknown }> }).meters.filter((m) => !m.link);
  assert.deepEqual(
    renamedOwn.map((m) => m.name),
    ['Energy', 'Power'],
  );
  await f.call('set_meters', { subscription: 'linker', remove: renamedOwn.filter((m) => m.name === 'Power').map((m) => m.id) });

  // 来源改名后，按现名找关联指标：说明它是关联的，不新建重名指标也不报找不到
  const renamed = { ...(await f.rawSub('owner')), meters: [{ id: 'km', name: 'Odometer', unit: 'km' }] };
  assert.equal((await f.request('subscriptions/owner', 'PUT', renamed)).status, 200);
  const before = ((await f.rawSub('linker')) as { meters: unknown[] }).meters.length;
  const byName = await f.call('add_readings', { subscription: 'linker', readings: [{ date: today, values: { Odometer: 1 } }] });
  assert.equal(byName.isError, true);
  assert.match(byName.content[0].text, /Fictional insurance/);
  assert.equal((await f.call('set_meters', { subscription: 'linker', meters: [{ name: 'Odometer', unit: 'mi' }] })).isError, true);
  assert.equal(((await f.rawSub('linker')) as { meters: unknown[] }).meters.length, before);
  assert.equal((await f.request('subscriptions/owner', 'PUT', owner)).status, 200);

  // 有人关联时，删来源订阅、删来源指标、导入覆盖掉来源都被拒，账本不变
  assert.equal((await f.request('subscriptions/owner', 'DELETE')).status, 400);
  assert.equal((await f.call('delete_subscription', { subscription: 'owner' })).isError, true);
  assert.equal((await f.call('set_meters', { subscription: 'owner', remove: ['km'] })).isError, true);
  assert.equal((await f.request('subscriptions/owner', 'PUT', { ...owner, meters: undefined, readings: undefined })).status, 400);
  assert.equal((await f.request('import', 'POST', { subscriptions: [{ ...owner, meters: [], readings: [] }] })).status, 400);
  assert.ok(await f.rawSub('owner'));

  // 备份恢复或并发留下的悬空引用：读到的是「来源不存在」，不是用了 0；无关修改照常存
  await upsert(f.env, 'subscriptions', 'owner', { ...owner, meters: [], readings: [] });
  const gone = (await meters()).find((m) => m.id === lk.id)!;
  assert.deepEqual([gone.source_missing, gone.total_usage, gone.periods], [true, null, null]);
  assert.equal((await f.request('subscriptions/linker', 'PUT', { ...(await f.rawSub('linker')), notes: 'Fictional note' })).status, 200);

  // 先解除关联就能删
  assert.equal((await f.call('set_meters', { subscription: 'linker', remove: [lk.id] })).isError ?? false, false);
  assert.equal((await f.request('subscriptions/owner', 'DELETE')).status, 200);
});

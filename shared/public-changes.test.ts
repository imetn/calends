import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { events } from './metrics.ts';
import { publicChanges, signedMoney, waterfallFirstMonth, waterfallMonth } from './public-changes.ts';
import { PUBLIC_GRID_SECTIONS } from './public-layout.ts';
import { DEFAULT_SETTINGS, type AppState, type PublicPageConfig, type Subscription } from './types.ts';

const TODAY = '2026-06-15';
const SECRET = 'private-stop-reason';
const sub = (over: Partial<Subscription>): Subscription =>
  ({ id: 'a', name: 'Fiction Music', category: '影音', tags: [], price: 12, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2024-01-15', status: 'active', ...over }) as Subscription;
const subs = () => [
  sub({ priceHistory: [{ from: '2024-01-15', amount: 6 }, { from: '2026-06-01', amount: 12 }] } as Partial<Subscription>),
  sub({ id: 'b', name: 'Fiction Cloud', price: 30, start: '2026-06-03', currency: 'EUR' }),
  sub({ id: 'c', name: 'Fiction Ended', price: 20, start: '2024-02-01', status: 'cancelled', notes: 'private-note', stop: { kind: 'cancel', date: '2026-06-05', reason: SECRET } } as unknown as Partial<Subscription>),
  sub({ id: 'd', name: 'Fiction Forever', price: 99, start: '2025-03-01', cycle: { unit: 'lifetime', every: 1 } }),
  sub({
    id: 'e',
    name: 'Fiction Region',
    start: '2023-01-01',
    phases: [
      { start: '2023-01-01', end: '2026-05-31', price: 5, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'Fictionland' },
      { start: '2026-06-01', price: 8, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'Otherland' },
    ],
  } as unknown as Partial<Subscription>),
];
const ledger = (publicPage?: PublicPageConfig, subscriptions = subs()): AppState =>
  ({
    fx: FALLBACK_FX,
    fxHistory: { '2025-03-01': { CNY: 7, EUR: 0.8 }, '2026-05-31': { CNY: 7, EUR: 0.9 } },
    methods: [],
    settings: { ...DEFAULT_SETTINGS, displayName: 'Fiction Owner', baseCurrency: 'USD', timezone: 'UTC', publicPage },
    subscriptions,
  }) as unknown as AppState;
/** 页面上只放一个组件 */
const only = (id: string): PublicPageConfig => ({
  sections: PUBLIC_GRID_SECTIONS.map(({ id: x, x: left, y, w, h }) => ({ id: x, x: left, y, w, h, ...(x === id ? {} : { hidden: true }) })),
});
const numbers = (rows: ReturnType<typeof publicChanges>) => rows.map((c) => [c.date, c.kind, c.delta]);

test('events 的 note 带停用原因、地区和原价，公开页的变动记录一律丢弃', () => {
  const raw = ledger();
  const notes = events(raw, TODAY).map((e) => e.note).filter(Boolean);
  assert.ok(notes.includes(SECRET), '原始账本的 note 确实带停用原因');
  assert.ok(events(raw, TODAY).some((e) => e.kind === 'switch' && e.note), '换区也有 note（正文含地区和原价）');
  const rows = publicChanges(raw, TODAY, 'USD');
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['date', 'delta', 'kind', 'sub']);
  for (const row of rows) assert.deepEqual(Object.keys(row.sub).sort(), ['category', 'icon', 'id', 'name', 'url']);
  for (const leak of [SECRET, 'private-note', 'Fictionland', 'Otherland']) assert.ok(!JSON.stringify(rows).includes(leak), leak);
});

test('脱敏后停用原因和备注不下发，note 也不再带原因', () => {
  const masked = maskForPublic(ledger(only('changes')));
  assert.ok(!JSON.stringify(masked).includes(SECRET));
  assert.ok(!JSON.stringify(masked).includes('private-note'));
  assert.ok(!events(masked, TODAY).some((e) => e.note === SECRET));
});

test('只放变动记录时，脱敏后的数据足够：输出与原始账本一致', () => {
  const raw = ledger();
  const masked = maskForPublic(ledger(only('changes')));
  assert.deepEqual(numbers(publicChanges(masked, TODAY, 'USD')), numbers(publicChanges(raw, TODAY, 'USD')));
  assert.deepEqual(publicChanges(masked, TODAY, 'USD').map((c) => c.sub.name), publicChanges(raw, TODAY, 'USD').map((c) => c.sub.name));
  assert.deepEqual(numbers(publicChanges(masked, TODAY, 'CNY')), numbers(publicChanges(raw, TODAY, 'CNY')));
});

test('只放月度变化时，脱敏后的数据足够：每个月都与原始账本一致', () => {
  const raw = ledger();
  const masked = maskForPublic(ledger(only('waterfall')));
  assert.equal(waterfallFirstMonth(masked, TODAY), waterfallFirstMonth(raw, TODAY));
  for (const month of ['2024-01', '2026-05', '2026-06']) assert.deepEqual(waterfallMonth(masked, month, TODAY, 'USD'), waterfallMonth(raw, month, TODAY, 'USD'), month);
});

test('组件不在页面上时价格历史照旧裁掉，放上去才下发', () => {
  const price = (m: AppState) => m.subscriptions.find((s) => s.id === 'a' || s.name === 'Fiction Music')?.priceHistory;
  assert.equal(price(maskForPublic(ledger(only('composition')))), undefined);
  assert.ok(price(maskForPublic(ledger(only('waterfall')))));
});

test('变动种类：新增、涨价、降价、停用、买断、换区，时间倒序', () => {
  const rows = publicChanges(ledger(), TODAY, 'USD');
  assert.deepEqual(rows.map((c) => c.date), rows.map((c) => c.date).slice().sort().reverse());
  const of = (id: string, kind: string) => rows.find((c) => c.sub.id === id && c.kind === kind);
  assert.ok(of('b', 'added'));
  assert.ok(Math.abs(of('a', 'up')!.delta - 6) < 1);
  assert.ok(of('c', 'stopped')!.delta < 0);
  assert.ok(of('e', 'switch')!.delta > 0);
  const down = publicChanges(ledger(undefined, [sub({ priceHistory: [{ from: '2024-01-15', amount: 12 }, { from: '2026-06-01', amount: 6 }], price: 6 } as Partial<Subscription>)]), TODAY, 'USD');
  assert.ok(down.some((c) => c.kind === 'down' && c.delta < 0));
});

test('买断按买入当天汇率，月额按当前汇率', () => {
  const state = ledger();
  const rows = publicChanges(state, TODAY, 'CNY');
  assert.equal(rows.find((c) => c.kind === 'buy')!.delta, 99 * 7);
  const usd = publicChanges(state, TODAY, 'USD').find((c) => c.sub.id === 'a' && c.kind === 'up')!.delta;
  assert.ok(Math.abs(rows.find((c) => c.sub.id === 'a' && c.kind === 'up')!.delta - usd * FALLBACK_FX.rates.CNY) < 1e-9);
});

test('缺汇率：金额是 NaN，不变成 0；涨跌方向仍然看原币', () => {
  const state = ledger(undefined, [
    sub({ currency: 'XXX', price: 6, priceHistory: [{ from: '2024-01-15', amount: 12 }, { from: '2026-06-01', amount: 6 }] } as Partial<Subscription>),
    sub({ id: 'b', price: 10, start: '2024-01-01' }),
  ]);
  const down = publicChanges(state, TODAY, 'USD').find((c) => c.sub.id === 'a' && c.kind === 'down');
  assert.ok(down);
  assert.ok(Number.isNaN(down.delta));
  const wf = waterfallMonth(state, '2026-06', TODAY, 'USD');
  assert.equal(wf.complete, false);
  assert.ok(Number.isNaN(wf.steps.find((s) => s.id === 'to')!.value));
  assert.equal(signedMoney(NaN, 'USD'), '—');
});

test('瀑布各项相加等于期末，为 0 的项不出现', () => {
  const wf = waterfallMonth(ledger(), '2026-06', TODAY, 'USD');
  assert.equal(wf.complete, true);
  const sum = wf.steps.filter((s) => s.id !== 'to').reduce((a, s) => a + s.value, 0);
  assert.ok(Math.abs(sum - wf.steps.at(-1)!.value) < 1e-6);
  assert.deepEqual(wf.steps.map((s) => s.id).slice(0, 2), ['from', 'added']);
  const flat = waterfallMonth(ledger(undefined, [sub({})]), '2026-06', TODAY, 'USD');
  assert.deepEqual(flat.steps.map((s) => s.id), ['from', 'to']);
  assert.equal(flat.floor, 0);
});

test('纵轴：变化相对总额很小时抬高起点，变化大时从 0 起', () => {
  const big = sub({ price: 2000, start: '2024-01-01' });
  const small = waterfallMonth(ledger(undefined, [big, sub({ id: 'b', price: 40, start: '2026-06-02' })]), '2026-06', TODAY, 'USD');
  assert.ok(small.floor > 0 && small.floor < 2000);
  const large = waterfallMonth(ledger(undefined, [sub({ price: 10, start: '2024-01-01' }), sub({ id: 'b', price: 100, start: '2026-06-02' })]), '2026-06', TODAY, 'USD');
  assert.equal(large.floor, 0);
});

test('没有周期订阅（或还没开始）时没有可翻的月份', () => {
  assert.equal(waterfallFirstMonth(ledger(undefined, []), TODAY), undefined);
  assert.equal(waterfallFirstMonth(ledger(undefined, [sub({ cycle: { unit: 'lifetime', every: 1 } } as Partial<Subscription>)]), TODAY), undefined);
  assert.equal(waterfallFirstMonth(ledger(undefined, [sub({ start: '2027-01-01' })]), TODAY), undefined);
  assert.equal(waterfallFirstMonth(ledger(), TODAY), '2023-01');
});

test('差额总带 + − 号，不受收支正负号设置影响', () => {
  assert.equal(signedMoney(12, 'USD'), '+$12');
  assert.equal(signedMoney(-3.5, 'USD'), '−$3.50');
});

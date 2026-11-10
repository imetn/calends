import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { PUBLIC_GRID_SECTIONS } from './public-layout.ts';
import { regionSpread } from './scope-report.ts';
import { DEFAULT_SETTINGS, type AppState, type PublicPageConfig, type Subscription } from './types.ts';

const TODAY = '2026-06-15';
const sub = (over: Partial<Subscription>): Subscription =>
  ({
    id: 'a',
    name: 'Fiction Music',
    category: '影音',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-01',
    status: 'active',
    ...over,
  }) as Subscription;
const ledger = (subscriptions: Subscription[], publicPage?: PublicPageConfig): AppState =>
  ({
    fx: FALLBACK_FX,
    fxHistory: {},
    methods: [{ id: 'm-tr', kind: 'appstore', name: 'Fiction Store', currency: 'TRY', region: 'TR' }],
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', timezone: 'UTC', publicPage },
    subscriptions,
  }) as unknown as AppState;
const regionOf = (state: AppState) => (v: Subscription) => v.region || state.methods.find((m) => m.id === v.methodId)?.region;

test('订阅地区：按计费中阶段的地区汇总，换区并行两边各算；不含代付、试用和停用；没地区的不计入', () => {
  const state = ledger([
    sub({ id: 'us', region: 'US', price: 30 }),
    sub({ id: 'us2', region: 'US', price: 6, cycle: { unit: 'year', every: 1 } }),
    sub({ id: 'tr', methodId: 'm-tr', price: 5 }),
    sub({
      id: 'move',
      phases: [
        { start: '2025-01-01', end: '2026-07-31', price: 4, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'JP' },
        { start: '2026-06-01', price: 8, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'NG' },
      ],
    } as unknown as Partial<Subscription>),
    sub({ id: 'proxy', region: 'DE', proxy: { personId: 'p1' } } as unknown as Partial<Subscription>),
    sub({ id: 'trial', region: 'FR', status: 'trial', trialEnd: '2026-07-01' } as Partial<Subscription>),
    sub({ id: 'gone', region: 'GB', status: 'cancelled', end: '2026-05-01' }),
    sub({ id: 'none' }),
  ]);
  const rows = regionSpread(state, TODAY, regionOf(state));
  assert.deepEqual(
    rows.map((r) => [r.cc, r.subs.map((s) => s.id), Math.round(r.monthly.value * 100) / 100]),
    [
      ['US', ['us', 'us2'], 30.5],
      ['NG', ['move'], 8],
      ['TR', ['tr'], 5],
      ['JP', ['move'], 4],
    ],
  );
});

test('订阅地区：缺汇率的金额保留原币、不当成 0，排在能折算的后面', () => {
  const state = ledger([sub({ id: 'x', region: 'US', price: 3 }), sub({ id: 'y', region: 'ZZ', price: 99, currency: 'XXX' })]);
  const rows = regionSpread(state, TODAY, regionOf(state));
  assert.deepEqual(
    rows.map((r) => r.cc),
    ['US', 'ZZ'],
  );
  const zz = rows[1].monthly;
  assert.equal(zz.known, false);
  assert.equal(zz.incomplete, true);
  assert.ok(zz.unconverted.XXX > 0);
});

const only = (id: string): PublicPageConfig =>
  ({
    sections: [
      ...PUBLIC_GRID_SECTIONS.map(({ id: x, x: left, y, w, h }) => ({ id: x, x: left, y, w, h, ...(x === id ? {} : { hidden: true }) })),
      // 底部的订阅堆会带名字，这里一并隐藏，只看这个组件本身要什么
      { id: 'pile', hidden: true },
    ],
  }) as PublicPageConfig;

test('公开页只放地球：地区和金额下发，名字不下发；结果与原始账本一致', () => {
  const subs = [
    sub({ id: 'us', name: 'Secret One', region: 'US', price: 30 }),
    sub({ id: 'tr', name: 'Secret Two', methodId: 'm-tr', price: 5 }),
    sub({
      id: 'move',
      name: 'Secret Three',
      phases: [
        { start: '2025-01-01', end: '2026-07-31', price: 4, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'JP' },
        { start: '2026-06-01', price: 8, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'NG' },
      ],
    } as unknown as Partial<Subscription>),
  ];
  const raw = ledger(subs);
  const masked = maskForPublic(ledger(subs, only('globe')));
  assert.ok(!JSON.stringify(masked).includes('Secret'));
  assert.ok(!JSON.stringify(masked).includes('Fiction Store'));
  const view = (s: AppState) => regionSpread(s, TODAY, regionOf(s)).map((r) => [r.cc, r.subs.length, r.monthly.value]);
  assert.deepEqual(view(masked), view(raw));
});

test('公开页不放地球也不放带名字的组件：订阅、阶段和付款来源的地区都不下发', () => {
  const subs = [
    sub({ id: 'us', region: 'US' }),
    sub({ id: 'tr', methodId: 'm-tr' }),
    sub({
      id: 'move',
      phases: [{ start: '2025-01-01', price: 4, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'JP' }],
    } as unknown as Partial<Subscription>),
  ];
  const masked = maskForPublic(ledger(subs, only('composition')));
  assert.ok(masked.subscriptions.every((s) => !s.region && (s.phases ?? []).every((p) => !p.region)));
  assert.ok(masked.methods.every((m) => !m.region));
});

test('订阅地区：同一订阅在同一地区两段并行，只算一个订阅，金额相加', () => {
  const state = ledger([
    sub({ id: 'us', region: 'US', price: 1 }),
    sub({ id: 'jp', region: 'JP', price: 1 }),
    sub({ id: 'ng', region: 'NG', price: 1 }),
    sub({
      id: 'two',
      phases: [
        { start: '2025-01-01', end: '2026-07-31', price: 4, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'TR' },
        { start: '2026-06-01', price: 8, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'TR' },
      ],
    } as unknown as Partial<Subscription>),
  ]);
  const tr = regionSpread(state, TODAY, regionOf(state)).find((r) => r.cc === 'TR')!;
  assert.deepEqual(
    tr.subs.map((s) => s.id),
    ['two'],
  );
  assert.equal(tr.monthly.value, 12);
});

test('订阅地区：同一地区部分能折算时，标为不完整并保留原币部分', () => {
  const state = ledger([sub({ id: 'a', region: 'US', price: 3 }), sub({ id: 'b', region: 'US', price: 9, currency: 'XXX' })]);
  const [us] = regionSpread(state, TODAY, regionOf(state));
  assert.equal(us.subs.length, 2);
  assert.equal(us.monthly.known, true);
  assert.equal(us.monthly.incomplete, true);
  assert.equal(us.monthly.value, 3);
  assert.ok(us.monthly.unconverted.XXX > 0);
});

test('公开页地球：设置里取消展示的订阅不下发，也不计入地区', () => {
  const subs = [sub({ id: 'us', region: 'US' }), sub({ id: 'hide', region: 'DE' })];
  const state = ledger(subs, only('globe'));
  state.settings.publicHidden = ['hide'];
  const masked = maskForPublic(state);
  assert.deepEqual(
    regionSpread(masked, TODAY, regionOf(masked)).map((r) => r.cc),
    ['US'],
  );
});

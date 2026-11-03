import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chargeDay, chargeServicePeriod, chargesBetween, FALLBACK_FX, subError } from './billing.ts';
import { maskForPublic } from './mask.ts';
import {
  costBetween,
  meterDecimals,
  meterError,
  meterLinkError,
  meterRows,
  meterSource,
  meterStats,
  meterSuggestions,
  meterSummary,
  meterView,
  periodReading,
  periodReadingCount,
  removeMeter,
  removeReading,
  replaceMeters,
  setPeriodValues,
  spreadUnitPrice,
  stableId,
  usageWithin,
  writeReading,
} from './meters.ts';
import { DEFAULT_SETTINGS, type AppState, type Meter, type Payment, type Reading, type Subscription } from './types.ts';

// 虚构场景：月付 ¥100 的 VPS，每月 10 日扣款；每月 15 日记一次出站流量（本期用量）和里程式累计读数
const today = '2025-05-01';
const traffic: Meter = { id: 'gb', name: 'Traffic', unit: 'GB' };
const odo: Meter = { id: 'odo', name: 'Counter', unit: 'kWh', kind: 'reading' };
const readings: Reading[] = [
  { id: 'r1', date: '2025-01-15', values: { gb: 10, odo: 1000 } },
  { id: 'r2', date: '2025-02-15', values: { gb: 20, odo: 1300 }, note: 'busy month' },
  { id: 'r3', date: '2025-03-15', values: { gb: 0, odo: 1200 } },
  { id: 'r4', date: '2025-04-15', values: { odo: 1500 } },
];
const vps = (extra: Partial<Subscription> = {}): Subscription => ({
  id: 'vps',
  name: 'Fictional VPS',
  category: 'tools',
  tags: [],
  price: 100,
  currency: 'CNY',
  cycle: { unit: 'month', every: 1 },
  start: '2025-01-10',
  status: 'active',
  meters: [traffic, odo],
  readings,
  ...extra,
});
const near = (actual: number | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('usage meter takes the value as period usage and prices it against charges since the previous reading', () => {
  const rows = meterRows(vps(), traffic, today);
  assert.deepEqual(
    rows.map((r) => [r.reading.id, r.usage, r.since, r.cost?.amount]),
    [
      ['r1', 10, '2025-01-09', 100],
      ['r2', 20, '2025-01-15', 100],
      ['r3', 0, '2025-02-15', 100],
    ],
  );
  near(rows[0].unitPrice, 10); // 首条从订阅开始算期间
  near(rows[1].unitPrice, 5);
  assert.equal(rows[2].unitPrice, undefined, 'zero usage has no unit price');
});

test('reading meter diffs against the previous reading; the first and a rollback have no usage', () => {
  const rows = meterRows(vps(), odo, today);
  assert.deepEqual(
    rows.map((r) => [r.reading.id, r.value, r.usage]),
    [
      ['r1', 1000, undefined],
      ['r2', 1300, 300],
      ['r3', 1200, undefined],
      ['r4', 1500, 300],
    ],
  );
  near(rows[1].unitPrice, 100 / 300);
  assert.equal(rows[2].unitPrice, undefined);
  near(rows[3].unitPrice, 100 / 300);
});

test('readings are ordered by date regardless of storage order', () => {
  const rows = meterRows(vps({ readings: [...readings].reverse() }), odo, today);
  assert.deepEqual(
    rows.map((r) => r.reading.id),
    ['r1', 'r2', 'r3', 'r4'],
  );
});

test('unit price excludes failed charges and has none when the period has no charge', () => {
  // 2 月扣款失败，下一次扣款顺延到 3 月
  const ok: Payment = { date: '2025-01-10', amount: 100, currency: 'CNY' };
  const failed: Payment = { date: '2025-02-10', amount: 100, currency: 'CNY', kind: 'failed' };
  const s = vps({ payments: [ok, failed], nextDue: '2025-03-10' });
  assert.equal(costBetween(s, '2025-01-15', '2025-02-15', today), undefined);
  const r2 = meterRows(s, traffic, today)[1];
  assert.equal(r2.usage, 20);
  assert.equal(r2.cost, undefined);
  assert.equal(r2.unitPrice, undefined);
  // 同一天内两条记录之间没有扣款
  assert.equal(costBetween(vps(), '2025-01-11', '2025-02-09', today), undefined);
  // 预测扣款（今天之后）不计
  assert.equal(costBetween(vps(), '2025-04-15', '2025-06-15', today), undefined);
});

test('summary totals usage over all readings or a window and reports the latest priced period', () => {
  const all = meterSummary(vps(), odo, today);
  assert.equal(all.total, 600);
  assert.equal(all.periods, 2);
  assert.equal(all.latest?.reading.id, 'r4');
  assert.equal(all.latestPriced?.reading.id, 'r4');
  const win = meterSummary(vps(), traffic, today, '2025-02-01', '2025-03-31');
  assert.equal(win.total, 20);
  assert.equal(win.periods, 2);
  assert.equal(win.from, '2025-02-15');
  assert.equal(meterSummary(vps(), traffic, today).latestPriced?.reading.id, 'r2');
  assert.equal(meterSummary(vps({ readings: undefined }), traffic, today).total, 0);
});

test('removing a meter strips its values and drops readings left empty', () => {
  const next = removeMeter(vps(), 'odo');
  assert.deepEqual(next.meters, [traffic]);
  assert.deepEqual(
    next.readings?.map((r) => [r.id, r.values]),
    [
      ['r1', { gb: 10 }],
      ['r2', { gb: 20 }],
      ['r3', { gb: 0 }],
    ],
  );
  assert.equal(next.readings?.[1].note, 'busy month');
  const none = replaceMeters(vps(), []);
  assert.equal(none.meters, undefined);
  assert.equal(none.readings, undefined);
  // 改名改单位不动历史数值
  const renamed = replaceMeters(vps(), [{ ...traffic, name: 'Egress' }, odo]);
  assert.deepEqual(renamed.readings, readings);
  assert.equal(renamed.meters?.[0].name, 'Egress');
});

test('stable ids are deterministic and skip taken ids', () => {
  const a = stableId('m', 'vps|traffic', new Set());
  assert.equal(stableId('m', 'vps|traffic', new Set()), a);
  const b = stableId('m', 'vps|traffic', new Set([a]));
  assert.notEqual(a, b);
  assert.ok(a.startsWith('m'));
});

test('suggestions come from other subscriptions, most used first, excluding names already on this one', () => {
  const other = (id: string, meters: Meter[]): Subscription => ({ ...vps(), id, meters, readings: undefined });
  const subs = [
    other('a', [{ id: 'x', name: 'Mileage', unit: 'km', kind: 'reading' }, traffic]),
    other('b', [{ id: 'y', name: 'Mileage', unit: 'km', kind: 'reading' }]),
    other('c', [{ id: 'z', name: 'traffic ', unit: 'GB' }]),
  ];
  const current = { ...vps(), id: 'mine', meters: [{ id: 'q', name: 'TRAFFIC', unit: 'GB' }] };
  assert.deepEqual(meterSuggestions([...subs, current], current), [{ name: 'Mileage', unit: 'km', kind: 'reading' }]);
  assert.deepEqual(meterSuggestions(subs).slice(0, 1), [{ name: 'Mileage', unit: 'km', kind: 'reading' }]);
});

test('validation rejects malformed meters and readings; subError runs it', () => {
  assert.equal(meterError(vps()), undefined);
  assert.equal(subError(vps()), undefined);
  assert.equal(meterError({}), undefined);
  const bad: Array<Partial<Subscription>> = [
    { meters: [traffic, { ...odo, id: 'gb' }], readings: [] },
    { meters: [{ ...traffic, name: '  ' }] },
    { meters: [traffic, { ...odo, name: ' Traffic ' }], readings: [] },
    { meters: [{ ...traffic, kind: 'usage' as never }] },
    { meters: 'x' as never },
    { readings: [{ id: 'r', date: '2025-02-30', values: { gb: 1 } }] },
    { readings: [{ id: 'r', date: '2025-02-01', values: { nope: 1 } }] },
    { readings: [{ id: 'r', date: '2025-02-01', values: { gb: Number.NaN } }] },
    { readings: [{ id: 'r', date: '2025-02-01', values: { gb: '3' as never } }] },
    { readings: [readings[0], { ...readings[1], id: 'r1' }] },
    { readings: [{ id: 'r', date: '2025-02-01', values: [] as never }] },
  ];
  for (const patch of bad) {
    const s = vps(patch);
    assert.ok(meterError(s), JSON.stringify(patch));
    assert.ok(subError(s), JSON.stringify(patch));
  }
});

test('public page never receives meters or readings', () => {
  const state: AppState = {
    subscriptions: [vps({ readings: [{ id: 'rx', date: '2025-01-15', values: { gb: 1 }, note: 'private reading note' }] })],
    methods: [],
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY', publicPage: true } as AppState['settings'],
    fx: FALLBACK_FX,
  };
  const out = maskForPublic(state);
  assert.equal(out.subscriptions.length, 1);
  assert.equal(out.subscriptions[0].meters, undefined);
  assert.equal(out.subscriptions[0].readings, undefined);
  assert.doesNotMatch(JSON.stringify(out), /private reading note|Traffic|kWh/);
});

test('postpaid bills count toward the reading at the end of the period they settle', () => {
  const kwh: Meter = { id: 'kwh', name: 'Electricity', unit: 'kWh' };
  const power: Subscription = {
    id: 'power',
    name: 'Fictional power',
    category: 'utilities',
    tags: [],
    price: 100,
    currency: 'CNY',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-01',
    status: 'active',
    billing: 'postpaid',
    payments: [
      { date: '2025-02-01', amount: 50 },
      { date: '2025-03-01', amount: 80 },
    ],
    meters: [kwh],
    readings: [
      { id: 'jan', date: '2025-01-31', values: { kwh: 100 } },
      { id: 'feb', date: '2025-02-28', values: { kwh: 200 } },
    ],
  };
  const rows = meterRows(power, kwh, '2025-03-15');
  assert.deepEqual(
    rows.map((r) => [r.reading.id, r.cost?.amount]),
    [
      ['jan', 50],
      ['feb', 80],
    ],
  );
  near(rows[0].unitPrice, 0.5);
  near(rows[1].unitPrice, 0.4);
  const stats = meterStats(rows);
  near(stats.average, 150);
  near(stats.unitPrice?.amount, 130 / 300);
  assert.equal(stats.peak?.reading.id, 'feb');
});

test('stats stay empty without usage', () => {
  assert.deepEqual(meterStats([]), { average: undefined, unitPrice: undefined, peak: undefined });
});

// 回归：中途才开始记录时，首条只摊前一个周期的扣款，不把订阅开始以来的全部算进去
test('a usage meter started mid-subscription prices its first reading against one cycle only', () => {
  const late = vps({ readings: [{ id: 'late', date: '2025-04-15', values: { gb: 50 } }] });
  const [row] = meterRows(late, traffic, today);
  assert.equal(row.since, '2025-03-15');
  assert.equal(row.cost?.amount, 100);
  near(row.unitPrice, 2);
});

// 回归：订阅开始前一天记的本期用量不属于任何计费周期，累计与期数要和扣款记录按服务期的合计一致
test('a usage reading dated before the subscription start is left out of totals like the charge ledger', () => {
  const early = vps({
    readings: [
      { id: 'pre0', date: '2024-12-20', values: { gb: 7 } },
      { id: 'pre', date: '2025-01-09', values: { gb: 5 } },
      { id: 'jan', date: '2025-02-09', values: { gb: 40 } },
      { id: 'feb', date: '2025-03-09', values: { gb: 2.5 } },
    ],
  });
  const rows = meterRows(early, traffic, today);
  assert.equal(rows[0].usage, undefined);
  assert.equal(rows[1].usage, undefined);
  const sum = meterSummary(early, traffic, today);
  assert.equal(sum.total, 42.5);
  assert.equal(sum.periods, 2);
  assert.equal(sum.from, '2025-02-09');
  assert.equal(meterStats(rows).average, 21.25);
  const charged = chargesBetween(early, early.start, today, today).filter((c) => !c.kind);
  const ledger = charged.reduce((a, c) => {
    const p = chargeServicePeriod(c.sub, c.date, c.serviceDate);
    return a + (usageWithin(rows, p.from, p.until) ?? 0);
  }, 0);
  assert.equal(ledger, sum.total);
});

test('two usage readings on the same date both count', () => {
  const twice = vps({
    readings: [
      { id: 'a', date: '2025-02-09', values: { gb: 40 } },
      { id: 'b', date: '2025-02-09', values: { gb: 2 } },
    ],
  });
  const rows = meterRows(twice, traffic, today);
  assert.deepEqual(
    rows.map((r) => r.usage),
    [40, 2],
  );
  assert.equal(meterSummary(twice, traffic, today).total, 42);
});

test('meter decimals follow the most precise recorded value, capped at three', () => {
  assert.equal(meterDecimals(vps(), 'gb'), 0);
  assert.equal(meterDecimals({ readings: [...readings, { id: 'x', date: '2025-05-15', values: { gb: 12.67 } }] }, 'gb'), 2);
  assert.equal(meterDecimals({ readings: [{ id: 'y', date: '2025-05-15', values: { gb: 0.1 + 0.2 } }] }, 'gb'), 1);
  assert.equal(meterDecimals({ readings: [{ id: 'z', date: '2025-05-15', values: { gb: 1.23456 } }] }, 'gb'), 3);
  assert.equal(meterDecimals({}, 'gb'), 0);
});

// 扣款记录的用量列：每笔按它覆盖的服务期汇总，后付费 10 月 1 日的账单对应 9 月 30 日那条
test('usage within a charge service period sums readings dated inside it', () => {
  const kwh: Meter = { id: 'kwh', name: 'Electricity', unit: 'kWh' };
  const power = vps({
    billing: 'postpaid',
    start: '2025-01-01',
    meters: [kwh],
    readings: [
      { id: 'jan', date: '2025-01-31', values: { kwh: 100 } },
      { id: 'feb', date: '2025-02-28', values: { kwh: 200 } },
    ],
  });
  const rows = meterRows(power, kwh, '2025-03-15');
  const feb1 = chargeServicePeriod(power, '2025-02-01');
  assert.equal(usageWithin(rows, feb1.from, feb1.until), 100);
  const mar1 = chargeServicePeriod(power, '2025-03-01');
  assert.equal(usageWithin(rows, mar1.from, mar1.until), 200);
  // 年付的一笔覆盖全年，记录逐月记也能合计
  assert.equal(usageWithin(meterRows(vps(), traffic, today), '2025-01-10', '2026-01-10'), 30);
  assert.equal(usageWithin(rows, '2024-01-01', '2024-12-31'), undefined);
});

test('charge sheet writes usage into the reading of that billing period', () => {
  const s = vps();
  const mar = chargeServicePeriod(s, '2025-03-10');
  assert.equal(periodReading(s, mar.from, mar.until)?.id, 'r3');
  // 改已有记录：只动填了的指标，其余保留
  const edited = setPeriodValues(s, mar.from, mar.until, { gb: 5 }, { id: 'new', date: '2025-04-09' });
  assert.deepEqual(edited.readings?.find((r) => r.id === 'r3')?.values, { gb: 5, odo: 1200 });
  assert.equal(edited.readings?.length, 4);
  // 周期内没有记录时新建一条
  const may = chargeServicePeriod(s, '2025-05-10');
  const added = setPeriodValues(s, may.from, may.until, { gb: 7, odo: undefined }, { id: 'new', date: '2025-05-10' });
  assert.deepEqual(added.readings?.at(-1), { id: 'new', date: '2025-05-10', values: { gb: 7 } });
  // 全部清掉的记录删掉；本来就没有、也没填时不写
  const r4 = chargeServicePeriod(s, '2025-04-10');
  assert.equal(
    setPeriodValues(s, r4.from, r4.until, { odo: undefined }, { id: 'x', date: '2025-04-10' }).readings?.some((r) => r.id === 'r4'),
    false,
  );
  assert.equal(setPeriodValues(s, may.from, may.until, { gb: undefined }, { id: 'x', date: '2025-05-10' }), s);
  // 同一周期多条时改最晚的一条
  const two = vps({ readings: [...readings, { id: 'r3b', date: '2025-03-20', values: { gb: 1 } }] });
  assert.equal(periodReading(two, mar.from, mar.until)?.id, 'r3b');
  assert.equal(periodReadingCount(two, mar.from, mar.until, 'gb'), 2);
  // 指标分开记：最晚那条没有 odo 时，改 odo 落在记了它的那条，不在同一周期写出第二个 odo
  assert.equal(periodReading(two, mar.from, mar.until, 'odo')?.id, 'r3');
  const split = setPeriodValues(two, mar.from, mar.until, { odo: 1250 }, { id: 'x', date: '2025-04-09' });
  assert.deepEqual(split.readings?.find((r) => r.id === 'r3')?.values, { gb: 0, odo: 1250 });
  assert.deepEqual(split.readings?.find((r) => r.id === 'r3b')?.values, { gb: 1 });
  // 两个指标都新建时写进同一条
  const both = setPeriodValues(vps({ readings: [] }), may.from, may.until, { gb: 7, odo: 1600 }, { id: 'n', date: '2025-05-10' });
  assert.deepEqual(both.readings, [{ id: 'n', date: '2025-05-10', values: { gb: 7, odo: 1600 } }]);
});

test('postpaid bills sit on the last day of the period they settle, prepaid charges on the cash date', () => {
  const power = vps({ billing: 'postpaid', start: '2025-01-01', meters: [], readings: [] });
  const [feb1] = chargesBetween(power, '2025-02-01', '2025-02-01', '2025-03-01');
  assert.equal(chargeDay(feb1), '2025-01-31');
  // 12 月的账单次年 1 月交，仍归 12 月
  const [jan1] = chargesBetween(power, '2026-01-01', '2026-01-01', '2026-02-01');
  assert.equal(chargeDay(jan1), '2025-12-31');
  assert.equal(chargeDay({ ...feb1, kind: 'refund' }), '2025-02-01');
  // 晚几天才交（1 月 5 日交 12 月电费）：仍归付款日前刚结束的那一期
  assert.deepEqual(chargeServicePeriod(power, '2026-01-05'), { from: '2025-12-01', until: '2026-01-01' });
  assert.equal(chargeDay({ ...jan1, date: '2026-01-05' }), '2025-12-31');
  assert.deepEqual(chargeServicePeriod(power, '2025-03-04'), { from: '2025-02-01', until: '2025-03-01' });
  // 月末起始：3 月 30 日交的仍是 2 月那期（下一个边界 3 月 31 日还没到）
  const eom = vps({ billing: 'postpaid', start: '2026-01-31', meters: [], readings: [] });
  assert.deepEqual(chargeServicePeriod(eom, '2026-03-30'), { from: '2026-01-31', until: '2026-02-28' });
  assert.deepEqual(chargeServicePeriod(eom, '2026-05-30'), { from: '2026-03-31', until: '2026-04-30' });
  // 4 月 30 日按时交了 4 月账单，5 月 3 日补交的是 3 月那期，两笔不归到同一期
  const both = {
    ...eom,
    payments: [
      { date: '2026-04-30', amount: 10 },
      { date: '2026-05-03', amount: 12 },
    ],
  };
  assert.deepEqual(chargeServicePeriod(both, '2026-04-30'), { from: '2026-03-31', until: '2026-04-30' });
  assert.deepEqual(chargeServicePeriod(both, '2026-05-03'), { from: '2026-02-28', until: '2026-03-31' });
  // 前几期都已按时结清：重复扣款仍归最近结束的一期
  const dup = {
    ...eom,
    payments: [
      { date: '2026-02-28', amount: 10 },
      { date: '2026-03-31', amount: 10 },
      { date: '2026-04-30', amount: 10 },
      { date: '2026-05-03', amount: 10 },
    ],
  };
  assert.deepEqual(chargeServicePeriod(dup, '2026-05-03'), { from: '2026-03-31', until: '2026-04-30' });
  const [mar10] = chargesBetween(vps(), '2025-03-10', '2025-03-10', today);
  assert.equal(chargeDay(mar10), '2025-03-10');
});

// 虚构场景：车险年付 ¥1200 持有里程；充电桩月付 ¥30 记电量，并关联车险的里程
const sharedOwner = (over: Partial<Subscription> = {}): Subscription => ({
  id: 'fictional-ins',
  name: 'Fictional insurance',
  price: 1200,
  currency: 'CNY',
  cycle: { unit: 'year', every: 1 },
  start: '2026-01-01',
  status: 'active',
  category: 'tools',
  tags: [],
  meters: [{ id: 'km', name: 'Mileage', unit: 'km' }],
  readings: [
    { id: 'k1', date: '2026-01-31', values: { km: 800 }, note: 'first month' },
    { id: 'k2', date: '2026-02-28', values: { km: 1000 } },
    { id: 'k3', date: '2026-03-31', values: { km: 900 } },
  ],
  ...over,
});
const sharedLinker = (over: Partial<Subscription> = {}): Subscription => ({
  ...sharedOwner(),
  id: 'fictional-pile',
  name: 'Fictional charger',
  price: 30,
  cycle: { unit: 'month', every: 1 },
  start: '2026-02-01',
  meters: [
    { id: 'kwh', name: 'Power', unit: 'kWh' },
    { id: 'lk', name: 'stale', unit: '?', link: { subId: 'fictional-ins', meterId: 'km' } },
  ],
  readings: [{ id: 'e1', date: '2026-02-15', values: { kwh: 40 } }],
  ...over,
});

test('关联指标显示来源的名称单位和记录，只取本订阅服务期内，存的数不进原始订阅', () => {
  const linker = sharedLinker({ stop: { date: '2026-03-15', kind: 'cancel' } } as Partial<Subscription>);
  const owner = sharedOwner();
  const view = meterView(linker, [owner, linker]);
  const meter = view.meters!.find((m) => m.id === 'lk')!;
  assert.deepEqual([meter.name, meter.unit, meter.link?.subId], ['Mileage', 'km', 'fictional-ins']);
  // 1 月的在开始前、3 月 31 日的在停用后，都不算；记录 id 与备注跟来源一致
  const rows = view.readings!.filter((r) => 'lk' in r.values);
  assert.deepEqual(rows, [{ id: 'k2', date: '2026-02-28', values: { lk: 1000 } }]);
  assert.equal(meterSummary(view, meter, '2026-04-15').total, 1000);
  assert.equal(linker.readings!.length, 1);
  assert.equal(meterView(owner, [owner, linker]), owner);
});

test('关联累计读数型时保留开始前最后一条作基数，来源的类型覆盖本地旧类型', () => {
  const owner = sharedOwner({
    meters: [{ id: 'km', name: 'Odometer', unit: 'km', kind: 'reading' }],
    readings: [
      { id: 'o1', date: '2026-01-10', values: { km: 100 } },
      { id: 'o2', date: '2026-01-20', values: { km: 500 } },
      { id: 'o3', date: '2026-02-20', values: { km: 900 } },
    ],
  });
  const linker = sharedLinker();
  const view = meterView(linker, [owner, linker]);
  const meter = view.meters!.find((m) => m.id === 'lk')!;
  assert.equal(meter.kind, 'reading');
  const rows = meterRows(view, meter, '2026-04-15');
  assert.deepEqual(
    rows.map((r) => [r.reading.id, r.usage ?? null]),
    [
      ['o2', null],
      ['o3', 400],
    ],
  );
});

test('来源不存在时关联指标不并入任何记录，不显示成用了 0', () => {
  const linker = sharedLinker();
  const view = meterView(linker, [linker]);
  assert.equal(meterSource(linker, linker.meters![1], [linker]), undefined);
  assert.equal(
    view.readings!.some((r) => 'lk' in r.values),
    false,
  );
  assert.equal(view.meters![1].name, 'stale');
});

test('引用校验拒绝新造的坏引用，放行早就坏掉的，拦住删来源、删指标和把来源改成关联', () => {
  const owner = sharedOwner();
  const linker = sharedLinker();
  const before = [owner, linker];
  assert.equal(meterLinkError(before, before), undefined);
  // 新建指向不存在的指标、指向自己
  const dangling = sharedLinker({ meters: [{ id: 'lk', name: 'x', unit: 'km', link: { subId: 'fictional-ins', meterId: 'none' } }] });
  assert.ok(meterLinkError(before, [owner, dangling]));
  const self = sharedLinker({ meters: [{ id: 'lk', name: 'x', unit: 'km', link: { subId: 'fictional-pile', meterId: 'kwh' } }] });
  assert.ok(meterLinkError(before, [owner, self]));
  // 删来源订阅、删来源指标：提示里点名被谁用着
  assert.match(meterLinkError(before, [linker]) ?? '', /./);
  assert.ok(meterLinkError(before, [{ ...owner, meters: [] }, linker]));
  // 来源变成关联别人：只有一层
  const third = sharedOwner({ id: 'fictional-third', name: 'Third' });
  const chained = { ...owner, meters: [{ id: 'km', name: 'Mileage', unit: 'km', link: { subId: 'fictional-third', meterId: 'km' } }], readings: undefined };
  assert.ok(meterLinkError([owner, linker, third], [chained, linker, third]));
  // 早就悬空的引用：无关修改照常存
  const stale = sharedLinker();
  assert.equal(meterLinkError([stale], [{ ...stale, notes: 'Fictional note' }]), undefined);
});

test('关联指标自己不存数，写入校验拒绝显示副本存回去', () => {
  const linker = sharedLinker();
  assert.equal(meterError(linker), undefined);
  assert.ok(meterError(meterView(linker, [sharedOwner(), linker])));
  assert.ok(meterError({ meters: [{ id: 'lk', name: 'x', unit: 'km', link: { subId: '', meterId: 'km' } }] }));
});

test('写记录和删记录只动这个指标，同一条上的其他指标留着', () => {
  const s = sharedOwner({
    meters: [
      { id: 'km', name: 'Mileage', unit: 'km' },
      { id: 'kwh', name: 'Power', unit: 'kWh' },
    ],
    readings: [{ id: 'k1', date: '2026-01-31', values: { km: 800, kwh: 50 }, note: 'old' }],
  });
  const edited = writeReading(s, ['km'], { id: 'k1', date: '2026-01-31', values: { km: 810 } });
  assert.deepEqual(edited.readings, [{ id: 'k1', date: '2026-01-31', values: { kwh: 50, km: 810 } }]);
  // 改日期：其他指标留在原日期，这个指标拆成新的一条
  const moved = writeReading(s, ['km'], { id: 'k1', date: '2026-02-01', values: { km: 810 } }, 'k1');
  assert.deepEqual(moved.readings![0], { id: 'k1', date: '2026-01-31', values: { kwh: 50 }, note: 'old' });
  assert.deepEqual([moved.readings![1].date, moved.readings![1].values], ['2026-02-01', { km: 810 }]);
  assert.notEqual(moved.readings![1].id, 'k1');
  // 同一个 id 重试：覆盖不重复记
  const retry = writeReading(edited, ['km'], { id: 'k1', date: '2026-01-31', values: { km: 810 } });
  assert.equal(retry.readings!.length, 1);
  const added = writeReading(s, ['km'], { id: 'k9', date: '2026-03-01', values: { km: 1 } });
  assert.equal(added.readings!.length, 2);
  // 删：只清这个指标；没有数了才删整条
  const removed = removeReading(s, ['km'], 'k1');
  assert.deepEqual(removed.readings![0].values, { kwh: 50 });
  assert.equal(removeReading(removed, ['kwh'], 'k1').readings, undefined);
});

test('年付车险按月记里程：单价按已记录时段摊费，晚记不涨价，逐期记录走原来的单价', () => {
  const s = sharedOwner();
  const rows = meterRows(s, s.meters![0], '2026-04-15');
  const spread = spreadUnitPrice(s, rows, '2026-04-15');
  // 1 月 1 日到 3 月 31 日共 90 天：1200 × 90 ÷ 365 ÷ 2700
  assert.equal(spread?.asOf, '2026-03-31');
  assert.ok(Math.abs(spread!.price!.amount - (1200 * 90) / 365 / 2700) < 1e-9);
  assert.equal(spread!.price!.currency, 'CNY');
  // 今天往后推，费用和用量都截至最后一条记录，单价不变
  const later = spreadUnitPrice(s, meterRows(s, s.meters![0], '2026-09-01'), '2026-09-01');
  assert.ok(Math.abs(later!.price!.amount - spread!.price!.amount) < 1e-9);
  // 每期一条：不摊，走逐期单价
  const monthly = sharedOwner({ cycle: { unit: 'month', every: 1 }, price: 30 });
  assert.equal(spreadUnitPrice(monthly, meterRows(monthly, monthly.meters![0], '2026-04-15'), '2026-04-15'), undefined);
  // 没有用量、终身买断：都不摊
  assert.equal(spreadUnitPrice(sharedOwner({ readings: undefined }), [], '2026-04-15'), undefined);
  const lifetime = sharedOwner({ cycle: { unit: 'lifetime', every: 1 } });
  assert.equal(spreadUnitPrice(lifetime, meterRows(lifetime, lifetime.meters![0], '2026-04-15'), '2026-04-15'), undefined);
});

test('公开页不带关联指标和来源引用', () => {
  const state: AppState = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [sharedOwner(), sharedLinker()] };
  const text = JSON.stringify(maskForPublic(state));
  assert.equal(text.includes('"link"'), false);
  assert.equal(text.includes('"meters"'), false);
  assert.equal(text.includes('"readings"'), false);
});

const spreadOf = (s: Subscription, today: string) => spreadUnitPrice(s, meterRows(s, s.meters![0], today), today);

test('摊销单价：中途才开始记录时只算首条所在的那一期，不把更早的费用摊进来', () => {
  const s = sharedOwner({ start: '2024-01-01' });
  const spread = spreadOf(s, '2026-04-15')!;
  assert.equal(spread.asOf, '2026-03-31');
  assert.ok(Math.abs(spread.price!.amount - (1200 * 90) / 365 / 2700) < 1e-9);
});

test('摊销单价：还没出账的后付费当期不进分母，截至日停在已出账的最后一条', () => {
  const s = sharedOwner({
    price: 90,
    billing: 'postpaid',
    cycle: { unit: 'month', every: 1 },
    readings: [
      { id: 'a', date: '2026-01-15', values: { km: 100 } },
      { id: 'b', date: '2026-01-31', values: { km: 100 } },
      { id: 'c', date: '2026-02-15', values: { km: 100 } },
    ],
  } as Partial<Subscription>);
  // 2 月 20 日时 1 月账单已出，2 月账单还没出：2 月那条既没费用也不算用量
  const spread = spreadOf(s, '2026-02-20')!;
  assert.equal(spread.asOf, '2026-01-31');
  assert.ok(Math.abs(spread.price!.amount - 90 / 200) < 1e-9);
});

test('摊销单价：币种只看摊到的扣款，换币前的不挡住单价；同一时段混币种才没有', () => {
  const s = sharedOwner({
    start: '2025-01-01',
    phases: [
      { start: '2025-01-01', price: 200, currency: 'USD', cycle: { unit: 'year', every: 1 } },
      { start: '2026-01-01', price: 1200, currency: 'CNY', cycle: { unit: 'year', every: 1 } },
    ],
  } as Partial<Subscription>);
  assert.equal(spreadOf(s, '2026-04-15')!.price!.currency, 'CNY');
  const parallel = sharedOwner({
    phases: [
      { start: '2026-01-01', end: '2026-12-31', price: 200, currency: 'USD', cycle: { unit: 'year', every: 1 } },
      { start: '2026-01-02', price: 1200, currency: 'CNY', cycle: { unit: 'year', every: 1 } },
    ],
  } as Partial<Subscription>);
  assert.equal(spreadOf(parallel, '2026-04-15')!.price, undefined);
});

test('摊销单价：退款和补差算进费用，全退后没有单价，扣款失败不算', () => {
  const pay = (over: object) => [
    { date: '2026-01-01', amount: 1200, currency: 'CNY' },
    { currency: 'CNY', ...over },
  ];
  const plain = spreadOf(sharedOwner(), '2026-04-15')!.price!.amount;
  const refunded = sharedOwner({ payments: pay({ date: '2026-02-01', amount: -1200, kind: 'refund' }) } as Partial<Subscription>);
  assert.equal(spreadOf(refunded, '2026-04-15')!.price, undefined);
  const adjusted = sharedOwner({ payments: pay({ date: '2026-02-01', amount: 600, kind: 'adjust' }) } as Partial<Subscription>);
  assert.ok(Math.abs(spreadOf(adjusted, '2026-04-15')!.price!.amount - plain * 1.5) < 1e-6);
  const failed = sharedOwner({ payments: pay({ date: '2026-02-01', amount: 600, kind: 'failed' }) } as Partial<Subscription>);
  assert.ok(Math.abs(spreadOf(failed, '2026-04-15')!.price!.amount - plain) < 1e-9);
});

test('关联指标只取真正服务的日子：阶段空档、暂停之后不算，并行阶段任一段覆盖即可', () => {
  const owner = sharedOwner({
    readings: ['01-31', '03-15', '05-15', '07-15', '09-15'].map((d, i) => ({ id: `k${i}`, date: `2026-${d}`, values: { km: 100 } })),
  });
  const dates = (s: Subscription) =>
    meterView(s, [owner, s])
      .readings!.filter((r) => 'lk' in r.values)
      .map((r) => r.date);
  const plan = { price: 30, currency: 'CNY', cycle: { unit: 'month', every: 1 } };
  const gap = sharedLinker({
    start: '2026-01-01',
    phases: [
      { ...plan, start: '2026-01-01', end: '2026-02-28' },
      { ...plan, start: '2026-05-01', end: '2026-06-30' },
    ],
  } as Partial<Subscription>);
  assert.deepEqual(dates(gap), ['2026-01-31', '2026-05-15']);
  const paused = sharedLinker({ start: '2026-01-01', status: 'paused', pausedAt: '2026-04-01' } as Partial<Subscription>);
  assert.deepEqual(dates(paused), ['2026-01-31', '2026-03-15']);
  // 并行：后开始的那段先结束，最后一段的结束日不能当成整个订阅的结束日
  const parallel = sharedLinker({
    start: '2026-01-01',
    phases: [
      { ...plan, start: '2026-01-01', end: '2026-08-31' },
      { ...plan, start: '2026-02-01', end: '2026-04-30' },
    ],
  } as Partial<Subscription>);
  assert.deepEqual(dates(parallel), ['2026-01-31', '2026-03-15', '2026-05-15', '2026-07-15']);
});

test('摊销单价：账单变多不改变单价，现金日在期外的正常扣款按自己的服务期算', () => {
  const twice = (m: string) => [
    { id: `${m}a`, date: `2026-${m}-14`, values: { km: 100 } },
    { id: `${m}b`, date: `2026-${m}-${m === '02' ? '28' : '31'}`, values: { km: 100 } },
  ];
  const post = sharedOwner({
    price: 90,
    billing: 'postpaid',
    cycle: { unit: 'month', every: 1 },
    readings: [...twice('01'), ...twice('02')],
  } as Partial<Subscription>);
  for (const day of ['2026-03-05', '2026-04-05', '2026-09-05']) assert.ok(Math.abs(spreadOf(post, day)!.price!.amount - 0.45) < 1e-9, day);
  // 提前续费：1 月 28 日付的是 2 月的
  const early = sharedOwner({
    price: 310,
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    payments: [{ date: '2026-01-28', amount: 310, currency: 'CNY', serviceDate: '2026-02-01' }],
    readings: [
      { id: 'x', date: '2026-02-10', values: { km: 10 } },
      { id: 'y', date: '2026-02-20', values: { km: 10 } },
    ],
  } as Partial<Subscription>);
  assert.ok(spreadOf(early, '2026-02-25')!.price);
});

test('摊销单价：服务结束后才退的款归最后一期', () => {
  const s = sharedOwner({
    price: 200,
    cycle: { unit: 'month', every: 1 },
    status: 'cancelled',
    stop: { date: '2026-02-01', kind: 'cancel' },
    payments: [
      { date: '2026-01-01', amount: 200, currency: 'CNY' },
      { date: '2026-03-02', amount: -100, currency: 'CNY', kind: 'refund' },
    ],
    readings: [
      { id: 'x', date: '2026-01-10', values: { km: 100 } },
      { id: 'y', date: '2026-01-31', values: { km: 100 } },
    ],
  } as Partial<Subscription>);
  assert.ok(Math.abs(spreadOf(s, '2026-04-01')!.price!.amount - 0.5) < 1e-9);
});

test('关联累计读数：断档和开始前很久的读数不算用量，跨断档的差不进累计', () => {
  const owner = sharedOwner({
    meters: [{ id: 'km', name: 'Odometer', unit: 'km', kind: 'reading' }],
    readings: ['01', '02', '03', '04', '05', '06', '07', '08'].map((m, i) => ({ id: `o${m}`, date: `2026-${m}-15`, values: { km: 1000 * (i + 1) } })),
  });
  const plan = { price: 30, currency: 'CNY', cycle: { unit: 'month', every: 1 } };
  const gap = sharedLinker({
    start: '2026-01-01',
    phases: [
      { ...plan, start: '2026-01-01', end: '2026-03-31' },
      { ...plan, start: '2026-07-01' },
    ],
  } as Partial<Subscription>);
  const view = meterView(gap, [owner, gap]);
  const rows = meterRows(
    view,
    view.meters!.find((m) => m.id === 'lk')!,
    '2026-09-01',
  );
  // 6-15 是断档里紧挨的基数，不算用量；7、8 月各 1000
  assert.deepEqual(
    rows.map((r) => [r.reading.date, r.usage]),
    [
      ['2026-01-15', undefined],
      ['2026-02-15', 1000],
      ['2026-03-15', 1000],
      ['2026-06-15', undefined],
      ['2026-07-15', 1000],
      ['2026-08-15', 1000],
    ],
  );
  // 基数太远：以开始后首条为基数，不把几年的里程算到这个订阅上
  const old = sharedOwner({
    meters: owner.meters,
    readings: [
      { id: 'a', date: '2020-02-01', values: { km: 1000 } },
      { id: 'b', date: '2026-07-15', values: { km: 90000 } },
      { id: 'c', date: '2026-08-15', values: { km: 91000 } },
    ],
  });
  const late = sharedLinker({ start: '2026-07-01' });
  const lateView = meterView(late, [old, late]);
  const lateSum = meterSummary(
    lateView,
    lateView.meters!.find((m) => m.id === 'lk')!,
    '2026-09-01',
  );
  assert.equal(lateSum.total, 1000);
});

test('关联累计读数：断档里没有读数也不算跨断档的差；相邻、并行阶段算一段连续服务', () => {
  const plan = { price: 30, currency: 'CNY', cycle: { unit: 'month', every: 1 } };
  const usages = (values: Array<[string, number]>, phases: Array<Record<string, unknown>>) => {
    const owner = sharedOwner({
      meters: [{ id: 'km', name: 'Odometer', unit: 'km', kind: 'reading' }],
      readings: values.map(([date, km]) => ({ id: date, date, values: { km } })),
    });
    const s = sharedLinker({ start: String(phases[0].start), phases: phases.map((p) => ({ ...plan, ...p })) } as Partial<Subscription>);
    const view = meterView(s, [owner, s]);
    return meterRows(
      view,
      view.meters!.find((m) => m.id === 'lk')!,
      '2026-12-01',
    ).map((r) => r.usage);
  };
  // 空档 3-02 ~ 6-30 里没有读数：7-15 只作新基数
  assert.deepEqual(
    usages(
      [
        ['2026-01-15', 1000],
        ['2026-02-15', 1100],
        ['2026-07-15', 5000],
        ['2026-08-15', 5100],
      ],
      [
        { start: '2026-01-01', end: '2026-03-01' },
        { start: '2026-07-01', end: '2026-09-30' },
      ],
    ),
    [undefined, 100, undefined, 100],
  );
  // 前后相接的两个阶段不算断档
  assert.deepEqual(
    usages(
      [
        ['2026-01-15', 100],
        ['2026-02-15', 200],
      ],
      [
        { start: '2026-01-01', end: '2026-01-31' },
        { start: '2026-02-01', end: '2026-03-31' },
      ],
    ),
    [undefined, 100],
  );
  // 并行阶段：基数距离从整段服务的开始算，19 天内不丢用量
  assert.deepEqual(
    usages(
      [
        ['2026-02-10', 100],
        ['2026-03-25', 500],
        ['2026-04-25', 800],
      ],
      [
        { start: '2026-03-01', end: '2026-06-30' },
        { start: '2026-03-20', end: '2026-05-31' },
      ],
    ),
    [undefined, 400, 300],
  );
});

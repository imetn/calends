import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chargeDay, chargeServicePeriod, chargesBetween, FALLBACK_FX, subError } from './billing.ts';
import { maskForPublic } from './mask.ts';
import {
  costBetween,
  meterError,
  meterRows,
  meterStats,
  meterSuggestions,
  meterSummary,
  periodReading,
  periodReadingCount,
  removeMeter,
  replaceMeters,
  setPeriodValues,
  stableId,
  usageWithin,
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

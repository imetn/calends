// 升级抵扣：旧套餐剩余抵扣新套餐首期（重新起算周期），或保持原扣款日只补差价
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargesBetween, nextCharge, subError } from './billing.ts';
import { switchPlan, upgradePlan, upgradeQuote } from './phases.ts';
import type { Subscription } from './types.ts';

const base = (o: Partial<Subscription> = {}): Subscription => ({
  id: 'x',
  name: 'X',
  category: '工具',
  tags: [],
  price: 30,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-11-01',
  status: 'active',
  ...o,
});
const MAX = { price: 100, currency: 'USD', cycle: { unit: 'month' as const, every: 1 } };
const list = (s: Subscription, from: string, to: string, today: string) =>
  chargesBetween(s, from, to, today).map((c) => [c.date, c.amount, c.kind ?? ''] as const);

test('用了 1 天就升级：抵扣剩余 29 天，首期付 71，周期从升级日重算', () => {
  const s = base();
  const q = upgradeQuote(s, '2026-11-02', MAX, '2026-11-02')!;
  assert.deepEqual([q.paid, q.days, q.unusedDays, q.credit, q.reset], [30, 30, 29, 29, 71]);
  assert.deepEqual(q.keep, { amount: 67.67, nextCharge: '2026-12-01', anchor: '2026-11-01' });
  const after = upgradePlan(s, '2026-11-02', MAX, '2026-11-02', 'reset');
  assert.equal(subError(after), undefined);
  assert.deepEqual(list(after, '2026-11-01', '2027-01-31', '2026-11-02'), [
    ['2026-11-01', 30, ''],
    ['2026-11-02', 71, ''],
    ['2026-12-02', 100, ''],
    ['2027-01-02', 100, ''],
  ]);
  assert.equal(nextCharge(after, '2026-11-03'), '2026-12-02');
});

test('保持原扣款日：今天按剩余天数补差，下次仍在原日期按新价扣', () => {
  const after = upgradePlan(base(), '2026-11-02', MAX, '2026-11-02', 'keep');
  assert.equal(subError(after), undefined);
  assert.deepEqual(list(after, '2026-11-01', '2027-01-31', '2026-11-02'), [
    ['2026-11-01', 30, ''],
    ['2026-11-02', 67.67, 'adjust'],
    ['2026-12-01', 100, ''],
    ['2027-01-01', 100, ''],
  ]);
  assert.equal(nextCharge(after, '2026-11-03'), '2026-12-01');
});

test('实付金额可改；补差为 0 时不记补差，也不在生效日多扣一期', () => {
  const paid = upgradePlan(base(), '2026-11-02', MAX, '2026-11-02', 'reset', 70);
  assert.equal(list(paid, '2026-11-02', '2026-11-02', '2026-11-02')[0][1], 70);
  const same = upgradePlan(base(), '2026-11-20', { ...MAX, price: 30 }, '2026-11-20', 'keep');
  assert.deepEqual(list(same, '2026-11-01', '2026-12-31', '2026-11-20'), [
    ['2026-11-01', 30, ''],
    ['2026-12-01', 30, ''],
  ]);
});

test('月底锚点：保持原扣款日时沿用 31 日的日号', () => {
  const s = base({ start: '2026-01-31' });
  const after = upgradePlan(s, '2026-03-05', MAX, '2026-03-05', 'keep');
  assert.deepEqual(
    chargesBetween(after, '2026-03-06', '2026-05-31', '2026-03-05')
      .filter((c) => !c.kind)
      .map((c) => c.date),
    ['2026-03-31', '2026-04-30', '2026-05-31'],
  );
});

test('扣款日漂移过：锚点改用实际的下次扣款日', () => {
  const s = base({ payments: [{ date: '2026-11-05', amount: 30 }] });
  const q = upgradeQuote(s, '2026-11-10', MAX, '2026-11-10')!;
  assert.equal(q.keep?.nextCharge, '2026-12-05');
  const after = upgradePlan(s, '2026-11-10', MAX, '2026-11-10', 'keep');
  assert.deepEqual(
    chargesBetween(after, '2026-11-11', '2027-01-31', '2026-11-10')
      .filter((c) => !c.kind)
      .map((c) => c.date),
    ['2026-12-05', '2027-01-05'],
  );
});

test('换周期只能重算；零小数货币按整数取', () => {
  const yearly = upgradeQuote(base(), '2026-11-02', { ...MAX, price: 1000, cycle: { unit: 'year', every: 1 } }, '2026-11-02')!;
  assert.equal(yearly.keep, undefined);
  assert.equal(yearly.reset, 971);
  assert.throws(() => upgradePlan(base(), '2026-11-02', { ...MAX, cycle: { unit: 'year', every: 1 } }, '2026-11-02', 'keep'));
  const jpy = upgradeQuote(base({ price: 1000, currency: 'JPY' }), '2026-11-11', { ...MAX, price: 3000, currency: 'JPY' }, '2026-11-11')!;
  assert.deepEqual([jpy.credit, jpy.reset, jpy.keep?.amount], [667, 2333, 1333]);
});

test('不能抵扣的切换：未来生效、换币种、后付费、续费当天、计划中', () => {
  const s = base();
  assert.equal(upgradeQuote(s, '2026-11-10', MAX, '2026-11-05'), undefined);
  assert.equal(upgradeQuote(s, '2026-11-02', { ...MAX, currency: 'EUR' }, '2026-11-02'), undefined);
  assert.equal(upgradeQuote(base({ billing: 'postpaid' }), '2026-11-02', MAX, '2026-11-02'), undefined);
  assert.equal(upgradeQuote(s, '2026-11-02', { ...MAX, billing: 'postpaid' }, '2026-11-02'), undefined);
  assert.equal(upgradeQuote(s, '2026-12-01', MAX, '2026-12-01'), undefined);
  assert.throws(() => upgradePlan(s, '2026-11-02', { ...MAX, planned: true }, '2026-11-02', 'reset'));
  // 不选抵扣时照旧：新套餐从生效日起按全价
  assert.deepEqual(list(switchPlan(s, '2026-11-02', MAX), '2026-11-02', '2026-11-02', '2026-11-02'), [['2026-11-02', 100, '']]);
});

test('审查回归：旧套餐有续费规则时只给重算，不给保持原扣款日', () => {
  for (const rule of [{ chargeLeadDays: 3 }, { renewalOffsetDays: 2 }]) {
    const q = upgradeQuote(base(rule), '2026-11-10', MAX, '2026-11-10');
    assert.ok(q && q.credit > 0 && q.keep === undefined, JSON.stringify(rule));
  }
});

test('审查回归：普通全价切换后的首期内可以升级；与升级无关的补差只算一次', () => {
  const switched = switchPlan(base({ start: '2026-01-01' }), '2026-11-01', { ...MAX, price: 50 });
  const q = upgradeQuote(switched, '2026-11-10', MAX, '2026-11-10')!;
  assert.equal(q.paid, 50);
  assert.equal(q.credit, 35);
  const adjusted = upgradeQuote(
    base({
      payments: [
        { date: '2026-11-01', amount: 30 },
        { date: '2026-11-05', amount: 5, kind: 'adjust' },
      ],
    }),
    '2026-11-10',
    MAX,
    '2026-11-10',
  )!;
  assert.equal(adjusted.paid, 35);
  assert.equal(adjusted.credit, 24.5);
});

test('审查回归：当期退款计入、生效日后已有续费、排定停用、当期已是升级、赠送期都不重复抵扣', () => {
  const refunded = upgradeQuote(
    base({
      payments: [
        { date: '2026-11-01', amount: 30 },
        { date: '2026-11-03', amount: -20, kind: 'refund' },
      ],
    }),
    '2026-11-10',
    MAX,
    '2026-11-10',
  )!;
  assert.equal(refunded.paid, 10);
  assert.equal(refunded.credit, 7);
  const renewed = base({
    start: '2026-10-01',
    payments: [
      { date: '2026-10-01', amount: 30 },
      { date: '2026-11-01', amount: 30 },
    ],
  });
  assert.equal(upgradeQuote(renewed, '2026-10-20', MAX, '2026-11-05'), undefined);
  const early = base({
    payments: [
      { date: '2026-11-01', amount: 30 },
      { date: '2026-11-28', amount: 30, serviceDate: '2026-12-01' },
    ],
  });
  assert.equal(upgradeQuote(early, '2026-11-30', MAX, '2026-11-30'), undefined);
  assert.equal(upgradeQuote(base({ stop: { date: '2026-11-20', kind: 'cancel' } } as Partial<Subscription>), '2026-11-10', MAX, '2026-11-10'), undefined);
  for (const mode of ['reset', 'keep'] as const) {
    const once = upgradePlan(base(), '2026-11-02', MAX, '2026-11-02', mode);
    assert.equal(upgradeQuote(once, '2026-11-17', { ...MAX, price: 200 }, '2026-11-17'), undefined, mode);
  }
  assert.equal(upgradeQuote(base({ bonus: { from: '2026-12-01', until: '2027-01-01' } }), '2026-11-10', MAX, '2026-11-10'), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALLBACK_FX, billingPeriod, cashChargesBetween, chargesBetween, overdueBills, settleBills, subError } from './billing.ts';
import { cashVsAccrual } from './metrics.ts';
import { deletePayment, savePayment } from './phases.ts';
import { DEFAULT_SETTINGS, type Payment, type Subscription } from './types.ts';

// 虚构的物业费：每月 1 日出账单，2026-01 起降价；记账从 2025-06 开始，之前的视为已缴
const fee = (payments: Payment[] = [], extra: Partial<Subscription> = {}): Subscription => ({
  id: 'fee',
  name: 'Fictional property fee',
  category: 'Home',
  tags: [],
  price: 400,
  currency: 'CNY',
  cycle: { unit: 'month', every: 1 },
  start: '2025-01-01',
  billingStart: '2025-06-01',
  priceHistory: [
    { from: '2025-01-01', amount: 500 },
    { from: '2026-01-01', amount: 400 },
  ],
  status: 'active',
  settlement: 'separate',
  payments,
  ...extra,
});
const TODAY = '2026-02-15';
const sum = (cs: { amount: number }[]) => Math.round(cs.reduce((a, c) => a + c.amount, 0) * 100) / 100;

test('合并缴：一笔结清多期，按账单日各记一份，缴费日记在 paidOn', () => {
  const s = fee([{ date: '2025-07-26', amount: 1500, periods: ['2025-06-01', '2025-07-01', '2025-08-01'] }]);
  const cs = chargesBetween(s, '2025-06-01', '2025-08-31', TODAY);
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount, c.paidOn, c.projected]),
    [
      ['2025-06-01', 500, '2025-07-26', false],
      ['2025-07-01', 500, '2025-07-26', false],
      ['2025-08-01', 500, '2025-07-26', false],
    ],
  );
  // 现金口径只有一笔，记在缴费日
  assert.deepEqual(
    cashChargesBetween(s, '2025-06-01', '2025-08-31', TODAY).map((c) => [c.date, c.amount]),
    [['2025-07-26', 1500]],
  );
});

test('拆开缴与部分缴：一期收到多笔，未缴满的显示部分已缴', () => {
  const s = fee([
    { date: '2025-06-03', amount: 200, periods: ['2025-06-01'] },
    { date: '2025-06-20', amount: 300, periods: ['2025-06-01'] },
    { date: '2025-07-05', amount: 120, periods: ['2025-07-01'] },
  ]);
  const { bills } = settleBills(s, TODAY);
  const june = bills.find((b) => b.date === '2025-06-01')!;
  const july = bills.find((b) => b.date === '2025-07-01')!;
  assert.equal(june.status, 'paid');
  assert.deepEqual(
    june.pieces.map((p) => p.amount),
    [200, 300],
  );
  assert.equal(july.status, 'partial');
  assert.equal(july.paid, 120);
  // 部分缴的余额已过账单日：不算扣款，算欠缴
  const owed = overdueBills(s, TODAY);
  assert.equal(owed[0].date, '2025-07-01');
  assert.equal(owed[0].amount, 380);
  assert.equal(owed[0].unpaid, 'overdue');
  assert.equal(owed[0].projected, true);
});

test('逾期后缴：成本归账单所属年份，现金记在缴费日（跨年合并缴）', () => {
  const s = fee([{ date: '2026-02-10', amount: 3700, periods: ['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'] }], {
    billingStart: '2025-10-01',
  });
  const y2025 = chargesBetween(s, '2025-01-01', '2025-12-31', TODAY).filter((c) => c.paidOn);
  const y2026 = chargesBetween(s, '2026-01-01', '2026-12-31', TODAY).filter((c) => c.paidOn);
  assert.equal(sum(y2025), 1500);
  // 剩下 1400 按最早未缴依次抵扣：已经没有过去的欠缴，抵到 2026-03 起的未来账单，也归 2026
  const prepaid = chargesBetween(s, '2026-03-01', '2026-12-31', TODAY).filter((c) => c.paidOn);
  assert.equal(sum(prepaid), 1400);
  assert.equal(sum(y2026), 2200);
  const cash = cashVsAccrual({ subscriptions: [s], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' }, fx: FALLBACK_FX }, TODAY, 6, 0);
  assert.equal(cash.find((r) => r.month === '2026-02')!.cash, 3700);
  assert.equal(cash.find((r) => r.month === '2025-10')!.cash, 0);
  assert.equal(Math.round(cash.find((r) => r.month === '2025-10')!.accrual), 500);
});

test('提前缴：预缴的未来账单不再预测扣款，之后的照常', () => {
  const s = fee([{ date: '2026-02-10', amount: 1200, periods: ['2026-02-01', '2026-03-01', '2026-04-01'] }], { billingStart: '2026-02-01' });
  const { bills } = settleBills(s, TODAY);
  assert.deepEqual(
    bills.filter((b) => b.date >= '2026-02-01' && b.date <= '2026-05-01').map((b) => [b.date, b.status]),
    [
      ['2026-02-01', 'paid'],
      ['2026-03-01', 'prepaid'],
      ['2026-04-01', 'prepaid'],
      ['2026-05-01', 'due'],
    ],
  );
  const future = chargesBetween(s, '2026-02-16', '2026-05-31', TODAY);
  assert.deepEqual(
    future.map((c) => [c.date, c.projected, c.unpaid ?? null]),
    [
      ['2026-03-01', false, null],
      ['2026-04-01', false, null],
      ['2026-05-01', true, 'due'],
    ],
  );
});

test('没写 periods 的缴费从最早未缴的账单开始抵扣，删掉后释放', () => {
  let s = fee([], { billingStart: '2025-12-01' });
  s = savePayment(s, TODAY, { date: '2026-02-10', amount: 900 });
  assert.deepEqual(
    settleBills(s, TODAY)
      .bills.filter((b) => b.date >= '2025-12-01' && b.date <= '2026-02-01')
      .map((b) => [b.date, b.status, b.paid]),
    [
      ['2025-12-01', 'paid', 500],
      ['2026-01-01', 'paid', 400],
      ['2026-02-01', 'overdue', 0],
    ],
  );
  assert.equal(s.nextDue, undefined);
  s = deletePayment(s, TODAY, '2026-02-10', 0);
  assert.equal(overdueBills(s, TODAY).length, 3);
});

test('billingStart 之前的账单视为已缴（推算），之后没缴的是欠缴；本期只看账单周期', () => {
  const s = fee([{ date: '2025-06-05', amount: 500, periods: ['2025-06-01'] }]);
  const past = chargesBetween(s, '2025-01-01', '2025-05-31', TODAY);
  assert.equal(past.length, 5);
  assert.ok(past.every((c) => !c.projected && !c.paidOn));
  assert.equal(overdueBills(s, TODAY).length, 8);
  assert.equal(overdueBills(s, TODAY)[0].date, '2025-07-01');
  assert.equal(billingPeriod(s, TODAY).from, '2026-02-01');
});

test('调价跨分配：每期按各自价格应缴，比例分配不越过应缴', () => {
  const s = fee([{ date: '2026-01-20', amount: 900, periods: ['2025-12-01', '2026-01-01'] }], { billingStart: '2025-12-01' });
  const cs = chargesBetween(s, '2025-12-01', '2026-01-31', TODAY);
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount]),
    [
      ['2025-12-01', 500],
      ['2026-01-01', 400],
    ],
  );
});

test('不完整的指定：多出来的钱继续抵扣最早未缴，校验拒绝错误的 periods', () => {
  const s = fee([{ date: '2026-02-10', amount: 700, periods: ['2026-01-01'] }], { billingStart: '2025-12-01' });
  const { bills } = settleBills(s, TODAY);
  assert.equal(bills.find((b) => b.date === '2026-01-01')!.paid, 400);
  assert.equal(bills.find((b) => b.date === '2025-12-01')!.paid, 300);
  assert.ok(subError(fee([{ date: '2026-02-10', amount: 1, periods: ['bad'] }])));
  assert.ok(subError(fee([{ date: '2026-02-10', amount: -1, kind: 'refund', periods: ['2026-01-01'] }])));
  assert.ok(subError({ ...fee(), settlement: 'other' as 'separate' }));
});

test('非分开记的订阅行为不变', () => {
  const s = fee([{ date: '2025-07-26', amount: 1500, periods: ['2025-06-01'] }], { settlement: undefined });
  assert.deepEqual(
    chargesBetween(s, '2025-07-01', '2025-07-31', TODAY).map((c) => [c.date, c.amount, c.paidOn ?? null]),
    [['2025-07-26', 1500, null]],
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FALLBACK_FX,
  billingPeriod,
  cashChargesBetween,
  chargesBetween,
  overdueBills,
  settleBills,
  subError,
  trackingStart,
  todayIn,
  addMonths,
} from './billing.ts';
import { cashVsAccrual, prepaidValue } from './metrics.ts';
import { yearOutlook } from './scope-report.ts';
import { netCost } from './transfers.ts';
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
  settledBefore: '2025-06-01',
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
    settledBefore: '2025-10-01',
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
  const s = fee([{ date: '2026-02-10', amount: 1200, periods: ['2026-02-01', '2026-03-01', '2026-04-01'] }], { settledBefore: '2026-02-01' });
  const { bills } = settleBills(s, TODAY, '2026-05-31');
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
  let s = fee([], { settledBefore: '2025-12-01' });
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

test('settledBefore 之前的账单视为已缴（推算），之后没缴的是欠缴；本期只看账单周期', () => {
  const s = fee([{ date: '2025-06-05', amount: 500, periods: ['2025-06-01'] }]);
  const past = chargesBetween(s, '2025-01-01', '2025-05-31', TODAY);
  assert.equal(past.length, 5);
  assert.ok(past.every((c) => !c.projected && !c.paidOn));
  assert.equal(overdueBills(s, TODAY).length, 8);
  assert.equal(overdueBills(s, TODAY)[0].date, '2025-07-01');
  assert.equal(billingPeriod(s, TODAY).from, '2026-02-01');
});

test('调价跨分配：每期按各自价格应缴，比例分配不越过应缴', () => {
  const s = fee([{ date: '2026-01-20', amount: 900, periods: ['2025-12-01', '2026-01-01'] }], { settledBefore: '2025-12-01' });
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
  const s = fee([{ date: '2026-02-10', amount: 700, periods: ['2026-01-01'] }], { settledBefore: '2025-12-01' });
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

// ---------- 审查回归（H1–H3、M1–M3、L1、L2、L4、L6） ----------

test('H1 分配与查询窗口无关：指定远期账单的钱不会挪到别的账单', () => {
  const s = fee(
    [
      { date: '2025-10-02', amount: 500 },
      { date: '2026-02-10', amount: 400, periods: ['2027-06-01'] },
    ],
    { settledBefore: '2025-10-01' },
  );
  const paid = (until?: string) =>
    settleBills(s, TODAY, until)
      .bills.filter((b) => b.pieces.length)
      .map((b) => [b.date, b.paid]);
  assert.deepEqual(paid(), [
    ['2025-10-01', 500],
    ['2027-06-01', 400],
  ]);
  assert.deepEqual(paid('2027-12-31'), paid());
  assert.deepEqual(
    overdueBills(s, TODAY).map((c) => c.date),
    ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'],
  );
});

test('H2 逾期账单出现在权责口径里，按待缴（预测）记，不算已付', () => {
  const s = fee([{ date: '2025-10-02', amount: 500 }], { settledBefore: '2025-10-01' });
  const cs = chargesBetween(s, '2025-12-01', '2026-03-31', TODAY);
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount, c.projected, c.unpaid ?? null]),
    [
      ['2025-12-01', 500, true, 'overdue'],
      ['2026-01-01', 400, true, 'overdue'],
      ['2026-02-01', 400, true, 'overdue'],
      ['2026-03-01', 400, true, 'due'],
    ],
  );
  // 与 overdueBills 一致
  assert.deepEqual(
    cs.filter((c) => c.unpaid === 'overdue').map((c) => c.date),
    overdueBills(s, '2026-02-15')
      .filter((c) => c.date >= '2025-12-01')
      .map((c) => c.date),
  );
});

test('H3 追踪起点之前的缴费只抵推算期，不重复计入，也不挪到之后的账单', () => {
  const s = fee([{ date: '2025-09-01', amount: 500 }], { settledBefore: '2025-10-01' });
  assert.deepEqual(
    cashChargesBetween(s, '2025-08-01', '2025-10-31', TODAY).map((c) => [c.date, c.amount]),
    [['2025-09-01', 500]],
  );
  const sep = chargesBetween(s, '2025-09-01', '2025-09-30', TODAY);
  assert.deepEqual(
    sep.map((c) => [c.date, c.amount, c.paidOn ?? null]),
    [['2025-09-01', 500, '2025-09-01']],
  );
  const oct = settleBills(s, TODAY).bills.find((b) => b.date === '2025-10-01')!;
  assert.equal(oct.paid, 0);
  assert.equal(oct.status, 'overdue');
});

test('M1 多阶段：缴费记在指定账单所在的段，不带 phase 也能删改', () => {
  const s: Subscription = {
    ...fee([], { settledBefore: '2025-10-01', priceHistory: undefined, price: 300 }),
    phases: [
      { start: '2025-01-01', price: 300, currency: 'CNY', cycle: { unit: 'month', every: 1 } },
      { start: '2026-01-01', price: 400, currency: 'CNY', cycle: { unit: 'month', every: 1 } },
    ],
  };
  const a = savePayment(s, TODAY, { date: '2026-02-10', amount: 900, periods: ['2025-10-01', '2025-11-01', '2025-12-01'] });
  assert.equal(a.phases![0].payments?.length, 1);
  const b = savePayment(a, TODAY, { date: '2026-02-10', amount: 600 }, { date: '2026-02-10', index: 0 });
  assert.equal(b.phases!.flatMap((p) => p.payments ?? []).length, 1);
  const c = deletePayment(b, TODAY, '2026-02-10', 0);
  assert.equal(c.phases!.flatMap((p) => p.payments ?? []).length, 0);
});

test('M2 现金口径只有真实缴费：没有推算期，也没有今天未缴的账单', () => {
  const s = fee([{ date: '2026-01-03', amount: 400 }], { settledBefore: '2026-01-01' });
  const today = '2026-02-01';
  assert.deepEqual(
    cashChargesBetween(s, s.start, today, today).map((c) => [c.date, c.amount]),
    [['2026-01-03', 400]],
  );
});

test('M3 追踪起点另存，不改账单锚点；缺省是第一笔缴费对应的那期', () => {
  const s: Subscription = {
    ...fee([{ date: '2025-03-05', amount: 100 }], { priceHistory: undefined }),
    price: 100,
    start: '2025-01-31',
    settledBefore: undefined,
  };
  assert.equal(trackingStart(s, '2025-03-10'), '2025-02-28');
  const { bills } = settleBills(s, '2025-03-10', '2025-07-31');
  assert.deepEqual(
    bills.map((b) => [b.date, b.status]),
    [
      ['2025-01-31', 'inferred'],
      ['2025-02-28', 'paid'],
      ['2025-03-31', 'due'],
      ['2025-04-30', 'due'],
      ['2025-05-31', 'due'],
      ['2025-06-30', 'due'],
      ['2025-07-31', 'due'],
    ],
  );
});

test('L1 L2 periods 校验：不存在的账单日、非分开记的订阅都拒绝；指定推算期按指定分配', () => {
  assert.ok(subError(fee([{ date: '2026-02-10', amount: 400, periods: ['2025-07-15'] }])));
  assert.ok(subError(fee([{ date: '2026-02-10', amount: 400, periods: ['2026-01-01'] }], { settlement: undefined })));
  assert.equal(subError(fee([{ date: '2026-02-10', amount: 400, periods: ['2026-01-01'] }])), undefined);
  const s = fee([{ date: '2026-02-01', amount: 500, periods: ['2025-05-01'] }]);
  const may = settleBills(s, TODAY).bills.find((b) => b.date === '2025-05-01')!;
  assert.equal(may.paid, 500);
  assert.equal(may.status, 'inferred');
});

test('L4 L6 一期多笔合成一条；卡上实扣与资金来源拆开后合计不变', () => {
  const s = fee([
    { date: '2025-06-03', amount: 200, periods: ['2025-06-01'] },
    { date: '2025-06-20', amount: 300, periods: ['2025-06-01'] },
  ]);
  assert.deepEqual(
    chargesBetween(s, '2025-06-01', '2025-06-30', TODAY).map((c) => [c.date, c.amount, c.paidOn]),
    [['2025-06-01', 500, '2025-06-20']],
  );
  const t = fee(
    [
      {
        date: '2025-07-01',
        amount: 1000,
        periods: ['2025-07-01', '2025-08-01'],
        settled: { amount: 33.33, currency: 'USD' },
        funding: [
          { methodId: 'a', amount: 333.33 },
          { methodId: 'b', amount: 666.67 },
        ],
      },
    ],
    { price: 500, priceHistory: undefined },
  );
  // 三期各 333.33：缴 1000 指定前两期，剩下的抵第三期
  const cs = chargesBetween(t, '2025-07-01', '2025-09-30', TODAY).filter((c) => c.paidOn);
  assert.equal(sum(cs.map((c) => c.settled!)), 33.33);
  assert.equal(sum(cs.flatMap((c) => c.funding ?? [])), 1000);
});

test('L4 H2 日历订阅：一期一个事件，逾期账单不再提醒', async () => {
  const { buildIcs } = await import('../worker/ics.ts');
  const today = todayIn('UTC');
  const month = `${today.slice(0, 7)}-01`;
  const tracked = addMonths(month, -2);
  const s: Subscription = {
    ...fee([{ date: tracked, amount: 50, periods: [tracked] }], { priceHistory: undefined, settledBefore: tracked }),
    price: 100,
    start: addMonths(month, -6),
  };
  const ics = buildIcs(
    { fx: FALLBACK_FX, settings: { ...DEFAULT_SETTINGS, timezone: 'UTC', remindDays: 1 }, subscriptions: [s], methods: [] },
    'https://calends.test',
  );
  const events = ics.split('BEGIN:VEVENT').slice(1);
  const day = (d: string) => events.filter((e) => e.includes(`DTSTART;VALUE=DATE:${d.replace(/-/g, '')}`));
  assert.equal(day(tracked).length, 1);
  assert.ok(!day(tracked)[0].includes('VALARM'));
  assert.ok(!day(addMonths(month, -1))[0].includes('VALARM'));
  assert.ok(day(addMonths(month, 1))[0].includes('VALARM'));
});

const ledger = (s: Subscription) => ({ subscriptions: [s], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' }, fx: FALLBACK_FX });
const flat = { start: '2025-10-01', settledBefore: '2025-10-01', priceHistory: undefined };

test('UI-1 实际每月按账单：截至今天的各期应缴 ÷ 到本期结束的月数，预缴的未来账单不摊进来；累计仍按实付', () => {
  const s = fee(
    [
      { date: '2025-10-01', amount: 2000 },
      { date: '2026-02-10', amount: 1200 },
    ],
    flat,
  );
  const c = netCost(ledger(s), s, TODAY, 'CNY');
  assert.equal(c.net, 3200);
  assert.ok(Math.abs(c.perMonth - 400) < 6, String(c.perMonth));
  assert.equal(c.spread.value, 2000);
  // 欠着的那期照样算进每月：缴没缴不改变每月花多少
  const owe = fee([{ date: '2025-10-01', amount: 1600 }], flat);
  assert.ok(Math.abs(netCost(ledger(owe), owe, TODAY, 'CNY').perMonth - 400) < 6);
});

test('UI-4 年度报告：逾期没缴的账单不算已扣款，算待扣款，并落在今天所在月；现金柱同一口径', () => {
  const s = fee([{ date: '2026-01-03', amount: 400 }], { start: '2026-01-01', settledBefore: '2026-01-01', priceHistory: undefined });
  const r = yearOutlook(ledger(s), TODAY);
  assert.equal(r.current.paid, 400);
  assert.equal(r.current.pending, 400 + 10 * 400);
  assert.equal(r.months[0].total, 400);
  assert.equal(r.months[1].total, 400);
  assert.equal(r.months[1].pending, 400);
  const cash = cashVsAccrual(ledger(s), TODAY, 1, 0);
  assert.deepEqual(
    cash.map((m) => [m.month, m.cash]),
    [
      ['2026-01', 400],
      ['2026-02', 400],
    ],
  );
  // 预缴的未来账单按缴费日记已扣款，不再出现在待扣款里
  const ahead = fee([{ date: '2026-01-03', amount: 1200 }], { start: '2026-01-01', settledBefore: '2026-01-01', priceHistory: undefined });
  const a = yearOutlook(ledger(ahead), TODAY);
  assert.equal(a.current.paid, 1200);
  assert.equal(a.current.pending, 9 * 400);
});

test('UI-5 预付余值：预缴的未来账单整期计入，没缴的账单不算', () => {
  const s = fee(
    [
      { date: '2025-10-01', amount: 2000 },
      { date: '2026-02-10', amount: 1200 },
    ],
    flat,
  );
  const pv = prepaidValue(ledger(s), TODAY);
  assert.equal(Math.round(pv.total), 1200 + 200);
  assert.equal(pv.items[0].until, '2026-06-01');
  const owe = fee([{ date: '2025-10-01', amount: 1600 }], flat);
  assert.deepEqual(prepaidValue(ledger(owe), TODAY).items, []);
});

test('UI-8 追踪起点之前的推算期不是真实缴费：扣款记录（现金）不列，报告现金头部与现金柱都不算', () => {
  const s = fee([{ date: '2025-06-03', amount: 500 }]);
  assert.deepEqual(
    cashChargesBetween(s, s.start, TODAY, TODAY)
      .filter((c) => c.date <= TODAY)
      .map((c) => [c.date, c.amount]),
    [['2025-06-03', 500]],
  );
  const r = yearOutlook(ledger(s), TODAY, 2025);
  assert.deepEqual(
    r.months.slice(0, 6).map((m) => m.total),
    [0, 0, 0, 0, 0, 500],
  );
  const cash = cashVsAccrual(ledger(s), TODAY, 13, 0).filter((m) => m.month < '2025-07');
  assert.deepEqual(
    cash.map((m) => m.cash),
    [0, 0, 0, 0, 0, 500],
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billingPeriod,
  chargeServicePeriod,
  chargesBetween,
  newShapeError,
  nextCharge,
  nonrenewalDate,
  renewalDates,
  stopSummary,
  subError,
} from './billing.ts';
import { maskForPublic } from './mask.ts';
import { stopSubscription, switchPlan, toEditForm } from './phases.ts';
import { stopForm, stopPreview } from './stop-form.ts';
import { DEFAULT_SETTINGS, type Subscription } from './types.ts';

const base = (o: Partial<Subscription> = {}): Subscription => ({
  id: 'p',
  name: 'Usage',
  category: '工具',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-10',
  status: 'active',
  billing: 'postpaid',
  ...o,
});
const dates = (s: Subscription, from = '2026-01-01', to = '2026-08-31', today = '2026-06-01') => chargesBetween(s, from, to, today).map((c) => c.date);

test('后付费：开始日不扣款，首张账单在一个周期之后', () => {
  const s = base();
  assert.deepEqual(dates(s, '2026-01-01', '2026-04-30'), ['2026-02-10', '2026-03-10', '2026-04-10']);
  assert.equal(nextCharge(s, '2026-01-10'), '2026-02-10');
  // 季付同理：首张账单在开始后三个月
  assert.deepEqual(dates(base({ cycle: { unit: 'month', every: 3 } }), '2026-01-01', '2026-12-31'), ['2026-04-10', '2026-07-10', '2026-10-10']);
});

test('后付费：serviceDate 是上一边界，服务期为 [上一边界, 本边界)', () => {
  const s = base();
  const charges = chargesBetween(s, '2026-01-01', '2026-04-30', '2026-06-01');
  assert.deepEqual(
    charges.map((c) => c.serviceDate),
    ['2026-01-10', '2026-02-10', '2026-03-10'],
  );
  assert.deepEqual(chargeServicePeriod(s, '2026-03-10'), { from: '2026-02-10', until: '2026-03-10' });
  assert.deepEqual(chargeServicePeriod(s, '2026-02-10'), { from: '2026-01-10', until: '2026-02-10' });
  // 金额按所用那一期：首期优惠覆盖到 03-10 之前开始的服务期
  const intro = base({ intro: { price: 5, until: '2026-03-10' } });
  assert.deepEqual(
    chargesBetween(intro, '2026-01-01', '2026-04-30', '2026-06-01').map((c) => c.amount),
    [5, 5, 10],
  );
});

test('后付费：实付记录之后接着预测，不重复出账单', () => {
  const s = base({
    payments: [
      { date: '2026-02-10', amount: 10 },
      { date: '2026-03-10', amount: 12 },
    ],
  });
  const charges = chargesBetween(s, '2026-01-01', '2026-05-31', '2026-03-20');
  assert.deepEqual(
    charges.map((c) => [c.date, c.amount, c.projected]),
    [
      ['2026-02-10', 10, false],
      ['2026-03-10', 12, false],
      ['2026-04-10', 10, true],
      ['2026-05-10', 10, true],
    ],
  );
  assert.equal(charges[2].serviceDate, '2026-03-10');
  assert.equal(nextCharge(s, '2026-03-20'), '2026-04-10');
});

test('后付费：结束日后仍出最后一张账单，之后不再有', () => {
  const s = base({ end: '2026-04-20', status: 'cancelled' });
  assert.deepEqual(dates(s), ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10']);
  assert.equal(nextCharge(s, '2026-04-25'), '2026-05-10');
  assert.equal(nextCharge(s, '2026-05-11'), undefined);
  // 结束日落在边界前一天：最后一张账单就在边界日
  assert.deepEqual(dates(base({ end: '2026-04-09' })), ['2026-02-10', '2026-03-10', '2026-04-10']);
  // 已退订但没写结束日：只出首期那一张
  assert.deepEqual(dates(base({ status: 'cancelled' })), ['2026-02-10']);
});

test('后付费：停止后出最后一张账单，账期不给已付、退款与浪费', () => {
  const s = base();
  const stopped = stopSubscription(s, '2026-04-20', 'cancel', '2026-04-20');
  assert.deepEqual(stopped.stop, { kind: 'cancel', date: '2026-04-20', paidThrough: '2026-04-20', reason: undefined });
  assert.equal(subError(stopped), undefined);
  assert.deepEqual(dates(stopped), ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10']);
  assert.equal(nextCharge(stopped, '2026-04-25'), '2026-05-10');
  assert.deepEqual(billingPeriod(s, '2026-04-20'), { from: '2026-04-10', paidThrough: '2026-04-20', paid: 0, days: 30 });
  const sm = stopSummary(stopped)!;
  assert.equal(sm.paid, 0);
  assert.equal(sm.unusedDays, 0);
  assert.equal(sm.wastedDays, 0);
  assert.equal(sm.suggestedRefund, 0);
  assert.equal(sm.refundStatus, 'none');
  // 未来日期也能停（没有预付期限制）
  const later = stopSubscription(s, '2026-04-01', 'terminate', '2026-04-20', 'quit');
  assert.equal(later.stop?.paidThrough, '2026-04-20');
  assert.equal(subError(later), undefined);
  // 停止日之后才记下的最后一张账单仍保留为实付
  const paid = { ...stopped, payments: [{ date: '2026-05-10', amount: 11 }] };
  assert.equal(subError(paid), undefined);
  assert.deepEqual(
    chargesBetween(paid, '2026-05-01', '2026-08-31', '2026-06-01').map((c) => [c.date, c.amount, c.projected]),
    [['2026-05-10', 11, false]],
  );
  // 停止表单：默认用到当期结束，预览不提示已付至或退款
  assert.equal(nonrenewalDate(s, '2026-04-15'), '2026-05-09');
  const form = stopForm(s, '2026-04-15');
  assert.equal(form.date, '2026-05-09');
  const preview = stopPreview(s, { ...form, mode: 'cancel' }, '2026-04-15');
  assert.equal(preview.period.paidThrough, '2026-05-09');
  assert.equal(preview.summary.suggestedRefund, 0);
});

test('后付费：暂停前开始的那一期照出账单，之后停止', () => {
  assert.deepEqual(dates(base({ status: 'paused', pausedAt: '2026-04-15' })), ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10']);
  assert.deepEqual(dates(base({ status: 'paused', pausedAt: '2026-04-10' })), ['2026-02-10', '2026-03-10', '2026-04-10']);
});

test('后付费：试用结束日起算，首张账单在其后一个周期', () => {
  const s = base({ status: 'trial', trialEnd: '2026-01-24' });
  const charges = chargesBetween(s, '2026-01-01', '2026-03-31', '2026-01-15');
  assert.deepEqual(
    charges.map((c) => [c.date, c.serviceDate]),
    [
      ['2026-02-24', '2026-01-24'],
      ['2026-03-24', '2026-02-24'],
    ],
  );
});

test('阶段之间切换先付费与后付费', () => {
  const prepaid = base({ billing: undefined });
  const toPost = switchPlan(prepaid, '2026-04-10', { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, billing: 'postpaid' });
  assert.equal(toPost.billing, 'postpaid');
  assert.equal(toPost.phases?.[0].billing, undefined);
  assert.equal(subError(toPost), undefined);
  assert.deepEqual(
    chargesBetween(toPost, '2026-01-01', '2026-06-30', '2026-06-01').map((c) => [c.date, c.amount]),
    [
      ['2026-01-10', 10],
      ['2026-02-10', 10],
      ['2026-03-10', 10],
      ['2026-05-10', 20],
      ['2026-06-10', 20],
    ],
  );
  // 后付费转先付费：旧阶段的最后一张账单与新阶段首购同日
  const toPre = switchPlan(base(), '2026-04-10', { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  assert.equal(toPre.billing, undefined);
  assert.equal(toPre.phases?.[0].billing, 'postpaid');
  assert.deepEqual(
    chargesBetween(toPre, '2026-01-01', '2026-05-31', '2026-06-01').map((c) => [c.date, c.amount]),
    [
      ['2026-02-10', 10],
      ['2026-03-10', 10],
      ['2026-04-10', 10],
      ['2026-04-10', 20],
      ['2026-05-10', 20],
    ],
  );
  assert.equal(toEditForm(toPre, '2026-02-01').billing, 'postpaid');
  assert.equal(toEditForm(toPre, '2026-05-01').billing, undefined);
});

test('先付费回归：缺省与原来完全一致，买断忽略后付费', () => {
  const pre = base({ billing: undefined });
  assert.deepEqual(dates(pre, '2026-01-01', '2026-04-30'), ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
  assert.deepEqual(billingPeriod(pre, '2026-04-20'), { from: '2026-04-10', paidThrough: '2026-05-09', paid: 10, days: 30 });
  assert.equal(renewalDates(pre, '2026-04-20').serviceExpires, '2026-05-10');
  assert.equal(nextCharge({ ...pre, end: '2026-04-20', stop: { kind: 'cancel', date: '2026-04-20', paidThrough: '2026-05-09' } }, '2026-04-25'), undefined);
  assert.deepEqual(dates({ ...pre, status: 'paused', pausedAt: '2026-04-15' }), ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
  const lifetime = { cycle: { unit: 'lifetime' as const, every: 1 } };
  assert.deepEqual(dates(base(lifetime)), dates(base({ ...lifetime, billing: undefined })));
  assert.deepEqual(dates(base(lifetime)), ['2026-01-10']);
  // 后付费没有「服务到期」
  assert.deepEqual(renewalDates(base(), '2026-04-20'), { nextCharge: '2026-05-10' });
});

test('后付费：退款以最近一张账单为上限', () => {
  const ok = base({
    payments: [
      { date: '2026-03-10', amount: 10 },
      { date: '2026-03-15', amount: -6, kind: 'refund' },
    ],
  });
  assert.equal(subError(ok), undefined);
  const over = base({
    payments: [
      { date: '2026-03-10', amount: 10 },
      { date: '2026-03-15', amount: -11, kind: 'refund' },
    ],
  });
  assert.ok(subError(over));
});

test('billing 字段校验与公开页保留', () => {
  const bad = { ...base(), billing: 'prepaid' } as unknown as Subscription;
  assert.ok(subError(bad));
  assert.ok(newShapeError(undefined, bad));
  assert.equal(newShapeError(undefined, base()), undefined);
  const badPhase = {
    ...base({ billing: undefined }),
    phases: [{ start: '2026-01-10', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, billing: 'later' }],
  } as unknown as Subscription;
  assert.ok(newShapeError(undefined, badPhase));
  const sub = switchPlan(base({ billing: undefined }), '2026-04-10', { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, billing: 'postpaid' });
  const pub = maskForPublic({ subscriptions: [sub], methods: [], settings: DEFAULT_SETTINGS, fx: { base: 'USD', rates: { USD: 1 }, fetchedAt: '' } });
  assert.equal(pub.subscriptions[0].billing, 'postpaid');
  assert.equal(pub.subscriptions[0].phases?.[1].billing, 'postpaid');
});

test('后付费：期中换方案，旧方案最后一张只收用到的天数，不与新方案重叠', () => {
  const sub = switchPlan(base(), '2026-04-25', { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, billing: 'postpaid' });
  const got = chargesBetween(sub, '2026-04-01', '2026-06-30', '2026-06-01').map((c) => [c.date, c.amount]);
  // 旧方案 [4-10, 4-25) 用了 15 天 / 30 天；新方案从 4-25 起按月出账
  assert.deepEqual(got, [
    ['2026-04-10', 10],
    ['2026-05-10', 5],
    ['2026-05-25', 20],
    ['2026-06-25', 20],
  ]);
});

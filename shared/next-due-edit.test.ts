// 用户反馈：下次扣款日在改提前扣款天数、周期、日期后不跟着变；开始日前付的首购让提前续费失效；编辑器可手动改下次扣款日
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargesBetween, nextCharge, preserveRenewalHistory, reconcileRenewalRules } from './billing.ts';
import { savePayment, switchPlan, syncPhase, toEditForm } from './phases.ts';
import type { Subscription } from './types.ts';

const base = (extra: Partial<Subscription> = {}): Subscription => ({
  id: 'fictional',
  name: 'Fictional server',
  category: 'Tools',
  tags: [],
  start: '2025-11-27',
  price: 60,
  currency: 'USD',
  cycle: { unit: 'year', every: 1 },
  status: 'active',
  ...extra,
});

/** 与编辑器保存同一条路径，再经服务端整条写入的规则合并 */
const edit = (s: Subscription, patch: Partial<Subscription>, today: string) => {
  const out = syncPhase(preserveRenewalHistory(s, { ...toEditForm(s, today), ...patch }, today), today);
  return reconcileRenewalRules(s, out, today);
};
const due = (s: Subscription) => s.nextDue ?? s.phases?.map((p) => p.nextDue).join(',');

test('开始日前付的首购结清开始那一期，之后提前续费顺延到下一年', () => {
  let s = base({ chargeLeadDays: 7, payments: [{ date: '2025-11-20', amount: 60 }] });
  assert.equal(nextCharge(s, '2026-09-27'), '2026-11-20');
  s = savePayment(s, '2026-09-28', { date: '2026-09-28', amount: 60 });
  assert.equal(s.payments?.at(-1)?.serviceDate, '2026-11-27');
  assert.equal(nextCharge(s, '2026-11-16'), '2027-11-20');
});

test('提前扣款天数改小后，已存的下次扣款日按新天数换算，服务端再写一次不重复平移', () => {
  let s = base({ chargeLeadDays: 7, payments: [{ date: '2025-11-27', amount: 60 }] });
  s = savePayment(s, '2026-09-28', { date: '2026-09-28', amount: 60 });
  assert.equal(nextCharge(s, '2026-11-16'), '2027-11-20');
  const form = syncPhase(preserveRenewalHistory(s, { ...toEditForm(s, '2026-11-16'), chargeLeadDays: 0 }, '2026-11-16'), '2026-11-16');
  assert.equal(form.nextDue, '2027-11-27');
  const saved = reconcileRenewalRules(s, form, '2026-11-16');
  assert.equal(saved.nextDue, '2027-11-27');
  assert.equal(nextCharge(saved, '2026-11-16'), '2027-11-27');
  // 调大时提前到不早于今天
  assert.equal(edit(saved, { chargeLeadDays: 400 }, '2026-11-16').nextDue, '2026-11-16');
});

test('月付提前记一笔后改成每 3 个月：从结清的那一期往后推一个新周期', () => {
  let s = base({
    start: '2026-05-08',
    cycle: { unit: 'month', every: 1 },
    payments: ['2026-05-08', '2026-06-08', '2026-07-08'].map((date) => ({ date, amount: 10 })),
  });
  s = savePayment(s, '2026-08-05', { date: '2026-08-05', amount: 10 });
  assert.equal(s.nextDue, '2026-09-08');
  const q = edit(s, { cycle: { unit: 'month', every: 3 } }, '2026-10-01');
  assert.equal(q.nextDue, '2026-11-08');
  assert.equal(nextCharge(q, '2026-10-01'), '2026-11-08');
});

test('把开始日与记录都改到 8 号后，下次扣款日落在新的扣款日', () => {
  let s = base({ start: '2026-05-01', cycle: { unit: 'month', every: 3 }, payments: [{ date: '2026-05-01', amount: 10 }] });
  s = savePayment(s, '2026-08-01', { date: '2026-08-01', amount: 10 });
  assert.equal(nextCharge(s, '2026-10-01'), '2026-11-01');
  const moved = edit(
    s,
    {
      start: '2026-05-08',
      payments: [
        { date: '2026-05-08', amount: 10 },
        { date: '2026-08-08', amount: 10 },
      ],
    },
    '2026-10-01',
  );
  assert.equal(nextCharge(moved, '2026-10-01'), '2026-11-08');
});

test('手动改的下次扣款日照存，同时改提前天数也不再平移', () => {
  const s = base({ start: '2026-05-08', cycle: { unit: 'month', every: 3 }, payments: [{ date: '2026-08-08', amount: 10 }], nextDue: '2026-11-08' });
  const manual = edit(s, { nextDue: '2026-11-20' }, '2026-10-01');
  assert.equal(manual.nextDue, '2026-11-20');
  assert.equal(nextCharge(manual, '2026-10-01'), '2026-11-20');
  const both = edit(s, { nextDue: '2026-11-20', chargeLeadDays: 3 }, '2026-10-01');
  assert.equal(both.nextDue, '2026-11-20');
});

test('多段订阅：编辑表单带上当前段的下次扣款日，手动改写回这一段', () => {
  const s = switchPlan(base({ start: '2025-01-08', cycle: { unit: 'month', every: 1 } }), '2026-05-08', {
    price: 30,
    currency: 'USD',
    cycle: { unit: 'month', every: 3 },
  });
  const manual = edit(s, { nextDue: '2026-11-20' }, '2026-10-01');
  assert.equal(manual.phases?.at(-1)?.nextDue, '2026-11-20');
  assert.equal(nextCharge(manual, '2026-10-01'), '2026-11-20');
  // 没碰下次扣款日的编辑不会清掉它
  assert.equal(due(edit(manual, { name: 'Renamed' }, '2026-10-02')), due(manual));
});

test('开始日往后挪很远时，原来的旧扣款不算首购，开始日这一期照常扣', () => {
  const s = base({ start: '2026-06-01', cycle: { unit: 'month', every: 1 }, payments: [{ date: '2025-03-01', amount: 10 }] });
  assert.deepEqual(
    chargesBetween(s, '2026-05-01', '2026-09-01', '2026-07-15')
      .filter((c) => !c.kind && c.date >= '2026-06-01')
      .map((c) => c.date),
    ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'],
  );
});

// 用户反馈：开始日前付的首期不在扣款记录里；提前续费后、续上那期开始前，「本期」显示成了续上的那期
test('开始日前付的首期计入整段扣款记录', async () => {
  const { historyStart, lastCharge } = await import('./billing.ts');
  const s = savePayment(base({ chargeLeadDays: 7, payments: [{ date: '2025-11-20', amount: 60 }] }), '2026-09-28', { date: '2026-09-28', amount: 60 });
  assert.equal(historyStart(s), '2025-11-20');
  assert.deepEqual(
    chargesBetween(s, historyStart(s), '2026-11-16', '2026-11-16').map((c) => c.date),
    ['2025-11-20', '2026-09-28'],
  );
  assert.equal(lastCharge(base({ payments: [{ date: '2025-11-20', amount: 60 }] }), '2025-11-25'), '2025-11-20');
  // 多阶段：较早阶段的付款也算
  const phased = switchPlan(s, '2026-12-01', { price: 80 });
  assert.equal(historyStart(phased), '2025-11-20');
  // 挪开始日留下的更早记录（早于一个周期）不算首期，起点仍是开始日
  assert.equal(historyStart(base({ start: '2026-06-01', payments: [{ date: '2025-01-01', amount: 60 }] })), '2026-06-01');
});

test('提前续费后续上那期开始前，本期仍是上一期；停用账期不变', async () => {
  const { billingPeriod, periodBeforeRenewal } = await import('./billing.ts');
  for (const lead of [7, 0]) {
    const s = savePayment(base({ chargeLeadDays: lead, payments: [{ date: lead ? '2025-11-20' : '2025-11-27', amount: 60 }] }), '2026-09-28', {
      date: '2026-09-28',
      amount: 60,
    });
    assert.deepEqual(periodBeforeRenewal(s, '2026-11-16'), { from: '2025-11-27', until: '2026-11-27' });
    assert.equal(periodBeforeRenewal(s, '2026-11-27'), undefined);
    assert.equal(periodBeforeRenewal(s, '2026-09-27'), undefined);
    // 停用与退款仍按已付到续上那期末
    assert.equal(billingPeriod(s, '2026-11-16').paidThrough, '2027-11-26');
  }
  // 月末日号：上一期从 9-30 起
  const month = { unit: 'month' as const, every: 1 };
  const m = savePayment(
    base({ cycle: month, start: '2026-08-31', payments: ['2026-08-31', '2026-09-30'].map((date) => ({ date, amount: 60 })) }),
    '2026-10-25',
    { date: '2026-10-25', amount: 60 },
  );
  assert.deepEqual(periodBeforeRenewal(m, '2026-10-27'), { from: '2026-09-30', until: '2026-10-31' });
  // 2 月夹短的月末：上一期仍从 1-31 起，不按 2-28 往回推成 1-28
  const feb = savePayment(
    base({ cycle: month, start: '2025-12-31', payments: ['2025-12-31', '2026-01-31'].map((date) => ({ date, amount: 60 })) }),
    '2026-02-20',
    { date: '2026-02-20', amount: 60 },
  );
  assert.deepEqual(periodBeforeRenewal(feb, '2026-02-22'), { from: '2026-01-31', until: '2026-02-28' });
});

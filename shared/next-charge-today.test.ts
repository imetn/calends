import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCharge } from './billing.ts';
import type { Subscription } from './types.ts';

const sub = (id: string, start: string): Subscription => ({
  id,
  name: id,
  category: '工具',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start,
  status: 'active',
});

// 回归：列表、侧栏、详情的下次扣款曾从明天起算，今天扣款的被当成下一期排到最后；界面一律传今天
test('a charge due today is the next charge and sorts before tomorrow', () => {
  const today = '2026-11-01';
  const rows = [sub('later', '2026-01-15'), sub('tomorrow', '2026-01-02'), sub('due-today', '2026-01-01')];
  assert.equal(nextCharge(rows[2], today), today);
  const sorted = rows.toSorted((a, b) => (nextCharge(a, today) ?? '').localeCompare(nextCharge(b, today) ?? ''));
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['due-today', 'tomorrow', 'later'],
  );
});

// Issue #31：今天记下的付款已经扣了，下一笔是之后那期；侧栏、详情、提醒都用 nextCharge
test('Issue #31: a payment recorded today is not the next charge', () => {
  const today = '2026-11-27';
  const early: Subscription = {
    ...sub('early', '2026-01-01'),
    price: 30,
    nextDue: '2027-01-01',
    payments: [{ date: today, amount: 30, serviceDate: '2026-12-01' }],
  };
  assert.equal(nextCharge(early, today), '2027-01-01');
  assert.equal(nextCharge(early, '2026-11-28'), '2027-01-01');
  // 到期当天付款：同样算已扣，下一笔是下个月
  const onDue: Subscription = { ...sub('on-due', '2026-01-27'), nextDue: '2026-12-27', payments: [{ date: today, amount: 10 }] };
  assert.equal(nextCharge(onDue, today), '2026-12-27');
  // 分开记：今天只缴了一部分，剩下的仍是今天待缴
  const partial: Subscription = { ...sub('partial', '2026-01-27'), price: 30, settlement: 'separate', payments: [{ date: today, amount: 10 }] };
  assert.equal(nextCharge(partial, today), today);
  assert.equal(nextCharge({ ...partial, payments: [{ date: today, amount: 30 }] }, today), '2026-12-27');
});

// 按某天起推算排期（换套餐默认保留到哪天等）时，那天记下的付款仍是一笔扣款
test('Issue #31: schedule lookups from a past date still count a payment on that date', () => {
  const s: Subscription = {
    ...sub('sched', '2026-01-12'),
    nextDue: '2026-12-12',
    payments: [
      { date: '2026-10-12', amount: 10 },
      { date: '2026-11-12', amount: 10 },
    ],
  };
  assert.equal(nextCharge(s, '2026-11-12', false), '2026-11-12');
  assert.equal(nextCharge(s, '2026-11-12'), '2026-12-12');
});

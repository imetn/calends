import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashChargesBetween, nextCharge, renewalDates } from './billing.ts';
import { savePayment } from './phases.ts';
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

test('an early renewal recorded today advances the next charge and stays in today’s cash history', () => {
  const today = '2026-11-27';
  const monthly = { ...sub('monthly', '2026-10-01'), cancelLeadDays: 1 };
  assert.equal(nextCharge(monthly, today), '2026-12-01');

  const saved = savePayment(monthly, today, { date: today, amount: 10 });
  assert.equal(saved.nextDue, '2027-01-01');
  assert.deepEqual(
    cashChargesBetween(saved, today, today, today).map(({ date, serviceDate, amount }) => ({ date, serviceDate, amount })),
    [{ date: today, serviceDate: '2026-12-01', amount: 10 }],
  );
  assert.equal(nextCharge(saved, '2026-11-26'), today);
  assert.equal(nextCharge(saved, today), '2027-01-01');
  assert.equal(nextCharge(saved, '2026-11-28'), '2027-01-01');
  assert.deepEqual(renewalDates(saved, today), { nextCharge: '2027-01-01', serviceExpires: '2027-01-01', cancelBy: '2026-12-31' });
});

test('a scheduled advance charge due today is still upcoming', () => {
  const monthly = { ...sub('lead-days', '2026-10-01'), chargeLeadDays: 4 };
  assert.equal(nextCharge(monthly, '2026-11-27'), '2026-11-27');
});

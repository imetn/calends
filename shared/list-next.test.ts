import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listNextCharge } from './list-scope.ts';
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

// 回归：列表「按下次扣款」曾从明天起算，今天扣款的被当成下一期排到最后
test('a charge due today is the next charge and sorts before tomorrow', () => {
  const today = '2026-11-01';
  const rows = [sub('later', '2026-01-15'), sub('tomorrow', '2026-01-02'), sub('due-today', '2026-01-01')];
  assert.equal(listNextCharge(rows[2], today), today);
  const sorted = rows.toSorted((a, b) => (listNextCharge(a, today) ?? '').localeCompare(listNextCharge(b, today) ?? ''));
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['due-today', 'tomorrow', 'later'],
  );
});

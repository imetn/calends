import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heatLevel, monthGrid } from './calendar.ts';

test('月网格从周起始日开始，补满整周', () => {
  const mon = monthGrid('2026-11', 1);
  assert.equal(mon[0], '2026-10-26');
  assert.equal(mon.length, 42);
  assert.equal(mon[41], '2026-12-06');
  const sun = monthGrid('2026-11', 0);
  assert.equal(sun[0], '2026-11-01', '11 月 1 日是周日，周日开始时不带上月');
  assert.equal(sun.length, 35);
  assert.equal(monthGrid('2027-02', 1).length, 28, '二月从周一开始正好四周');
});

test('热力分档：有扣款至少一档，缺汇率或相抵为 0 也不算没扣款', () => {
  assert.equal(heatLevel(0, 100), 1);
  assert.equal(heatLevel(Number.NaN, 100), 1);
  assert.equal(heatLevel(5, 0), 1);
  assert.equal(heatLevel(100, 100), 4);
  assert.equal(heatLevel(1, 1000), 1);
  assert.equal(heatLevel(250, 1000), 2, '开方：年费不把其他日子都压成最浅');
  assert.equal(heatLevel(2000, 1000), 4, '不超过最高档');
});

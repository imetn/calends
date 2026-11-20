import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX, phaseSubs } from './billing.ts';
import { changePrice, movePhaseStart, switchPlan } from './phases.ts';
import { priceSeries } from './price-steps.ts';
import type { Subscription } from './types.ts';

const base = (o: Partial<Subscription> = {}): Subscription => ({
  id: 'x',
  name: 'X',
  category: '工具',
  tags: [],
  price: 64.99,
  currency: 'TRY',
  cycle: { unit: 'month', every: 1 },
  start: '2023-02-26',
  status: 'active',
  region: 'TR',
  ...o,
});
const series = (s: Subscription, today = '2026-11-20', fxHistory?: Record<string, Record<string, number>>) =>
  priceSeries(
    phaseSubs(s),
    phaseSubs(s).map(() => undefined),
    today,
    'CNY',
    fxHistory,
    FALLBACK_FX,
  );

test('历程走势：同币种按原币连成台阶，画到今天', () => {
  let s = base();
  s = changePrice(s, '2023-08-26', 129.99);
  s = changePrice(s, '2024-09-26', 249.99);
  const r = series(s)!;
  assert.equal(r.currency, 'TRY');
  assert.equal(r.perMonth, false);
  assert.deepEqual(
    r.steps.map((x) => [x.from, x.to, x.amount, x.kind]),
    [
      ['2023-02-26', '2023-08-26', 64.99, 'start'],
      ['2023-08-26', '2024-09-26', 129.99, 'price'],
      ['2024-09-26', '2026-11-20', 249.99, 'price'],
    ],
  );
  // 今天之后才生效的调价不画
  assert.equal(series(changePrice(s, '2027-01-01', 399.99))!.steps.length, 3);
});

test('历程走势：价格没变过、买断、并行方案时不提供走势', () => {
  assert.equal(series(base()), undefined);
  assert.equal(series(base({ cycle: { unit: 'lifetime', every: 1 } })), undefined);
  const parallel = switchPlan(base(), '2024-06-01', { price: 9.99, currency: 'TRY', cycle: { unit: 'month', every: 1 } }, '2024-08-01');
  assert.equal(series(parallel), undefined);
});

test('历程走势：换过货币时折成本位币，每级按开始那天的汇率；缺汇率不当 0', () => {
  const s = switchPlan(base(), '2026-10-27', { price: 9.99, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const fxHistory = { '2023-02-26': { TRY: 20, CNY: 7 }, '2026-10-27': { TRY: 40, CNY: 7.2 } };
  const r = series(s, '2026-11-20', fxHistory)!;
  assert.equal(r.currency, 'CNY');
  assert.ok(Math.abs(r.steps[0].amount - (64.99 / 20) * 7) < 1e-9);
  assert.ok(Math.abs(r.steps[1].amount - 9.99 * 7.2) < 1e-9);
  assert.equal(r.steps[1].kind, 'switch');
  const noRate = { ...FALLBACK_FX, rates: { USD: 1, CNY: 7 } };
  assert.equal(priceSeries(phaseSubs(s), [undefined, undefined], '2026-11-20', 'CNY', undefined, noRate), undefined);
});

test('历程走势：月付换年付时按每月折算', () => {
  const s = switchPlan(base({ price: 100, currency: 'USD' }), '2025-01-01', { price: 1200, currency: 'USD', cycle: { unit: 'year', every: 1 } });
  const r = series(changePrice(s, '2026-01-01', 960))!;
  assert.equal(r.perMonth, true);
  assert.ok(Math.abs(r.steps[0].amount - 100) < 1e-9);
  assert.ok(Math.abs(r.steps[1].amount - 1200 / (365.25 / 30.4375)) < 1);
  assert.equal(r.steps.length, 3);
});

test('历程走势：开始日挪过调价点后，第一级取开始日当天的价，不画开始日之前的点', () => {
  let s = switchPlan(base(), '2024-01-01', { price: 20, currency: 'TRY', cycle: { unit: 'month', every: 1 } });
  s = changePrice(s, '2024-03-01', 25);
  s = movePhaseStart(s, '2024-01-01', '2024-05-01');
  const r = series(s)!;
  const own = r.steps.filter((x) => x.phase === '2024-05-01');
  assert.deepEqual(
    own.map((x) => [x.from, x.to, x.amount, x.kind]),
    [['2024-05-01', '2026-11-20', 25, 'switch']],
  );
  assert.ok(r.steps.every((x) => x.from <= x.to));
  // 只有一段、挪过开始日但价格没变过：不提供走势
  assert.equal(series(movePhaseStart(changePrice(base(), '2023-04-01', 70), '2023-02-26', '2023-05-01')), undefined);
});

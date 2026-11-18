import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settlementCurrencyOf } from './fx.ts';
import { stopForm } from './stop-form.ts';
import { DEFAULT_SETTINGS, type PaymentMethod, type Subscription } from './types.ts';

test('payment and stop settlement defaults use the actual card account with base fallback', () => {
  const state = {
    methods: [
      { id: 'jpy', currency: 'JPY' },
      { id: 'eur', currency: 'EUR' },
    ] as PaymentMethod[],
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
  };
  assert.equal(settlementCurrencyOf(state, 'jpy'), 'JPY');
  // 同币种卡（USD 卡付 USD 订阅）也默认卡的币种，不跳到本位币
  assert.equal(settlementCurrencyOf(state, 'eur'), 'EUR');
  assert.equal(settlementCurrencyOf(state), 'CNY');
  const sub = {
    id: 's',
    start: '2026-10-01',
    price: 10,
    currency: 'EUR',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    methodId: 'jpy',
  } as Subscription;
  assert.equal(stopForm(sub, '2026-10-25', state).settledCurrency, 'JPY');
  assert.equal(stopForm({ ...sub, methodId: 'eur' }, '2026-10-25', state).settledCurrency, 'EUR', 'same-currency card refund defaults to the card currency');
  sub.stop = { date: '2026-10-20', kind: 'cancel', paidThrough: '2026-10-31' };
  sub.payments = [{ date: '2026-10-20', kind: 'refund', amount: -2, settled: { amount: -3, currency: 'USD' } }];
  assert.equal(stopForm(sub, '2026-10-25', state).settledCurrency, 'USD', 'existing settlement always wins');
});

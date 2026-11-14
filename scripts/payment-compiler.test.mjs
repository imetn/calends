import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import * as billing from '../shared/billing.ts';
import * as phases from '../shared/phases.ts';
import { settlementCurrencyOf } from '../shared/fx.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

test('compiled new payment initializes settlement without an edit record', () => {
  const source = readFileSync(new URL('../app/src/views/PaymentSheet.tsx', import.meta.url), 'utf8');
  const compiled = transformSync('PaymentSheet.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: true });
  assert.equal(compiled.fatal, false);
  const code = compiled.code.replace(/^import .*;$/gm, '').replace('export function PaymentSheet', 'function PaymentSheet');
  const initialized = Symbol('settlement initialized');
  let states = 0;
  const PaymentSheet = new Function('_c', 'useState', 'currentPhase', code + '; return PaymentSheet;')(
    (n) => Array(n).fill(Symbol.for('react.memo_cache_sentinel')),
    (initial) => {
      if (++states === 5) {
        assert.equal(initial, '');
        throw initialized;
      }
      return [initial, () => {}];
    },
    (s) => s,
  );
  assert.throws(
    () => PaymentSheet({ sub: { price: 10, currency: 'USD', start: '2026-10-01' }, today: '2026-10-25', onClose() {} }),
    (e) => e === initialized,
  );
});

test('compiled payment renders the whole new form including its unused delete callback', () => {
  const source = readFileSync(new URL('../app/src/views/PaymentSheet.tsx', import.meta.url), 'utf8');
  const code = transformSync('PaymentSheet.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: true })
    .code.replace(/^import .*;$/gm, '')
    .replace('export function PaymentSheet', 'function PaymentSheet');
  const deps = {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    _c: (n) => Array(n).fill(Symbol.for('react.memo_cache_sentinel')),
    useState: (v) => [v, () => {}],
    currentPhase: (s) => s,
    chargesBetween: () => [],
    isSeparate: () => false,
    addMonths: (d) => d,
    settleBills: () => ({ bills: [], allocated: new Map(), credit: [] }),
    earlyRenewalEffect: () => undefined,
    currencyDecimals: () => 2,
    useSubmit: () => [false, () => {}],
    getState: () => ({ methods: [], settings: { baseCurrency: 'CNY' } }),
    settlementCurrencyOf: () => 'CNY',
    t: String,
    money: String,
  };
  for (const name of [
    'ConfirmButton',
    'Sheet',
    'MoneyInput',
    'Seg',
    'Cell',
    'Group',
    'IconButton',
    'Icon',
    'DatePicker',
    'CurrencySelect',
    'Picker',
    'MethodPicker',
  ])
    deps[name] = name;
  const PaymentSheet = new Function(...Object.keys(deps), code + ';return PaymentSheet;')(...Object.values(deps));
  assert.doesNotThrow(() => PaymentSheet({ sub: { price: 10, currency: 'USD', start: '2026-10-01' }, today: '2026-10-25', onClose() {} }));
});

test('editing an early payment keeps its owning phase unassigned and saves without changing methodId', async () => {
  const pay = { date: '2026-09-25', amount: 30 };
  const sub = {
    id: 'early-payment',
    name: 'Fictional',
    category: 'tools',
    tags: [],
    status: 'active',
    start: '2026-01-01',
    price: 30,
    currency: 'USD',
    cycle: { unit: 'month', every: 3 },
    phases: [
      { start: '2026-01-01', end: '2026-09-30', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'previous-card' },
      { start: '2026-10-01', price: 30, currency: 'USD', cycle: { unit: 'month', every: 3 }, payments: [pay], nextDue: '2027-01-01' },
    ],
  };
  let saved;
  let closed = false;
  const deps = {
    ...billing,
    ...phases,
    settlementCurrencyOf,
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    _c: (n) => Array(n).fill(Symbol.for('react.memo_cache_sentinel')),
    useState: (v) => [v, () => {}],
    useSubmit: () => [false, (fn) => fn()],
    getState: () => ({ methods: [{ id: 'previous-card', name: 'Fictional card', currency: 'USD' }], settings: DEFAULT_SETTINGS }),
    saveSub: async (s) => {
      saved = s;
    },
    run: (fn) => fn(),
    currencyDecimals: () => 2,
    money: String,
    t: String,
  };
  for (const name of [
    'ConfirmButton',
    'Sheet',
    'MoneyInput',
    'Seg',
    'Cell',
    'Group',
    'IconButton',
    'Icon',
    'DatePicker',
    'CurrencySelect',
    'Picker',
    'MethodPicker',
  ])
    deps[name] = name;
  const source = readFileSync(new URL('../app/src/views/PaymentSheet.tsx', import.meta.url), 'utf8');
  const compiled = transformSync('PaymentSheet.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: true });
  assert.equal(compiled.fatal, false);
  const code = compiled.code.replace(/^import .*;$/gm, '').replace('export function PaymentSheet', 'function PaymentSheet');
  const PaymentSheet = new Function(...Object.keys(deps), code + ';return PaymentSheet;')(...Object.values(deps));
  const tree = PaymentSheet({
    sub,
    today: '2026-10-26',
    edit: { pay, index: 0, phase: '2026-10-01' },
    onClose: () => {
      closed = true;
    },
  });
  const all = (node) =>
    Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.children), ...all(node.props?.foot)] : [];
  const nodes = all(tree);
  assert.equal(nodes.find((n) => n.type === 'MethodPicker').props.value, undefined, 'the form must show Unassigned, not the previous phase card');
  await nodes.find((n) => n.type === 'button' && n.props.className === 'btn primary').props.onClick();
  assert.equal(closed, true);
  assert.equal(saved.phases[0].methodId, 'previous-card');
  assert.equal(saved.phases[1].methodId, undefined);
  assert.equal(saved.phases[1].payments.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.phases[1].payments[0])), { ...pay, currency: 'USD', serviceDate: '2026-10-01' });
  assert.deepEqual(sub.phases[1].payments, [pay], 'input records remain unchanged');
});

test('separate settlement payment preselects the oldest unpaid bills the amount covers and saves without fixed periods', async () => {
  const sub = {
    id: 'separate-fee',
    name: 'Fictional fee',
    category: 'home',
    tags: [],
    status: 'active',
    start: '2026-01-01',
    billingStart: '2026-07-01',
    settlement: 'separate',
    price: 100,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    payments: [{ date: '2026-07-03', amount: 100 }],
  };
  let saved;
  const deps = {
    ...billing,
    ...phases,
    settlementCurrencyOf,
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    _c: (n) => Array(n).fill(Symbol.for('react.memo_cache_sentinel')),
    useState: (v) => [v, () => {}],
    useSubmit: () => [false, (fn) => fn()],
    getState: () => ({ methods: [], settings: DEFAULT_SETTINGS }),
    saveSub: async (s) => {
      saved = s;
    },
    run: (fn) => fn(),
    currencyDecimals: () => 2,
    cnDateAuto: String,
    money: (n) => String(n),
    t: String,
  };
  for (const name of [
    'ConfirmButton',
    'Sheet',
    'MoneyInput',
    'NumInput',
    'Seg',
    'Cell',
    'Group',
    'IconButton',
    'Icon',
    'DatePicker',
    'CurrencySelect',
    'Picker',
    'MethodPicker',
  ])
    deps[name] = name;
  const source = readFileSync(new URL('../app/src/views/PaymentSheet.tsx', import.meta.url), 'utf8');
  const code = transformSync('PaymentSheet.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: true })
    .code.replace(/^import .*;$/gm, '')
    .replace('export function PaymentSheet', 'function PaymentSheet');
  const PaymentSheet = new Function(...Object.keys(deps), code + ';return PaymentSheet;')(...Object.values(deps));
  // 8、9、10 月未缴（另列下一期 11 月），金额 100 只够最早的 8 月
  const tree = PaymentSheet({ sub, today: '2026-10-15', onClose() {} });
  const all = (node) =>
    Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.children), ...all(node.props?.foot)] : [];
  const nodes = all(tree);
  const rows = nodes.filter((n) => n.type === 'label' && String(n.props.className).includes('rv-period'));
  assert.equal(rows.length, 4);
  const checked = rows.map((r) => all(r.children).find((n) => n.type === 'input').props.checked);
  assert.deepEqual(checked, [true, false, false, false]);
  assert.equal(
    nodes.some((n) => n.props?.foot && String(n.props.foot).includes('earlyHint')),
    false,
  );
  await nodes.find((n) => n.type === 'button' && n.props.className === 'btn primary').props.onClick();
  const pay = saved.payments.find((p) => p.date === '2026-10-15');
  assert.equal(pay.periods, undefined);
  assert.equal(saved.nextDue, sub.nextDue);
  assert.deepEqual(
    billing.overdueBills(saved, '2026-10-15').map((c) => c.date),
    ['2026-09-01', '2026-10-01'],
  );
});

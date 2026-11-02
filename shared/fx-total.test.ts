import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountTotal,
  averageLine,
  chargesTotal,
  dueTotal,
  convertedTotal,
  formatTotal,
  formatUnconverted,
  scaleTotal,
  sumTotals,
  totalDifference,
  totalNote,
  totalsNote,
  totalRatio,
} from './fx-total.ts';
import { FALLBACK_FX, totals, runwayFor, memberDues, monthlyPriceTotal } from './billing.ts';
import { contributionTotal, cashVsAccrual, mrrTotal, yearReview, topUpPlan } from './metrics.ts';
import { netCost } from './transfers.ts';
import { monthReport, scopeReport } from './scope-report.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { flatten, setLocale } from './i18n.ts';
import { readFileSync } from 'node:fs';
setLocale('en', [flatten('core', JSON.parse(readFileSync(new URL('./locales/en/core.json', import.meta.url), 'utf8')))]);
const today = '2026-10-25';
const sub = (id: string, currency = 'USD', price = 10): Subscription => ({
  id,
  name: id,
  category: 'Tools',
  tags: [],
  currency,
  price,
  start: '2026-10-01',
  status: 'active',
  cycle: { unit: 'month', every: 1 },
});
const state = (subscriptions: Subscription[]): AppState => ({
  subscriptions,
  methods: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
  fx: FALLBACK_FX,
});
test('complete, partially missing and all-missing aggregates retain known totals and original currencies', () => {
  for (const [subs, value, missing] of [
    [[sub('known')], 10, false],
    [[sub('known'), sub('unknown', 'XCD', 27)], 10, true],
    [[sub('unknown', 'XCD', 27)], 0, true],
  ] as const) {
    const st = state([...subs]);
    const partial = totals(st, today).partial.mrr;
    assert.equal(partial.value, value);
    assert.equal(partial.incomplete, missing);
    assert.deepEqual(partial.unconverted, missing ? { XCD: 27 } : {});
    assert.equal(mrrTotal(st, today).value, value);
    if (missing) {
      assert.ok(Number.isNaN(totals(st, today).mrr));
      assert.ok(Number.isNaN(totalRatio(partial, amountTotal(10, 'USD', 10))));
      assert.ok(Number.isNaN(totalDifference(partial, amountTotal(10, 'USD', 10))));
    }
  }
});
test('all missing uses originals, averages require one currency, and a known cancellation stays a known zero', () => {
  const a = convertedTotal(state([]), 27, 'XCD');
  assert.equal(formatTotal(a, 'USD'), 'XCD 27.00');
  assert.equal(formatTotal(a, 'USD', { approx: true }), 'XCD 27.00');
  assert.equal(formatTotal(amountTotal(10, 'USD', 10), 'USD', { approx: true }), '≈ $10.00');
  assert.equal(formatTotal(scaleTotal(a, 1 / 3), 'USD', { average: true }), 'XCD 9.00');
  const multi = sumTotals([a, amountTotal(10, 'ZZZ', NaN)]);
  assert.equal(formatTotal(multi, 'USD', { average: true }), '—');
  assert.ok(!formatTotal(multi, 'USD').includes('$0'));
  const zero = sumTotals([amountTotal(10, 'USD', 10), amountTotal(-10, 'USD', -10), a]);
  assert.equal(zero.known, true);
  assert.equal(zero.value, 0);
  assert.ok(formatTotal(zero, 'USD').startsWith('$0.00 + '));
  assert.match(totalNote(a), /Unconverted/);
  const four = sumTotals(['AAA', 'BBB', 'CCC', 'DDD'].map((c, i) => amountTotal(i + 1, c, NaN)));
  assert.match(formatUnconverted(four), /^DDD 4.00 \+ CCC 3.00 \+ BBB 2.00 and 1 other currencies$/);
});
test('settlement currency and historical FX, refunds and transfers keep their original cash basis', () => {
  const s = sub('s', 'XCD', 27);
  s.payments = [
    { date: '2026-10-01', amount: 27, settled: { amount: 50, currency: 'USD' } },
    { date: '2026-10-02', amount: -4, kind: 'refund', currency: 'XCD' },
  ];
  const st = state([s]);
  const part = chargesTotal(st, [
    { amount: 27, currency: 'XCD', date: '2026-10-01', projected: false, settled: { amount: 50, currency: 'USD' } },
    { amount: -4, currency: 'XCD', date: '2026-10-02', projected: false, kind: 'refund' },
  ]);
  assert.equal(part.value, 50);
  assert.deepEqual(part.unconverted, { XCD: -4 });
  s.transfers = [
    { kind: 'buy', date: '2026-10-01', amount: 10, currency: 'XCD' },
    { kind: 'sell', date: '2026-10-02', amount: 3, currency: 'XCD' },
  ];
  assert.equal(netCost(st, s, today).partial.unconverted.XCD, 3); // -4 refund +10 buy -3 sell
  const historical = { ...st, fxHistory: { '2026-10-01': { USD: 1, XCD: 2 } } };
  assert.equal(convertedTotal(historical, 10, 'XCD', '2026-10-01').value, 5);
});
test('parallel phases keep each currency; reports and year review preserve missing originals and suppress comparisons', () => {
  const s = sub('parallel');
  s.phases = [
    { start: '2026-10-01', price: 10, currency: 'USD', cycle: s.cycle },
    { start: '2026-10-10', price: 27, currency: 'XCD', cycle: s.cycle },
  ];
  const st = state([s]);
  assert.deepEqual(contributionTotal(st, s, today).unconverted, { XCD: 27 });
  const price = monthlyPriceTotal(st, { ...s, phases: s.phases.map((p, i) => (i === 0 ? { ...p, end: '2026-11-01' } : p)) }, today);
  assert.equal(price.value, 10);
  assert.deepEqual(price.unconverted, { XCD: 27 });
  const report = monthReport(st, '2026-10', today);
  const h = report.blocks.find((b) => b.type === 'headline');
  assert.ok(h && h.mode === 'month');
  assert.equal(h.partial!.total.value, 10);
  assert.equal(h.partial!.total.unconverted.XCD, 27);
  assert.ok(Number.isNaN(h.previous.amount));
  assert.equal(yearReview(st, today).partial.total.unconverted.XCD, 27);
  assert.equal(scopeReport(st, [s], today).blocks[0].partial!.mrr.unconverted.XCD, 27);
  assert.ok(cashVsAccrual(st, today, 0, 0)[0].partial.cash.incomplete);
});
test('wallet missing FX retains known balance and original debits without proving sufficiency', () => {
  const s = { ...sub('s', 'XCD', 27), methodId: 'm', start: '2026-10-26' };
  const st = state([s]);
  const method = { id: 'm', name: 'Fictional', kind: 'giftcard' as const, currency: 'USD', balance: 100, balanceAsOf: today };
  st.methods = [method];
  const r = runwayFor(method, st, today)!;
  assert.equal(r.incomplete, true);
  assert.ok(Number.isNaN(r.topUp12m));
  assert.equal(r.partial.current.value, 100);
  assert.equal(r.forecast[0].partial.unconverted.XCD, 27);
  assert.equal(r.forecast[0].balancePartial.value, 100);
});

test('one note retains different periods and deduplicates repeated derived measures', () => {
  const month = amountTotal(27, 'XCD', NaN),
    year = amountTotal(270, 'XCD', NaN);
  const note = totalsNote([
    ['Monthly', month],
    ['Annual duplicate', month],
    ['Paid this year', year],
    ['Known', amountTotal(10, 'USD', 10)],
  ]);
  assert.match(note, /Monthly: XCD 27.00/);
  assert.match(note, /Paid this year: XCD 270.00/);
  assert.ok(!note.includes('Annual duplicate'));
  assert.ok(!note.includes('Known'));
});

test('unpaid periods retain native currencies when the fee changes into a currency without FX', () => {
  const s = sub('fee-history');
  s.start = '2026-08-01';
  s.share = {
    role: 'owner',
    seats: 4,
    since: s.start,
    members: [
      {
        id: 'm',
        name: 'Fictional',
        joined: s.start,
        share: 5,
        fee: 7,
        feeCurrency: 'XCD',
        billEvery: 1,
        feeHistory: [
          { from: '2026-08-01', fee: 5, currency: 'USD', billEvery: 1, share: 5 },
          { from: '2026-09-01', fee: 7, currency: 'XCD', billEvery: 1, share: 5 },
        ],
      },
    ],
  };
  const st = state([s]);
  const due = memberDues(s, today, 'USD', st)[0];
  assert.ok(Number.isNaN(due.owed));
  const total = dueTotal(st, due);
  assert.equal(total.value, 5);
  assert.equal(total.incomplete, true);
  assert.deepEqual(total.unconverted, { XCD: 14 });
  const sharing = monthReport(st, '2026-10', today).blocks.find((b) => b.type === 'sharing');
  assert.ok(sharing);
  assert.equal(sharing.partial!.owed.unconverted.XCD, 7);
});

test('top-up plans retain unknown native debits and clamp only the known funding requirement', () => {
  const unknown = { ...sub('unknown', 'XCD', 27), methodId: 'm', start: '2026-10-26' };
  const known = { ...sub('known', 'USD', 150), methodId: 'm', start: '2026-10-26' };
  const method = { id: 'm', name: 'Fictional balance', kind: 'giftcard' as const, currency: 'USD', balance: 100, balanceAsOf: today };
  for (const [subs, knownPart] of [
    [[unknown], false],
    [[unknown, known], true],
  ] as const) {
    const st = { ...state([...subs]), methods: [method] };
    const p = topUpPlan(st, today, 3)[0];
    assert.equal(p.incomplete, true);
    assert.ok(Number.isNaN(p.need));
    assert.equal(p.partial.need.known, knownPart);
    assert.ok(p.partial.need.value >= 0);
    assert.ok(p.partial.need.unconverted.XCD > 0);
    if (!knownPart) assert.ok(!formatTotal(p.partial.need, 'USD').includes('$0'));
  }
});

test('图表平均线：缺汇率的不当 0，不足两笔或每笔相同时不画', () => {
  assert.equal(averageLine([100, 200, NaN]), 150);
  assert.equal(averageLine([100, NaN]), undefined);
  assert.equal(averageLine([68, 68, 68]), undefined);
  assert.equal(averageLine([]), undefined);
});

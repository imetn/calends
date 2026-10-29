import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX, memberDues } from './billing.ts';
import { chargeValue } from './fx.ts';
import { cashVsAccrual, contributionOn, movement, mrrOn, stopLosses } from './metrics.ts';
import { compactComposition, monthReport, scopeReport, yearOutlook, type Block, type ScopeReport } from './scope-report.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const today = '2026-10-22';
const sub = (id: string, extra: Partial<Subscription> = {}): Subscription => ({
  id,
  name: id,
  category: 'Tools',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2025-01-01',
  status: 'active',
  ...extra,
});
const state = (subscriptions: Subscription[], extra: Partial<AppState> = {}): AppState => ({
  subscriptions,
  methods: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
  fx: FALLBACK_FX,
  ...extra,
});
const get = <T extends Block['type']>(report: ScopeReport, type: T) => report.blocks.find((b): b is Extract<Block, { type: T }> => b.type === type);
const stopped = (extra: Partial<Subscription> = {}) =>
  sub('Stopped', {
    price: 120,
    cycle: { unit: 'year', every: 1 },
    start: '2026-01-01',
    status: 'terminated',
    end: '2026-10-10',
    stop: { kind: 'terminate', date: '2026-10-10', paidThrough: '2026-12-31' },
    payments: [{ date: '2026-01-01', amount: 120 }],
    ...extra,
  });
const owner = () =>
  sub('Owner', {
    share: {
      role: 'owner',
      seats: 3,
      members: [
        {
          id: 'm',
          name: 'Member',
          share: 4,
          fee: 4,
          feeCurrency: 'USD',
          joined: '2026-01-01',
          billEvery: 1,
          // 9 月初收 8 月那期、10 月初收 9 月那期；10 月那期还没收
          receipts: [
            { id: 'r1', date: '2026-09-01', amount: 4, currency: 'USD', periods: ['2026-08-01'] },
            { id: 'r2', date: '2026-10-03', amount: 4, currency: 'USD', periods: ['2026-09-01'] },
          ],
        },
      ],
    },
  });

test('empty reports contain only the mandatory headline', () => {
  assert.deepEqual(
    scopeReport(state([]), [], today).blocks.map((b) => b.type),
    ['headline'],
  );
  assert.deepEqual(
    monthReport(state([]), '2026-10', today).blocks.map((b) => b.type),
    ['headline'],
  );
});

test('reports are deterministic, keep fixed block order and do not mutate frozen input', () => {
  const st = state([sub('A', { methodId: 'a', category: 'AI', start: '2026-10-01' }), sub('B', { methodId: 'b', start: '2025-01-25' }), stopped(), owner()]);
  const freeze = (v: unknown) => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      Object.values(v).forEach(freeze);
    }
  };
  freeze(st);
  const order = ['headline', 'trend', 'composition', 'top', 'upcoming', 'events', 'losses', 'sharing'];
  for (const generate of [() => scopeReport(st, st.subscriptions, today), () => monthReport(st, '2026-10', today)]) {
    const a = generate();
    assert.deepEqual(a, generate());
    assert.deepEqual(
      a.blocks.map((b) => b.type),
      order,
    );
  }
});

test('losses appear only for a loss or refund and match stopLosses', () => {
  const plain = state([sub('A')]);
  assert.equal(get(scopeReport(plain, plain.subscriptions, today), 'losses'), undefined);
  const st = state([stopped()]);
  for (const r of [scopeReport(st, st.subscriptions, today), monthReport(st, '2026-10', today)]) {
    const loss = get(r, 'losses')!;
    assert.equal(loss.loss, stopLosses(st, today).total);
    assert.ok(loss.loss > 0);
    assert.equal(loss.refunds.length, 0);
  }
});

test('fully refunded stops and ordinary refunds still produce a refunds block', () => {
  const st = state([
    stopped({
      payments: [
        { date: '2026-01-01', amount: 120 },
        { date: '2026-10-11', amount: -120, kind: 'refund' },
      ],
    }),
  ]);
  assert.equal(stopLosses(st, today).items.length, 0);
  const loss = get(monthReport(st, '2026-10', today), 'losses')!;
  assert.equal(loss.loss, 0);
  assert.equal(loss.refunded, 120);
  assert.equal(loss.rows.length, 0);
});

test('monthly losses use stop dates; refunds use payment dates, including later refunds', () => {
  const s = stopped({
    end: '2026-09-10',
    stop: { kind: 'terminate', date: '2026-09-10', paidThrough: '2026-12-31' },
    payments: [
      { date: '2026-01-01', amount: 120 },
      { date: '2026-10-11', amount: -10, kind: 'refund' },
    ],
  });
  const st = state([s]);
  const oct = get(monthReport(st, '2026-10', today), 'losses')!;
  assert.equal(oct.loss, 0);
  assert.equal(oct.refunded, 10);
  const sep = get(monthReport(st, '2026-09', today), 'losses')!;
  assert.equal(sep.loss, stopLosses(st, today, { from: '2026-09-01', to: '2026-09-30' }).total);
  assert.equal(sep.refunds.length, 0);
});

test('scope MRR matches the subset; one category and one method are omitted', () => {
  const a = sub('A');
  const st = state([a, sub('Outside', { price: 100 })]);
  const r = scopeReport(st, [a], today);
  const h = get(r, 'headline')!;
  assert.equal(h.mode, 'scope');
  if (h.mode !== 'scope') return;
  assert.equal(h.mrr, mrrOn({ ...st, subscriptions: [a] }, today));
  assert.equal(h.annual, h.mrr * 12);
  assert.equal(h.activeCount, 1);
  assert.equal(get(r, 'composition'), undefined);
  assert.equal(get(r, 'top')!.rows.length, 1);
});

test('scope composition uses active historical phases for payment methods', () => {
  const s = sub('Parallel', {
    phases: [
      { start: '2026-01-01', end: '2026-12-31', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'old' },
      { start: '2026-10-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'new' },
    ],
  });
  const st = state([s]);
  const c = get(scopeReport(st, [s], today), 'composition')!;
  assert.deepEqual(c.categories, []);
  assert.deepEqual(
    c.methods.map((r) => [r.key, r.amount]),
    [
      ['new', 20],
      ['old', 10],
    ],
  );
  assert.equal(
    c.methods.reduce((a, r) => a + r.amount, 0),
    contributionOn(st, s, today),
  );
});

test('month comparisons use full-month net cash, today is charged, failed payments are excluded', () => {
  const s = sub('Cash', {
    cycle: { unit: 'lifetime', every: 1 },
    payments: [
      { date: '2025-10-01', amount: 40 },
      { date: '2026-09-01', amount: 50 },
      { date: today, amount: 100 },
      { date: '2026-10-25', amount: 20 },
      { date: '2026-10-03', amount: -10, kind: 'refund' },
      { date: '2026-10-02', amount: 999, kind: 'failed' },
    ],
  });
  const h = get(monthReport(state([s]), '2026-10', today), 'headline')!;
  assert.equal(h.mode, 'month');
  if (h.mode !== 'month') return;
  assert.equal(h.total, 110);
  assert.equal(h.paid, 90);
  assert.equal(h.pending, 20);
  assert.equal(h.total, h.paid + h.pending);
  assert.equal(h.count, 2);
  assert.deepEqual(h.previous, { amount: 60, percent: 1.2 });
  assert.deepEqual(h.yearly, { amount: 70, percent: 1.75 });
});

test('no year comparison without prior-year charges, zero denominator has no percentage', () => {
  const st = state([sub('New', { start: '2026-10-01' })]);
  const h = get(monthReport(st, '2026-10', today), 'headline')!;
  if (h.mode !== 'month') assert.fail('month headline');
  assert.equal(h.yearly, undefined);
  assert.deepEqual(h.previous, { amount: 10, percent: undefined });
});

test('cash uses settlement FX and my share, matching cashVsAccrual', () => {
  const s = owner();
  s.currency = 'EUR';
  s.payments = [{ date: '2026-10-01', amount: 10, settled: { amount: 14, currency: 'USD' } }];
  const st = state([s]);
  const r = monthReport(st, '2026-10', today);
  const h = get(r, 'headline')!;
  if (h.mode !== 'month') assert.fail('month headline');
  assert.equal(h.total, cashVsAccrual(st, today, 0, 0)[0].cash);
  assert.equal(h.total, 14 * 0.6);
  const top = get(r, 'top')!;
  assert.equal(top.rows[0].sub, s);
});

test('month movement matches the report page and is absent for future months', () => {
  const st = state([sub('New', { start: '2026-10-01' }), sub('Sep', { start: '2026-09-01' })]);
  const current = get(monthReport(st, '2026-10', today), 'trend')!;
  if (current.mode !== 'month') assert.fail('month trend');
  const withoutContext = (mv: typeof current.movement) => ({ ...mv, items: mv.items.map(({ from, to, since, until, ...r }) => r) });
  assert.deepEqual(withoutContext(current.movement), movement(st, '2026-09-30', today));
  assert.deepEqual(current.movement.items[0], {
    sub: st.subscriptions[0],
    kind: 'added',
    delta: 10,
    from: 0,
    to: 10,
    since: '2026-10-01',
    until: '2026-10-01',
  });
  const past = get(monthReport(st, '2026-09', today), 'trend')!;
  if (past.mode !== 'month') assert.fail('month trend');
  assert.deepEqual(withoutContext(past.movement), movement(st, '2026-08-31', '2026-09-30', '2026-09-30'));
  assert.equal(get(monthReport(st, '2026-11', today), 'trend'), undefined);
});

test('composition keeps up to six rows and groups only the tail above six without changing totals', () => {
  for (const count of [0, 1, 5, 6, 7, 12]) {
    const total = (count * (count + 1)) / 2;
    const rows = Array.from({ length: count }, (_, i) => Object.freeze({ key: String(i), amount: count - i, share: (count - i) / total }));
    const result = compactComposition(Object.freeze(rows));
    assert.equal(result.length, Math.min(count, 6));
    assert.equal(
      result.reduce((n, r) => n + r.amount, 0),
      total,
    );
    assert.ok(Math.abs(result.reduce((n, r) => n + r.share, 0) - (count ? 1 : 0)) < 1e-12);
    if (count <= 6) assert.deepEqual(result, rows);
    else {
      assert.deepEqual(result.slice(0, 5), rows.slice(0, 5));
      assert.deepEqual(result[5], {
        key: '',
        other: true,
        amount: rows.slice(5).reduce((n, r) => n + r.amount, 0),
        share: rows.slice(5).reduce((n, r) => n + r.share, 0),
      });
    }
  }
});

test('both report builders compact categories and payment methods independently', () => {
  const subs = Array.from({ length: 8 }, (_, i) => sub(String(i), { price: 10 + i, category: `Category ${i}`, methodId: `method-${i}`, start: '2026-10-01' }));
  const st = state(subs);
  for (const report of [scopeReport(st, subs, today), monthReport(st, '2026-10', today)]) {
    const c = get(report, 'composition')!;
    for (const rows of [c.categories, c.methods]) {
      assert.equal(rows.length, 6);
      assert.equal(rows[5].other, true);
      assert.equal(rows[5].amount, 33);
      assert.equal(
        rows.reduce((n, r) => n + r.amount, 0),
        108,
      );
      assert.ok(Math.abs(rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-12);
    }
  }
});

test('movement context keeps rebased monthly costs and dates across price, phase and stop changes', () => {
  const st = state([
    sub('Price', {
      price: 30,
      priceHistory: [
        { from: '2025-01-01', amount: 10 },
        { from: '2026-10-03', amount: 20 },
        { from: '2026-10-12', amount: 30 },
      ],
    }),
    sub('Phase', {
      phases: [
        { start: '2025-01-01', end: '2026-10-07', price: 25, currency: 'USD', cycle: { unit: 'month', every: 1 } },
        { start: '2026-10-08', price: 15, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      ],
    }),
    stopped(),
  ]);
  const trend = get(monthReport(st, '2026-10', today), 'trend')!;
  if (trend.mode !== 'month') assert.fail('month trend');
  const rows = trend.movement.items;
  assert.deepEqual(
    rows.map((r) => [r.sub.id, r.kind, r.from, r.to, r.since, r.until]),
    [
      ['Price', 'expansion', 10, 30, '2026-10-03', '2026-10-12'],
      ['Phase', 'contraction', 25, 15, '2026-10-08', '2026-10-08'],
      ['Stopped', 'churned', 10, 0, '2026-10-10', '2026-10-10'],
    ],
  );
  assert.ok(rows.every((r) => Math.abs(r.to - r.from - r.delta) < 1e-10));
});

test('scope has a fixed 12-month cash series, while upcoming is tomorrow through day 30', () => {
  const st = state([sub('Today', { start: today }), sub('Day30', { start: '2026-11-21' })]);
  const report = scopeReport(st, st.subscriptions, today);
  const trend = get(report, 'trend')!;
  if (trend.mode !== 'scope') assert.fail('scope trend');
  assert.equal(trend.rows.length, 12);
  assert.equal(trend.rows[0].month, '2025-11');
  assert.equal(trend.rows.at(-1)!.month, '2026-10');
  assert.equal(trend.rows.filter((r) => r.projected).length, 0);
  assert.deepEqual(
    get(report, 'upcoming')!.rows.map((r) => r.date),
    ['2026-11-21'],
  );
  assert.equal(get(monthReport(st, '2026-09', today), 'upcoming'), undefined);
  assert.ok(get(monthReport(st, '2026-11', today), 'upcoming')!.rows.every((r) => r.date > today));
});

test('scope omits an all-zero cash chart even when an older prepayment is still being amortized', () => {
  const s = sub('Prepaid', { price: 360, cycle: { unit: 'year', every: 3 }, start: '2025-01-01' });
  const st = state([s]);
  assert.ok(cashVsAccrual(st, today, 11, 3).some((r) => r.accrual > 0));
  assert.equal(get(scopeReport(st, [s], today), 'trend'), undefined);
});

test('events include trial end, nonrenewal and immediate stop, with original subscriptions for details', () => {
  const trial = sub('Trial', { start: '2026-10-01', trialEnd: '2026-10-31', status: 'trial' });
  const ending = sub('Ending', { end: '2026-10-30', status: 'cancelled' });
  const immediate = stopped({ id: 'Immediate', stop: { kind: 'cancel', date: '2026-10-10', paidThrough: '2026-12-31' } });
  const st = state([trial, ending, immediate]);
  const rows = get(monthReport(st, '2026-10', today), 'events')!.rows;
  assert.ok(rows.some((r) => r.kind === 'trial' && r.date === '2026-10-31' && r.sub === trial));
  assert.ok(rows.some((r) => r.kind === 'end' && r.date === '2026-10-31' && r.sub === ending));
  assert.ok(rows.some((r) => r.kind === 'cancel' && r.date === '2026-10-10' && r.sub === immediate));
  assert.ok(rows.every((r) => r.date >= '2026-10-01' && r.date <= '2026-10-31'));
});

test('sharing includes owner receipts in the window and only unpaid periods starting in the window', () => {
  const s = owner();
  const joined = sub('Joined', { share: { ...s.share!, role: 'member' } });
  const st = state([s, joined]);
  const oct = get(monthReport(st, '2026-10', today), 'sharing')!;
  assert.equal(oct.received, 4);
  assert.equal(oct.owed, 4);
  assert.equal(oct.rows.length, 1);
  assert.equal(oct.rows[0].sub, s);
  const year = get(scopeReport(st, st.subscriptions, today), 'sharing')!;
  assert.equal(year.received, 8);
  assert.equal(year.owed, memberDues(s, today, 'USD')[0].owed);
  assert.equal(get(monthReport(st, '2026-11', today), 'sharing')!.owed, 4);
});

test('missing stop FX stays incomplete and preserves the original-currency loss', () => {
  const s = stopped({ currency: 'XYZ' });
  const st = state([s]);
  const loss = get(scopeReport(st, [s], today), 'losses')!;
  assert.ok(Number.isNaN(loss.loss));
  assert.equal(loss.incomplete, true);
  assert.ok(loss.rows[0].loss > 0);
});

test('top is limited to five, refunds are not charges, and ties are stable', () => {
  const subs = Array.from({ length: 7 }, (_, i) => sub(String(i), { price: 10 + i, start: '2026-10-01' })).reverse();
  const st = state(subs);
  assert.deepEqual(
    get(scopeReport(st, subs, today), 'top')!.rows.map((r) => r.sub.id),
    ['6', '5', '4', '3', '2'],
  );
  const rows = get(monthReport(st, '2026-10', today), 'top')!.rows;
  assert.equal(rows.length, 5);
  assert.equal(rows[0].amount, chargeValue(st, { date: '2026-10-01', amount: 16, currency: 'USD', projected: false }));
});

test('proxy subscriptions never enter any block', () => {
  const own = sub('Own');
  const proxy = sub('Proxy', { ...stopped(), id: 'Proxy', proxy: { forName: 'Other' }, share: owner().share });
  const st = state([own, proxy]);
  assert.deepEqual(scopeReport(st, [own, proxy], today), scopeReport(st, [own], today));
  assert.deepEqual(monthReport(st, '2026-10', today), monthReport(state([own]), '2026-10', today));
});

test('mini calendar series uses six consecutive selected months and the exact full headline cash basis', () => {
  const s = owner();
  s.currency = 'EUR';
  s.payments = [
    { date: '2026-10-01', amount: 10, settled: { amount: 14, currency: 'USD' } },
    { date: '2026-10-22', amount: -30, kind: 'refund' },
    { date: '2026-10-23', amount: 999, kind: 'failed' },
  ];
  const st = state([s, sub('Proxy', { price: 999, proxy: { forName: 'Other' } })]);
  for (const month of ['2026-01', '2026-10', '2026-12']) {
    const report = monthReport(st, month, today);
    assert.equal(report.months.length, 6);
    assert.equal(report.months.at(-1)!.month, month);
    for (const row of report.months) {
      const headline = get(monthReport(st, row.month, today), 'headline')!;
      if (headline.mode !== 'month') assert.fail('month headline');
      assert.equal(row.total, headline.total);
      assert.equal(row.paid, headline.paid);
      assert.equal(row.pending, headline.pending);
      assert.ok(Math.abs(row.total - row.paid - row.pending) < 1e-10);
    }
  }
  const rows = monthReport(st, '2026-10', today).months;
  assert.equal(rows[0].month, '2026-05');
  assert.ok(rows.at(-1)!.paid < 0, 'refund-heavy months stay negative');
  assert.ok(rows.at(-1)!.total < 0);
  assert.equal(
    monthReport(state([]), '2026-10', today).months.every((r) => r.total === 0),
    true,
  );
});

test('movement before/after costs use the same end FX and keep FX drift separate', () => {
  const st = state(
    [
      sub('Euro', {
        currency: 'EUR',
        price: 20,
        priceHistory: [
          { from: '2025-01-01', amount: 10 },
          { from: '2026-10-12', amount: 20 },
        ],
      }),
    ],
    {
      fx: { rates: { USD: 1, EUR: 2 }, fetchedAt: today },
      fxHistory: { '2026-09-30': { USD: 1, EUR: 1 } },
    },
  );
  const trend = get(monthReport(st, '2026-10', today), 'trend')!;
  if (trend.mode !== 'month') assert.fail('month trend');
  assert.equal(trend.movement.fx, -5);
  assert.deepEqual(
    trend.movement.items.map((r) => [r.from, r.to, r.delta, r.since, r.until]),
    [[5, 10, 5, '2026-10-12', '2026-10-12']],
  );
  assert.equal(trend.movement.to - trend.movement.from, trend.movement.fx + trend.movement.items[0].delta);
});

test('movement without a ledger event shows the reporting window rather than an invented date', () => {
  const st = state([sub('Trial ended', { status: 'trial', trialEnd: '2026-10-10' })]);
  const trend = get(monthReport(st, '2026-10', today), 'trend')!;
  if (trend.mode !== 'month') assert.fail('month trend');
  assert.deepEqual(
    trend.movement.items.map((r) => [r.from, r.to, r.since, r.until]),
    [[0, 10, '2026-10-01', today]],
  );
});

test('没有持续计费的范围（如只看买断）改为累计花费头部、累计构成与排行；有计费订阅时仍是月成本', () => {
  const life = (id: string, price: number, start: string) =>
    sub(id, { price, cycle: { unit: 'lifetime', every: 1 }, start, category: id === 'B' ? 'Media' : 'Tools' });
  const subs = [life('A', 30, '2024-06-01'), life('B', 50, '2026-03-01')];
  const st = state(subs);
  const head = get(scopeReport(st, subs, today), 'headline')!;
  assert.equal(head.mode, 'total');
  if (head.mode !== 'total') return;
  assert.equal(head.total, 80);
  assert.equal(head.count, 2);
  assert.equal(head.average, 40);
  assert.equal(head.yearPaid, 50);
  assert.equal(head.since, '2024-06-01');
  const top = get(scopeReport(st, subs, today), 'top')!;
  assert.equal(top.mode, 'total');
  assert.deepEqual(
    top.rows.map((r) => [r.sub.id, r.amount]),
    [
      ['B', 50],
      ['A', 30],
    ],
  );
  const mixed = [...subs, sub('M')];
  assert.equal(get(scopeReport(state(mixed), mixed, today), 'headline')!.mode, 'scope');
});

test('year outlook: this year is paid plus forecast, same period compares Jan 1 through the same day', () => {
  const st = state([
    sub('Base'),
    sub('New', { price: 120, cycle: { unit: 'year', every: 1 }, start: '2026-03-15' }),
    sub('Gone', { price: 5, status: 'cancelled', end: '2025-12-31' }),
  ]);
  const r = yearOutlook(st, today);
  assert.equal(r.year, '2026');
  assert.deepEqual([r.current.total, r.current.paid, r.current.pending], [240, 220, 20]);
  assert.equal(r.samePeriod.previousThrough, '2025-10-22');
  assert.deepEqual([r.samePeriod.amount, r.samePeriod.previous], [220, 150]);
  assert.equal(r.samePeriod.change?.amount, 70);
  assert.ok(Math.abs(r.samePeriod.change!.percent! - 70 / 150) < 1e-9);
  assert.deepEqual(
    r.drivers.map((d) => [d.sub.id, d.kind, d.delta]),
    [
      ['New', 'added', 120],
      ['Gone', 'stopped', -50],
    ],
  );
  assert.deepEqual([r.nextMonth.month, r.nextMonth.total, r.nextMonth.paid], ['2026-11', 10, 0]);
  assert.deepEqual([r.nextYear.year, r.nextYear.total], ['2027', 240]);
  // 同一份年数，订阅列表的迷你报告也按「已付 + 预计」给出
  const head = get(scopeReport(st, st.subscriptions, today), 'headline');
  assert.ok(head?.mode === 'scope');
  assert.deepEqual([head.paid, head.year], [220, 240]);
});

test('year outlook maps Feb 29 to Feb 28 and keeps missing FX incomplete instead of zero', () => {
  assert.equal(yearOutlook(state([sub('A')]), '2028-02-29').samePeriod.previousThrough, '2027-02-28');
  const r = yearOutlook(state([sub('A', { currency: 'XXX' })]), today);
  assert.ok(r.current.partial.total.incomplete);
  assert.ok(Number.isNaN(r.samePeriod.change!.amount));
  // 去年同期没有支出时不做对比，也不列变化来源
  const fresh = yearOutlook(state([sub('A', { start: '2026-02-01' })]), today);
  assert.deepEqual([fresh.samePeriod.change, fresh.drivers], [undefined, []]);
});

test('month report carries the following month for the calendar three-month view', () => {
  const st = state([sub('Base')]);
  const r = monthReport(st, '2026-09', today);
  assert.deepEqual([r.months.at(-1)!.month, r.next.month], ['2026-09', '2026-10']);
  assert.deepEqual([r.next.total, r.next.paid, r.next.pending], [10, 10, 0]);
  assert.deepEqual([monthReport(st, '2026-10', today).next.pending], [10]);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { scopeFixtures, SCOPE_TODAY as today } from '../scripts/scope-report-fixtures.ts';
import { addDays, chargesBetween, myShareFactor, diffDays } from './billing.ts';
import { chargeTotal, scaleTotal, sumTotals } from './fx-total.ts';
import { contributionTotal, stopHistory, stopLosses } from './metrics.ts';
import { monthReport, scopeReport } from './scope-report.ts';
import { scopeReportOut } from '../worker/ai/report-tools.ts';

const data = scopeFixtures();
test('seven fictional Kiro subscriptions retain all six provider stops including full refunds and zero unused days', () => {
  const st = data.kiro;
  const report = scopeReport(st, st.subscriptions, today);
  const r = report.lifecycle!;
  assert.equal(r.terminatedCount, 6);
  assert.equal(r.stops.length, 6);
  assert.equal(r.stops.filter((r) => r.refundStatus === 'full').length, 2);
  assert.equal(r.stops.filter((r) => r.paidThrough === r.date).length, 1);
  assert.equal(stopLosses(st, today).items.length, 3, 'loss-only API retains its historical contract');
  assert.deepEqual(
    r.stops.map((s) => s.date),
    r.stops
      .map((s) => s.date)
      .sort()
      .reverse(),
  );
  const expected = st.subscriptions.flatMap((s) =>
    chargesBetween(s, s.start, today, today)
      .filter((c) => c.kind !== 'failed')
      .map((c) => scaleTotal(chargeTotal(st, c), myShareFactor(c.sub, c.date))),
  );
  assert.deepEqual(r.spent, sumTotals(expected));
  assert.equal(r.spent.value, 490);
  assert.equal(r.activeCount, 1);
  const duration = st.subscriptions.reduce((n, s) => n + diffDays(s.start, s.stop?.date ?? today), 0) / 7;
  assert.equal(r.averageDays, duration);
  assert.equal(
    r.spending.reduce((n, r) => n + r.total.value, 0),
    r.spent.value,
  );
  assert.equal(report.blocks.find((b) => b.type === 'trend')?.mode, 'scope');
});

test('all stopped, no provider stops, a single subscription and empty selection retain finite lifecycle facts', () => {
  const stopped = scopeReport(data.stopped, data.stopped.subscriptions, today).lifecycle!;
  assert.equal(stopped.activeCount, 0);
  // 全部停用时给出停用前的月成本，不显示成「—」
  const lastMonthly = sumTotals(
    data.stopped.subscriptions.map((s) => contributionTotal(data.stopped, s, s.stop ? addDays(s.stop.date, -1) : (s.end ?? today))),
  );
  assert.ok(stopped.stoppedMonthly.value > 0);
  assert.deepEqual(stopped.stoppedMonthly, lastMonthly);
  const ordinary = scopeReport(data.ordinary, data.ordinary.subscriptions, today).lifecycle!;
  assert.equal(ordinary.terminatedCount, 0);
  assert.equal(ordinary.stoppedCount, 1);
  assert.equal(scopeReport(data.single, data.single.subscriptions, today).lifecycle!.averageDays, 46);
  assert.equal(scopeReport(data.single, [], today).lifecycle!.averageDays, 0);
});

test('lifetime spending retains my share, negative refunds and missing currency originals', () => {
  const st = structuredClone(data.missing);
  const s = st.subscriptions[1];
  s.share = { role: 'owner', seats: 2, members: [{ id: 'm', name: 'Fictional Member', share: 60 }] };
  const r = scopeReport(st, st.subscriptions, today).lifecycle!;
  assert.equal(r.spent.incomplete, true);
  assert.equal(r.spent.value, 120);
  assert.equal(r.spent.unconverted.XCD, 60);
  const one = structuredClone(data.single);
  one.subscriptions[0].payments = [{ date: '2026-10-20', amount: -60, kind: 'refund' }];
  assert.equal(scopeReport(one, one.subscriptions, today).lifecycle!.spent.value, -40);
});

test('timeline caps at the twelve highest cumulative costs and current-month cash excludes future charges', () => {
  const st = structuredClone(data.single);
  st.subscriptions = Array.from({ length: 14 }, (_, i) => ({
    ...st.subscriptions[0],
    id: `${i}`,
    name: `Demo ${String(14 - i).padStart(2, '0')}`,
    price: i + 1,
    start: '2026-10-01',
  }));
  const r = scopeReport(st, st.subscriptions, today).lifecycle!;
  assert.equal(r.timeline.length, 12);
  assert.equal(r.omitted, 2);
  assert.deepEqual(
    r.timeline.map((s) => s.price).sort((a, b) => b - a),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
  );
  const chronological = structuredClone(data.single);
  chronological.subscriptions = [
    { ...chronological.subscriptions[0], id: 'old', start: '2025-01-01', name: 'Old' },
    { ...chronological.subscriptions[0], id: 'new-b', start: '2026-10-01', name: 'Beta' },
    { ...chronological.subscriptions[0], id: 'new-a', start: '2026-10-01', name: 'Alpha' },
  ];
  assert.deepEqual(
    scopeReport(chronological, chronological.subscriptions, today).lifecycle!.timeline.map((s) => s.id),
    ['new-a', 'new-b', 'old'],
  );
  const future = { ...st.subscriptions[0], start: '2026-10-30' };
  const report = scopeReport({ ...st, subscriptions: [future] }, [future], today);
  assert.equal(report.lifecycle!.spent.value, 0);
  const trend = report.blocks.find((b) => b.type === 'trend');
  assert.equal(trend, undefined);
});

test('timeline orders recent starts first and same-day names alphabetically after selecting the cost leaders', () => {
  const st = structuredClone(data.single);
  const sub = st.subscriptions[0];
  st.subscriptions = [
    { ...sub, id: 'old', name: 'Old', start: '2025-01-01' },
    { ...sub, id: 'z', name: 'Zulu', start: '2026-09-01' },
    { ...sub, id: 'a', name: 'Alpha', start: '2026-09-01' },
    { ...sub, id: 'new', name: 'New', start: '2026-10-01' },
  ];
  assert.deepEqual(
    scopeReport(st, st.subscriptions, today).lifecycle!.timeline.map((s) => s.id),
    ['new', 'a', 'z', 'old'],
  );
});

test('stop history retains separate historical phase stops without leaking proxy records', () => {
  const st = structuredClone(data.kiro);
  const [a, b] = st.subscriptions;
  const combined = {
    ...b,
    start: a.start,
    phases: [a, b].map((s) => ({
      start: s.start,
      end: s.end,
      price: s.price,
      currency: s.currency,
      cycle: s.cycle,
      status: s.status,
      stop: s.stop,
      payments: s.payments,
    })),
  };
  st.subscriptions = [combined, { ...a, id: 'proxy', proxy: { forName: 'Fictional Person' } }];
  assert.equal(stopHistory(st, today).length, 2);
  assert.equal(scopeReport(st, st.subscriptions, today).lifecycle!.terminatedCount, 2);
});

test('MCP preserves legacy headline fields and adds lifetime, duration and all stop details', () => {
  const out = scopeReportOut(data.kiro, today, undefined);
  assert.equal(out.lifecycle!.terminated_count, 6);
  assert.equal(out.lifecycle!.cumulative_spending.total, 490);
  assert.equal(out.lifecycle!.stops.length, 6);
  assert.ok(!('saved' in out.lifecycle!));
  for (const key of ['unrefunded_loss', 'termination_loss', 'stops', 'timeline', 'spending']) assert.ok(key in out.lifecycle!);
  const head = out.blocks.find((b) => b.type === 'headline')!;
  for (const key of ['mrr', 'annual', 'active_count', 'paid_this_year', 'stop_loss_this_year', 'mrr_change_since_last_month']) assert.ok(key in head);
  const missing = scopeReportOut(data.missing, today, undefined);
  assert.equal(missing.lifecycle!.cumulative_spending.total, null);
  assert.equal(missing.lifecycle!.cumulative_spending.known_total, 120);
  assert.equal(missing.lifecycle!.cumulative_spending.incomplete, true);
});

test('calendar month output stays frozen across historical, current, future and missing-FX fixtures', () => {
  const output = Object.values(data).flatMap((s) => ['2025-02', '2026-10', '2026-12'].map((m) => monthReport(s, m, today)));
  // 只新增 next（下一个月），其余字段与原冻结值一致
  assert.equal(createHash('sha256').update(JSON.stringify(output)).digest('hex'), 'b8f84d662440ff61291303a3eb35d40bf32fd8c73de65b236eba9058dbe3ec0f');
});

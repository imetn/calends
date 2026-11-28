import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  billingPeriod,
  chargesBetween,
  migrateRenewalRules,
  newShapeError,
  nextCharge,
  nonrenewalDate,
  preserveRenewalHistory,
  reconcileRenewalRules,
  renewalDates,
  subError,
} from './billing.ts';
import { cancelAtEnd, removePhase, stopSubscription, switchPlan, syncPhase, toEditForm } from './phases.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { maskForPublic } from './mask.ts';
import { parseBackup } from '../worker/backup.ts';
import { buildDaily } from '../worker/notify.ts';
import { stopForm } from './stop-form.ts';

const sub = (patch: Partial<Subscription> = {}): Subscription => ({
  id: 'fictional',
  name: 'Fictional service',
  category: 'Tools',
  tags: [],
  price: 12,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-31',
  status: 'active',
  ...patch,
});
const dates = (s: Subscription, from = s.start, to = '2027-04-30') => chargesBetween(s, from, to, '2026-10-22').map((c) => c.date);
const state = (s: Subscription): AppState => ({
  subscriptions: [s],
  methods: [],
  settings: { ...DEFAULT_SETTINGS, remindDays: 3 },
  fx: { base: 'USD', fetchedAt: '2026-10-22', rates: { USD: 1 } },
});

test('monthly lead preserves month-end service anchors and first purchase', () => {
  const s = sub({ chargeLeadDays: 5, cancelLeadDays: 1 });
  assert.deepEqual(dates(s, s.start, '2026-04-30'), ['2026-01-31', '2026-02-23', '2026-03-26', '2026-04-25']);
  assert.deepEqual(renewalDates(s, '2026-02-01'), {
    nextCharge: '2026-02-23',
    serviceExpires: '2026-02-28',
    cancelBy: '2026-02-22',
  });
});
test('annual and multi-year lead crosses year boundary and leap days', () => {
  for (const every of [1, 2, 3]) {
    const s = sub({ start: '2024-02-29', cycle: { unit: 'year', every }, chargeLeadDays: 90 });
    assert.equal(nextCharge(s, '2024-03-01'), `${2023 + every}-11-30`);
    assert.equal(renewalDates(s, '2024-03-01').serviceExpires, `${2024 + every}-02-28`);
  }
});
test('lead crossing a month uses day subtraction, not a shifted monthly anchor', () => {
  const s = sub({ start: '2026-03-01', chargeLeadDays: 10 });
  assert.deepEqual(dates(s, '2026-03-02', '2026-05-31'), ['2026-03-22', '2026-04-21', '2026-05-22']);
});
test('future phase rules remain independent from earlier phase', () => {
  const old = sub({ chargeLeadDays: 5 });
  const s = switchPlan(old, '2026-06-01', { price: 20, currency: 'USD', cycle: { unit: 'year', every: 1 }, chargeLeadDays: 30, cancelLeadDays: 1 });
  assert.deepEqual(dates(s, '2026-05-01', '2027-06-30'), ['2026-05-26', '2026-06-01', '2027-05-02']);
  assert.equal(toEditForm(s, '2026-04-01').chargeLeadDays, 5);
  assert.equal(removePhase(s, 1).chargeLeadDays, 5);
});
test('trial converts on trial end; subsequent renewals charge in advance', () => {
  const s = sub({ start: '2026-01-01', status: 'trial', trialEnd: '2026-02-01', chargeLeadDays: 5, cancelLeadDays: 1 });
  assert.deepEqual(dates(s, s.start, '2026-03-31'), ['2026-02-01', '2026-02-24', '2026-03-27']);
  assert.equal(renewalDates(s, '2026-01-20').cancelBy, '2026-01-31');
});
test('recorded payments, settlement and refunds stay untouched with future inference', () => {
  const payments = [
    { date: '2026-01-31', amount: 7, settled: { amount: 50, currency: 'CNY' } },
    { date: '2026-02-23', amount: 8 },
  ];
  const s = sub({ chargeLeadDays: 5, payments });
  assert.deepEqual(dates(s, s.start, '2026-04-30'), ['2026-01-31', '2026-02-23', '2026-03-26', '2026-04-25']);
  assert.deepEqual(chargesBetween(s, s.start, '2026-02-28', '2026-10-22')[0].settled, payments[0].settled);
  assert.deepEqual(s.payments, payments);
  assert.equal(billingPeriod(s, '2026-02-25').paidThrough, '2026-03-30');
});
test('explicit nextDue is a cash date and preserves month-end alignment', () => {
  const s = sub({ chargeLeadDays: 5, payments: [{ date: '2026-01-31', amount: 12 }], nextDue: '2026-02-23' });
  assert.deepEqual(dates(s, '2026-02-01', '2026-04-30'), ['2026-02-23', '2026-03-26', '2026-04-25']);
});
test('rule edit preserves old inferred history and only changes later cash', () => {
  const old = sub();
  const next = preserveRenewalHistory(old, { ...old, chargeLeadDays: 5, cancelLeadDays: 1 }, '2026-10-22');
  assert.deepEqual(dates(next, old.start, '2026-10-21'), dates(old, old.start, '2026-10-21'));
  assert.equal(nextCharge(next, '2026-10-22'), '2026-10-26');
  const second = preserveRenewalHistory(next, { ...next, chargeLeadDays: 10 }, '2026-11-02');
  assert.equal(nextCharge(second, '2026-11-03'), '2026-11-20');
  assert.deepEqual(dates(second, old.start, '2026-11-01'), dates(next, old.start, '2026-11-01'));
});
test('increasing lead catches a pending boundary today; decreasing lead never charges a paid boundary twice', () => {
  const old = sub({ start: '2026-01-01' });
  const early = preserveRenewalHistory(old, { ...old, chargeLeadDays: 20 }, '2026-01-25');
  assert.equal(nextCharge(early, '2026-01-25'), '2026-01-25');
  const later = preserveRenewalHistory(early, { ...early, chargeLeadDays: 0 }, '2026-01-26');
  assert.equal(nextCharge(later, '2026-01-26'), '2026-03-01');
});
test('editing a current phase preserves prior phase rules and records', () => {
  const original = switchPlan(sub({ chargeLeadDays: 3 }), '2026-06-01', { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const next = syncPhase(preserveRenewalHistory(original, { ...toEditForm(original, '2026-10-22'), chargeLeadDays: 5 }, '2026-10-22'), '2026-10-22');
  assert.deepEqual(next.phases![0], original.phases![0]);
  assert.equal(next.phases![1].chargeLeadDays, 5);
});
test('service paid-through follows purchased coverage after an advance charge', () => {
  const s = sub({ start: '2026-01-01', cycle: { unit: 'year', every: 1 }, chargeLeadDays: 30 });
  assert.equal(billingPeriod(s, '2026-12-01').paidThrough, '2026-12-31');
  assert.equal(billingPeriod(s, '2026-12-02').paidThrough, '2027-12-31');
  const stopped = stopSubscription(s, '2026-12-10', 'cancel');
  assert.equal(stopped.stop!.paidThrough, '2027-12-31');
  assert.equal(nextCharge(stopped, '2026-12-11'), undefined);
});
test('nonrenew defaults before actual charge; late cancellation includes next paid period', () => {
  const s = sub({ start: '2026-01-01', cycle: { unit: 'year', every: 1 }, chargeLeadDays: 30, cancelLeadDays: 1 });
  assert.equal(nonrenewalDate(s, '2026-10-22'), '2026-12-01');
  assert.equal(stopForm(s, '2026-10-22').date, '2026-12-01');
  assert.equal(nonrenewalDate(s, '2026-12-02'), '2027-12-31');
  assert.equal(nextCharge(cancelAtEnd(s, '2026-12-01', '2026-10-22'), '2026-10-22'), undefined);
});
test('stopped, paused and lifetime records do not invent renewal deadlines', () => {
  for (const s of [
    sub({ end: '2026-05-31', chargeLeadDays: 5 }),
    sub({ status: 'paused', chargeLeadDays: 5 }),
    sub({ cycle: { unit: 'lifetime', every: 1 }, cancelLeadDays: 1 }),
  ])
    assert.deepEqual(renewalDates(s, '2026-10-22'), {});
});
test('legacy expires migration is deterministic, idempotent and preserves dates', () => {
  const old = sub({ start: '2025-12-02', cycle: { unit: 'year', every: 1 }, expires: '2027-01-01' });
  const migrated = migrateRenewalRules(old);
  assert.equal(migrated.chargeLeadDays, 30);
  assert.deepEqual(dates(migrated), dates({ ...old, expires: undefined }));
  assert.deepEqual(renewalDates(migrated, '2026-10-22'), { nextCharge: '2026-12-02', serviceExpires: '2027-01-01', cancelBy: undefined });
  assert.equal(renewalDates(migrated, '2026-12-03').serviceExpires, '2028-01-01');
  assert.deepEqual(migrateRenewalRules(migrated), migrated);
});
test('legacy backups keep their version, preserve actual payments and round-trip rules', () => {
  const s = sub({ start: '2025-12-02', cycle: { unit: 'year', every: 1 }, expires: '2027-01-01', payments: [{ date: '2025-12-02', amount: 10 }] });
  const backup = parseBackup({ version: 1, subscriptions: [s] });
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.subscriptions[0].payments, s.payments);
  assert.equal(backup.subscriptions[0].chargeLeadDays, 30);
  assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(backup))), backup);
});
test('public cash dates agree with private dates without exposing notes', () => {
  const s = sub({ chargeLeadDays: 5, cancelLeadDays: 1, notes: 'private' });
  const masked = maskForPublic(state(s)).subscriptions[0];
  assert.deepEqual(dates(masked), dates(s));
  assert.equal(masked.notes, undefined);
});
test('charge and cancellation reminders use independent dates and existing lead setting', () => {
  const s = sub({ start: '2026-01-01', chargeLeadDays: 5, cancelLeadDays: 1 });
  const st = state(s);
  const cancellation = buildDaily(st, '2026-01-23');
  assert.ok(cancellation?.sections.some((section) => section.rows.some((row) => row.days === 3)));
  const charge = buildDaily(st, '2026-01-24');
  assert.ok(charge?.sections.some((section) => section.rows.some((row) => row.days === 3)));
  st.subscriptions[0].remindDays = -1;
  assert.equal(buildDaily(st, '2026-01-23'), undefined);
});
test('rule validation rejects negative, fractional, excessive and invalid-history inputs', () => {
  for (const value of [-1, 1.5, 3661, NaN, Infinity]) assert.ok(subError(sub({ chargeLeadDays: value })));
  assert.equal(subError(sub({ chargeLeadDays: 0, cancelLeadDays: 1 })), undefined);
  assert.ok(subError(sub({ renewalHistory: [{ from: 'bad', chargeLeadDays: 0, cancelLeadDays: 0 }] })));
});

test('cash reports move the debit while service accrual keeps the original period', async () => {
  const { cashVsAccrual } = await import('./metrics.ts');
  const s = sub({ start: '2026-01-01', cycle: { unit: 'year', every: 1 }, chargeLeadDays: 30 });
  const report = cashVsAccrual(state(s), '2026-12-15', 1, 1);
  assert.equal(report.find((r) => r.month === '2026-12')!.cash, 12);
  assert.ok(report.find((r) => r.month === '2026-12')!.accrual < 2);
  assert.ok(report.find((r) => r.month === '2027-01')!.accrual < 2);
});

test('ICS uses cash dates and adds a cancellation alarm using the same reminder days', async () => {
  const { buildIcs } = await import('../worker/ics.ts');
  const { todayIn, addMonths, nthCharge, addDays } = await import('./billing.ts');
  const today = todayIn('UTC');
  const s = sub({ start: addMonths(today, -1), chargeLeadDays: 5, cancelLeadDays: 1 });
  const ics = buildIcs(state(s), 'https://fictional.example');
  const boundary = nthCharge(s.start, s.cycle, 2);
  assert.ok(ics.includes(`DTSTART;VALUE=DATE:${addDays(boundary, -5).replaceAll('-', '')}`));
  assert.ok(ics.includes('TRIGGER:-P3DT15H'));
  assert.ok(ics.includes('TRIGGER:-P2DT15H'));
});

test('later descriptive saves cannot erase the preserved renewal history', async () => {
  const { reconcileRenewalRules } = await import('./billing.ts');
  const old = sub();
  const ruled = preserveRenewalHistory(old, { ...old, chargeLeadDays: 5 }, '2026-10-22');
  const saved = reconcileRenewalRules(ruled, { ...ruled, notes: 'Renamed', renewalHistory: undefined }, '2026-11-01');
  assert.deepEqual(dates(saved, old.start, '2026-10-21'), dates(old, old.start, '2026-10-21'));
});

test('advance payment adjustments remain paid and refunds before coverage cannot exceed the charge', () => {
  const s = sub({
    start: '2026-01-01',
    cycle: { unit: 'year', every: 1 },
    chargeLeadDays: 30,
    payments: [
      { date: '2026-01-01', amount: 12 },
      { date: '2026-12-02', amount: 12 },
      { date: '2026-12-03', amount: 2, kind: 'adjust' },
    ],
  });
  assert.equal(billingPeriod(s, '2026-12-05').paid, 14);
  const stopped = stopSubscription(s, '2026-12-05', 'cancel');
  assert.ok(subError({ ...stopped, payments: [...stopped.payments!, { date: '2026-12-05', amount: -15, kind: 'refund' }] }));
});

test('bonus service keeps its service boundary and advance cash date with cancellation rule edits', () => {
  const old = sub({ start: '2026-01-01', chargeLeadDays: 5, bonus: { from: '2026-02-01', until: '2026-03-15' } });
  const s = preserveRenewalHistory(old, { ...old, cancelLeadDays: 1 }, '2026-01-10');
  assert.equal(nextCharge(s, '2026-02-01'), '2026-03-10');
  assert.equal(billingPeriod(s, '2026-01-20').paidThrough, '2026-03-14');
});

test('legacy inference keeps historical prices and stopped paid-through dates unchanged', () => {
  const old = sub({
    start: '2025-12-02',
    cycle: { unit: 'year', every: 1 },
    expires: '2027-01-01',
    priceHistory: [
      { from: '2025-12-02', amount: 12 },
      { from: '2026-12-15', amount: 18 },
    ],
  });
  const original = chargesBetween({ ...old, expires: undefined }, old.start, '2028-01-01', '2026-10-22');
  const migrated = chargesBetween(migrateRenewalRules(old), old.start, '2028-01-01', '2026-10-22');
  assert.deepEqual(
    migrated.map((c) => [c.date, c.amount]),
    original.map((c) => [c.date, c.amount]),
  );
  const stopped = stopSubscription({ ...old, expires: undefined }, '2026-10-01', 'cancel');
  const legacyStop = migrateRenewalRules({ ...stopped, expires: old.expires });
  assert.deepEqual(legacyStop.stop, stopped.stop);
  assert.equal(subError(legacyStop), undefined);
});

test('migrateRenewalRules never turns multi-year, bonus or ended expires into chargeLeadDays', () => {
  // 5-year switch with deprecated expires set to the next 5-year expiry (1826d away)
  const fiveYear = sub({
    start: '2026-11-28',
    cycle: { unit: 'year', every: 5 },
    expires: '2031-11-28',
    payments: [{ date: '2026-11-28', amount: 100 }],
  });
  const migrated5y = migrateRenewalRules(fiveYear);
  assert.equal(migrated5y.chargeLeadDays, 0);
  assert.equal(migrated5y.renewalOffsetDays, undefined);

  // Bonus period extending expiry 426 days beyond payment
  const withBonus = sub({
    start: '2026-11-29',
    cycle: { unit: 'year', every: 1 },
    bonus: { from: '2027-11-29', until: '2028-01-28' },
    expires: '2028-01-28',
    payments: [{ date: '2026-11-29', amount: 50 }],
  });
  const migratedBonus = migrateRenewalRules(withBonus);
  assert.equal(migratedBonus.chargeLeadDays, 0);
  assert.equal(migratedBonus.renewalOffsetDays, undefined);

  // Ended / non-renewing subscription with expires
  const ending = sub({
    start: '2026-11-28',
    cycle: { unit: 'year', every: 1 },
    end: '2027-11-20',
    expires: '2027-11-20',
  });
  assert.equal(migrateRenewalRules(ending).chargeLeadDays, 0);
});

test('renewalDates skips same-day recorded payments and covers multi-year and bonus horizons', () => {
  const fiveYear = sub({
    start: '2025-11-28',
    cycle: { unit: 'year', every: 5 },
    phases: [
      {
        start: '2025-11-28',
        end: '2026-11-27',
        price: 20,
        currency: 'USD',
        cycle: { unit: 'year', every: 1 },
        payments: [{ date: '2025-11-28', amount: 20 }],
      },
      {
        start: '2026-11-28',
        price: 100,
        currency: 'USD',
        cycle: { unit: 'year', every: 5 },
        payments: [{ date: '2026-11-28', amount: 100 }],
      },
    ],
  });
  assert.deepEqual(renewalDates(fiveYear, '2026-11-28'), {
    nextCharge: '2031-11-28',
    serviceExpires: '2031-11-28',
    cancelBy: undefined,
  });

  // Unpaid first day of a new 5-year phase reports the end of the first period, not today
  const unpaidFirstDay = sub({
    start: '2026-11-28',
    cycle: { unit: 'year', every: 5 },
  });
  assert.deepEqual(renewalDates(unpaidFirstDay, '2026-11-28'), {
    nextCharge: '2026-11-28',
    serviceExpires: '2031-11-28',
    cancelBy: undefined,
  });

  // Non-renewing subscription already paid today has no next renewal
  const nonRenewing = sub({
    start: '2026-11-28',
    cycle: { unit: 'year', every: 1 },
    end: '2027-11-20',
    payments: [{ date: '2026-11-28', amount: 50 }],
  });
  assert.deepEqual(renewalDates(nonRenewing, '2026-11-28'), {});
});

test('reconcileRenewalRules isolates historical phases from top-level fields and honors explicit clears', () => {
  const previous = sub({
    start: '2025-11-28',
    cycle: { unit: 'year', every: 1 },
    chargeLeadDays: 0,
    renewalOffsetDays: 426,
    renewalHistory: [{ from: '2025-11-28', chargeLeadDays: 426, cancelLeadDays: 0 }],
    phases: [
      {
        start: '2025-11-28',
        end: '2026-11-27',
        price: 20,
        currency: 'USD',
        cycle: { unit: 'year', every: 1 },
        chargeLeadDays: 0,
        renewalOffsetDays: 426,
        renewalHistory: [{ from: '2025-11-28', chargeLeadDays: 426, cancelLeadDays: 0 }],
      },
    ],
  });
  const next = sub({
    start: '2025-11-28',
    cycle: { unit: 'year', every: 5 },
    nextDue: '2031-11-28',
    chargeLeadDays: 0,
    phases: [
      {
        start: '2025-11-28',
        end: '2026-11-27',
        price: 20,
        currency: 'USD',
        cycle: { unit: 'year', every: 1 },
        chargeLeadDays: 0,
        renewalHistory: [],
        renewalOffsetDays: 0,
      },
      {
        start: '2026-11-28',
        price: 100,
        currency: 'USD',
        cycle: { unit: 'year', every: 5 },
        nextDue: '2031-11-28',
        renewalHistory: [],
        renewalOffsetDays: 0,
      },
    ],
  });
  const reconciled = reconcileRenewalRules(previous, next, '2026-11-28');
  assert.equal(reconciled.phases?.[0].nextDue, undefined);
  assert.equal(reconciled.phases?.[0].renewalHistory, undefined);
  assert.equal(reconciled.phases?.[0].renewalOffsetDays, undefined);
  assert.equal(reconciled.phases?.[1].nextDue, '2031-11-28');
  assert.equal(reconciled.phases?.[1].renewalHistory, undefined);
  assert.equal(reconciled.renewalHistory, undefined);
  assert.equal(reconciled.renewalOffsetDays, undefined);
});

test('newShapeError rejects a bonus period whose end is on or before its start', () => {
  const baseSub = sub({ start: '2026-11-29', cycle: { unit: 'year', every: 1 } });
  assert.ok(newShapeError(baseSub, { ...baseSub, bonus: { from: '2027-11-29', until: '2027-11-29' } }));
  assert.ok(newShapeError(baseSub, { ...baseSub, bonus: { from: '2027-11-29', until: '2027-01-01' } }));
  assert.equal(newShapeError(baseSub, { ...baseSub, bonus: { from: '2027-11-29', until: '2028-01-28' } }), undefined);
});

test('review regressions: historical bonus keeps valid advance lead, key-order-independent history, and malformed bonus.until safety', () => {
  // Historical bonus ended before the charge: genuine 30-day advance-charge expires still migrates
  const pastBonus = sub({
    start: '2024-01-01',
    cycle: { unit: 'year', every: 1 },
    bonus: { from: '2024-02-01', until: '2024-03-01' },
    expires: '2026-03-31',
    payments: [
      { date: '2024-01-01', amount: 12 },
      { date: '2025-03-01', amount: 12 },
      { date: '2026-03-01', amount: 12 },
    ],
  });
  assert.equal(migrateRenewalRules(pastBonus).chargeLeadDays, 30);

  // Reordered keys in unchanged renewalHistory still append a new effective-day point on lead edit
  const prev = sub({
    start: '2026-01-01',
    chargeLeadDays: 5,
    renewalHistory: [{ from: '2026-01-01', chargeLeadDays: 5, cancelLeadDays: 0 }],
  });
  const reordered = {
    ...prev,
    chargeLeadDays: 10,
    renewalHistory: [{ cancelLeadDays: 0, chargeLeadDays: 5, from: '2026-01-01' }],
  };
  const preserved = preserveRenewalHistory(prev, reordered, '2026-06-01');
  assert.equal(preserved.renewalHistory?.length, 2);
  assert.equal(preserved.renewalHistory?.[1].chargeLeadDays, 10);

  // Malformed legacy bonus.until must never throw RangeError in nextCharge/renewalDates
  const legacyBadBonus = sub({ start: '2026-01-01', bonus: { from: '2026-02-01', until: '9999-99-99' } });
  assert.doesNotThrow(() => nextCharge(legacyBadBonus, '2026-06-01'));
  assert.doesNotThrow(() => renewalDates(legacyBadBonus, '2026-06-01'));

  // Explicit empty renewalHistory clears even when previous had only an implicit lead without history
  const implicitLead = sub({ start: '2025-01-01', chargeLeadDays: 30, renewalOffsetDays: 30 });
  const cleared = preserveRenewalHistory(implicitLead, { ...implicitLead, chargeLeadDays: 0, renewalOffsetDays: 0, renewalHistory: [] }, '2026-06-01');
  assert.equal(cleared.renewalHistory, undefined);
  assert.equal(cleared.renewalOffsetDays, undefined);
});

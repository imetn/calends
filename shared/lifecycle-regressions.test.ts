// 订阅生命周期的回归用例：阶段隔离、日期未知的停用、试用到期后的提前续费、暂停日
import test from 'node:test';
import assert from 'node:assert/strict';
import { chargesBetween, effectiveStatus, nextCharge } from './billing.ts';
import { cancelAtEnd, deletePayment, dropPlan, resume, savePayment, statusChangeError, stopSubscription, stopUndated, switchPlan } from './phases.ts';
import { applyStopForm, editStop, stopForm } from './stop-form.ts';
import type { Subscription } from './types.ts';

const today = '2026-11-08';
const month = { unit: 'month', every: 1 } as const;
const plan = { price: 20, currency: 'USD', cycle: month };
const base = (o: Partial<Subscription> = {}): Subscription =>
  ({ id: 'x', name: 'x', category: 'c', tags: [], price: 10, currency: 'USD', cycle: month, start: '2024-01-15', status: 'active', ...o }) as Subscription;
const past = (s: Subscription) => chargesBetween(s, '2000-01-01', today, today);
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const twoPhases = (last: object) => json(switchPlan(base(), '2026-06-01', { ...plan, ...last }));

test('first edit on an older phase keeps its own price instead of the last phase intro', () => {
  const s = twoPhases({ intro: { price: 1, until: '2028-01-01' } });
  const next = savePayment(s, today, { date: '2024-02-15', amount: 9 }, { date: '2024-02-15', index: 0 });
  const old = next.phases!.find((p) => p.start === '2024-01-15')!;
  assert.ok(old.payments!.filter((p) => p.date !== '2024-02-15').every((p) => p.amount === 10));
  assert.equal(old.payments!.find((p) => p.date === '2024-02-15')!.amount, 9);
});

test('deleting from an older phase is not shifted by a postpaid last phase', () => {
  const s = twoPhases({ billing: 'postpaid' });
  const old = deletePayment(s, today, '2024-02-15', 0).phases!.find((p) => p.start === '2024-01-15')!;
  assert.equal(old.payments![0].date, '2024-01-15');
  assert.equal(
    old.payments!.some((p) => p.date === '2024-02-15'),
    false,
  );
});

test('editing another field of an undated cancellation keeps the date unknown', () => {
  const s = stopUndated(base({ payments: [{ date: '2024-01-15', amount: 10 }] }), 'cancel', today);
  const edited = { ...s, notes: 'n' };
  const out = applyStopForm(edited, stopForm(edited, today), today);
  assert.equal(out.end, undefined);
  assert.equal(effectiveStatus(out, today), 'ended');
  assert.equal(past(out).length, 1);
});

test('an untouched stop form is unchanged whatever the settlement currency default is', () => {
  const s = stopUndated(base(), 'cancel', today);
  assert.equal(applyStopForm(s, { ...stopForm(s, today), settledCurrency: 'CNY' }, today).end, undefined);
});

test('an undated termination stays editable and can be given its real date', () => {
  const s = stopUndated(base(), 'terminate', today);
  const form = stopForm(s, today);
  assert.equal(form.mode, 'terminate');
  const out = applyStopForm({ ...s, notes: 'n' }, form, today);
  assert.equal(out.status, 'terminated');
  assert.equal(statusChangeError(s, out, today), undefined);
  const dated = editStop(s, { mode: 'terminate', date: '2026-10-20' }, today);
  assert.equal(dated.stop?.date, '2026-10-20');
  assert.equal(statusChangeError(dated, resume(dated, today, plan), today), undefined);
});

test('an undated termination stops projecting, like an undated cancellation', () => {
  const s = stopUndated(base(), 'terminate', today);
  assert.equal(past(s).length, 1);
  assert.equal(nextCharge(s, today), undefined);
});

test('resume and switch refuse to invent an end for an unknown stop date', () => {
  for (const kind of ['cancel', 'terminate'] as const) {
    const s = stopUndated(base(), kind, today);
    assert.throws(() => resume(s, today, plan));
    assert.throws(() => switchPlan(s, today, plan));
  }
});

test('switching after a subscription ended keeps its end and leaves the gap', () => {
  const next = switchPlan(cancelAtEnd(base(), '2025-01-31', today), today, plan);
  assert.equal(next.phases![0].end, '2025-01-31');
  assert.equal(past(next).length, 14);
});

test('switching before a future end still shortens the old phase', () => {
  const s = cancelAtEnd(base(), '2027-05-31', today);
  assert.equal(switchPlan(s, '2026-12-01', plan).phases![0].end, '2026-11-30');
});

test('an undated stop discards the future end of the last phase', () => {
  const s = json(switchPlan(base(), '2026-06-01', plan));
  s.phases!.at(-1)!.end = '2027-05-31';
  const next = stopUndated(s, 'cancel', today);
  assert.equal(next.phases!.at(-1)!.end, undefined);
  assert.equal(effectiveStatus(next, today), 'ended');
  assert.equal(nextCharge(next, today), undefined);
});

test('an early renewal after the trial ended rolls the next due date forward', () => {
  const s = base({ status: 'trial', trialEnd: '2026-10-15', start: '2026-09-15', payments: [{ date: '2026-10-15', amount: 10 }] });
  const next = savePayment(s, today, { date: '2026-11-10', amount: 10 });
  assert.equal(next.nextDue, '2026-12-15');
  assert.equal(next.payments!.at(-1)!.serviceDate, '2026-11-15');
});

test('a payment during the trial is not an early renewal', () => {
  const s = base({ status: 'trial', trialEnd: '2026-12-15', start: '2026-09-15', payments: [{ date: '2026-10-15', amount: 10 }] });
  assert.equal(savePayment(s, today, { date: '2026-10-20', amount: 10 }).payments!.at(-1)!.serviceDate, undefined);
});

test('a pause dated in the future reads as active until that day', () => {
  const s = base({ status: 'paused', pausedAt: '2027-03-01' });
  assert.equal(effectiveStatus(s, today), 'active');
  assert.equal(effectiveStatus(s, '2027-03-01'), 'paused');
  assert.equal(nextCharge(s, today), '2026-11-15');
});

test('a pause before the start date is rejected; an existing one is left alone', () => {
  const s = base({ status: 'paused', pausedAt: '2023-12-01' });
  assert.ok(statusChangeError(base(), s, today));
  assert.equal(statusChangeError(s, { ...s, notes: 'n' }, today), undefined);
});

test('a stop dated today is already ended', () => {
  assert.equal(effectiveStatus(stopSubscription(base(), today, 'cancel', today), today), 'ended');
});

test('an older phase is materialized with its own status, trial, end and renewal rules', () => {
  const trial = twoPhases({});
  Object.assign(trial, { status: 'trial', trialEnd: '2027-01-01' });
  const old = savePayment(trial, today, { date: '2024-02-15', amount: 9 }, { date: '2024-02-15', index: 0 }).phases![0];
  assert.equal(old.payments!.length, 29);

  const legacy = json(twoPhases({}));
  Object.assign(legacy, { expires: '2026-12-05', chargeLeadDays: 0 });
  const kept = deletePayment(legacy, today, '2024-02-15', 0).phases![0];
  assert.equal(kept.payments!.at(-1)!.date, '2026-05-15');

  const open = json(twoPhases({}));
  delete open.phases![0].end;
  const bounded = savePayment(open, today, { date: '2024-02-15', amount: 9 }, { date: '2024-02-15', index: 0 }).phases![0];
  assert.equal(bounded.payments!.at(-1)!.date, '2026-05-15');
});

test('an unknown stop on a later phase does not cut an older phase', () => {
  const s = stopUndated(twoPhases({}), 'terminate', today);
  delete s.phases![0].end;
  const old = savePayment(s, today, { date: '2024-02-15', amount: 9 }, { date: '2024-02-15', index: 0 }).phases![0];
  assert.equal(old.payments!.at(-1)!.date, '2026-05-15');
});

test('an undated stop also ends a parallel older phase', () => {
  const next = stopUndated(switchPlan(base(), '2026-06-01', plan, '2027-03-31'), 'cancel', today);
  assert.equal(next.phases![0].end, undefined);
  assert.equal(nextCharge(next, today), undefined);
});

test('an undated stop clears an end dated today', () => {
  const s = json(switchPlan(base(), '2026-06-01', plan));
  s.phases!.at(-1)!.end = today;
  assert.equal(stopUndated(s, 'cancel', today).phases!.at(-1)!.end, undefined);
});

test('dropping a phase does not date an unknown stop', () => {
  const s = stopUndated(json(switchPlan(base(), '2026-06-01', plan)), 'cancel', today);
  delete s.phases![0].end;
  assert.equal(dropPlan(s, '2026-06-01').end, undefined);
});

test('a date the owner really chose is written, even today', () => {
  const s = stopUndated(base(), 'cancel', today);
  assert.equal(editStop(s, { mode: 'nonrenew', date: today }, today).end, today);
  const form = stopForm(s, today);
  assert.equal(applyStopForm(s, { ...form, date: today, dateUnset: undefined }, today).end, today);
});

test('a stop form drafted on an earlier day still counts as untouched', () => {
  const s = stopUndated(base(), 'cancel', today);
  assert.equal(applyStopForm(s, { ...stopForm(s, '2026-11-07') }, today).end, undefined);
});

test('an undated termination cannot gain a phase through a full replace', () => {
  const s = stopUndated(base(), 'terminate', today);
  const added = {
    ...s,
    phases: [
      { start: s.start, price: 10, currency: 'USD', cycle: month },
      { start: today, ...plan },
    ],
  };
  assert.ok(statusChangeError(s, added, today));
});

test('restoring a record with an old pause is not rejected; moving the start past it is', () => {
  const s = base({ status: 'paused', pausedAt: '2024-02-01' });
  assert.equal(statusChangeError(undefined, s, today), undefined);
  assert.ok(statusChangeError(s, { ...s, start: '2024-03-01' }, today));
});

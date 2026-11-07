import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { applyStopForm, editStop, stopForm } from './stop-form.ts';
import { cancelAtEnd, savePayment, statusChangeError, stopSubscription, switchPlan } from './phases.ts';
import { currentPhase, subError } from './billing.ts';
import { flatten, setLocale, t } from './i18n.ts';
import type { Subscription } from './types.ts';

const messages = {};
for (const ns of ['core', 'mcp']) flatten(ns, JSON.parse(readFileSync(new URL(`./locales/en/${ns}.json`, import.meta.url), 'utf8')), messages);
setLocale('en', [messages]);
const today = '2026-10-19';
const sub: Subscription = {
  id: 's',
  name: 'Service',
  category: 'tools',
  tags: [],
  price: 31,
  currency: 'USD',
  start: '2026-10-05',
  cycle: { unit: 'month', every: 1 },
  status: 'active',
};

test('stop fields preserve unchanged stop/refunds and replace only the displayed refund', () => {
  let stopped = stopSubscription(sub, today, 'cancel', today, undefined, { amount: 6 });
  stopped = savePayment(stopped, today, { date: '2026-10-20', amount: -2, currency: 'USD', kind: 'refund' });
  const before = structuredClone(stopped);
  const form = stopForm(stopped, today);
  assert.equal(form.amount, '2');
  assert.equal(applyStopForm(stopped, form, today), stopped);
  const next = applyStopForm(stopped, { ...form, amount: '3', settled: '21', settledCurrency: 'CNY' }, today);
  assert.deepEqual(
    currentPhase(next, today)
      .payments!.filter((p) => p.kind === 'refund')
      .map((p) => p.amount),
    [-6, -3],
  );
  assert.deepEqual(next.payments!.at(-1)!.settled, { amount: -21, currency: 'CNY' });
  assert.equal(subError(next), undefined);
  const removed = applyStopForm(next, { ...stopForm(next, today), refund: false }, today);
  assert.deepEqual(
    removed.payments!.filter((p) => p.kind === 'refund').map((p) => p.amount),
    [-6],
  );
  assert.deepEqual(stopped, before);
});

test('existing stop date/method edits retain ordinary payments and other phases', () => {
  const multi = switchPlan(sub, '2026-10-10', { price: 31, currency: 'EUR', cycle: sub.cycle });
  const stopped = stopSubscription(multi, today, 'cancel', today, undefined, { amount: 6 });
  const next = applyStopForm(stopped, { ...stopForm(stopped, today), date: '2026-10-18', amount: '5' }, today);
  assert.equal(next.stop!.date, '2026-10-18');
  assert.equal(next.phases!.at(-1)!.stop!.date, '2026-10-18');
  assert.deepEqual(next.phases![0], stopped.phases![0]);
  assert.equal(currentPhase(next, today).currency, 'EUR');
  assert.equal(currentPhase(next, today).payments!.filter((p) => p.kind === 'refund').length, 1);
  assert.equal(currentPhase(next, today).payments!.filter((p) => p.kind === 'refund')[0].amount, -5);
  assert.equal(subError(next), undefined);
  const nonrenew = applyStopForm(next, { ...stopForm(next, today), mode: 'nonrenew', date: '2026-11-04' }, today);
  assert.equal(nonrenew.stop, undefined);
  assert.equal(nonrenew.phases!.at(-1)!.stop, undefined);
  assert.deepEqual(currentPhase(nonrenew, today).payments, currentPhase(next, today).payments);
  const expired = cancelAtEnd(sub, '2026-10-10', today);
  assert.equal(applyStopForm(expired, { ...stopForm(expired, today), date: '2026-10-12' }, today).end, '2026-10-12');
  const corrected = applyStopForm(expired, { ...stopForm(expired, today), mode: 'cancel', date: '2026-10-10' }, today);
  assert.equal(corrected.stop!.date, '2026-10-10');
  assert.equal(statusChangeError(expired, corrected, today), undefined);
});

test('provider termination fields are editable, but cannot become voluntary cancellation or nonrenewal', () => {
  for (const original of [sub, switchPlan(sub, '2026-10-10', { price: 31, currency: 'EUR', cycle: sub.cycle })]) {
    const stopped = stopSubscription(original, today, 'terminate', today, 'Closure', { amount: 6 });
    const form = stopForm(stopped, today);
    for (const mode of ['cancel', 'nonrenew'] as const)
      assert.throws(() => applyStopForm(stopped, { ...form, mode }, today), { message: t('mcp.error.terminatedReactivate') });
    const next = applyStopForm(stopped, { ...form, reason: 'Corrected reason', amount: '7' }, today);
    assert.equal(next.stop!.reason, 'Corrected reason');
    assert.equal(next.status, 'terminated');
    assert.equal(statusChangeError(stopped, next, today), undefined);
    assert.equal(currentPhase(next, today).payments!.filter((p) => p.kind === 'refund').length, 1);
  }
});

test('stop form reuses domain validation for dates and refund limits, including zero and invalid amounts', () => {
  const form = { ...stopForm(sub, today), mode: 'cancel' as const, date: today, refund: true };
  for (const amount of ['', '-1', 'NaN', 'Infinity'])
    assert.throws(() => applyStopForm(sub, { ...form, amount }, today), { message: t('mcp.error.invalidRefund') });
  assert.throws(() => applyStopForm(sub, { ...form, amount: '32' }, today), { message: t('mcp.error.refundExceedsPaid') });
  assert.throws(() => applyStopForm(sub, { ...form, amount: '0', refundDate: '2026-10-18' }, today), { message: t('mcp.error.refundBeforeStop') });
  assert.throws(() => applyStopForm(sub, { ...form, date: '2026-10-01' }, today), { message: t('mcp.error.stopBeforeStart') });
  assert.throws(() => applyStopForm(sub, { ...form, date: '2026-11-05' }, today), { message: t('mcp.error.stopAfterPaidThrough') });
  for (const amount of ['0', '6', '31']) assert.equal(subError(applyStopForm(sub, { ...form, amount }, today)), undefined);
  assert.throws(() => applyStopForm(sub, { ...form, settled: 'Infinity' }, today), { message: t('mcp.error.invalidRefund') });
});

test('stop fields show the exact stored nonrenewal date, including prepaid future ends and legacy cancellation', () => {
  const future = { ...sub, status: 'cancelled' as const, end: '2027-06-30' };
  assert.equal(stopForm(future, today).date, '2027-06-30');
  assert.equal(applyStopForm(future, stopForm(future, today), today), future);
  const legacy = { ...sub, status: 'cancelled' as const };
  assert.equal(stopForm(legacy, today).date, today);
  assert.equal(applyStopForm(legacy, stopForm(legacy, today), today).end, today);
});

test('editStop keeps omitted stop fields, moves a stop-day refund with the date and never turns termination into cancel', () => {
  const stopped = stopSubscription(sub, today, 'cancel', '2026-10-10', undefined, { amount: 6 });
  const moved = editStop(stopped, { mode: 'cancel', date: '2026-10-12' }, today);
  assert.equal(moved.stop?.date, '2026-10-12');
  assert.deepEqual(
    moved.payments?.filter((p) => p.kind === 'refund').map((p) => [p.date, p.amount]),
    [['2026-10-12', -6]],
  );
  const nonrenew = editStop(moved, { mode: 'nonrenew' }, today);
  assert.equal(nonrenew.stop, undefined);
  assert.equal(nonrenew.end, '2026-10-12');
  assert.throws(() => editStop(sub, { mode: 'cancel', date: '2026-10-12' }, today), /not stopped/);
  const terminated = stopSubscription(sub, today, 'terminate', '2026-10-10', 'Policy');
  assert.equal(editStop(terminated, { mode: 'terminate', reason: 'Revised' }, today).stop?.reason, 'Revised');
  assert.throws(() => editStop(terminated, { mode: 'cancel' }, today), /another stop type/);
  assert.throws(() => editStop(stopped, { mode: 'cancel', reason: 'x' }, today));
});

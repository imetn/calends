import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmInOrder,
  draftSignature,
  remainingFailures,
  shouldSupersede,
  writeMismatches,
  type ProposalLike,
  type ToolFailure,
} from './assistant-result.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { FALLBACK_FX } from './billing.ts';

const sub = (id: string, price = 10): Subscription => ({
  id,
  name: id,
  price,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-01',
  status: 'active',
  tags: [],
  category: 'Tools',
});
const ledger = (subscriptions: Subscription[]): AppState => ({
  subscriptions,
  methods: [],
  people: [],
  prefs: {},
  settings: { ...DEFAULT_SETTINGS },
  fx: FALLBACK_FX,
});

test('draft identity ignores nested object key order but retains array order and operation dates', () => {
  const a = { subscription: 's', set: { notes: 'x', start: '2026-01-01', payments: [1, 2] } };
  const b = { dry_run: true, set: { payments: [1, 2], start: '2026-01-01', notes: 'x' }, subscription: 's' };
  assert.equal(draftSignature('update_subscription', a), draftSignature('update_subscription', b));
  assert.notEqual(draftSignature('update_subscription', a), draftSignature('update_subscription', { ...a, set: { ...a.set, payments: [2, 1] } }));
  assert.notEqual(draftSignature('update_subscription', a), draftSignature('update_subscription', { ...a, set: { ...a.set, start: '2026-01-02' } }));
});

test('read-back verifies intended entities/deletions, preserves financial dates, ignores unrelated edits and timestamps', () => {
  const before = ledger([sub('s'), sub('other')]);
  const expected = ledger([{ ...sub('s', 12), end: '2026-07-17' }, sub('other')]);
  const actual = ledger([{ ...sub('s', 12), end: '2026-07-17', updatedAt: 'different' }, sub('other', 99)]);
  assert.deepEqual(writeMismatches(before, expected, actual), []);
  actual.subscriptions[0].end = '2026-07-16';
  assert.deepEqual(writeMismatches(before, expected, actual), ['subscriptions.s']);
  assert.deepEqual(writeMismatches(before, ledger([sub('other')]), before), ['subscriptions.s']);
  const wanted = { ...before, settings: { ...before.settings, remindDays: 5 } };
  assert.deepEqual(writeMismatches(before, wanted, before), ['settings.remindDays']);
});

test('confirm all stops on a failed/unverified write instead of applying dependent drafts', async () => {
  const called: number[] = [];
  await confirmInOrder([1, 2, 3], async (n) => {
    called.push(n);
    return n !== 2;
  });
  assert.deepEqual(called, [1, 2]);
});

test('a recovered tool clears its failure without clearing another target or date', () => {
  const f = (id: string, subscription: string, date: string): ToolFailure => ({
    id,
    name: 'record_payment',
    args: { subscription, date },
    error: 'bad currency',
  });
  const failures = [f('a', 's', '2026-01-01'), f('b', 'other', '2026-01-01'), f('c', 's', '2026-02-01')];
  assert.deepEqual(
    remainingFailures(failures, 'record_payment', { subscription: 's', date: '2026-01-01', currency: 'USD' }, { subscription: { id: 's' } }).map((f) => f.id),
    ['b', 'c'],
  );
});

test('shouldSupersede replaces stale drafts while preserving additive steps and settled cards', () => {
  const card = (id: string, tool: string, args: Record<string, unknown>, state = 'pending', subId?: string): ProposalLike => ({
    kind: 'proposal',
    id,
    tool,
    args,
    preview: subId ? { subscription: { id: subId } } : undefined,
    state,
  });
  const save1 = card('p1', 'save_subscription', { subscription: { id: 'sub-1', name: 'A' } }, 'pending', 'sub-1');
  const save2 = card('p2', 'save_subscription', { subscription: { id: 'sub-1', name: 'A' } }, 'pending', 'sub-1');
  const create1 = card('c1', 'create_subscription', { id: 'sub-1', name: 'A' }, 'pending', 'sub-1');
  const update1 = card('u1', 'update_subscription', { subscription: 'sub-1', set: { notes: 'old' } }, 'pending', 'sub-1');
  const update2 = card('u2', 'update_subscription', { subscription: 'sub-1', set: { notes: 'new' } }, 'pending', 'sub-1');
  const pay1 = card('pay1', 'record_payment', { subscription: 'sub-1', date: '2026-11-28', amount: 10 }, 'pending', 'sub-1');
  const payOtherDate = card('pay2', 'record_payment', { subscription: 'sub-1', date: '2026-12-28', amount: 10 }, 'pending', 'sub-1');
  const otherSub = card('o1', 'save_subscription', { subscription: { id: 'sub-2', name: 'B' } }, 'pending', 'sub-2');

  // save_subscription supersedes earlier unapplied drafts on the same subscription (both cross-turn and same-turn)
  assert.equal(shouldSupersede(save1, save2, false), true);
  assert.equal(shouldSupersede(save1, save2, true), true);
  assert.equal(shouldSupersede(update1, save2, false), true);
  assert.equal(shouldSupersede(update1, save2, true), true);
  // Same-turn create_subscription followed by save_subscription is not superseded
  assert.equal(shouldSupersede(create1, save2, true), false);
  assert.equal(shouldSupersede(create1, save2, false), true);
  // Different subscription is untouched
  assert.equal(shouldSupersede(otherSub, save2, false), false);
  // Cross-turn same-tool replacement supersedes; same-turn distinct steps stay active
  assert.equal(shouldSupersede(update1, update2, false), true);
  assert.equal(shouldSupersede(update1, update2, true), false);
  assert.equal(shouldSupersede(pay1, payOtherDate, false), false);
  // Applied / dismissed / unverified cards are never superseded
  for (const state of ['applied', 'dismissed', 'unverified', 'superseded']) {
    assert.equal(shouldSupersede({ ...save1, state }, save2, false), false);
  }
  // Error cards can be superseded so a clean replacement draft is unblocked
  assert.equal(shouldSupersede({ ...save1, state: 'error' }, save2, false), true);
  // Cross-turn set_status correction supersedes earlier unapplied set_status draft even when date changes
  const stop1 = card('st1', 'set_status', { subscription: 'sub-1', action: 'cancel', at: '2026-12-31' }, 'pending', 'sub-1');
  const stop2 = card('st2', 'set_status', { subscription: 'sub-1', action: 'cancel', at: '2027-01-01' }, 'pending', 'sub-1');
  assert.equal(shouldSupersede(stop1, stop2, false), true);
  assert.equal(shouldSupersede(stop1, stop2, true), false);
});

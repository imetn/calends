import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorMoreKeys, editorMoreOpen } from '../app/src/views/editor/more.ts';
import type { Subscription } from './types.ts';

const empty: Subscription = {
  id: 'fictional-more',
  name: 'Fictional',
  category: 'tools',
  tags: [],
  price: 10,
  currency: 'USD',
  start: '2026-10-01',
  status: 'active',
  cycle: { unit: 'month', every: 1 },
};
const fields: Partial<Subscription>[] = [
  { intro: { price: 1, until: '2026-11-01' } },
  { bonus: { from: '2026-11-01', until: '2026-12-01' } },
  { remindDays: 0 },
  { remindDays: -1 },
  { chargeLeadDays: 1 },
  { cancelLeadDays: 2 },
  { contract: { start: '2026-01-17', term: { unit: 'year', every: 1 } } },
  { settlement: 'separate', settledBefore: '2026-10-01' },
  { url: 'https://example.test' },
  { manageUrl: 'https://example.test/account' },
  { icon: '🌟' },
  { tags: ['fiction'] },
  { notes: 'A note' },
  { transfers: [{ kind: 'buy', date: '2026-10-01', amount: 20, currency: 'USD' }] },
];

test('new subscription always starts collapsed, including restored/catalogue fields', () => {
  for (const extra of [{}, ...fields, Object.assign({}, ...fields)]) assert.equal(editorMoreOpen({ ...empty, ...extra }, true), false);
});
test('existing subscription expands for every filled More field, but not defaults/other sections', () => {
  for (const extra of fields) assert.equal(editorMoreOpen({ ...empty, ...extra }, false), true, JSON.stringify(extra));
  for (const extra of [
    {},
    { url: ' ', manageUrl: '\t', icon: '', notes: ' ' },
    { chargeLeadDays: 0, cancelLeadDays: 0, transfers: [] },
    { account: 'fiction@example.test', region: 'US', methodId: 'fictional-card', showOnPublic: true },
  ])
    assert.equal(editorMoreOpen({ ...empty, ...extra }, false), false, JSON.stringify(extra));
  assert.equal(editorMoreOpen({ ...empty, showOnPublic: true }, false, true), true);
});
test('hidden lifetime/proxy fields do not force expansion and summaries share the same predicate', () => {
  const lifetime = { ...empty, cycle: { unit: 'lifetime', every: 1 } as const, intro: { price: 1, until: '2026-11-01' }, remindDays: 0, cancelLeadDays: 1 };
  assert.deepEqual(editorMoreKeys(lifetime), []);
  assert.equal(editorMoreOpen(lifetime, false), false);
  const proxy = { ...empty, proxy: { forName: 'Fictional', charged: [] }, transfers: fields.at(-1)!.transfers } as Subscription;
  assert.equal(editorMoreOpen(proxy, false), false);
  assert.deepEqual(editorMoreKeys({ ...lifetime, notes: 'note' }), ['editor.more.notes']);
});
test('contract term has its own More group, separate from renewal rules', () => {
  assert.deepEqual(editorMoreKeys({ ...empty, contract: { start: '2026-01-17', term: { unit: 'month', every: 18 } } }), ['core.contract.title']);
  assert.deepEqual(editorMoreKeys({ ...empty, chargeLeadDays: 1 }), ['core.renewal.title']);
});

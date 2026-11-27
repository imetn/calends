import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorMoreKeys, editorMoreOpen } from '../app/src/views/editor/more.ts';
import {
  EMPTY_LINKED,
  applyChildLink,
  buildLinkedChildSub,
  effectiveLinkedChildren,
  linkableExistingChildren,
  parentHasAnyChild,
  unlinkChildSub,
  validateExistingChildLink,
} from '../app/src/views/editor/linked.ts';
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
test('linked children expand More for existing parents, stay collapsed on new, and never show on proxy or child subs', () => {
  assert.deepEqual(editorMoreKeys(empty, false, true), ['editor.more.bundle']);
  assert.equal(editorMoreOpen(empty, false, false, true), true);
  assert.equal(editorMoreOpen(empty, true, false, true), false);
  const child = { ...empty, bundle: { parentId: 'other' } };
  assert.deepEqual(editorMoreKeys(child, false, true), []);
  const proxy = { ...empty, proxy: { forName: 'Alex', charged: [] } } as Subscription;
  assert.deepEqual(editorMoreKeys(proxy, false, true), []);
});
test('editor linked-child helpers create perks, link/unlink without rewriting historical phases, and enforce 1-level rules', () => {
  const today = '2026-11-27';
  const parent: Subscription = {
    ...empty,
    id: 'p1',
    name: '88VIP',
    currency: 'CNY',
    price: 88,
    cycle: { unit: 'year', every: 1 },
    start: '2026-01-01',
    methodId: 'card1',
  };
  const standalone: Subscription = { ...empty, id: 's1', name: 'Music', price: 0, currency: 'CNY', start: '2026-11-27' };
  const historicChild: Subscription = {
    ...empty,
    id: 'c1',
    name: 'Video',
    price: 0,
    currency: 'CNY',
    start: '2025-01-01',
    phases: [
      { start: '2025-01-01', price: 15, currency: 'CNY', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'p1' } },
      { start: '2026-01-01', price: 0, currency: 'CNY', cycle: { unit: 'year', every: 1 }, bundle: { parentId: 'p1' } },
    ],
    bundle: { parentId: 'p1' },
  };
  const subs = [parent, standalone, historicChild];

  // 新建免费附赠继承主订阅周期且不带支付方式；付费加购继承主订阅支付方式
  const freePerk = buildLinkedChildSub(
    {
      kind: 'new',
      id: 'n1',
      name: 'Cloud',
      category: 'tools',
      price: 0,
      currency: 'CNY',
      cycle: { unit: 'month', every: 1 },
      start: '2026-01-01',
      follow: true,
    },
    parent,
    today,
  );
  assert.deepEqual(freePerk.cycle, { unit: 'year', every: 1 });
  assert.equal(freePerk.methodId, undefined);
  assert.deepEqual(freePerk.bundle, { parentId: 'p1' });

  const paidAddon = buildLinkedChildSub(
    {
      kind: 'new',
      id: 'n2',
      name: 'Extra 2TB',
      category: 'tools',
      price: 20,
      currency: 'CNY',
      cycle: { unit: 'month', every: 1 },
      start: '2026-11-27',
      follow: false,
    },
    parent,
    today,
  );
  assert.equal(paidAddon.methodId, 'card1');
  assert.deepEqual(paidAddon.bundle, { parentId: 'p1', follow: false });

  // 解绑只清当前阶段，保留历史阶段原貌
  const unlinked = unlinkChildSub(historicChild, 'p1', today);
  assert.equal(unlinked.phases![0].bundle?.parentId, 'p1');
  assert.equal(unlinked.phases![1].bundle, undefined);

  // 已有独立订阅挂到主订阅并校验历史不冲突
  assert.equal(validateExistingChildLink(standalone, parent, true, subs, today), undefined);
  const linkedExisting = applyChildLink(standalone, 'p1', false, today);
  assert.deepEqual(linkedExisting.bundle, { parentId: 'p1', follow: false });

  // 候选池排除自身、已关联项，但允许刚在草稿里解绑的项重新挂回
  assert.deepEqual(
    linkableExistingChildren('p1', subs, today, EMPTY_LINKED).map((s) => s.id),
    ['s1'],
  );
  assert.deepEqual(
    linkableExistingChildren('p1', subs, today, { upsert: [], unlink: ['c1'] })
      .map((s) => s.id)
      .sort(),
    ['c1', 's1'],
  );
  assert.equal(parentHasAnyChild('p1', false, subs, { upsert: [], unlink: ['c1'] }), false);
  assert.equal(
    effectiveLinkedChildren(parent, subs, today, { upsert: [{ kind: 'existing', subId: 's1', follow: true }], unlink: ['c1'] })
      .map((x) => x.id)
      .join(','),
    's1',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { transformSync } from 'oxc-transform-react';
import { extractUiFunction } from './ui-test-source.ts';
import { isProxyCandidate } from '../app/src/views/proxy/candidates.ts';
import { prepareEditorSave, mergeEditorSave } from '../app/src/views/editor/save.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { FALLBACK_FX, chargesBetween } from '../shared/billing.ts';

const today = '2026-10-27';
const sub = {
  id: 'fictional',
  name: 'Fictional plan',
  tags: ['代付'],
  category: 'tools',
  price: 20,
  currency: 'USD',
  start: '2026-01-01',
  status: 'active',
  cycle: { unit: 'month', every: 1 },
};
const state = { subscriptions: [sub], methods: [], settings: DEFAULT_SETTINGS, fx: FALLBACK_FX };
const nodes = (node, type) =>
  !React.isValidElement(node) ? [] : [...(node.type === type ? [node] : []), ...React.Children.toArray(node.props.children).flatMap((n) => nodes(n, type))];
function compile(file, name, deps) {
  const result = transformSync(name + '.tsx', extractUiFunction(new URL('../app/src/' + file, import.meta.url), name), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  return new Function('React', ...Object.keys(deps), result.code.replace(/export /g, '') + '; return ' + name)(React, ...Object.values(deps));
}

test('proxy candidates include supported tags and future/lifetime plans, excluding classified and stopped plans', () => {
  for (const tag of ['代付', '代充', '帮朋友付', 'PROXY', 'monthly proxy']) assert.equal(isProxyCandidate({ ...sub, tags: [tag] }, today), true, tag);
  assert.equal(isProxyCandidate({ ...sub, start: '2027-01-01' }, today), true);
  assert.equal(isProxyCandidate({ ...sub, status: 'paused' }, today), true);
  assert.equal(isProxyCandidate({ ...sub, cycle: { unit: 'lifetime', every: 1 } }, today), true);
  for (const patch of [
    { tags: ['家庭', 'normal'] },
    { tags: [] },
    { proxy: { forName: '' } },
    { share: { role: 'owner', seats: 6, members: [] } },
    { status: 'cancelled' },
    { status: 'terminated', end: '2026-10-01' },
  ])
    assert.equal(isProxyCandidate({ ...sub, ...patch }, today), false, JSON.stringify(patch));
  assert.deepEqual(sub.tags, ['代付']);
});

test('Toolbar draws no add button and hands a page-specific add to the phone dock', () => {
  const registered = [];
  const Toolbar = compile('components/ui.tsx', 'Toolbar', {
    t: (k) => k,
    copyParts: (v) => v,
    IconButton: 'icon-button',
    Icon: 'icon',
    useRegisterPageAdd: (onAdd, label) => registered.push({ onAdd, label }),
  });
  let custom = 0;
  // Phones have one add, in the dock's More arc; toolbars never draw their own.
  assert.deepEqual(nodes(Toolbar({ title: 'Fictional', onAdd: () => custom++, addLabel: 'Add person' }), 'icon-button'), []);
  assert.equal(registered[0].label, 'Add person');
  registered[0].onAdd();
  assert.equal(custom, 1);
  Toolbar({ title: 'Fictional' });
  assert.equal(registered[1].onAdd, undefined);
});

test('a proxy editor draft survives new-subscription save and JSON round trip', () => {
  const newSub = compile('views/editor/new-sub.ts', 'newSub', { uid: () => 'new-fictional', presetCat: (c) => c });
  const draft = { ...newSub(today, 'fictional-method', 'USD'), proxy: { forName: '' } };
  const form = { ...draft, name: ' Fictional proxy ', price: 12, proxy: { forName: 'Lin', personId: 'fictional-person' } };
  const out = prepareEditorSave(draft, form, today, true, 0);
  const saved = JSON.parse(JSON.stringify(mergeEditorSave(draft, out, undefined, true)));
  assert.deepEqual(saved.proxy, form.proxy);
  assert.equal(saved.name, 'Fictional proxy');
  assert.equal(saved.methodId, 'fictional-method');
  assert.equal(saved.share, undefined);
});

test('proxy conversion links people, preserves current history and rejects changed/deleted subscriptions', async () => {
  let current = structuredClone(sub),
    draft = { forName: ' Lin ', contact: 'lin', contactVia: 'Telegram' },
    saved,
    closed = false,
    pending;
  const deps = {
    useState: () => [
      draft,
      (v) => {
        draft = v;
      },
    ],
    useSubmit: () => [false, (fn) => (pending = fn())],
    t: (k) => k,
    Sheet: 'sheet',
    Group: 'group',
    Cell: 'cell',
    PersonPicker: 'picker',
    ContactField: 'contact',
    contactText: () => '',
    getState: () => ({ ...state, subscriptions: current ? [current] : [] }),
    linkPerson: async () => ({ id: 'fictional-person' }),
    savePerson: async () => {},
    saveSub: async (s) => {
      saved = s;
    },
    run: async (fn) => fn(),
  };
  const Convert = compile('views/proxy/ConvertProxySheet.tsx', 'ConvertProxySheet', deps);
  const render = () =>
    Convert({
      state,
      s: sub,
      onClose: () => {
        closed = true;
      },
    });
  const submit = () => nodes(render().props.foot, 'button').find((n) => n.props.className.includes('primary')).props;
  draft = { forName: '   ' };
  assert.equal(submit().disabled, true);
  draft = { forName: ' Lin ', personId: 'fictional-person', contact: 'lin', contactVia: 'Telegram' };
  current = { ...sub, notes: 'concurrent note', price: 25 };
  submit().onClick();
  await pending;
  assert.equal(closed, true);
  assert.deepEqual(saved, { ...current, proxy: { ...draft, forName: 'Lin' } });
  const history = (s) => chargesBetween(s, sub.start, today, today).map(({ sub: _sub, ...c }) => c);
  assert.deepEqual(history(saved), history(current));
  for (const changed of [undefined, { ...sub, share: { role: 'owner', seats: 6, members: [] } }, { ...sub, proxy: { forName: 'Other' } }]) {
    current = changed;
    saved = undefined;
    submit().onClick();
    await assert.rejects(pending, /proxy.convert.changed/);
    assert.equal(saved, undefined);
  }
});

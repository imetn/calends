import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canUseSingleKey, pageShortcut, preventBrowserSave, sheetSubmitKey, submitSheet, focusPageSearch } from '../app/src/keyboard.ts';

// DOM boundary doubles: selectors resolve to fixture nodes; assertions exercise event routing/clicks.
function fixture({ tag = 'INPUT', type = 'text', local = false, disabled = false, popup = false, editable = false } = {}) {
  let outerClicks = 0;
  let localClicks = 0;
  const doc = { querySelector: () => (popup ? {} : null), querySelectorAll: () => [], body: {} };
  const sheet = { ownerDocument: doc, querySelectorAll: () => [outerButton] };
  const button = (click) => ({
    tagName: 'BUTTON',
    closest: (selector) => (selector === '.sheet-dlg' ? sheet : local ? region : null),
    matches: () => disabled,
    click,
  });
  const outerButton = button(() => outerClicks++);
  const localButton = button(() => localClicks++);
  const region = { dataset: { submit: '.btn.primary' }, querySelectorAll: () => [localButton] };
  const target = {
    tagName: tag,
    type,
    ownerDocument: doc,
    closest: (selector) => {
      if (selector === '.sheet-dlg') return sheet;
      if (selector === '[data-submit]') return local ? region : null;
      return editable ? target : null;
    },
  };
  const event = (changes = {}) => ({
    key: 'Enter',
    target,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...changes,
  });
  return { doc, sheet, target, region, event, clicks: () => [outerClicks, localClicks] };
}

test('Sheet Enter clicks the footer once for writable single-line fields, including single-field dialogs', () => {
  for (const type of ['text', 'number', 'date', 'email', 'search']) {
    const f = fixture({ type });
    const e = f.event();
    assert.equal(submitSheet(e, f.sheet), true, type);
    assert.deepEqual(f.clicks(), [1, 0]);
    assert.equal(e.defaultPrevented, true);
    assert.equal(e.stopped, true);
  }
});

test('IME composition, legacy 229, repeat, modifiers, textarea, native controls and readonly fields do not submit on Enter', () => {
  for (const changes of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }]) {
    const f = fixture();
    assert.equal(submitSheet(f.event(changes), f.sheet), false);
    assert.deepEqual(f.clicks(), [0, 0]);
  }
  for (const [tag, type] of [
    ['TEXTAREA', ''],
    ['BUTTON', 'submit'],
    ['A', ''],
    ['INPUT', 'checkbox'],
    ['INPUT', 'radio'],
    ['INPUT', 'file'],
    ['SELECT', ''],
  ]) {
    const f = fixture({ tag, type });
    assert.equal(submitSheet(f.event(), f.sheet), false);
  }
  for (const property of ['readOnly', 'disabled']) {
    const f = fixture();
    f.target[property] = true;
    assert.equal(submitSheet(f.event(), f.sheet), false);
  }
});

test('Command/Control Enter submits from textarea or button, while composing never submits', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    for (const tag of ['TEXTAREA', 'BUTTON']) {
      const f = fixture({ tag });
      assert.equal(submitSheet(f.event({ [modifier]: true }), f.sheet), true);
      assert.deepEqual(f.clicks(), [1, 0]);
      assert.equal(sheetSubmitKey(f.event({ [modifier]: true, isComposing: true })), false);
    }
  }
});

test('disabled primary buttons and open pickers block plain Enter and submit chords', () => {
  for (const condition of [{ disabled: true }, { popup: true }]) {
    for (const chord of [{}, { metaKey: true }, { key: 's', ctrlKey: true }]) {
      const f = fixture(condition);
      assert.equal(submitSheet(f.event(chord), f.sheet), false);
      assert.deepEqual(f.clicks(), [0, 0]);
    }
  }
});

test('nested submit regions select their own action; disabled, missing or locally handled actions never fall through', () => {
  const f = fixture({ local: true });
  for (const chord of [{}, { metaKey: true }, { key: 's', ctrlKey: true }]) assert.equal(submitSheet(f.event(chord), f.sheet), true);
  assert.deepEqual(f.clicks(), [0, 3]);
  const blocked = fixture({ local: true, disabled: true });
  assert.equal(submitSheet(blocked.event(), blocked.sheet), false);
  assert.deepEqual(blocked.clicks(), [0, 0]);
  f.region.querySelectorAll = () => [];
  assert.equal(submitSheet(f.event(), f.sheet), false);
  f.region.dataset.submit = '';
  assert.equal(submitSheet(f.event(), f.sheet), false);
  assert.deepEqual(f.clicks(), [0, 3]);
});

test('events in another sheet do not submit this sheet', () => {
  const f = fixture();
  assert.equal(submitSheet(f.event(), fixture().sheet), false);
});

test('Command/Control S prevents browser Save without a sheet and submits the active form with one', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    const f = fixture({ tag: 'TEXTAREA' });
    const e = f.event({ key: 's', [modifier]: true });
    preventBrowserSave(e);
    assert.equal(e.defaultPrevented, true);
    assert.equal(submitSheet(e, f.sheet), true);
    assert.deepEqual(f.clicks(), [1, 0]);
  }
  const e = fixture().event({ key: 's' });
  preventBrowserSave(e);
  assert.equal(e.defaultPrevented, false);
});

test('E is limited to the open detail; / and ? resolve to page search and help', () => {
  const f = fixture({ tag: 'DIV' });
  const detail = {};
  const scrim = { contains: (node) => node === detail };
  f.doc.querySelectorAll = () => [scrim];
  assert.equal(pageShortcut(f.event({ key: 'e' }), detail), 'edit');
  assert.equal(pageShortcut(f.event({ key: 'e' })), undefined);
  for (const key of ['/', '?', 'n', '1']) assert.equal(pageShortcut(f.event({ key })), undefined);
  f.doc.querySelectorAll = () => [scrim, { contains: () => false }];
  assert.equal(pageShortcut(f.event({ key: 'e' }), detail), undefined);
  f.doc.querySelectorAll = () => [];
  assert.equal(pageShortcut(f.event({ key: '/' })), 'search');
  assert.equal(pageShortcut(f.event({ key: '?', shiftKey: true })), 'help');
  assert.equal(pageShortcut(f.event({ key: 'n' })), 'new');
  assert.equal(pageShortcut(f.event({ key: '9' })), 9);
});

test('all single-key actions share editable, composition, modifier and overlay guards', () => {
  for (const key of ['e', '/', '?', 'n', '1', 'ArrowLeft', 't']) {
    const f = fixture({ editable: true });
    assert.equal(canUseSingleKey(f.event({ key })), false);
    const plain = fixture({ tag: 'DIV' });
    for (const changes of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert.equal(canUseSingleKey(plain.event({ key, ...changes })), false);
    }
  }
  assert.equal(canUseSingleKey(fixture().event({ key: 'n', shiftKey: true })), false);
});

test('/ focuses an available page search or reports absence for the palette fallback', () => {
  let focused = 0;
  const hidden = { disabled: false, closest: () => null, getClientRects: () => [] };
  const input = { disabled: false, closest: () => null, getClientRects: () => [{}], focus: () => focused++ };
  assert.equal(focusPageSearch({ querySelectorAll: () => [hidden, input] }), true);
  assert.equal(focused, 1);
  assert.equal(focusPageSearch({ querySelectorAll: () => [] }), false);
});

test('a region skips primary buttons owned by a nested submit region', () => {
  const f = fixture({ local: true });
  let nestedClicks = 0;
  const own = f.region.querySelectorAll()[0];
  const nested = { tagName: 'BUTTON', closest: () => ({}), matches: () => false, click: () => nestedClicks++ };
  f.region.querySelectorAll = () => [nested, own];
  assert.equal(submitSheet(f.event(), f.sheet), true);
  assert.equal(nestedClicks, 0);
  assert.deepEqual(f.clicks(), [0, 1]);
});

test('issue #20: the inline date input handles Enter itself instead of saving the sheet with an uncommitted draft', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../app/src/components/DatePicker.tsx', import.meta.url), 'utf8');
  assert.match(source, /className=\{`dp-btn editing[^>]*data-submit=""/);
});

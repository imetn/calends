import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'oxc-transform-react';
import * as React from 'react';

// Render the real component with deterministic hooks/API; exercise its actual input/button handlers.
function harness({ catalog = true } = {}) {
  const src = readFileSync(new URL('../app/src/views/editor/NameField.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const compiled = transformSync('NameField.tsx', src, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(compiled.fatal, false);
  const states = [],
    refs = [],
    picks = [];
  let cursor = 0,
    refCursor = 0,
    value = 'Claude',
    scheduled;
  const item = { name: 'Claude', icon: '/brands/claude.webp', url: 'https://example.test', category: 'AI' };
  const deps = {
    React,
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (next) => {
          states[i] = typeof next === 'function' ? next(states[i]) : next;
        },
      ];
    },
    useRef(initial) {
      const i = refCursor++;
      return (refs[i] ??= { current: initial });
    },
    window: {
      clearTimeout() {},
      setTimeout(fn) {
        scheduled = fn;
        return 1;
      },
    },
    api: async () => ({ results: [{ ...item, name: 'Fictional App Store' }] }),
    // 兜底逻辑另在 shared/appstore-plans.test.ts 覆盖；这里只走服务端
    searchWithFallback: (server) => server(),
    searchCatalog: () => (catalog ? [item] : []),
    t: (k) => k,
    base: (v) => v,
    copyParts: (v) => v,
    SubIcon: () => null,
  };
  const Component = new Function(...Object.keys(deps), compiled.code.replace(/export /g, '') + '; return NameField;')(...Object.values(deps));
  let tree;
  const render = () => {
    cursor = refCursor = 0;
    tree = Component({
      value,
      region: 'us',
      onChange(v) {
        value = v;
      },
      onPick(h) {
        picks.push(h);
      },
      onPickCatalog(c) {
        picks.push(c);
      },
    });
  };
  const nodes = (node, type) =>
    !React.isValidElement(node) ? [] : [...(node.type === type ? [node] : []), ...React.Children.toArray(node.props.children).flatMap((n) => nodes(n, type))];
  const input = () => nodes(tree, 'input')[0].props;
  render();
  input().onChange({ target: { value } });
  render();
  return {
    picks,
    input,
    buttons: () => nodes(tree, 'button').map((n) => n.props),
    render,
    async search() {
      await scheduled();
      render();
    },
    key(key, nativeEvent = {}) {
      const event = {
        key,
        nativeEvent,
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      input().onKeyDown(event);
      render();
      return event;
    },
  };
}

for (const catalog of [true, false]) {
  const source = catalog ? 'catalogue' : 'App Store';
  test(`${source}: composition Enter, isComposing and legacy key 229 never pick or consume input`, async () => {
    const h = harness({ catalog });
    if (!catalog) await h.search();
    h.key('ArrowDown');
    h.input().onCompositionStart?.();
    assert.equal(h.key('Enter').prevented, false);
    h.input().onCompositionEnd?.();
    for (const native of [{ isComposing: true }, { keyCode: 229 }]) assert.equal(h.key('Enter', native).prevented, false);
    assert.equal(h.picks.length, 0);
    assert.equal(h.key('Enter').prevented, true);
    assert.equal(h.picks.length, 1);
  });
  test(`${source}: no default or hover selection; arrows explicitly enable Enter`, async () => {
    const h = harness({ catalog });
    if (!catalog) await h.search();
    assert.ok(h.buttons().every((b) => !b.className.split(/\s+/).includes('hi')));
    assert.equal(h.key('Enter').prevented, false);
    assert.equal(h.picks.length, 0);
    h.buttons()[0].onMouseMove();
    h.render();
    assert.equal(h.key('Enter').prevented, false);
    h.key('ArrowDown');
    assert.equal(h.key('Enter').prevented, true);
    assert.equal(h.picks.length, 1);
  });
  test(`${source}: pointer selection and Escape retain their behavior`, async () => {
    const h = harness({ catalog });
    if (!catalog) await h.search();
    h.buttons()[0].onClick();
    h.render();
    assert.equal(h.picks.length, 1);
    assert.equal(h.buttons().length, 0);
    h.input().onFocus();
    h.render();
    const e = h.key('Escape');
    if (catalog) {
      assert.equal(e.stopped, true);
      assert.equal(h.buttons().length, 0);
    }
  });
}

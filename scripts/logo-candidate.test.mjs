import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'oxc-transform-react';
import * as React from 'react';

const hit = { url: 'https://example.test/original.png', thumb: 'https://example.test/thumb.png', source: 'web', name: 'Fictional logo' };
function harness(load = async () => {}) {
  const source = readFileSync(new URL('../app/src/components/LogoCandidate.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const compiled = transformSync('LogoCandidate.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(compiled.fatal, false);
  const states = [],
    refs = [],
    effects = [];
  let stateIndex = 0,
    refIndex = 0;
  const selected = [],
    loaded = [];
  let failed = 0;
  const deps = {
    React,
    base: (s) => s,
    IconButton: 'button',
    loadLogoImage: async (url) => {
      loaded.push(url);
      await load(url);
    },
    useState: (initial) => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (value) => {
          states[i] = value;
        },
      ];
    },
    useRef: (initial) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useEffect: (fn) => {
      if (!effects.length) effects.push(fn());
    },
  };
  const Candidate = new Function(...Object.keys(deps), compiled.code.replace(/export /g, '') + '; return LogoCandidate;')(...Object.values(deps));
  return {
    selected,
    loaded,
    failures: () => failed,
    render() {
      stateIndex = refIndex = 0;
      return Candidate({ hit, onPick: (url) => selected.push(url), onUnavailable: () => failed++ });
    },
    unmount() {
      for (const cleanup of effects) cleanup?.();
    },
  };
}
const image = (tree) => React.Children.toArray(tree.props.children).find((child) => child.type === 'img');

test('broken thumbnails are rejected and unready candidates cannot be selected', async () => {
  const h = harness();
  const tree = h.render();
  assert.equal(tree.props.disabled, true);
  await tree.props.onClick();
  assert.deepEqual(h.selected, []);
  image(tree).props.onError();
  assert.equal(h.failures(), 1);
});

test('a thumbnail alone is insufficient: validate the saved original and image relay before selection', async () => {
  const h = harness();
  image(h.render()).props.onLoad();
  const tree = h.render();
  assert.equal(tree.props.disabled, false);
  await tree.props.onClick();
  assert.deepEqual(h.loaded, [hit.url, `/api/img?u=${encodeURIComponent(hit.url)}`]);
  assert.deepEqual(h.selected, [hit.url]);
});

test('failed original images never replace the draft icon', async () => {
  const h = harness(async () => {
    throw new Error('Fixture 404');
  });
  image(h.render()).props.onLoad();
  await h.render().props.onClick();
  assert.deepEqual(h.selected, []);
  assert.equal(h.failures(), 1);
});

test('closing the panel cancels a pending choice and repeat clicks do not start duplicate requests', async () => {
  const complete = [];
  const h = harness(() => new Promise((resolve) => complete.push(resolve)));
  image(h.render()).props.onLoad();
  const tree = h.render();
  const pending = tree.props.onClick();
  await tree.props.onClick();
  assert.equal(h.loaded.length, 2);
  h.unmount();
  for (const resolve of complete) resolve();
  await pending;
  assert.deepEqual(h.selected, []);
  assert.equal(h.failures(), 0);
});

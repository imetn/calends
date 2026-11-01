import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcAngle, mobileNav, navPath, pickSlot } from '../app/src/mobile-nav.ts';

const all = ['overview', 'list', 'calendar', 'report', 'wallet', 'family', 'behalf', 'assistant', 'connect'];

test('phone tab bar defaults to the first four sidebar modules and merges assistant with connect', () => {
  assert.deepEqual(mobileNav(all, undefined), {
    bar: ['overview', 'list', 'calendar', 'report'],
    more: ['wallet', 'family', 'behalf', 'ai'],
  });
  assert.deepEqual(mobileNav(['overview', 'connect', 'list', 'assistant'], undefined).bar, ['overview', 'ai', 'list']);
});

test('phone tab bar keeps chosen items, drops hidden or duplicate ones and fills from sidebar order', () => {
  assert.deepEqual(mobileNav(all, ['ai', 'wallet', 'ai', 'gone']), {
    bar: ['ai', 'wallet', 'overview', 'list'],
    more: ['calendar', 'report', 'family', 'behalf'],
  });
  // Hidden in the sidebar: not offered on the tab bar either.
  assert.deepEqual(mobileNav(['overview', 'list', 'report'], ['calendar', 'report']).bar, ['report', 'overview', 'list']);
});

test('wide screens put every module on the tab bar, chosen ones first, leaving only the fixed items in More', () => {
  assert.deepEqual(mobileNav(all, ['ai', 'wallet'], Infinity), {
    bar: ['ai', 'wallet', 'overview', 'list', 'calendar', 'report', 'family', 'behalf'],
    more: [],
  });
  assert.deepEqual(mobileNav(['overview', 'report'], undefined, Infinity).bar, ['overview', 'report']);
});

test('choosing a module already on the tab bar swaps the two slots', () => {
  const bar = ['overview', 'list', 'calendar', 'report'];
  assert.deepEqual(pickSlot(bar, 0, 'report'), ['report', 'list', 'calendar', 'overview']);
  assert.deepEqual(pickSlot(bar, 1, 'ai'), ['overview', 'ai', 'calendar', 'report']);
  assert.deepEqual(bar, ['overview', 'list', 'calendar', 'report']);
});

test('the merged AI entry takes the desktop module it opens, so it is named Assistant rather than a separate AI label', () => {
  assert.equal(navPath('ai', all), 'assistant');
  // Read-only or assistant hidden: it falls back to the connect page and its name.
  assert.equal(navPath('ai', ['overview', 'connect']), 'connect');
  assert.equal(navPath('wallet', all), 'wallet');
});

test('More arc items keep one gap between neighbours, centred on the diagonal', () => {
  const at = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  const dist = ([x0, y0], [x1, y1]) => Math.hypot(x1 - x0, y1 - y0);
  const ring = (n, r) => Array.from({ length: n }, (_, i) => arcAngle(i, n, r, 72));
  assert.equal(arcAngle(0, 1, 100, 72), 225);
  for (const [n, r] of [
    [3, 100],
    [5, 172],
    [2, 172],
  ]) {
    const angles = ring(n, r);
    assert.ok(Math.abs(angles[0] + angles.at(-1) - 450) < 1e-9, `symmetric around 225 for ${n}`);
    for (let i = 1; i < n; i++) assert.ok(Math.abs(dist(at(angles[i - 1], r), at(angles[i], r)) - 72) < 1e-9);
  }
  // The full default outer ring stays within a few degrees of the quarter.
  const outer = ring(5, 172);
  assert.ok(outer[0] > 175 && outer.at(-1) < 275);
});

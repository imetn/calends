import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileNav, pickSlot } from '../app/src/mobile-nav.ts';

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

test('choosing a module already on the tab bar swaps the two slots', () => {
  const bar = ['overview', 'list', 'calendar', 'report'];
  assert.deepEqual(pickSlot(bar, 0, 'report'), ['report', 'list', 'calendar', 'overview']);
  assert.deepEqual(pickSlot(bar, 1, 'ai'), ['overview', 'ai', 'calendar', 'report']);
  assert.deepEqual(bar, ['overview', 'list', 'calendar', 'report']);
});

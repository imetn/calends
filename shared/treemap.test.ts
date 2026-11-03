import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { servedSpan } from './format.ts';
import { flatten, setLocale, type MessageTree } from './i18n.ts';
import { spendingMap, spendTiles, squarify, type SpendGroup } from './treemap.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const detail = JSON.parse(readFileSync(new URL('./locales/en/detail.json', import.meta.url), 'utf8')) as MessageTree;
const today = '2026-10-22';
const sub = (id: string, category: string, price: number, extra: Partial<Subscription> = {}): Subscription => ({
  id,
  name: id,
  category,
  tags: [],
  price,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2025-01-01',
  status: 'active',
  ...extra,
});
const ledger = (subscriptions: Subscription[]): AppState => ({
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
  subscriptions,
  methods: [],
  fx: { rates: { USD: 1 }, fetchedAt: today },
  fxHistory: {},
});

test('squarify fills the box and keeps each value proportional', () => {
  const rects = squarify([6, 6, 4, 3, 2, 2, 1], 0, 0, 600, 400);
  assert.equal(rects.length, 7);
  const area = rects.reduce((a, r) => a + r.w * r.h, 0);
  assert.ok(Math.abs(area - 240000) < 1e-6);
  for (const r of rects) {
    assert.ok(Math.abs((r.w * r.h) / 240000 - [6, 6, 4, 3, 2, 2, 1][r.i] / 24) < 1e-9);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-9 && r.y + r.h <= 400 + 1e-9);
  }
});

test('squarify ignores zero values and returns nothing without a positive total', () => {
  assert.deepEqual(squarify([0, 0]), []);
  assert.deepEqual(squarify([]), []);
  assert.deepEqual(
    squarify([0, 5]).map((r) => r.i),
    [1],
  );
});

test('spendingMap groups current monthly spend by category, largest first', () => {
  const map = spendingMap(
    ledger([
      sub('a', 'Tools', 10),
      sub('b', 'Video', 30),
      sub('c', 'Tools', 5),
      sub('gone', 'Tools', 99, { status: 'cancelled', end: '2025-06-01' }),
      sub('free', 'Music', 7, { status: 'paused', pausedAt: '2026-01-01' }),
    ]),
    today,
  );
  assert.deepEqual(
    map.groups.map((g) => [g.name, g.rank, g.v, g.subs.map((s) => s.id)]),
    [
      ['Video', 0, 30, ['b']],
      ['Tools', 1, 15, ['a', 'c']],
    ],
  );
  assert.equal(map.total, 45);
  assert.equal(map.missing, 0);
});

test('spendingMap counts a missing exchange rate instead of treating it as zero', () => {
  const map = spendingMap(ledger([sub('a', 'Tools', 10), sub('x', 'Tools', 10, { currency: 'ZZZ' })]), today);
  assert.equal(map.missing, 1);
  assert.equal(map.total, 10);
  assert.deepEqual(
    map.groups.flatMap((g) => g.subs.map((s) => s.id)),
    ['a'],
  );
});

test('spendTiles stays inside the box, sits flush with its edges and leaves the gap between tiles', () => {
  const groups: SpendGroup[] = [
    {
      name: 'A',
      rank: 0,
      v: 60,
      subs: [
        { id: 'a1', name: 'a1', v: 40 },
        { id: 'a2', name: 'a2', v: 20 },
      ],
    },
    {
      name: 'B',
      rank: 1,
      v: 40,
      subs: [
        { id: 'b1', name: 'b1', v: 30 },
        { id: 'b2', name: 'b2', v: 10 },
      ],
    },
  ];
  const W = 300;
  const H = 200;
  const tiles = spendTiles(groups, W, H);
  assert.equal(tiles.length, 4);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  for (const r of tiles) assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6);
  assert.ok(near(Math.min(...tiles.map((r) => r.x)), 0));
  assert.ok(near(Math.min(...tiles.map((r) => r.y)), 0));
  assert.ok(near(Math.max(...tiles.map((r) => r.x + r.w)), W));
  assert.ok(near(Math.max(...tiles.map((r) => r.y + r.h)), H));
  // 任意两块不重叠，相邻的两块之间正好 2px
  let touching = 0;
  for (const a of tiles)
    for (const b of tiles) {
      if (a === b) continue;
      const dx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      const dy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      assert.ok(dx >= 2 - 1e-6 || dy >= 2 - 1e-6);
      if ((near(dx, 2) && dy < 0) || (near(dy, 2) && dx < 0)) touching++;
    }
  assert.ok(touching > 0);
  assert.deepEqual(spendTiles(groups, 0, 200), []);
});

test('servedSpan writes years and months, and days under a month', () => {
  setLocale('en', [flatten('detail', detail)]);
  assert.equal(servedSpan(10), '10 days');
  assert.equal(servedSpan(61), '2 months');
  assert.equal(servedSpan(365.25), '1 year');
  assert.equal(servedSpan(800), '2 yr 2 mo');
  setLocale('en', []);
});

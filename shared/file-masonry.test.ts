import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutMasonry, MASONRY, masonryCols } from '../app/src/file-masonry.ts';

const W = 4 * MASONRY.minCol + 3 * MASONRY.gap; // 正好四列

test('narrow containers fall back to the plain grid', () => {
  assert.ok(masonryCols(390) < 3);
  assert.equal(layoutMasonry([{ key: 'a' }], 390), null);
  assert.ok(layoutMasonry([{ key: 'a' }], W));
});

test('each tile goes to the shortest column, so column bottoms differ', () => {
  const tiles = [
    { key: 'tall', ratio: 0.5 },
    { key: 'a4', ratio: 0.707 },
    { key: 'sq', ratio: 1 },
    { key: 'shot', ratio: 0.6 },
    { key: 'next', ratio: 0.707 },
  ];
  const { items } = layoutMasonry(tiles, W)!;
  const by = Object.fromEntries(items.map((p) => [p.key, p]));
  assert.deepEqual(
    items.slice(0, 4).map((p) => p.top),
    [0, 0, 0, 0],
  );
  // 第五张接在最矮的方形那一列下面，而不是新起一行
  assert.equal(by.next.left, by.sq.left);
  assert.equal(by.next.top, by.sq.height + MASONRY.gap);
  assert.notEqual(by.tall.height, by.sq.height);
});

test('landscape files span two columns; extreme ratios are clamped', () => {
  const { items } = layoutMasonry(
    [
      { key: 'invoice', ratio: 1.6 },
      { key: 'banner', ratio: 8 },
      { key: 'phone', ratio: 0.2 },
      { key: 'squareish', ratio: 1.1 },
    ],
    W,
  )!;
  const [invoice, banner, phone, squareish] = items;
  const col = MASONRY.minCol;
  assert.equal(invoice.span, 2);
  assert.equal(invoice.width, col * 2 + MASONRY.gap);
  assert.equal(banner.span, 2);
  assert.equal(banner.height, Math.round(banner.width / MASONRY.maxWide));
  assert.equal(phone.span, 1);
  assert.equal(phone.height, Math.round(col / MASONRY.minTall));
  assert.equal(squareish.span, 1);
});

test('unknown ratios use a portrait placeholder', () => {
  const { items } = layoutMasonry([{ key: 'x' }, { key: 'y', ratio: Number.NaN }], W)!;
  for (const p of items) assert.equal(p.height, Math.round(MASONRY.minCol / MASONRY.fallback));
});

test('a wide card waits for single cards to fill the hole it would leave', () => {
  // 第四列先被一张长截图拉高；横向卡若马上放在三、四列，第三列下面会空出一大块
  const { items } = layoutMasonry(
    [
      { key: 'a', ratio: 1 },
      { key: 'b', ratio: 1 },
      { key: 'c', ratio: 1 },
      { key: 'tall', ratio: 0.5 },
      { key: 'x', ratio: 1 },
      { key: 'y', ratio: 1 },
      { key: 'wide', ratio: 1.6 },
      { key: 'fill', ratio: 1 },
    ],
    W,
  )!;
  const by = Object.fromEntries(items.map((p) => [p.key, p]));
  const step = MASONRY.minCol + MASONRY.gap;
  // 后面的单列卡先填进第三列的空处，宽卡再放到等高的一、二列下面
  assert.equal(by.fill.left, 2 * step);
  assert.equal(by.fill.top, step);
  assert.equal(by.wide.left, 0);
  assert.equal(by.wide.top, 2 * step);
  // 所有卡按输入顺序返回
  assert.deepEqual(
    items.map((p) => p.key),
    ['a', 'b', 'c', 'tall', 'x', 'y', 'wide', 'fill'],
  );
});

test('without single cards left, the wide card is placed anyway', () => {
  const { items } = layoutMasonry(
    [
      { key: 'tall', ratio: 0.5 },
      { key: 'wide', ratio: 1.6 },
    ],
    W,
  )!;
  assert.equal(items[1].top, 0);
  assert.equal(items[1].left, MASONRY.minCol + MASONRY.gap);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickPalette } from '../app/src/icon-palette.ts';

/** n 个像素的 RGBA 数据，按 [颜色, 个数] 依次填充 */
function pixels(...runs: Array<[[number, number, number, number], number]>) {
  return runs.flatMap(([c, n]) => Array.from({ length: n }, () => c)).flat();
}
const hue = (c: string) => {
  const [r, g, b] = c.match(/\d+/g)!.map(Number);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  return (h * 60 + 360) % 360;
};

test('icon palette keeps up to three distinct icon colours by weight', () => {
  const p = pickPalette(pixels([[230, 40, 40, 255], 500], [[250, 200, 20, 255], 300], [[30, 160, 90, 255], 200], [[255, 255, 255, 255], 24]));
  assert.deepEqual(p, ['rgb(230, 40, 40)', 'rgb(250, 200, 20)', 'rgb(30, 160, 90)']);
});

test('icon palette never pairs blue with purple', () => {
  const p = pickPalette(pixels([[68, 115, 203, 255], 500], [[135, 105, 192, 255], 400], [[73, 183, 234, 255], 124]))!;
  assert.equal(p.length, 2);
  assert.ok(!p.some((c) => hue(c) >= 250 && hue(c) < 320), p.join());
});

test('single-colour icons get an adjacent companion that does not drift into purple', () => {
  const red = pickPalette(pixels([[195, 18, 27, 255], 600], [[0, 0, 0, 255], 424]))!;
  assert.equal(red.length, 2);
  assert.ok(hue(red[1]) > 10 && hue(red[1]) < 40, red[1]);
  const blue = pickPalette(pixels([[60, 120, 230, 255], 600], [[255, 255, 255, 255], 424]))!;
  assert.ok(hue(blue[1]) < 200, blue[1]);
});

test('black, white and grey icons fall back to the category glow', () => {
  assert.equal(pickPalette(pixels([[0, 0, 0, 255], 500], [[255, 255, 255, 255], 400], [[128, 128, 128, 255], 124])), null);
  assert.equal(pickPalette(pixels([[230, 40, 40, 0], 1024])), null);
});

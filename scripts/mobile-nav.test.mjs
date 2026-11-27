import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcAngle, arcRadius, mobileNav, navPath, ringRadii } from '../app/src/mobile-nav.ts';

const all = ['overview', 'list', 'calendar', 'report', 'wallet', 'family', 'behalf', 'assistant', 'connect'];

test('phone tab bar takes the first four sidebar modules in sidebar order and merges assistant with connect', () => {
  assert.deepEqual(mobileNav(all), {
    bar: ['overview', 'list', 'calendar', 'report'],
    more: ['wallet', 'family', 'behalf', 'ai'],
  });
  assert.deepEqual(mobileNav(['overview', 'connect', 'list', 'assistant']).bar, ['overview', 'ai', 'list']);
  // Reordered sidebar: the tab bar follows the same order.
  assert.deepEqual(mobileNav(['wallet', 'report', 'overview', 'list', 'calendar']), { bar: ['wallet', 'report', 'overview', 'list'], more: ['calendar'] });
});

test('only two modules left in the sidebar: the bar holds those two and More keeps only its fixed items', () => {
  assert.deepEqual(mobileNav(['overview', 'list']), { bar: ['overview', 'list'], more: [] });
});

test('wide screens put every module on the tab bar in sidebar order, leaving only the fixed items in More', () => {
  assert.deepEqual(mobileNav(all, Infinity), {
    bar: ['overview', 'list', 'calendar', 'report', 'wallet', 'family', 'behalf', 'ai'],
    more: [],
  });
  assert.deepEqual(mobileNav(['overview', 'report'], Infinity).bar, ['overview', 'report']);
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

test('More outer ring grows its radius instead of running off screen when it holds more items', () => {
  // 4 项及以下保持默认半径 172；更多项时放大，整道弧落在四分之一圆内
  assert.equal(arcRadius(4, 172, 72), 172);
  assert.equal(arcRadius(1, 172, 72), 172);
  for (const n of [5, 6, 7, 8]) {
    const r = arcRadius(n, 172, 72);
    assert.ok(r > 172, `${n}: radius grows`);
    const first = arcAngle(0, n, r, 72);
    const last = arcAngle(n - 1, n, r, 72);
    assert.ok(Math.abs(last - first - 90) < 1e-6, `${n}: spans exactly the cap`);
    assert.ok(first >= 180 - 1e-9 && last <= 270 + 1e-9);
    // 屏幕 390 宽、按钮圆心离右边 46：最左一项 圆心-半径-30 仍在屏幕内
    if (n <= 6) assert.ok(390 - 46 - r - 30 > 0, `${n}: stays on a 390pt screen`);
  }
});

test('More puts New on the inner ring and both rings fit the quarter with one gap between them', () => {
  const at = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  // 默认：内圈 3 项、外圈 4 项不放大
  assert.deepEqual(ringRadii(3, 4, 100, 72), { inner: 100, outer: 172 });
  for (const [ni, no] of [
    [4, 5],
    [4, 4],
    [3, 5],
    [4, 6],
  ]) {
    const r = ringRadii(ni, no, 100, 72);
    assert.equal(r.outer - r.inner, 72);
    for (const [n, rad] of [
      [ni, r.inner],
      [no, r.outer],
    ]) {
      const first = arcAngle(0, n, rad, 72);
      const last = arcAngle(n - 1, n, rad, 72);
      assert.ok(first >= 180 - 1e-9 && last <= 270 + 1e-9, `${ni}/${no}: ring of ${n} stays in the quarter`);
      // 最左一项和最下一项都在 390×844 屏内（按钮圆心离右边、底边约 46，圆半径 30）
      const [x0, y0] = at(first, rad);
      assert.ok(390 - 46 + x0 - 30 > 0 && 844 - 46 + y0 - 30 > 0);
    }
  }
  // 4 + 5 比旧的 3 + 6 半径小
  assert.ok(ringRadii(4, 5, 100, 72).outer < ringRadii(3, 6, 100, 72).outer);
});

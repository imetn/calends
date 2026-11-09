import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morphPath } from '../app/src/path-morph.ts';

test('结构相同的路径逐数插值，圆弧标志位不变', () => {
  const morph = morphPath('M0,10V5A2,2 0 0 1 4,3Z', 'M10,20V15A2,2 0 0 1 14,13Z');
  assert.equal(morph(0), 'M0,10V5A2,2 0 0 1 4,3Z');
  assert.equal(morph(0.5), 'M5,15V10A2,2 0 0 1 9,8Z');
  assert.equal(morph(1), 'M10,20V15A2,2 0 0 1 14,13Z');
});

test('点数不同的折线取样后两端形状一致', () => {
  const morph = morphPath('M0,0L100,100', 'M0,100L50,0L100,100');
  assert.equal(morph(0), 'M0,0L50,50L100,100');
  assert.equal(morph(1), 'M0,100L50,0L100,100');
});

test('面积图闭合路径的基线两点单独对应', () => {
  const morph = morphPath('M0,50L100,10L100,200L0,200Z', 'M0,80L50,40L100,20L100,200L0,200Z');
  assert.equal(morph(0), 'M0,50L50,30L100,10L100,200L0,200Z');
  assert.equal(morph(0.5).endsWith('L100,200L0,200Z'), true);
});

test('无法对应的路径返回 null', () => {
  assert.equal(morphPath('M0,0H10', 'M0,0L5,5L10,10'), null);
  assert.equal(morphPath('M0,0L1,1Z', 'M0,0L1,1'), null);
});

test('中途打断后从当前形状继续', () => {
  const first = morphPath('M0,0L100,100', 'M0,100L50,0L100,100');
  const mid = first(0.5);
  const next = morphPath(mid, 'M0,0L100,0');
  assert.equal(next(0), mid);
  assert.equal(next(1), 'M0,0L50,0L100,0');
});

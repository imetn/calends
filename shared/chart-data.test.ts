import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OTHER, flowGraph, flowLevels, flowShares, netByItem, roundShares, shareProfile, streamLayers, waterfallDomain } from './chart-data.ts';

const row = (from: string, to: string, value: number) => ({ from, fromLabel: from, to, toLabel: to, value });

test('flowGraph 合并同一对节点，左右合计相等，非正数丢弃', () => {
  const g = flowGraph([
    row('Visa', '影音', 10),
    row('Visa', '影音', 5),
    row('Visa', 'AI', 20),
    row('PayPal', 'AI', 8),
    row('PayPal', '工具', -3),
    row('PayPal', '工具', 0),
  ]);
  assert.deepEqual(
    g.left.map((n) => [n.key, n.value]),
    [
      ['Visa', 35],
      ['PayPal', 8],
    ],
  );
  assert.deepEqual(
    g.right.map((n) => [n.key, n.value]),
    [
      ['AI', 28],
      ['影音', 15],
    ],
  );
  assert.equal(g.total, 43);
  assert.equal(
    g.links.reduce((a, l) => a + l.value, 0),
    43,
  );
  assert.deepEqual(g.links.find((l) => l.from === 'Visa' && l.to === '影音')?.value, 15);
});

test('flowGraph 超过上限的小项并进其他，恰好多一项时不合并', () => {
  const rows = ['a', 'b', 'c', 'd'].map((k, i) => row(k, 'x', 10 - i));
  const folded = flowGraph(rows, 3);
  assert.deepEqual(
    folded.left.map((n) => n.key),
    ['a', 'b', OTHER],
  );
  assert.equal(folded.left[2].value, 8 + 7);
  assert.equal(folded.links.find((l) => l.from === OTHER)?.value, 15);
  assert.equal(flowGraph(rows, 4).left.length, 4);
});

test('shareProfile 按各期占比，少于 3 条轴或一期为空时不画', () => {
  const axes = shareProfile(
    [
      { key: 'AI', value: 60 },
      { key: '影音', value: 30 },
      { key: '工具', value: 10 },
    ],
    [
      { key: 'AI', value: 10 },
      { key: '影音', value: 10 },
    ],
  );
  assert.deepEqual(
    axes.map((x) => x.key),
    ['AI', '影音', '工具'],
  );
  assert.equal(axes[0].a, 0.6);
  assert.equal(axes[0].b, 0.5);
  assert.equal(axes[2].b, 0);
  assert.deepEqual(shareProfile([{ key: 'AI', value: 1 }], [{ key: 'AI', value: 1 }]), []);
  assert.deepEqual(shareProfile([], [{ key: 'AI', value: 1 }]), []);
});

test('shareProfile 轴超过上限时其余并进其他，占比合计仍为 1', () => {
  const xs = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, value: 9 - i }));
  const axes = shareProfile(xs, xs, 7);
  assert.equal(axes.length, 7);
  assert.equal(axes[6].key, OTHER);
  assert.ok(Math.abs(axes.reduce((a, x) => a + x.a, 0) - 1) < 1e-9);
});

test('streamLayers 每列对称于 0，层厚等于数值', () => {
  const s = streamLayers([
    new Map([
      ['a', 4],
      ['b', 2],
    ]),
    new Map([['b', 6]]),
  ]);
  assert.deepEqual(s.keys, ['b', 'a']);
  assert.equal(s.peak, 6);
  assert.equal(s.y0[0][0], -3);
  assert.equal(s.y1[1][0], 3);
  assert.equal(s.y1[1][1] - s.y0[1][1], 0);
  assert.equal(s.y0[0][1], -3);
});

test('waterfallDomain 截断纵轴让变化量可见，且包住所有累计值', () => {
  const { lo, hi } = waterfallDomain([2000, 2100, 2080, 2150]);
  assert.ok(lo > 1700 && lo < 2000);
  assert.ok(hi > 2150);
  assert.deepEqual(waterfallDomain([]), { lo: 0, hi: 1 });
  assert.equal(waterfallDomain([0.5, 0.6]).lo, 0);
});

test('netByItem 退款只抵本订阅，不冲减同组其他订阅（与构成卡同口径）', () => {
  const rows = netByItem([
    { id: 'a', from: 'visa', to: 'AI', value: 100 },
    { id: 'b', from: 'visa', to: 'AI', value: -30 },
    { id: 'c', from: 'visa', to: 'AI', value: 50 },
    { id: 'c', from: 'visa', to: 'AI', value: -20 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.value]),
    [
      ['a', 100],
      ['c', 30],
    ],
  );
  const g = flowGraph(rows.map((r) => ({ ...r, fromLabel: r.from, toLabel: r.to })));
  assert.equal(g.right[0].value, 130);
});

test('flowLevels 三层：每层合计相等，订阅只留前几名，其余并进各自分类下的其他', async () => {
  const { flowLevels } = await import('./chart-data.ts');
  const r = (m: string, c: string, s: string, v: number) => ({ path: [m, c, s], labels: [m, c, s], value: v });
  const g = flowLevels(
    [
      r('visa', 'AI', 'a', 50),
      r('visa', 'AI', 'b', 5),
      r('visa', 'AI', 'c', 4),
      r('pp', '影音', 'd', 30),
      r('pp', '影音', 'e', 3),
      r('visa', '工具', 'f', 2),
      r('pp', 'AI', 'a', 10),
      r('pp', 'AI', 'x', -9),
    ],
    [6, 7, 2],
  );
  const sum = (lv: number) => g.levels[lv].reduce((a, n) => a + n.value, 0);
  assert.equal(g.total, 104);
  assert.deepEqual([sum(0), sum(1), sum(2)], [104, 104, 104]);
  // 前两名 a、d 保留；AI 下 b、c 并成其他；影音下只并 e 一项、工具下只并 f 一项，直接显示
  assert.deepEqual(
    g.levels[2].map((n) => [n.key, n.value]),
    [
      ['a', 60],
      [OTHER + 'AI', 9],
      ['d', 30],
      ['e', 3],
      ['f', 2],
    ],
  );
  assert.equal(
    g.links.filter((l) => l.level === 0).reduce((a, l) => a + l.value, 0),
    104,
  );
  assert.equal(
    g.links.filter((l) => l.level === 1).reduce((a, l) => a + l.value, 0),
    104,
  );
  assert.equal(g.links.find((l) => l.level === 0 && l.from === 'pp' && l.to === 'AI')?.value, 10);
});

test('roundShares 取整后相加正好 100，同额的项显示同一个数', () => {
  assert.deepEqual(roundShares([2, 1, 1], 4), [50, 25, 25]);
  assert.deepEqual(roundShares([0.4, 99.6], 100), [0, 100]);
  assert.deepEqual(roundShares([0.1, 0.2], 0.3), [33, 67]);
  assert.deepEqual(roundShares([5, 0], 0), [0, 0]);
  // 两笔同额抢一个余数：都不补，宁可合计差 1，也不让同额显示不同、或让小项越过大项
  assert.deepEqual(roundShares([1, 1, 1], 3), [33, 33, 33]);
  assert.deepEqual(roundShares([5.5, 5.5, 89], 100), [5, 5, 89]);
  assert.deepEqual(roundShares([5.6, 5.6, 5.4, 83.4], 100), [6, 6, 5, 83]);
});

test('flowShares 每层节点合计 100%，节点唯一的出线或入线与节点同数，同额节点同数', () => {
  const g = flowLevels(
    [
      { path: ['a', 'x', '1'], labels: ['A', 'X', 'S1'], value: 50.5 },
      { path: ['b', 'x', '2'], labels: ['B', 'X', 'S2'], value: 24.75 },
      { path: ['b', 'y', '3'], labels: ['B', 'Y', 'S3'], value: 24.75 },
    ],
    [5, 6, 8],
  );
  const s = flowShares(g);
  g.levels.forEach((nodes, lv) =>
    assert.equal(
      nodes.reduce((a, n) => a + s.get(`${lv}\u0001${n.key}`)!, 0),
      100,
    ),
  );
  // A 只有一条出线，S3 只有一条入线：同一笔钱同一个数
  assert.equal(s.get('0\u0001a\u0001x'), s.get('0\u0001a'));
  assert.equal(s.get('1\u0001y\u00013'), s.get('2\u00013'));
  assert.equal(s.get('2\u00012'), s.get('2\u00013'));
});

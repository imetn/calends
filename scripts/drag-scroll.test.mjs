import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachDragScroll, dragScroll } from '../app/src/drag-scroll.ts';

// 用 EventTarget 模拟一行放不下的筛选芯片：容器 300px，内容 900px
function harness(t, { scrollWidth = 900 } = {}) {
  const captured = new Set();
  const row = Object.assign(new EventTarget(), {
    scrollWidth,
    clientWidth: 300,
    scrollLeft: 100,
    dataset: {},
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => captured.delete(id),
  });
  const send = (type, props = {}) => {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.assign(event, { pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, detail: 1, ...props });
    row.dispatchEvent(event);
    return event;
  };
  const dispose = attachDragScroll(row);
  let picked = 0;
  // 芯片的 React onClick 在根节点冒泡阶段处理：被拦下（stopPropagation）就到不了
  row.addEventListener('click', (e) => !e.cancelBubble && picked++);
  t.after(dispose);
  return { row, captured, send, dispose, picked: () => picked };
}

test('鼠标拖动横向滚动该行，松开后不触发选中', (t) => {
  const h = harness(t);
  h.send('pointerdown', { clientX: 200 });
  h.send('pointermove', { clientX: 197 });
  assert.equal(h.row.scrollLeft, 100, '阈值内不滚动');
  assert.equal(h.row.dataset.dragScroll, undefined);
  const move = h.send('pointermove', { clientX: 140 });
  assert.equal(move.defaultPrevented, true);
  assert.equal(h.row.scrollLeft, 160);
  assert.equal(h.row.dataset.dragScroll, 'dragging');
  assert.equal(h.captured.has(1), true);
  h.send('pointerup', { clientX: 140 });
  assert.equal(h.captured.size, 0);
  assert.equal(h.row.dataset.dragScroll, undefined);
  const click = h.send('click');
  assert.equal(click.defaultPrevented, true);
  assert.equal(h.picked(), 0);
  // 只吞一次：下一次单击照常
  h.send('pointerdown', { clientX: 50 });
  h.send('pointerup', { clientX: 50 });
  h.send('click');
  assert.equal(h.picked(), 1);
});

test('单击和小于阈值的抖动仍选中分类', (t) => {
  const h = harness(t);
  h.send('pointerdown', { clientX: 200 });
  h.send('pointermove', { clientX: 204 });
  h.send('pointerup', { clientX: 204 });
  assert.equal(h.send('click').defaultPrevented, false);
  assert.equal(h.picked(), 1);
  assert.equal(h.row.scrollLeft, 100);
});

test('拖动后残留状态不吞键盘点击，下一次按下即清除', (t) => {
  const h = harness(t);
  h.send('pointerdown', { clientX: 200 });
  h.send('pointermove', { clientX: 100 });
  h.send('pointerup', { clientX: 100 });
  // 键盘 Enter/空格触发的 click detail 为 0
  h.send('click', { detail: 0 });
  assert.equal(h.picked(), 1);
  h.send('pointerdown', { clientX: 100, pointerType: 'touch' });
  h.send('click');
  assert.equal(h.picked(), 2);
});

test('触屏、触控笔、非左键与放得下的行都不接管', (t) => {
  for (const props of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { button: 2 }, { isPrimary: false }]) {
    const h = harness(t);
    h.send('pointerdown', { clientX: 200, ...props });
    const move = h.send('pointermove', { clientX: 100, ...props });
    assert.equal(move.defaultPrevented, false, JSON.stringify(props));
    assert.equal(h.row.scrollLeft, 100);
    assert.equal(h.captured.size, 0);
    h.send('pointerup', props);
    h.send('click');
    assert.equal(h.picked(), 1);
  }
  const fits = harness(t, { scrollWidth: 300 });
  fits.send('pointerdown', { clientX: 200 });
  fits.send('pointermove', { clientX: 100 });
  assert.equal(fits.row.scrollLeft, 100);
  fits.send('pointerup');
  fits.send('click');
  assert.equal(fits.picked(), 1);
});

test('卸载后不再接管；ref 形式在 null 时无清理函数', (t) => {
  const h = harness(t);
  h.dispose();
  h.send('pointerdown', { clientX: 200 });
  h.send('pointermove', { clientX: 100 });
  assert.equal(h.row.scrollLeft, 100);
  assert.equal(dragScroll(null), undefined);
});

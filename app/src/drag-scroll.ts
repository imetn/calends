/** 鼠标拖动超过这个距离才算拖动，松开后不再触发按钮点击 */
export const DRAG_SCROLL_SLOP = 5;

/**
 * 横向可滚的芯片/分段行：鼠标按住拖动即横向滚动。
 * 只接管 pointerType 为 mouse 的左键；触屏、触控板滚动和键盘保持浏览器原样。
 * 拖动超过阈值后吞掉松开时那次点击（键盘触发的 detail 为 0 的点击不受影响）；放得下时什么都不做。
 */
export function attachDragScroll(el: HTMLElement) {
  let dragged = false;
  let pointer: { id: number; x: number; left: number } | undefined;
  const down = (e: PointerEvent) => {
    dragged = false;
    if (e.pointerType !== 'mouse' || e.button !== 0 || !e.isPrimary || el.scrollWidth - el.clientWidth < 1) return;
    pointer = { id: e.pointerId, x: e.clientX, left: el.scrollLeft };
  };
  const move = (e: PointerEvent) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x;
    if (!dragged) {
      if (Math.abs(dx) < DRAG_SCROLL_SLOP) return;
      dragged = true;
      el.setPointerCapture(e.pointerId);
      el.dataset.dragScroll = 'dragging';
    }
    e.preventDefault();
    el.scrollLeft = pointer.left - dx;
  };
  const up = () => {
    if (pointer && el.hasPointerCapture(pointer.id)) el.releasePointerCapture(pointer.id);
    pointer = undefined;
    delete el.dataset.dragScroll;
  };
  const click = (e: MouseEvent) => {
    if (!dragged || e.detail === 0) return;
    dragged = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const dragStart = (e: DragEvent) => {
    if (pointer) e.preventDefault();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('click', click, true);
  el.addEventListener('dragstart', dragStart);
  return () => {
    up();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', up);
    el.removeEventListener('click', click, true);
    el.removeEventListener('dragstart', dragStart);
  };
}

/** 直接作为 ref 使用：`<div ref={dragScroll}>`；React 19 卸载时调用返回的清理函数 */
export function dragScroll(el: HTMLElement | null) {
  if (el) return attachDragScroll(el);
}

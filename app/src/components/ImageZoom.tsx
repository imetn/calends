// 文件详情里的图片：点一下在点击处放大、再点还原；触控板捏合或 Ctrl+滚轮缩放，双指捏合缩放，放大后拖动平移
import '../file-preview.css';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const ZOOM = 2.5;
const MAX = 6;
type View = { s: number; x: number; y: number };
const ORIGIN: View = { s: 1, x: 0, y: 0 };

export function ImageZoom({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(ORIGIN);
  const [dragging, setDragging] = useState(false);
  // 按下的指针、拖动起点与是否移动过（移动过就不算点击）
  const gesture = useRef({ pointers: new Map<number, { x: number; y: number }>(), start: { x: 0, y: 0 }, moved: false, pinch: 0 });
  const zoomedNow = useRef(false);

  /** 平移不让图片边缘离开中心：放大后的图最多移到边缘与容器对齐 */
  const clamp = (v: View): View => {
    if (v.s <= 1) return ORIGIN;
    const el = img.current;
    const bx = box.current;
    if (!el || !bx) return v;
    const mx = Math.max(0, (el.offsetWidth * v.s - bx.clientWidth) / 2);
    const my = Math.max(0, (el.offsetHeight * v.s - bx.clientHeight) / 2);
    return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  };
  /** 以容器内一点（相对中心）为锚缩放到 s：该点下的图片位置不动 */
  const zoomAt = (v: View, s: number, px: number, py: number): View => {
    const next = Math.min(MAX, Math.max(1, s));
    return clamp({ s: next, x: px - ((px - v.x) / v.s) * next, y: py - ((py - v.y) / v.s) * next });
  };
  const local = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return [clientX - r.left - r.width / 2, clientY - r.top - r.height / 2] as const;
  };
  const toggle = (clientX?: number, clientY?: number) => {
    if (view.s > 1) return setView(ORIGIN);
    const [px, py] = clientX === undefined ? [0, 0] : local(clientX, clientY!);
    setView(zoomAt(ORIGIN, ZOOM, px, py));
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1) {
      g.start = { x: e.clientX, y: e.clientY };
      g.moved = false;
    }
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      g.moved = true;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const prev = g.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinch > 0) {
        const [px, py] = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        setView((v) => zoomAt(v, v.s * (dist / g.pinch), px, py));
      }
      g.pinch = dist;
      setDragging(true);
      return;
    }
    if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 4) g.moved = true;
    if (g.moved && view.s > 1) {
      setDragging(true);
      setView((v) => clamp({ s: v.s, x: v.x + dx, y: v.y + dy }));
    }
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const single = g.pointers.size === 1 && !g.moved;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinch = 0;
    if (g.pointers.size === 0) {
      setDragging(false);
      if (single && e.type === 'pointerup') toggle(e.clientX, e.clientY);
    }
  };
  // 触控板捏合在浏览器里是带 Ctrl 的滚轮；放大后普通滚轮用来平移，未放大时让弹窗照常滚动。要拦默认滚动，只能挂非被动监听
  useEffect(() => {
    zoomedNow.current = view.s > 1;
  });
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const [px, py] = local(e.clientX, e.clientY);
        setView((v) => zoomAt(v, v.s * Math.exp(-e.deltaY / 100), px, py));
      } else if (zoomedNow.current) {
        e.preventDefault();
        setView((v) => clamp({ s: v.s, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  };

  const zoomed = view.s > 1;
  return (
    <div
      ref={box}
      className={`file-view fp-zoom${zoomed ? ' zoomed' : ''}${dragging ? ' dragging' : ''}`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <img ref={img} src={src} alt={alt} decoding="async" draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }} />
    </div>
  );
}

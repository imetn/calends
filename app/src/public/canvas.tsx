import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fitHeights, placeItem, publicGridBottom, publicGrid, PUBLIC_COLUMNS, PUBLIC_GRID_SECTIONS, PUBLIC_MAX_HEIGHT, type PublicGridId, type PublicGridItem, type PublicRect } from '../../../shared/public-layout.ts';

/** 网格一行的高度和间距，和 index.css 的 .public-grid 一致 */
const ROW = 24;
const GAP = 16;
const STEP = ROW + GAP;
/** 编辑时页面下方留出的空行，卡片才有地方往下放 */
const SPARE_ROWS = 10;
const SCROLL_EDGE = 48;
const SCROLL_SPEED = 12;
/** 指针移动超过这么多才算开始拖，之前不自动滚动 */
const DRAG_START = 3;

export type CanvasText = { labels: Record<string, string>; remove: string; empty: string };
type Mode = 'move' | 'e' | 's' | 'se';
type Drag = { id: string; mode: Mode; base: PublicGridItem[]; from: PublicGridItem; startX: number; startY: number; x: number; y: number; latest: PublicGridItem[]; frame: number };

export const cellVars = (s: PublicRect) => ({ '--x': s.x + 1, '--y': s.y + 1, '--w': s.w, '--h': s.h }) as React.CSSProperties;

/** 卡片内容需要多少行：临时取消拉伸量一次，不会画到屏幕上 */
function naturalRows(cell: HTMLElement): number {
  cell.dataset.measure = '';
  const height = cell.offsetHeight;
  delete cell.dataset.measure;
  return Math.max(1, Math.ceil((height + GAP) / STEP));
}

/** 编辑页的画布：真实卡片摆在网格上，拖动换位置，拖边缘改大小。松手才通知编辑页 */
export function Canvas({ config, blocks, text, onCommit, onRemove }: {
  config: Parameters<typeof publicGrid>[0];
  blocks: Partial<Record<PublicGridId, React.ReactNode>>;
  text: CanvasText;
  onCommit: (items: PublicGridItem[]) => void;
  onRemove: (id: string) => void;
}) {
  const grid = publicGrid(config);
  const key = JSON.stringify(grid);
  const [items, setItems] = useState(grid);
  const [seen, setSeen] = useState(key);
  const [active, setActive] = useState<{ id: string; mode: Mode } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const prevShown = useRef(new Set(grid.filter((s) => !s.hidden).map((s) => s.id as string)));
  if (key !== seen) {
    setSeen(key);
    setItems(grid);
  }

  const cellOf = (id: string) => root.current?.querySelector<HTMLElement>(`[data-cell="${id}"]`);

  // 新添加的卡片在页面最下面，滚过去让主人看到
  useEffect(() => {
    const shown = new Set(items.filter((s) => !s.hidden).map((s) => s.id as string));
    const added = [...shown].find((id) => !prevShown.current.has(id));
    prevShown.current = shown;
    if (added) cellOf(added)?.scrollIntoView({ block: 'center' });
  }, [items]);

  // 改大小时高度不能小于内容；改窄后内容变高，高度也跟着补上
  useLayoutEffect(() => {
    const d = drag.current;
    if (!d || d.mode === 'move') return;
    const cell = cellOf(d.id);
    const item = items.find((s) => s.id === d.id);
    if (!cell || !item) return;
    const need = Math.min(naturalRows(cell), PUBLIC_MAX_HEIGHT);
    if (item.h < need) {
      d.latest = placeItem(d.base, d.id, { ...item, h: need });
      setItems(d.latest);
    }
  }, [items]);

  const apply = () => {
    const d = drag.current;
    if (!d || !root.current) return;
    const dx = (d.x - d.startX) / ((root.current.clientWidth + GAP) / PUBLIC_COLUMNS);
    const dy = (d.y + window.scrollY - d.startY) / STEP;
    const { x, y, w, h } = d.from;
    const rect =
      d.mode === 'move'
        ? { x: x + dx, y: y + dy, w, h }
        : { x, y, w: d.mode === 's' ? w : Math.min(w + dx, PUBLIC_COLUMNS - x), h: d.mode === 'e' ? h : h + dy };
    d.latest = placeItem(d.base, d.id, rect);
    setItems(d.latest);
  };

  const scrollWhileDragging = () => {
    const d = drag.current;
    if (!d) return;
    const by = d.y < SCROLL_EDGE ? -SCROLL_SPEED : d.y > window.innerHeight - SCROLL_EDGE ? SCROLL_SPEED : 0;
    if (by) {
      window.scrollBy(0, by);
      apply();
    }
    d.frame = requestAnimationFrame(scrollWhileDragging);
  };

  const begin = (e: React.PointerEvent<HTMLElement>, id: string, mode: Mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // 先把每张卡的高度补到内容实际需要的行数，之后网格每行等高，指针位置才能直接换算成行
    const need: Record<string, number> = {};
    for (const s of items) {
      const cell = !s.hidden && cellOf(s.id);
      if (cell) need[s.id] = naturalRows(cell);
    }
    const base = fitHeights(items, need);
    drag.current = { id, mode, base, from: base.find((s) => s.id === id)!, startX: e.clientX, startY: e.clientY + window.scrollY, x: e.clientX, y: e.clientY, latest: base, frame: 0 };
    setActive({ id, mode });
    setItems(base);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.frame && Math.abs(d.x - d.startX) + Math.abs(d.y + window.scrollY - d.startY) > DRAG_START) d.frame = requestAnimationFrame(scrollWhileDragging);
    apply();
  };
  const finish = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    drag.current = null;
    setActive(null);
    // 位置和大小最后没变（只点了一下、拖走又拖回）：不算改动，高度补齐也不留下
    const now = d.latest.find((s) => s.id === d.id)!;
    const changed = now.x !== d.from.x || now.y !== d.from.y || now.w !== d.from.w || now.h !== d.from.h;
    if (commit && changed) {
      setItems(d.latest);
      onCommit(d.latest);
    } else setItems(grid);
  };
  const bind = (id: string, mode: Mode) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => begin(e, id, mode),
    onPointerMove: onMove,
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
  });

  // DOM 顺序固定：位置全靠 grid 属性，节点一动指针捕获就断了
  const shown = PUBLIC_GRID_SECTIONS.map((def) => items.find((s) => s.id === def.id)!).filter((s) => !s.hidden);
  return (
    <div ref={root} className="public-grid" data-free="" data-canvas="" data-active={active ? '' : undefined}>
      {shown.map((s) => (
        <div key={s.id} data-cell={s.id} data-active={active?.id === s.id ? '' : undefined} className="public-cell @container" style={cellVars(s)}>
          {blocks[s.id] || <div className="public-canvas-empty">{text.empty}</div>}
          <div className="public-canvas-box" {...bind(s.id, 'move')}>
            <span className="public-canvas-name">{text.labels[s.id]}</span>
            <RemoveButton label={text.remove} onRemove={() => onRemove(s.id)} />
            <i className="public-canvas-handle" data-edge="e" {...bind(s.id, 'e')} />
            <i className="public-canvas-handle" data-edge="s" {...bind(s.id, 's')} />
            <i className="public-canvas-handle" data-edge="se" {...bind(s.id, 'se')} />
          </div>
        </div>
      ))}
      <div aria-hidden="true" style={{ gridColumn: '1 / -1', gridRow: publicGridBottom(items) + SPARE_ROWS }} />
    </div>
  );
}

function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" className="public-canvas-remove" aria-label={label} title={label} onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>
      <X size={14} />
    </button>
  );
}

/** 页脚和订阅堆固定在页面底部：画布上只能移除，不能摆放 */
export function CanvasFixed({ label, text, onRemove, children }: { label: string; text: CanvasText; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="public-canvas-fixed">
      {children}
      <div className="public-canvas-box" data-fixed="">
        <span className="public-canvas-name">{label}</span>
        <RemoveButton label={text.remove} onRemove={onRemove} />
      </div>
    </div>
  );
}

import { useSnapshotRender } from '../snapshot-render.tsx';
import { useRef, type ReactNode as ComponentChildren } from 'react';
import { tipProps, tipSet } from './overlays.tsx';
import { useWidth } from './inputs.tsx';
import { monthTicks } from '../../../shared/format.ts';

/** 每个刻度标签至少留这么宽，窄屏自动换到更稀的一档；宽屏最多 12 个 */
const TICK_PX = 48;
/** 放在组件外：Oxc 版 React Compiler 处理组件里的 Math.max 会放弃优化整个组件 */
const tickBudget = (w: number) => Math.min(12, Math.max(2, Math.floor((w || 600) / TICK_PX)));

/**
 * 横轴标签。pos 为 0–1 的位置；贴边的标签改成左对齐 / 右对齐，不伸出图外。
 * 给了 months（YYYY-MM）就按季度、半年、年等边界取刻度，否则用调用方的 fallback 下标。
 */
function XAxis({ labels, months, pos, w, fallback }: { labels: string[]; months?: string[]; pos: (i: number) => number; w: number; fallback: number[] }) {
  const ticks = months ? monthTicks(months, tickBudget(w)) : fallback;
  const half = w ? 24 / w : 0.02;
  return (
    <div className="area-x">
      {ticks.map((i) => {
        const p = pos(i);
        const transform = p < half ? 'none' : p > 1 - half ? 'translateX(-100%)' : undefined;
        return (
          <span key={i} style={{ left: `${p * 100}%`, transform }}>
            {labels[i]}
          </span>
        );
      })}
    </div>
  );
}

/** 面积折线图：SVG 只画形状，文字用 HTML 叠加，避免被拉伸 */
export function AreaChart({
  values,
  labels,
  height = 160,
  tip,
  markers,
  months,
  now,
  fmt,
}: {
  values: number[];
  labels: string[];
  height?: number;
  tip: (i: number) => ComponentChildren;
  markers?: number[];
  /** 每个点的月份（YYYY-MM）：给了就按日历边界取刻度 */
  months?: string[];
  /** 今天：小数下标与当时的值；之前实线铺底，之后虚线。at < 0 全是预计，不给则全已发生 */
  now?: { at: number; value: number };
  /** 给了就把横线放在整数金额上，并在左侧标出金额 */
  fmt?: (v: number) => string;
}) {
  const W = 1000;
  // 刻度至少到 10，小额时不出现取整后重复的标签；留 8% 余量，曲线不贴顶
  const ticks = fmt ? niceTicks(Math.max(10, ...values) * 1.08, 3).slice(1) : [];
  const max = fmt ? ticks[ticks.length - 1] : Math.max(1, ...values) * 1.12;
  const grid = fmt ? ticks.map((v) => v / max) : [0.25, 0.5, 0.75];
  const n = values.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => height - (v / max) * height;
  // 实线终点：今天，或最后一个点
  const end = !n || (now && now.at < 0) ? undefined : now ? { at: Math.min(now.at, n - 1), value: now.value } : { at: n - 1, value: values[n - 1] };
  const path = (p: Array<[number, number]>) => p.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const done: Array<[number, number]> = end ? [...values.flatMap((v, i): Array<[number, number]> => (i < end.at ? [[i, v]] : [])), [end.at, end.value]] : [];
  const todo: Array<[number, number]> = [
    ...(end ? [[end.at, end.value] as [number, number]] : []),
    ...values.flatMap((v, i): Array<[number, number]> => (!end || i > end.at ? [[i, v]] : [])),
  ];
  const line = done.length ? path(done) : '';
  const rest = todo.length > 1 ? path(todo) : '';
  const area = end && end.at > 0 ? `${line}L${x(end.at).toFixed(1)},${height}L0,${height}Z` : '';
  const step = Math.max(1, Math.ceil(n / 8));
  const [box, w] = useWidth();
  useSnapshotRender(box, () => <AreaChart values={values} labels={labels} height={height} tip={tip} markers={markers} months={months} now={now} fmt={fmt} />);
  return (
    <div className="area" ref={box} style={{ height: height + 22 }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }}>
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--chart-ink)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--chart-ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={height * (1 - f)}
            y2={height * (1 - f)}
            stroke="var(--sep)"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 4"
          />
        ))}
        {area && <path d={area} fill="url(#area-fill)" />}
        {line && <path d={line} fill="none" stroke="var(--chart-ink)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        {rest && (
          <path d={rest} fill="none" stroke="var(--label-3)" strokeWidth="2.2" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        )}
      </svg>
      {markers?.map((i) => (
        <i key={i} className="area-mark" style={{ left: `${(x(i) / W) * 100}%`, top: y(values[i]) }} />
      ))}
      {fmt &&
        ticks.map((v) => (
          <span key={v} className="area-y" style={{ top: y(v) }}>
            {fmt(v)}
          </span>
        ))}
      {end && <i className="area-end" style={{ left: `${(x(end.at) / W) * 100}%`, top: y(end.value) }} />}
      <div className="area-hit">
        {values.map((_, i) => (
          <span key={i} {...tipProps(() => tip(i))} />
        ))}
      </div>
      <XAxis labels={labels} months={months} w={w} pos={(i) => x(i) / W} fallback={labels.flatMap((_, i) => (i % step === 0 || i === n - 1 ? [i] : []))} />
    </div>
  );
}

/** 柱顶金额每个字符约占的宽度（12px 等宽数字），用来判断放不放得下 */
const VAL_PX = 7;

/** 柱子宽度：占格宽的比例与上限，与 design-tokens.css 的 --bar-ratio、--bar-max 同值，给 SVG 画的柱子用 */
export const BAR = { ratio: 0.6, max: 28 };

/** 柱 + 线：柱为现金，线为权责 */
export function BarLine({
  bars,
  line,
  labels,
  future,
  height = 150,
  tip,
  months,
  fmt,
  onPick,
}: {
  bars: number[];
  line: number[];
  labels: string[];
  future: boolean[];
  height?: number;
  tip: (i: number) => ComponentChildren;
  /** 每根柱子的月份（YYYY-MM）：给了就按日历边界取刻度 */
  months?: string[];
  /** 给了就在柱顶标金额，返回空串的柱子不标；顶部留出一行字的高度 */
  fmt?: (v: number, i: number) => string;
  /** 给了柱子就可点：鼠标点一下就触发；触屏第一下先弹浮窗看金额，同一根再点一下才触发 */
  onPick?: (i: number) => void;
}) {
  const max = Math.max(1, ...bars, ...line) * 1.08;
  const min = Math.min(0, ...bars, ...line) * 1.08;
  const span = max - min;
  const pad = fmt ? 18 : 0;
  const y = (v: number) => pad + ((max - v) / span) * (height - pad);
  const n = bars.length;
  const W = 1000;
  const cx = (i: number) => ((i + 0.5) / n) * W;
  const path = line.map((v, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  // 每个月份标签约占 44px，按实际宽度决定隔几根柱子标一次，窄屏不挤
  const [box, w] = useWidth();
  useSnapshotRender(box, () => <BarLine bars={bars} line={line} labels={labels} future={future} height={height} tip={tip} months={months} fmt={fmt} />);
  // 在按下时判断：触屏按下的是上次已点过的那根才放行。iOS 第一下可能只弹浮窗不派发 click，按下时记账两种情况都对
  const armed = useRef(-1);
  const ready = useRef(false);
  const press = (i: number, pointer: string) => {
    ready.current = pointer === 'mouse' || armed.current === i;
    armed.current = pointer === 'mouse' ? -1 : i;
  };
  // 键盘触发的 click（detail 为 0）没有按下这一步，直接放行
  const pick = (i: number, detail: number) => {
    const go = detail === 0 || ready.current;
    ready.current = false;
    if (!go) return;
    armed.current = -1;
    tipSet?.(null);
    onPick?.(i);
  };
  const Col = onPick ? 'button' : 'div';
  const step = Math.max(1, Math.ceil(n / Math.min(12, Math.max(2, Math.floor(w / 44) || 12))));
  // 柱顶金额：每格放得下就每根都标，放不下只标最高的一根
  const vals = fmt ? bars.map((v, i) => (v >= 0.5 ? fmt(v, i) : '')) : [];
  // 加上左右 2px 内边距，再留 2px 间隔
  const fits = !!w && vals.every((s) => s.length * VAL_PX + 6 <= w / n);
  const top = bars.indexOf(Math.max(...bars));
  const shown = (i: number) => !!vals[i] && (fits || i === top);
  return (
    <div className="barline" ref={box} style={{ height: height + 22 }}>
      <div className="bl-bars" style={{ height }}>
        {bars.map((v, i) => (
          <Col
            key={i}
            className={`bl-col ${future[i] ? 'future' : ''}`}
            style={{ position: 'relative' }}
            {...tipProps(() => tip(i))}
            {...(onPick
              ? {
                  type: 'button' as const,
                  'aria-label': labels[i],
                  onPointerDown: (e: { pointerType: string }) => press(i, e.pointerType),
                  onClick: (e: { detail: number }) => pick(i, e.detail),
                }
              : {})}
          >
            <i style={{ position: 'absolute', top: y(Math.max(0, v)), height: (Math.abs(v) / span) * (height - pad) }} />
            {shown(i) && (
              // 折线在柱顶之上时标到折线点上方，免得线穿过数字
              <span className="bl-val" style={{ top: Math.min(y(Math.max(0, v)), y(line[i] ?? v)) - 3 }}>
                {vals[i]}
              </span>
            )}
          </Col>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }} className="bl-line">
        {min < 0 && <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--sep)" vectorEffect="non-scaling-stroke" />}
        <path d={path} fill="none" stroke="var(--chart-ink)" strokeWidth="2.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <XAxis labels={labels} months={months} w={w} pos={(i) => cx(i) / W} fallback={labels.flatMap((_, i) => (i % step === 0 ? [i] : []))} />
    </div>
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  i: number;
}

/** Squarified treemap（Bruls et al.），坐标为百分比 */
export function squarify(values: number[], x = 0, y = 0, w = 100, h = 100): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const items = values
    .map((v, i) => ({ v: (v / total) * w * h, i }))
    .filter((t) => t.v > 0)
    .sort((a, b) => b.v - a.v);
  const out: Rect[] = [];
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row);
    const mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  let rect = { x, y, w, h };
  let row: typeof items = [];
  const layout = (r: typeof items) => {
    const s = r.reduce((a, b) => a + b.v, 0);
    if (rect.w >= rect.h) {
      const cw = s / rect.h;
      let cy = rect.y;
      for (const t of r) {
        const ch = t.v / cw;
        out.push({ x: rect.x, y: cy, w: cw, h: ch, i: t.i });
        cy += ch;
      }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const ch = s / rect.w;
      let cx = rect.x;
      for (const t of r) {
        const cw = t.v / ch;
        out.push({ x: cx, y: rect.y, w: cw, h: ch, i: t.i });
        cx += cw;
      }
      rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
    }
  };
  for (const t of items) {
    const side = Math.min(rect.w, rect.h);
    if (
      !row.length ||
      worst([...row.map((r) => r.v), t.v], side) <=
        worst(
          row.map((r) => r.v),
          side,
        )
    )
      row.push(t);
    else {
      layout(row);
      row = [t];
    }
  }
  if (row.length) layout(row);
  return out;
}

/** 取整齐的刻度：1 / 2 / 2.5 / 5 × 10^n */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export interface Bucket {
  key: string;
  label: string;
  parts: Array<{ k: string; v: number }>;
  total: number;
  future: boolean;
  current: boolean;
}

/** 堆叠柱状图：有刻度、可选中，未来为斜纹 */
/** 相邻同色的分段合成一段，单色柱子里不留发丝缝 */
function mergeByColor(parts: Bucket['parts'], color: (k: string) => string) {
  const out: Array<{ k: string; v: number; c: string }> = [];
  for (const p of parts) {
    const c = color(p.k);
    const last = out[out.length - 1];
    if (last?.c === c) last.v += p.v;
    else out.push({ k: p.k, v: p.v, c });
  }
  return out;
}

export function Activity({
  buckets,
  color,
  selected,
  current,
  onSelect,
  height = 220,
  fmt,
  tip,
}: {
  buckets: Bucket[];
  color: (k: string) => string;
  selected?: string;
  current?: string;
  onSelect: (k: string) => void;
  height?: number;
  fmt: (v: number) => string;
  /** 悬停柱子时的明细；柱子统一单色，构成靠这里读 */
  tip?: (b: Bucket) => ComponentChildren;
}) {
  const ticks = niceTicks(Math.max(1, ...buckets.map((b) => b.total)));
  const top = ticks[ticks.length - 1];
  return (
    <div className="act" style={{ '--h': `${height}px` } as Record<string, string>}>
      <div className="act-grid">
        {ticks.map((t) => (
          <div key={t} className="act-tick" style={{ bottom: `${(t / top) * 100}%` }}>
            <span>{fmt(t)}</span>
          </div>
        ))}
      </div>
      <div className="act-bars">
        {buckets.map((b, i) => (
          <button
            key={b.key}
            data-snapshot-keep
            className={`act-col ${(buckets.length - 1 - i) % 2 ? 'odd' : ''} ${b.future ? 'future' : ''} ${b.current ? 'current' : ''} ${(selected ?? current) === b.key ? 'sel' : ''} ${selected && selected !== b.key ? 'dim' : ''}`}
            onClick={() => onSelect(b.key)}
            aria-label={`${b.label} ${fmt(b.total)}`}
            {...(tip && b.total > 0 ? tipProps(() => tip(b)) : {})}
          >
            <div className="act-stack" style={{ height: `${(b.total / top) * 100}%` }}>
              {/* 颜色传 pending 的一段是还没扣的（本月待扣）：与全站「未扣」同一种虚框样式 */}
              {mergeByColor(b.parts, color).map((p) =>
                p.c === 'pending' ? (
                  <i key={p.k} className="act-pending" style={{ flexGrow: p.v }} />
                ) : (
                  <i key={p.k} style={{ flexGrow: p.v, background: p.c }} />
                ),
              )}
            </div>
            <span className="act-label">{b.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export interface Bubble {
  x: number;
  y: number;
  r: number;
  i: number;
}

/**
 * 圆堆积：面积 ∝ 数值。最大的放中心，之后每个圆贴着已有的圆找离中心最近、且不重叠的位置。
 * 返回的坐标已归一化到 [0, 1] 的正方形里。
 */
export function packCircles(values: number[], aspect = 1.6): Bubble[] {
  const order = values
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);
  const placed: Bubble[] = [];
  const max = order[0]?.v ?? 1;
  const top = Math.sqrt(max);
  // 半径按金额的 0.45 次方：比开平方更贴近真实差距，又不至于让小订阅缩成一个点；最小保留 14%
  const radius = (v: number) => top * (0.14 + 0.86 * Math.pow(v / max, 0.45));
  const gap = top * 0.04;
  for (const { v, i } of order) {
    const r = radius(v);
    if (!placed.length) {
      placed.push({ x: 0, y: 0, r, i });
      continue;
    }
    let best: Bubble | undefined;
    let bestD = Infinity;
    for (const p of placed) {
      for (let a = 0; a < 360; a += 10) {
        const t = (a * Math.PI) / 180;
        const d = p.r + r + gap;
        const x = p.x + Math.cos(t) * d;
        const y = p.y + Math.sin(t) * d;
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + gap - 1e-6)) continue;
        // 以椭圆距离衡量离中心远近，整体铺成横向的椭圆团
        const dc = Math.hypot(x / aspect, y) + r * 0.3;
        if (dc < bestD) {
          bestD = dc;
          best = { x, y, r, i };
        }
      }
    }
    placed.push(best!);
  }
  if (!placed.length) return [];
  const minX = Math.min(...placed.map((p) => p.x - p.r));
  const maxX = Math.max(...placed.map((p) => p.x + p.r));
  const minY = Math.min(...placed.map((p) => p.y - p.r));
  const maxY = Math.max(...placed.map((p) => p.y + p.r));
  const w = maxX - minX;
  const h = maxY - minY;
  return placed.map((p) => ({ i: p.i, r: p.r / w, x: (p.x - minX) / w, y: (p.y - minY) / w, h: h / w }) as Bubble & { h: number });
}

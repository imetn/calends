import { DAYS_PER_MONTH } from '../../../shared/billing.ts';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { addMonths, diffDays } from '../../../shared/billing.ts';
import { monthLabel } from '../../../shared/format.ts';
import { useWidth } from '../components/inputs.tsx';
import { BAR } from '../components/charts.tsx';

export interface ChartBar {
  date: string;
  /** 折合记账货币的金额；缺汇率时为 NaN，画成占位的短柱 */
  v: number;
  /** 今天之后的预测扣款 */
  future?: boolean;
  /** 标价参照（按那一段首笔的汇率折算），画成虚线台阶；高出或低于它就是汇率带来的涨跌 */
  list?: number;
  /** 属于哪一段方案：只有不同方案的扣款挨在一起时才并排，同一方案的相邻扣款各自一根 */
  phase?: string;
  /** 首期优惠期间这一笔的原价（同单位）：实际扣的是实色，原价比实际多出的部分画成柱顶的虚框 */
  full?: number;
}

export interface ChartLane {
  key: string;
  from: string;
  to: string;
  lane: number;
  color: string;
  label: ReactNode;
  /** 色带窄时只写价格，不写周期 */
  short?: ReactNode;
  aside?: ReactNode;
}

const PAD_L = 44;
const PAD_R = 14;
const LANE = 24;
/** 柱区高度与顶部留白（留给「今天」标签） */
const H = 150;
const T = 18;

/** 刻度取 1、2、2.5、5 × 10ⁿ，让 4 格左右正好盖住最大值 */
function niceStep(max: number) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

/**
 * 扣款时间轴：横轴是真实日期，每笔扣款一根柱。今天之前是实际扣款，之后是预测，中间一条「今天」虚线；
 * 下面是各段方案的轨道。悬停（或手指按住拖动）时高亮最近的一根并出现明细卡片。
 */
export function ChargeBars({
  bars,
  from,
  to,
  today,
  todayLabel,
  fmt,
  lanes,
  tip,
  onBucket,
}: {
  bars: ChartBar[];
  from: string;
  to: string;
  today: string;
  todayLabel: string;
  fmt: (v: number) => string;
  lanes: ChartLane[];
  tip: (indices: number[], summed: boolean) => ReactNode;
  /** 柱子太密改为按月（1）、季（3）、年（12）汇总时，告诉调用方写一句说明 */
  onBucket?: (months: number) => void;
}) {
  const [box, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const span = Math.max(1, diffDays(from, to));
  const iw = Math.max(1, w - PAD_L - PAD_R);
  const x = (d: string) => PAD_L + (Math.min(span, Math.max(0, diffDays(from, d))) / span) * iw;
  type Group = { x: number; idx: number[]; future: boolean; stack: boolean };
  // 1) 换方案、换卡、并行方案时，不同方案的两笔相隔 10 天以内：并排放在同一位置，悬停时逐笔列出
  const near: Group[] = [];
  bars.forEach((b, i) => {
    const last = near[near.length - 1];
    const prev = last && bars[last.idx[last.idx.length - 1]];
    if (last && prev && !!b.future === last.future && prev.phase !== b.phase && diffDays(prev.date, b.date) <= 10) last.idx.push(i);
    else near.push({ x: 0, idx: [i], future: !!b.future, stack: true });
  });
  // 2) 太密时（柱距不到 7px）按月、季、年汇总成一根实心柱，柱子代表那段时间的合计，不再分段
  const fit = Math.max(4, Math.floor(iw / 7));
  const bucketOf = (d: string, by: number) => {
    const m = Number(d.slice(5, 7)) - 1;
    return `${d.slice(0, 4)}-${by === 12 ? 0 : Math.floor(m / by)}`;
  };
  let groups: Group[] = near;
  let bucket = 0;
  for (const by of [1, 3, 12]) {
    if (groups.length <= fit) break;
    bucket = by;
    const merged: Group[] = [];
    for (const g of near) {
      const k = bucketOf(bars[g.idx[0]].date, by) + (g.future ? '+' : '');
      const last = merged[merged.length - 1];
      const lk = last && bucketOf(bars[last.idx[0]].date, by) + (last.future ? '+' : '');
      if (last && lk === k) last.idx.push(...g.idx);
      else merged.push({ x: 0, idx: [...g.idx], future: g.future, stack: false });
    }
    groups = merged;
  }
  useEffect(() => onBucket?.(bucket), [bucket, onBucket]);
  // 柱子放在组内各笔日期的平均位置
  for (const g of groups) g.x = g.idx.reduce((a, i) => a + x(bars[i].date), 0) / g.idx.length;
  // 柱宽随密度变：密时 3px，稀疏的年付最宽 BAR.max（与全站柱宽一致）
  const bw = Math.max(3, Math.min(BAR.max, (iw / Math.max(1, groups.length)) * BAR.ratio));
  const val = (i: number) => (Number.isFinite(bars[i].v) ? Math.max(0, bars[i].v) : 0);
  const listOf = (g: Group) =>
    g.idx.every((i) => bars[i].list != null)
      ? g.stack
        ? Math.max(...g.idx.map((i) => bars[i].list!))
        : g.idx.reduce((a, i) => a + bars[i].list!, 0)
      : undefined;
  const max =
    Math.max(
      0,
      ...groups.map((g) =>
        Math.max(
          g.idx.reduce((a, i) => a + val(i), 0),
          listOf(g) ?? 0,
        ),
      ),
    ) || 1;
  const step = niceStep(max * 1.08);
  const top = Math.ceil((max * 1.08) / step) * step;
  const y = (v: number) => T + (1 - v / top) * (H - T - 6);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const cx = groups.map((g) => g.x);

  // 月份刻度：间隔按宽度挑，最多约每 90px 一个
  const months = Math.max(1, Math.round(span / DAYS_PER_MONTH));
  const every = [1, 2, 3, 6, 12, 24, 36].find((m) => (months / m) * 90 <= iw) ?? 48;
  const xt: Array<{ d: string; label: string }> = [];
  for (let d = addMonths(`${from.slice(0, 7)}-01`, 1); d <= to; d = addMonths(d, 1)) {
    const m = Number(d.slice(5, 7)) - 1;
    if (every >= 12 ? m !== 0 || Number(d.slice(0, 4)) % (every / 12) : m % every) continue;
    xt.push({ d, label: m === 0 ? d.slice(0, 4) : monthLabel(d.slice(0, 7), { year: false }) });
  }

  const nLanes = lanes.reduce((m, l) => Math.max(m, l.lane + 1), 0);
  const onMove = (e: React.PointerEvent) => {
    if (!bars.length) return;
    const px = e.clientX - box.current!.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < cx.length; i++) if (Math.abs(cx[i] - px) < Math.abs(cx[best] - px)) best = i;
    setHover(best);
  };
  const hx = hover != null ? cx[hover] : 0;
  const tx = x(today);
  const showToday = today >= from && today <= to;

  return (
    <div className="cc" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
      {w > 0 && (
        <>
          <svg className="cc-plot" width={w} height={H}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="cc-grid" x1={PAD_L} x2={w - PAD_R} y1={y(v)} y2={y(v)} />
                <text className="cc-tk" x={PAD_L - 8} y={y(v) + 3.5} textAnchor="end">
                  {fmt(v)}
                </text>
              </g>
            ))}
            {groups.map((g, gi) => {
              const on = hover === gi ? 'on' : '';
              // 汇总柱：一根实心柱，高度是这段时间的合计；有一笔缺汇率就画成浅色短块
              if (!g.stack || g.idx.length === 1) {
                const ok = g.idx.every((i) => Number.isFinite(bars[i].v));
                const sum = g.idx.reduce((a, i) => a + val(i), 0);
                const by = ok ? Math.min(y(sum), y(0) - 2) : y(0) - 4;
                const full = g.idx.length === 1 ? bars[g.idx[0]].full : undefined;
                return (
                  <g key={gi}>
                    {/* 首期优惠：先画一整根原价高度的未扣柱（与预测同一种虚框样式），实际扣的实色柱从底部涨到它的金额为止 */}
                    {ok && full != null && full > sum && (
                      <rect className={`cc-bar future ${on}`} x={g.x - bw / 2} y={y(full)} width={bw} height={y(0) - y(full)} rx={Math.min(3, bw / 2)} />
                    )}
                    <rect
                      className={`cc-bar ${g.future ? 'future' : ''} ${ok ? '' : 'unknown'} ${on}`}
                      x={g.x - bw / 2}
                      y={by}
                      width={bw}
                      height={y(0) - by}
                      rx={Math.min(3, bw / 2)}
                    />
                  </g>
                );
              }
              // 挨在一起的几笔（不同方案）：同一位置左右并排，每笔一根窄柱，中间留 1px 缝
              const n = g.idx.length;
              const w1 = Math.max(2, (bw - (n - 1)) / n);
              return g.idx.map((i, k) => {
                const ok = Number.isFinite(bars[i].v);
                const by = ok ? Math.min(y(val(i)), y(0) - 2) : y(0) - 4;
                return (
                  <rect
                    key={i}
                    className={`cc-bar ${g.future ? 'future' : ''} ${ok ? '' : 'unknown'} ${on}`}
                    x={g.x - bw / 2 + k * (w1 + 1)}
                    y={by}
                    width={w1}
                    height={y(0) - by}
                    rx={Math.min(2, w1 / 2)}
                  />
                );
              });
            })}
            {/* 标价参照：每根柱上一段虚线，相邻相同时连成台阶；汇总柱用组内合计 */}
            {(() => {
              let d = '';
              let prev: number | undefined;
              groups.forEach((g) => {
                const lv = listOf(g);
                if (lv == null) {
                  prev = undefined;
                  return;
                }
                const ly = y(lv);
                const x0 = g.x - bw / 2 - 2;
                const x1 = g.x + bw / 2 + 2;
                d += prev == null ? `M${x0},${ly}H${x1}` : `L${x0},${prev}L${x0},${ly}H${x1}`;
                prev = ly;
              });
              return d && <path className="cc-list" d={d} />;
            })()}
            {showToday && <line className="cc-today" x1={tx} x2={tx} y1={T - 4} y2={H} />}
            {showToday && (
              <text className="cc-today-l" x={tx} y={T - 8} textAnchor={tx > w - PAD_R - 24 ? 'end' : tx < PAD_L + 24 ? 'start' : 'middle'}>
                {todayLabel}
              </text>
            )}
          </svg>
          {nLanes > 0 && (
            <div className="cc-lanes" style={{ height: nLanes * LANE + 4, marginLeft: PAD_L, marginRight: PAD_R }}>
              {lanes.map((l) => {
                const a = Math.max(PAD_L, x(l.from));
                const b = Math.min(w - PAD_R, x(l.to > to ? to : l.to));
                return (
                  <div
                    key={l.key}
                    className="cc-lane"
                    style={{ left: a - PAD_L, width: Math.max(6, b - a), top: l.lane * LANE + 4, '--tint': l.color } as Record<string, string | number>}
                  >
                    {b - a > 56 && <b>{b - a > 120 ? l.label : (l.short ?? l.label)}</b>}
                    {l.aside && b - a > 260 && <span>{l.aside}</span>}
                  </div>
                );
              })}
              {showToday && <i className="cc-today-lane" style={{ left: tx - PAD_L }} />}
            </div>
          )}
          <div className="cc-xt" style={{ marginLeft: PAD_L, marginRight: PAD_R }}>
            {xt.map((t) => (
              <span key={t.d} style={{ left: x(t.d) - PAD_L }}>
                {t.label}
              </span>
            ))}
          </div>
          {hover != null && (
            <div className="cc-tip" style={hx > w / 2 ? { right: w - hx + 14 } : { left: hx + 14 }}>
              {tip(groups[hover].idx, !groups[hover].stack)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

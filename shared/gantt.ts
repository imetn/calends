import { DAYS_PER_MONTH } from './billing.ts';
import { addDays, addMonths, chargeServicePeriod, chargesBetween, coveredUntil, cycleDays, diffDays, effectiveStatus, isStopped, parseDay, phaseLanes, phaseSubs } from './billing.ts';
import type { Subscription } from './types.ts';
import { dateFormat } from './intl.ts';

export type GanttZoom = '3m' | '6m' | '1y' | '3y' | 'all';
export const isGanttZoom = (v: string): v is GanttZoom => ['3m', '6m', '1y', '3y', 'all'].includes(v);
export const GANTT_STEP: Record<Exclude<GanttZoom, 'all'>, number> = { '3m': 3, '6m': 6, '1y': 12, '3y': 36 };

/**
 * 没有结束日的订阅在时间轴上画到哪里：今天之后的下一次扣款所覆盖的服务期末尾。
 * 即过去各期 + 当前这一期 + 再往后一期，不一直铺到视窗尽头（末端由视图渐隐表示还会继续）。
 */
export function ganttOpenEnd(v: Subscription, today: string): string {
  const days = Math.max(1, Math.ceil(cycleDays(v.cycle)));
  const from = v.start > today ? v.start : addDays(today, 1);
  const next = chargesBetween(v, from, addDays(from, days * 2 + 31), today).find((c) => !c.kind);
  return next ? chargeServicePeriod(v, next.date).until : addDays(from, days);
}

/** 名称列以图标为下限、最长名称为上限，至少给轨道留出一半容器。 */
export function ganttLabelBounds(
  textWidth: number,
  containerWidth: number,
  style: { paddingLeft: number; paddingRight: number; iconWidth: number; gap: number },
  defaultWidth = 200,
): { min: number; max: number; default: number } {
  const min = Math.ceil(style.paddingLeft + style.iconWidth + style.paddingRight);
  const full = Math.ceil(min + (textWidth > 0 ? style.gap + textWidth : 0));
  const max = Math.max(min, Math.min(full, containerWidth > 0 ? Math.floor(containerWidth / 2) : full));
  return { min, max, default: Math.max(min, Math.min(defaultWidth, max)) };
}

/** 今天留在中偏右；短范围仍保留足够的未来空间。全部从最早一笔的月初开始。 */
/** 「全部」刚好装下当前这一批：从最早开始的那个月起；都已结束时到最后那个月末，还有进行中的只到今天 */
/** 固定范围：总月数与今天之后保留的天数 */
const FIXED_WINDOW = { '3m': [3, 7], '6m': [6, 10], '1y': [12, 15], '3y': [36, 45] } as const;

export function ganttWindow(
  zoom: GanttZoom,
  today: string,
  earliest = today,
  latest?: string,
  ongoing = latest == null || latest > today,
): { start: string; end: string } {
  switch (zoom) {
    case '3m':
    case '6m':
    case '1y':
    case '3y': {
      // 与「全部」一样以今天为主：今天线靠右，只留几天到一个半月余量，未来往右拖动再看
      const [months, ahead] = FIXED_WINDOW[zoom];
      const end = addDays(today, ahead);
      return { start: addMonths(end, -months), end };
    }
    case 'all': {
      const start = `${earliest.slice(0, 7)}-01`;
      if (!latest) return { start, end: addMonths(today, 6) };
      // 都已结束：停在最后那个月；还有进行中的：只到今天，留约 2% 余量让今天线不压在边上，未来部分看固定范围
      if (!ongoing) return { start, end: addMonths(`${latest.slice(0, 7)}-01`, 1) };
      return { start, end: addDays(today, Math.max(7, Math.round(diffDays(start, today) * 0.02))) };
    }
  }
}

/** 吸附到最近的月份锚点，保留基准日号；短月夹紧到月底，不产生 2/31 等无效日期。 */
export function snapGanttPan(baseStart: string, raw: number): number {
  const day = addDays(baseStart, Math.round(raw));
  const month = monthDistance(baseStart, day);
  const candidates = [month - 1, month, month + 1].map((n) => diffDays(baseStart, addMonths(baseStart, n)));
  return candidates.reduce((best, n) => (Math.abs(n - raw) < Math.abs(best - raw) ? n : best));
}

function monthDistance(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/** 翻页也沿用基准日号，跨过二月后再返回不会逐渐漂离月份锚点。 */
export function stepGanttPan(baseStart: string, raw: number, months: number): number {
  const month = monthDistance(baseStart, addDays(baseStart, snapGanttPan(baseStart, raw)));
  return diffDays(baseStart, addMonths(baseStart, month + months));
}

export interface GanttTick {
  d: string;
  major: boolean;
  label: string;
  labelX: number;
}

/** 网格与文字独立：3 个月按周，半年按半月；窄屏保留细网格，文字按宽度抽稀。 */
export function ganttTicks(zoom: GanttZoom, start: string, end: string, width: number, locale: string): GanttTick[] {
  if (width <= 0) return [];
  const short = zoom === '3m' || zoom === '6m';
  const k = width / Math.max(1, diffDays(start, end));
  const fmt = dateFormat(locale, { timeZone: 'UTC', ...(short ? { month: 'numeric', day: 'numeric' } : { month: 'short' }) });
  const dates: string[] = [];
  if (zoom === '3m') {
    const weekday = new Date(parseDay(start)).getUTCDay();
    for (let d = addDays(start, (8 - weekday) % 7); d <= end; d = addDays(d, 7)) dates.push(d);
  } else {
    const monthPx = k * DAYS_PER_MONTH;
    const every = [1, 2, 3, 6, 12].find((n) => n >= (zoom === '3y' ? 3 : 1) && monthPx * n >= 40) ?? 12;
    for (let d = `${start.slice(0, 7)}-01`; d <= end; d = addMonths(d, 1)) {
      if (zoom === '6m') {
        if (d >= start) dates.push(d);
        const mid = `${d.slice(0, 7)}-15`;
        if (mid >= start && mid <= end) dates.push(mid);
      } else if (d >= start && (d.slice(5, 7) === '01' || (zoom !== 'all' && (Number(d.slice(5, 7)) - 1) % every === 0))) dates.push(d);
    }
  }
  let labelEnd = -8;
  return dates.map((d) => {
    const major = short ? Number(d.slice(8)) <= (zoom === '3m' ? 7 : 1) : d.slice(5, 7) === '01';
    const text = !short && major ? d.slice(0, 4) : fmt.format(new Date(parseDay(d)));
    // 11px 字号保守预留字符宽度与两端空隙；标签中心夹在轨道内，避免边缘截字。
    const labelWidth = Array.from(text).reduce((n, c) => n + (c.codePointAt(0)! > 0x024f ? 12 : 8), 0);
    const labelX = Math.min(width - labelWidth / 2, Math.max(labelWidth / 2, diffDays(start, d) * k));
    const fits = labelWidth <= width && labelX - labelWidth / 2 >= labelEnd + 8;
    if (fits) labelEnd = labelX + labelWidth / 2;
    return { d, major, label: fits ? text : '', labelX };
  });
}

export interface YearsBar {
  v: Subscription;
  from: string;
  to: string;
  /** 还在继续，画到今天 */
  ongoing: boolean;
  lane: number;
}
export interface YearsRow {
  s: Subscription;
  bars: YearsBar[];
  gaps: Array<{ from: string; to: string }>;
  lanes: number;
}

/** 公开页订阅年表：只画到今天，还没开始的阶段不画；从最早一年的 1 月起，保证至少有一个年份刻度 */
export function yearsTimeline(subs: Subscription[], today: string): { rows: YearsRow[]; start: string; end: string; ongoing: boolean } {
  const rows = subs.flatMap((s): YearsRow[] => {
    const parts = phaseSubs(s)
      .filter((v) => v.start <= today)
      .map((v) => {
        const paused = v.status === 'paused' ? v.pausedAt : undefined;
        const stops = [v.end, v.stop?.date, paused].filter((d): d is string => !!d && d <= today).sort();
        const to = stops[0] && stops[0] > v.start ? stops[0] : stops[0] ? v.start : today;
        // 买断没有结束日时只是一个购买点
        const point = v.cycle.unit === 'lifetime' && !stops[0];
        return { v, from: v.start, to: point ? v.start : to, ongoing: !point && !stops[0] && !isStopped(effectiveStatus(v, today)) };
      });
    if (!parts.length) return [];
    const spans = parts.map((p) => ({ start: p.from, end: p.ongoing ? undefined : p.to }));
    const lanes = phaseLanes(spans);
    const gaps = parts.slice(1).flatMap((p, i) => {
      const until = coveredUntil(spans, i + 1);
      return until && until < p.from ? [{ from: until, to: p.from }] : [];
    });
    return [{ s, bars: parts.map((p, i) => ({ ...p, lane: lanes[i] })), gaps, lanes: Math.max(...lanes) + 1 }];
  });
  rows.sort((a, b) => a.bars[0].from.localeCompare(b.bars[0].from) || a.s.name.localeCompare(b.s.name));
  const earliest = rows.reduce((m, r) => (r.bars[0].from < m ? r.bars[0].from : m), today);
  const latest = rows.reduce((m, r) => r.bars.reduce((n, b) => (b.to > n ? b.to : n), m), earliest);
  const ongoing = rows.some((r) => r.bars.some((b) => b.ongoing));
  return { rows, ongoing, ...ganttWindow('all', today, `${earliest.slice(0, 4)}-01-01`, latest, ongoing) };
}

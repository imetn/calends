import { addDays, addMonths, diffDays } from './billing.ts';
import { isSettled, type LedgerPeriod } from './receivables.ts';

export type PeriodGridMode = 'months' | 'weeks' | 'periods';
export interface PeriodSegment {
  period: LedgerPeriod;
  /** Zero-based column and number of cells, with no gap inside the segment. */
  column: number;
  span: number;
  start: boolean;
  end: boolean;
  /** 按月排时的半格位置（一年 24 个半格）：同一个月里切出两期时各占半个月，其余整月占两个半格 */
  track?: number;
  tracks?: number;
}
export interface PeriodGridRow {
  key: string;
  year?: number;
  quarter?: number;
  segments: PeriodSegment[];
}
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** Infer presentation from the derived schedule, including clipped joining/final periods. */
export function periodGridMode(periods: LedgerPeriod[]): PeriodGridMode {
  const spans = periods.map((p, i) => [p.from, periods[i + 1]?.from ?? addDays(p.until, 1)]);
  const months = spans.map(([from, next]) => monthIndex(next) - monthIndex(from));
  const exact = spans.map(([from, next], i) => months[i] > 0 && addMonths(from, months[i]) === next);
  // 每一期都须是整月，例外只有首期（入伙截短）和同一个月里切出的两期及其相邻一期（改过收费）；
  // 30 天等固定天数周期偶尔恰逢整月，不能据此按月排
  const monthly = exact.some(Boolean) && spans.every((_, i) => exact[i] || i === 0 || months[i] === 0 || months[i - 1] === 0 || months[i + 1] === 0);
  if (monthly && months.every((m) => m >= 0)) return 'months';
  if (spans.length && spans.every(([from, next]) => diffDays(from, next) === 7)) return 'weeks';
  return 'periods';
}

/** All started periods, prepaid future periods, then the first future period still to collect. */
export function visibleStripPeriods(periods: LedgerPeriod[], today: string): LedgerPeriod[] {
  const sorted = [...periods].sort((a, b) => a.from.localeCompare(b.from));
  const next = sorted.findIndex((p) => p.from > today && !isSettled(p));
  return next < 0 ? sorted : sorted.slice(0, next + 1);
}

/** How a period cell is drawn; the member sheet strip and the shared-plan table both use this. Prepaid future periods draw as settled. */
export function periodCellKind(p: LedgerPeriod, today: string): LedgerPeriod['status'] {
  return p.from > today && !isSettled(p) ? 'upcoming' : p.status;
}

/** Pure presentation: keeps dates, dues and receipt allocation untouched. */
export function periodGrid(periods: LedgerPeriod[], today: string, mode = periodGridMode(periods)) {
  const all = [...periods].sort((a, b) => a.from.localeCompare(b.from));
  const visible = visibleStripPeriods(all, today);
  const columns = mode === 'weeks' ? 13 : 12;
  const rows: PeriodGridRow[] = [];
  const rowFor = (key: string, year?: number, quarter?: number) => {
    let row = rows.find((r) => r.key === key);
    if (!row) rows.push((row = { key, year, quarter, segments: [] }));
    return row;
  };
  if (mode === 'months') {
    // 以半个月为单位排：改过收费可能在同一个月里切出两期（如 1月10日–16日 和 1月17日起），
    // 前一期占这个月的前半格、后一期占后半格，其余各期仍在自己的月份上，不会整体顺延
    let cursor = -Infinity;
    all.forEach((p, index) => {
      const next = all[index + 1];
      const start = Math.max(monthIndex(p.from) * 2, cursor);
      // Use the next start month, not the overlapping end month (e.g. Jul 17–Jan 16).
      const stop = Math.max(start, next ? monthIndex(next.from) * 2 - 1 : monthIndex(p.until) * 2 + 1);
      cursor = stop + 1;
      if (!visible.includes(p)) return;
      for (let track = start; track <= stop;) {
        const year = Math.floor(track / 24);
        const end = Math.min(stop, year * 24 + 23);
        const column = Math.floor((track % 24) / 2);
        rowFor(String(year), year).segments.push({
          period: p,
          column,
          span: Math.floor((end % 24) / 2) - column + 1,
          start: track === start,
          end: end === stop,
          track: track % 24,
          tracks: end - track + 1,
        });
        track = end + 1;
      }
    });
  } else if (mode === 'weeks' && visible.length) {
    // Thirteen consecutive weeks per row; no duplicated or dropped week at quarter/year edges.
    const first = visible[0].from;
    const quarter = Number(first.slice(0, 4)) * 4 + Math.floor((Number(first.slice(5, 7)) - 1) / 3);
    const quarterStart = `${first.slice(0, 4)}-${String(Math.floor((Number(first.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
    const offset = Math.floor(diffDays(quarterStart, first) / 7);
    for (const p of visible) {
      const week = offset + Math.round(diffDays(first, p.from) / 7);
      const q = quarter + Math.floor(week / 13);
      rowFor(String(q), Math.floor(q / 4), (q % 4) + 1).segments.push({ period: p, column: week % 13, span: 1, start: true, end: true });
    }
  } else {
    // 不按月对齐（自定义天数周期，或改过收费后同一个月里切出两期）：仍按年分行、标出年份，一格一期，一年超过 12 期就换行
    const used = new Map<number, number>();
    for (const p of visible) {
      const year = Number(p.from.slice(0, 4));
      const i = used.get(year) ?? 0;
      used.set(year, i + 1);
      rowFor(`${year}-${Math.floor(i / columns)}`, year).segments.push({ period: p, column: i % columns, span: 1, start: true, end: true });
    }
  }
  return { mode, columns, rows };
}

/** Semantic tooltip data: allocation count refers to the whole recorded payment, including hidden future periods. */
export function periodTipData(p: LedgerPeriod) {
  return {
    from: p.from,
    until: p.until,
    due: p.due,
    currency: p.currency,
    status: p.status,
    receipt: p.receipt
      ? {
          date: p.receipt.date,
          amount: p.receipt.amount,
          share: p.share,
          currency: p.receipt.currency,
          count: p.receipt.periods.length,
          opening: !!p.receipt.opening,
        }
      : undefined,
    note: p.waiver?.note ?? p.receipt?.note,
  };
}

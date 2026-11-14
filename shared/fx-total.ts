import type { AppState } from './types.ts';
import { chargeBaseOrNaN, toBaseOrNaN } from './fx.ts';
import { flow, money } from './format.ts';
import { t } from './i18n.ts';

/** Display aggregates retain the known base amount and every unconverted original amount. */
export interface FxTotal {
  value: number;
  incomplete: boolean;
  unconverted: Record<string, number>;
  /** Distinguishes a real known zero (including cancellation) from all-missing FX. */
  known: boolean;
}
export const emptyTotal = (): FxTotal => ({ value: 0, incomplete: false, unconverted: {}, known: false });
export function amountTotal(amount: number, currency: string, converted: number): FxTotal {
  if (amount === 0) return emptyTotal();
  return Number.isFinite(converted)
    ? { value: converted, incomplete: false, unconverted: {}, known: true }
    : { value: 0, incomplete: true, unconverted: Number.isFinite(amount) ? { [currency]: amount } : {}, known: false };
}
export function sumTotals(rows: readonly FxTotal[]): FxTotal {
  const out = emptyTotal();
  for (const r of rows) {
    out.value += r.value;
    out.incomplete ||= r.incomplete;
    out.known ||= r.known;
    for (const [ccy, value] of Object.entries(r.unconverted)) out.unconverted[ccy] = (out.unconverted[ccy] ?? 0) + value;
  }
  return out;
}
export function scaleTotal(total: FxTotal, factor: number): FxTotal {
  return { ...total, value: total.value * factor, unconverted: Object.fromEntries(Object.entries(total.unconverted).map(([c, v]) => [c, v * factor])) };
}
export function convertedTotal(state: AppState, amount: number, currency: string, date?: string, to = state.settings.baseCurrency): FxTotal {
  return amountTotal(amount, currency, toBaseOrNaN(state, amount, currency, date, to));
}
type Cash = {
  valuationParts?: Cash[];
  amount: number;
  currency: string;
  date: string;
  projected: boolean;
  settled?: { amount: number; currency: string };
  kind?: string;
};
export function chargeTotal(state: AppState, c: Cash, to = state.settings.baseCurrency): FxTotal {
  if (c.kind === 'failed') return emptyTotal();
  if (c.valuationParts?.length) return sumTotals(c.valuationParts.map((part) => chargeTotal(state, part, to)));
  const original = c.settled && !c.projected ? c.settled : c;
  return amountTotal(original.amount, original.currency, chargeBaseOrNaN(state, c, to));
}
export const chargesTotal = (state: AppState, rows: readonly Cash[], to = state.settings.baseCurrency) => sumTotals(rows.map((c) => chargeTotal(state, c, to)));

/** Ratios and comparisons are meaningful only when both sides are complete. */
export const totalRatio = (a: FxTotal, b: FxTotal): number => (a.incomplete || b.incomplete ? NaN : a.value / b.value);
export const totalDifference = (a: FxTotal, b: FxTotal): number => (a.incomplete || b.incomplete ? NaN : a.value - b.value);

export interface TotalFormat {
  compact?: boolean;
  /** Only converted totals carry an approximation marker; native fallbacks do not. */
  approx?: boolean;
  /** Cash direction: -1 = expense, +1 = income; omitted = unsigned money. */
  direction?: 1 | -1;
  /** Narrow primary value; the caller owns a single note for the card. */
  main?: boolean;
  /** All-missing multi-currency averages have no common unit. */
  average?: boolean;
  /** Fixed decimals for the converted value only (e.g. a ledger whose amounts are all whole). */
  decimals?: number;
}
export function formatUnconverted(total: FxTotal, opts: TotalFormat = {}): string {
  const fmt = (v: number, ccy: string) =>
    opts.direction ? flow(v * opts.direction, ccy, { compact: opts.compact }) : money(v, ccy, { compact: opts.compact });
  const rows = Object.entries(total.unconverted).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]));
  const text = rows
    .slice(0, 3)
    .map(([c, v]) => fmt(v, c))
    .join(' + ');
  return rows.length > 3 ? `${text} ${t('core.fxOther', { count: rows.length - 3 })}` : text;
}
export function totalNote(total: FxTotal, opts: TotalFormat = {}): string {
  return total.incomplete
    ? Object.keys(total.unconverted).length
      ? t('core.fxUnconverted', { amount: formatUnconverted(total, opts) })
      : t('core.fxIncomplete')
    : '';
}
export function formatTotal(total: FxTotal, currency: string, opts: TotalFormat = {}): string {
  const original = formatUnconverted(total, opts);
  if (total.incomplete && !total.known) return opts.average && Object.keys(total.unconverted).length > 1 ? '—' : original || '—';
  const base = opts.direction
    ? flow(total.value * opts.direction, currency, { compact: opts.compact, decimals: opts.decimals })
    : money(total.value, currency, { compact: opts.compact, decimals: opts.decimals });
  const text = !opts.main && total.incomplete && original ? `${base} + ${original}` : base;
  return opts.approx ? `≈ ${text}` : text;
}

/** One existing note slot can describe distinct measures without adding currencies across unlike periods. */
export function totalsNote(rows: Array<[string, FxTotal | undefined]>): string {
  const seen = new Set<string>();
  const parts = rows.flatMap(([label, total]) => {
    if (!total?.incomplete) return [];
    const key = JSON.stringify(total.unconverted);
    if (seen.has(key)) return [];
    seen.add(key);
    return [`${label}: ${formatUnconverted(total) || '—'}`];
  });
  return parts.length ? t('core.fxUnconverted', { amount: parts.join('\n') }) : '';
}

/** A fee-currency change can make the intermediate owed amount unavailable; retain each unpaid period's native amount. */
export function dueTotal(
  state: AppState,
  due: { owed: number; currency: string; originals?: Record<string, number> },
  converted?: number,
  to = state.settings.baseCurrency,
  date?: string,
): FxTotal {
  return due.originals
    ? sumTotals(Object.entries(due.originals).map(([c, v]) => convertedTotal(state, v, c, date, to)))
    : amountTotal(due.owed, due.currency, converted ?? toBaseOrNaN(state, due.owed, due.currency, date, to));
}

/**
 * 图表平均线的取值：不足两笔没有可比的，每笔都一样时线只会贴着柱顶，都不画。
 * 换算不了的（NaN）不算进去，不能当 0 拉低平均
 */
export function averageLine(values: number[]): number | undefined {
  const known = values.filter(Number.isFinite);
  if (known.length < 2 || Math.max(...known) - Math.min(...known) < 0.005) return undefined;
  return known.reduce((a, v) => a + v, 0) / known.length;
}

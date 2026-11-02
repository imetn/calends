import { LIFETIME_BILL_MONTHS } from './types.ts';
import { intlLocale, t } from './i18n.ts';
import { dateFormat, numberFormat, relativeFormat } from './intl.ts';

const SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: 'JP¥',
  HKD: 'HK$',
  TWD: 'NT$',
  TRY: '₺',
  NGN: '₦',
  PHP: '₱',
  INR: '₹',
  KRW: '₩',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
  THB: '฿',
  VND: '₫',
  RUB: '₽',
  UAH: '₴',
  BRL: 'R$',
  EGP: 'E£',
  PKR: '₨',
  KZT: '₸',
  IDR: 'Rp',
  MYR: 'RM',
};

export const CURRENCIES = [
  'CNY',
  'USD',
  'HKD',
  'TWD',
  'JPY',
  'EUR',
  'GBP',
  'TRY',
  'NGN',
  'PHP',
  'INR',
  'PKR',
  'EGP',
  'KRW',
  'SGD',
  'MYR',
  'THB',
  'VND',
  'IDR',
  'AUD',
  'CAD',
  'BRL',
  'ARS',
  'RUB',
  'UAH',
  'KZT',
  'CHF',
  'CLP',
  'HUF',
  'PYG',
  'MGA',
  'BIF',
];

export function symbol(ccy: string): string {
  return SYMBOL[ccy] ?? ccy + ' ';
}

/** 展示精度；不改变计算、存储或历史原值。 */
export function currencyDecimals(ccy: string): number {
  return ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'HUF', 'TWD', 'PYG', 'MGA', 'BIF'].includes(ccy) ? 0 : 2;
}

type MoneyOptions = { compact?: boolean; sign?: boolean; decimals?: number };

/** 金额文本和分段金额组件共用；显式精度和紧凑显示也不能为零小数货币添加小数。 */
export function moneyDecimals(n: number, ccy: string, opts: MoneyOptions = {}): number {
  const digits = currencyDecimals(ccy);
  return digits === 0 ? 0 : (opts.decimals ?? (opts.compact && (Math.abs(n) >= 1000 || Number.isInteger(n)) ? 0 : digits));
}

/** 图表的缩略金额刻度，精度同样服从币种规则。 */
export function moneyTick(n: number, ccy: string): string {
  return Math.abs(n) >= 1000 ? `${money(n / 1000, ccy, { decimals: Math.abs(n) >= 10000 ? 0 : 1 })}k` : money(n, ccy, { decimals: 0 });
}

/** 带币种符号的金额；compact 去掉多余小数。数字分组跟随当前语言 */
export function money(n: number, ccy: string, opts: MoneyOptions = {}): string {
  if (!Number.isFinite(n)) return '—';
  const decimals = moneyDecimals(n, ccy, opts);
  const s = numberFormat(intlLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(n));
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}${symbol(ccy)}${s}`;
}

let signedAmounts = true;

/** 只控制收支展示，不改变 money() 的标价及对比差额语义。 */
export function setSignedAmounts(on: boolean): void {
  signedAmounts = on;
}

/** 收支符号：负数流出，正数流入，零不带符号。 */
export function flowSign(n: number): string {
  return signedAmounts && Number.isFinite(n) ? (n < 0 ? '−' : n > 0 ? '+' : '') : '';
}

/** 带方向的收支金额；格式选项与 money() 一致。 */
export function flow(n: number, ccy: string, opts: { compact?: boolean; decimals?: number } = {}): string {
  return `${flowSign(n)}${money(Math.abs(n), ccy, opts)}`;
}

/** 日期字符串（YYYY-MM-DD）按当前语言格式化；按 UTC 解析，避免时区把日期挪一天 */
function fmtDate(d: string, o: Intl.DateTimeFormatOptions): string {
  const [y, m, day] = d.split('-').map(Number);
  return dateFormat(intlLocale(), { ...o, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, day)));
}

/** 「10月20日」「Oct 20」；withWeek 附带星期 */
export function cnDate(d: string, withWeek = false): string {
  const s = fmtDate(d, { month: 'short', day: 'numeric' });
  return withWeek ? `${s} ${fmtDate(d, { weekday: 'short' })}` : s;
}

/** 星期几的简写：「周一」「Mon」 */
export function weekdayOf(d: string): string {
  return fmtDate(d, { weekday: 'short' });
}

/** 今年的日期省略年份，往年的带上年份，避免「1月17日」到底是哪一年的歧义 */
export function cnDateAuto(d: string, today: string): string {
  return d.slice(0, 4) === today.slice(0, 4) ? cnDate(d) : cnDateFull(d);
}

/** 「2026年10月20日」「Oct 20, 2026」 */
export function cnDateFull(d: string): string {
  return fmtDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** 「2026年10月」「Oct 2026」；month 为 YYYY-MM */
export function monthLabel(month: string, opts: { year?: boolean; long?: boolean } = {}): string {
  return fmtDate(`${month}-01`, { month: opts.long ? 'long' : 'short', ...(opts.year === false ? {} : { year: 'numeric' }) });
}

/**
 * 月度横轴的刻度下标：只落在整月 / 双月 / 季度 / 半年 / 年 / 两年的边界上，取不超过 max 个的最密一档。
 * 档位在一年内都落在一月上，标签在一月处写年份即可给出年份线索；一档也放不下时只标第一个月。
 */
export function monthTicks(months: string[], max: number): number[] {
  const at = (step: number) => months.flatMap((m, i) => ((Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1) % step === 0 ? [i] : []));
  for (const step of [1, 2, 3, 6, 12, 24, 60]) {
    const ticks = at(step);
    if (ticks.length && ticks.length <= max) return ticks;
  }
  return months.length ? [0] : [];
}

/** 星期几的简称，0 = 周日 */
export function weekdayShort(i: number, narrow = false): string {
  // 2023-01-01 是周日
  return fmtDate(`2023-01-0${i + 1}`, { weekday: narrow ? 'narrow' : 'short' });
}

/** 今天、明天、3 天后、2 个月后 */
export function relDays(n: number): string {
  const rtf = relativeFormat(intlLocale(), { numeric: 'auto' });
  // 两个月内按天，两年内按月，再远按年：两年付的下次扣款说「2 年后」，不说「24 个月后」
  if (Math.abs(n) < 60) return rtf.format(n, 'day');
  if (Math.abs(n) < 700) return rtf.format(Math.round(n / 30), 'month');
  return rtf.format(Math.round(n / 365.25), 'year');
}

/** 下次扣款等未来日期的统一写法：两周内说「今天 / 明天 / 3天后」，再远写日期（不是今年的带年份）。侧栏、总览、列表共用这一个口径 */
export const NEAR_DAYS = 14;
export function nearDate(date: string, today: string): string {
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return n <= NEAR_DAYS ? relDays(n) : cnDateAuto(date, today);
}

/** 合租收费周期的文字：按月、按季……不在常用选项里的写成「按 N 个月」 */
export function billLabel(months?: number): string {
  const m = months ?? 1;
  // 买断的合租只收一次（收费周期按 LIFETIME_BILL_MONTHS 记）
  if (m >= LIFETIME_BILL_MONTHS) return t('core.bill.once');
  return [1, 3, 6, 12].includes(m) ? t(`core.bill.m${m}`) : t('core.bill.custom', { count: m });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 把服务端的 UTC 时间（ISO 或 SQLite 的「YYYY-MM-DD HH:MM:SS」）按设置的时区显示成「2026-10-20 19:03」；dateOnly 只要日期 */
export function localTime(raw: string, timeZone: string, dateOnly = false): string {
  const iso = /[TZ]/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  const s = d.toLocaleString('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return dateOnly ? s.slice(0, 10) : s.slice(0, 16);
}

/**
 * 详情页金额的小数位：某币种的金额全是整数时（如整价扣款）该币种一律不写 .00，省出宽度；
 * 扣款记录、提示框、柱顶数值用同一套，同一笔不会一处 ¥590、一处 ¥590.00
 */
export function wholeCurrencies(list: Array<{ amount: number; currency: string }>): Set<string> {
  const known = list.filter((r) => Number.isFinite(r.amount));
  return new Set([...new Set(known.map((r) => r.currency))].filter((ccy) => known.every((r) => r.currency !== ccy || Number.isInteger(Math.round(r.amount * 100) / 100))));
}
export const wholeOpts = (v: number, ccy: string, whole?: Set<string>) => (whole?.has(ccy) && Number.isInteger(Math.round(v * 100) / 100) ? { decimals: 0 } : {});

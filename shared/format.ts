import { DAYS_PER_MONTH } from './billing.ts';
import { LIFETIME_BILL_MONTHS } from './types.ts';
import { intlLocale, t } from './i18n.ts';
import { dateFormat, numberFormat, relativeFormat } from './intl.ts';
import type { DateOrder } from './date-input.ts';

/** 按当前语言缓存一份货币名称表 */
let namesLoc = '';
let namesObj: Intl.DisplayNames | undefined;
function names(): Intl.DisplayNames | undefined {
  const loc = intlLocale();
  if (loc !== namesLoc) {
    namesLoc = loc;
    try {
      namesObj = new Intl.DisplayNames([loc], { type: 'currency' });
    } catch {
      namesObj = undefined;
    }
  }
  return namesObj;
}

/** Chrome 精简版 ICU 里没有的新货币，名称放进 core 文案，Worker 也能取到 */
const NAME_FIX = new Set(['SLE', 'XCG', 'ZWG']);

/** 货币名称（按当前语言），取不到时用代码 */
export function ccyName(code: string): string {
  if (NAME_FIX.has(code)) return t(`core.currency.${code}`);
  try {
    return names()?.of(code) ?? code;
  } catch {
    return code;
  }
}

const SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: 'JP¥',
  HKD: 'HK$',
  MOP: 'MOP$',
  MXN: 'MX$',
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
  'MOP',
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

const ZERO_DECIMALS = ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'HUF', 'TWD', 'PYG', 'MGA', 'BIF'];
/** 账务计算与金额输入沿用既有精度；展示规则不能改变历史分摊、退款或实扣。 */
export function currencyDecimals(ccy: string): number {
  return ZERO_DECIMALS.includes(ccy) ? 0 : 2;
}

const intlDecimals = new Map<string, number>();

/** 展示精度；不改变计算、存储或历史原值。只分 0 位和 2 位：常用货币按固定列表，其余 Intl 记为无小数的（如 ISK、UGX）取 0 */
export function displayCurrencyDecimals(ccy: string): number {
  if (ZERO_DECIMALS.includes(ccy)) return 0;
  if (CURRENCIES.includes(ccy)) return 2;
  let d = intlDecimals.get(ccy);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency: ccy }).resolvedOptions().maximumFractionDigits === 0 ? 0 : 2;
    } catch {
      d = 2;
    }
    intlDecimals.set(ccy, d);
  }
  return d;
}

type MoneyOptions = { compact?: boolean; sign?: boolean; decimals?: number };

/** 金额文本和分段金额组件共用；显式精度和紧凑显示也不能为零小数货币添加小数。 */
export function moneyDecimals(n: number, ccy: string, opts: MoneyOptions = {}): number {
  const digits = displayCurrencyDecimals(ccy);
  return digits === 0 ? 0 : (opts.decimals ?? (opts.compact && (Math.abs(n) >= 1000 || Number.isInteger(n)) ? 0 : digits));
}

/** 图表的缩略金额刻度。k、M 档的小数是缩写的精度，零小数货币也保留，否则 ¥2,500 和 ¥3,000 都写成 ¥3k。 */
export function moneyTick(n: number, ccy: string): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(n) || abs < 1000) return money(n, ccy, { decimals: 0 });
  // 四舍五入后到 1000 就升一档：999,600 写 1M，不写 1,000k
  const tier = abs >= 999.5e6 ? 1e9 : abs >= 999.5e3 ? 1e6 : 1e3;
  const v = abs / tier;
  const s = numberFormat(intlLocale(), { maximumFractionDigits: v >= 10 ? 0 : 1 }).format(v);
  return `${n < 0 ? '−' : ''}${symbol(ccy)}${s}${tier === 1e9 ? 'B' : tier === 1e6 ? 'M' : 'k'}`;
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

/** 数字日期，顺序与分隔符跟随语言：短的「11/15」「15/11」「15.11.」，带年份的「11/15/2026」「15/11/2026」「2026/11/15」 */
export function numericDate(d: string, opts: { year?: boolean } = {}): string {
  return fmtDate(d, opts.year ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { month: 'numeric', day: 'numeric' });
}

/** 当前语言数字日期的字段顺序与写法：en-AU「dmy」「DD/MM/YYYY」，zh-CN「ymd」「YYYY/MM/DD」；手动输入日期时预填与解析都按它 */
function numericParts(): Intl.DateTimeFormatPart[] {
  return dateFormat(intlLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2026, 10, 19)));
}
export function dateOrder(): DateOrder {
  const order = numericParts()
    .map((p) => p.type[0])
    .filter((c) => c === 'y' || c === 'm' || c === 'd')
    .join('');
  return order === 'dmy' || order === 'mdy' ? order : 'ymd';
}
const PATTERN: Partial<Record<string, string>> = { year: 'YYYY', month: 'MM', day: 'DD' };
export function datePattern(): string {
  return numericParts()
    .map((p) => PATTERN[p.type] ?? p.value)
    .join('')
    .trim();
}

/** 「2026年10月」「Oct 2026」；month 为 YYYY-MM。numeric 写成两位年份的数字月份：「10/26」「26/10」 */
export function monthLabel(month: string, opts: { year?: boolean; long?: boolean; numeric?: boolean } = {}): string {
  if (opts.numeric) return fmtDate(`${month}-01`, { year: '2-digit', month: 'numeric' });
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

// 纯日期（YYYY-MM-DD）没有时刻，不能当 UTC 零点换时区，否则西半球会早一天
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const utcInstant = (raw: string): Date => new Date(/[TZ]/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');

/** 服务端的 UTC 时间（ISO 或 SQLite 的「YYYY-MM-DD HH:MM:SS」）在设置时区里是哪一天，YYYY-MM-DD，供比较用，不用于显示 */
export function localDay(raw: string, timeZone: string): string {
  if (DATE_ONLY.test(raw)) return raw;
  const d = utcInstant(raw);
  return Number.isNaN(d.getTime()) ? raw.slice(0, 10) : dateFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * 服务端的 UTC 时间按设置的时区、当前语言显示：「2026年10月20日 19:03」「Oct 20, 2026, 7:03 PM」「20 Oct 2026, 7:03 pm」。
 * part 只要日期或时间；today（YYYY-MM-DD）与之同年时省略年份。
 */
export function localTime(raw: string, timeZone: string, opts: { part?: 'date' | 'time'; today?: string } = {}): string {
  if (DATE_ONLY.test(raw)) return opts.part === 'time' ? '' : opts.today ? cnDateAuto(raw, opts.today) : cnDateFull(raw);
  const d = utcInstant(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (opts.part === 'time') return dateFormat(intlLocale(), { timeZone, ...time }).format(d);
  const year = opts.today && localDay(raw, timeZone).slice(0, 4) === opts.today.slice(0, 4) ? {} : { year: 'numeric' as const };
  return dateFormat(intlLocale(), { timeZone, ...year, month: 'short', day: 'numeric', ...(opts.part === 'date' ? {} : time) }).format(d);
}

/**
 * 详情页金额的小数位：某币种的金额全是整数时（如整价扣款）该币种一律不写 .00，省出宽度；
 * 扣款记录、提示框、柱顶数值用同一套，同一笔不会一处 ¥590、一处 ¥590.00
 */
export function wholeCurrencies(list: Array<{ amount: number; currency: string }>): Set<string> {
  const known = list.filter((r) => Number.isFinite(r.amount));
  return new Set(
    [...new Set(known.map((r) => r.currency))].filter((ccy) => known.every((r) => r.currency !== ccy || Number.isInteger(Math.round(r.amount * 100) / 100))),
  );
}
export const wholeOpts = (v: number, ccy: string, whole?: Set<string>) =>
  whole?.has(ccy) && Number.isInteger(Math.round(v * 100) / 100) ? { decimals: 0 } : {};

/** 时长：满一年写几年几个月，不足一个月写天数；与详情页同一写法 */
export function servedSpan(days: number): string {
  const n = days < 30 ? 0 : Math.round(days / DAYS_PER_MONTH);
  const years = Math.floor(n / 12);
  const months = n % 12;
  if (years) return months ? t('detail.stats.yearsMonths', { years, months }) : t('detail.stats.years', { count: years });
  return months ? t('detail.stats.months', { count: months }) : t('detail.stats.days', { count: Math.round(days) });
}

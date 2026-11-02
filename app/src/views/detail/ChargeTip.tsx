import type { ReactNode } from 'react';
import { addDays, addMonths, chargeMethodId, chargeServicePeriod, isPostpaid, type Charge } from '../../../../shared/billing.ts';
import { cnDateAuto, cnDateFull, flow, money, monthLabel, weekdayOf, wholeOpts } from '../../../../shared/format.ts';
import { intlLocale, t } from '../../../../shared/i18n.ts';
import { numberFormat } from '../../../../shared/intl.ts';
import { usageWithin, type MeterRow } from '../../../../shared/meters.ts';
import type { AppState, Meter } from '../../../../shared/types.ts';
import { PayBadge } from '../../components/marks.tsx';
import { methodOf } from './shared.tsx';

export const qty = (n: number) => numberFormat(intlLocale(), { maximumFractionDigits: 3 }).format(n);
/** 固定小数位的数量：同一指标按 meterDecimals() 的位数写，一列里不出现 24 与 12.67 混排 */
export const fixedQty = (d: number) => (n: number) => numberFormat(intlLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
export const withUnit = (n: number, unit: string, f = qty) => (unit ? `${f(n)} ${unit}` : f(n));

/** 单价常是零点几（每度电、每 GB），多留一位小数 */
export const unitMoney = (p: number, currency: string, unit: string) => {
  const s = money(p, currency, Math.abs(p) < 1 ? { decimals: 3 } : {});
  return unit ? `${s}/${unit}` : s;
};

/** 起止日：今年内省略年份；跨年或不在今年时两头都写年份，不出现「4月10日 – 4月9日」 */
export function rangeLabel(from: string, last: string, today: string) {
  const f = from.slice(0, 4) === last.slice(0, 4) ? (d: string) => cnDateAuto(d, today) : cnDateFull;
  return `${f(from)} – ${f(last)}`;
}

/** 计费周期的写法：正好是一个自然月时写「2026年8月」，否则写起止日 */
export function periodLabel(p: { from: string; until: string }, today: string) {
  return p.from.endsWith('-01') && p.until === addMonths(p.from, 1) ? monthLabel(p.from.slice(0, 7)) : rangeLabel(p.from, addDays(p.until, -1), today);
}

/** 这一笔结算的那段时间里记下的用量；退款等非周期扣款没有 */
export function chargeUsage(readings: MeterRow[] | undefined, c: Charge) {
  if (!readings || c.kind) return undefined;
  const p = chargeServicePeriod(c.sub, c.date, c.serviceDate);
  return usageWithin(readings, p.from, p.until);
}

/**
 * 单笔扣款的提示框，费用走势与用量走势共用：标题行扣款日，下面左字段右内容——
 * 计费周期、金额（原币）、与图表货币不同时的折合、首期优惠原价、用量与平均单价、支付方式。
 * 后付费的周期账单按所属周期归：标题写周期，扣款日另起一行。
 */
export function ChargeTip({
  c,
  state,
  today,
  whole,
  future,
  converted,
  full,
  usage,
  meter,
  decimals,
  note,
}: {
  c: Charge;
  state: AppState;
  today: string;
  /** 金额全是整数的币种（wholeCurrencies），与扣款记录同一写法 */
  whole?: Set<string>;
  future?: boolean;
  /** 原币与图表货币不同时的折合金额（已格式化） */
  converted?: ReactNode;
  /** 首期优惠期间的原价（已格式化） */
  full?: ReactNode;
  usage?: number;
  meter?: Meter;
  /** 用量的小数位（meterDecimals），与用量卡、扣款记录一致 */
  decimals?: number;
  note?: string;
}) {
  // 终身买断没有计费周期
  const p = c.kind || c.sub.cycle.unit === 'lifetime' ? undefined : chargeServicePeriod(c.sub, c.date, c.serviceDate);
  const post = p && isPostpaid(c.sub);
  const row = (label: string, value: ReactNode) => (
    <div className="cc-tip-r">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
  return (
    <>
      {post ? (
        <div className="cc-tip-h">
          <b>{periodLabel(p, today)}</b>
        </div>
      ) : (
        <div className="cc-tip-h">
          <b>{cnDateFull(c.date)}</b>
          <span>{weekdayOf(c.date)}</span>
        </div>
      )}
      {p && !post && row(t('detail.chart.period'), rangeLabel(p.from, addDays(p.until, -1), today))}
      {post && row(t('detail.chart.paidOn'), cnDateFull(c.date))}
      {row(future ? t('detail.timeline.planned') : t('detail.field.amount'), flow(-c.amount, c.currency, wholeOpts(c.amount, c.currency, whole)))}
      {converted != null && row(t('detail.chart.converted'), converted)}
      {full != null && row(t('detail.chart.regular'), full)}
      {usage != null && meter && row(t('detail.meters.head.usage'), withUnit(usage, meter.unit, decimals != null ? fixedQty(decimals) : qty))}
      {usage != null && meter && usage > 0 && c.amount > 0 && row(t('detail.chart.average'), unitMoney(c.amount / usage, c.currency, meter.unit))}
      {row(t('detail.chart.method'), <PayBadge m={methodOf(state, chargeMethodId(c))} />)}
      {note && <div className="cc-tip-f">{note}</div>}
    </>
  );
}

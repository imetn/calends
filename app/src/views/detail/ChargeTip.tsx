import type { ReactNode } from 'react';
import { addDays, chargeMethodId, chargeServicePeriod, type Charge } from '../../../../shared/billing.ts';
import { cnDate, cnDateFull, flow, money, weekdayOf } from '../../../../shared/format.ts';
import { intlLocale, t } from '../../../../shared/i18n.ts';
import { numberFormat } from '../../../../shared/intl.ts';
import { usageWithin, type MeterRow } from '../../../../shared/meters.ts';
import type { AppState, Meter } from '../../../../shared/types.ts';
import { PayBadge } from '../../components/marks.tsx';
import { methodOf } from './shared.tsx';

export const qty = (n: number) => numberFormat(intlLocale(), { maximumFractionDigits: 3 }).format(n);
export const withUnit = (n: number, unit: string, f = qty) => (unit ? `${f(n)} ${unit}` : f(n));
/** 单价常是零点几（每度电、每 GB），多留一位小数 */
export const unitMoney = (p: number, currency: string, unit: string) => {
  const s = money(p, currency, Math.abs(p) < 1 ? { decimals: 3 } : {});
  return unit ? `${s}/${unit}` : s;
};

/** 这一笔结算的那段时间里记下的用量；退款等非周期扣款没有 */
export function chargeUsage(readings: MeterRow[] | undefined, c: Charge) {
  if (!readings || c.kind) return undefined;
  const p = chargeServicePeriod(c.sub, c.date, c.serviceDate);
  return usageWithin(readings, p.from, p.until);
}

/**
 * 单笔扣款的提示框，费用走势与用量走势共用：标题行扣款日，下面左字段右内容——
 * 计费周期、金额（原币）、与图表货币不同时的折合、首期优惠原价、用量与平均单价、支付方式。
 */
export function ChargeTip({
  c,
  state,
  future,
  converted,
  full,
  usage,
  meter,
  note,
}: {
  c: Charge;
  state: AppState;
  future?: boolean;
  /** 原币与图表货币不同时的折合金额（已格式化） */
  converted?: ReactNode;
  /** 首期优惠期间的原价（已格式化） */
  full?: ReactNode;
  usage?: number;
  meter?: Meter;
  note?: string;
}) {
  // 终身买断没有计费周期
  const p = c.kind || c.sub.cycle.unit === 'lifetime' ? undefined : chargeServicePeriod(c.sub, c.date, c.serviceDate);
  const row = (label: string, value: ReactNode) => (
    <div className="cc-tip-r">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
  return (
    <>
      <div className="cc-tip-h">
        <b>{cnDateFull(c.date)}</b>
        <span>{weekdayOf(c.date)}</span>
      </div>
      {p && row(t('detail.chart.period'), `${cnDate(p.from)} – ${cnDate(addDays(p.until, -1))}`)}
      {row(future ? t('detail.timeline.planned') : t('detail.field.amount'), flow(-c.amount, c.currency))}
      {converted != null && row(t('detail.chart.converted'), converted)}
      {full != null && row(t('detail.chart.regular'), full)}
      {usage != null && meter && row(t('detail.meters.head.usage'), withUnit(usage, meter.unit))}
      {usage != null && meter && usage > 0 && c.amount > 0 && row(t('detail.chart.average'), unitMoney(c.amount / usage, c.currency, meter.unit))}
      {row(t('detail.field.method'), <PayBadge m={methodOf(state, chargeMethodId(c))} />)}
      {note && <div className="cc-tip-f">{note}</div>}
    </>
  );
}

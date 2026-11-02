// 公开页指标卡的数据：页面把账本算好的数传进来（已是显示币种），这里只决定每个指标显示什么
import type { PublicMetricId } from './public-layout.ts';

export interface MetricInputs {
  mrr: number;
  yearAgoMrr: number;
  mrrSeries: { label: string; v: number }[];
  active: number;
  paidTotal: number;
  paidYear: number;
  paidYearPrev: number;
  paidMonth: number;
  paidMonthPrev: number;
  paidSeries: { label: string; v: number }[];
  next30: number;
  topSub?: { name: string; v: number };
  topCategory?: { name: string; v: number };
  ended: number;
  lifetime: number;
  fxEffect: number;
}

export interface MetricValue {
  kind: 'money' | 'count';
  value: number;
  /** 有名字的指标：最贵的订阅、最大的分类 */
  name?: string;
  series?: { label: string; v: number }[];
  prev?: number;
  /** 占比的分母 */
  total?: number;
  /** 有正负之分的差额：写出 + − 号 */
  signed?: boolean;
}

/** 算不出来的（缺汇率）保持 NaN，由界面显示占位，不当成 0 */
export function metricValues(m: MetricInputs): Record<PublicMetricId, MetricValue> {
  const money = (value: number, more: Partial<MetricValue> = {}): MetricValue => ({ kind: 'money', value, ...more });
  const count = (value: number): MetricValue => ({ kind: 'count', value });
  return {
    monthly: money(m.mrr, { series: m.mrrSeries, prev: m.yearAgoMrr }),
    yearly: money(m.mrr * 12, { prev: m.yearAgoMrr * 12 }),
    active: count(m.active),
    avgPerSub: money(m.active ? m.mrr / m.active : NaN),
    paidTotal: money(m.paidTotal),
    paidYear: money(m.paidYear, { prev: m.paidYearPrev }),
    paidMonth: money(m.paidMonth, { series: m.paidSeries, prev: m.paidMonthPrev }),
    next30: money(m.next30),
    topSub: money(m.topSub?.v ?? 0, { name: m.topSub?.name, total: m.mrr }),
    topCategory: money(m.topCategory?.v ?? 0, { name: m.topCategory?.name, total: m.mrr }),
    endedCount: count(m.ended),
    lifetimeCount: count(m.lifetime),
    fxEffect: money(m.fxEffect, { signed: true }),
  };
}

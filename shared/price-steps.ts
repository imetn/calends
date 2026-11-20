import { cycleDays, DAYS_PER_MONTH, phaseLanes } from './billing.ts';
import { convertOn } from './fx.ts';
import { pricePoints } from './phases.ts';
import type { FxHistory, FxTable } from './types.ts';
import type { Subscription } from './types.ts';

/** 标价走势的一级台阶：从 from 到 to 都是这个价 */
export interface PriceStep {
  from: string;
  to: string;
  amount: number;
  /** 这一级的标价本身（方案原币、每期），方案轨道写它 */
  price: number;
  /** 所属方案的开始日（方案轨道与提示框用） */
  phase: string;
  /** 这一级怎么来的：开始订阅、切换方案，或同一方案内调价 */
  kind: 'start' | 'switch' | 'price';
}

export interface PriceSeries {
  steps: PriceStep[];
  currency: string;
  /** 各段周期不同（如月付换年付）时按每月折算，否则就是每期标价 */
  perMonth: boolean;
}

/**
 * 历程的标价走势：每段方案的价格历史连成台阶，只画到今天（或那段结束）。
 * 全程一种货币时用原币；换过货币时折成本位币，每一级按它开始那天的汇率，不随之后的汇率波动。
 * 价格从没变过、有并行方案、买断，或有一级换算不了（缺汇率不能当 0）时返回 undefined，不提供走势。
 */
export function priceSeries(
  phases: Subscription[],
  ends: Array<string | undefined>,
  today: string,
  base: string,
  fxHistory: FxHistory | undefined,
  fx: FxTable,
): PriceSeries | undefined {
  const vs = phases.filter((v) => v.start <= today);
  if (!vs.length || vs.some((v) => v.cycle.unit === 'lifetime')) return undefined;
  if (phaseLanes(vs).some((l) => l > 0)) return undefined;
  const ccys = new Set(vs.map((v) => v.currency));
  const currency = ccys.size === 1 ? vs[0].currency : base;
  const cycleKey = (v: Subscription) => `${v.cycle.every} ${v.cycle.unit}`;
  const perMonth = new Set(vs.map(cycleKey)).size > 1;
  const steps: PriceStep[] = [];
  vs.forEach((v, i) => {
    const next = vs[i + 1]?.start;
    const until = [ends[phases.indexOf(v)] ?? today, today, ...(next ? [next] : [])].sort()[0];
    // 开始日往后挪过的方案，价格历史里可能还留着开始日之前的点：第一级取开始日当天生效的价，之前的点不画
    const all = pricePoints(v);
    const first = all.findLast((p) => p.from <= v.start) ?? all[0];
    const pts = [{ from: v.start, amount: first.amount }, ...all.filter((p) => p.from > v.start && p.from <= until)];
    pts.forEach((p, k) => {
      const raw = currency === v.currency ? p.amount : convertOn(p.amount, v.currency, currency, p.from, fxHistory, fx);
      const amount = perMonth ? raw / (cycleDays(v.cycle) / DAYS_PER_MONTH) : raw;
      steps.push({
        from: p.from,
        to: pts[k + 1]?.from ?? until,
        amount,
        price: p.amount,
        phase: v.start,
        kind: k ? 'price' : i ? 'switch' : 'start',
      });
    });
  });
  if (steps.some((s) => !Number.isFinite(s.amount))) return undefined;
  // 金额按分比较：折算后的小数误差不算变价
  if (new Set(steps.map((s) => Math.round(s.amount * 100))).size < 2) return undefined;
  return { steps, currency, perMonth };
}

// 公开页「变动记录」「月度变化」的数据。金额都按显示币种：当前月额用当前汇率，买断和往月按当时汇率；缺汇率为 NaN，不当成 0
import { addMonths } from './billing.ts';
import { money } from './format.ts';
import { toBaseOrNaN } from './fx.ts';
import { events, monthEnd, monthMovement, type LedgerEvent } from './metrics.ts';
import type { AppState, Subscription } from './types.ts';

const inCcy = (state: AppState, ccy: string): AppState => (ccy === state.settings.baseCurrency ? state : { ...state, settings: { ...state.settings, baseCurrency: ccy } });

/** 带 + − 号的差额，不受「收支正负号」设置影响；不足 10 的保留分 */
export const signedMoney = (v: number, ccy: string) => money(v, ccy, { sign: true, decimals: Math.abs(v) < 10 ? 2 : 0 });

export type PublicChangeKind = 'added' | 'resumed' | 'buy' | 'up' | 'down' | 'switch' | 'stopped' | 'paused';

/** 白名单：events 的 note 可能带停用原因、地区和原价，公开页一律不要 */
export interface PublicChange {
  date: string;
  kind: PublicChangeKind;
  /** 对每月花费的影响；买断是一次性金额；缺汇率为 NaN */
  delta: number;
  sub: Pick<Subscription, 'id' | 'name' | 'icon' | 'url' | 'category'>;
}

/** 缺汇率时 delta 是 NaN，涨跌方向看原币差额 */
function direction(e: LedgerEvent): PublicChangeKind {
  const v = Number.isFinite(e.delta) ? e.delta : (e.partial?.unconverted[e.sub.currency] ?? 0);
  return v < 0 ? 'down' : 'up';
}

const KIND = { start: 'added', resume: 'resumed', buy: 'buy', switch: 'switch', end: 'stopped', terminate: 'stopped', pause: 'paused' } as const;

/** 时间倒序的变动：新增、涨价降价、换区换套餐、停用 */
export function publicChanges(state: AppState, today: string, ccy: string): PublicChange[] {
  const scoped = inCcy(state, ccy);
  return events(scoped, today).map((e) => {
    const { id, name, icon, url, category } = e.sub;
    return {
      date: e.date,
      kind: e.kind === 'price' || e.kind === 'intro-end' ? direction(e) : KIND[e.kind],
      // 买断是已经付出去的钱：按买入当天汇率
      delta: e.kind === 'buy' ? toBaseOrNaN(scoped, e.sub.price, e.sub.currency, e.date) : e.delta,
      sub: { id, name, icon, url, category },
    };
  });
}

export type WaterfallStepId = 'from' | 'added' | 'expansion' | 'contraction' | 'churned' | 'fx' | 'to';

export interface WaterfallStep {
  id: WaterfallStepId;
  /** 期初、期末是总额，其余是带方向的差额 */
  value: number;
  low: number;
  high: number;
}

export interface WaterfallMonth {
  month: string;
  steps: WaterfallStep[];
  /** 期初、期末、汇率影响都算得出来才画图 */
  complete: boolean;
  /** 纵轴起点：变化相对总额太小时不从 0 画，否则变化量只剩细线 */
  floor: number;
}

/** 最早能翻到的月份；没有周期订阅时为 undefined */
export function waterfallFirstMonth(state: AppState, today: string): string | undefined {
  const starts = state.subscriptions.filter((s) => !s.proxy && s.cycle.unit !== 'lifetime').flatMap((s) => [s.start, ...(s.phases ?? []).map((p) => p.start)]);
  const first = starts.filter((d) => d <= today).sort()[0];
  return first?.slice(0, 7);
}

function axisFloor(levels: number[]): number {
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const span = hi - lo;
  if (span < 1 || lo < hi / 2) return 0;
  const unit = 10 ** Math.floor(Math.log10(span));
  return Math.max(0, Math.floor((lo - span / 2) / unit) * unit);
}

/** 上月末 → 新增 → 涨价 → 降价 → 取消 → 汇率 → 期末；为 0 的项不出现，各项相加等于期末。往月按月末汇率 */
export function waterfallMonth(state: AppState, month: string, today: string, ccy: string): WaterfallMonth {
  const current = month === today.slice(0, 7);
  const mv = monthMovement(inCcy(state, ccy), current ? today : monthEnd(month), !current);
  const complete = [mv.from, mv.to, mv.fx].every(Number.isFinite);
  const deltas: Array<[WaterfallStepId, number]> = [
    ['added', mv.added],
    ['expansion', mv.expansion],
    ['contraction', -mv.contraction],
    ['churned', -mv.churned],
    ['fx', mv.fx],
  ];
  const steps: WaterfallStep[] = [{ id: 'from', value: mv.from, low: 0, high: mv.from }];
  let level = mv.from;
  for (const [id, value] of deltas) {
    if (Number.isFinite(value) && Math.abs(value) < 0.005) continue;
    const next = level + value;
    steps.push({ id, value, low: Math.min(level, next), high: Math.max(level, next) });
    level = next;
  }
  steps.push({ id: 'to', value: mv.to, low: 0, high: mv.to });
  return { month, steps, complete, floor: complete ? axisFloor(steps.flatMap((s) => (s.id === 'from' || s.id === 'to' ? [s.value] : [s.low, s.high]))) : 0 };
}

export const stepMonth = (month: string, by: number) => addMonths(`${month}-01`, by).slice(0, 7);

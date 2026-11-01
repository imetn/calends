import {
  addDays,
  addMonths,
  chargeServicePeriod,
  chargesBetween,
  currentPhase,
  cycleDays,
  effectiveStatus,
  phaseSubs,
  isPostpaid,
  isStopped,
} from '../../../shared/billing.ts';
import type { Subscription } from '../../../shared/types.ts';

/** Display boundary only: an undated stop never becomes a persisted service end. */
export function detailHistoryEnd(sub: Subscription, today: string): { date: string | undefined; unknown: boolean } {
  const status = effectiveStatus(sub, today);
  if (!['ended', 'terminated', 'paused'].includes(status)) return { date: undefined, unknown: false };
  const known = sub.stop?.date ?? (status === 'paused' && sub.pausedAt ? addDays(sub.pausedAt, -1) : sub.end);
  if (known && known <= today) return { date: known, unknown: false };
  if (sub.phases?.length) {
    const ends = phaseSubs(sub)
      .filter((p) => p.start <= today)
      .map((p) => detailHistoryEnd(p, today));
    return {
      date: ends
        .map((e) => e.date)
        .filter((d): d is string => !!d)
        .sort()
        .at(-1),
      unknown: ends.some((e) => e.unknown),
    };
  }
  const last =
    (sub.payments ?? [])
      .filter((p) => !p.kind && p.date <= today)
      .map((p) => p.date)
      .sort()
      .at(-1) ?? sub.start;
  // 后付费的账单日即已用到的那天，没有预付期
  const coverage = sub.cycle.unit === 'lifetime' || isPostpaid(sub) ? last : addDays(chargeServicePeriod(sub, last).until, -1);
  // An already-disposed service can have prepaid time left. Do not draw that as future ownership.
  return { date: coverage < today ? coverage : last, unknown: true };
}

/** 短周期保留一年节奏；稀疏扣款只展示下一笔，查询范围覆盖多年周期。 */
/**
 * 详情里头部、指标、进度条各取一次预测：按订阅对象与日期记住结果，同一次渲染不重复推算。
 * 订阅改动后是新对象（store 不原地修改），缓存自然失效。
 */
const forecastCache = new WeakMap<Subscription, Map<string, ReturnType<typeof computeForecast>>>();
export function detailForecast(sub: Subscription, today: string) {
  let byDay = forecastCache.get(sub);
  if (!byDay) forecastCache.set(sub, (byDay = new Map()));
  let hit = byDay.get(today);
  if (!hit) byDay.set(today, (hit = computeForecast(sub, today)));
  return hit;
}

function computeForecast(sub: Subscription, today: string) {
  if (sub.cycle.unit === 'lifetime') return { sparse: true, charges: [] };
  const from = addDays(today, 1);
  const cur = currentPhase(sub, today);
  // 后付费停止后还有最后一张账单要出
  const ended = isStopped(effectiveStatus(sub, today)) && !isPostpaid(cur);
  const charges = ended ? [] : chargesBetween(sub, from, addMonths(today, 12), today).filter((c) => !c.kind);
  const sparse = cycleDays(cur.cycle) >= 365 || charges.length <= 2;
  if (!sparse) return { sparse, charges };
  const span = Math.max(
    366,
    ...phaseSubs(sub)
      .filter((p) => p.cycle.unit !== 'lifetime')
      .map((p) => Math.ceil(cycleDays(p.cycle)) + 31),
  );
  const next = ended ? undefined : (charges[0] ?? chargesBetween(sub, from, addDays(today, span), today).find((c) => !c.kind));
  return { sparse, charges: next ? [next] : [] };
}

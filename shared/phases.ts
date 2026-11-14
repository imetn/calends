// 订阅历程的编辑操作：调价、换区/换套餐、断更、续订。全部为纯函数，返回新的订阅对象。
import {
  undatedStop,
  addDays,
  billingPeriod,
  chargesBetween,
  collectionAnchor,
  currentPhase,
  chargeBefore,
  chargeOfService,
  cycleDays,
  diffDays,
  effectiveStatus,
  isPostpaid,
  isSeparate,
  isStopped,
  nextCharge,
  nthCharge,
  pausedFromOf,
  phaseSubs,
  settleLegacyEarly,
  priceAt,
  stopBillingPeriod,
  subError,
  validDay,
} from './billing.ts';
import type { Cycle, Payment, Phase, PricePoint, Stop, Subscription, RenewalRules } from './types.ts';
import { t } from './i18n.ts';
import { applyFields } from './ledger-edit.ts';
import { currencyDecimals } from './format.ts';

export interface PlanChange extends RenewalRules {
  price: number;
  currency: string;
  cycle: Cycle;
  billing?: 'postpaid';
  methodId?: string;
  region?: string;
  note?: string;
  /** 只是计划，还没确定 */
  planned?: boolean;
}

/** 当前顶层字段 → 一个阶段 */
function fromTop(s: Subscription, start: string): Phase {
  return {
    start,
    billingStart: s.billingStart,
    chargeLeadDays: s.chargeLeadDays,
    cancelLeadDays: s.cancelLeadDays,
    renewalHistory: s.renewalHistory,
    renewalOffsetDays: s.renewalOffsetDays,
    end: s.end,
    stop: s.stop,
    price: s.price,
    currency: s.currency,
    cycle: s.cycle,
    billing: s.billing,
    methodId: s.methodId,
    region: s.region,
    priceHistory: s.priceHistory,
    intro: s.intro,
    bonus: s.bonus,
    payments: s.payments,
    nextDue: s.nextDue,
  };
}

/** 只剩一个阶段时退回普通订阅：阶段的字段写回顶层（fromTop 的逆操作） */
function phaseToTop(s: Subscription, p: Phase): Subscription {
  return {
    ...s,
    phases: undefined,
    start: p.start,
    billingStart: p.billingStart,
    chargeLeadDays: p.chargeLeadDays,
    cancelLeadDays: p.cancelLeadDays,
    renewalHistory: p.renewalHistory,
    renewalOffsetDays: p.renewalOffsetDays,
    end: p.end,
    stop: p.stop,
    price: p.price,
    currency: p.currency,
    cycle: p.cycle,
    billing: p.billing,
    methodId: p.methodId,
    region: p.region,
    priceHistory: p.priceHistory,
    intro: p.intro,
    bonus: p.bonus,
    payments: p.payments,
    nextDue: p.nextDue,
  };
}

/** 顶层只镜像最后一段：算某一段时，这一段没有的项不能从顶层继承，否则历史会按最后一段的优惠、节奏计算 */
function phaseBase(sub: Subscription): Subscription {
  return {
    ...sub,
    phases: undefined,
    // 旧版续费规则只属于单段订阅，多段时不能拿来重算某一段
    expires: sub.phases?.length ? undefined : sub.expires,
    billingStart: undefined,
    chargeLeadDays: undefined,
    cancelLeadDays: undefined,
    renewalHistory: undefined,
    renewalOffsetDays: undefined,
    stop: undefined,
    billing: undefined,
    methodId: undefined,
    region: undefined,
    priceHistory: undefined,
    intro: undefined,
    bonus: undefined,
    payments: undefined,
    nextDue: undefined,
  };
}

function phasesOf(s: Subscription): Phase[] {
  return s.phases?.length ? s.phases.map((p) => ({ ...p })).sort((a, b) => a.start.localeCompare(b.start)) : [fromTop(s, s.start)];
}

/** 让顶层字段镜像最后一个阶段，列表、详情等界面直接读顶层即可 */
function mirror(s: Subscription, phases: Phase[]): Subscription {
  const last = phases[phases.length - 1];
  return {
    ...s,
    phases,
    price: last.price,
    currency: last.currency,
    cycle: last.cycle,
    billing: last.billing,
    methodId: last.methodId,
    region: last.region,
    chargeLeadDays: last.chargeLeadDays,
    cancelLeadDays: last.cancelLeadDays,
    renewalHistory: last.renewalHistory,
    renewalOffsetDays: last.renewalOffsetDays,

    priceHistory: undefined,
    // 首期优惠、赠送时长跟着最后一段走，编辑表单才能看到并修改；计费只读阶段，不会重复生效
    intro: last.intro,
    bonus: last.bonus,
    payments: undefined,
    nextDue: undefined,
    billingStart: undefined,
    end: endOf(phases),
    stop: last.stop,
  };
}

/** 整个订阅的结束日：最后一段一直延续时没有；否则取各段里最晚的结束日（并行的旧段可能比最后一段跑得更久） */
function endOf(phases: Phase[]): string | undefined {
  const last = phases[phases.length - 1];
  if (!last.end) return undefined;
  return phases.reduce((m, p) => (p.end && p.end > m ? p.end : m), last.end);
}

/** 结束日含当天：更早的阶段结束日恰好落在 day（另一段的开始日）会让两段那天各扣一次，往前收一天；已停用的不能动，直接报错 */
function endBefore(phases: Phase[], day: string, skip?: Phase) {
  phases.forEach((p, i) => {
    if (p === skip || p.start >= day || p.end !== day) return;
    if (p.stop) throw new Error(t('core.phase.endOnNextStart'));
    phases[i] = { ...p, end: addDays(day, -1) };
  });
}

/**
 * 从 at 起换区或换套餐：上一阶段默认在 at 前一天结束，新阶段无缝衔接；
 * 给了 keepUntil 时上一阶段继续跑到那天（比如旧区域已预付到月底），两段并行、两边都照常计费
 */
export function switchPlan(s: Subscription, at: string, next: PlanChange, keepUntil?: string): Subscription {
  const phases = phasesOf(s);
  const last = phases[phases.length - 1];
  if (at <= last.start) throw new Error(t('core.phase.switchTooEarly'));
  if (keepUntil && keepUntil <= at) throw new Error(t('core.phase.keepTooEarly'));
  if (last.stop && at <= last.stop.date) throw new Error(t('core.phase.resumeTooEarly'));
  if (undatedStop(s)) throw new Error(t('core.phase.resumeNeedsStopDate'));
  // 已经结束的段保持原结束日，中间的空档就是断更期
  if (!last.stop && !(last.end && last.end < at)) last.end = keepUntil ?? addDays(at, -1);
  endBefore(phases, at, last);
  phases.push({ start: at, ...next });
  return { ...mirror(s, phases), status: 'active', pausedAt: undefined };
}

/** 升级时旧套餐剩余怎么处理：reset 抵扣剩余、从生效日重新起算周期；keep 保持原扣款日，只补剩余天数的差价 */
export type UpgradeMode = 'reset' | 'keep';

export interface UpgradeQuote {
  /** 旧套餐当期实付、本期天数、生效日起没用到的天数 */
  paid: number;
  days: number;
  unusedDays: number;
  /** 没用到的部分按天折算的钱，reset 时从新套餐首期里扣 */
  credit: number;
  /** reset：新套餐首期实付 */
  reset: number;
  /** keep：今天补的差价和原来的下次扣款日；换了周期时没有 */
  keep?: { amount: number; nextCharge: string; anchor: string };
}

const roundIn = (n: number, ccy: string) => {
  const f = 10 ** currencyDecimals(ccy);
  return Math.round(n * f) / f;
};

/**
 * 在 at 升级到 next 时旧套餐的抵扣：只算已经发生的切换（at 不晚于今天），新旧都是先付费、同一币种，旧套餐当期付过钱且还有没用完的天数。
 * 抵扣额 = 当期净付（含当期补差、退款）× 剩余天数 / 本期天数；保持原扣款日时补差 = (新价 − 当期净付) × 剩余天数 / 本期天数，只在周期不变、旧套餐没有续费规则且推得出原扣款日时提供。
 * 已排定停用、生效日后已有续费、当期本身是一次升级、赠送期并进当期时不提供。
 */
export function upgradeQuote(
  s: Subscription,
  at: string,
  next: Pick<PlanChange, 'price' | 'currency' | 'cycle' | 'billing'>,
  today: string,
): UpgradeQuote | undefined {
  if (!validDay(at) || at > today || !(next.price >= 0)) return undefined;
  const phases = phaseSubs(s);
  const old = phases[phases.length - 1];
  // 已有停用（含排定在以后的）走停用与退款，不在这里抵扣
  if (at <= old.start || (old.end && old.end < at) || old.stop || old.planned) return undefined;
  if (isPostpaid(old) || old.cycle.unit === 'lifetime' || next.billing === 'postpaid' || next.cycle.unit === 'lifetime') return undefined;
  if (old.currency !== next.currency) return undefined;
  // 生效日之后旧套餐已有续费或提前续费（补记过去的切换），剩余价值不止当期，不在这里折算
  if (old.payments?.some((p) => !p.kind && (p.date >= at || (p.serviceDate ?? '') >= at))) return undefined;
  const period = billingPeriod(s, addDays(at, -1));
  // 当期本身就是一次抵扣升级（无缝接在上一段后面，保持了旧扣款日，或首期实付低于全价）：实付不代表整期价值，不再叠加抵扣
  const seamless = period.from <= old.start && phases.some((p) => p !== old && p.end === addDays(old.start, -1));
  if (seamless && ((old.billingStart ?? old.start) < old.start || period.paid < old.price)) return undefined;
  // 赠送期并进当期时按天折算会把赠送天数也算成钱，不在这里折算
  if (old.bonus && old.bonus.from <= period.paidThrough && old.bonus.until > period.from) return undefined;
  const unusedDays = Math.min(period.days, Math.max(0, diffDays(at, period.paidThrough) + 1));
  // 当期实付已含补差；退款是负数不在其中，按日期落在当期的计入：退过一部分钱，能抵的也相应变少
  const paid = roundIn(
    period.paid + (old.payments ?? []).filter((p) => p.kind === 'refund' && p.date >= period.from && p.date < at).reduce((n, p) => n + p.amount, 0),
    next.currency,
  );
  if (!(paid > 0) || !unusedDays) return undefined;
  const ratio = unusedDays / period.days;
  const credit = roundIn(paid * ratio, next.currency);
  const quote: UpgradeQuote = { paid, days: period.days, unusedDays, credit, reset: roundIn(Math.max(0, next.price - credit), next.currency) };
  if (next.cycle.unit !== old.cycle.unit || (next.cycle.every ?? 1) !== (old.cycle.every ?? 1)) return quote;
  // 旧套餐有提前扣款、偏移等续费规则时新阶段不带，之后的扣款日会漂，不提供保持
  if ((old.chargeLeadDays ?? 0) > 0 || old.renewalOffsetDays || old.renewalHistory?.length) return quote;
  const open = { ...old, end: undefined, stop: undefined, status: 'active' as const, pausedAt: undefined };
  const oldNext = nextCharge(open, at);
  if (!oldNext) return quote;
  // 沿用旧套餐的计费锚点（保留月底日号）；扣款日漂移过、原锚点推不出下次扣款日时，改用下次扣款日往前一期。
  // 用真正切换后的订阅核对：旧套餐的续费规则（提前扣款、偏移）新阶段不带，推不出同一天就不提供
  const anchor = [old.billingStart ?? old.start, nthCharge(oldNext, old.cycle, -1)].find((a) => a < at && keptNext(s, at, next, a) === oldNext);
  if (!anchor) return quote;
  quote.keep = { amount: roundIn(Math.max(0, (next.price - paid) * ratio), next.currency), nextCharge: oldNext, anchor };
  return quote;
}

function withAnchor(s: Subscription, anchor: string): Subscription {
  const last = s.phases!.length - 1;
  return { ...s, phases: s.phases!.map((p, i) => (i === last ? { ...p, billingStart: anchor } : p)) };
}

function keptNext(s: Subscription, at: string, next: Pick<PlanChange, 'price' | 'currency' | 'cycle' | 'billing'>, anchor: string) {
  try {
    return nextCharge(withAnchor(switchPlan(s, at, next as PlanChange), anchor), at);
  } catch {
    return undefined;
  }
}

/**
 * 升级并处理旧套餐剩余：reset 在生效日记一笔首期实付（默认新价减抵扣额），新周期从生效日起算；
 * keep 新阶段沿用旧的扣款日，生效日记一笔补差（默认按剩余天数折算，为 0 时不记）。amount 可改成实际付的钱
 */
export function upgradePlan(s: Subscription, at: string, next: PlanChange, today: string, mode: UpgradeMode, amount?: number): Subscription {
  if (next.planned) throw new Error(t('core.phase.upgradeUnavailable'));
  const q = upgradeQuote(s, at, next, today);
  if (!q || (mode === 'keep' && !q.keep)) throw new Error(t('core.phase.upgradeUnavailable'));
  const pay = amount ?? (mode === 'keep' ? q.keep!.amount : q.reset);
  if (!Number.isFinite(pay) || pay < 0) throw new Error(t('core.subError.price'));
  const out = mode === 'keep' ? withAnchor(switchPlan(s, at, next), q.keep!.anchor) : switchPlan(s, at, next);
  const last = out.phases!.length - 1;
  const payment: Payment | undefined = mode === 'reset' ? { date: at, amount: pay } : pay > 0 ? { date: at, amount: pay, kind: 'adjust' } : undefined;
  return payment ? { ...out, phases: out.phases!.map((p, i) => (i === last ? { ...p, payments: [payment] } : p)) } : out;
}

/**
 * 补一段更早的历史：插在第一段之前，从 at 起；默认一直用到原来第一段开始（无缝），
 * 给了 until 时在那天结束，中间算断档。比如先买断、后来才改订阅，买断那段是后补的
 */
export function prependPlan(s: Subscription, at: string, prev: PlanChange, until?: string): Subscription {
  const phases = phasesOf(s);
  const first = phases[0];
  if (at >= first.start) throw new Error(t('core.phase.prependTooLate'));
  if (until && (until <= at || until >= first.start)) throw new Error(t('core.phase.prependUntil'));
  phases.unshift({ start: at, end: until ?? addDays(first.start, -1), ...prev });
  return mirror({ ...s, start: at }, phases);
}

/** 计划成真：去掉「计划」标记 */
export function confirmPlan(s: Subscription, start: string): Subscription {
  return mirror(
    s,
    phasesOf(s).map((p) => (p.start === start ? { ...p, planned: undefined } : p)),
  );
}

/** 日期未知的停用撤掉后一段：上一段成为末段，结束日不能变成停用日；清掉前固化它已发生的扣款，否则只剩首笔 */
function reopenUndatedLast(s: Subscription, last: Phase, removedStart: string): Phase {
  const all = phasesOf(s);
  const until = addDays(removedStart, -1);
  return {
    ...materialize(
      all,
      all.findIndex((p) => p.start === last.start),
      s,
      until,
      until,
    ),
    end: undefined,
  };
}

/** 不切换了：删掉这个计划阶段，上一阶段就在原定的切换日结束（到期不续）；原本就打算并行跑得更久的，保留它自己的结束日 */
export function dropPlan(s: Subscription, start: string): Subscription {
  const phases = phasesOf(s).filter((p) => p.start !== start);
  const last = phases[phases.length - 1];
  // 日期未知的停用不因撤掉一段而得到结束日：上一段的切换边界也不能变成停用日
  if (undatedStop(s)) {
    if (last.start < start) phases[phases.length - 1] = reopenUndatedLast(s, last, start);
  } else if (!last.end || last.end < start) last.end = addDays(start, -1);
  if (phases.length === 1) return phaseToTop(s, phases[0]);
  return mirror({ ...s, start: phases[0].start }, phases);
}

/** 断更后在 at 续订：上一阶段保持原来的结束日，中间的空档就是断更期 */
export function resume(s: Subscription, at: string, next: PlanChange): Subscription {
  const phases = phasesOf(s);
  const last = phases[phases.length - 1];
  if (undatedStop(s)) throw new Error(t('core.phase.resumeNeedsStopDate'));
  if (!last.end) last.end = addDays(s.pausedAt && s.pausedAt < at ? s.pausedAt : at, -1);
  if (at <= last.end) throw new Error(t('core.phase.resumeTooEarly'));
  phases.push({ start: at, ...next });
  return { ...mirror(s, phases), status: 'active', pausedAt: undefined };
}

/** 在当前阶段记一次调价：from 起按新价格扣费 */
export function changePrice(s: Subscription, from: string, amount: number): Subscription {
  const v = phaseSubs(s).findLast((p) => p.start <= from && (!p.end || from <= p.end));
  if (!v) throw new Error(t('core.phase.priceOutOfRange'));
  const hist = pricePoints(v);
  return replacePricePoints(s, v.start, hist.filter((p) => p.from !== from).concat({ from, amount }));
}

/** 无历史的阶段也有一个可编辑的起始价；不把首期优惠当作常规价格。 */
export function pricePoints(phase: Pick<Phase, 'priceHistory' | 'price' | 'start'>): PricePoint[] {
  return (phase.priceHistory?.length ? phase.priceHistory : [{ from: phase.start, amount: phase.price }]).slice().sort((a, b) => a.from.localeCompare(b.from));
}

/** 以阶段开始日定位，替换价格历史；不触碰扣款、计费锚点或其他阶段。 */
function replacePricePoints(s: Subscription, start: string, points: PricePoint[]): Subscription {
  const phases = phasesOf(s);
  const p = phases.find((p) => p.start === start);
  const v = phaseSubs(s).find((p) => p.start === start);
  if (!p || !v || !points.length) throw new Error(t('mcp.error.invalidTarget'));
  const old = pricePoints(p);
  for (const point of points) {
    if (!validDay(point.from) || point.from < start || (v.end && point.from > v.end)) {
      // movePhaseStart may retain older dated points. An unchanged historical point is still valid.
      if (!old.some((x) => x.from === point.from && x.amount === point.amount)) throw new Error(t('core.phase.priceOutOfRange'));
    }
    if (!Number.isFinite(point.amount) || point.amount < 0) throw new Error(t('core.subError.price'));
  }
  if (new Set(points.map((p) => p.from)).size !== points.length) throw new Error(t('core.phase.priceDuplicate'));
  p.priceHistory = points.map((p) => ({ ...p })).sort((a, b) => a.from.localeCompare(b.from));
  p.price = p.priceHistory.at(-1)!.amount;
  return s.phases?.length ? mirror(s, phases) : { ...s, price: p.price, priceHistory: p.priceHistory };
}

/** 修改一个价格点（包括起始价），oldFrom 为原生效日。 */
export function editPricePoint(s: Subscription, start: string, oldFrom: string, point: PricePoint): Subscription {
  const v = phaseSubs(s).find((p) => p.start === start);
  if (!v || !pricePoints(v).some((p) => p.from === oldFrom)) throw new Error(t('mcp.error.invalidTarget'));
  if (!validDay(point.from) || point.from < start || (v.end && point.from > v.end)) throw new Error(t('core.phase.priceOutOfRange'));
  return replacePricePoints(
    s,
    start,
    pricePoints(v).map((p) => (p.from === oldFrom ? point : p)),
  );
}

/** 删除调价后沿用前一个价格；最早的起始价不能删除。 */
export function removePricePoint(s: Subscription, start: string, from: string): Subscription {
  const v = phaseSubs(s).find((p) => p.start === start);
  if (!v) throw new Error(t('mcp.error.invalidTarget'));
  const hist = pricePoints(v);
  if (hist[0].from === from) throw new Error(t('core.phase.priceInitial'));
  if (!hist.some((p) => p.from === from)) throw new Error(t('mcp.error.invalidTarget'));
  return replacePricePoints(
    s,
    start,
    hist.filter((p) => p.from !== from),
  );
}

/** 已发生、没有实付覆盖且因价格修正改变金额的预计扣款笔数。 */
export function affectedPriceCharges(previous: Subscription, next: Subscription, today: string): number {
  const after = phaseSubs(next);
  return phaseSubs(previous).reduce((count, before, i) => {
    const v = after[i];
    if (!v) return count;
    const charges = new Map(chargesBetween(v, v.start, today, today).map((c) => [c.date, c]));
    return (
      count +
      chargesBetween(before, before.start, today, today).filter((c) => {
        if (before.payments?.some((p) => p.date === c.date)) return false;
        const revised = charges.get(c.date);
        return revised && revised.currency === c.currency && revised.amount !== c.amount;
      }).length
    );
  }, 0);
}

/** 阶段 i 最后一个服务日（含）；无缝切换在下一段开始前一天结束。 */
const endAt = (phases: Phase[], i: number) => phases[i].end ?? (phases[i + 1] ? addDays(phases[i + 1].start, -1) : '9999-12-31');

/**
 * 编辑表单对应的阶段：今天所在的阶段（还没开始的计划阶段不算；并行时取最晚开始的，与 currentPhase 一致），
 * 今天不在任何阶段里时取最近开始的，都没开始时取第一个
 */
function editIndex(phases: Phase[], today: string): number {
  const live = phases.findLastIndex((p, i) => p.start <= today && today <= endAt(phases, i));
  return live >= 0
    ? live
    : Math.max(
        0,
        phases.findLastIndex((p) => p.start <= today),
      );
}

/** 打开编辑表单时，顶层字段换成当前阶段的，避免把未生效的计划阶段当成现在的样子 */
export function toEditForm(s: Subscription, today: string): Subscription {
  if (!s.phases?.length) return s;
  const phases = phasesOf(s);
  const p = phases[editIndex(phases, today)];
  return {
    ...s,
    price: p.price,
    currency: p.currency,
    cycle: p.cycle,
    billing: p.billing,
    methodId: p.methodId,
    region: p.region,
    chargeLeadDays: p.chargeLeadDays,
    cancelLeadDays: p.cancelLeadDays,
    renewalHistory: p.renewalHistory,
    renewalOffsetDays: p.renewalOffsetDays,
    intro: p.intro,
    bonus: p.bonus,
  };
}

/**
 * 编辑表单改了顶层字段后，同步回当前阶段；结束日属于整个订阅，改了才写到最后一个阶段
 * （并行的旧段各有自己的结束日，没改结束日时不动它们；订阅的结束日对所有阶段封顶）
 */
export function syncPhase(s: Subscription, today: string): Subscription {
  if (!s.phases?.length) return s;
  const phases = phasesOf(s);
  Object.assign(phases[editIndex(phases, today)], {
    price: s.price,
    currency: s.currency,
    cycle: s.cycle,
    billing: s.billing,
    methodId: s.methodId,
    region: s.region,
    chargeLeadDays: s.chargeLeadDays,
    cancelLeadDays: s.cancelLeadDays,
    renewalHistory: s.renewalHistory,
    renewalOffsetDays: s.renewalOffsetDays,
    intro: s.intro,
    bonus: s.bonus,
  });
  if (s.end !== endOf(phases)) phases[phases.length - 1].end = s.end;
  phases[phases.length - 1].stop = s.stop;
  return { ...mirror(s, phases), end: s.end };
}

/**
 * 改某一段的结束日（按开始日定位）：留空回到缺省（下一段开始日；最后一段为一直延续）。
 * 晚于下一段的开始日即为并行，早于则中间是断更；最后一段的结束日就是整个订阅的结束日
 */
export function setPhaseEnd(s: Subscription, start: string, end: string | undefined): Subscription {
  if (end && end <= start) throw new Error(t('core.phase.endTooEarly'));
  if (!s.phases?.length) return { ...s, end };
  const phases = phasesOf(s);
  const p = phases.find((x) => x.start === start);
  if (!p) throw new Error(t('core.phase.priceOutOfRange'));
  if (end && phases.some((x) => x.start === end)) throw new Error(t('core.phase.endOnNextStart'));
  p.end = end;
  return mirror(s, phases);
}

/**
 * 改阶段标识（开始日），不移动实际发生的付款、停止、优惠、赠送和合租覆盖日期。
 * billingStart 固定原计费锚点，提前开始日时向前补周期，之后的扣款日不变；买断固化原购买记录。
 * priceHistory 中的初始价随标识迁移；跨过调价点时保留原历史并补新起点的有效价。
 * shiftBilling：扣款锚点随开始日一起平移（未来扣款日跟着变），买断的购买日也随之移动；默认保留原锚点。
 */
export function movePhaseStart(s: Subscription, start: string, nextStart: string, opts: { shiftBilling?: boolean } = {}): Subscription {
  if (!validDay(nextStart)) throw new Error(t('core.subError.start'));
  const phases = phasesOf(s);
  const i = phases.findIndex((p) => p.start === start);
  if (i < 0) throw new Error(t('core.phase.priceOutOfRange'));
  if (start === nextStart) return s;
  const p = phases[i];
  if ((i > 0 && nextStart <= phases[i - 1].start) || (phases[i + 1] && nextStart >= phases[i + 1].start)) throw new Error(t('core.phase.startOrder'));
  const end = phaseSubs(s).find((v) => v.start === start)?.end ?? p.end;
  if (end && nextStart >= end) throw new Error(t('core.phase.endTooEarly'));
  // 提前开始时，原本无缝接上来的上一段跟着收到新开始日前一天，不留静默并行；往后挪保持原结束日（中间算断档）
  if (nextStart < start) phases.forEach((x, j) => j < i && !x.stop && x.end === addDays(start, -1) && (phases[j] = { ...x, end: addDays(nextStart, -1) }));
  endBefore(phases, nextStart, p);
  if (p.stop && nextStart > p.stop.date) throw new Error(t('mcp.error.stopBeforeStart'));
  const v = { ...s, phases: undefined, ...p };
  const hist = p.priceHistory ?? [];
  const crossed = hist.some((h) => h.from !== start && h.from > start && h.from <= nextStart);
  const priceHistory = crossed
    ? [...hist, ...(hist.some((h) => h.from === nextStart) ? [] : [{ from: nextStart, amount: priceAt(v, nextStart) }])]
    : hist.map((h) => (h.from === start ? { ...h, from: nextStart } : h));
  const shift = !!opts.shiftBilling;
  const payments = !shift && p.cycle.unit === 'lifetime' && !p.payments?.length ? [{ date: start, amount: priceAt(v, start) }] : p.payments;
  phases[i] = {
    ...p,
    start: nextStart,
    priceHistory: p.priceHistory ? priceHistory : undefined,
    payments,
    billingStart: shift ? undefined : (p.billingStart ?? start),
  };
  const share = s.share && i === 0 ? { ...s.share, collectFrom: collectionAnchor(s), since: s.share.since ?? s.start } : s.share;
  const next = s.phases?.length ? mirror({ ...s, start: phases[0].start, share }, phases) : { ...s, ...phases[0], share };
  const error = subError(next);
  if (error) throw new Error(error);
  return next;
}

/** 开始日移动后新落到服务期之外的已有扣款；退款允许晚于服务结束日。 */
export function paymentsOutsideMovedPhase(previous: Subscription, next: Subscription): Payment[] {
  const before = phaseSubs(previous);
  return phaseSubs(next).flatMap((v, i) =>
    (v.payments ?? []).filter((p) => {
      const outside = (x: Subscription) => p.date < x.start || (!!x.end && p.date > x.end && p.kind !== 'refund');
      return outside(v) && !outside(before[i]);
    }),
  );
}

/** 删除一个阶段（误操作撤回）；只剩一个阶段时退回普通订阅 */
export function removePhase(s: Subscription, index: number): Subscription {
  const phases = phasesOf(s);
  if (phases.length <= 1) return s;
  const [removed] = phases.splice(index, 1);
  // 撤回最后一次换区：上一阶段只是因为换区才结束（或换区时选了继续跑到某天）的，恢复为进行中
  const prev = phases[phases.length - 1];
  if (index === phases.length && undatedStop(s)) phases[phases.length - 1] = reopenUndatedLast(s, prev, removed.start);
  else if (index === phases.length && !prev.stop && prev.end && prev.end >= addDays(removed.start, -1)) prev.end = undefined;
  if (phases.length === 1) return phaseToTop(s, phases[0]);
  return mirror({ ...s, start: phases[0].start }, phases);
}

// ---------- 扣款记录（手动编辑） ----------

/**
 * date 落在哪一段：开始日 ≤ date < 结束日；都不在时取它之前最近的一段。
 * 给了 phase（阶段开始日）就用那段；两段并行时，找已有记录（existing）优先取那天确实有扣款的一段，否则取最晚开始的一段
 */
function phaseIndexAt(phases: Phase[], date: string, sub?: Subscription, phase?: string, existing = false): number {
  const pick = phase ? phases.findIndex((p) => p.start === phase) : -1;
  if (pick >= 0) return pick;
  const live = phases.flatMap((p, k) => (p.start <= date && date < endAt(phases, k) ? [k] : []));
  if (existing && sub && live.length > 1) {
    const has =
      live.find((k) => (phases[k].payments ?? []).some((x) => x.date === date)) ??
      live.find(
        (k) => !phases[k].payments?.length && chargesBetween({ ...sub, phases: undefined, ...phases[k], end: endAt(phases, k) }, date, date, date).length,
      );
    if (has != null) return has;
  }
  // 改动提前付的下一段首期：这笔记在尚未开始的那一段里
  if (existing && !live.some((k) => phases[k].payments?.some((x) => x.date === date))) {
    const owner = phases.findIndex((p) => p.start > date && p.payments?.some((x) => x.date === date));
    if (owner >= 0) return owner;
  }
  if (live.length) return live[live.length - 1];
  const before = phases.map((p, k) => [p.start, k] as const).filter(([d]) => d <= date);
  return before.length ? before[before.length - 1][1] : 0;
}

/**
 * 把推算出来的历史扣款固化成记录：一段一旦有了扣款记录，就完全以记录为准，
 * 所以第一次手动改之前，先把到今天为止推算出的扣款写进去，并记下原本的下次扣款日，未来照旧。
 */
function materialize(phases: Phase[], k: number, sub: Subscription, today: string, target?: string): Phase {
  const p = phases[k];
  if (p.cycle.unit === 'lifetime') return p;
  const recorded = p.payments ?? [];
  // 已有记录且要改的那笔就在记录里：保持原样，不额外改写其他推算
  if (recorded.length && (!target || recorded.some((r) => r.date === target))) return p;
  const v = phaseView(phases, k, sub);
  const past = chargesBetween(v, p.start, today, today);
  const next = p.stop ? addDays(p.stop.paidThrough, 1) : chargesBetween(v, addDays(today, 1), addDays(today, 800), today).find((c) => !c.kind)?.date;
  // 要改的是记录之后推算出的扣款（如结束日当天的一期）：把推算的过去扣款补成记录，这一行才能修改或删除
  const inferred = past.filter((c) => !c.kind && !recorded.some((r) => r.date === c.date));
  const payments = [...recorded, ...inferred.map((c) => ({ date: c.date, amount: c.amount }))].sort((a, b) => a.date.localeCompare(b.date));
  // 到期前不会再扣（比如并行中快到期的旧段）：下次扣款记到结束日之后，既不多出一笔，删掉最后一笔也不会被重新推算出来
  return { ...p, payments, nextDue: p.nextDue ?? next ?? (p.end ? addDays(p.end, 1) : v.end && v.end < today ? addDays(v.end, 1) : undefined) };
}

/** 这一段的计费视图：没写结束日时到下一段开始前为止 */
function phaseView(phases: Phase[], k: number, sub: Subscription): Subscription {
  const p = phases[k];
  // 多段时与读取同一套视图：状态、试用、暂停、结束日都按这一段算
  const own = phases.length > 1 || sub.phases?.length ? phaseSubs({ ...sub, phases }).find((v) => v.start === p.start) : undefined;
  if (own) return own;
  return { ...phaseBase(sub), ...p, end: p.end ?? (k + 1 < phases.length ? addDays(phases[k + 1].start, -1) : undefined) };
}

/** 存储的 trial 到期后不会自动改写：这笔付款已在试用结束之后，就是正常计费。试用结束日存在订阅上，视图只有首段带着它 */
const isPastTrial = (v: Subscription, pay: Payment, trialEnd?: string) => v.status === 'trial' && !!trialEnd && pay.date >= trialEnd;

/** 只有计费中的预付订阅才有「提前结清」；试用、暂停、停止、后付费、买断不动 */
function settles(v: Subscription, pay: Payment, trialEnd: string | undefined): boolean {
  return !pay.kind && v.cycle.unit !== 'lifetime' && !isPostpaid(v) && !v.stop && !v.pausedAt && (v.status === 'active' || isPastTrial(v, pay, trialEnd));
}

const renewalsOf = (p: Phase) => (p.payments ?? []).filter((x) => !x.kind);
const latest = (days: string[]) => days.reduce((m, d) => (d > m ? d : m), '');

/** 最后一笔续费之后的第一个待付期；pay 用来放宽查找窗口，覆盖导入边界和赠送期之后才恢复的扣款 */
function pendingCharge(v: Subscription, p: Phase, pay: Payment, today: string) {
  const last = latest(renewalsOf(p).map((x) => x.date));
  const from = last ? addDays(last, 1) : p.start;
  const span = Math.ceil(cycleDays(p.cycle) * 2) + 32 + (p.chargeLeadDays ?? 0);
  return chargesBetween(v, from, addDays(pay.date > from ? pay.date : from, span), today).find((c) => !c.kind);
}

/**
 * 正常续费归入当期：早于下次扣款日、上一期已结清的算提前结清这一期，下次扣款日顺延一期，到期日不随付款日漂移；
 * 逾期付款同样按原计费日继续；上一期没结清时这笔归上一期，不顺延。
 */
function settleRenewal(phases: Phase[], k: number, sub: Subscription, pay: Payment, today: string): { phase: Phase; pay: Payment } {
  const p = phases[k];
  const same = { phase: p, pay };
  const v = phaseView(phases, k, sub);
  if (!settles(v, pay, sub.trialEnd) || pay.date <= latest(renewalsOf(p).map((x) => x.date))) return same;
  const charge = pendingCharge(v, p, pay, today);
  if (!charge) return same;
  const due = charge.date;
  if (pay.date >= due) return p.nextDue ? same : { phase: { ...p, nextDue: due }, pay };
  const prior = chargeBefore(v, due);
  const billed = prior >= p.start && prior >= (v.estimateFrom ?? '') && !(v.bonus && prior >= v.bonus.from && prior < v.bonus.until);
  if (billed && latest(renewalsOf(p).map((x) => x.serviceDate ?? x.date)) < prior) return same;
  const span = Math.ceil(cycleDays(p.cycle) * 2) + 32 + (p.chargeLeadDays ?? 0);
  const next = chargesBetween(v, addDays(due, 1), addDays(due, span), today).find((c) => !c.kind)?.date ?? (v.end && addDays(v.end, 1));
  return next ? { phase: { ...p, nextDue: next }, pay: { ...pay, serviceDate: charge.serviceDate ?? due } } : same;
}

/**
 * 去掉一笔提前续费：它之后的提前续费依次前移一期，下次扣款日回退一期，删除顺序不影响结果。
 * 之后已有准时的续费时，那一期算漏记，下次扣款日不动。
 */
function unsettleRenewal(p: Phase, v: Subscription, removed: Payment): Phase {
  if (!removed.serviceDate) return p;
  const later = renewalsOf(p)
    .filter((x) => x.date >= removed.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (later.some((x) => !x.serviceDate)) return p;
  let free = removed.serviceDate;
  const moved = new Map<Payment, Payment>();
  for (const x of later) {
    moved.set(x, { ...x, serviceDate: free });
    free = x.serviceDate!;
  }
  return { ...p, payments: p.payments?.map((x) => moved.get(x) ?? x), nextDue: chargeOfService(v, free) };
}

/**
 * 没有记录时事后补记：这一笔替换同一天的推算；不在推算日上时结清它之后的第一期，只去掉那一期，
 * 其余推算照常固化。下次扣款日已由固化算好，不再顺延。
 */
function dropSettledEstimate(p: Phase, v: Subscription, pay: Payment, today: string): { phase: Phase; service?: string } {
  const payments = p.payments ?? [];
  if (payments.some((x) => x.date === pay.date)) return { phase: { ...p, payments: payments.filter((x) => x.date !== pay.date) } };
  const settled = payments.find((x) => x.date > pay.date);
  if (!settled) return { phase: p };
  const charge = chargesBetween(v, settled.date, settled.date, today).find((c) => !c.kind);
  return { phase: { ...p, payments: payments.filter((x) => x !== settled) }, service: charge?.serviceDate ?? settled.date };
}

/** 写入前把旧版提前记账落成记录，后面的顺延和回退都按它算。 */
function settleLegacyPhases(phases: Phase[], sub: Subscription, stopAt?: string): void {
  phases.forEach((p, k) => {
    if (stopAt && p.payments?.some((x) => !x.kind && x.date >= stopAt)) return;
    const v = phaseView(phases, k, sub);
    const settled = settleLegacyEarly(v);
    if (settled !== v) phases[k] = { ...p, nextDue: settled.nextDue, payments: settled.payments };
  });
}

/** 这笔普通扣款保存后算提前续费时，返回它结清的一期和下一期的扣款日；表单用来提前说明。 */
export function earlyRenewalEffect(
  s: Subscription,
  today: string,
  pay: Payment,
  old?: { date: string; index: number },
  phase?: string,
): { settles: string; next: string } | undefined {
  if (pay.kind || old?.date === pay.date) return undefined;
  let saved: Subscription;
  try {
    saved = savePayment(s, today, pay, old, phase);
  } catch {
    return undefined;
  }
  // 只看这次新增的结清：同一段同一天已有一笔提前续费时，再记一笔不算
  const had = new Map(
    phaseSubs(s).map((v) => [
      v.start,
      new Set(
        settleLegacyEarly(v)
          .payments?.filter((x) => x.date === pay.date)
          .map((x) => x.serviceDate),
      ),
    ]),
  );
  for (const v of phaseSubs(saved)) {
    const service = settleLegacyEarly(v).payments?.find((x) => x.date === pay.date && x.serviceDate && !had.get(v.start)?.has(x.serviceDate))?.serviceDate;
    if (!service) continue;
    const settles = chargeOfService(v, service);
    if (pay.date >= settles) continue;
    const span = Math.ceil(cycleDays(v.cycle) * 2) + 32 + (v.chargeLeadDays ?? 0);
    const next = chargesBetween(v, addDays(settles, 1), addDays(settles, span), today).find((c) => !c.kind)?.date;
    if (next) return { settles, next };
  }
  return undefined;
}

/** 新增或修改一笔扣款记录；old 为原记录的日期与序号（修改时） */
export function savePayment(s: Subscription, today: string, pay: Payment, old?: { date: string; index: number }, phase?: string): Subscription {
  if (isSeparate(s)) return saveSeparatePayment(s, pay, old, phase);
  const phases = phasesOf(s);
  settleLegacyPhases(phases, s);
  // 改写一笔时没有带 methodId 这个键（如 MCP 只改金额），沿用原来那一笔单独记的支付方式；明确传 undefined 才清除
  let originalPhase: number | undefined;
  let keptService: string | undefined;
  let sameDay = false;
  if (old) {
    const oi = phaseIndexAt(phases, old.date, s, phase, true);
    phases[oi] = materialize(phases, oi, s, today, old.date);
    originalPhase = oi;
    const list = (phases[oi].payments ?? []).filter((x) => x.date === old.date);
    const target = list[old.index];
    if (!target) throw new Error(t('mcp.error.invalidTarget'));
    // 资金拆分同理：两个键都没带时沿用原来的拆分；带了拆分就不再沿用单独的支付方式
    if (!('methodId' in pay) && !('funding' in pay) && target.funding?.length) pay = { ...pay, funding: target.funding };
    else if (!('methodId' in pay) && !pay.funding?.length && target.methodId) pay = { ...pay, methodId: target.methodId };
    const kept = { ...phases[oi], payments: (phases[oi].payments ?? []).filter((x) => x !== target) };
    // 改金额、改支付方式，或日期仍早于到期日：仍结清原来那一期，留在原段
    if (target.serviceDate && !pay.kind && pay.date < chargeOfService(phaseView(phases, oi, s), target.serviceDate)) keptService = target.serviceDate;
    sameDay = pay.date === target.date;
    phases[oi] = keptService ? kept : unsettleRenewal(kept, phaseView(phases, oi, s), target);
  }
  if (pay.serviceDate !== keptService) pay = { ...pay, serviceDate: keptService };
  if (pay.funding && !pay.funding.length) pay = { ...pay, funding: undefined };
  // 原日期不变的编辑始终留在原阶段（修正开始日后可能在服务期外）；改日期或新记录仍按覆盖范围归段
  // 指定了尚未开始的一段：是提前付那一段的首期
  const keep = phase
    ? phases.findIndex(
        (p, k) =>
          p.start === phase && (old?.date === pay.date || (p.start <= pay.date ? pay.kind === 'refund' || pay.date < endAt(phases, k) : !old && !pay.kind)),
      )
    : -1;
  let i = keptService || (sameDay && !phase) ? originalPhase! : keep >= 0 ? keep : phaseIndexAt(phases, pay.date);
  // The original phase was already materialized before removal. Repeating it after
  // removing its sole payment would recreate the estimate being replaced.
  const fresh = i !== originalPhase;
  const prepare = (k: number) => {
    const bare = !phases[k].payments?.length;
    const p = materialize(phases, k, s, today);
    const v = phaseView(phases, k, s);
    return bare && settles(v, pay, s.trialEnd) ? dropSettledEstimate(p, v, pay, today) : { phase: p };
  };
  // 当前一段已经没有待付期、下一段还没开始：这笔是提前付下一段的首期
  if (!old && keep < 0 && i + 1 < phases.length && phases[i + 1].start > pay.date && settles(phaseView(phases, i, s), pay, s.trialEnd)) {
    const current = prepare(i).phase;
    if (pay.date > latest(renewalsOf(current).map((x) => x.date)) && !pendingCharge(phaseView(phases, i, s), current, pay, today)) i += 1;
  }
  if (fresh) {
    const prepared = prepare(i);
    phases[i] = prepared.phase;
    if (prepared.service) {
      keptService = prepared.service;
      pay = { ...pay, serviceDate: keptService };
    }
  }
  const settled = keptService ? { phase: phases[i], pay } : settleRenewal(phases, i, s, pay, today);
  phases[i] = { ...settled.phase, payments: [...(settled.phase.payments ?? []), settled.pay].sort((a, b) => a.date.localeCompare(b.date)) };
  const next = fromPhases(s, phases);
  const error = subError(next);
  if (error) throw new Error(error);
  return next;
}

/**
 * 改一段方案的支付方式：这一段的扣款都跟着换；这一段里单独记成同一张卡的扣款去掉单独记录，
 * 单独记成别的卡的保持不变。没有分段的订阅就是改订阅本身
 */
export function setPhaseMethod(s: Subscription, phaseStart: string, methodId: string | undefined): Subscription {
  const clear = (pays?: Payment[]) => pays?.map((x) => (x.methodId === methodId ? { ...x, methodId: undefined } : x));
  if (!s.phases?.length) return { ...s, methodId, payments: clear(s.payments) };
  const phases = phasesOf(s).map((p) => (p.start === phaseStart ? { ...p, methodId, payments: clear(p.payments) } : p));
  const next = mirror(s, phases);
  const error = subError(next);
  if (error) throw new Error(error);
  return next;
}

/** 删除一笔扣款记录 */
/** 分开记的缴费可能记在指定的账单所在的阶段（不一定是缴费日所在的段）：在所有阶段里按日期找第 index 笔；给了 phase 先找那段 */
function findSeparatePayment(phases: Phase[], date: string, index: number, phase?: string): [number, Payment] {
  const found = (only?: string) =>
    phases.flatMap((p, k) => (only && p.start !== only ? [] : (p.payments ?? []).filter((x) => x.date === date).map((x) => [k, x] as [number, Payment])));
  const hit = (phase ? found(phase)[index] : undefined) ?? found()[index];
  if (!hit) throw new Error(t('mcp.error.invalidTarget'));
  return hit;
}

/**
 * 账单与缴费分开记：缴费原样记下，不固化推算、不推下次扣款日、不识别提前续费；分配由 settleBills 按 periods 与先后顺序算出。
 * 指定了结清哪几期时记在第一期所在的阶段，否则按缴费日归段
 */
function saveSeparatePayment(s: Subscription, pay: Payment, old?: { date: string; index: number }, phase?: string): Subscription {
  const phases = phasesOf(s);
  if (old) {
    const [oi, target] = findSeparatePayment(phases, old.date, old.index, phase);
    if (!('methodId' in pay) && !('funding' in pay) && target.funding?.length) pay = { ...pay, funding: target.funding };
    else if (!('methodId' in pay) && !pay.funding?.length && target.methodId) pay = { ...pay, methodId: target.methodId };
    if (!('periods' in pay) && target.periods && !pay.kind) pay = { ...pay, periods: target.periods };
    phases[oi] = { ...phases[oi], payments: (phases[oi].payments ?? []).filter((x) => x !== target) };
  }
  const periods = pay.kind || !pay.periods?.length ? undefined : [...new Set(pay.periods)].sort();
  pay = { ...pay, serviceDate: undefined, periods, ...(pay.funding && !pay.funding.length ? { funding: undefined } : {}) };
  const i = phaseIndexAt(phases, periods?.[0] ?? pay.date, s, phase);
  phases[i] = { ...phases[i], payments: [...(phases[i].payments ?? []), pay].sort((a, b) => a.date.localeCompare(b.date)) };
  const next = fromPhases(s, phases);
  const error = subError(next);
  if (error) throw new Error(error);
  return next;
}

export function deletePayment(s: Subscription, today: string, date: string, index: number, phase?: string): Subscription {
  if (isSeparate(s)) {
    const phases = phasesOf(s);
    const [i, target] = findSeparatePayment(phases, date, index, phase);
    phases[i] = { ...phases[i], payments: (phases[i].payments ?? []).filter((x) => x !== target) };
    return fromPhases(s, phases);
  }
  const phases = phasesOf(s);
  settleLegacyPhases(phases, s);
  const i = phaseIndexAt(phases, date, s, phase, true);
  phases[i] = materialize(phases, i, s, today, date);
  const list = (phases[i].payments ?? []).filter((x) => x.date === date);
  const target = list[index];
  if (!target) throw new Error(t('mcp.error.invalidTarget'));
  const payments = (phases[i].payments ?? []).filter((x) => x !== target);
  // 删掉已结束阶段的最后一笔：这笔本就不该有，下次扣款推到结束日之后，不再被推算回来
  const end = phaseView(phases, i, s).end;
  const due = phases[i].nextDue;
  // 旧段还在跑、下次扣款仍在结束日前：删的只是其中一期，后面的预测不动
  const last = end && (end < today || !due || due > end) && !payments.some((x) => x.date >= date);
  phases[i] = { ...unsettleRenewal({ ...phases[i], payments }, phaseView(phases, i, s), target), ...(last ? { nextDue: addDays(end, 1) } : {}) };
  return fromPhases(s, phases);
}

/** 只有一段时写回顶层（不引入 phases），多段时镜像最后一段 */
function fromPhases(s: Subscription, phases: Phase[]): Subscription {
  if (!s.phases?.length && phases.length === 1) {
    const p = phases[0];
    return { ...s, payments: p.payments, nextDue: p.nextDue };
  }
  return mirror(s, phases);
}

export interface StopRefund {
  amount: number;
  date?: string;
  currency?: string;
  settled?: { amount: number; currency: string };
}

/** 提前停止：撤销所有后续阶段，保留已发生的扣款与原已付服务期。 */
export function stopSubscription(s: Subscription, today: string, kind: Stop['kind'], at = today, reason?: string, refund?: StopRefund): Subscription {
  if (!validDay(at)) throw new Error(t('mcp.error.notDate', { what: 'at' }));
  if (at < s.start) throw new Error(t('mcp.error.stopBeforeStart'));
  if (s.stop || isStopped(effectiveStatus(s, today))) throw new Error(t('mcp.error.subscriptionEnded'));
  // 旧版提前续费先写进记录：停用后读取不再识别，已付账期要和停用前算的一致
  if (s.phases?.length) {
    const phases = phasesOf(s);
    settleLegacyPhases(phases, s, at);
    s = mirror(s, phases);
  } else if (!s.payments?.some((p) => !p.kind && p.date >= at)) s = settleLegacyEarly(s);
  const current = currentPhase(s, at);
  if (at < current.start) throw new Error(t('mcp.error.stopBeforeStart'));
  const period = stopBillingPeriod(current, at, today);
  if (at > period.paidThrough) throw new Error(t('mcp.error.stopAfterPaidThrough'));
  const stop: Stop = { kind, date: at, paidThrough: period.paidThrough, reason: kind === 'terminate' ? reason?.trim() || undefined : undefined };
  // 停在暂停之后：记下暂停日，暂停期间没发生的扣款不复活
  if (s.status === 'paused' && s.pausedAt && s.pausedAt <= at) stop.pausedAt = s.pausedAt;
  let next: Subscription;
  if (s.phases?.length) {
    // 停用日才开始、又不是当前段的计划（比如暂停中排好的）从未生效，没有付款就撤掉，有付款留给校验报错，不悄悄删；
    // 目标段恰在停用日开始时，并行的较早阶段截到前一天，免得两段那天各扣一次
    const phases = phasesOf(s).filter((p) => p.start < at || p.start === current.start || p.payments?.length);
    const cut = current.start === at ? addDays(at, -1) : at;
    for (const p of phases) {
      if (!p.end || p.end > at || (p.end === at && p.start < at)) p.end = p.start < at ? cut : at;
    }
    const target = phases.find((p) => p.start === current.start)!;
    target.stop = stop;
    target.end = at;
    next = { ...mirror(s, phases), end: at, stop };
  } else next = { ...s, end: at, stop };
  next = { ...next, status: kind === 'terminate' ? 'terminated' : 'cancelled', pausedAt: undefined };
  if (refund) {
    if (!Number.isFinite(refund.amount) || refund.amount < 0) throw new Error(t('mcp.error.invalidRefund'));
    if (refund.currency && refund.currency !== current.currency) throw new Error(t('mcp.error.refundCurrency'));
    const date = refund.date ?? at;
    if (date < at) throw new Error(t('mcp.error.refundBeforeStop'));
    next = savePayment(
      next,
      today,
      {
        date,
        amount: -refund.amount,
        currency: current.currency,
        kind: 'refund',
        settled: refund.settled ? { ...refund.settled, amount: -Math.abs(refund.settled.amount) } : undefined,
      },
      undefined,
      current.start,
    );
  }
  const error = subError(next);
  if (error) throw new Error(error);
  return next;
}

/**
 * 暂停结束时记下这段区间（暂停日清掉后，扣款推算只能靠它跳过）。已有记录的 pauses 只由这里追加，整条替换带来的值不生效。
 * 补录的新阶段早于今天时算到新阶段开始；这段本来就没有阶段在跑（断更后续订）就不用记。
 */
export function closePause(previous: Subscription | undefined, next: Subscription, today: string): Subscription {
  const pauses = previous ? previous.pauses : next.pauses;
  const base = pauses === next.pauses ? next : { ...next, pauses };
  const from = previous && pausedFromOf(previous);
  if (!from || next.phases?.some((p) => p.stop?.pausedAt === from)) return base;
  // 还在暂停：只有暂停中停用后又改回暂停（暂停日晚于原来）才算前一段结束，改暂停日不算
  const again = next.status === 'paused' ? (next.pausedAt ?? today) : pausedFromOf(next);
  if (again && (previous.status === 'paused' || again <= from)) return base;
  const known = new Set(previous.phases?.map((p) => p.start));
  const resumed = next.phases
    ?.map((p) => p.start)
    .filter((d) => d > from && !known.has(d))
    .sort()[0];
  const until = again && again < today ? again : today;
  const to = resumed && resumed < until ? resumed : until;
  if (from >= to || !phaseSubs(next).some((v) => v.start < to && (!v.end || v.end >= from))) return base;
  return { ...base, pauses: [...(pauses ?? []), { from, to }].sort((a, b) => a.from.localeCompare(b.from)) };
}

/** 清掉停用、暂停与结束日（最后一段同样），不做任何状态约束；对外用 reactivate */
export function reopenStopped(s: Subscription): Subscription {
  const phases = s.phases?.map((p, i, all) => (i === all.length - 1 ? { ...p, end: undefined, stop: undefined } : p));
  return { ...s, phases, status: 'active', pausedAt: undefined, end: undefined, stop: undefined };
}

/** 恢复：清掉停用（含被服务方停用）、暂停与结束日，当作这次停用没发生过。服务真的中断后又重新订阅时用 resume 另起新阶段。 */
export function reactivate(s: Subscription): Subscription {
  const open = reopenStopped(s);
  if (!undatedStop(s) || !open.phases) return open;
  // 未知日期停用时为并行旧段停掉的预测（下次扣款推到结束日后），恢复时还原
  const phases = open.phases.map((p, i, all) => (i < all.length - 1 && p.end && p.nextDue === addDays(p.end, 1) ? { ...p, nextDue: undefined } : p));
  return { ...open, phases };
}

/** API 与 MCP 共用的状态迁移约束；重新订阅必须保留原停用阶段并新增阶段。调用方已先做 subError 整体校验。 */
export function statusChangeError(previous: Subscription | undefined, next: Subscription, today: string): string | undefined {
  if (
    next.status === 'paused' &&
    next.pausedAt &&
    next.pausedAt < next.start &&
    (!previous || next.pausedAt !== previous.pausedAt || next.start !== previous.start)
  )
    return t('mcp.error.stopBeforeStart');
  if (previous && !previous.stop && next.stop) {
    // An existing end date can be corrected into an explicit stop by the full editor.
    // Action-based MCP callers still reject ended subscriptions before reaching this validator.
    // An undated stop (stopUndated) may be given its real date; other ended records may not gain a new stop.
    const undated = (previous.status === 'cancelled' || previous.status === 'terminated') && !previous.end;
    const status = effectiveStatus(previous, today);
    if (!undated && (status === 'terminated' || (status === 'ended' && !previous.end))) return t('mcp.error.subscriptionEnded');
    const period = stopBillingPeriod(currentPhase(previous, next.stop.date), next.stop.date, today);
    if (next.stop.date > period.paidThrough) return t('mcp.error.stopAfterPaidThrough');
  }
  // 日期未知的被停用：改别的字段时仍是同一状态，不算改停用方式
  const segments = (x?: Subscription) => Math.max(x?.phases?.length ?? 0, 1);
  // 只放行修正：不能新增阶段，也不能把阶段挪到将来，否则已停用的订阅又开始预测
  if (
    previous?.status === 'terminated' &&
    undatedStop(previous) &&
    next.status === 'terminated' &&
    undatedStop(next) &&
    segments(next) <= segments(previous) &&
    !next.phases?.some((p) => p.start > today)
  )
    return undefined;
  if (previous && (previous.stop?.kind === 'terminate' || previous.status === 'terminated') && next.stop?.kind !== 'terminate') {
    const old = phaseSubs(previous).at(-1)!;
    // 撤销误记的停用：整段停用连同结束日一起清掉，不允许改成别的停用方式
    // 阶段原样保留、较早阶段的停用与结束日不变、误记那段清空，才算撤销；同时换阶段或另加停用的仍按改停用方式拒绝
    const starts = (x: Subscription) => (x.phases ?? []).map((p) => p.start).join();
    const same = next.phases?.find((p) => p.start === old.start);
    const cleared = !next.stop && !next.end && next.status !== 'cancelled' && next.status !== 'terminated';
    const earlier = (x: Subscription) => JSON.stringify((x.phases ?? []).filter((p) => p.start !== old.start).map((p) => [p.start, p.end, p.stop]));
    if (cleared && starts(next) === starts(previous) && earlier(next) === earlier(previous) && (!next.phases?.length || (same && !same.stop && !same.end)))
      return undefined;
    const history = next.phases?.find((p) => p.start === old.start);
    const newPhase = next.phases?.some((p) => p.start > old.end!);
    if (history?.stop?.date !== old.stop?.date || history?.end !== old.end) return t('mcp.error.terminatedReactivate');
    if (!history?.stop || history.stop.kind !== 'terminate' || !newPhase) return t('mcp.error.terminatedReactivate');
  }
  return undefined;
}

/**
 * 已停用、日期未知：只记 cancelled / terminated 状态，不填 end 与 stop，也不把今天当停用日；
 * 撤销今天之后才开始的计划阶段。已记录的扣款原样保留，之后不再预测扣款。
 */
export function stopUndated(s: Subscription, kind: Stop['kind'], today: string): Subscription {
  if (s.stop || isStopped(effectiveStatus(s, today))) throw new Error(t('mcp.error.subscriptionEnded'));
  // 直接去掉未来阶段，不用 dropPlan：它会给前一段补一个结束日，那就成了编造的停用日期
  const kept = s.phases?.length ? phasesOf(s).filter((p) => p.start <= today) : [];
  // 原定今天及以后的结束日：最后一段的作废，否则仍显示到期不续；并行的旧段保留结束日这段历史，固化已发生的扣款，下次扣款推到结束日之后
  const futureEnd = kept.some((p) => p.end && p.end >= today);
  kept.forEach((p, i) => {
    if (!p.end || p.end < today) return;
    if (i === kept.length - 1) p.end = undefined;
    else kept[i] = { ...materialize(kept, i, s, today, today), nextDue: addDays(p.end, 1) };
  });
  const c = kept.length && (futureEnd || kept.length < s.phases!.length) ? mirror(s, kept) : s;
  return { ...c, status: kind === 'terminate' ? 'terminated' : 'cancelled', pausedAt: undefined, end: undefined, stop: undefined };
}

/** 到期不续：只有 end，没有 stop；撤销结束日之后的阶段。 */
export function cancelAtEnd(s: Subscription, at: string, today: string): Subscription {
  if (s.stop || isStopped(effectiveStatus(s, today))) throw new Error(t('mcp.error.subscriptionEnded'));
  if (!validDay(at)) throw new Error(t('mcp.error.notDate', { what: 'at' }));
  if (at < s.start) throw new Error(t('mcp.error.stopBeforeStart'));
  // 暂停到期后不续没有已付期可等，就是在这天停用；要记下暂停日，同 stopSubscription
  if (s.status === 'paused' && s.pausedAt && s.pausedAt <= at) return stopSubscription(s, today, 'cancel', at);
  let c = s;
  for (const p of (s.phases ?? []).filter((p) => p.start > at).sort((a, b) => b.start.localeCompare(a.start))) c = dropPlan(c, p.start);
  return syncPhase({ ...toEditForm(c, today), status: 'cancelled', end: at, stop: undefined }, today);
}

/** Correct one existing phase without replacing unrelated phases or recorded payments. */
export function editPhase(s: Subscription, start: string, patch: Partial<Phase>): Subscription {
  if (patch.priceHistory === null) throw new Error(t('core.phase.priceInitial'));
  const phases = phasesOf(s);
  const index = phases.findIndex((p) => p.start === start);
  if (index < 0) throw new Error(t('mcp.error.invalidTarget'));
  phases[index] = applyFields(phases[index], patch);
  phases.sort((a, b) => a.start.localeCompare(b.start));
  if (new Set(phases.map((p) => p.start)).size !== phases.length) throw new Error(t('mcp.error.invalidTarget'));
  // 其余字段格式由写入入口统一校验（subRefsError → newShapeError）；开始日先查，后面的定位依赖它
  for (const phase of phases) {
    if (!validDay(phase.start)) throw new Error(t('core.subError.start'));
    if (phase.end && phase.end < phase.start) throw new Error(t('core.phase.endTooEarly'));
  }
  let next = mirror({ ...s, start: phases[0].start }, phases);
  const target = phases.find((p) => p.start === (patch.start ?? start))!;
  if (patch.priceHistory) {
    const initial = pricePoints(phasesOf(s).find((p) => p.start === start)!)[0];
    if (!patch.priceHistory.some((p) => p.from === initial.from)) throw new Error(t('core.phase.priceInitial'));
    const end = phaseSubs(next).find((p) => p.start === target.start)?.end;
    if (patch.priceHistory.some((p) => !validDay(p.from) || p.from < target.start || (end && p.from > end))) throw new Error(t('core.phase.priceOutOfRange'));
    next = replacePricePoints(next, target.start, patch.priceHistory);
  } else if (patch.price !== undefined && target.priceHistory?.length) {
    const hist = pricePoints(target);
    next = editPricePoint(next, target.start, hist.at(-1)!.from, { ...hist.at(-1)!, amount: patch.price });
  }
  return next;
}

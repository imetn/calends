import { amountTotal, convertedTotal, formatTotal, chargeTotal, emptyTotal, scaleTotal, sumTotals, type FxTotal } from './fx-total.ts';
// 把个人订阅当成一家「反向 SaaS 公司」来做财报：MRR 走势、月度变动、权责发生制、预付余值、退订省下的钱。
// MRR 与退订省钱按当前汇率；历史现金、停用损失按发生日汇率。
import {
  activePhases,
  chargeServicePeriod,
  stopSummary,
  addDays,
  addMonths,
  chargesBetween,
  coveredUntil,
  cycleDays,
  phaseSubs,
  diffDays,
  effectiveStatus,
  isGap,
  myShareFactor,
  monthlyGross,
  nextCharge,
  nthCharge,
  priceAt,
  runwayFor,
  type Charge,
  DAYS_PER_MONTH,
} from './billing.ts';
import { chargeBaseOrNaN, chargeValue, convertOn, toBaseAt, toBaseOrNaN } from './fx.ts';
import { cnDate, money } from './format.ts';
import { intlLocale, t } from './i18n.ts';
import type { AppState, PaymentMethod, Subscription } from './types.ts';
import { transferRows, transferredStop } from './transfers.ts';

const MONTH = DAYS_PER_MONTH;

/** day 当天这个订阅贡献的月成本（本位币，我承担的部分）；不在计费状态则为 0 */
export function contributionOn(state: AppState, s: Subscription, day: string, fxDate?: string): number {
  if (s.proxy) return 0;
  // 多阶段：当天在跑的各段相加（换区后新旧两段并行时两边都在付钱）
  if (s.phases?.length) return activePhases(s, day).reduce((a, v) => a + contributionOn(state, v, day, fxDate), 0);
  if (s.cycle.unit === 'lifetime') return 0;
  if (s.start > day) return 0;
  if (s.stop && s.stop.date <= day) return 0;
  if (s.end && s.end < day) return 0;
  if (s.status === 'cancelled' && !s.end) return 0;
  if (s.status === 'paused' && (s.pausedAt ?? day) <= day) return 0;
  if (s.status === 'trial' && s.trialEnd && s.trialEnd > day) return 0;
  return toBaseOrNaN(state, monthlyGross(s, day), s.currency, fxDate) * myShareFactor(s, day);
}

/** The same contribution rules, retaining original phase currencies when FX is unavailable. */
export function contributionTotal(state: AppState, s: Subscription, day: string, fxDate?: string): FxTotal {
  if (s.phases?.length) return sumTotals(activePhases(s, day).map((v) => contributionTotal(state, v, day, fxDate)));
  const amount = contributionOn({ ...state, settings: { ...state.settings, baseCurrency: s.currency } }, s, day, fxDate);
  return amountTotal(amount, s.currency, contributionOn(state, s, day, fxDate));
}
export const mrrTotal = (state: AppState, day: string, fxDate?: string) => sumTotals(state.subscriptions.map((s) => contributionTotal(state, s, day, fxDate)));

/** fxDate 缺省为当前汇率；传入则按该日汇率 */
export function mrrOn(state: AppState, day: string, fxDate?: string): number {
  return state.subscriptions.reduce((a, s) => a + contributionOn(state, s, day, fxDate), 0);
}

export function monthEnd(month: string): string {
  return addDays(addMonths(month + '-01', 1), -1);
}

/** 从上月末到 day 的月成本变动；包含汇率影响，与月度变动报告使用同一口径。 */
export function monthMovement(state: AppState, day: string, historical = false): Movement {
  return movement(state, addDays(day.slice(0, 8) + '01', -1), day, historical ? day : undefined);
}

export function mrrChangeSinceLastMonth(state: AppState, today: string): number {
  const change = monthMovement(state, today);
  return change.to - change.from;
}

/**
 * 图表从哪个月画起：最多 range 个月（缺省为全部），但不早于账本第一笔数据所在月，至少 2 个月。
 * 选「3 年」而账本才半年时，不再在前面画两年多的零线。按自然月精确计数。
 */
export function chartMonths(first: string, today: string, range?: number): number {
  const span = (Number(today.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
  return Math.max(2, Math.min(range ?? span, span));
}

export interface MrrPoint {
  month: string; // YYYY-MM
  mrr: number;
  partial: FxTotal;
}

/** 每月月末（当月为今天）的 MRR；historical 为 true 时按当月汇率，否则按当前汇率 */
export function mrrSeries(state: AppState, today: string, months: number, historical = false): MrrPoint[] {
  const out: MrrPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = addMonths(today.slice(0, 8) + '01', -i).slice(0, 7);
    const day = i === 0 ? today : monthEnd(m);
    out.push({ month: m, mrr: mrrOn(state, day, historical && i > 0 ? day : undefined), partial: mrrTotal(state, day, historical && i > 0 ? day : undefined) });
  }
  return out;
}

export interface Movement {
  partial: { from: FxTotal; to: FxTotal };
  /** 期初 MRR（期初汇率） */
  from: number;
  /** 汇率变化带来的增减：期初的订阅组合按期末汇率重估 */
  fx: number;
  to: number;
  added: number;
  expansion: number;
  contraction: number;
  churned: number;
  items: Array<{ sub: Subscription; kind: 'added' | 'expansion' | 'contraction' | 'churned'; delta: number }>;
}

/**
 * 区间 (start, end] 内的 MRR 变动。
 * 期初按期初汇率；先把期初组合按期末汇率重估得到「汇率影响」，
 * 再在期末汇率下拆出新增、涨价、降价、退订，保证各项相加正好等于期末。
 * endFx 缺省（期末是今天）时用当前汇率。
 */
export function movement(state: AppState, start: string, end: string, endFx?: string): Movement {
  const r: Movement = {
    partial: { from: mrrTotal(state, start, start), to: mrrTotal(state, end, endFx) },
    from: 0,
    fx: 0,
    to: 0,
    added: 0,
    expansion: 0,
    contraction: 0,
    churned: 0,
    items: [],
  };
  for (const s of state.subscriptions) {
    const a0 = contributionOn(state, s, start, start);
    const a = contributionOn(state, s, start, endFx);
    const b = contributionOn(state, s, end, endFx);
    r.from += a0;
    r.fx += a - a0;
    r.to += b;
    const d = b - a;
    if (!Number.isFinite(d) || Math.abs(d) < 0.005) continue;
    const kind = a === 0 ? 'added' : b === 0 ? 'churned' : d > 0 ? 'expansion' : 'contraction';
    r[kind] += Math.abs(d);
    r.items.push({ sub: s, kind, delta: d });
  }
  r.items.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return r;
}

export type EventKind = 'start' | 'end' | 'price' | 'intro-end' | 'buy' | 'pause' | 'switch' | 'resume' | 'terminate';

export interface LedgerEvent {
  partial?: FxTotal;
  date: string;
  sub: Subscription;
  kind: EventKind;
  /** 对 MRR 的影响（本位币/月），买断为一次性金额 */
  delta: number;
  note?: string;
}

/** 单个阶段的事件 */
function eventsOf(state: AppState, s: Subscription, today: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  if (s.cycle.unit === 'lifetime') {
    if (s.start <= today) out.push({ date: s.start, sub: s, kind: 'buy', delta: toBaseOrNaN(state, s.price, s.currency) });
    return out;
  }
  const after = (d: string) => contributionOn(state, s, d);
  if (s.start <= today)
    out.push({
      date: s.start,
      sub: s,
      kind: 'start',
      delta: after(s.start) || after(addDays(s.start, 1)) || toBaseOrNaN(state, (s.price * MONTH) / cycleDays(s.cycle), s.currency) * myShareFactor(s, s.start),
    });
  const hist = (s.priceHistory ?? []).slice().sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].from > today) continue;
    const prev = hist[i - 1].amount;
    const cur = hist[i].amount;
    if (prev === cur) continue;
    out.push({
      date: hist[i].from,
      sub: s,
      kind: 'price',
      delta: toBaseOrNaN(state, ((cur - prev) * MONTH) / cycleDays(s.cycle), s.currency) * myShareFactor(s, hist[i].from),
      note: `${prev} → ${cur} ${s.currency}`,
    });
  }
  if (s.intro && s.intro.until <= today && s.intro.until > s.start) {
    out.push({
      date: s.intro.until,
      sub: s,
      kind: 'intro-end',
      delta: toBaseOrNaN(state, ((s.price - s.intro.price) * MONTH) / cycleDays(s.cycle), s.currency) * myShareFactor(s, s.intro.until),
    });
  }
  if (s.stop && s.stop.date <= today)
    out.push({
      date: s.stop.date,
      sub: s,
      kind: s.stop.kind === 'terminate' ? 'terminate' : 'end',
      delta: -contributionOn(state, { ...s, stop: undefined, status: s.trialEnd && s.trialEnd > s.stop.date ? 'trial' : 'active' }, s.stop.date),
      note: s.stop.reason,
    });
  else if (s.end && s.end < today) out.push({ date: addDays(s.end, 1), sub: s, kind: 'end', delta: -contributionOn(state, s, s.end) });
  if (s.status === 'paused' && s.pausedAt && s.pausedAt <= today)
    out.push({ date: s.pausedAt, sub: s, kind: 'pause', delta: -contributionOn(state, { ...s, status: 'active' }, s.pausedAt) });
  return out;
}

const label = (v: Subscription) =>
  t('core.event.label', {
    region: v.region ? t('core.event.region', { region: v.region }) : '',
    price: money(v.price, v.currency),
    per:
      v.cycle.unit === 'year'
        ? t('core.event.per.year')
        : v.cycle.unit === 'month'
          ? v.cycle.every === 1
            ? t('core.event.per.month')
            : t('core.event.per.months', { count: v.cycle.every })
          : t(`core.event.per.${v.cycle.unit}`),
  });

/** 变更日志：像 git log 一样记录每一次花钱决策；多阶段订阅会合并成「换区/换套餐」「断更」「续订」 */
export function events(state: AppState, today: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  // 代付是替别人做的决定，不进我的变更日志
  for (const s of state.subscriptions.filter((x) => !x.proxy)) {
    const vs = phaseSubs(s);
    if (vs.length === 1 && !s.phases?.length) {
      out.push(...eventsOf(state, s, today));
      continue;
    }
    vs.forEach((v, i) => {
      const evs = eventsOf(state, v, today);
      const prev = vs[i - 1];
      const next = vs[i + 1];
      const contiguous = (a: Subscription, b: Subscription) => !!a.end && a.end <= b.start && !isGap(a.end, b.start);
      // 前面还有没到期的段：新旧并行，旧段照常付到到期
      const until = coveredUntil(vs, i);
      const parallel = i > 0 && (!until || until > v.start);
      for (const e of evs) {
        if (e.kind === 'start' && prev && parallel) {
          // 新段整份计入；旧段到期时另记一笔结束
          out.push({ ...e, kind: 'switch', note: `${label(prev)} → ${label(v)}` });
          continue;
        }
        if (e.kind === 'start' && prev) {
          if (contiguous(prev, v)) {
            const before = contributionOn(state, prev, addDays(v.start, -1));
            out.push({ ...e, kind: 'switch', delta: e.delta - before, note: `${label(prev)} → ${label(v)}` });
          } else out.push({ ...e, kind: 'resume', note: label(v) });
          continue;
        }
        if (e.kind === 'end' && next && contiguous(v, next)) continue; // 并入下一阶段的 switch
        out.push(e);
      }
    });
  }
  for (const e of out) {
    const native = eventsOf({ ...state, settings: { ...state.settings, baseCurrency: e.sub.currency } }, e.sub, today).find(
      (x) => x.date === e.date && x.kind === e.kind,
    );
    e.partial = amountTotal(native?.delta ?? NaN, e.sub.currency, e.delta);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** 一笔扣款覆盖的服务期 [date, 下一笔扣款日)；没有下一笔时按一个周期（到期日更早则截到到期日） */
function coverage(c: Charge): [string, string] {
  const s = c.sub;
  if (s.cycle.unit === 'lifetime') return [c.date, addDays(c.date, 1)];
  if (s.chargeLeadDays || s.renewalHistory?.length) {
    const period = chargeServicePeriod(s, c.date, c.serviceDate);
    return [period.from, s.end && s.end < period.until ? addDays(s.end, 1) : period.until];
  }
  const horizon = addDays(c.date, Math.round(cycleDays(s.cycle) * 3) + 31);
  const next = chargesBetween(
    { ...s, stop: undefined, end: undefined, status: s.status === 'paused' ? 'active' : s.status },
    addDays(c.date, 1),
    horizon,
    '9999-12-31',
  ).find((charge) => !charge.kind)?.date;
  let end = next ?? nthCharge(c.date, s.cycle, 1);
  if (s.end && addDays(s.end, 1) < end) end = addDays(s.end, 1);
  return [c.date, end];
}

export interface CashAccrual {
  month: string;
  cash: number;
  accrual: number;
  partial: { cash: FxTotal; accrual: FxTotal };
  projected: boolean;
}

/**
 * 现金 vs 权责：现金按扣款日入账（年付会形成尖峰），
 * 权责把每笔扣款平摊到它覆盖的天数上，反映真实的每月成本。买断不计入权责。
 */
export function cashVsAccrual(state: AppState, today: string, back: number, fwd: number): CashAccrual[] {
  const first = addMonths(today.slice(0, 8) + '01', -back);
  const last = monthEnd(addMonths(today.slice(0, 8) + '01', fwd).slice(0, 7));
  const rows = new Map<string, CashAccrual>();
  for (let i = 0; i <= back + fwd; i++) {
    const m = addMonths(first, i).slice(0, 7);
    rows.set(m, { month: m, cash: 0, accrual: 0, partial: { cash: emptyTotal(), accrual: emptyTotal() }, projected: m > today.slice(0, 7) });
  }
  // 往前多取一年，保证年付在窗口开头的摊销完整
  const charges = state.subscriptions.filter((s) => !s.proxy).flatMap((s) => chargesBetween(s, addMonths(first, -24), last, today));
  for (const c of charges) {
    const v = chargeValue(state, c) * myShareFactor(c.sub, c.date);
    const r = rows.get(c.date.slice(0, 7));
    const part = scaleTotal(chargeTotal(state, c), myShareFactor(c.sub, c.date));
    if (r) {
      r.cash += v;
      r.partial.cash = sumTotals([r.partial.cash, part]);
    }
    if (c.sub.cycle.unit === 'lifetime') continue;
    const [a, b] = coverage(c);
    const days = Math.max(1, diffDays(a, b));
    const perDay = v / days;
    // 按月切分覆盖期
    let cur = a;
    while (cur < b) {
      const mEnd = addDays(monthEnd(cur.slice(0, 7)), 1);
      const segEnd = mEnd < b ? mEnd : b;
      const row = rows.get(cur.slice(0, 7));
      if (row) {
        row.accrual += perDay * diffDays(cur, segEnd);
        row.partial.accrual = sumTotals([row.partial.accrual, scaleTotal(part, diffDays(cur, segEnd) / days)]);
      }
      cur = segEnd;
    }
  }
  return [...rows.values()];
}

export interface StopLoss {
  sub: Subscription;
  /** 展开的历史阶段；phaseIndex 按开始日排序，从 0 起 */
  phase: Subscription;
  phaseIndex: number;
  kind: 'cancel' | 'terminate';
  date: string;
  paidThrough: string;
  reason?: string;
  currency: string;
  /** 金额均为我的份额；无 Base 后缀为阶段原币，Base 为停止日汇率折算 */
  paid: number;
  paidBase: number;
  refunded: number;
  refundedBase: number;
  loss: number;
  lossBase: number;
  /** 缺少可用汇率时保留原币明细，本位币数值为 NaN */
  fxMissing: boolean;
  refundStatus: 'none' | 'partial' | 'full';
  wastedDays: number;
}

/** Complete explicit stop history, including fully refunded stops and stops without unused service. */
export function stopHistory(state: AppState, today: string, range?: { from?: string; to?: string }) {
  const items: StopLoss[] = [];
  for (const sub of state.subscriptions) {
    if (sub.proxy) continue;
    phaseSubs(sub).forEach((phase, phaseIndex) => {
      if (!phase.stop || phase.stop.date > today || (range?.from && phase.stop.date < range.from) || (range?.to && phase.stop.date > range.to)) return;
      // 卖出时剩余服务已随转让收回，不算已付未用
      if (transferredStop(phase)) return;
      const summary = stopSummary(phase, today)!;
      const factor = myShareFactor(phase, summary.date);
      const loss = summary.unusedValue * factor;
      const rate = convertOn(1, phase.currency, state.settings.baseCurrency, summary.date, state.fxHistory, state.fx);
      const lossBase = loss === 0 ? 0 : loss * rate;
      const paid = summary.paid * factor;
      const refunded = summary.refunded * factor;
      items.push({
        sub,
        phase,
        phaseIndex,
        kind: summary.kind,
        date: summary.date,
        paidThrough: summary.paidThrough,
        reason: summary.kind === 'terminate' ? summary.reason : undefined,
        currency: phase.currency,
        paid,
        paidBase: paid * rate,
        refunded,
        refundedBase: refunded * rate,
        loss,
        lossBase,
        fxMissing: !Number.isFinite(lossBase),
        refundStatus: summary.refundStatus,
        wastedDays: summary.wastedDays,
      });
    });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || b.lossBase - a.lossBase);
  return items;
}

/** Positive, unrefunded unused value only. Existing report/overview callers keep this contract. */
export function stopLosses(state: AppState, today: string, range?: { from?: string; to?: string }) {
  const items = stopHistory(state, today, range).filter((i) => i.loss > 0 && !(i.lossBase <= 0.005));
  const byKind = { cancel: 0, terminate: 0 };
  for (const i of items) byKind[i.kind] += i.lossBase;
  return {
    partial: sumTotals(items.map((i) => amountTotal(i.loss, i.currency, i.lossBase))),
    total: items.reduce((sum, i) => sum + i.lossBase, 0),
    byKind,
    items,
    incomplete: items.some((i) => i.fxMissing),
  };
}

/** 预付余值：已经付了钱、但服务期还没用完的部分 */
export function prepaidValue(
  state: AppState,
  today: string,
): {
  total: number;
  unusedTotal: number;
  unusedIncomplete: boolean;
  partial: FxTotal;
  unusedItems: Array<{ sub: Subscription; value: number; until: string }>;
  items: Array<{ sub: Subscription; value: number; until: string; partial: FxTotal }>;
} {
  const items: Array<{ sub: Subscription; value: number; until: string; partial: FxTotal }> = [];
  const losses = stopLosses(state, today);
  const unusedItems = losses.items.map((i) => ({ sub: i.sub, value: i.lossBase, until: i.paidThrough }));
  for (const s of state.subscriptions) {
    // 按阶段各算各的：换区后旧区域预付的时长和新区域的一样都是余值
    let value = 0;
    let partial = emptyTotal();
    let until = '';
    for (const p of phaseSubs(s)) {
      if (p.stop && p.stop.date <= today) continue;
      if (p.cycle.unit === 'lifetime' || p.start > today) continue;
      const past = chargesBetween(p, addMonths(today, -12 * Math.max(1, p.cycle.unit === 'year' ? p.cycle.every : 1) - 1), today, today).filter((c) => !c.kind);
      const last = past[past.length - 1];
      if (!last) continue;
      const [a, b] = coverage(last);
      const end = p.end && addDays(p.end, 1) < b ? addDays(p.end, 1) : b;
      if (end <= today) continue;
      const factor = myShareFactor(p, today) * (diffDays(today, end) / Math.max(1, diffDays(a, b)));
      value += chargeValue(state, last) * factor;
      partial = sumTotals([partial, scaleTotal(chargeTotal(state, last), factor)]);
      if (end > until) until = end;
    }
    if (value > 0.01 || partial.incomplete) items.push({ sub: s, value, until, partial });
  }
  items.sort((x, y) => y.value - x.value);
  return {
    partial: sumTotals(items.map((i) => i.partial)),
    total: items.reduce((t, i) => t + i.value, 0),
    items,
    unusedTotal: losses.total,
    unusedIncomplete: losses.incomplete,
    unusedItems,
  };
}

/** 退订省下的钱：如果没退，从退订到今天还要付多少 */
export function cancelSavings(
  state: AppState,
  today: string,
): { total: number; partial: FxTotal; items: Array<{ sub: Subscription; saved: number; since: string; monthly: number; partial: FxTotal }> } {
  const items: Array<{ sub: Subscription; saved: number; since: string; monthly: number; partial: FxTotal }> = [];
  for (const s of state.subscriptions) {
    if (s.proxy || s.cycle.unit === 'lifetime' || !s.end || s.end > today) continue;
    const monthly = toBaseAt(state, (priceAt(s, s.end) * MONTH) / cycleDays(s.cycle), s.currency) * myShareFactor(s, s.end);
    const since = s.stop ? s.stop.paidThrough : s.end;
    const saved = (monthly * Math.max(0, diffDays(since, today))) / MONTH;
    const original = (((priceAt(s, s.end) * MONTH) / cycleDays(s.cycle)) * myShareFactor(s, s.end) * Math.max(0, diffDays(since, today))) / MONTH;
    const partial = amountTotal(original, s.currency, toBaseOrNaN(state, original, s.currency));
    if (saved > 0 || partial.incomplete) items.push({ sub: s, saved, since, monthly, partial });
  }
  items.sort((x, y) => y.saved - x.saved);
  return { total: items.reduce((t, i) => t + i.saved, 0), partial: sumTotals(items.map((i) => i.partial)), items };
}

// ---------- 礼品卡充值计划 ----------

const DENOMS: Record<string, number[]> = {
  TRY: [100, 250, 500, 1000],
  NGN: [5000, 10000, 25000, 50000],
  PHP: [100, 300, 500, 1000],
  USD: [10, 25, 50, 100],
  CNY: [50, 100, 200, 500],
  INR: [500, 1000, 2000],
  PKR: [1000, 2500, 5000],
  EGP: [100, 250, 500],
};

/** 用尽量少的卡凑够金额（贪心，最后一张向上取整） */
function pickCards(need: number, denoms: number[]): number[] {
  const ds = [...denoms].sort((a, b) => b - a);
  const cards: number[] = [];
  let left = need;
  for (const d of ds) {
    while (left >= d) {
      cards.push(d);
      left -= d;
    }
  }
  if (left > 0)
    cards.push(
      ds
        .slice()
        .reverse()
        .find((d) => d >= left) ?? ds[ds.length - 1],
    );
  return cards;
}

export interface TopUp {
  incomplete: boolean;
  partial: { current: FxTotal; monthly: FxTotal; due: FxTotal; need: FxTotal };
  method: PaymentMethod;
  current: number;
  /** 撑满 horizon 所需充值（账户币种） */
  need: number;
  /** 最晚充值日：余额首次不够的那天 */
  deadline?: string;
  /** 赶在 deadline 前至少要充多少，才够付那一笔 */
  minNeed: number;
  /** 这段时间一共要扣多少 */
  due: number;
  /** 礼品卡、话费这类只能按面额充的账户才给面额组合；银行卡、加密卡按需充值，不拆面额 */
  cards: number[];
  monthly: number;
}

export function topUpPlan(state: AppState, today: string, months = 6): TopUp[] {
  const out: TopUp[] = [];
  for (const m of state.methods) {
    const r = runwayFor(m, state, today, Math.max(12, months));
    if (!r || !r.forecast.length) continue;
    const horizon = addMonths(today, months);
    const due = r.forecast.filter((c) => c.date <= horizon).reduce((a, c) => a + c.amountInMethod, 0);
    const need = Math.max(0, due - r.current);
    // 最少补多少：累计到第一笔付不起的扣款为止
    let acc = 0;
    let minNeed = 0;
    for (const c of r.forecast) {
      acc += c.amountInMethod;
      if (acc > r.current) {
        minNeed = acc - r.current;
        break;
      }
    }
    const byCard = ['appstore', 'googleplay', 'giftcard', 'phone'].includes(m.kind);
    const denoms = DENOMS[m.currency] ?? [Math.pow(10, Math.max(1, Math.round(Math.log10(Math.max(10, need)))))];
    const duePartial = sumTotals(r.forecast.filter((c) => c.date <= horizon).map((c) => c.partial));
    const needPartial = sumTotals([duePartial, scaleTotal(r.partial.current, -1)]);
    out.push({
      incomplete: r.incomplete,
      partial: {
        current: r.partial.current,
        monthly: r.partial.monthlyDrain,
        due: duePartial,
        need: { ...needPartial, value: Math.max(0, needPartial.value), known: duePartial.known },
      },
      method: m,
      current: r.current,
      need,
      due,
      minNeed,
      deadline: r.shortfall?.date,
      cards: byCard && need > 0 ? pickCards(need, denoms) : [],
      monthly: r.monthlyDrain,
    });
  }
  return out.sort((a, b) => (a.deadline ?? '9').localeCompare(b.deadline ?? '9'));
}

// ---------- 体检 ----------

export interface Insight {
  id: string;
  tone: 'warn' | 'info' | 'good';
  title: string;
  body: string;
  subs?: Subscription[];
  /** 与这条提醒直接相关的支付方式（如余额不足的卡），界面上和订阅图标并排 */
  methods?: PaymentMethod[];
  href?: string;
}

/** 去掉地区、平台、序号等修饰，用来识别重复订阅 */
/** 一组同名订阅的共同名字，按词截断：「Claude Pro · 02」「Claude Pro · 03」→「Claude Pro」。没有共同部分时返回空串 */
export function sharedName(subs: Subscription[]): string {
  const all = subs.map((s) => s.name.trim());
  let head = all.reduce((a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  });
  const sep = /[\s·•|/:#_\-–—]/u;
  // 截在词中间（下一个字符不是分隔符）就退回到上一个分隔符
  if (all.some((n) => n.length > head.length && !sep.test(n[head.length]) && !sep.test(head.at(-1) ?? ' '))) {
    const cut = Math.max(...[...head].map((c, i) => (sep.test(c) ? i : -1)));
    head = cut >= 0 ? head.slice(0, cut) : '';
  }
  return head.replace(/[\s·•|/:#_\-–—]+$/u, '').trim();
}

function baseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\b(mac|ios|ipad|pro|plus|premium|main|主号|小号)\b/g, '')
    .replace(/主号|小号|\d+(\.\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 货币中文名，取不到时用代码 */
function ccyLabel(c: string): string {
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'currency' }).of(c) ?? c;
  } catch {
    return c;
  }
}

export function insights(state: AppState, today: string): Insight[] {
  const out: Insight[] = [];
  const unused = stopLosses(state, today);
  if (unused.items.length)
    out.push({
      id: 'unused',
      tone: 'warn',
      title: t('core.stop.lossTitle'),
      body: formatTotal(unused.partial, state.settings.baseCurrency),
      subs: [...new Map(unused.items.map((i) => [i.sub.id, i.sub])).values()],
    });
  const base = state.settings.baseCurrency;
  // 代付是别人的订阅，不参与体检
  const live = state.subscriptions.filter((s) => !s.proxy && ['active', 'ending', 'trial'].includes(effectiveStatus(s, today)));
  const names = (ss: Subscription[]) => ss.map((s) => s.name).join(t('core.listSep'));

  // 1. 年付续费窗口：60 天内要自动续费的长周期订阅
  const yearly = live
    .filter((s) => cycleDays(s.cycle) >= 180 && effectiveStatus(s, today) === 'active')
    .map((s) => ({ s, n: nextCharge(s, today) }))
    .filter((x) => x.n && diffDays(today, x.n) <= 60)
    .sort((a, b) => a.n!.localeCompare(b.n!));
  if (yearly.length) {
    const sum = sumTotals(yearly.map((x) => convertedTotal(state, priceAt(x.s, x.n!), x.s.currency)));
    out.push({
      id: 'yearly-window',
      tone: 'warn',
      title: t('core.insight.yearly.title', { count: yearly.length }),
      body: t('core.insight.yearly.body', { sum: formatTotal(sum, base, { compact: true }) }),
      subs: yearly.map((x) => x.s),
    });
  }

  // 2. 疑似重复：同名、同币种、价格相近、同一账号才算。合租的车各收各的钱，Plus / Pro 这种不同档位、
  // 填了不同账号的多开也是有意为之，都不提示；没填账号的同名订阅仍视为可能重复
  const groups = new Map<string, Subscription[]>();
  for (const s of live) {
    if (s.share) continue;
    const k = `${baseName(s.name)}|${s.currency}|${Math.round(Math.log(Math.max(1, s.price)) * 4)}|${(s.account ?? '').trim().toLowerCase()}`;
    if (k.split('|')[0].length < 2) continue;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    const sum = sumTotals(g.map((s) => contributionTotal(state, s, today)));
    out.push({
      id: `dup-${g[0].id}`,
      tone: 'info',
      title: t('core.insight.dup.title', { names: sharedName(g) || names(g) }),
      body: t('core.insight.dup.body', { count: g.length, sum: formatTotal(sum, base, { compact: true }) }),
      subs: g,
    });
  }

  // 3. 过去一年涨过价
  const yearAgo = addMonths(today, -12);
  const hikes = live.filter((s) => {
    const h = (s.priceHistory ?? []).filter((p) => p.from > yearAgo && p.from <= today);
    return h.length && (s.priceHistory ?? []).length > 1 && priceAt(s, today) > priceAt(s, addDays(h[0].from, -1));
  });
  if (hikes.length) out.push({ id: 'hikes', tone: 'warn', title: t('core.insight.hikes.title', { count: hikes.length }), body: names(hikes), subs: hikes });

  // 4. 首期优惠即将结束
  const introEnding = live.filter((s) => s.intro && s.intro.until > today && diffDays(today, s.intro.until) <= 30);
  for (const s of introEnding) {
    out.push({
      id: `intro-${s.id}`,
      tone: 'warn',
      title: t('core.insight.intro.title', { name: s.name, count: diffDays(today, s.intro!.until) }),
      body: t('core.insight.intro.body', { from: money(s.intro!.price, s.currency), to: money(s.price, s.currency) }),
      subs: [s],
    });
  }

  // 5. 余额 30 天内不够
  for (const m of state.methods) {
    const r = runwayFor(m, state, today);
    if (r?.shortfall && diffDays(today, r.shortfall.date) <= (m.lowRunwayDays ?? 30)) {
      out.push({
        id: `bal-${m.id}`,
        tone: 'warn',
        title: t('core.insight.balance.title', { name: m.name, date: cnDate(r.shortfall.date) }),
        body: t('core.insight.balance.body', {
          sub: r.shortfall.sub.name,
          need: money(r.shortfall.amount, r.shortfall.currency),
          current: money(r.current, m.currency),
        }),
        methods: [m],
        subs: [r.shortfall.sub],
        href: '/wallet',
      });
    }
  }

  // 6. 汇率敞口
  const byCcy = new Map<string, number>();
  let total = 0;
  for (const s of live) {
    const v = contributionOn(state, s, today);
    total += v;
    byCcy.set(s.currency, (byCcy.get(s.currency) ?? 0) + v);
  }
  const foreign = [...byCcy.entries()].filter(([c]) => c !== base).sort((a, b) => b[1] - a[1]);
  if (total > 0 && foreign.length) {
    const share = foreign.reduce((a, [, v]) => a + v, 0) / total;
    out.push({
      id: 'fx',
      tone: 'info',
      title: t('core.insight.fx.title', { pct: Math.round(share * 100) }),
      body: t('core.insight.fx.body', { ccy: ccyLabel(foreign[0][0]), share: Math.round((foreign[0][1] / total) * 100) }),
    });
  }

  // 7. 未指定支付方式
  const noMethod = live.filter((s) => !s.methodId);
  if (noMethod.length)
    out.push({
      id: 'nomethod',
      tone: 'info',
      title: t('core.insight.noMethod.title', { count: noMethod.length }),
      body: t('core.insight.noMethod.body'),
      subs: noMethod,
    });

  // 8. 最贵的一天
  const perDay = live.map((s) => ({ s, v: contributionOn(state, s, today) / MONTH })).sort((a, b) => b.v - a.v)[0];
  if (perDay && perDay.v > 0 && Number.isFinite(total)) {
    out.push({
      id: 'top',
      tone: 'good',
      title: t('core.insight.top.title', { name: perDay.s.name }),
      body: t('core.insight.top.body', { perDay: money(perDay.v, base), pct: total > 0 ? Math.round(((perDay.v * MONTH) / total) * 100) : 0 }),
      subs: [perDay.s],
    });
  }
  return out;
}

// ---------- 年度回顾 ----------

export interface YearReview {
  partial: { total: FxTotal; perDay: FxTotal; stopLoss: FxTotal; bySub: Record<string, FxTotal>; byMonth: Record<string, FxTotal> };
  /** 'YYYY'，或 'all'：从最早的订阅到今天 */
  year: string;
  /** 当年停止的阶段截至 today 仍未退回的损失（我的份额、本位币） */
  stopLoss: number;
  /** 当年扣款（含退款负数、我的份额、不含代付）加转让现金，本位币 */
  total: number;
  /** 当年服务扣款笔数，不含退款与失败 */
  charges: number;
  top: Array<{ sub: Subscription; sum: number }>;
  /** 这一年每个订阅花了多少，从多到少 */
  items: Array<{ sub: Subscription; sum: number }>;
  longest?: { sub: Subscription; days: number };
  /** 当年开始、当年结束的订阅：不含代付 */
  newSubs: Subscription[];
  ended: Subscription[];
  currencies: number;
  busiestMonth?: { month: string; sum: number };
  perDay: number;
}

export function yearReview(state: AppState, today: string, year = today.slice(0, 4)): YearReview {
  // 'all'：从最早的订阅开始到今天
  const all = year === 'all';
  const from = all ? state.subscriptions.filter((s) => !s.proxy).reduce((m, s) => (s.start < m ? s.start : m), today) : `${year}-01-01`;
  const to = all || `${year}-12-31` >= today ? today : `${year}-12-31`;
  const cs = state.subscriptions
    .filter((s) => !s.proxy)
    .flatMap((s) => chargesBetween(s, from, to, today))
    .filter((c) => c.kind !== 'failed');
  const bySub = new Map<string, { sub: Subscription; sum: number }>();
  const byMonth = new Map<string, number>();
  const ccys = new Set<string>();
  let total = 0;
  const partial = {
    total: emptyTotal(),
    perDay: emptyTotal(),
    stopLoss: stopLosses(state, today, { from, to }).partial,
    bySub: {} as Record<string, FxTotal>,
    byMonth: {} as Record<string, FxTotal>,
  };
  const note = (sub: Subscription, date: string, part: FxTotal) => {
    partial.total = sumTotals([partial.total, part]);
    partial.bySub[sub.id] = sumTotals([partial.bySub[sub.id] ?? emptyTotal(), part]);
    const month = date.slice(0, 7);
    partial.byMonth[month] = sumTotals([partial.byMonth[month] ?? emptyTotal(), part]);
  };
  for (const c of cs) {
    note(c.sub, c.date, scaleTotal(chargeTotal(state, c), myShareFactor(c.sub, c.date)));
    const v = chargeBaseOrNaN(state, c) * myShareFactor(c.sub, c.date);
    total += v;
    ccys.add(c.currency);
    const r = bySub.get(c.sub.id) ?? { sub: c.sub, sum: 0 };
    r.sum += v;
    bySub.set(c.sub.id, r);
    byMonth.set(c.date.slice(0, 7), (byMonth.get(c.date.slice(0, 7)) ?? 0) + v);
  }
  // 转让是现金流：买入加、卖出减，计入总额与各月，但不算扣款笔数和币种
  for (const r of transferRows(state, from, to, today)) {
    note(r.sub, r.date, amountTotal(r.transfer.amount * (r.transfer.kind === 'buy' ? 1 : -1), r.transfer.currency, r.amount));
    total += r.amount;
    const e = bySub.get(r.sub.id) ?? { sub: r.sub, sum: 0 };
    e.sum += r.amount;
    bySub.set(r.sub.id, e);
    byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.amount);
  }
  const live = state.subscriptions.filter((s) => !s.proxy && s.cycle.unit !== 'lifetime' && ['active', 'ending', 'paused'].includes(effectiveStatus(s, today)));
  const longest = live.map((s) => ({ sub: s, days: diffDays(s.start, today) })).sort((a, b) => b.days - a.days)[0];
  const busiest = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  partial.perDay = scaleTotal(partial.total, 1 / Math.max(1, diffDays(from, to) + 1));
  return {
    partial,
    year,
    stopLoss: stopLosses(state, today, { from, to }).total,
    total,
    charges: cs.filter((c) => c.kind !== 'refund' && c.kind !== 'failed').length,
    top: [...bySub.values()].sort((a, b) => b.sum - a.sum).slice(0, 5),
    items: [...bySub.values()].sort((a, b) => b.sum - a.sum),
    longest,
    newSubs: state.subscriptions.filter((s) => !s.proxy && (all || s.start.startsWith(year))),
    ended: state.subscriptions.filter((s) => !s.proxy && s.end && (all || s.end.startsWith(year)) && s.end < today),
    currencies: ccys.size,
    busiestMonth: busiest && { month: busiest[0], sum: busiest[1] },
    perDay: total / Math.max(1, diffDays(from, to) + 1),
  };
}

/**
 * 一个订阅今年（自然年）的总成本，折成本位币：今年已扣的按实扣，剩下的按预计，算到 12 月 31 日；失败的扣款不算。
 * 合租、代付列表的套餐价格小字与合租的当年盈亏共用这一个数
 */
export function yearCost(state: AppState, s: Subscription, today: string, y = today.slice(0, 4)): number {
  // 缺汇率的扣款让合计为 NaN（显示为不可用），不当成 0
  return chargesBetween(s, `${y}-01-01`, `${y}-12-31`, today)
    .filter((c) => c.kind !== 'failed')
    .reduce((a, c) => a + chargeBaseOrNaN(state, c), 0);
}

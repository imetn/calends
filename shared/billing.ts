import { amountTotal, convertedTotal, chargeTotal, scaleTotal, sumTotals, type FxTotal } from './fx-total.ts';
import {
  LIFETIME_BILL_MONTHS,
  validBillMonths,
  type AppState,
  type Cycle,
  type FxTable,
  type PaymentMethod,
  type Subscription,
  type Payment,
  type ShareMember,
  type RenewalRule,
  type Receipt,
  type Waiver,
  type Settings,
} from './types.ts';
import { dateFormat } from './intl.ts';
import { t } from './i18n.ts';
import { chargeBaseOrNaN, convertOn } from './fx.ts';
import { isSettled, settle, type Period } from './receivables.ts';
import { transferError } from './transfers.ts';
import { meterError } from './meters.ts';

// ---------- 日期：全部按 UTC 日计算 ----------

const DAY = 86_400_000;

/** 平均每月天数（365.25 / 12）：周期折月、月成本折算共用 */
export const DAYS_PER_MONTH = 30.4375;

/** 三位大写币种代码 */
export const CURRENCY_CODE = /^[A-Z]{3}$/;

export function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  return fmtDay(parseDay(s) + n * DAY);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY);
}

/** 按月加，保留原始日号并在短月夹紧到月底（1/31 → 2/28 → 3/31） */
/** 两个日期之间相隔几年几个月几天：先数整月（月底按 addMonths 对齐），剩下的算天 */
export function calendarSpan(from: string, to: string): { years: number; months: number; days: number } {
  let months = 0;
  while (addMonths(from, months + 1) <= to) months++;
  return { years: Math.floor(months / 12), months: months % 12, days: Math.max(0, diffDays(addMonths(from, months), to)) };
}

export function addMonths(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fmtDay(Date.UTC(ny, nm, Math.min(d, last)));
}

export function todayIn(tz: string, now = Date.now()): string {
  try {
    return dateFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return fmtDay(now);
  }
}

/** 第 k 次扣款日（k=0 即 start） */
export function nthCharge(start: string, cycle: Cycle, k: number): string {
  const n = cycle.every * k;
  switch (cycle.unit) {
    case 'day':
      return addDays(start, n);
    case 'week':
      return addDays(start, n * 7);
    case 'month':
      return addMonths(start, n);
    case 'year':
      return addMonths(start, n * 12);
    default:
      return start;
  }
}

export function cycleDays(c: Cycle): number {
  switch (c.unit) {
    case 'day':
      return c.every;
    case 'week':
      return c.every * 7;
    case 'month':
      return c.every * DAYS_PER_MONTH;
    case 'year':
      return c.every * 365.25;
    default:
      return Infinity;
  }
}

export function cycleLabel(c: Cycle): string {
  if (c.unit === 'lifetime') return t('core.cycle.lifetime');
  if (c.every === 1) return t(`core.cycle.every.${c.unit}`);
  if (c.unit === 'month' && c.every === 3) return t('core.cycle.quarterly');
  if (c.unit === 'month' && c.every === 6) return t('core.cycle.halfYearly');
  if (c.unit === 'year' && c.every === 2) return t('core.cycle.biennial');
  return t(`core.cycle.everyN.${c.unit}`, { count: c.every });
}

/** 金额后缀用的「每…」：/月、/季、/年、/买断 */
export function perLabel(s: Pick<Subscription, 'cycle'>): string {
  const { unit, every } = s.cycle;
  if (unit === 'lifetime') return t('report.per.lifetime');
  if (every === 1) return t(`report.per.${unit}`);
  if (unit === 'month' && every === 3) return t('report.per.quarter');
  if (unit === 'month' && every === 6) return t('report.per.halfYear');
  if (unit === 'year' && every === 2) return t('report.per.twoYears');
  return t(`report.per.n.${unit}`, { count: every });
}

export function cycleShort(c: Cycle): string {
  if (c.unit === 'lifetime') return t('core.cycle.once');
  const u = { day: 'd', week: 'w', month: 'mo', year: 'yr' }[c.unit];
  return c.every === 1 ? u : `${c.every}${u}`;
}

/** 收款、免收记录的结构：日期有效、至少抵扣一期、金额非负、币种为三位代码 */
function receivableError(r: { receipts?: unknown; waivers?: unknown }): string | undefined {
  const list = (v: unknown) => v == null || Array.isArray(v);
  if (!list(r.receipts) || !list(r.waivers)) return t('mcp.error.invalidInput', { field: 'receipts' });
  const bad = (x: { id?: unknown; date?: unknown; periods?: unknown }) =>
    typeof x?.id !== 'string' || !validDay(String(x.date)) || !Array.isArray(x.periods) || !x.periods.length || !x.periods.every((k) => validDay(String(k)));
  for (const x of (r.receipts as Receipt[] | undefined) ?? [])
    if (bad(x) || !Number.isFinite(x.amount) || x.amount < 0 || !CURRENCY_CODE.test(x.currency)) return t('mcp.error.invalidInput', { field: 'receipts' });
  for (const x of (r.waivers as Waiver[] | undefined) ?? []) if (bad(x)) return t('mcp.error.invalidInput', { field: 'waivers' });
}

/** 订阅基本字段的校验：有问题时返回错误文案（后台接口与 MCP 共用） */
export function subError(s: Subscription): string | undefined {
  if (!s.name?.trim()) return t('core.subError.name');
  if (!Number.isFinite(s.price) || s.price < 0) return t('core.subError.price');
  if (!validDay(s.start) || (s.share?.collectFrom && !validDay(s.share.collectFrom))) return t('core.subError.start');
  const transfer = transferError(s) ?? meterError(s);
  if (transfer) return transfer;
  for (const m of s.share?.members ?? []) {
    if (
      m.feeHistory != null &&
      (!Array.isArray(m.feeHistory) ||
        m.feeHistory.some(
          (p) =>
            !p ||
            !validDay(p.from) ||
            !Number.isFinite(p.fee) ||
            p.fee < 0 ||
            !CURRENCY_CODE.test(p.currency) ||
            // 买断合租沿用内部周期 LIFETIME_BILL_MONTHS，改规则时会写进历史
            !(validBillMonths(p.billEvery) || p.billEvery === LIFETIME_BILL_MONTHS) ||
            (p.share != null && (!Number.isFinite(p.share) || p.share < 0)),
        ))
    )
      return t('core.subError.price');
    if (m.leaveRefund != null) {
      const r = m.leaveRefund;
      if (!Number.isFinite(r.amount) || r.amount <= 0 || !CURRENCY_CODE.test(r.currency)) return t('core.subError.refundAmount');
      if (!m.left || !validDay(m.left) || !validDay(r.date) || r.date < memberSince(s, m)) return t('core.subError.refundDate');
      if (r.note != null && typeof r.note !== 'string') return t('mcp.error.invalidInput', { field: 'leave_refund.note' });
    }
    if (m.firstPeriod != null && !['prorate', 'full', 'free'].includes(m.firstPeriod)) return t('mcp.error.invalidFirstPeriod');
    if (m.firstAmount != null && (!Number.isFinite(m.firstAmount) || m.firstAmount < 0)) return t('core.subError.price');
    if (m.periodDues != null && (!Array.isArray(m.periodDues) || !m.periodDues.every((d) => validDay(d.from) && Number.isFinite(d.amount) && d.amount >= 0)))
      return t('mcp.error.invalidInput', { field: 'periodDues' });
    const records = receivableError(m);
    if (records) return records;
    if (m.restarts != null && (!Array.isArray(m.restarts) || !m.restarts.every(validDay))) return t('mcp.error.invalidInput', { field: 'restarts' });
  }
  if (s.proxy) {
    const records = receivableError(s.proxy);
    if (records) return records;
    if (
      s.proxy.charged != null &&
      (!Array.isArray(s.proxy.charged) ||
        s.proxy.charged.some(
          (c) =>
            !validDay(c.charge) ||
            (c.amount != null && (!Number.isFinite(c.amount) || c.amount < 0)) ||
            (c.currency != null && !CURRENCY_CODE.test(c.currency)),
        ))
    )
      return t('mcp.error.invalidInput', { field: 'charged' });
  }
  if (!s.cycle || !['day', 'week', 'month', 'year', 'lifetime'].includes(s.cycle.unit) || !Number.isInteger(s.cycle.every) || !(s.cycle.every >= 1))
    return t('core.subError.cycle');
  if (s.billing != null && s.billing !== 'postpaid') return t('mcp.error.invalidInput', { field: 'billing' });
  if (s.settlement != null && s.settlement !== 'separate') return t('mcp.error.invalidInput', { field: 'settlement' });
  for (const v of phaseSubs(s)) {
    if (v.billing != null && v.billing !== 'postpaid') return t('mcp.error.invalidInput', { field: 'billing' });
    if (v.estimateFrom && !validDay(v.estimateFrom)) return t('core.subError.start');
    if (v.billingStart && !validDay(v.billingStart)) return t('core.subError.start');
    if ([v.chargeLeadDays, v.cancelLeadDays, v.renewalOffsetDays].some((n) => n != null && (!Number.isInteger(n) || n < 0 || n > 3660)))
      return t('core.renewal.invalid');
    if (
      v.renewalHistory?.some(
        (r, i, all) =>
          !validDay(r.from) ||
          (i > 0 && r.from <= all[i - 1].from) ||
          [r.chargeLeadDays, r.cancelLeadDays].some((n) => !Number.isInteger(n) || n < 0 || n > 3660),
      )
    )
      return t('core.renewal.invalid');
    const error = stopError(v) ?? paymentError(v);
    if (error) return error;
  }
  return undefined;
}

/**
 * 订阅与各阶段的字段格式问题：开始日、价格、币种、周期、结束日、下次扣款日、试用结束、暂停日、首期优惠、赠送期、标签与扣款币种。
 * 每项带上「字段 + 取值」作键，newShapeError 据此只拦本次新写入的问题。
 */
function shapeIssues(s: Subscription): Array<[key: string, error: string]> {
  const out: Array<[string, string]> = [];
  const add = (field: string, value: unknown, error: string) => out.push([`${field}:${JSON.stringify(value) ?? 'undefined'}`, error]);
  const isDay = (v: unknown): v is string => typeof v === 'string' && validDay(v);
  const day = (field: string, v: unknown) => {
    if (v != null && !isDay(v)) add(field, v, t('mcp.error.notDate', { what: field }));
  };
  day('trialEnd', s.trialEnd);
  day('pausedAt', s.pausedAt);
  if (s.pauses != null && !(Array.isArray(s.pauses) && s.pauses.every((p) => p && isDay(p.from) && isDay(p.to) && p.from < p.to)))
    add('pauses', s.pauses, t('mcp.error.invalidInput', { field: 'pauses' }));
  if (!Array.isArray(s.tags) || s.tags.some((x) => typeof x !== 'string')) add('tags', s.tags, t('mcp.error.invalidInput', { field: 'tags' }));
  if (s.settlement != null && s.settlement !== 'separate') add('settlement', s.settlement, t('mcp.error.invalidInput', { field: 'settlement' }));
  for (const p of [s, ...(Array.isArray(s.phases) ? s.phases : [])]) {
    if (!p || typeof p !== 'object') {
      add('phase', p, t('mcp.error.invalidInput', { field: 'phases' }));
      continue;
    }
    if (!isDay(p.start)) add('start', p.start, t('core.subError.start'));
    if (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0) add('price', p.price, t('core.subError.price'));
    if (typeof p.currency !== 'string' || !CURRENCY_CODE.test(p.currency))
      add('currency', p.currency, t('mcp.error.unsupportedCurrency', { code: String(p.currency) }));
    const c = p.cycle;
    if (!c || !['day', 'week', 'month', 'year', 'lifetime'].includes(c.unit) || !Number.isInteger(c.every) || !(c.every >= 1))
      add('cycle', c, t('core.subError.cycle'));
    if (p.billing != null && p.billing !== 'postpaid') add('billing', p.billing, t('mcp.error.invalidInput', { field: 'billing' }));
    day('end', p.end);
    if (isDay(p.end) && isDay(p.start) && p.end < p.start) add('end', [p.start, p.end], t('core.phase.endTooEarly'));
    day('nextDue', p.nextDue);
    if (p.intro != null) {
      day('intro.until', p.intro.until ?? null);
      if (typeof p.intro.price !== 'number' || !Number.isFinite(p.intro.price) || p.intro.price < 0)
        add('intro.price', p.intro.price, t('core.subError.price'));
    }
    if (p.bonus != null) {
      day('bonus.from', p.bonus.from ?? null);
      day('bonus.until', p.bonus.until ?? null);
    }
    // 扣款金额始终按所属方案的币种计；另写的币种会被忽略，卡上实扣的币种用 settled
    for (const pay of Array.isArray(p.payments) ? p.payments : [])
      if (pay?.currency != null && pay.currency !== p.currency)
        add('payment.currency', [pay.date, pay.currency, p.currency], t('core.subError.paymentCurrency'));
  }
  // 结束日含当天：等于下一段开始日会让两段在那天各扣一次，多半是把「到期日」当成了结束日；真要并行至少多出一天（switchPlan 的 keepUntil 同理）
  const phases = (Array.isArray(s.phases) ? s.phases : []).filter((p) => p && isDay(p.start));
  const starts = new Set(phases.map((p) => p.start));
  for (const p of phases) if (p.end && p.end > p.start && starts.has(p.end)) add('end', [p.start, p.end], t('core.phase.endOnNextStart'));
  return out;
}

/**
 * 整条写入的格式校验：只拦本次新引入的问题，previous 里原有的同一问题放行（与 subRefsError 的引用校验同一做法），
 * 已存的旧记录仍可编辑保存。导入、恢复备份不经过这里。
 */
export function newShapeError(previous: Subscription | undefined, next: Subscription): string | undefined {
  const known = new Set(previous ? shapeIssues(previous).map(([key]) => key) : []);
  return shapeIssues(next).find(([key]) => !known.has(key))?.[1];
}

// ---------- 阶段（换区 / 换套餐 / 断更续订） ----------

/** 暂停从哪天起生效。暂停中停用时记在 stop.pausedAt：暂停期间没发生的扣款不因停用而复活，后面续订也不影响这段 */
export function pausedFromOf(s: Pick<Subscription, 'status' | 'pausedAt' | 'stop'>): string | undefined {
  return s.status === 'paused' ? s.pausedAt : s.stop?.pausedAt;
}

/** 暂停默认从今天起；订阅还没开始时从开始日起 */
export const pauseDay = (s: Pick<Subscription, 'start'>, today: string): string => (today < s.start ? s.start : today);

/** day 是否落在已结束的暂停里：这段时间没发生的扣款，恢复后不再推算 */
function pausedOn(s: Pick<Subscription, 'pauses'>, day: string): boolean {
  return !!s.pauses?.some((p) => p.from <= day && day < p.to);
}

/** 已停用但日期未知：只有 cancelled / terminated 状态，没有 end 与 stop；之后不再预测，也不把任何一天当停用日 */
export const undatedStop = (s: Pick<Subscription, 'status' | 'end'>): boolean => (s.status === 'cancelled' || s.status === 'terminated') && !s.end;

/**
 * 把多阶段订阅展开成若干个单阶段的「虚拟订阅」，id 不变；无阶段时返回自身。
 * 阶段缺省在下一阶段开始前一天结束；显式的 end 可以晚于下一阶段的开始日（换区后旧区域预付到期前仍在跑），两段在时间上并行。
 */
export function phaseSubs(s: Subscription): Subscription[] {
  if (!s.phases?.length) return [s];
  const sorted = s.phases.slice().sort((a, b) => a.start.localeCompare(b.start));
  // 订阅整体的结束日、暂停日对所有阶段生效：之后才开始的计划阶段作废，跨过它的阶段（包括并行中的旧阶段）在那天截止
  const pausedAt = pausedFromOf(s);
  const stop = [s.end, pausedAt].filter(Boolean).sort()[0];
  // 暂停后才开始的阶段作废，但记过实付的留着，账不能丢
  const kept = stop ? sorted.filter((p, i) => i === 0 || p.start <= stop || (pausedAt && p.payments?.length)) : sorted;
  const lastStart = kept[kept.length - 1].start;
  return kept.map((p, i) => {
    const last = i === kept.length - 1;
    const natural = p.end ?? (last ? undefined : addDays(kept[i + 1].start, -1));
    // 并行中的旧阶段跑过了暂停日：同样在暂停日停下
    const paused = !last && (s.status === 'paused' || !!pausedAt) && !!natural && natural > lastStart && (!pausedAt || natural > pausedAt);
    // 已退订但没写结束日：与最后一段并行的旧阶段也一并视为退订
    const cancelled = !last && undatedStop(s) && !!natural && natural > lastStart;
    return {
      ...s,
      phases: undefined,
      expires: undefined,
      stop: p.stop ?? (last ? s.stop : undefined),
      start: p.start,
      billingStart: p.billingStart,
      chargeLeadDays: p.chargeLeadDays,
      cancelLeadDays: p.cancelLeadDays,
      renewalHistory: p.renewalHistory,
      renewalOffsetDays: p.renewalOffsetDays,
      end: s.end && (!natural || natural > s.end) ? s.end : natural,
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
      planned: p.planned,
      trialEnd: i === 0 ? s.trialEnd : undefined,
      status: last ? s.status : paused ? 'paused' : cancelled ? 'cancelled' : 'active',
      pausedAt: last ? s.pausedAt : paused ? pausedAt : undefined,
    };
  });
}

/** 两段之间空了几天以内不算断更（续费晚一两天、时区差之类） */
export function isGap(prevEnd: string | undefined, nextStart: string): boolean {
  return !!prevEnd && diffDays(prevEnd, nextStart) > 4;
}

/** 把阶段排进并行轨道：与前面仍在跑的段重叠时放到下一条轨道，返回每段的轨道号（0 起）；没有结束日的段视为一直延续 */
export function phaseLanes(vs: Array<{ start: string; end?: string }>): number[] {
  const laneEnd: string[] = [];
  return vs.map((v) => {
    // 同一天交接（旧段结束日 = 新段开始日）是换套餐，不是并行：接在刚结束的那一行，而不是最早空出来的行
    let l = -1;
    laneEnd.forEach((e, i) => {
      if (e <= v.start && (l < 0 || e > laneEnd[l])) l = i;
    });
    if (l < 0) l = laneEnd.length;
    laneEnd[l] = v.end ?? '9999-12-31';
    return l;
  });
}

/** 第 i 段开始前，前面各段最晚跑到哪天；有一直延续的段时返回 undefined。断更看它：并行的旧段还没到期就不算断 */
export function coveredUntil(vs: Array<{ start: string; end?: string }>, i: number): string | undefined {
  let m = '';
  for (const v of vs.slice(0, i)) {
    if (!v.end) return undefined;
    if (v.end > m) m = v.end;
  }
  return m || undefined;
}

/** 实际在订的天数（并行的阶段不重复计，截到 today），以及中间没有任何阶段在跑的断更空档 */
export function servedTime(s: Subscription, today: string): { days: number; gaps: Array<{ from: string; to: string; days: number }> } {
  const vs = phaseSubs(s);
  let days = 0;
  let cursor = '';
  const gaps: Array<{ from: string; to: string; days: number }> = [];
  vs.forEach((v, i) => {
    const until = i > 0 ? coveredUntil(vs, i) : undefined;
    const gapStart = until ? addDays(until, 1) : undefined;
    if (gapStart && gapStart < v.start) gaps.push({ from: gapStart, to: v.start, days: diffDays(gapStart, v.start) });
    if (v.start > today) return;
    const a = cursor > v.start ? cursor : v.start;
    const b = v.end && v.end < today ? addDays(v.end, 1) : today;
    if (b > a) {
      days += diffDays(a, b);
      cursor = b;
    }
  });
  return { days, gaps };
}

/**
 * 已付款覆盖的在订天数：预付费的扣款买的是之后一期，均摊时分母要算到已付那期结束，
 * 不然扣款当天会把整期费用摊进已过去的日子（订满 1 个月、付了 2 期，算成每月 2 期）。后付费、买断不受影响
 */
export function paidServedDays(s: Subscription, charges: Array<Pick<Charge, 'sub' | 'date' | 'serviceDate' | 'kind' | 'projected'>>, today: string): number {
  let through = today;
  for (const c of charges) {
    if (c.kind || c.projected || c.date > today || isPostpaid(c.sub) || c.sub.cycle.unit === 'lifetime') continue;
    let until = chargeServicePeriod(c.sub, c.date, c.serviceDate).until;
    // 阶段提前结束：覆盖期截到阶段末，不把之后另一段的日子算进这笔钱
    if (c.sub.end && until > addDays(c.sub.end, 1)) until = addDays(c.sub.end, 1);
    if (until > through) through = until;
  }
  return servedTime(s, through).days;
}

/** day 当天同时在跑的所有阶段，按开始日排列（换区后旧区域还没到期时会有多个）；无阶段的订阅总是返回自身 */
export function activePhases(s: Subscription, day: string): Subscription[] {
  if (!s.phases?.length) return [s];
  return phaseSubs(s).filter((v) => v.start <= day && (!v.end || v.end >= day));
}

/** day 当天所处的阶段：并行时取最晚开始的那段；处在断更空档或尚未开始时返回 undefined（无阶段的订阅总是返回自身） */
export function phaseAt(s: Subscription, day: string): Subscription | undefined {
  return activePhases(s, day).pop();
}

/** 当前生效的阶段（并行时取最晚开始的那段）；没有生效的取最近的一个 */
export function currentPhase(s: Subscription, day: string): Subscription {
  const vs = phaseSubs(s);
  return phaseAt(s, day) ?? vs.filter((v) => v.start <= day).pop() ?? vs[0];
}

// ---------- 订阅状态 ----------

/** 订阅在 day 当天是否仍处于计费关系中（不考虑暂停） */
function isLive(s: Subscription, day: string): boolean {
  if (undatedStop(s)) return false;
  if (s.end && s.end < day) return false;
  return true;
}

/**
 * 待生效的变更：今天之后才开始的第一个阶段（换区、换支付方式、断更后约好的续订）；
 * 没有阶段的订阅若开始日在未来，返回自身（未来某天才开始订阅、前面有免费期等）
 */
export function upcomingPhase(s: Subscription, today: string): Subscription | undefined {
  if (!s.phases?.length) return s.start > today ? s : undefined;
  return phaseSubs(s).find((v) => v.start > today);
}

export function effectiveStatus(s: Subscription, today: string): 'upcoming' | 'active' | 'trial' | 'paused' | 'ending' | 'ended' | 'terminated' | 'lifetime' {
  if (s.phases?.length) {
    const vs = phaseSubs(s);
    const v = phaseAt(s, today);
    if (v) {
      const st = effectiveStatus(v, today);
      // 已经排好下一阶段（换区 / 换套餐 / 换支付方式，中间空几天也算），不算到期不续
      const next = vs[vs.findIndex((x) => x.start === v.start) + 1];
      return st === 'ending' && next ? 'active' : st;
    }
    if (vs.some((x) => x.start > today)) return vs[0].start > today ? 'upcoming' : 'paused'; // 尚未开始，或断更中已安排续订
    return effectiveStatus(vs[vs.length - 1], today);
  }
  if (s.start > today) return 'upcoming';
  if (s.stop && s.stop.date <= today) return s.stop.kind === 'terminate' ? 'terminated' : 'ended';
  if (s.status === 'terminated' && !s.stop) return 'terminated';
  if (s.cycle.unit === 'lifetime') return 'lifetime';
  // 暂停日还没到：这之前照常计费，状态也照常
  if (s.status === 'paused' && (!s.pausedAt || s.pausedAt <= today)) return 'paused';
  if (!isLive(s, today)) return 'ended';
  if (s.status === 'trial' && s.trialEnd && s.trialEnd > today) return 'trial';
  if (s.end) return 'ending';
  return 'active';
}

/** 已停止（到期结束或被服务商停用）：effectiveStatus 为 ended / terminated */
export function isStopped(status: string): boolean {
  return status === 'ended' || status === 'terminated';
}

export function priceAt(s: Subscription, day: string): number {
  if (s.phases?.length) return priceAt(currentPhase(s, day), day);
  if (s.intro && day < s.intro.until) return s.intro.price;
  let p = s.price;
  const hist = (s.priceHistory ?? []).slice().sort((a, b) => a.from.localeCompare(b.from));
  if (!hist.length) return p;
  // 历史价：取 from<=day 的最后一个；早于首个历史点时用首个点
  p = hist[0].amount;
  for (const h of hist) if (h.from <= day) p = h.amount;
  return p;
}

export interface Charge {
  sub: Subscription;
  date: string;
  amount: number; // 原币
  currency: string;
  /** 预测的未来扣款 */
  projected: boolean;
  kind?: Payment['kind'];
  /** 卡上实际扣的币种与金额 */
  settled?: Payment['settled'];
  note?: string;
  /** 本笔续费购买的服务起点，与现金日期分开。 */
  serviceDate?: string;
  /** 这一笔单独记的支付方式；缺省用所属阶段的，读取用 chargeMethodId() */
  methodId?: string;
  /** 这一笔由几个来源合付；读取用 chargeSources() */
  funding?: Payment['funding'];
  /** 账单与缴费分开记：结清这期账单（date 为账单日）的那笔缴费的实际日期 */
  paidOn?: string;
  /** 账单与缴费分开记：账单未缴的部分；overdue 为账单日已过 */
  unpaid?: 'due' | 'overdue';
  /** 账单与缴费分开记的实际缴费（cashChargesBetween）：记下的指定账单（Payment.periods），修改时原样带回 */
  periods?: string[];
  /** 同上：这笔缴费实际分到的账单日 */
  settles?: string[];
}

/** 一笔扣款实际用的支付方式：拆分付款取金额最大的来源，否则这一笔单独记的优先，再否则是所属阶段的 */
export const chargeMethodId = (c: Pick<Charge, 'methodId' | 'sub' | 'funding'>) =>
  c.funding?.length ? c.funding.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a)).methodId : (c.methodId ?? c.sub.methodId);

/** 一笔扣款各来源及所占比例（合计为 1）；未拆分时只有 chargeMethodId() 一个来源 */
export function chargeSources(c: Pick<Charge, 'methodId' | 'sub' | 'funding' | 'amount'>): Array<{ methodId: string | undefined; share: number }> {
  if (!c.funding?.length) return [{ methodId: chargeMethodId(c), share: 1 }];
  const total = c.funding.reduce((a, f) => a + f.amount, 0);
  return c.funding.map((f) => ({ methodId: f.methodId, share: total ? f.amount / total : 1 / c.funding!.length }));
}

/** 资金拆分：至少两个不同来源，与本笔同号且不为零，合计等于本笔金额；失败的扣款和单独记的 methodId 不能同时拆分 */
export function fundingError(p: Payment): string | undefined {
  if (p.funding == null) return undefined;
  const parts = p.funding;
  if (
    !Array.isArray(parts) ||
    parts.length < 2 ||
    p.kind === 'failed' ||
    p.methodId != null ||
    parts.some(
      (f) => !f || typeof f.methodId !== 'string' || !f.methodId || !Number.isFinite(f.amount) || f.amount === 0 || Math.sign(f.amount) !== Math.sign(p.amount),
    ) ||
    new Set(parts.map((f) => f.methodId)).size !== parts.length
  )
    return t('core.subError.funding');
  if (Math.abs(parts.reduce((a, f) => a + f.amount, 0) - p.amount) > 0.005) return t('core.subError.fundingSum');
  return undefined;
}

/** 后付费：每个周期边界为刚用完的上一期出账单，开始日本身不扣款；买断不适用 */
export function isPostpaid(s: Pick<Subscription, 'billing' | 'cycle'>): boolean {
  return s.billing === 'postpaid' && s.cycle.unit !== 'lifetime';
}

/** 规则修改只影响尚未发生的扣款；已扣过的服务边界不重复收费。 */
function renewalDate(s: Subscription, boundary: string, initial = false): string {
  if (initial) return boundary;
  const service = addDays(boundary, s.renewalOffsetDays ?? 0);
  const history = s.renewalHistory;
  if (!history?.length) return addDays(service, -(s.chargeLeadDays ?? 0));
  let date = addDays(service, -history[0].chargeLeadDays);
  for (const rule of history.slice(1)) {
    if (date < rule.from) break;
    const proposed = addDays(service, -rule.chargeLeadDays);
    date = proposed < rule.from ? rule.from : proposed;
  }
  return date;
}

export function renewalRuleAt(s: Subscription, day: string): RenewalRule {
  return (
    s.renewalHistory?.findLast((r) => r.from <= day) ?? {
      from: s.start,
      chargeLeadDays: s.chargeLeadDays ?? 0,
      cancelLeadDays: s.cancelLeadDays ?? 0,
    }
  );
}

/** 原计费锚点：试用中取试用结束日（首个付费日），否则取保留的原计费起点或开始日 */
function billingAnchor(s: Subscription): string {
  return s.status === 'trial' && s.trialEnd ? s.trialEnd : (s.billingStart ?? s.start);
}

/** 当前与历史续费规则里最长的提前扣款天数 */
function maxChargeLead(s: Subscription): number {
  return Math.max(s.chargeLeadDays ?? 0, ...(s.renewalHistory ?? []).map((r) => r.chargeLeadDays));
}

/** 开始日前移后，允许沿原计费锚点向前查找新增的周期。 */
function firstCycle(s: Subscription, anchor: string): number {
  return anchor === s.billingStart && s.start < anchor ? Math.floor(diffDays(anchor, s.start) / cycleDays(s.cycle)) - 2 : 0;
}

/** 将实付/nextDue 的现金日期恢复为原服务锚点，保留月底日号。 */
export function renewalAnchor(s: Subscription, anchor: string): string {
  const original = billingAnchor(s);
  const first = firstCycle(s, original);
  const guess = Math.max(first, Math.round(diffDays(original, anchor) / cycleDays(s.cycle)));
  for (let k = Math.max(first, guess - 2); k <= guess + Math.ceil(maxChargeLead(s) / cycleDays(s.cycle)) + 2; k++) {
    const boundary = nthCharge(original, s.cycle, k);
    if (renewalDate(s, boundary, k === 0 && !isPostpaid(s)) === anchor) return original;
  }
  return addDays(anchor, (renewalRuleAt(s, anchor).chargeLeadDays ?? 0) - (s.renewalOffsetDays ?? 0));
}

/** due 这一期的上一个扣款日，沿 due 所在的计费锚点算，保留月底日号。 */
export function chargeBefore(s: Subscription, due: string): string {
  const original = billingAnchor(s);
  const anchor = renewalAnchor(s, due);
  const guess = Math.round(diffDays(anchor, due) / cycleDays(s.cycle));
  const span = Math.ceil(maxChargeLead(s) / cycleDays(s.cycle)) + 2;
  const cash = (k: number) => {
    const boundary = nthCharge(anchor, s.cycle, k);
    return renewalDate(s, boundary, boundary === original && !isPostpaid(s));
  };
  for (let k = guess - span; k <= guess + span; k++) if (cash(k) === due) return cash(k - 1);
  return nthCharge(due, s.cycle, -1);
}

/** 服务从 service 开始的那一期，它的扣款日。 */
export function chargeOfService(s: Subscription, service: string): string {
  return service === billingAnchor(s) ? service : renewalDate(s, addDays(service, -(s.renewalOffsetDays ?? 0)));
}

/**
 * 旧版提前记账没有顺延 nextDue，准时记账也不更新它，所以存储的 nextDue 常常落后。从最后一笔续费往前找：
 * 连续几期都落在到期前半个周期内，再往前有一笔结清了上一期（排除一直晚付的），就按提前续费计算。
 * 只影响计算，不改存储；下次保存这一段时才写入记录。付款较早的识别不了，重新保存那一笔即可；确实是额外费用的改记成补差。
 */
export function settleLegacyEarly(s: Subscription): Subscription {
  if (!s.nextDue || !s.payments?.length || s.cycle.unit === 'lifetime' || isPostpaid(s)) return s;
  const renewals = s.payments.filter((p) => !p.kind).sort((a, b) => a.date.localeCompare(b.date));
  const last = renewals.at(-1);
  const stopped = s.stop?.date ?? pausedFromOf(s);
  if (!last || last.serviceDate || (stopped && last.date >= stopped)) return s;
  // 存储的 trial 到期后不会自动改写：按试用结束日判断这笔是否已在计费期
  if (s.status === 'trial' && !(s.trialEnd && last.date >= s.trialEnd)) return s;
  // 没写日期的暂停、退订算不出账期，不动
  if (!stopped && (s.status === 'paused' || undatedStop(s))) return s;
  // 按没有停止、暂停和结束日的账期走：停用后已结清的一期也不能再冒出来
  const open: Subscription = { ...s, stop: undefined, end: undefined, pausedAt: undefined, pauses: undefined, status: 'active' };
  const half = cycleDays(s.cycle) / 2;
  const span = Math.ceil(cycleDays(s.cycle) * 2) + 32 + maxChargeLead(s);
  // 赠送期之后账期从赠送结束日重新算；月底日号要从 nextDue 起算才不被夹短
  const rebased = s.bonus && s.bonus.until > s.nextDue ? s.bonus.until : undefined;
  const after = (day: string) =>
    schedule(open, rebased && day >= rebased ? rebased : s.nextDue!, addDays(day, 1), addDays(day, span), day, day, true).find((c) => !c.kind);
  const refundFrom = s.payments.filter((p) => p.kind === 'refund').reduce((m, p) => (p.date > m ? p.date : m), '');
  const chain: Array<{ pay: Payment; due: Charge }> = [];
  let first = renewals.length;
  for (let k = renewals.length - 1; k >= 0; k--) {
    const pay = renewals[k];
    const due = after(pay.date);
    // 记完又退了款的是冲销，不算续费
    if (!due || pay.serviceDate || pay.date <= refundFrom || (rebased && chain.length && pay.date < rebased)) break;
    if (diffDays(pay.date, due.date) >= half || pay.date <= chargeBefore(open, due.date)) break;
    if (chain.length && after(due.date)?.date !== chain[0].due.date) break;
    const service = due.serviceDate ?? due.date;
    if (
      (s.end && service > s.end) ||
      (stopped && (due.date > stopped || (!s.stop && due.date === stopped))) ||
      (s.bonus && service >= s.bonus.from && service < s.bonus.until)
    )
      return s;
    chain.unshift({ pay, due });
    first = k;
  }
  if (!chain.length) return s;
  const prior = chargeBefore(open, chain[0].due.date);
  if (!renewals.slice(0, first).some((p) => (p.serviceDate ?? p.date) >= prior)) return s;
  const next = after(chain.at(-1)!.due.date);
  if (!next) return s;
  const settled = new Map(chain.map((x) => [x.pay, x.due.serviceDate ?? x.due.date]));
  return { ...s, nextDue: next.date, payments: s.payments.map((p) => (settled.has(p) ? { ...p, serviceDate: settled.get(p) } : p)) };
}

/** 按原服务边界迭代，再转换现金日期；首购和试用转付费不提前扣。 */
function schedule(s: Subscription, anchor: string, from: string, to: string, today: string, after = '', cashAnchor = false): Charge[] {
  const out: Charge[] = [];
  const begin = anchor;
  const original = billingAnchor(s);
  if (cashAnchor) anchor = renewalAnchor(s, anchor);
  const pausedFrom = pausedFromOf(s) ?? (s.status === 'paused' ? today : undefined);
  const postpaid = isPostpaid(s);
  // 开始日提前时，沿原计费锚点向前补周期；保留月底日号及之后的续费日期。
  const first = firstCycle(s, anchor);
  let k = Math.max(first, Math.floor(diffDays(anchor, addDays(from, -(s.renewalOffsetDays ?? 0))) / cycleDays(s.cycle)) - 2);
  const maxLead = maxChargeLead(s);
  for (let guard = 0; guard < 10000; guard++, k++) {
    const boundary = nthCharge(anchor, s.cycle, k);
    if (boundary > addDays(to, maxLead)) break;
    if (postpaid) {
      // 后付费：边界日为上一期 [prev, boundary) 出账单；服务期在停止/结束/暂停前开始的仍出最后一张
      const prev = nthCharge(anchor, s.cycle, k - 1);
      const d = renewalDate(s, boundary);
      const serviceDate = prev === original ? prev : addDays(prev, s.renewalOffsetDays ?? 0);
      if (d > to) continue;
      if (s.stop && serviceDate > s.stop.date) break;
      if (s.end && serviceDate > s.end) break;
      if (undatedStop(s) && serviceDate > original) break;
      if (pausedFrom && serviceDate >= pausedFrom) break;
      if (serviceDate < s.start || d < from || d <= after || (cashAnchor && d < begin)) continue;
      if (s.status === 'trial' && s.trialEnd && serviceDate < s.trialEnd) continue;
      // 金额按所用那一期的价格（首期优惠、调价都看服务期起点）；结束日（含）在期中时只收用到的天数，换方案不重复计费
      const full = priceAt(s, serviceDate);
      const cut = s.end && s.end < addDays(boundary, -1) ? addDays(s.end, 1) : undefined;
      // 服务期从暂停里开始：只收恢复之后用到的天数，整期都在暂停里就没有账单；暂停前开始的那期金额不变
      const resumed = s.pauses?.find((p) => p.from <= serviceDate && serviceDate < p.to)?.to;
      if (resumed && (cut ?? boundary) <= resumed) continue;
      const amount =
        cut || resumed ? Math.round(((full * diffDays(resumed ?? serviceDate, cut ?? boundary)) / diffDays(serviceDate, boundary)) * 100) / 100 : full;
      out.push({ sub: s, date: d, serviceDate, amount, currency: s.currency, projected: d > today });
      continue;
    }
    const initial = boundary === original;
    const d = renewalDate(s, boundary, initial);
    const serviceDate = initial ? boundary : addDays(boundary, s.renewalOffsetDays ?? 0);
    if (d > to) continue;
    if (s.stop && d > s.stop.date) break;
    // end is inclusive service coverage; no purchase of service starting after it.
    if (s.end && serviceDate > s.end) break;
    if (undatedStop(s) && boundary > original) break;
    if (serviceDate < s.start || d < s.start || d < from || d <= after || (cashAnchor && d < begin)) continue;
    if (s.status === 'trial' && s.trialEnd && d < s.trialEnd) continue;
    if (pausedFrom && d >= pausedFrom) break;
    if (pausedOn(s, d)) continue;
    out.push({ sub: s, date: d, serviceDate, amount: priceAt(s, d), currency: s.currency, projected: d > today });
  }
  return out;
}

/**
 * [from, to] 区间内的扣款（含两端）。暂停中的订阅不产生未来扣款；试用期内的不计费。
 * 有实际扣款记录（payments）时以记录为准，之后从 nextDue（缺省为最后一笔 + 一个周期）开始推算；
 * 开始日提前到原 billingStart 之前的新增服务期按原规则补算，同日实付优先。
 * 只有 nextDue 时，此前按开始日推算，此后从 nextDue 推算（用于扣款日漂移、提前续费等）。
 */
export function chargesBetween(s: Subscription, from: string, to: string, today: string): Charge[] {
  if (s.expires && s.chargeLeadDays == null) s = migrateRenewalRules(s);
  if (s.phases?.length) {
    return phaseSubs(s)
      .flatMap((v) => chargesBetween(v, from, to, today))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  if (isSeparate(s)) return separateCharges(s, from, to, today, 'accrual');
  return chargesAsRecorded(settleLegacyEarly(s), from, to, today);
}

/** 账单与缴费分开记（买断不适用） */
export const isSeparate = (s: Pick<Subscription, 'settlement' | 'cycle'>) => s.settlement === 'separate' && s.cycle.unit !== 'lifetime';

/**
 * 现金口径的扣款：分开记时每笔缴费按实际缴费日记一条（不拆到账单），之后未缴的账单仍按账单日预测；
 * 其余订阅与 chargesBetween 相同。支付方式余额、现金流按它算。
 */
export function cashChargesBetween(s: Subscription, from: string, to: string, today: string): Charge[] {
  if (s.expires && s.chargeLeadDays == null) s = migrateRenewalRules(s);
  if (s.phases?.length) {
    return phaseSubs(s)
      .flatMap((v) => cashChargesBetween(v, from, to, today))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  if (isSeparate(s)) return separateCharges(s, from, to, today, 'cash');
  return chargesAsRecorded(settleLegacyEarly(s), from, to, today);
}

/** 分开记时账单日已过、还没缴清的各期（未缴部分），按账单日排序；chargesBetween 不含它们，详情图与欠缴提示另取 */
export function overdueBills(s: Subscription, today: string): Charge[] {
  if (s.expires && s.chargeLeadDays == null) s = migrateRenewalRules(s);
  return phaseSubs(s)
    .filter(isSeparate)
    .flatMap((v) =>
      settleBills(v, today)
        .bills.filter((b) => b.date < today && b.due - b.paid > 0.005)
        .map((b) => unpaidCharge(v, b, today)),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type BillStatus = 'paid' | 'partial' | 'due' | 'overdue' | 'prepaid' | 'inferred' | 'free';

export interface Bill {
  date: string;
  serviceDate?: string;
  /** 本期应缴 */
  due: number;
  /** 已分配到本期的缴费 */
  paid: number;
  status: BillStatus;
  /** 各笔缴费分到本期的金额 */
  pieces: Array<{ payment: Payment; amount: number }>;
}

export interface Settlement {
  bills: Bill[];
  /** 每笔缴费结清的账单日（按分配结果，含自动抵扣） */
  allocated: Map<Payment, string[]>;
  /** 分配不出去的余额（所有账单都已缴清） */
  credit: Array<{ payment: Payment; amount: number }>;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * 分开记的账单与分配：账单按开始锚点、价格历史、停止/暂停/试用/后付费等规则生成，与缴费日期无关；
 * billingStart 之前的视为已缴（推算）。缴费先按 periods 指定的账单按应缴比例分，剩下的（及没写 periods 的）
 * 按账单日从早到晚抵扣未缴的部分，可以抵到未来的账单（预缴）。删掉一笔缴费，它的分配随之释放。
 */
export function settleBills(s: Subscription, today: string, until = today): Settlement {
  const pays = (s.payments ?? []).filter((p) => !p.kind).sort((a, b) => a.date.localeCompare(b.date));
  const total = pays.reduce((a, p) => a + Math.max(0, p.amount), 0);
  const lastPay = pays.at(-1)?.date ?? '';
  const open = { ...s, payments: undefined, nextDue: undefined, settlement: undefined };
  const keyOf = new Map<string, number>();
  let horizon = [until, today, lastPay].sort().at(-1)!;
  let raw: Charge[] = [];
  // 预缴可能抵到很远的账单：账单总额不够分配时往后多生成，没有新账单（已结束）就停
  for (let i = 0; i < 40; i++) {
    raw = chargesAsRecorded(open, s.start < (s.billingStart ?? s.start) ? s.start : (s.billingStart ?? s.start), horizon, today).filter((c) => !c.kind);
    const owed = raw.filter((c) => !s.billingStart || c.date >= s.billingStart).reduce((a, c) => a + c.amount, 0);
    if (owed >= total - 0.005) break;
    const next = addMonths(horizon, 12);
    const more = chargesAsRecorded(open, addDays(horizon, 1), next, today).filter((c) => !c.kind);
    if (!more.length) break;
    horizon = next;
  }
  const bills: Bill[] = raw.map((c) => {
    const inferred = !!s.billingStart && c.date < s.billingStart;
    return { date: c.date, serviceDate: c.serviceDate, due: c.amount, paid: inferred ? c.amount : 0, status: inferred ? 'inferred' : 'due', pieces: [] };
  });
  bills.forEach((b, i) => {
    keyOf.set(b.date, i);
    if (b.serviceDate && !keyOf.has(b.serviceDate)) keyOf.set(b.serviceDate, i);
  });
  const allocated = new Map<Payment, string[]>();
  const rest = new Map<Payment, number>();
  const give = (p: Payment, b: Bill, amount: number) => {
    if (amount <= 0.004) return;
    b.paid = cents(b.paid + amount);
    const piece = b.pieces.find((x) => x.payment === p);
    if (piece) piece.amount = cents(piece.amount + amount);
    else b.pieces.push({ payment: p, amount: cents(amount) });
    const keys = allocated.get(p) ?? [];
    if (!keys.includes(b.date)) allocated.set(p, [...keys, b.date]);
  };
  const left = (b: Bill) => cents(b.due - b.paid);
  // 先分指定了账单的：按各期未缴金额的比例，最后一期拿零头
  for (const p of pays) {
    let amount = Math.max(0, p.amount);
    const targets = [...new Set((p.periods ?? []).map((k) => keyOf.get(k)).filter((i): i is number => i != null))]
      .sort((a, b) => a - b)
      .map((i) => bills[i])
      .filter((b) => b.status !== 'inferred' && left(b) > 0);
    const owed = targets.reduce((a, b) => a + left(b), 0);
    if (owed > 0) {
      const use = Math.min(amount, owed);
      let given = 0;
      targets.forEach((b, i) => {
        const part = i === targets.length - 1 ? cents(use - given) : cents((use * left(b)) / owed);
        const take = Math.min(part, left(b));
        give(p, b, take);
        given = cents(given + take);
      });
      amount = cents(amount - given);
    }
    rest.set(p, amount);
  }
  // 再按缴费日先后，把余额从最早未缴的账单依次抵扣
  for (const p of pays) {
    let amount = rest.get(p) ?? 0;
    for (const b of bills) {
      if (amount <= 0.004) break;
      if (b.status === 'inferred') continue;
      const take = Math.min(amount, left(b));
      if (take <= 0) continue;
      give(p, b, take);
      amount = cents(amount - take);
    }
    rest.set(p, amount);
  }
  for (const b of bills) {
    if (b.status === 'inferred') continue;
    b.status =
      b.due <= 0.004 ? 'free' : left(b) <= 0.004 ? (b.date > today ? 'prepaid' : 'paid') : b.paid > 0.004 ? 'partial' : b.date < today ? 'overdue' : 'due';
  }
  const credit = pays.filter((p) => (rest.get(p) ?? 0) > 0.004).map((p) => ({ payment: p, amount: rest.get(p)! }));
  return { bills, allocated, credit };
}

function unpaidCharge(s: Subscription, b: Bill, today: string): Charge {
  return {
    sub: s,
    date: b.date,
    ...(b.serviceDate ? { serviceDate: b.serviceDate } : {}),
    amount: cents(b.due - b.paid),
    currency: s.currency,
    projected: true,
    unpaid: b.date < today ? 'overdue' : 'due',
  };
}

/** 一笔缴费按比例拆出的一份：卡上实扣与资金来源同比例缩放 */
function paymentCharge(s: Subscription, p: Payment, date: string, amount: number, today: string, extra: Partial<Charge>): Charge {
  const ratio = p.amount ? amount / p.amount : 1;
  return {
    sub: s,
    date,
    amount,
    currency: s.currency,
    projected: false,
    ...(p.settled ? { settled: { amount: cents(p.settled.amount * ratio), currency: p.settled.currency } } : {}),
    ...(p.note ? { note: p.note } : {}),
    ...(p.methodId ? { methodId: p.methodId } : {}),
    ...(p.funding?.length ? { funding: p.funding.map((f) => ({ ...f, amount: cents(f.amount * ratio) })) } : {}),
    ...extra,
    ...(date > today && !extra.paidOn ? { projected: true } : {}),
  };
}

function separateCharges(s: Subscription, from: string, to: string, today: string, basis: 'accrual' | 'cash'): Charge[] {
  const { bills, credit, allocated } = settleBills(s, today, to);
  const out: Charge[] = [];
  const inWindow = (d: string) => d >= from && d <= to;
  // 退款、补差、扣款失败仍是按日期的现金记录
  for (const p of s.payments ?? []) {
    if (!p.kind || !inWindow(p.date)) continue;
    out.push(paymentCharge(s, p, p.date, p.kind === 'failed' ? 0 : p.amount, today, { kind: p.kind, ...(p.kind === 'failed' ? { settled: undefined } : {}) }));
  }
  for (const b of bills) {
    const base = b.serviceDate ? { serviceDate: b.serviceDate } : {};
    if (b.status === 'inferred') {
      if (inWindow(b.date)) out.push({ sub: s, date: b.date, ...base, amount: b.due, currency: s.currency, projected: b.date > today });
      continue;
    }
    if (basis === 'accrual' && inWindow(b.date))
      for (const piece of b.pieces) out.push(paymentCharge(s, piece.payment, b.date, piece.amount, today, { ...base, paidOn: piece.payment.date }));
    // 未缴部分：账单日已过的不算扣款（见 overdueBills），今天及以后的照常预测
    if (b.due - b.paid > 0.005 && b.date >= today && inWindow(b.date)) out.push(unpaidCharge(s, b, today));
  }
  if (basis === 'cash') {
    for (const p of s.payments ?? [])
      if (!p.kind && inWindow(p.date))
        out.push(
          paymentCharge(s, p, p.date, p.amount, today, {
            paidOn: p.date,
            ...(p.periods?.length ? { periods: p.periods } : {}),
            settles: [...(allocated.get(p) ?? [])].sort(),
          }),
        );
  } else {
    // 账单都已缴清后多出的钱：按缴费日记，不丢
    for (const c of credit) if (inWindow(c.payment.date)) out.push(paymentCharge(s, c.payment, c.payment.date, c.amount, today, { paidOn: c.payment.date }));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 按记录原样算，不再识别旧版提前续费；账期计算去掉停用状态后用它，否则会绕过 settleLegacyEarly 的停用判断 */
function chargesAsRecorded(s: Subscription, from: string, to: string, today: string): Charge[] {
  if (s.expires && s.chargeLeadDays == null) s = migrateRenewalRules(s);
  const recorded = new Set((s.payments ?? []).map((p) => p.date));
  const known = (c: Charge) => !s.estimateFrom || c.date >= s.estimateFrom || recorded.has(c.date);
  const raw = rawCharges(s, from, to, today).filter(known);
  const b = s.bonus;
  if (!b || s.cycle.unit === 'lifetime') return raw;
  // 赠送期：期间的预测扣款去掉，之后从赠送结束日重新按周期起算；实际扣款记录照旧保留
  const paid = new Set((s.payments ?? []).map((p) => p.date));
  const settled = new Set((s.payments ?? []).map((p) => p.serviceDate));
  const lastPaid = (s.payments ?? []).filter((p) => !p.kind).reduce((m, p) => (p.date > m ? p.date : m), '');
  const keep = raw.filter((c) => paid.has(c.date) || (c.serviceDate ?? c.date) < b.from);
  const after = schedule(s, b.until, from, to, today, lastPaid > renewalDate(s, b.until) ? lastPaid : addDays(renewalDate(s, b.until), -1));
  // 后付费：赠送结束日起用的那一期才再出账单
  const postpaid = isPostpaid(s);
  return keep
    .concat(after.filter((c) => !paid.has(c.date) && !settled.has(c.serviceDate ?? c.date) && known(c) && (!postpaid || (c.serviceDate ?? c.date) >= b.until)))
    .sort((x, y) => x.date.localeCompare(y.date));
}

function rawCharges(s: Subscription, from: string, to: string, today: string): Charge[] {
  const pays = (s.payments ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const renewals = pays.filter((p) => !p.kind);
  // 后付费：停止日之后才出的最后一张账单仍属于停止前的服务期
  const postpaidBefore = (date: string, stop: string) => isPostpaid(s) && chargeServicePeriod(s, date).from <= stop;
  if (pays.length) {
    // 扣款失败的记一笔 0，不计入支出，但留在记录里
    const out: Charge[] = pays
      .filter((p) => p.date >= from && p.date <= to && (!s.stop || p.date <= s.stop.date || p.kind === 'refund' || postpaidBefore(p.date, s.stop.date)))
      .map((p) => ({
        sub: s,
        date: p.date,
        amount: p.kind === 'failed' ? 0 : p.amount,
        currency: s.currency,
        projected: p.date > today,
        kind: p.kind,
        settled: p.kind === 'failed' ? undefined : p.settled,
        note: p.note,
        ...(p.serviceDate ? { serviceDate: p.serviceDate } : {}),
        ...(p.methodId ? { methodId: p.methodId } : {}),
        ...(p.funding?.length ? { funding: p.funding } : {}),
      }));
    if (s.cycle.unit === 'lifetime') return out;
    const last = renewals.at(-1)?.date ?? s.billingStart ?? s.start;
    const future = schedule(s, s.nextDue ?? last, from, to, today, last, true);
    const covered = new Set([...pays, ...future].map((p) => p.date));
    const earlier =
      s.billingStart && s.start < s.billingStart
        ? schedule(s, s.billingStart, from, to < s.billingStart ? to : addDays(s.billingStart, -1), today).filter((c) => !covered.has(c.date))
        : [];
    return earlier.concat(out, future).sort((a, b) => a.date.localeCompare(b.date));
  }
  if (s.cycle.unit === 'lifetime') {
    return s.start >= from && s.start <= to ? [{ sub: s, date: s.start, amount: priceAt(s, s.start), currency: s.currency, projected: s.start > today }] : [];
  }
  const anchor = billingAnchor(s);
  if (s.nextDue) {
    const before = schedule(s, anchor, from, to < s.nextDue ? to : addDays(s.nextDue, -1), today).filter(
      (c) => diffDays(c.date, s.nextDue!) > cycleDays(s.cycle) / 2,
    );
    return before.concat(schedule(s, s.nextDue, from, to, today, '', true));
  }
  return schedule(s, anchor, from, to, today);
}

/** 兼容旧 expires：围绕旧到期日查找上一扣款，固定推导结果，不随读取日期漂移。 */
export function migrateRenewalRules(s: Subscription): Subscription {
  if (!s.expires || s.chargeLeadDays != null || !validDay(s.expires)) return s;
  if (s.stop || s.cycle.unit === 'lifetime') return { ...s, chargeLeadDays: 0 };
  const clean = { ...s, expires: undefined };
  const candidates = chargesBetween(clean, addDays(s.expires, -3660), s.expires, s.expires).filter((c) => !c.kind);
  const charge = candidates.at(-1);
  const n = charge ? diffDays(charge.date, s.expires) : 0;
  if (n <= 0 || n > 3660) return { ...s, chargeLeadDays: 0 };
  const patch = { chargeLeadDays: n, cancelLeadDays: s.cancelLeadDays ?? 0, renewalOffsetDays: n };
  return { ...s, ...patch, ...(s.phases ? { phases: s.phases.map((p) => (p.start === charge!.sub.start ? { ...p, ...patch } : p)) } : {}) };
}

/** 更新当前阶段规则，旧规则留在历史中；调用方在 syncPhase 前使用。 */
export function preserveRenewalHistory(previous: Subscription, next: Subscription, today: string): Subscription {
  const old = currentPhase(migrateRenewalRules(previous), today);
  if ((old.chargeLeadDays ?? 0) === (next.chargeLeadDays ?? 0) && (old.cancelLeadDays ?? 0) === (next.cancelLeadDays ?? 0))
    return { ...next, renewalHistory: old.renewalHistory, renewalOffsetDays: old.renewalOffsetDays };
  const initial = { from: old.start, chargeLeadDays: old.chargeLeadDays ?? 0, cancelLeadDays: old.cancelLeadDays ?? 0 };
  const history = (old.renewalHistory ?? [initial]).filter((r) => r.from < today);
  return {
    ...next,
    renewalOffsetDays: old.renewalOffsetDays,
    renewalHistory: [
      ...history,
      {
        from: today,
        chargeLeadDays: next.chargeLeadDays ?? 0,
        cancelLeadDays: next.cancelLeadDays ?? 0,
      },
    ],
  };
}

export function renewalDates(s: Subscription, from: string): { nextCharge?: string; serviceExpires?: string; cancelBy?: string } {
  s = migrateRenewalRules(s);
  const phases = phaseSubs(s);
  const span = Math.max(...phases.map((p) => (p.cycle.unit === 'lifetime' ? 0 : cycleDays(p.cycle))));
  const lead = Math.max(0, ...phases.map((p) => p.chargeLeadDays ?? 0));
  const horizon = addDays(from, Math.ceil(span * 2) + lead + 32);
  const charge = chargesBetween(s, from, horizon, from).find((c) => !c.kind);
  if (!charge || charge.sub.cycle.unit === 'lifetime') return {};
  const rule = renewalRuleAt(charge.sub, charge.date);
  // 后付费的账单为已用完的一期付款，没有「服务到期」
  if (isPostpaid(charge.sub)) return { nextCharge: charge.date };
  return {
    nextCharge: charge.date,
    serviceExpires: charge.serviceDate ?? chargeServicePeriod(charge.sub, charge.date).from,
    cancelBy: rule.cancelLeadDays > 0 ? addDays(charge.date, -rule.cancelLeadDays) : undefined,
  };
}

/** 非续费默认截在下次现金扣款之前；已过取消截止时须再承担下一期。 */
export function nonrenewalDate(s: Subscription, today: string): string {
  const dates = renewalDates(s, today);
  // 后付费：没有预付期，默认用到当期结束（下张账单前一天），最后一张账单照出
  if (isPostpaid(currentPhase(s, today))) return dates.nextCharge ? addDays(dates.nextCharge, -1) : today;
  if (!dates.nextCharge) return billingPeriod(s, today).paidThrough;
  if (dates.cancelBy && today > dates.cancelBy) return billingPeriod(s, dates.nextCharge).paidThrough;
  return addDays(dates.nextCharge, -1);
}

/** 服务覆盖期不随现金日提前；实付落在预定扣款上时恢复原始月末日号。 */
export function chargeServicePeriod(s: Subscription, cashDate: string, serviceDate?: string): { from: string; until: string } {
  const offset = s.renewalOffsetDays ?? 0;
  const anchor = renewalAnchor(s, cashDate);
  const first = firstCycle(s, anchor);
  const guess = Math.max(first, Math.round(diffDays(anchor, cashDate) / cycleDays(s.cycle)));
  const maxLead = maxChargeLead(s);
  const original = billingAnchor(s);
  if (isPostpaid(s)) {
    // 不在边界当天付（1 月 5 日才交 12 月电费，锚点没能还原到原始边界）：结清的是付款日前最近结束的一期
    if (anchor !== original) {
      const base = firstCycle(s, original);
      const near = Math.max(base, Math.round(diffDays(original, cashDate) / cycleDays(s.cycle)));
      // 当天另有一笔正常扣款的边界已由那笔结清（4 月 30 日交了 4 月账单，5 月 3 日补交的是 3 月的）
      const onTime = new Set((s.payments ?? []).filter((p) => !p.kind && p.date !== cashDate).map((p) => p.date));
      // 往前几期都已结清（重复扣款）时仍归最近结束的一期，不落到不在边界上的时段
      let latest: number | undefined;
      for (let k = near + 1; k > base && k >= near - 2; k--) {
        const due = renewalDate(s, nthCharge(original, s.cycle, k));
        if (due > cashDate) continue;
        latest ??= k;
        if (onTime.has(due)) continue;
        latest = k;
        break;
      }
      if (latest != null) {
        const boundary = nthCharge(original, s.cycle, latest);
        const prev = nthCharge(original, s.cycle, latest - 1);
        return { from: serviceDate ?? (prev === original ? prev : addDays(prev, offset)), until: addDays(boundary, offset) };
      }
    }
    // 后付费：账单覆盖刚结束的 [上一边界, 本边界)
    for (let k = Math.max(first, guess - 2); k <= guess + Math.ceil(maxLead / cycleDays(s.cycle)) + 2; k++) {
      const boundary = nthCharge(anchor, s.cycle, k);
      if (renewalDate(s, boundary) !== cashDate) continue;
      const prev = nthCharge(anchor, s.cycle, k - 1);
      return { from: serviceDate ?? (prev === original ? prev : addDays(prev, offset)), until: addDays(boundary, offset) };
    }
    const until = addDays(cashDate, renewalRuleAt(s, cashDate).chargeLeadDays);
    return { from: serviceDate ?? addDays(nthCharge(addDays(until, -offset), s.cycle, -1), offset), until };
  }
  const extend = (until: string) => (s.bonus && until >= s.bonus.from && until < s.bonus.until ? s.bonus.until : until);
  // 提前续费：现金日不在边界上，按它结清的那一期找边界；优先原锚点以保留月底日号
  if (serviceDate && s.payments?.some((p) => p.date === cashDate && p.serviceDate === serviceDate)) {
    const base = firstCycle(s, original);
    const near = Math.max(base, Math.round(diffDays(original, serviceDate) / cycleDays(s.cycle)));
    for (let k = Math.max(base, near - 2); k <= near + 2; k++) {
      const boundary = nthCharge(original, s.cycle, k);
      if (boundary === serviceDate || addDays(boundary, offset) === serviceDate)
        return { from: serviceDate, until: extend(addDays(nthCharge(original, s.cycle, k + 1), offset)) };
    }
    return { from: serviceDate, until: extend(addDays(nthCharge(addDays(serviceDate, -offset), s.cycle, 1), offset)) };
  }
  for (let k = Math.max(first, guess - 2); k <= guess + Math.ceil(maxLead / cycleDays(s.cycle)) + 2; k++) {
    const boundary = nthCharge(anchor, s.cycle, k);
    if (renewalDate(s, boundary, boundary === original) === cashDate)
      return {
        from: serviceDate ?? (boundary === original ? boundary : addDays(boundary, offset)),
        until: extend(addDays(nthCharge(anchor, s.cycle, k + 1), offset)),
      };
  }
  const from = serviceDate ?? addDays(cashDate, renewalRuleAt(s, cashDate).chargeLeadDays);
  return { from, until: extend(addDays(nthCharge(addDays(from, -offset), s.cycle, 1), offset)) };
}

/**
 * 归期日：后付费的周期账单按它结清的服务期末日算（9 月 1 日交的 8 月电费归 8 月 31 日），与读数同一天；
 * 其余（预付费、退款、调整）按扣款日。详情页的柱子位置、扣款记录分年用它，日历与现金统计仍按扣款日
 */
export function chargeDay(c: Pick<Charge, 'sub' | 'date' | 'serviceDate' | 'kind'>): string {
  return !c.kind && isPostpaid(c.sub) ? addDays(chargeServicePeriod(c.sub, c.date, c.serviceDate).until, -1) : c.date;
}

/** 一段日子 [first, last] 的中间一天：后付费账单与用量的柱子画在所属周期中间，不贴着下个月的刻度 */
export function midDay(first: string, last: string): string {
  return addDays(first, Math.floor(diffDays(first, last) / 2));
}

/** 服务端全记录写入也保留规则历史；不依赖客户端是否携带历史项。 */
export function reconcileRenewalRules(previous: Subscription | undefined, next: Subscription, today: string): Subscription {
  next = migrateRenewalRules(next);
  if (!previous) return next;
  previous = migrateRenewalRules(previous);
  if (!next.phases?.length) return preserveRenewalHistory(previous, next, today);
  const old = phaseSubs(previous);
  return {
    ...next,
    phases: next.phases.map((p) => {
      const before = old.find((v) => v.start === p.start);
      if (!before) return p;
      const revised = preserveRenewalHistory(before, { ...next, ...p, phases: undefined }, today);
      return { ...p, renewalHistory: revised.renewalHistory, renewalOffsetDays: revised.renewalOffsetDays };
    }),
  };
}

/** 今天及以后的第一次扣款；今天扣款的仍算下次扣款，界面、MCP 与提醒都传今天 */
export function nextCharge(s: Subscription, today: string): string | undefined {
  if (s.cycle.unit === 'lifetime') return s.start > today ? s.start : undefined;
  // 后付费停止后还有最后一张账单，交给 chargesBetween 判断
  if (s.stop && s.stop.date <= today && !isPostpaid(s)) return undefined;
  // 提前续费后下一笔可能在将近两个周期之后；分开记时已预缴的账单（带 paidOn）不算下一笔
  return chargesBetween(s, today, addDays(today, Math.max(396, Math.ceil(cycleDays(s.cycle) * 2) + 32)), today).find((c) => !c.kind && !c.paidOn)?.date;
}

export function lastCharge(s: Subscription, today: string): string | undefined {
  const all = chargesBetween(s, s.start, today, today).filter((c) => !c.kind);
  return all[all.length - 1]?.date;
}

/** 停止前原账期。按原始锚点推算，保留月末夹紧、nextDue、实付与赠送期。 */
export function billingPeriod(s: Subscription, at: string): { from: string; paidThrough: string; paid: number; days: number } {
  if (s.phases?.length) return billingPeriod(currentPhase(s, at), at);
  // 分开记：账期只看账单周期，缴了没有、哪天缴的不影响「本期」
  if (isSeparate(s)) return periodAsRecorded({ ...s, payments: undefined, nextDue: undefined, settlement: undefined }, at);
  return periodAsRecorded(settleLegacyEarly(s), at);
}

function periodAsRecorded(s: Subscription, at: string): { from: string; paidThrough: string; paid: number; days: number } {
  const pausedFrom = s.pauses?.find((p) => p.from <= at && at < p.to)?.from ?? pausedFromOf(s);
  if (pausedFrom && at >= pausedFrom) {
    // 暂停后没有新账期：已付期算到暂停前那期（或暂停后记下的最后一笔实付），停在这之后就没有未用天数
    const paid = (s.payments ?? [])
      .filter((p) => !p.kind && p.date >= pausedFrom && p.date <= at)
      .map((p) => p.date)
      .sort()
      .at(-1);
    const before = s.pauses?.filter((p) => p.to <= pausedFrom);
    const period = periodAsRecorded(
      { ...s, pausedAt: undefined, pauses: before, stop: s.stop && { ...s.stop, pausedAt: undefined } },
      paid ?? addDays(pausedFrom, -1),
    );
    return period.paidThrough < at ? { ...period, paidThrough: at } : period;
  }
  const open = {
    ...s,
    stop: undefined,
    end: undefined,
    // 还没开始的暂停不影响 at 所在的账期
    pauses: s.pauses?.filter((p) => p.from <= at),
    status: s.status === 'trial' || ((s.stop || s.status === 'paused') && s.trialEnd) ? ('trial' as const) : ('active' as const),
  };
  if (isPostpaid(s)) {
    // 后付费没有预付：已付 0、不可退款、不浪费，用到哪天算到哪天；from 为 at 所在服务期的起点
    const span = Math.ceil(cycleDays(s.cycle) * 2) + maxChargeLead(s) + 32;
    const next = chargesBetween(open, addDays(at, 1), addDays(at, span), at).find((c) => !c.kind);
    const period = next ? chargeServicePeriod(s, next.date, next.serviceDate) : undefined;
    const from = period && period.from <= at ? period.from : s.start <= at ? s.start : at;
    return { from, paidThrough: at, paid: 0, days: Math.max(1, diffDays(from, period?.until ?? addDays(at, 1))) };
  }
  // 修正服务开始日后，之前的实付/计费锚点仍决定已付账期。
  const paidFrom = [s.start, s.billingStart, s.nextDue, ...(s.payments ?? []).filter((p) => !p.kind).map((p) => p.date)]
    .filter((d): d is string => !!d)
    .sort()[0];
  // 账期按完整计费规则推算：导入边界（estimateFrom）只决定统计里算不算边界前的推算扣款，
  // 不能让当前账期的那一笔消失，否则已付金额为 0、退款上限和浪费天数全错
  const paidOpen = { ...open, start: paidFrom, estimateFrom: undefined };
  const past = chargesAsRecorded(paidOpen, paidFrom, at, at).filter((c) => !c.kind);
  const last = past.at(-1);
  // 恢复后还在被暂停跳过的那一期里：账期按原节奏算，但这期没付过钱
  const natural = open.pauses?.length
    ? chargesAsRecorded({ ...paidOpen, pauses: undefined }, paidFrom, at, at)
        .filter((c) => !c.kind)
        .at(-1)
    : last;
  const skipped = !!natural && (!last || natural.date > last.date);
  const current = skipped ? natural : last;
  // 这期没有扣款，账期从恢复日算，不显示一个不存在的扣款日
  const resumedAt = skipped ? open.pauses?.at(-1)?.to : undefined;
  const sinceResume = (day: string) => (resumedAt && resumedAt > day ? resumedAt : day);
  // 提前续费：现金日早于服务日，服务开始后账期从服务日算
  const from = sinceResume(current?.serviceDate && current.serviceDate <= at ? current.serviceDate : (current?.date ?? s.start));
  // 下一账期开始日：实付的提前续费按它结清的那一期算
  const nextPaid = (day?: string) => s.payments?.find((p) => p.date === day && p.serviceDate)?.serviceDate ?? day;
  const horizon = addDays(at, Math.ceil(cycleDays(s.cycle) === Infinity ? 366 : cycleDays(s.cycle) * 2) + 32);
  const next =
    s.cycle.unit === 'lifetime'
      ? addDays(at, 1)
      : (nextPaid(chargesAsRecorded(paidOpen, addDays(at, 1), horizon, at).find((c) => !c.kind)?.date) ?? nthCharge(from, s.cycle, 1));
  if ((s.chargeLeadDays ?? 0) > 0 || s.renewalHistory?.length) {
    const service = current ? chargeServicePeriod(s, current.date, current.serviceDate) : { from: s.start, until: next };
    const serviceFrom = sinceResume(service.from);
    return {
      from: serviceFrom,
      paidThrough: addDays(service.until, -1),
      paid:
        last && !skipped
          ? chargesAsRecorded(paidOpen, last.date, at, at)
              .filter((c) => c.amount > 0 && c.kind !== 'failed')
              .reduce((sum, c) => sum + c.amount, 0)
          : 0,
      days: Math.max(1, diffDays(serviceFrom, service.until)),
    };
  }
  const paidThrough = addDays(next, -1);
  const paid =
    last && !skipped
      ? chargesAsRecorded(paidOpen, last.date, at, at)
          .filter((c) => c.amount > 0 && c.kind !== 'failed')
          .reduce((a, c) => a + c.amount, 0)
      : 0;
  return { from, paidThrough, paid, days: Math.max(1, diffDays(from, next)) };
}

/** 在 at 停止时校验用的账期：先付费按今天已付到哪天；后付费随时可停，账期截到 at */
export function stopBillingPeriod(s: Subscription, at: string, today: string) {
  const day = isPostpaid(s) || at < today || pausedFromOf(s) ? at : today;
  // 停在最后一笔续费当天或之前：停用后这笔不算提前续费，这里要同样算
  return s.payments?.some((p) => !p.kind && p.date >= at) ? periodAsRecorded(s, day) : billingPeriod(s, day);
}

/** 退款的已付基数：恢复后被跳过的那一期已付为 0，退的是暂停前最后一笔 */
function refundablePaid(s: Subscription, paid: number, at: string): number {
  const paidOn = !paid && s.pauses?.length ? lastCharge(s, at) : undefined;
  if (!paidOn) return paid;
  return chargesBetween(s, paidOn, at, at)
    .filter((c) => c.amount > 0 && c.kind !== 'failed')
    .reduce((a, c) => a + c.amount, 0);
}

export function stopSummary(s: Subscription, asOf = '9999-12-31') {
  if (!s.stop) return undefined;
  const period = billingPeriod(s, s.stop.date);
  const unusedDays = Math.min(period.days, Math.max(0, diffDays(s.stop.date, s.stop.paidThrough)));
  const prorated = (period.paid * unusedDays) / period.days;
  const refunded = (s.payments ?? []).filter((p) => p.kind === 'refund' && p.date >= s.stop!.date && p.date <= asOf).reduce((a, p) => a - p.amount, 0);
  // 商家通常按天退剩余部分：退回金额达到按天折算额即视为全额退款
  const paid = refundablePaid(s, period.paid, s.stop.date);
  const refundStatus: 'none' | 'full' | 'partial' =
    refunded < 0.005 ? 'none' : refunded + 0.005 >= (period.paid ? Math.min(prorated, paid) : paid) ? 'full' : 'partial';
  const unusedValue = refundStatus === 'full' ? 0 : Math.max(0, prorated - refunded);
  return {
    ...s.stop,
    refunded,
    refundStatus,
    unusedDays,
    unusedValue,
    /** 真正浪费的天数：没退回的钱按日价折算，部分退款时短于 unusedDays */
    wastedDays: prorated > 0 ? Math.round((unusedDays * unusedValue) / prorated) : 0,
    suggestedRefund: Math.round(prorated * 100) / 100,
    paid,
  };
}

export function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(parseDay(day)) && fmtDay(parseDay(day)) === day;
}

export function stopError(s: Subscription): string | undefined {
  const stop = s.stop;
  // 被停用但日期不详：没有 stop 也没有 end；有结束日却没有 stop 信息仍不合格
  if (!stop) return s.status === 'terminated' && s.end ? t('mcp.error.needStop') : undefined;
  if (!['cancel', 'terminate'].includes(stop.kind) || !validDay(stop.date) || !validDay(stop.paidThrough)) return t('mcp.error.notDate', { what: 'stop' });
  if (stop.date < s.start) return t('mcp.error.stopBeforeStart');
  if (stop.date > stop.paidThrough) return t('mcp.error.stopAfterPaidThrough');
  if (stop.paidThrough !== billingPeriod(s, stop.date).paidThrough) return t('mcp.error.invalidPaidThrough');
  if (s.end !== stop.date || (stop.kind === 'cancel' && stop.reason)) return t('mcp.error.invalidStop');
  return undefined;
}

/** 所有写入入口共用：逐账期限制退款总额，settled 只影响卡上实退，不改变原币上限。 */
export function paymentError(s: Subscription): string | undefined {
  for (const p of s.payments ?? []) {
    if (!validDay(p.date)) return t('mcp.error.notDate', { what: 'payment.date' });
    if (p.serviceDate != null && !validDay(p.serviceDate)) return t('mcp.error.notDate', { what: 'payment.serviceDate' });
    if (!Number.isFinite(p.amount) || (p.settled && (!Number.isFinite(p.settled.amount) || !p.settled.currency))) return t('core.subError.price');
    if (p.periods != null && (p.kind || !Array.isArray(p.periods) || !p.periods.every((d) => typeof d === 'string' && validDay(d))))
      return t('mcp.error.invalidInput', { field: 'periods' });
    const funding = fundingError(p);
    if (funding) return funding;
    if (p.kind !== 'refund') continue;
    if (p.currency && p.currency !== s.currency) return t('mcp.error.refundCurrency');
    if (p.amount > 0 || (p.settled && p.settled.amount > 0)) return t('mcp.error.invalidRefund');
    if (isPostpaid(s)) {
      // 后付费：退款以退款日前最近一张账单为上限
      const bill = chargesBetween(s, s.start, p.date, p.date)
        .filter((c) => !c.kind && c.amount > 0)
        .at(-1);
      const refunded = -(s.payments ?? [])
        .filter((r) => r.kind === 'refund' && !!bill && r.date >= bill.date && r.date <= p.date)
        .reduce((a, r) => a + r.amount, 0);
      if (!bill || refunded > bill.amount + 0.005) return t('mcp.error.refundExceedsPaid');
      continue;
    }
    const stopPeriod = s.stop && p.date >= s.stop.date;
    const period = billingPeriod(s, stopPeriod ? s.stop!.date : s.end && p.date > s.end ? s.end : p.date);
    const paidOn = lastCharge(s, stopPeriod ? s.stop!.date : p.date);
    const refundFrom = paidOn && paidOn < period.from ? paidOn : period.from;
    const refunded = -(s.payments ?? [])
      .filter((r) => r.kind === 'refund' && r.date >= refundFrom && (stopPeriod || r.date <= period.paidThrough))
      .reduce((a, r) => a + r.amount, 0);
    if (refunded > refundablePaid(s, period.paid, p.date) + 0.005) return t('mcp.error.refundExceedsPaid');
  }
  return undefined;
}

// ---------- 金额 ----------

export const FALLBACK_FX: FxTable = {
  base: 'USD',
  fetchedAt: '2026-10-19',
  rates: {
    USD: 1,
    CNY: 7.12,
    HKD: 7.78,
    TWD: 32.1,
    JPY: 151.5,
    EUR: 0.92,
    GBP: 0.77,
    TRY: 41.9,
    NGN: 1530,
    PHP: 58.4,
    INR: 88.6,
    KRW: 1390,
    SGD: 1.3,
    MYR: 4.25,
    THB: 34.2,
    VND: 26300,
    IDR: 16400,
    AUD: 1.52,
    CAD: 1.39,
    BRL: 5.4,
    ARS: 1400,
    EGP: 48.5,
    PKR: 281,
    RUB: 81,
    UAH: 41.5,
    KZT: 535,
    CHF: 0.8,
  },
};

export function convert(amount: number, from: string, to: string, fx: FxTable): number {
  if (from === to) return amount;
  const a = fx.rates[from] ?? FALLBACK_FX.rates[from];
  const b = fx.rates[to] ?? FALLBACK_FX.rates[to];
  if (!a || !b) return NaN;
  return (amount / a) * b;
}

/** 成员的加入日：缺省为开始合租那天，再缺省为订阅开始日 */
export function memberSince(s: Subscription, m: Pick<ShareMember, 'joined'>): string {
  return m.joined ?? s.share?.since ?? s.start;
}

/** 合租向成员收钱的最后一天：订阅结束日；暂停中的订阅到暂停前一天（与 memberDues 同一口径，暂停期间不生成新的应收期） */
export function shareLastDay(s: Pick<Subscription, 'end' | 'status' | 'pausedAt' | 'stop'>): string | undefined {
  const pausedFrom = pausedFromOf(s);
  const paused = pausedFrom ? addDays(pausedFrom, -1) : undefined;
  return [s.end, paused].filter((d): d is string => !!d).sort()[0];
}

/** 加入日当天生效，退出日当天已离开。 */
export function memberAboard(m: { joined?: string; left?: string }, day: string): boolean {
  return (!m.joined || m.joined <= day) && (!m.left || m.left > day);
}

/** 我实际承担的比例（合租发起人扣除他人份额；加入的成员 price 本就是自己那份） */
export function myShareFactor(s: Subscription, day: string): number {
  // 代付：全额由对方承担
  if (s.proxy) return 0;
  const sh = s.share;
  if (!sh || sh.role !== 'owner' || s.price <= 0) return 1;
  const others = sh.members.reduce((t, m) => t + (m.exempt || !memberAboard(m, day) ? 0 : (memberFeePoint(m, day)?.share ?? m.share) || 0), 0);
  return Math.max(0, (s.price - others) / s.price);
}

/**
 * 每月折算（原币，全额）。多阶段订阅按 day 当天的阶段算，币种为 currentPhase 的币种；
 * 换区后新旧两段并行时两边都在真实付钱，按两段之和计（另一段按 fx 折成当前段的币种，缺省用内置汇率）
 */
export function monthlyGross(s: Subscription, day?: string, fx: FxTable = FALLBACK_FX): number {
  if (s.phases?.length) {
    if (!day) return monthlyGross(phaseSubs(s).pop()!);
    const cur = currentPhase(s, day);
    const others = activePhases(s, day).filter((v) => v.start !== cur.start);
    // 并行段折算不了（缺汇率）时整体为 NaN，不把那一段当成 0
    return others.reduce((a, v) => a + convert(monthlyGross(v, day), v.currency, cur.currency, fx), monthlyGross(cur, day));
  }
  if (s.cycle.unit === 'lifetime') return 0;
  const p = day ? priceAt(s, day) : s.price;
  // 有赠送时长：这一期的钱摊到「周期 + 赠送」上，赠送结束后恢复正常
  const b = s.bonus;
  const days = cycleDays(s.cycle) + (b && (!day || day < b.until) ? Math.max(0, diffDays(b.from, b.until)) : 0);
  return (p * DAYS_PER_MONTH) / days;
}

/** monthlyGross's plan-price basis, retaining each concurrent phase's native currency. */
export function monthlyPriceTotal(state: AppState, s: Subscription, day: string, to = state.settings.baseCurrency): FxTotal {
  if (!s.phases?.length) return convertedTotal(state, monthlyGross(s, day), s.currency, undefined, to);
  const cur = currentPhase(s, day);
  return sumTotals([cur, ...activePhases(s, day).filter((v) => v.start !== cur.start)].map((v) => monthlyPriceTotal(state, v, day, to)));
}

/** 计入每月成本的阶段：day 当天在跑的各段（并行时都算），都不在跑时取最近的一段 */
function billedPhases(s: Subscription, day: string): Subscription[] {
  const vs = activePhases(s, day);
  return vs.length ? vs : [currentPhase(s, day)];
}

/**
 * 每月折算到本位币、我承担的部分；多阶段订阅按 day 所在阶段的价格和币种算，并行的几段相加。
 * 给了 methodId 时只算用这个支付方式付的那几段（钱包按卡统计）
 */
export function monthlyMine(state: AppState, s: Subscription, day: string, methodId?: string): number {
  return billedMonthly(state, s, day, methodId).mine;
}

/** 计费中各段的每月全额与我承担的部分（本位币）；折算不了时返回 NaN。monthlyMine 与 totals 共用 */
function billedMonthly(state: AppState, s: Subscription, day: string, methodId?: string): { gross: number; mine: number } {
  let gross = 0;
  let mine = 0;
  for (const v of billedPhases(s, day)) {
    if ((methodId !== undefined && v.methodId !== methodId) || !['active', 'ending'].includes(effectiveStatus(v, day))) continue;
    const m = convert(monthlyGross(v, day), v.currency, state.settings.baseCurrency, state.fx);
    gross += m;
    mine += m * myShareFactor(v, day);
  }
  return { gross, mine };
}

/** Monthly totals keep the billing/status and built-in current-FX fallback rules. */
export function monthlyTotal(state: AppState, s: Subscription, day: string, methodId?: string, gross = false, to = state.settings.baseCurrency): FxTotal {
  return sumTotals(
    billedPhases(s, day)
      .filter((v) => (methodId === undefined || v.methodId === methodId) && ['active', 'ending'].includes(effectiveStatus(v, day)))
      .map((v) => {
        const original = monthlyGross(v, day) * (gross ? 1 : myShareFactor(v, day));
        return amountTotal(original, v.currency, convert(original, v.currency, to, state.fx));
      }),
  );
}
export interface Totals {
  partial: { mrr: FxTotal; gross: FxTotal; recover: FxTotal };
  mrr: number; // 我承担的部分，正数，展示时加负号
  grossMrr: number;
  recoverMrr: number; // 合租每月回血
  activeCount: number;
  incomplete: boolean;
}

export function totals(state: AppState, today: string): Totals {
  let mrr = 0;
  let gross = 0;
  let count = 0;
  for (const s of state.subscriptions) {
    // 代付是替别人付的钱，不算我的订阅，也不计入数量与总额
    if (s.proxy) continue;
    const st = effectiveStatus(s, today);
    if (st !== 'active' && st !== 'ending' && st !== 'trial') continue;
    // 数量只算正在计费的；试用期不计入数量与金额（和列表的「订阅中」一致）
    if (st !== 'trial') count++;
    // 试用期不计入数量与金额
    if (st === 'trial') continue;
    // 换区后新旧两段并行时两边都在付钱，都计入
    const m = billedMonthly(state, s, today);
    gross += m.gross;
    mrr += m.mine;
  }
  const eligible = state.subscriptions.filter((s) => !s.proxy && ['active', 'ending'].includes(effectiveStatus(s, today)));
  const mine = sumTotals(eligible.map((s) => monthlyTotal(state, s, today)));
  const full = sumTotals(eligible.map((s) => monthlyTotal(state, s, today, undefined, true)));
  return {
    partial: { mrr: mine, gross: full, recover: sumTotals([full, scaleTotal(mine, -1)]) },
    mrr,
    grossMrr: gross,
    recoverMrr: gross - mrr,
    activeCount: count,
    incomplete: !Number.isFinite(mrr) || !Number.isFinite(gross),
  };
}

// ---------- 余额续航 ----------

export interface Runway {
  partial: { current: FxTotal; monthlyDrain: FxTotal; topUp12m: FxTotal };
  method: PaymentMethod;
  /** 今天的估算余额（asOf 之后的扣款已扣除） */
  current: number;
  monthlyDrain: number;
  /** 余额首次不足以支付的那笔扣款；今天这笔不够时就是今天；current 始终扣到今天，充值和校准都以它为准 */
  shortfall?: Charge;
  /** 扣那一笔之前还剩多少 */
  beforeShortfall?: number;
  /** 校准之后到今天已经扣掉的金额（账户币种） */
  spentSince: number;
  /** 今天到期的扣款：校准日设为今天时，它们算已包含在余额里 */
  dueToday: Array<Charge & { amountInMethod: number }>;
  /** 余额还能完整支付的期数 */
  coveredCharges: number;
  runsOutOn?: string;
  /** 撑满未来 12 个月还需充值多少（账户币种） */
  topUp12m: number;
  /** 有扣款或月消耗缺汇率：从那一笔起余额、充值额为 NaN，不跳过 */
  incomplete: boolean;
  /** 完整推演，供充值计划使用；明细单独截断 */
  forecast: Array<Charge & { balanceAfter: number; amountInMethod: number; partial: FxTotal; balancePartial: FxTotal }>;
  upcoming: Runway['forecast'];
  /** 设了余额到期日、到期时还有余额：那天作废多少（账户币种）；早于今天的表示已经作废 */
  expiring?: { date: string; amount: number };
}

/**
 * 在表单里改余额：填的是今天的数，校准日跟着到今天，否则旧校准日之后的扣款会再扣一遍。
 * 手动选过日期的按选的算；改回原来的数等于没改；清空余额时校准日一起清。
 */
export function editedBalance(m: Pick<PaymentMethod, 'balance' | 'balanceAsOf'>, balance: number | undefined, today: string, picked?: string) {
  if (balance == null) return { balance: undefined, balanceAsOf: undefined };
  const balanceAsOf = picked ?? (balance === m.balance ? m.balanceAsOf : undefined) ?? today;
  return { balance, balanceAsOf };
}

/** 仍有效的余额到期日：早于校准日（未来校准日按今天算）的视为已失效，返回 undefined */
export function liveExpiry(m: Pick<PaymentMethod, 'balance' | 'balanceAsOf' | 'balanceExpires'>, today: string): string | undefined {
  if (m.balance == null || !m.balanceExpires) return undefined;
  const asOf = m.balanceAsOf && m.balanceAsOf < today ? m.balanceAsOf : today;
  return m.balanceExpires >= asOf ? m.balanceExpires : undefined;
}

export function runwayFor(method: PaymentMethod, state: AppState, today: string, horizonMonths = 36): Runway | undefined {
  if (method.balance == null) return undefined;
  // 按阶段展开：换区前后可能用不同的支付方式。月消耗仍按阶段的支付方式
  const phases = state.subscriptions.flatMap(phaseSubs);
  const subs = phases.filter((s) => s.methodId === method.id);
  // 校准日写成未来时按今天算，否则这段时间的扣款会被跳过
  const asOf = method.balanceAsOf && method.balanceAsOf < today ? method.balanceAsOf : today;
  const horizon = addMonths(today, Math.max(12, horizonMonths));
  // 余额按每笔实际的来源扣：单笔记的支付方式优先，拆分付款按份额；预测的扣款没有单笔记录，仍归阶段的支付方式
  const share = (c: Charge) => chargeSources(c).reduce((a, x) => a + (x.methodId === method.id ? x.share : 0), 0);
  // 余额按实际扣款日走：分开记的合并缴只扣一次（见 cashChargesBetween）
  const charges = phases
    .flatMap((s) => cashChargesBetween(s, addDays(asOf, 1), horizon, today))
    .map((c) => ({ c, share: share(c) }))
    .filter((x) => x.share > 0)
    .sort((a, b) => a.c.date.localeCompare(b.c.date));
  let bal = method.balance;
  const forecast: Runway['forecast'] = [];
  // 代付各期记过的卡上实扣
  const proxyCharges = new Map(
    state.subscriptions.filter((s) => s.proxy?.charged?.length).map((s) => [s.id, new Map(s.proxy!.charged!.map((c) => [c.charge, c]))]),
  );
  let shortfall: Charge | undefined;
  let beforeShortfall: number | undefined;
  let spentSince = 0;
  const dueToday: Runway['dueToday'] = [];
  let covered = 0;
  let current = bal;
  let incomplete = false;
  let balancePartial = amountTotal(method.balance, method.currency, method.balance);
  let currentPartial = balancePartial;
  // 余额到期：到期日当天的扣款照常，之后剩余的正余额作废；欠着的（负数）和算不出的（NaN）不动。早于校准日的到期日已失效
  const expires = liveExpiry(method, today);
  let expiring: Runway['expiring'];
  const yearOut = addMonths(today, 12);
  let yearBal = bal;
  let yearPartial = balancePartial;
  const expire = () => {
    if (expiring || !expires) return;
    expiring = { date: expires, amount: Number.isFinite(bal) ? Math.max(0, bal) : NaN };
    if (bal > 0) {
      bal = 0;
      balancePartial = amountTotal(0, method.currency, 0);
    }
    if (expires < today) {
      current = bal;
      currentPartial = balancePartial;
    }
    if (expires <= yearOut) {
      yearBal = bal;
      yearPartial = balancePartial;
    }
  };
  for (const { c, share } of charges) {
    if (expires && c.date > expires) expire();
    const entry = proxyCharges.get(c.sub.id)?.get(c.date);
    const settled = c.kind === 'failed' ? undefined : entry?.amount != null ? { amount: entry.amount, currency: entry.currency ?? c.currency } : c.settled;
    const amt = chargeBaseOrNaN(state, { ...c, settled }, method.currency) * share;
    // 缺汇率的扣款照样扣：余额从这里起不可知（NaN），而不是假装没扣
    if (!Number.isFinite(amt)) incomplete = true;
    const partial = scaleTotal(chargeTotal(state, { ...c, settled }, method.currency), share);
    balancePartial = sumTotals([balancePartial, scaleTotal(partial, -1)]);
    if (c.date === today && !c.kind && amt !== 0) dueToday.push({ ...c, amountInMethod: amt });
    // 退款、失败记录不会让余额不够；过去的扣款已经发生，只有今天和之后才谈得上付不付得起
    if (!shortfall && c.date >= today && amt > 0 && bal - amt < -1e-9) {
      shortfall = c;
      beforeShortfall = bal;
    }
    if (c.date <= today) {
      if (!shortfall) spentSince += amt;
      currentPartial = balancePartial;
      bal -= amt;
      current = bal;
      yearBal = bal;
      yearPartial = balancePartial;
      continue;
    }
    bal -= amt;
    if (!shortfall && Number.isFinite(bal)) covered++;
    forecast.push({ ...c, balanceAfter: bal, amountInMethod: amt, partial, balancePartial });
    if (c.date <= yearOut) {
      yearBal = bal;
      yearPartial = balancePartial;
    }
  }
  if (expires && expires <= horizon) expire();
  let monthlyDrain = 0;
  for (const s of subs) {
    const st = effectiveStatus(s, today);
    if (st === 'active' || st === 'ending') monthlyDrain += convert(monthlyGross(s, today), s.currency, method.currency, state.fx);
  }
  if (!Number.isFinite(monthlyDrain)) incomplete = true;
  return {
    partial: {
      current: currentPartial,
      monthlyDrain: sumTotals(
        subs
          .filter((s) => ['active', 'ending'].includes(effectiveStatus(s, today)))
          .map((s) => amountTotal(monthlyGross(s, today), s.currency, convert(monthlyGross(s, today), s.currency, method.currency, state.fx))),
      ),
      // 撑满 12 个月要补的 = 12 个月后的余额缺口；余额到期作废也算在里面
      topUp12m: scaleTotal(yearPartial, -1),
    },
    method,
    current,
    monthlyDrain,
    incomplete,
    shortfall,
    beforeShortfall,
    spentSince,
    dueToday,
    coveredCharges: covered,
    runsOutOn: shortfall?.date,
    topUp12m: Number.isFinite(yearBal) ? Math.max(0, -yearBal) : NaN,
    forecast,
    upcoming: forecast.slice(0, 60),
    ...(expiring && expiring.amount > 0.005 ? { expiring } : {}),
  };
}

// ---------- 合租 ----------

export interface MemberDue {
  sub: Subscription;
  member: NonNullable<Subscription['share']>['members'][number];
  /** 最早未覆盖的收款起始日 */
  dueFor: string;
  owed: number;
  currency: string;
  periodsOwed: number;
  /** Native unpaid amounts when a fee-currency change cannot be consolidated. */
  originals?: Record<string, number>;
}

export { LIFETIME_BILL_MONTHS, validBillMonths };

/** 旧成员未设置周期时沿用订阅周期。 */
export function memberBillMonths(s: Subscription, m: ShareMember, day?: string): number {
  const months = Math.round(memberFeePoint(m, day)?.billEvery ?? m.billEvery ?? cycleDays(s.cycle) / DAYS_PER_MONTH);
  return Math.min(LIFETIME_BILL_MONTHS, Math.max(1, Number.isFinite(months) ? months : LIFETIME_BILL_MONTHS));
}

/** 无历史的旧成员继续读原字段；历史按生效日读取，不依赖系统时间。 */
export function memberFeePoint(m: ShareMember, day?: string) {
  const history = [...(m.feeHistory ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  return history.filter((p) => !day || p.from <= day).at(-1) ?? history[0];
}

/** 合租收款币种：设置里选过的，否则本位币。memberRate 等收费计算一律传它，不再各自缺省 */
export function collectCurrencyOf(settings: Pick<Settings, 'collectCurrency' | 'baseCurrency'>): string {
  return settings.collectCurrency ?? settings.baseCurrency;
}

/** collectCurrency：旧成员只填了 fee、没填 feeCurrency 时的收费币种，传 collectCurrencyOf(settings) */
export function memberRate(s: Subscription, m: ShareMember, day: string, collectCurrency: string) {
  const point = memberFeePoint(m, day);
  const billEvery = memberBillMonths(s, m, day);
  const amount = point?.fee ?? m.fee ?? ((m.share || 0) * billEvery) / (cycleDays(s.cycle) / DAYS_PER_MONTH);
  const currency = point?.currency ?? (m.fee != null ? (m.feeCurrency ?? collectCurrency) : s.currency);
  return { amount: Math.round(amount * 100) / 100, currency, billEvery };
}

/** 车的收款节奏基准日：存过的为准，否则依次取开始合租日、最早一笔收款抵扣的期、订阅开始日 */
export function collectionAnchor(s: Subscription): string {
  if (s.share?.collectFrom) return s.share.collectFrom;
  if (s.share?.since) return s.share.since;
  const starts = (s.share?.members ?? []).flatMap((m) => (m.receipts ?? []).flatMap((r) => r.periods));
  return starts.sort()[0] ?? s.start;
}

/**
 * 某天适用的收款基准日：成员钉了自己的基准日（车改过收款日）时用它；
 * 车的收款日（collectFrom）只对生效日起的期起作用，之前的期沿用开始合租时的节奏，不会倒推切出碎期
 */
function anchorOn(s: Subscription, m: ShareMember, day: string): string {
  if (m.anchor) return m.anchor;
  const from = s.share?.collectFrom;
  if (!from || day >= from) return collectionAnchor(s);
  const before = collectionAnchor({ ...s, share: { ...s.share!, collectFrom: undefined } });
  return before < from ? before : from;
}

/** 包含 day 的对齐期。每次从原始 anchor 加月，短月夹紧不会累积漂移。 */
export function collectionPeriod(s: Subscription, m: ShareMember, day: string) {
  const anchor = anchorOn(s, m, day);
  const every = memberBillMonths(s, m, memberSince(s, m));
  const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  let k = Math.floor((monthIndex(day) - monthIndex(anchor)) / every);
  while (addMonths(anchor, k * every) > day) k--;
  while (addMonths(anchor, (k + 1) * every) <= day) k++;
  const from = addMonths(anchor, k * every);
  const next = addMonths(anchor, (k + 1) * every);
  return { from, until: addDays(next, -1), next };
}

/** 重新起算前剩下的天数不超过 7 天、也不超过一期的十分之一时，并进前一期（月付最多 3 天） */
const STUB_DAYS = 7;

/**
 * 成员的应收期：从加入日起按条款切——首期对齐车的收款节奏，之后按成员自己的周期接着切；
 * 与收没收钱无关，所以可以单独收第 3 期、留着第 2 期。到退出日、订阅结束或 last 为止
 */
export function memberPeriods(s: Subscription, m: ShareMember, last: string, collectCurrency: string, legacyDrift = false): Period[] {
  const out: Period[] = [];
  const end = shareLastDay(s);
  for (let from = memberSince(s, m), guard = 0; from <= last && guard < 1200; guard++) {
    if ((m.left && from >= m.left) || (end && from > end)) break;
    const c = memberCollection(s, m, from, collectCurrency, legacyDrift);
    out.push({ key: c.from, from: c.from, until: c.until, due: c.amount, currency: c.currency });
    if (c.next <= from) break;
    from = c.next;
  }
  return out;
}

/**
 * 成员的应收账：各期加上收款、免收推算出的状态。至少算到 through（缺省今天），
 * 收款、免收抵扣到更晚的期（提前收）时一直算到那一期
 */
export function memberLedger(s: Subscription, m: ShareMember, today: string, collectCurrency: string, through = today) {
  const keys = [...(m.receipts ?? []), ...(m.waivers ?? [])].flatMap((x) => x.periods);
  const last = keys.reduce((a, k) => (k > a ? k : a), through);
  return settle(memberPeriods(s, m, last, collectCurrency), m, today);
}

/**
 * 成员每期从哪天起收：最近一次节奏重起（restarts）那天的日子，否则是收款基准日的日子。
 * 29–31 号起收的，短月夹到月底后下一期回到原来的日子，不会一路漂到 28 号
 */
function collectionDayOf(s: Subscription, m: ShareMember, from: string): number {
  const restart = (m.restarts ?? [])
    .filter((r) => r <= from)
    .sort()
    .at(-1);
  return Number((restart ?? anchorOn(s, m, from)).slice(8, 10));
}
/** 把某天挪到同月的第 day 号（短月夹到月底），只往后挪 */
function onCollectionDay(date: string, day: number): string {
  const last = Number(addDays(addMonths(date.slice(0, 8) + '01', 1), -1).slice(8, 10));
  const want = Math.min(day, last);
  return want > Number(date.slice(8, 10)) ? `${date.slice(0, 8)}${String(want).padStart(2, '0')}` : date;
}

/** 只有首次未收款的加入期对齐统一日；之后按成员自己的覆盖起点收完整一期。 */
export function memberCollection(s: Subscription, m: ShareMember, from: string, collectCurrency: string, legacyDrift = false) {
  const joined = memberSince(s, m);
  const first = collectionPeriod(s, m, joined);
  const isFirst = from === joined;
  const rate = memberRate(s, m, from, collectCurrency);
  const natural = isFirst
    ? first.next
    : legacyDrift
      ? addMonths(from, rate.billEvery)
      : onCollectionDay(addMonths(from, rate.billEvery), collectionDayOf(s, m, from));
  // 收款节奏从某天起重新起算（比如订阅断过又在别的日子续上）：这一期截到那天前一天，按天折算
  const restart = (m.restarts ?? []).filter((r) => r > from && r < natural).sort()[0];
  // 期满后不到半个月就重新起算：中间剩下的几天并进这一期，不单独切出按天折算的碎期
  const stub = (r: string) => diffDays(natural, r) <= Math.min(STUB_DAYS, diffDays(from, natural) / 10);
  // 旧版切法（legacyDrift）只用来对齐迁移前的期，保持原样不并
  const stretch = restart || legacyDrift ? undefined : (m.restarts ?? []).filter((r) => r > natural && stub(r)).sort()[0];
  const next = restart ?? stretch ?? natural;
  const until = isFirst && m.left && m.left <= next ? addDays(m.left, -1) : addDays(next, -1);
  const partial = (isFirst && (joined > first.from || until < first.until)) || !!restart;
  let amount = rate.amount;
  if (partial && !isFirst) amount = (amount * (diffDays(from, until) + 1)) / (diffDays(from, addDays(natural, -1)) + 1);
  else if (partial) {
    const mode = m.firstPeriod ?? 'prorate';
    amount =
      mode === 'free'
        ? 0
        : (m.firstAmount ?? (mode === 'full' ? amount : (amount * Math.max(0, diffDays(from, until) + 1)) / (diffDays(first.from, first.until) + 1)));
  }
  const fixed = m.periodDues?.find((d) => d.from === from);
  if (fixed) amount = fixed.amount;
  const end = shareLastDay(s);
  if (m.exempt || until < from || (m.left && from >= m.left) || (end && from > end)) amount = 0;
  return { from, until, next: addDays(until, 1) > from ? addDays(until, 1) : next, amount: Math.round(amount * 100) / 100, currency: rate.currency, partial };
}

/**
 * 最早一期还没结清的起始日（欠着的或还没到期的）；免费首期、已免收的期跳过。
 * 都结清了（比如已退出）时返回最后一期之后的那天
 */
export function memberUnpaidFrom(s: Subscription, m: ShareMember): string {
  const joined = memberSince(s, m);
  if (m.exempt) return joined;
  for (let years = 2; years <= 128; years *= 2) {
    // 收费币种只影响各期的币种标签，不影响结清状态，这里不需要设置
    const { periods } = memberLedger(s, m, joined, s.currency, addMonths(joined, 12 * years));
    const open = periods.find((p) => !isSettled(p));
    if (open) return open.from;
    const last = periods.at(-1);
    const end = shareLastDay(s);
    if (last && ((m.left && addDays(last.until, 1) >= m.left) || (end && addDays(last.until, 1) > end))) return addDays(last.until, 1);
  }
  return joined;
}

export function memberDues(s: Subscription, today: string, collectCurrency: string, fxState?: Pick<AppState, 'fx' | 'fxHistory' | 'settings'>): MemberDue[] {
  if (!s.share || s.share.role !== 'owner') return [];
  const stop = [
    shareLastDay(s),
    s.status === 'paused' && !s.pausedAt ? addDays(today, -1) : undefined,
    undatedStop(s) ? (lastCharge(s, today) ?? s.start) : undefined,
    today,
  ]
    .filter((d): d is string => !!d)
    .sort()[0];
  return s.share.members.map((m) => {
    const dueFor = memberUnpaidFrom(s, m);
    const currency = memberCollection(s, m, dueFor, collectCurrency).currency;
    const until = m.left && m.left <= stop ? addDays(m.left, -1) : stop;
    let owed = 0;
    let periodsOwed = 0;
    const originals: Record<string, number> = {};
    if (!m.exempt) {
      // 欠着的期：已经开始、没收也没免的；中间收过的期不算，可以不连续
      for (const period of memberLedger(s, m, until, collectCurrency).periods.filter((p) => p.status === 'due')) {
        originals[period.currency] = (originals[period.currency] ?? 0) + period.due;
        if (period.due !== 0 && period.currency !== currency && !fxState) throw new Error('FX state required for member fee currency changes');
        owed +=
          period.due === 0 || period.currency === currency
            ? period.due
            : convertOn(period.due, period.currency, currency, today, fxState!.fxHistory, fxState!.fx);
        periodsOwed++;
      }
    }
    return { sub: s, member: m, dueFor, owed: Math.round(owed * 100) / 100, currency, periodsOwed, ...(!Number.isFinite(owed) ? { originals } : {}) };
  });
}

/** FNV-1a 32 位哈希：同样的文本得到同样的值，供稳定 id、配色与公开页 id 脱敏 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** History's rounded-month rule is shared by every gap-duration label. */
export function durationLabel(days: number, kind: 'duration' | 'gap' = 'duration'): string {
  const months = Math.round(days / DAYS_PER_MONTH);
  const key = kind === 'gap' ? (months >= 1 ? 'editor.history.gapMonths' : 'editor.history.gapDays') : months >= 1 ? 'list.gantt.months' : 'list.gantt.days';
  return t(key, { count: months >= 1 ? months : days });
}

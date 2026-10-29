import { amountTotal, chargeTotal, convertedTotal, dueTotal, emptyTotal, scaleTotal, sumTotals, totalRatio, type FxTotal } from './fx-total.ts';
import { contributionTotal, mrrTotal } from './metrics.ts';
import { memberCashFlows, memberFlowValue } from './carpool.ts';
import { addDays, addMonths, chargesBetween, collectCurrencyOf, memberDues, myShareFactor, phaseSubs, totals, type Charge, chargeSources } from './billing.ts';
import { diffDays, effectiveStatus, isStopped } from './billing.ts';
import { chargeValue, toBaseOrNaN } from './fx.ts';
import {
  stopHistory,
  cashVsAccrual,
  contributionOn,
  events,
  monthEnd,
  movement,
  mrrChangeSinceLastMonth,
  mrrOn,
  stopLosses,
  type CashAccrual,
  type LedgerEvent,
  type Movement,
  type StopLoss,
} from './metrics.ts';
import type { AppState, Subscription } from './types.ts';
import { transferRows } from './transfers.ts';

export interface Comparison {
  amount: number;
  /** Undefined when the comparison period has zero or negative net cash. */
  percent?: number;
}

export interface ChargeRow {
  sub: Subscription;
  date: string;
  /** Base currency, my share; refunds are negative. */
  amount: number;
  original: Charge;
  partial?: FxTotal;
}

export interface CompositionRow {
  key: string;
  amount: number;
  share: number;
  other?: true;
  partial?: FxTotal;
}

export type MovementRow = Movement['items'][number] & {
  from: number;
  to: number;
  /** One event date, or the span of events contributing to this net change. */
  since: string;
  until: string;
};

export type ReportEvent = Pick<LedgerEvent, 'date' | 'sub' | 'delta' | 'partial'> & { kind: LedgerEvent['kind'] | 'trial' | 'cancel' };

export type Block = (
  | {
      type: 'headline';
      mode: 'scope';
      mrr: number;
      annual: number;
      activeCount: number;
      paid: number;
      /** 1/1–12/31: paid through today plus the remaining forecast, same charge basis as paid. */
      year: number;
      loss: number;
      change: Comparison;
    }
  | { type: 'headline'; mode: 'total'; total: number; count: number; average: number; yearPaid: number; since: string }
  | { type: 'headline'; mode: 'month'; month: string; total: number; paid: number; pending: number; count: number; previous: Comparison; yearly?: Comparison }
  | { type: 'trend'; mode: 'scope'; rows: CashAccrual[] }
  | { type: 'trend'; mode: 'month'; month: string; movement: Omit<Movement, 'items'> & { items: MovementRow[] } }
  | { type: 'composition'; categories: CompositionRow[]; methods: CompositionRow[] }
  | { type: 'top'; mode: 'scope' | 'total'; rows: Array<{ sub: Subscription; amount: number; partial?: FxTotal }> }
  | { type: 'top'; mode: 'month'; rows: ChargeRow[] }
  | { type: 'upcoming'; rows: ChargeRow[]; total: number }
  | { type: 'events'; rows: ReportEvent[] }
  | { type: 'losses'; rows: StopLoss[]; refunds: ChargeRow[]; loss: number; refunded: number; incomplete: boolean }
  | {
      type: 'sharing';
      rows: Array<{ sub: Subscription; received: number; owed: number; partial?: { received: FxTotal; owed: FxTotal } }>;
      received: number;
      owed: number;
    }
) & { partial?: Record<string, FxTotal> };

export interface ScopeLifecycle {
  spent: FxTotal;
  averageDays: number;
  activeCount: number;
  stoppedCount: number;
  /** Monthly cost of the stopped subscriptions on their last billed day; shown when nothing in the selection is still billing. */
  stoppedMonthly: FxTotal;
  terminatedCount: number;
  loss: FxTotal;
  terminationLoss: FxTotal;
  stops: StopLoss[];
  timeline: Subscription[];
  omitted: number;
  /** Net cash at my share, refunds included, apportioned to the historical charge phase/method. */
  spending: Array<{ sub: Subscription; methodId?: string; region: string; category: string; total: FxTotal }>;
}

export interface ScopeReport {
  blocks: Block[];
  /** Selection-only facts; calendar reports retain their existing block contract. */
  lifecycle?: ScopeLifecycle;
}

export interface CashSpan {
  total: number;
  paid: number;
  pending: number;
  partial: { total: FxTotal; paid: FxTotal; pending: FxTotal };
}

export interface MonthCash extends CashSpan {
  month: string;
}

const sum = (rows: Array<{ amount: number }>) => rows.reduce((a, r) => a + r.amount, 0);
const compare = (amount: number, previous: number): Comparison => ({
  amount: amount - previous,
  percent: previous > 0 ? (amount - previous) / previous : undefined,
});
const byAmount = (a: { sub: Subscription; amount: number }, b: { sub: Subscription; amount: number }) =>
  b.amount - a.amount || a.sub.id.localeCompare(b.sub.id);

function rowTotal(rows: Array<{ amount: number; partial?: FxTotal }>): FxTotal {
  return sumTotals(rows.map((r) => r.partial ?? amountTotal(r.amount, '', r.amount)));
}
function cashMonth(rows: Array<{ date: string; amount: number; partial?: FxTotal }>, month: string, today: string): MonthCash {
  return { month, ...cashSpan(rows, today) };
}
function cashSpan(rows: Array<{ date: string; amount: number; partial?: FxTotal }>, today: string): CashSpan {
  return {
    total: sum(rows),
    paid: sum(rows.filter((r) => r.date <= today)),
    pending: sum(rows.filter((r) => r.date > today)),
    partial: {
      total: rowTotal(rows),
      paid: rowTotal(rows.filter((r) => r.date <= today)),
      pending: rowTotal(rows.filter((r) => r.date > today)),
    },
  };
}

type CashRow = { sub: Subscription; date: string; amount: number; partial?: FxTotal };
/** 净现金：扣款（我的份额、含退款）加转让收付；today 之后按当前计划预计。 */
function cashRows(state: AppState, from: string, to: string, today: string, list = charges(state, from, to, today)): CashRow[] {
  return [
    ...list,
    ...transferRows(state, from, to, today).map((r) => ({
      ...r,
      partial: amountTotal(r.transfer.amount * (r.transfer.kind === 'buy' ? 1 : -1), r.transfer.currency, r.amount),
    })),
  ];
}

function charges(state: AppState, from: string, to: string, today: string): ChargeRow[] {
  return state.subscriptions
    .flatMap((sub) =>
      chargesBetween(sub, from, to, today)
        .filter((c) => c.kind !== 'failed')
        .map((c) => ({
          sub,
          date: c.date,
          amount: chargeValue(state, c) * myShareFactor(c.sub, c.date),
          original: c,
          partial: scaleTotal(chargeTotal(state, c), myShareFactor(c.sub, c.date)),
        })),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.sub.id.localeCompare(b.sub.id));
}

/** Ranked composition: at most six rows, with the tail sharing one explicit Other row. */
export function compactComposition(rows: readonly CompositionRow[]): CompositionRow[] {
  if (rows.length <= 6) return [...rows];
  const rest = rows.slice(5);
  return [
    ...rows.slice(0, 5),
    {
      key: '',
      other: true,
      amount: sum(rest),
      share: rest.reduce((a, r) => a + r.share, 0),
      ...(rest.some((r) => r.partial) ? { partial: rowTotal(rest) } : {}),
    },
  ];
}

function composition(rows: Array<{ key: string; amount: number; partial?: FxTotal }>): CompositionRow[] {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  const total = rowTotal(rows);
  return compactComposition(
    [...groups]
      .map(([key, list]) => {
        const partial = rowTotal(list);
        return { key, amount: partial.value, share: totalRatio(partial, total), partial };
      })
      .filter((r) => r.amount > 0 || r.partial.incomplete)
      .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key)),
  );
}

function addComposition(blocks: Block[], cat: CompositionRow[], pay: CompositionRow[], scope: boolean) {
  const categories = scope && cat.length === 1 ? [] : cat;
  const methods = pay.length > 1 ? pay : [];
  if (categories.length || methods.length) blocks.push({ type: 'composition', categories, methods });
}

function details(
  state: AppState,
  today: string,
  from: string,
  to: string,
  lossRange: { from: string; to: string } | undefined,
  sharingFrom: string,
  sharingTo: string,
): Block[] {
  const blocks: Block[] = [];
  const roots = new Map(state.subscriptions.map((s) => [s.id, s]));
  // events() emits end-of-service on the following day and only after it has passed.
  const rows: ReportEvent[] = events(state, addDays(to, 1))
    .filter((e) => e.date >= from && e.date <= to && e.kind !== 'buy' && e.kind !== 'pause')
    .map((e) => ({ date: e.date, delta: e.delta, partial: e.partial, kind: e.kind === 'end' && e.sub.stop ? 'cancel' : e.kind, sub: roots.get(e.sub.id)! }));
  for (const sub of state.subscriptions) {
    if (
      sub.trialEnd &&
      sub.trialEnd >= from &&
      sub.trialEnd <= to &&
      (sub.status !== 'cancelled' || sub.end) &&
      (!sub.end || sub.end >= sub.trialEnd) &&
      (!sub.stop || sub.stop.date >= sub.trialEnd)
    )
      rows.push({ sub, date: sub.trialEnd, kind: 'trial', delta: 0 });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.sub.id.localeCompare(b.sub.id) || a.kind.localeCompare(b.kind));
  if (rows.length) blocks.push({ type: 'events', rows });

  const losses = stopLosses(state, today, lossRange);
  // Fully refunded stops are deliberately absent from stopLosses(); use cash records for refunds.
  const refunds = charges(state, lossRange?.from ?? '0001-01-01', lossRange?.to && lossRange.to < today ? lossRange.to : today, today).filter(
    (r) => r.original.kind === 'refund' && (r.original.amount < 0 || (r.original.settled?.amount ?? 0) < 0),
  );
  if (losses.items.length || refunds.length)
    blocks.push({
      type: 'losses',
      rows: losses.items,
      refunds,
      loss: losses.total,
      refunded: -sum(refunds),
      incomplete: losses.incomplete,
      partial: { loss: losses.partial, refunded: scaleTotal(rowTotal(refunds), -1) },
    });

  const sharing = state.subscriptions
    .filter((s) => s.share?.role === 'owner')
    .map((sub) => {
      const received = sub
        .share!.members.flatMap(memberCashFlows)
        .filter((p) => p.date >= sharingFrom && p.date <= sharingTo && p.date <= today)
        .reduce((a, p) => a + memberFlowValue(state, p), 0);
      // Only still-unpaid periods originating in this window, not older arrears.
      const before = new Map(memberDues(sub, addDays(sharingFrom, -1), collectCurrencyOf(state.settings), state).map((d) => [d.member.id, d]));
      const owed = memberDues(sub, sharingTo, collectCurrencyOf(state.settings), state).reduce(
        (a, d) =>
          a +
          (Number.isFinite(d.owed) && Number.isFinite(before.get(d.member.id)?.owed ?? 0)
            ? toBaseOrNaN(state, Math.max(0, d.owed - (before.get(d.member.id)?.owed ?? 0)), d.currency, sharingTo > today ? undefined : sharingTo)
            : NaN),
        0,
      );
      const partial = {
        received: sumTotals(
          sub
            .share!.members.flatMap(memberCashFlows)
            .filter((p) => p.date >= sharingFrom && p.date <= sharingTo && p.date <= today)
            .map((p) => convertedTotal(state, p.amount, p.currency, p.date)),
        ),
        owed: sumTotals(
          memberDues(sub, sharingTo, collectCurrencyOf(state.settings), state).map((d) => {
            const prior = before.get(d.member.id);
            const date = sharingTo > today ? undefined : sharingTo;
            if (Number.isFinite(d.owed) && (!prior || Number.isFinite(prior.owed)))
              return convertedTotal(state, Math.max(0, d.owed - (prior?.owed ?? 0)), d.currency, date);
            const change = sumTotals([
              dueTotal(state, d, undefined, state.settings.baseCurrency, date),
              scaleTotal(prior ? dueTotal(state, prior, undefined, state.settings.baseCurrency, date) : emptyTotal(), -1),
            ]);
            return {
              ...change,
              value: Math.max(0, change.value),
              unconverted: Object.fromEntries(Object.entries(change.unconverted).map(([ccy, value]) => [ccy, Math.max(0, value)])),
            };
          }),
        ),
      };
      return { sub, received, owed, partial };
    })
    .filter((r) => r.received !== 0 || r.owed > 0 || !Number.isFinite(r.owed));
  if (sharing.length)
    blocks.push({
      type: 'sharing',
      rows: sharing,
      received: sharing.reduce((a, r) => a + r.received, 0),
      owed: sharing.reduce((a, r) => a + r.owed, 0),
      partial: { received: sumTotals(sharing.map((r) => r.partial.received)), owed: sumTotals(sharing.map((r) => r.partial.owed)) },
    });
  return blocks;
}

function selectionCash(state: AppState, today: string): CashAccrual[] {
  return cashVsAccrual(state, today, 11, 0).map((row) => {
    if (row.month !== today.slice(0, 7)) return row;
    const paid = charges(state, `${row.month}-01`, today, today);
    return { ...row, cash: sum(paid), partial: { ...row.partial, cash: rowTotal(paid) } };
  });
}

/** Selection lifecycle, while retaining legacy block fields for external clients. */
export function scopeReport(state: AppState, subs: readonly Subscription[], today: string): ScopeReport {
  const scoped = { ...state, subscriptions: subs.filter((s) => !s.proxy) };
  const first = scoped.subscriptions.reduce((m, s) => (s.start < m ? s.start : m), today);
  const rows = charges(scoped, first, today, today);
  const stops = stopHistory(scoped, today);
  const spentBySub = scoped.subscriptions.map((sub) => ({ sub, total: rowTotal(rows.filter((r) => r.sub.id === sub.id)) }));
  spentBySub.sort((a, b) => b.total.value - a.total.value || a.sub.id.localeCompare(b.sub.id));
  const stopped = scoped.subscriptions.filter((s) => isStopped(effectiveStatus(s, today)));
  const stoppedCount = stopped.length;
  const stoppedMonthly = sumTotals(
    stopped.map((s) => {
      const last = phaseSubs(s)
        .filter((p) => p.start <= today)
        .at(-1);
      const until = last?.stop ? addDays(last.stop.date, -1) : (last?.end ?? today);
      return contributionTotal(scoped, s, until < today ? until : today);
    }),
  );
  const lifecycle: ScopeLifecycle = {
    spent: rowTotal(rows),
    averageDays: scoped.subscriptions.length
      ? scoped.subscriptions.reduce((n, s) => {
          const last = phaseSubs(s)
            .filter((p) => p.start <= today)
            .at(-1);
          const end = last?.stop?.date ?? last?.end ?? today;
          return n + Math.max(0, diffDays(s.start, end < today ? end : today));
        }, 0) / scoped.subscriptions.length
      : 0,
    activeCount: totals(scoped, today).activeCount,
    stoppedCount,
    stoppedMonthly,
    terminatedCount: stops.filter((s) => s.kind === 'terminate').length,
    loss: stopLosses(scoped, today).partial,
    terminationLoss: sumTotals(stops.filter((s) => s.kind === 'terminate').map((s) => amountTotal(s.loss, s.currency, s.lossBase))),
    stops,
    timeline: spentBySub
      .slice(0, 12)
      .map((s) => s.sub)
      .sort((a, b) => b.start.localeCompare(a.start) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    omitted: Math.max(0, scoped.subscriptions.length - 12),
    spending: rows.flatMap((r) =>
      chargeSources(r.original).map((source) => ({
        sub: r.sub,
        methodId: source.methodId,
        region: r.original.sub.region ?? '',
        category: r.original.sub.category,
        total: scaleTotal(r.partial!, source.share),
      })),
    ),
  };
  return { ...legacyScopeReport(state, subs, today), lifecycle };
}

function legacyScopeReport(state: AppState, subs: readonly Subscription[], today: string): ScopeReport {
  const scoped = { ...state, subscriptions: subs.filter((s) => !s.proxy) };
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = `${today.slice(0, 4)}-12-31`;
  const mrr = mrrOn(scoped, today);
  // 没有任何持续计费（全是买断，或都已停止）时，月成本恒为 0，改看累计花了多少
  if (mrr === 0 && scoped.subscriptions.length) return totalReport(scoped, today, yearStart);
  const blocks: Block[] = [
    {
      type: 'headline',
      mode: 'scope',
      mrr,
      partial: {
        mrr: mrrTotal(scoped, today),
        annual: scaleTotal(mrrTotal(scoped, today), 12),
        paid: rowTotal(charges(scoped, yearStart, today, today)),
        year: rowTotal(charges(scoped, yearStart, yearEnd, today)),
        loss: stopLosses(scoped, today, { from: yearStart, to: today }).partial,
      },
      annual: mrr * 12,
      activeCount: totals(scoped, today).activeCount,
      paid: sum(charges(scoped, yearStart, today, today)),
      year: sum(charges(scoped, yearStart, yearEnd, today)),
      loss: stopLosses(scoped, today, { from: yearStart, to: today }).total,
      change: { amount: mrrChangeSinceLastMonth(scoped, today) },
    },
  ];
  const cash = selectionCash(scoped, today);
  if (cash.some((r) => r.cash !== 0)) blocks.push({ type: 'trend', mode: 'scope', rows: cash });
  const live = scoped.subscriptions
    .map((sub) => ({ sub, amount: contributionOn(scoped, sub, today), partial: contributionTotal(scoped, sub, today) }))
    .filter((r) => r.amount > 0 || r.partial.incomplete);
  addComposition(
    blocks,
    composition(live.map((r) => ({ key: r.sub.category, amount: r.amount, partial: r.partial }))),
    composition(
      scoped.subscriptions.flatMap((s) =>
        phaseSubs(s).map((p) => ({ key: p.methodId ?? '', amount: contributionOn(scoped, p, today), partial: contributionTotal(scoped, p, today) })),
      ),
    ),
    true,
  );
  if (live.length) blocks.push({ type: 'top', mode: 'scope', rows: live.sort(byAmount).slice(0, 5) });
  const upcoming = charges(scoped, addDays(today, 1), addDays(today, 30), today).filter(
    (r) => r.original.kind !== 'refund' && (r.amount > 0 || !!r.partial?.incomplete),
  );
  if (upcoming.length) blocks.push({ type: 'upcoming', rows: upcoming, total: sum(upcoming), partial: { total: rowTotal(upcoming) } });
  blocks.push(
    ...details(
      scoped,
      today,
      scoped.subscriptions.reduce((m, s) => (s.start < m ? s.start : m), today),
      today,
      undefined,
      yearStart,
      today,
    ),
  );
  return { blocks };
}

/** 累计视角：从第一笔到今天按我的份额、扣除退款的实际支出；构成与排行也按累计金额。 */
function totalReport(scoped: AppState, today: string, yearStart: string): ScopeReport {
  const first = scoped.subscriptions.reduce((m, s) => (s.start < m ? s.start : m), today);
  const rows = charges(scoped, first, today, today);
  const total = sum(rows);
  const bySub = new Map<string, { sub: Subscription; amount: number; partial: FxTotal }>();
  for (const r of rows) {
    const e = bySub.get(r.sub.id) ?? { sub: r.sub, amount: 0, partial: emptyTotal() };
    e.amount += r.amount;
    e.partial = sumTotals([e.partial, r.partial!]);
    bySub.set(r.sub.id, e);
  }
  const spent = [...bySub.values()].filter((r) => r.amount > 0 || r.partial.incomplete);
  const blocks: Block[] = [
    {
      type: 'headline',
      mode: 'total',
      partial: {
        total: rowTotal(rows),
        average: scaleTotal(rowTotal(rows), 1 / Math.max(1, scoped.subscriptions.length)),
        yearPaid: rowTotal(rows.filter((r) => r.date >= yearStart)),
      },
      total,
      count: scoped.subscriptions.length,
      average: scoped.subscriptions.length ? total / scoped.subscriptions.length : 0,
      yearPaid: sum(rows.filter((r) => r.date >= yearStart)),
      since: rows[0]?.date ?? first,
    },
  ];
  const cash = selectionCash(scoped, today);
  if (cash.some((r) => r.cash !== 0)) blocks.push({ type: 'trend', mode: 'scope', rows: cash });
  addComposition(
    blocks,
    composition(spent.map((r) => ({ key: r.sub.category, amount: r.amount, partial: r.partial }))),
    composition(
      rows.flatMap((r) =>
        chargeSources(r.original).map((x) => ({ key: x.methodId ?? '', amount: r.amount * x.share, partial: scaleTotal(r.partial!, x.share) })),
      ),
    ),
    true,
  );
  if (spent.length > 1) blocks.push({ type: 'top', mode: 'total', rows: spent.sort(byAmount).slice(0, 10) });
  blocks.push(
    ...details(
      scoped,
      today,
      scoped.subscriptions.reduce((m, s) => (s.start < m ? s.start : m), today),
      today,
      undefined,
      yearStart,
      today,
    ),
  );
  return { blocks };
}

/** Monthly cash uses the same net, my-share cash basis as cashVsAccrual, including refunds. */
export function monthReport(state: AppState, month: string, today: string): ScopeReport & { months: MonthCash[]; next: MonthCash } {
  const scoped = { ...state, subscriptions: state.subscriptions.filter((s) => !s.proxy) };
  const from = `${month}-01`;
  const to = monthEnd(month);
  const rows = charges(scoped, from, to, today);
  // 转让收付只进现金合计与月度走势，不进笔数、构成、排行和即将扣款
  const cashOf = (m: string, list?: ChargeRow[]) => cashRows(scoped, `${m}-01`, monthEnd(m), today, list);
  const cash = cashOf(month, rows);
  const previousMonth = addMonths(from, -1).slice(0, 7);
  const previous = cashOf(previousMonth);
  const lastYear = addMonths(from, -12).slice(0, 7);
  const yearlyCharges = charges(scoped, `${lastYear}-01`, monthEnd(lastYear), today);
  const yearly = cashOf(lastYear, yearlyCharges);
  const debits = rows.filter((r) => r.original.kind !== 'refund' && (r.amount > 0 || !!r.partial?.incomplete));
  const blocks: Block[] = [
    {
      type: 'headline',
      mode: 'month',
      ...cashMonth(cash, month, today),
      count: rows.filter((r) => r.original.kind !== 'refund').length,
      previous: rowTotal(cash).incomplete || rowTotal(previous).incomplete ? { amount: NaN, percent: NaN } : compare(sum(cash), sum(previous)),
      yearly: yearlyCharges.some((r) => r.original.kind !== 'refund')
        ? rowTotal(cash).incomplete || rowTotal(yearly).incomplete
          ? { amount: NaN, percent: NaN }
          : compare(sum(cash), sum(yearly))
        : undefined,
    },
  ];
  if (from <= today) {
    const end = to < today ? to : today;
    const start = addDays(from, -1);
    const endFx = end === today ? undefined : end;
    const mv = movement(scoped, start, end, endFx);
    if (mv.items.length || Math.abs(mv.fx) >= 0.005) {
      const changes = events(scoped, end).filter((e) => e.date >= from && e.kind !== 'buy');
      const items = mv.items.map((r): MovementRow => {
        const dates = changes
          .filter((e) => e.sub.id === r.sub.id)
          .map((e) => e.date)
          .sort();
        return {
          ...r,
          from: contributionOn(scoped, r.sub, start, endFx),
          to: contributionOn(scoped, r.sub, end, endFx),
          since: dates[0] ?? from,
          until: dates.at(-1) ?? end,
        };
      });
      blocks.push({ type: 'trend', mode: 'month', month, movement: { ...mv, items } });
    }
  }
  addComposition(
    blocks,
    composition(debits.map((r) => ({ key: r.sub.category, amount: r.amount, partial: r.partial }))),
    composition(
      debits.flatMap((r) =>
        chargeSources(r.original).map((x) => ({ key: x.methodId ?? '', amount: r.amount * x.share, partial: scaleTotal(r.partial!, x.share) })),
      ),
    ),
    false,
  );
  if (debits.length) blocks.push({ type: 'top', mode: 'month', rows: [...debits].sort(byAmount).slice(0, 5) });
  const upcoming = debits.filter((r) => r.date > today);
  if (to >= today && upcoming.length) blocks.push({ type: 'upcoming', rows: upcoming, total: sum(upcoming), partial: { total: rowTotal(upcoming) } });
  blocks.push(...details(scoped, today, from, to, { from, to }, from, to < today ? to : from > today ? to : today));
  const months = Array.from({ length: 6 }, (_, i) => {
    const m = addMonths(from, i - 5).slice(0, 7);
    return cashMonth(m === month ? cash : cashOf(m), m, today);
  });
  const nextMonth = addMonths(from, 1).slice(0, 7);
  return { blocks, months, next: cashMonth(cashOf(nextMonth), nextMonth, today) };
}

export interface YearDriver {
  sub: Subscription;
  /** added: started after last year's comparison date; stopped: no cash this year and no longer billing. */
  kind: 'added' | 'stopped' | 'up' | 'down';
  current: number;
  previous: number;
  delta: number;
}

export interface YearOutlook {
  year: string;
  /** Jan 1 – Dec 31: paid through today, the rest forecast from current plans. */
  current: CashSpan;
  /** Same period: Jan 1 – today against Jan 1 – the same day last year (Feb 29 maps to Feb 28). */
  samePeriod: {
    through: string;
    previousThrough: string;
    amount: number;
    previous: number;
    /** Undefined when last year's period has no cash, like the calendar's same-month comparison. */
    change?: Comparison;
    partial: { amount: FxTotal; previous: FxTotal };
  };
  /** Per-subscription cash differences behind the same-period change, largest first; empty without a comparison. */
  drivers: YearDriver[];
  nextMonth: CashSpan & { month: string };
  nextYear: CashSpan & { year: string };
}

/** Year-level net cash on the monthReport basis: my share, refunds and transfer cash, proxies excluded. */
export function yearOutlook(state: AppState, today: string): YearOutlook {
  const scoped = { ...state, subscriptions: state.subscriptions.filter((s) => !s.proxy) };
  const y = Number(today.slice(0, 4));
  const lastFrom = `${y - 1}-01-01`;
  const md = today.slice(5) === '02-29' ? '02-28' : today.slice(5);
  const lastThrough = `${y - 1}-${md}`;
  const ytd = cashRows(scoped, `${y}-01-01`, today, today);
  const last = cashRows(scoped, lastFrom, lastThrough, today);
  const amount = rowTotal(ytd);
  const previous = rowTotal(last);
  const bySub = new Map<string, { sub: Subscription; current: number; previous: number }>();
  for (const [list, key] of [
    [ytd, 'current'],
    [last, 'previous'],
  ] as const) {
    for (const r of list) {
      const e = bySub.get(r.sub.id) ?? { sub: r.sub, current: 0, previous: 0 };
      e[key] += r.amount;
      bySub.set(r.sub.id, e);
    }
  }
  const drivers = [...bySub.values()]
    .map((e): YearDriver => {
      const delta = e.current - e.previous;
      const kind =
        Math.abs(e.previous) < 0.005 && e.sub.start > lastThrough
          ? 'added'
          : Math.abs(e.current) < 0.005 && isStopped(effectiveStatus(e.sub, today))
            ? 'stopped'
            : delta > 0
              ? 'up'
              : 'down';
      return { ...e, kind, delta };
    })
    .filter((d) => Number.isFinite(d.delta) && Math.abs(d.delta) >= 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.sub.id.localeCompare(b.sub.id));
  const nextMonth = addMonths(today.slice(0, 8) + '01', 1).slice(0, 7);
  return {
    year: String(y),
    current: cashSpan(cashRows(scoped, `${y}-01-01`, `${y}-12-31`, today), today),
    samePeriod: {
      through: today,
      previousThrough: lastThrough,
      amount: sum(ytd),
      previous: sum(last),
      change: !last.length ? undefined : amount.incomplete || previous.incomplete ? { amount: NaN, percent: NaN } : compare(sum(ytd), sum(last)),
      partial: { amount, previous },
    },
    drivers: last.length ? drivers : [],
    nextMonth: { month: nextMonth, ...cashSpan(cashRows(scoped, `${nextMonth}-01`, monthEnd(nextMonth), today), today) },
    nextYear: { year: String(y + 1), ...cashSpan(cashRows(scoped, `${y + 1}-01-01`, `${y + 1}-12-31`, today), today) },
  };
}

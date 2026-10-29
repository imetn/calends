import { partialOut } from './tool-views.ts';
import { type FxTotal, emptyTotal } from '../../shared/fx-total.ts';
import { addDays, addMonths, chargesBetween, diffDays, phaseSubs } from '../../shared/billing.ts';
import { chargeFxMissing, convertOn } from '../../shared/fx.ts';
import { t } from '../../shared/i18n.ts';
import { LIST_STATUSES, listScope, listWords, type ListScope, type ListStatus } from '../../shared/list-scope.ts';
import { monthEnd } from '../../shared/metrics.ts';
import { monthReport, scopeReport, type Block, type MonthCash, type ChargeRow, type Comparison, type CompositionRow } from '../../shared/scope-report.ts';
import { transferRows, transfersOf, transferValue } from '../../shared/transfers.ts';
import type { AppState, Subscription } from '../../shared/types.ts';
import { categoryRef, findSub, methodRef } from './tool-kit.ts';
import { round } from './tool-views.ts';

/** Shared by get_insights scope_report and spending_stats: the web list's filter, plus MCP-only narrowing. */
export const LIST_FILTER = {
  type: 'object',
  additionalProperties: false,
  description:
    'Subset of my subscriptions, using the same rules as the web subscription list filter (proxy payments are never included). All given fields must match.',
  properties: {
    status: {
      type: 'string',
      enum: LIST_STATUSES,
      default: 'all',
      description: 'List status facet: live = active + ending (trial and paused are separate), as in the web list.',
    },
    category: { type: 'string', description: 'Existing category code or name from list_categories.' },
    method: { type: 'string', description: 'Current payment method id or name; "none" = unassigned.' },
    query: {
      type: 'string',
      description:
        'Web list search: every whitespace-separated word must appear in name, category, tags, notes, region, URL or current payment method name (literal, case-insensitive; the web UI additionally matches pinyin).',
    },
    tag: { type: 'string', description: 'MCP only: exact tag (case-insensitive).' },
    region: { type: 'string', description: 'MCP only: ISO region of the current phase, e.g. TR.' },
    subscriptions: { type: 'array', items: { type: 'string' }, description: 'MCP only: explicit subscription ids or names.' },
  },
};

/** Resolve MCP filter arguments into the shared list selection; unknown references fail with candidates. */
export function listFilter(st: AppState, f: Record<string, unknown> | undefined): ListScope {
  if (!f) return {};
  const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));
  const method = str(f.method);
  return {
    status: (str(f.status) as ListStatus | undefined) ?? 'all',
    category: f.category == null ? undefined : categoryRef(st, f.category),
    method: method == null ? undefined : method.toLowerCase() === 'none' ? 'none' : methodRef(st, method),
    words: listWords(str(f.query)),
    tag: str(f.tag),
    region: str(f.region),
    ids: Array.isArray(f.subscriptions) ? new Set(f.subscriptions.map((x) => findSub(st, x).id)) : undefined,
  };
}

export const filteredSubs = (st: AppState, today: string, f: Record<string, unknown> | undefined) => listScope(st, today, listFilter(st, f));

interface Gaps {
  /** Months with a charge or transfer that cannot be converted. */
  months: Set<string>;
  currencies: Set<string>;
  subs: Set<string>;
  /** A phase currency has no current rate: MRR, movement and forecasts would count it as 0. */
  current: boolean;
  /** Charges/transfers that could not be converted, with their original amounts. */
  rows: Array<{ date: string; subscription_id: string; name: string; kind: string; original: { amount: number; currency: string } }>;
}

/** Where report figures would silently treat missing FX as 0 (toBaseAt falls back to 0). */
function fxGaps(st: AppState, subs: readonly Subscription[], from: string, to: string, today: string): Gaps {
  const g: Gaps = { months: new Set(), currencies: new Set(), subs: new Set(), current: false, rows: [] };
  const base = st.settings.baseCurrency;
  for (const s of subs) {
    if (s.proxy) continue;
    for (const c of chargesBetween(s, from, to, today)) {
      if (c.kind === 'failed' || !chargeFxMissing(st, c)) continue;
      const original = c.settled && !c.projected ? c.settled : c;
      g.months.add(c.date.slice(0, 7));
      g.currencies.add(original.currency);
      g.subs.add(s.id);
      g.rows.push({ date: c.date, ...ref(s), kind: c.kind ?? 'charge', original: { amount: round(original.amount), currency: original.currency } });
    }
    for (const tr of transfersOf(s)) {
      if (tr.date < from || tr.date > to || tr.date > today || Number.isFinite(transferValue(st, tr))) continue;
      g.months.add(tr.date.slice(0, 7));
      g.currencies.add(tr.currency);
      g.subs.add(s.id);
      g.rows.push({ date: tr.date, ...ref(s), kind: tr.kind, original: { amount: round(tr.amount), currency: tr.currency } });
    }
    for (const p of phaseSubs(s))
      if (!Number.isFinite(convertOn(1, p.currency, base, '9999-12-31', undefined, st.fx))) {
        g.currencies.add(p.currency);
        g.subs.add(s.id);
        g.current = true;
      }
  }
  return g;
}

const num = (n: number) => (Number.isFinite(n) ? round(n) : null);
const pct = (n: number | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 10);
const ref = (s: Subscription) => ({ subscription_id: s.id, name: s.name });
const cmp = (c: Comparison | undefined, missing: boolean) =>
  !c ? null : missing ? { amount: null, percent: null } : { amount: num(c.amount), percent: pct(c.percent) };

function chargeOut(st: AppState, r: ChargeRow) {
  const c = r.original;
  const missing = chargeFxMissing(st, c);
  return {
    date: r.date,
    ...ref(r.sub),
    kind: c.kind ?? 'charge',
    projected: c.projected,
    bill: { amount: round(c.amount), currency: c.currency },
    ...(c.settled ? { settled: { amount: round(c.settled.amount), currency: c.settled.currency } } : {}),
    /** Base currency, my share; refunds negative. */
    ...(r.partial ? partialOut(r.partial) : {}),
    amount: missing ? null : num(r.amount),
    ...(missing ? { fx_missing: true } : {}),
  };
}

function compOut(st: AppState, rows: CompositionRow[], kind: 'category' | 'method', missing: boolean) {
  return rows.map((r) => ({
    key: r.other ? null : r.key,
    label: r.other ? null : kind === 'category' ? r.key : (st.methods.find((m) => m.id === r.key)?.name ?? t('mcp.label.unassigned')),
    ...(r.other ? { other: true } : {}),
    ...(r.partial ? partialOut(r.partial) : {}),
    amount: missing ? null : num(r.amount),
    share_pct: missing ? null : pct(r.share),
  }));
}

interface Missing {
  headline: boolean;
  previous: boolean;
  yearly: boolean;
  trend: boolean;
  composition: boolean;
  subs: Set<string>;
}

function blockOut(st: AppState, b: Block, m: Missing): Record<string, unknown> {
  const out = blockValues(st, b, m);
  if (b.partial) {
    const primary = b.partial.total ?? b.partial.mrr ?? b.partial.loss ?? b.partial.received;
    if (primary) Object.assign(out, partialOut(primary));
    out.totals = Object.fromEntries(Object.entries(b.partial).map(([key, value]) => [key, partialOut(value)]));
  }
  return out;
}
function blockValues(st: AppState, b: Block, m: Missing): Record<string, unknown> {
  const sub = (s: Subscription, n: number) => (m.subs.has(s.id) ? null : num(n));
  switch (b.type) {
    case 'headline': {
      const h = (n: number) => (m.headline ? null : num(n));
      if (b.mode === 'scope')
        return {
          type: 'headline',
          mode: 'scope',
          mrr: h(b.mrr),
          annual: h(b.annual),
          active_count: b.activeCount,
          paid_this_year: h(b.paid),
          this_year_with_forecast: h(b.year),
          stop_loss_this_year: m.headline ? null : num(b.loss),
          mrr_change_since_last_month: m.headline ? null : num(b.change.amount),
        };
      if (b.mode === 'total')
        return { type: 'headline', mode: 'total', total: h(b.total), count: b.count, average: h(b.average), paid_this_year: h(b.yearPaid), since: b.since };
      return {
        type: 'headline',
        mode: 'month',
        month: b.month,
        total: h(b.total),
        paid: h(b.paid),
        pending: h(b.pending),
        count: b.count,
        vs_previous_month: cmp(b.previous, m.previous),
        vs_same_month_last_year: cmp(b.yearly, m.yearly),
      };
    }
    case 'trend':
      if (b.mode === 'scope')
        return {
          type: 'trend',
          mode: 'scope',
          rows: b.rows.map((r) => ({ month: r.month, cash: m.trend ? null : num(r.cash), accrual: m.trend ? null : num(r.accrual), projected: r.projected })),
        };
      {
        const mv = b.movement;
        const v = (n: number) => (m.trend ? null : num(n));
        return {
          type: 'trend',
          mode: 'month',
          month: b.month,
          mrr_from: v(mv.from),
          mrr_to: v(mv.to),
          fx: v(mv.fx),
          added: v(mv.added),
          expansion: v(mv.expansion),
          contraction: v(mv.contraction),
          churned: v(mv.churned),
          items: mv.items.map((i) => ({
            ...ref(i.sub),
            kind: i.kind,
            delta: m.trend ? null : sub(i.sub, i.delta),
            from: m.trend ? null : sub(i.sub, i.from),
            to: m.trend ? null : sub(i.sub, i.to),
            since: i.since,
            until: i.until,
          })),
        };
      }
    case 'composition':
      return {
        type: 'composition',
        categories: compOut(st, b.categories, 'category', m.composition),
        methods: compOut(st, b.methods, 'method', m.composition),
      };
    case 'top':
      if (b.mode === 'month') return { type: 'top', mode: 'month', rows: b.rows.map((r) => chargeOut(st, r)) };
      return { type: 'top', mode: b.mode, rows: b.rows.map((r) => ({ ...ref(r.sub), amount: sub(r.sub, r.amount) })) };
    case 'upcoming':
      return { type: 'upcoming', total: m.composition ? null : num(b.total), rows: b.rows.map((r) => chargeOut(st, r)) };
    case 'events':
      return { type: 'events', rows: b.rows.map((r) => ({ date: r.date, ...ref(r.sub), kind: r.kind, monthly_delta: sub(r.sub, r.delta) })) };
    case 'losses':
      return {
        type: 'losses',
        loss: num(b.loss),
        refunded: num(b.refunded),
        incomplete: b.incomplete,
        rows: b.rows.map((i) => ({
          ...ref(i.sub),
          phase_start: i.phase.start,
          kind: i.kind,
          date: i.date,
          paid_through: i.paidThrough,
          currency: i.currency,
          loss: round(i.loss),
          loss_base: num(i.lossBase),
          fx_missing: i.fxMissing,
          refund_status: i.refundStatus,
        })),
        refunds: b.refunds.map((r) => chargeOut(st, r)),
      };
    case 'sharing':
      return {
        type: 'sharing',
        received: num(b.received),
        owed: num(b.owed),
        rows: b.rows.map((r) => ({ ...ref(r.sub), received: num(r.received), owed: num(r.owed) })),
      };
  }
}

/** Unconverted rows are listed separately: the shared report counts them as 0 and so may drop them from rankings. */
const gapsOut = (g: Gaps, from: string, to: string) => ({
  incomplete: g.currencies.size > 0,
  fx_missing: [...g.currencies].sort(),
  unconverted: g.rows.filter((r) => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date)),
});

/** get_insights section=month_report: the calendar month report (monthReport) as JSON. */
export function monthReportOut(st: AppState, month: string, today: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(t('mcp.error.badMonth', { month }));
  const r = monthReport(st, month, today);
  const scoped = { ...st, subscriptions: st.subscriptions.filter((s) => !s.proxy) };
  const from = `${month}-01`;
  const to = monthEnd(month);
  const g = fxGaps(st, scoped.subscriptions, addMonths(from, -12), to, today);
  const bad = (d: string) => g.months.has(d.slice(0, 7));
  const cur = bad(from);
  const missing: Missing = {
    headline: cur,
    previous: cur || bad(addMonths(from, -1)),
    yearly: cur || bad(addMonths(from, -12)),
    trend: g.current,
    composition: cur,
    subs: g.subs,
  };
  const transfers = transferRows(scoped, from, to, today);
  const monthOut = (x: MonthCash) => {
    const gap = bad(`${x.month}-01`) || x.partial.total.incomplete;
    return {
      month: x.month,
      ...partialOut(x.partial.total),
      total: gap ? null : num(x.total),
      paid: gap ? null : num(x.paid),
      pending: gap ? null : num(x.pending),
    };
  };
  return {
    month,
    known_total: partialOut(r.blocks.find((b) => b.type === 'headline')?.partial?.total ?? emptyTotal()).known_total,
    totals: partialOut(r.blocks.find((b) => b.type === 'headline')?.partial?.total ?? emptyTotal()),
    today,
    currency: st.settings.baseCurrency,
    basis:
      'Net cash at my share, each past charge at its own day’s FX; refunds negative. total/paid/pending and months include second-hand transfers (buy outflow, sell inflow) up to today; count, composition, top and upcoming exclude transfers. Proxy payments excluded.',
    ...gapsOut(g, from, to),
    blocks: r.blocks.map((b) => blockOut(st, b, missing)),
    months: r.months.map(monthOut),
    next_month: monthOut(r.next),
    transfers: transfers.map((x) => ({
      date: x.date,
      ...ref(x.sub),
      kind: x.transfer.kind,
      original: { amount: round(x.transfer.amount), currency: x.transfer.currency },
      /** Base currency at the transfer date, cost-positive like charges: buy positive, sell negative. */
      amount: num(x.amount),
    })),
  };
}

/** get_insights section=scope_report: the web list's selection report (scopeReport) as JSON. */
export function scopeReportOut(st: AppState, today: string, f: Record<string, unknown> | undefined) {
  const subs = filteredSubs(st, today, f);
  const g = fxGaps(st, subs, '0001-01-01', monthEnd(addMonths(today, 3).slice(0, 7)), today);
  const report = scopeReport(st, subs, today);
  const head = report.blocks.find((b) => b.type === 'headline');
  const partial = head?.partial?.mrr ?? head?.partial?.total ?? emptyTotal();
  const lifecycleTotal = (total: FxTotal) => ({
    total: total.incomplete ? null : num(total.value),
    incomplete: total.incomplete,
    fx_missing: Object.keys(total.unconverted).sort(),
    ...partialOut(total),
  });
  const bad = g.currencies.size > 0;
  const missing: Missing = { headline: bad, previous: bad, yearly: bad, trend: bad, composition: bad, subs: g.subs };
  return {
    as_of: today,
    known_total: partialOut(partial).known_total,
    totals: partialOut(partial),
    currency: st.settings.baseCurrency,
    basis:
      'Selection lifecycle supplies all-history net cash at my share, average duration and complete recorded stops. Legacy headline blocks retain MRR/annual at current FX, paid this year and stop losses at my share; trend = 12 cash months through this month, paid through today (cash vs accrual); upcoming = next 30 days. Transfers are not part of this report. When nothing has recurring cost, the headline switches to lifetime totals (mode=total).',
    lifecycle: report.lifecycle
      ? {
          cumulative_spending: lifecycleTotal(report.lifecycle.spent),
          average_duration_days: num(report.lifecycle.averageDays),
          active_count: report.lifecycle.activeCount,
          stopped_count: report.lifecycle.stoppedCount,
          terminated_count: report.lifecycle.terminatedCount,
          unrefunded_loss: lifecycleTotal(report.lifecycle.loss),
          termination_loss: lifecycleTotal(report.lifecycle.terminationLoss),
          stops: report.lifecycle.stops.map((r) => ({
            ...ref(r.sub),
            phase_start: r.phase.start,
            kind: r.kind,
            date: r.date,
            used_days: Math.max(0, diffDays(r.phase.start, r.date)),
            unused_days: Math.max(0, diffDays(r.date, r.paidThrough)),
            wasted_days: r.wastedDays,
            paid_through: r.paidThrough,
            loss: num(r.loss),
            loss_base: num(r.lossBase),
            refunded: num(r.refunded),
            refunded_base: num(r.refundedBase),
            currency: r.currency,
            fx_missing: r.fxMissing,
            refund_status: r.refundStatus,
          })),
          timeline: report.lifecycle.timeline.map(ref),
          timeline_omitted: report.lifecycle.omitted,
          spending: report.lifecycle.spending.map((r) => ({
            ...ref(r.sub),
            method_id: r.methodId ?? null,
            region: r.region,
            category: r.category,
            ...lifecycleTotal(r.total),
          })),
        }
      : undefined,
    count: subs.length,
    subscriptions: subs.map((s) => ({ id: s.id, name: s.name })),
    ...gapsOut(g, '0001-01-01', addDays(today, 30)),
    blocks: subs.length ? report.blocks.map((b) => blockOut(st, b, missing)) : [],
  };
}

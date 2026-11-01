import { amountTotal, chargesTotal, dueTotal, type FxTotal } from '../../shared/fx-total.ts';
import { personSummary } from '../../shared/avatar.ts';
import {
  renewalDates,
  chargeMethodId,
  activePhases,
  chargesBetween,
  currentPhase,
  cycleLabel,
  diffDays,
  effectiveStatus,
  lastCharge,
  collectionAnchor,
  type MemberDue,
  memberCollection,
  memberUnpaidFrom,
  monthlyGross,
  monthlyPriceTotal,
  myShareFactor,
  nextCharge,
  priceAt,
  stopSummary,
  type Charge,
} from '../../shared/billing.ts';
import { chargeBaseOrNaN, toBaseOrNaN } from '../../shared/fx.ts';
import { type LedgerPeriod } from '../../shared/receivables.ts';
import { personAmounts, type PersonLedger } from '../../shared/people.ts';
import type { AppState, Person, ShareMember, Subscription } from '../../shared/types.ts';
import { carRule, followsCar, memberPaidThrough } from '../../shared/carpool.ts';
import { meterSummary, type MeterRow } from '../../shared/meters.ts';

export function money(st: AppState, amount: number, currency: string, date?: string, to = st.settings.baseCurrency) {
  const conv = !Number.isFinite(amount) ? NaN : currency === to ? amount : toBaseOrNaN(st, amount, currency, date, to);
  return { amount: fin(amount), currency, converted: fin(conv), convertedCurrency: to, ...partialOut(amountTotal(amount, currency, conv)) };
}

export const round = (n: number) => Math.round(n * 100) / 100;

/** Additive partial totals; existing null and FX-gap fields retain their meaning. */
export const partialOut = (total: FxTotal) => ({
  known_total: round(total.value),
  unconverted: Object.fromEntries(Object.entries(total.unconverted).map(([c, v]) => [c, round(v)])),
});
export const fin = (n: number): number | null => (Number.isFinite(n) ? round(n) : null);

export function fxGaps() {
  const missing = new Set<string>();
  let gap = false;
  return {
    /** 记录 v；不是有限数时标记缺汇率，原样返回 v */
    note(v: number | null | undefined, ccy?: string) {
      if (v == null || !Number.isFinite(v)) {
        gap = true;
        if (ccy) missing.add(ccy);
      }
      return v;
    },
    out: () => ({ incomplete: gap, fx_missing: [...missing].sort() }),
  };
}

export const VIA_EN: Record<string, string> = { 微信: 'WeChat', 邮箱: 'Email', 手机: 'Phone', 其他: '' };

export const contactLine = (p: Pick<Person, 'contactVia' | 'contact'>) => {
  if (!p.contact) return null;
  const via = p.contactVia ? (VIA_EN[p.contactVia] ?? p.contactVia) : '';
  return via ? `${via} ${p.contact}` : p.contact;
};

export function personRow(st: AppState, l: PersonLedger, out: string, today: string) {
  const conv = (v: number) => fin(toBaseOrNaN(st, v, st.settings.baseCurrency, undefined, out));
  const partial = personAmounts(st, l, today, out);
  return {
    ...partialOut(partial.owed),
    totals: { owed: partialOut(partial.owed), received: partialOut(partial.received) },
    person_id: l.person.id || null,
    name: l.person.name,
    contact: contactLine(l.person),
    note: l.person.note ?? null,
    has_avatar: !!l.person.avatar,
    record: personSummary(l.person),
    owed: conv(l.owed),
    periods_owed: l.periodsOwed,
    received: conv(l.received),
    last_paid: l.lastPaid ?? null,
    in: l.items.map((i) => ({
      subscription_id: i.sub.id,
      name: i.sub.name,
      kind: i.kind,
      member_id: i.member?.id ?? null,
      ...(i.member ? { account: i.member.account ?? null } : {}),
      active: i.active,
      left: i.member?.left && i.member.left <= today ? i.member.left : null,
      owed: conv(i.owed),
      periods_owed: i.periodsOwed,
      received: conv(i.received),
      last_paid: i.lastPaid ?? null,
      paid_until: i.paidUntil ?? null,
      ...(i.member ? { leave_refund: i.member.leaveRefund ?? null } : {}),
    })),
  };
}

export function periodsOut(periods: LedgerPeriod[]) {
  return periods.map((p) => ({
    period: p.key,
    from: p.from,
    until: p.until,
    due: p.due,
    currency: p.currency,
    status: p.status,
    receipt_id: p.receipt?.id ?? null,
    waiver_id: p.waiver?.id ?? null,
  }));
}

export function collectionSummary(st: AppState, s: Subscription, m: ShareMember, due: MemberDue | undefined, today: string) {
  const rule = s.share?.role === 'owner' ? carRule(st, s, today) : undefined;
  const currency = collectCcy(st);
  const first = memberCollection(s, m, m.joined ?? s.share?.since ?? s.start, currency);
  const next = memberCollection(s, m, memberUnpaidFrom(s, m), currency);
  return {
    follows_rule: rule ? followsCar(st, s, m, today) : false,
    collect_from: collectionAnchor(s),
    paid_until: memberPaidThrough(s, m, today, currency) ?? null,
    leave_refund: m.leaveRefund ?? null,
    first_collection: first,
    next_collection: next,
    next_collection_date: next.from,
    overdue_days: due && due.periodsOwed > 0 && next.from < today ? diffDays(next.from, today) : 0,
    is_first_period: next.from <= first.until,
    pending_amount: { ...money(st, due?.owed ?? 0, due?.currency ?? next.currency), ...(due ? partialOut(dueTotal(st, due)) : {}) },
  };
}

export function ruleOut(st: AppState, s: Subscription, today: string) {
  const r = carRule(st, s, today);
  return { fee: r.fee, currency: r.currency, every_months: r.billEvery, stored: !!s.share?.rule };
}

export type Scope = 'mine' | 'share_owner' | 'share_member' | 'proxy';

export const kindOf = (s: Subscription): Scope =>
  s.proxy ? 'proxy' : s.share?.role === 'owner' ? 'share_owner' : s.share?.role === 'member' ? 'share_member' : 'mine';

export function row(st: AppState, s: Subscription, today: string, out?: string) {
  const cur = currentPhase(s, today);
  const next = nextCharge(s, today);
  // 换区后旧阶段还在跑：每月成本按并行各段之和，另列出同时进行的旧阶段
  const monthly = monthlyGross(s, today, st.fx);
  const parallel = s.phases?.length ? activePhases(s, today).filter((v) => v.start !== cur.start) : [];
  return {
    id: s.id,
    name: s.name,
    account: s.account ?? null,
    category: s.category,
    tags: s.tags,
    status: effectiveStatus(s, today),
    kind: kindOf(s),
    price: money(st, next && (!cur.end || next < cur.end) ? priceAt(s, next) : cur.price, cur.currency, undefined, out),
    cycle: cycleLabel(cur.cycle),
    monthly: { ...money(st, monthly, cur.currency, undefined, out), ...partialOut(monthlyPriceTotal(st, s, today, out ?? st.settings.baseCurrency)) },
    my_share_factor: round(myShareFactor(cur, today)),
    next_charge: next ?? null,
    service_expires: renewalDates(s, today).serviceExpires ?? null,
    cancel_by: renewalDates(s, today).cancelBy ?? null,
    last_charge: lastCharge(s, today) ?? null,
    method: st.methods.find((m) => m.id === cur.methodId)?.name ?? null,
    method_id: cur.methodId ?? null,
    region: cur.region ?? null,
    start: s.start,
    estimate_from: s.estimateFrom ?? null,
    end: s.end ?? null,
    stop: stopSummary(cur, today) ?? null,
    has_planned_change: !!s.phases?.some((p) => p.planned),
    ...(parallel.length
      ? {
          also_running: parallel.map((v) => ({
            start: v.start,
            until: v.end ?? null,
            price: money(st, v.price, v.currency, undefined, out),
            cycle: cycleLabel(v.cycle),
            region: v.region ?? null,
            method: st.methods.find((m) => m.id === v.methodId)?.name ?? null,
          })),
        }
      : {}),
  };
}

export function chargeRow(st: AppState, c: Charge, out?: string) {
  const sub = st.subscriptions.find((x) => x.id === c.sub.id) ?? c.sub;
  const v = chargeBaseOrNaN(st, c, out ?? st.settings.baseCurrency);
  return {
    date: c.date,
    subscription_id: c.sub.id,
    name: sub.name,
    amount: { amount: round(c.amount), currency: c.currency, converted: fin(v), convertedCurrency: out ?? st.settings.baseCurrency },
    my_amount: fin(v * myShareFactor(c.sub, c.date)),
    ...(Number.isFinite(v) ? {} : { fx_missing: true }),
    projected: c.projected,
    kind: c.kind ?? 'charge',
    method: st.methods.find((m) => m.id === chargeMethodId(c))?.name ?? null,
    ...(c.funding?.length
      ? {
          funding: c.funding.map((f) => ({
            method: st.methods.find((m) => m.id === f.methodId)?.name ?? null,
            method_id: f.methodId,
            amount: round(f.amount),
          })),
        }
      : {}),
    ...(c.settled ? { settled: c.settled } : {}),
    ...(c.note ? { note: c.note } : {}),
  };
}

export const collectCcy = (st: AppState) => st.settings.collectCurrency ?? st.settings.baseCurrency;

export function fieldChanges(before: unknown, after: unknown, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  const leaf = (x: unknown) => x === undefined || x === null || typeof x !== 'object';
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (leaf(before) || leaf(after) || Array.isArray(before) !== Array.isArray(after))
    return [{ path: path || '$', before: before ?? null, after: after ?? null }];
  const b = before as Record<string, unknown>;
  const n = after as Record<string, unknown>;
  const keys = Array.isArray(after)
    ? [...Array(Math.max((before as unknown[]).length, (after as unknown[]).length)).keys()].map(String)
    : [...new Set([...Object.keys(b), ...Object.keys(n)])];
  return keys.flatMap((k) => fieldChanges(b[k], n[k], Array.isArray(after) ? `${path}[${k}]` : path ? `${path}.${k}` : k));
}

export const chargeCcy = (c: Charge) => (c.settled && !c.projected ? c.settled.currency : c.currency);

export function computedOf(st: AppState, s: Subscription, today: string) {
  const all = chargesBetween(s, '1970-01-01', today, today).filter((c) => !c.projected);
  const gaps = fxGaps();
  const spent = all.reduce((sum, c) => sum + (gaps.note(chargeBaseOrNaN(st, c), chargeCcy(c)) as number), 0);
  return {
    status: effectiveStatus(s, today),
    next_charge: nextCharge(s, today) ?? null,
    last_charge: lastCharge(s, today) ?? null,
    spent_total: { amount: fin(spent), currency: st.settings.baseCurrency, charges: all.length, ...gaps.out(), ...partialOut(chargesTotal(st, all)) },
    stop: stopSummary(currentPhase(s, today), today) ?? null,
  };
}

export function roundAll<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]),
  ) as T;
}

const unitRound = (n: number) => Math.round(n * 1e4) / 1e4;

/** 业务数据：每个指标的累计、最近一期与时间窗内逐条派生（用量、期间扣款、单价，币种为扣款原币） */
export function metersOut(s: Subscription, today: string, from: string) {
  const one = (r: MeterRow) => ({
    reading_id: r.reading.id,
    date: r.reading.date,
    value: r.value,
    usage: r.usage ?? null,
    since: r.since ?? null,
    cost: r.cost ? round(r.cost.amount) : null,
    unit_price: r.unitPrice != null ? unitRound(r.unitPrice) : null,
    currency: r.cost?.currency ?? null,
    note: r.reading.note ?? null,
  });
  return (s.meters ?? []).map((m) => {
    const sum = meterSummary(s, m, today);
    return {
      id: m.id,
      name: m.name,
      unit: m.unit,
      kind: m.kind ?? 'usage',
      total_usage: sum.total,
      periods: sum.periods,
      latest: sum.latest ? one(sum.latest) : null,
      latest_unit_price: sum.latestPriced ? { date: sum.latestPriced.reading.date, amount: unitRound(sum.latestPriced.unitPrice!), currency: sum.latestPriced.cost!.currency } : null,
      readings: sum.rows.filter((r) => r.reading.date >= from).map(one),
    };
  });
}

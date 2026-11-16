import { amountTotal, convertedTotal, emptyTotal, scaleTotal, sumTotals, type FxTotal } from './fx-total.ts';
// 代付：每一期扣款是一笔应收，和合租共用一套按期记账的规则（receivables.ts）。页面和提醒邮件共用，保证两边说法一致
import { addDays, addMonths, chargesBetween } from './billing.ts';
import { toBaseOrNaN as toBaseAt } from './fx.ts';
import { settle, type LedgerPeriod, type Period } from './receivables.ts';
import type { AppState, ProxyCharge, Subscription } from './types.ts';

/**
 * 代付的各期：期的标识是扣款日，到下次扣款前一天为止（改过开始日期时，旧记录按落在哪一期对上）；
 * 应收是卡上实扣（记了实扣用实扣，否则按订阅价）
 */
export function proxyPeriods(s: Subscription, last: string, today: string): (Period & { list: number; listCurrency: string; charge?: ProxyCharge })[] {
  const charged = new Map((s.proxy?.charged ?? []).map((c) => [c.charge, c]));
  // 多取一年，最后一期也知道到哪天为止
  const all = chargesBetween(s, s.start, addMonths(last, 13), today);
  return all.flatMap((c, i) => {
    if (c.date > last) return [];
    const charge = charged.get(c.date);
    const next = all[i + 1]?.date;
    return {
      key: c.date,
      from: c.date,
      until: next ? addDays(next, -1) : (s.end ?? c.date),
      due: charge?.amount ?? c.amount,
      currency: charge?.currency ?? c.currency,
      list: c.amount,
      listCurrency: c.currency,
      charge,
    };
  });
}

/** 代付的应收账：至少算到 through（缺省今天）；提前收、提前免的期一直算到那一期 */
export function proxyLedger(s: Subscription, today: string, through = today) {
  const keys = [...(s.proxy?.receipts ?? []), ...(s.proxy?.waivers ?? [])].flatMap((x) => x.periods);
  const last = keys.reduce((a, k) => (k > a ? k : a), through);
  return settle(proxyPeriods(s, last, today), s.proxy ?? {}, today);
}

export interface ProxyRow extends LedgerPeriod {
  partial?: { charged: FxTotal; received: FxTotal };
  /** 扣款日（同 key） */
  date: string;
  /** 这一期记的实扣 */
  charge?: ProxyCharge;
  /** 订阅原价（订阅币种） */
  list: number;
  listCurrency: string;
  /** 卡上实扣：金额同 due、币种同 currency */
  charged: number;
  /** 扣款当天汇率折成本位币 */
  chargedBase: number;
  /** 收回多少，收款当天汇率折成本位币：免收的期为 0，期初结清的按实扣算；没结清为空 */
  receivedBase?: number;
}

function row(state: AppState, p: LedgerPeriod & { list: number; listCurrency: string; charge?: ProxyCharge }): ProxyRow {
  const chargedBase = toBaseAt(state, p.due, p.currency, p.from);
  const receivedBase =
    p.status === 'waived'
      ? 0
      : p.status !== 'paid'
        ? undefined
        : p.share == null
          ? chargedBase
          : toBaseAt(state, p.share, p.receipt!.currency, p.receipt!.date);
  return {
    ...p,
    date: p.from,
    charged: p.due,
    chargedBase,
    receivedBase,
    partial: {
      charged: convertedTotal(state, p.due, p.currency, p.from),
      received:
        p.status === 'waived' || p.status !== 'paid'
          ? emptyTotal()
          : p.share == null
            ? convertedTotal(state, p.due, p.currency, p.from)
            : convertedTotal(state, p.share, p.receipt!.currency, p.receipt!.date),
    },
  };
}

/** 已经扣过款的每一期（新的在前）：卡上实扣多少、折合多少，对方还了多少、折合多少 */
export function proxyRows(state: AppState, s: Subscription, today: string): ProxyRow[] {
  return proxyLedger(s, today)
    .periods.filter((p) => p.from <= today)
    .map((p) => row(state, p as Parameters<typeof row>[1]))
    .reverse();
}

/**
 * 已经预收（或免收）、还没到扣款日的期（新的在前）。实扣按预测金额，不计入已代付、已收回与盈亏；到了扣款日自然进入 proxyRows
 */
export function proxyAhead(state: AppState, s: Subscription, today: string): ProxyRow[] {
  return proxyLedger(s, today)
    .periods.filter((p) => p.from > today && (p.status === 'paid' || p.status === 'waived'))
    .map((p) => row(state, p as Parameters<typeof row>[1]))
    .reverse();
}

/** 可以记收款的期（旧的在前）：已扣还没收的，接着是未来至少 months 个月内还没收的期 */
export function proxyOpenPeriods(state: AppState, s: Subscription, today: string, months = 12): ProxyRow[] {
  return proxyLedger(s, today, addMonths(today, months))
    .periods.filter((p) => p.status === 'due' || p.status === 'upcoming')
    .map((p) => row(state, p as Parameters<typeof row>[1]));
}

/**
 * 一组代付期的合计（都折成本位币）：已收与待收两组、已代付、已收回、待收、盈亏（只算已收的期：收回 − 实扣）、最近一次收款日。
 * 代付页、卡片、详情与列表共用，口径只在这里一处
 */
export function proxyTotals(rows: ProxyRow[]) {
  const done = rows.filter((r) => r.receivedBase != null);
  const open = rows.filter((r) => r.receivedBase == null);
  return {
    done,
    open,
    partial: {
      charged: sumTotals(rows.map((r) => r.partial?.charged ?? amountTotal(r.charged, r.currency, r.chargedBase))),
      received: sumTotals(done.map((r) => r.partial?.received ?? amountTotal(r.share ?? r.charged, r.receipt?.currency ?? r.currency, r.receivedBase!))),
      owed: sumTotals(open.map((r) => r.partial?.charged ?? amountTotal(r.charged, r.currency, r.chargedBase))),
      diff: sumTotals(
        done.flatMap((r) => [
          r.partial?.received ?? amountTotal(r.share ?? r.charged, r.receipt?.currency ?? r.currency, r.receivedBase!),
          scaleTotal(r.partial?.charged ?? amountTotal(r.charged, r.currency, r.chargedBase), -1),
        ]),
      ),
    },
    charged: rows.reduce((a, r) => a + r.chargedBase, 0),
    received: done.reduce((a, r) => a + r.receivedBase!, 0),
    owed: open.reduce((a, r) => a + r.chargedBase, 0),
    diff: done.reduce((a, r) => a + r.receivedBase! - r.chargedBase, 0),
    lastIn: done
      .flatMap((r) => (r.receipt && !r.receipt.opening ? [r.receipt.date] : []))
      .reduce<string | undefined>((a, d) => (!a || d > a ? d : a), undefined),
  };
}

/**
 * 今年（自然年）扣款的代付期合计：盈亏同 proxyTotals，只算已收回的期（收回 − 实扣），还没收的期计入待收。
 * subs 是今年有扣款的代付订阅
 */
export function proxyYear(state: AppState, today: string, y = today.slice(0, 4)) {
  const bySub = state.subscriptions.filter((s) => s.proxy).map((s) => ({ s, rows: proxyRows(state, s, today).filter((r) => r.date.slice(0, 4) === y) }));
  const used = bySub.filter((x) => x.rows.length > 0);
  return { subs: used.map((x) => x.s), ...proxyTotals(used.flatMap((x) => x.rows)) };
}

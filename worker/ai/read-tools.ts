import { amountTotal, chargesTotal, dueTotal, emptyTotal, sumTotals, type FxTotal } from '../../shared/fx-total.ts';
import { partialOut } from './tool-views.ts';
import {
  renewalDates,
  chargeMethodId,
  chargeSources,
  activePhases,
  addMonths,
  chargesBetween,
  currentPhase,
  cycleLabel,
  effectiveStatus,
  memberDues,
  collectionAnchor,
  memberLedger,
  monthlyPriceTotal,
  myShareFactor,
  phaseSubs,
  runwayFor,
  stopSummary,
  totals,
  type Charge,
} from '../../shared/billing.ts';
import { chargeBaseOrNaN, toBaseOrNaN } from '../../shared/fx.ts';
import { cancelSavings, cashVsAccrual, events, insights, movement, mrrSeries, prepaidValue, stopLosses, topUpPlan, yearReview } from '../../shared/metrics.ts';
import { proxyLedger } from '../../shared/proxy.ts';
import { yearOutlook } from '../../shared/scope-report.ts';
import { paidThrough } from '../../shared/receivables.ts';
import { normName, peopleLedger, personAmounts } from '../../shared/people.ts';
import { t } from '../../shared/i18n.ts';
import { searchAppStore } from '../appstore.ts';
import { filteredSubs, LIST_FILTER, monthReportOut, scopeReportOut } from './report-tools.ts';
import { objectSchema as obj } from '../../shared/tool-schema.ts';
import { categoryCounts, categoryList } from '../../shared/categories.ts';
import { netCost, transferRows, transferredStop, transferSign, transfersOf, transferValue } from '../../shared/transfers.ts';
import type { Tool } from './tool-kit.ts';
import { state, findSub, rangeOf, chargesIn, groupOf, missingRates, outCcy, DATE, SUBREF, CURRENCY_OUT, PERIOD, str, date, methodRef } from './tool-kit.ts';
import { money, round, fin, fxGaps, personRow, periodsOut, row, chargeRow, collectCcy, chargeCcy, roundAll } from './tool-views.ts';

export const get_overview: Tool = {
  name: 'get_overview',
  description:
    'Snapshot of the subscription ledger: today, base currency, my monthly recurring spend (MRR — excludes proxy payments made on behalf of others, counts only my share of shared plans), active count, payment methods (ids), categories and regions in use, top insights. Call this first to learn ids and categories.',
  inputSchema: obj({ currency_out: CURRENCY_OUT }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a) ?? st.settings.baseCurrency;
    const t = totals(st, today);
    const gaps = fxGaps();
    const conv = (v: number) => fin(gaps.note(toBaseOrNaN(st, v, st.settings.baseCurrency, undefined, out)) as number);
    const mrr = conv(t.mrr);
    const figures = { mrr, yearly: conv(t.mrr * 12), gross_mrr: conv(t.grossMrr), share_recovered_mrr: conv(t.recoverMrr) };
    return {
      today,
      base_currency: st.settings.baseCurrency,
      currency_out: out,
      ...figures,
      ...partialOut(totals({ ...st, settings: { ...st.settings, baseCurrency: out } }, today).partial.mrr),
      // 缺汇率时总数为 null：列出没有当前汇率的币种（包括换算目标）
      incomplete: gaps.out().incomplete,
      fx_missing: gaps.out().incomplete ? missingRates(st, [out, ...st.subscriptions.flatMap((s) => phaseSubs(s).map((v) => v.currency))]) : [],
      active_count: t.activeCount,
      subscription_count: st.subscriptions.length,
      methods: st.methods.map((m) => ({ id: m.id, name: m.name, kind: m.kind, currency: m.currency, region: m.region ?? null, balance: m.balance ?? null })),
      // 分类按用户排的顺序，只列用到的；图标颜色等见 list_categories
      categories: categoryList(st.settings, st.subscriptions)
        .map((c) => c.name)
        .filter((n) => st.subscriptions.some((s) => s.category === n)),
      regions: [...new Set(st.subscriptions.flatMap((s) => phaseSubs(s).map((v) => v.region)).filter(Boolean))],
      insights: insights(st, today)
        .slice(0, 5)
        .map((i) => ({ tone: i.tone, title: i.title, body: i.body })),
    };
  },
};

export const list_categories: Tool = {
  name: 'list_categories',
  description:
    'List the user’s categories in display order: name, icon (a Lucide icon name or an emoji), color, built-in code if any, and how many subscriptions use it (total / live). Call this before assigning categories. Use an existing code/name in create_subscription and update_subscription; unknown names fail unless create_category=true. For a missing category use save_category action=create or explicitly set create_category=true.',
  inputSchema: obj({}),
  async run(_a, ctx) {
    const { st, today } = await state(ctx);
    const all = categoryCounts(st.subscriptions);
    const live = categoryCounts(st.subscriptions.filter((s) => ['active', 'trial', 'ending', 'paused'].includes(effectiveStatus(s, today))));
    return {
      items: categoryList(st.settings, st.subscriptions).map((c) => ({
        name: c.name,
        icon: c.icon ?? null,
        color: c.color ?? null,
        builtin: c.preset ?? null,
        subscriptions: all.get(c.name) ?? 0,
        live: live.get(c.name) ?? 0,
      })),
    };
  },
};

export const list_subscriptions: Tool = {
  name: 'list_subscriptions',
  description:
    'List subscriptions with status, current price, monthly cost, next/last charge, payment method and region. Filter by fuzzy name query, status, kind (mine / share_owner = shared plan I organize / share_member = shared plan I joined / proxy = paid on behalf of someone), category, method or region. Stop summaries distinguish non-renewal (end only), voluntary immediate cancellation and provider termination; stop includes kind, date, paidThrough, reason, refunded, refundStatus (none / partial / full; a pro-rata refund of the remaining days counts as full), unusedDays (stop date to paidThrough), unusedValue and wastedDays (days not covered by the refund). Use query to find a subscription id.',
  inputSchema: obj({
    query: {
      type: 'string',
      description:
        'Search name, login account, tags, notes, category, region and payment method. Same-name subscriptions may belong to different accounts; inspect candidates instead of assuming duplicates.',
    },
    status: {
      type: 'string',
      enum: ['active', 'trial', 'paused', 'ending', 'ended', 'terminated', 'upcoming', 'lifetime', 'live', 'all'],
      default: 'live',
      description: 'live = active+trial+ending+paused.',
    },
    kind: { type: 'string', enum: ['mine', 'share_owner', 'share_member', 'proxy', 'all'], default: 'all' },
    category: { type: 'string' },
    method: { type: 'string', description: 'Payment method id or name.' },
    region: { type: 'string', description: 'ISO country code, e.g. TR.' },
    sort: { type: 'string', enum: ['next_charge', 'monthly_cost', 'name', 'start'], default: 'next_charge' },
    limit: { type: 'integer', default: 100 },
    currency_out: CURRENCY_OUT,
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a);
    const q = str(a.query)?.toLowerCase();
    const status = str(a.status) ?? 'live';
    const method = a.method ? methodRef(st, a.method) : undefined;
    let rows = st.subscriptions
      .filter(
        (s) =>
          !q ||
          [s.name, s.account, ...s.tags, s.notes, s.category, s.region, st.methods.find((m) => m.id === s.methodId)?.name]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q),
      )
      .map((s) => row(st, s, today, out))
      .filter((r) => status === 'all' || (status === 'live' ? ['active', 'trial', 'ending', 'paused'].includes(r.status) : r.status === status))
      .filter((r) => !a.kind || a.kind === 'all' || r.kind === a.kind)
      .filter((r) => !a.category || r.category === a.category)
      .filter((r) => !method || r.method_id === method)
      .filter((r) => !a.region || r.region === String(a.region).toUpperCase());
    const sort = str(a.sort) ?? 'next_charge';
    rows.sort((x, y) =>
      sort === 'monthly_cost'
        ? (y.monthly.converted ?? -Infinity) - (x.monthly.converted ?? -Infinity) || 0
        : sort === 'name'
          ? x.name.localeCompare(y.name)
          : sort === 'start'
            ? y.start.localeCompare(x.start)
            : (x.next_charge ?? '9').localeCompare(y.next_charge ?? '9'),
    );
    rows = rows.slice(0, Number(a.limit ?? 100));
    const gaps = fxGaps();
    for (const r of rows) for (const m of [r.price, r.monthly]) gaps.note(m.converted, m.currency);
    return {
      count: rows.length,
      ...gaps.out(),
      ...partialOut(
        sumTotals(
          rows.map((r) =>
            monthlyPriceTotal(
              st,
              st.subscriptions.find((s) => s.id === r.id)!,
              today,
              out ?? st.settings.baseCurrency,
            ),
          ),
        ),
      ),
      items: rows,
    };
  },
};

export const get_subscription: Tool = {
  name: 'get_subscription',
  description:
    'Full detail of one subscription: every phase (region or plan switches, gaps = lapses), price history, intro/bonus periods, recent and upcoming charges, shared-plan member dues, proxy repayments, and totals spent so far. Stop summaries include provider termination reasons, refunds and paid-but-unused days/value for each phase.',
  inputSchema: obj(
    { subscription: SUBREF, months_back: { type: 'integer', default: 12 }, months_forward: { type: 'integer', default: 6 }, currency_out: CURRENCY_OUT },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a);
    const s = findSub(st, a.subscription);
    const all = chargesBetween(s, s.start, today, today);
    const gaps = fxGaps();
    const spent = all.reduce((t, c) => t + (gaps.note(chargeBaseOrNaN(st, c, out ?? st.settings.baseCurrency), chargeCcy(c)) as number), 0);
    const from = addMonths(today, -Number(a.months_back ?? 12));
    const to = addMonths(today, Number(a.months_forward ?? 6));
    const px = s.proxy;
    const collect = collectCcy(st);
    return {
      ...row(st, s, today, out),
      record: s, // Complete editable history, stable receipt indices and original currencies.
      notes: s.notes ?? null,
      account: s.account ?? null,
      url: s.url ?? null,
      intro: s.intro ?? null,
      bonus: s.bonus ?? null,
      expires: renewalDates(s, today).serviceExpires ?? null,
      spent_total: {
        amount: fin(spent),
        ...partialOut(chargesTotal(st, all, out ?? st.settings.baseCurrency)),
        ...gaps.out(),
        currency: out ?? st.settings.baseCurrency,
        charges: all.length,
        from: s.estimateFrom ?? s.start,
        history_complete: !s.estimateFrom,
      },
      // 转让收付（二手买入付给原主、卖出收到的实际现金）；index 为同一天内的序号，供 record_transfer replace/delete
      transfers: transfersOf(s).map((tr) => ({
        kind: tr.kind,
        date: tr.date,
        index: (s.transfers ?? []).filter((x) => x.date === tr.date).indexOf(tr),
        amount: tr.amount,
        currency: tr.currency,
        base_amount: fin(transferValue(st, tr, out ?? st.settings.baseCurrency)),
        note: tr.note ?? null,
      })),
      // 生命周期净成本 = 服务付款 + 买入 − 卖出；持有期从最早买入（早于开始时）到最后一次卖出
      net_cost: (() => {
        const c = netCost(st, s, today, out ?? st.settings.baseCurrency);
        return {
          ...partialOut(c.partial),
          currency: c.currency,
          service: fin(c.service),
          bought: fin(c.bought),
          sold: fin(c.sold),
          net: fin(c.net),
          holding_from: c.from,
          holding_until: c.until,
          holding_days: c.days,
          per_month: fin(c.perMonth),
          per_day: fin(c.perDay),
          complete: !c.incomplete && !s.estimateFrom,
        };
      })(),
      phases: phaseSubs(s).map((v) => ({
        start: v.start,
        end: v.end ?? null,
        stop: stopSummary(v, today) ?? null,
        // 卖出时剩余服务随转让收回：该阶段不计已付未用损失
        transferred_on: transferredStop(v)?.date ?? null,
        price: v.price,
        currency: v.currency,
        cycle: cycleLabel(v.cycle),
        region: v.region ?? null,
        method: st.methods.find((m) => m.id === v.methodId)?.name ?? null,
        price_history: v.priceHistory ?? null,
        planned: !!v.planned,
      })),
      charges: chargesBetween(s, from, to, today).map((c) => chargeRow(st, c, out)),
      share: s.share
        ? {
            role: s.share.role,
            collect_from: collectionAnchor(s),
            seats: s.share.seats,
            members: s.share.members.map((m) => ({
              id: m.id,
              name: m.name,
              ...(() => {
                const l = memberLedger(s, m, today, collect);
                return { paid_until: paidThrough(l.periods) ?? null, periods: periodsOut(l.periods), unmatched_records: l.unmatched };
              })(),
              joined: m.joined ?? null,
              first_period: m.firstPeriod ?? 'prorate',
              first_amount: m.firstAmount ?? null,
              left: m.left ?? null,
              leave_refund: m.leaveRefund ?? null,
              exempt: !!m.exempt,
            })),
            dues: memberDues(s, today, collectCcy(st), st)
              .filter((d) => d.periodsOwed > 0)
              .map((d) => ({
                member: d.member.name,
                periods_owed: d.periodsOwed,
                owed: { ...money(st, d.owed, d.currency, undefined, out), ...partialOut(dueTotal(st, d, undefined, out)) },
              })),
          }
        : null,
      proxy: px
        ? {
            for: px.forName,
            // 各期（含已预收、还没到扣款日的期）；period 即扣款日
            ...(() => {
              const l = proxyLedger(s, today);
              return { periods: periodsOut(l.periods), unmatched_records: l.unmatched };
            })(),
          }
        : null,
    };
  },
};

export const list_charges: Tool = {
  name: 'list_charges',
  description:
    'Charges (actual and projected) in a period: today, next 3 days, next 7/30 days, this or next month, last 30 days, this year, or custom from/to. scope=mine excludes proxy payments and reports my_amount as my share for shared plans; gross = full card charges incl. proxy payments; proxy = only proxy payments.',
  inputSchema: obj({
    period: { ...PERIOD, default: 'next_30_days' },
    from: DATE,
    to: DATE,
    scope: { type: 'string', enum: ['mine', 'gross', 'proxy'], default: 'mine' },
    subscription: SUBREF,
    method: { type: 'string', description: 'Payment method id or name.' },
    include_projected: { type: 'boolean', default: true },
    currency_out: CURRENCY_OUT,
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a);
    const [from, to] = rangeOf(a.period ?? 'next_30_days', today, a.from, a.to);
    const sub = a.subscription ? findSub(st, a.subscription) : undefined;
    const method = a.method ? methodRef(st, a.method) : undefined;
    const scope = str(a.scope) ?? 'mine';
    const charges = (sub ? chargesBetween(sub, from, to, today) : chargesIn(st, from, to, today, scope))
      .filter((c) => !method || chargeMethodId(c) === method)
      .filter((c) => a.include_projected !== false || !c.projected);
    const items = charges.map((c) => chargeRow(st, c, out));
    // 有一笔折算不了，合计就是 null 并标出缺哪些币种，不把它当 0 加进去
    const sum = (k: 'converted' | 'my') => fin(items.reduce((t, i) => t + ((k === 'my' ? i.my_amount : i.amount.converted) ?? NaN), 0));
    const missing = [...new Set(charges.filter((c) => !Number.isFinite(chargeBaseOrNaN(st, c, out ?? st.settings.baseCurrency))).map(chargeCcy))].sort();
    return {
      from,
      to,
      today,
      currency: out ?? st.settings.baseCurrency,
      count: items.length,
      total: sum('converted'),
      my_total: sum('my'),
      ...partialOut(chargesTotal(st, charges, out ?? st.settings.baseCurrency)),
      incomplete: missing.length > 0,
      fx_missing: missing,
      items,
    };
  },
};

export const spending_stats: Tool = {
  name: 'spending_stats',
  description:
    'Aggregate spending over a period, grouped by month, year, category, payment method, currency, region or subscription. Cash basis: each past charge converted at its own day’s FX rate. scope=mine (default) excludes proxy payments and counts my share of shared plans. Provider charges only by default; include_transfers=true adds second-hand transfers dated up to today (buy = cost, sell = negative; grouped under their subscription, transfer currency and month, method = "transfer"), which matches the calendar month report total for a calendar month — for that whole report prefer get_insights section=month_report. filter narrows to a subset with the same rules as the web list filter and get_insights section=scope_report (proxy payments then never match). Charges without a usable FX rate make their group and the total null with incomplete=true and fx_missing currencies.',
  inputSchema: obj({
    period: { ...PERIOD, default: 'this_year' },
    from: DATE,
    to: DATE,
    group_by: { type: 'string', enum: ['month', 'year', 'category', 'method', 'currency', 'region', 'subscription', 'none'], default: 'category' },
    scope: { type: 'string', enum: ['mine', 'gross', 'proxy'], default: 'mine' },
    include_projected: { type: 'boolean', default: true, description: 'Include projected (future) charges inside the period.' },
    include_transfers: { type: 'boolean', default: false, description: 'Add second-hand buy/sell cash (not with scope=proxy).' },
    filter: LIST_FILTER,
    top: { type: 'integer', default: 30 },
    currency_out: CURRENCY_OUT,
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a) ?? st.settings.baseCurrency;
    const [from, to] = rangeOf(a.period ?? 'this_year', today, a.from, a.to);
    const scope = str(a.scope) ?? 'mine';
    const by = str(a.group_by) ?? 'category';
    const ids = a.filter ? new Set(filteredSubs(st, today, a.filter as Record<string, unknown>).map((s) => s.id)) : undefined;
    const groups = new Map<string, { key: string; label: string; total: number; count: number; missing: boolean; partial: FxTotal }>();
    const fxMissing = new Set<string>();
    let total = 0;
    const add = (key: string, label: string, v: number, ccy: string, original: number) => {
      const g = groups.get(key) ?? { key, label, total: 0, count: 0, missing: false, partial: emptyTotal() };
      g.partial = sumTotals([g.partial, amountTotal(original, ccy, v)]);
      if (Number.isFinite(v)) g.total += v;
      else {
        g.missing = true;
        fxMissing.add(ccy);
      }
      g.count++;
      groups.set(key, g);
    };
    for (const c of chargesIn(st, from, to, today, scope)) {
      if (a.include_projected === false && c.projected) continue;
      if (ids && !ids.has(c.sub.id)) continue;
      const sub = st.subscriptions.find((x) => x.id === c.sub.id) ?? c.sub;
      // 缺汇率为 NaN：标为不完整而不是算进 0
      const v = chargeBaseOrNaN(st, c, out) * (scope === 'mine' ? myShareFactor(c.sub, c.date) : 1);
      const ccy = chargeCcy(c);
      // 按支付方式分组时，拆分付款按份额分到各来源
      for (const x of by === 'method' ? chargeSources(c) : [{ methodId: chargeMethodId(c), share: 1 }]) {
        const m = st.methods.find((y) => y.id === x.methodId);
        const [key, label] = groupOf(by, c, sub, m);
        add(
          key,
          label,
          v * x.share,
          ccy,
          (c.settled && !c.projected ? c.settled.amount : c.amount) * (scope === 'mine' ? myShareFactor(c.sub, c.date) : 1) * x.share,
        );
      }
      total += v;
    }
    let transferTotal = 0;
    if (a.include_transfers === true && scope !== 'proxy') {
      const subs = st.subscriptions.filter((s) => !s.proxy && (!ids || ids.has(s.id)));
      for (const r of transferRows({ ...st, subscriptions: subs }, from, to, today)) {
        const v = transferSign(r.transfer) * transferValue(st, r.transfer, out);
        const as = { date: r.date, currency: r.transfer.currency, sub: r.sub } as Charge;
        const [key, label] = by === 'method' ? ['transfer', t('mcp.label.transfer')] : groupOf(by, as, r.sub, undefined);
        add(key, label, v, r.transfer.currency, transferSign(r.transfer) * r.transfer.amount);
        total += v;
        transferTotal += v;
      }
    }
    const list = [...groups.values()].sort((x, y) => (by === 'month' || by === 'year' ? x.key.localeCompare(y.key) : y.total - x.total));
    const ok = Number.isFinite(total);
    return {
      from,
      to,
      currency: out,
      scope,
      total: ok ? round(total) : null,
      ...partialOut(sumTotals(list.map((g) => g.partial))),
      ...(a.include_transfers === true ? { transfer_total: Number.isFinite(transferTotal) ? round(transferTotal) : null } : {}),
      incomplete: !ok,
      fx_missing: [...fxMissing].sort(),
      groups: list.slice(0, Number(a.top ?? 30)).map(({ missing, partial, ...g }) => ({
        ...g,
        ...partialOut(partial),
        total: missing ? null : round(g.total),
        share_pct: missing || !ok ? null : total > 0 ? Math.round((g.total / total) * 1000) / 10 : 0,
      })),
    };
  },
};

export const get_trends: Tool = {
  name: 'get_trends',
  description:
    'Time series: monthly MRR history, cash-vs-accrual by month (cash = what was charged; accrual = cost spread over the period it covers), or MRR movement between two dates (added / expansion / contraction / churn / FX effect).',
  inputSchema: obj({
    metric: { type: 'string', enum: ['mrr', 'cash_vs_accrual', 'movement'], default: 'mrr' },
    months_back: { type: 'integer', default: 12 },
    months_forward: { type: 'integer', default: 3, description: 'cash_vs_accrual only.' },
    from: { ...DATE, description: 'movement only: start date (default: one month ago).' },
    to: { ...DATE, description: 'movement only: end date (default: today).' },
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const metric = str(a.metric) ?? 'mrr';
    if (metric === 'mrr')
      return {
        currency: st.settings.baseCurrency,
        points: mrrSeries(st, today, Number(a.months_back ?? 12)).map(({ partial, ...p }) => ({
          ...roundAll(p),
          ...partialOut(partial),
          incomplete: partial.incomplete,
          fx_missing: Object.keys(partial.unconverted),
        })),
      };
    if (metric === 'cash_vs_accrual')
      return {
        currency: st.settings.baseCurrency,
        points: cashVsAccrual(st, today, Number(a.months_back ?? 12), Number(a.months_forward ?? 3)).map(({ partial, ...p }) => ({
          ...roundAll(p),
          cash: partial.cash.incomplete ? null : fin(p.cash),
          accrual: partial.accrual.incomplete ? null : fin(p.accrual),
          ...partialOut(partial.cash),
          incomplete: partial.cash.incomplete || partial.accrual.incomplete,
          fx_missing: [...new Set([...Object.keys(partial.cash.unconverted), ...Object.keys(partial.accrual.unconverted)])],
          totals: { cash: partialOut(partial.cash), accrual: partialOut(partial.accrual) },
        })),
      };
    const mv = movement(st, date(a.from, 'from', addMonths(today, -1)), date(a.to, 'to', today));
    return {
      currency: st.settings.baseCurrency,
      ...roundAll({ ...mv, items: undefined, partial: undefined }),
      ...partialOut(mv.partial.to),
      totals: { from: partialOut(mv.partial.from), to: partialOut(mv.partial.to) },
      items: mv.items.map((i) => ({ name: i.sub.name, kind: i.kind, delta: fin(i.delta) })),
    };
  },
};

export const list_payment_methods: Tool = {
  name: 'list_payment_methods',
  description:
    'Payment methods (bank cards, App Store region balances, crypto cards, prepaid balances…) with current estimated balance, monthly drain, runway (how long the balance lasts, first shortfall) and a top-up suggestion.',
  inputSchema: obj({ topup_months: { type: 'integer', default: 6 } }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const plans = topUpPlan(st, today, Number(a.topup_months ?? 6));
    return {
      items: st.methods.map((m) => {
        const r = runwayFor(m, st, today);
        const p = plans.find((x) => x.method.id === m.id);
        return {
          record: m,
          top_ups: (m.topUps ?? []).map((p, index) => ({ index, ...p })),
          id: m.id,
          name: m.name,
          kind: m.kind,
          currency: m.currency,
          region: m.region ?? null,
          balance: r ? fin(r.current) : (m.balance ?? null),
          balance_as_of: m.balanceAsOf ?? null,
          subscriptions: st.subscriptions
            .filter(
              (s) =>
                [currentPhase(s, today), ...activePhases(s, today)].some((v) => v.methodId === m.id) &&
                ['active', 'trial', 'ending'].includes(effectiveStatus(s, today)),
            )
            .map((s) => s.name),
          runway: r
            ? {
                ...partialOut(r.partial.monthlyDrain),
                totals: { current: partialOut(r.partial.current), monthly_drain: partialOut(r.partial.monthlyDrain), topup: partialOut(r.partial.topUp12m) },
                monthly_drain: fin(r.monthlyDrain),
                // 余额估算或月耗用到了折算不了的扣款：数字为 null，不当成 0
                incomplete: !Number.isFinite(r.current) || !Number.isFinite(r.monthlyDrain) || ('incomplete' in r && !!r.incomplete),
                covered_charges: r.coveredCharges,
                runs_out_on: r.runsOutOn ?? null,
                shortfall: r.shortfall ? { date: r.shortfall.date, name: r.shortfall.sub.name, amount: fin(r.shortfall.amount) } : null,
              }
            : null,
          topup:
            p && (p.need > 0 || !Number.isFinite(p.need))
              ? { ...partialOut(p.partial.need), need: fin(p.need), min_need: fin(p.minNeed), deadline: p.deadline ?? null }
              : null,
        };
      }),
    };
  },
};

export const list_people: Tool = {
  name: 'list_people',
  description:
    'People in the ledger (shared-plan members and people I pay on behalf of, each listed once): contact, which shared plans / proxy payments they are in and the separate account on each shared plan, how much they owe me now, how much they have paid so far and when they last paid. Use query to find someone by name.',
  inputSchema: obj({
    query: { type: 'string', description: 'Fuzzy name filter.' },
    owing_only: { type: 'boolean', default: false },
    currency_out: CURRENCY_OUT,
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a) ?? st.settings.baseCurrency;
    const q = normName(str(a.query));
    const list = peopleLedger(st, today).filter((l) => (!q || normName(l.person.name).includes(q)) && (!a.owing_only || l.periodsOwed > 0));
    const rows = list.map((l) => personRow(st, l, out, today));
    const total = rows.reduce((x, r) => x + (r.owed ?? NaN), 0);
    return {
      currency: out,
      count: rows.length,
      total_owed: fin(total),
      incomplete: !Number.isFinite(total),
      ...partialOut(sumTotals(list.map((l) => personAmounts(st, l, today, out).owed))),
      people: rows,
    };
  },
};

export const get_receivables: Tool = {
  name: 'get_receivables',
  description:
    'Money others owe me: by_person totals each person across all their shared plans and proxy payments; share lists shared-plan members whose payment is due/overdue; proxy lists charges paid on behalf of someone not yet repaid.',
  inputSchema: obj({ kind: { type: 'string', enum: ['share', 'proxy', 'all'], default: 'all' }, currency_out: CURRENCY_OUT }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const out = outCcy(st, a) ?? st.settings.baseCurrency;
    const kind = str(a.kind) ?? 'all';
    const share =
      kind === 'proxy'
        ? []
        : st.subscriptions.flatMap((s) =>
            memberDues(s, today, collectCcy(st), st)
              .filter((d) => d.periodsOwed > 0)
              .map((d) => ({
                subscription_id: s.id,
                name: s.name,
                person_id: d.member.personId ?? null,
                member: d.member.name,
                contact: d.member.contact ?? null,
                periods_owed: d.periodsOwed,
                first_unpaid: d.dueFor,
                owed: { ...money(st, d.owed, d.currency, undefined, out), ...partialOut(dueTotal(st, d, undefined, out)) },
              })),
          );
    const proxy =
      kind === 'share'
        ? []
        : st.subscriptions
            .filter((s) => s.proxy)
            .flatMap((s) =>
              proxyLedger(s, today)
                .periods.filter((p) => p.status === 'due')
                .map((p) => ({
                  subscription_id: s.id,
                  name: s.name,
                  person_id: s.proxy!.personId ?? null,
                  for: s.proxy!.forName,
                  charge: p.key,
                  charged: money(st, p.due, p.currency, p.from, out),
                })),
            );
    const gaps = fxGaps();
    const total =
      share.reduce((t, x) => {
        const currencies = Object.keys(x.owed.unconverted);
        if (x.owed.converted == null && currencies.length) currencies.forEach((c) => gaps.note(null, c));
        else gaps.note(x.owed.converted, x.owed.currency);
        return t + (x.owed.converted ?? NaN);
      }, 0) + proxy.reduce((t, x) => t + (gaps.note(x.charged.converted, x.charged.currency) ?? NaN), 0);
    // 按人汇总：只列现在欠钱的人，金额与下面的明细同源（memberDues / 代付逐期对账）
    const by_person = peopleLedger(st, today)
      .map((l) => ({ ...l, items: l.items.filter((i) => i.periodsOwed > 0 && (kind === 'all' || i.kind === kind)) }))
      .filter((l) => l.items.length)
      .map((l) => ({ ...l, owed: l.items.reduce((a, i) => a + i.owed, 0), periodsOwed: l.items.reduce((a, i) => a + i.periodsOwed, 0) }))
      .map((l) => personRow(st, l, out, today))
      .sort((a, b) => (b.owed ?? Infinity) - (a.owed ?? Infinity) || 0);
    return {
      currency: out,
      total_outstanding: fin(total),
      ...gaps.out(),
      ...partialOut(
        sumTotals([
          ...share.flatMap((x) => [
            amountTotal(x.owed.known_total, out, x.owed.known_total),
            ...Object.entries(x.owed.unconverted).map(([ccy, value]) => amountTotal(value, ccy, NaN)),
          ]),
          ...proxy.map((x) => amountTotal(x.charged.amount ?? NaN, x.charged.currency, x.charged.converted ?? NaN)),
        ]),
      ),
      by_person,
      share,
      proxy,
    };
  },
};

export const get_insights: Tool = {
  name: 'get_insights',
  description:
    'Health check and reports: insights (renewals, price hikes, low balances, duplicates), year_review (spending and losses from stops in that year), year_outlook (this year paid + forecast, Jan 1–today vs the same period last year with per-subscription drivers, next month and next year forecasts; same figures as the web report year card), prepaid (remaining prepaid value), cancel_savings (money saved by cancelling), stop_losses (unrefunded unused service after cancellation or provider termination, by phase and type), month_report (the calendar month report for month=YYYY-MM: net cash total/paid/pending incl. second-hand transfers, vs previous month and last year, MRR movement, composition, top, upcoming, events, losses, sharing, six-month cash series), scope_report (the web list selection report for filter: MRR, annual, paid this year, 12+3 month cash vs accrual, composition, top, upcoming, events, losses, sharing). Use month_report for "how much did I spend in <month>" so answers match the calendar, scope_report for questions about a subset (category, status, payment method, tag, region, search or named subscriptions). Report amounts are base currency at my share; charge rows also carry the original bill. Stop losses cover all history through today, exclude proxy payments and count only my share, using stop-date FX; prorated full refunds have no loss. Missing FX keeps original amounts but returns null base amounts/totals with an incomplete flag.',
  inputSchema: obj({
    section: {
      type: 'string',
      enum: ['insights', 'year_review', 'year_outlook', 'prepaid', 'cancel_savings', 'stop_losses', 'month_report', 'scope_report'],
      default: 'insights',
    },
    year: { type: 'string', description: 'year_review only, e.g. 2025.' },
    month: { type: 'string', description: 'month_report only: YYYY-MM, default this month.' },
    filter: { ...LIST_FILTER, description: `scope_report only. ${LIST_FILTER.description}` },
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const sec = str(a.section) ?? 'insights';
    const base = st.settings.baseCurrency;
    if (sec === 'month_report') return monthReportOut(st, str(a.month) ?? today.slice(0, 7), today);
    if (sec === 'scope_report') return scopeReportOut(st, today, a.filter as Record<string, unknown> | undefined);
    if (sec === 'insights')
      return { items: insights(st, today).map((i) => ({ tone: i.tone, title: i.title, body: i.body, subscriptions: i.subs?.map((s) => s.name) ?? [] })) };
    if (sec === 'year_outlook') {
      const r = yearOutlook(st, today);
      const span = (x: { total: number; paid: number; pending: number; partial: { total: FxTotal } }) =>
        x.partial.total.incomplete
          ? { total: null, paid: null, pending: null, ...partialOut(x.partial.total) }
          : { total: fin(x.total), paid: fin(x.paid), pending: fin(x.pending), ...partialOut(x.partial.total) };
      // 无可比（对比期没有现金）为 null；缺汇率时 change 为 null
      const delta = (c?: { amount: number; percent?: number | null }) =>
        c
          ? { change: Number.isFinite(c.amount) ? fin(c.amount) : null, change_percent: Number.isFinite(c.percent ?? NaN) ? round(c.percent! * 100) : null }
          : null;
      const same = r.samePeriod;
      const ok = !!same.change && Number.isFinite(same.change.amount);
      return {
        currency: base,
        basis:
          'Net cash at my share: charges (refunds negative) plus second-hand transfers up to today; after today, forecast from current plans. Proxy payments excluded.',
        year: r.year,
        this_year: span(r.current),
        same_period: {
          from: `${r.year}-01-01`,
          through: same.through,
          previous_from: `${Number(r.year) - 1}-01-01`,
          previous_through: same.previousThrough,
          amount: same.partial.amount.incomplete ? null : fin(same.amount),
          previous: same.partial.previous.incomplete ? null : fin(same.previous),
          change: ok ? fin(same.change!.amount) : null,
          change_percent: ok && same.change!.percent != null ? round(same.change!.percent * 100) : null,
          no_previous: !same.change,
          incomplete: !!same.change && !ok,
        },
        drivers: ok
          ? r.drivers.slice(0, 10).map((d) => ({ name: d.sub.name, kind: d.kind, this_year: fin(d.current), last_year: fin(d.previous), change: fin(d.delta) }))
          : [],
        next_month: { month: r.nextMonth.month, ...span(r.nextMonth), vs_same_month_last_year: delta(r.nextMonth.change) },
        next_year: { year: r.nextYear.year, ...span(r.nextYear), vs_this_year: delta(r.nextYear.change) },
      };
    }
    if (sec === 'year_review') {
      const r = yearReview(st, today, str(a.year) ?? today.slice(0, 4));
      return {
        currency: base,
        year: r.year,
        stop_loss: Number.isFinite(r.stopLoss) ? round(r.stopLoss) : null,
        stop_loss_incomplete: !Number.isFinite(r.stopLoss),
        total: fin(r.total),
        ...partialOut(r.partial.total),
        charges: r.charges,
        per_day: fin(r.perDay),
        currencies: r.currencies,
        top: r.items.slice(0, 10).map((x) => ({ name: x.sub.name, total: fin(x.sum), ...partialOut(r.partial.bySub[x.sub.id]) })),
        longest: r.longest ? { name: r.longest.sub.name, days: r.longest.days } : null,
        busiest_month: r.busiestMonth
          ? { month: r.busiestMonth.month, total: fin(r.busiestMonth.sum), ...partialOut(r.partial.byMonth[r.busiestMonth.month]) }
          : null,
        new: r.newSubs.map((s) => s.name),
        ended: r.ended.map((s) => s.name),
      };
    }
    if (sec === 'prepaid') {
      const p = prepaidValue(st, today);
      return {
        currency: base,
        total: p.partial.incomplete ? null : fin(p.total),
        ...partialOut(p.partial),
        unused_total: Number.isFinite(p.unusedTotal) ? round(p.unusedTotal) : null,
        unused_incomplete: p.unusedIncomplete,
        unused_items: p.unusedItems.map((i) => ({ name: i.sub.name, value: Number.isFinite(i.value) ? round(i.value) : null, until: i.until })),
        items: p.items.map((i) => ({ name: i.sub.name, value: i.partial.incomplete ? null : fin(i.value), until: i.until, ...partialOut(i.partial) })),
      };
    }
    if (sec === 'stop_losses') {
      const losses = stopLosses(st, today);
      const baseAmount = (n: number) => (Number.isFinite(n) ? round(n) : null);
      return {
        currency: base,
        as_of: today,
        total: baseAmount(losses.total),
        ...partialOut(losses.partial),
        incomplete: losses.incomplete,
        by_type: { cancel: baseAmount(losses.byKind.cancel), terminate: baseAmount(losses.byKind.terminate) },
        items: losses.items.map((i) => ({
          subscription_id: i.sub.id,
          name: i.sub.name,
          phase_index: i.phaseIndex,
          phase_start: i.phase.start,
          kind: i.kind,
          date: i.date,
          paid_through: i.paidThrough,
          ...(i.kind === 'terminate' && i.reason ? { reason: i.reason } : {}),
          currency: i.currency,
          paid: round(i.paid),
          paid_base: baseAmount(i.paidBase),
          refunded: round(i.refunded),
          refunded_base: baseAmount(i.refundedBase),
          loss: round(i.loss),
          loss_base: baseAmount(i.lossBase),
          fx_missing: i.fxMissing,
          refund_status: i.refundStatus,
          wasted_days: i.wastedDays,
        })),
      };
    }
    const c = cancelSavings(st, today);
    return {
      currency: base,
      total: c.partial.incomplete ? null : fin(c.total),
      ...partialOut(c.partial),
      incomplete: c.partial.incomplete,
      items: c.items.map((i) => ({
        name: i.sub.name,
        saved: i.partial.incomplete ? null : fin(i.saved),
        since: i.since,
        monthly: i.partial.incomplete ? null : fin(i.monthly),
        ...partialOut(i.partial),
      })),
    };
  },
};

export const list_events: Tool = {
  name: 'list_events',
  description:
    'Changelog of spending decisions: subscriptions started, ended, paused, resumed, price changes and plan/region switches, each with its effect on monthly spend (base currency).',
  inputSchema: obj({ since: DATE, until: DATE, subscription: SUBREF, limit: { type: 'integer', default: 50 } }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const sub = a.subscription ? findSub(st, a.subscription) : undefined;
    const items = events(st, today)
      .filter((e) => (!a.since || e.date >= String(a.since)) && (!a.until || e.date <= String(a.until)) && (!sub || e.sub.id === sub.id))
      .slice(0, Number(a.limit ?? 50))
      .map((e) => ({ date: e.date, subscription_id: e.sub.id, name: e.sub.name, kind: e.kind, monthly_delta: fin(e.delta), note: e.note ?? null }));
    return { currency: st.settings.baseCurrency, count: items.length, items };
  },
};

export const search_app_store: Tool = {
  name: 'search_app_store',
  description:
    'Look up an app on the App Store by name or App Store link: returns name, icon URL, store URL, seller and genre. Use it to fill icon and url when creating a subscription for an app.',
  inputSchema: obj({ query: { type: 'string' }, country: { type: 'string', description: 'Two-letter store region, e.g. us, tr, cn. Defaults to us.' } }, [
    'query',
  ]),
  async run(a) {
    return { results: await searchAppStore(String(a.query ?? ''), str(a.country) ?? 'us') };
  },
};

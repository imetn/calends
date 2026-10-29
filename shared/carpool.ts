import { chargesTotal, convertedTotal, emptyTotal, scaleTotal, sumTotals } from './fx-total.ts';
// 合租的账：一年的成本与预计收入、从开始合租起实际付出与收回；成员每次该收多少。
// 后台合租页与 MCP / AI 助手共用，算出来的数一致。
import {
  chargesBetween,
  currentPhase,
  cycleDays,
  monthlyGross,
  memberAboard,
  effectiveStatus,
  memberBillMonths,
  LIFETIME_BILL_MONTHS,
  memberRate,
  addMonths,
  collectionAnchor,
  memberLedger,
  diffDays,
  collectCurrencyOf,
  DAYS_PER_MONTH,
  memberSince,
  memberPeriods,
  isStopped,
  uid,
  priceAt,
} from './billing.ts';
import { chargeBaseOrNaN, convertOn, toBaseAt, toBaseOrNaN } from './fx.ts';
import { yearCost } from './metrics.ts';
import { currencyDecimals } from './format.ts';
import { isSettled, paidThrough, putRecord, removeRecordPeriod, resolveKey, type LedgerPeriod, type Period, type Receivable } from './receivables.ts';
import type { AppState, CarRule, MemberFeePoint, ShareMember, Subscription } from './types.ts';

/** 成员实际交来、退回的钱：期初结清没有金额，不算；退款作为负数。不改变各期是否结清 */
export function memberCashFlows(m: ShareMember) {
  return [
    ...(m.receipts ?? []).filter((r) => !r.opening).map((r) => ({ ...r, kind: 'receipt' as const })),
    ...(m.leaveRefund ? [{ ...m.leaveRefund, amount: -m.leaveRefund.amount, kind: 'refund' as const }] : []),
  ];
}

/** 实收、实退按各自日期换算；缺汇率保留不可用状态。 */
export function memberFlowValue(state: AppState, p: { amount: number; currency: string; date: string }, to = state.settings.baseCurrency) {
  return convertOn(p.amount, p.currency, to, p.date, state.fxHistory, state.fx);
}

/** 首期因为退出被截短时，截短后的这一期（覆盖到退出前一天、应收按截短算）；没截短返回 undefined */
function firstPeriodCut(s: Subscription, m: ShareMember, collectCurrency: string) {
  if (!m.left) return undefined;
  const joined = memberSince(s, m);
  const real = memberCollection(s, m, joined, collectCurrency);
  return real.until < memberCollection(s, { ...m, left: undefined }, joined, collectCurrency).until ? real : undefined;
}

/** 已付至：从第一期起连续结清到哪天。已退出的按没退出算，退出前提前收了的期也算进去（成员弹窗、人员页、MCP 同一口径） */
export function memberPaidThrough(s: Subscription, m: ShareMember, today: string, collectCurrency: string): string | undefined {
  return paidThrough(memberLedger(s, m.left ? { ...m, left: undefined } : m, today, collectCurrency).periods);
}

/** 清空退出日时一并清除退款，其他历史不动。 */
export function updateMemberLeave(m: ShareMember, patch: Partial<ShareMember>): ShareMember {
  const next = { ...m, ...patch };
  return next.left ? next : { ...next, leaveRefund: undefined };
}

/**
 * 退出时建议退多少：收过钱的期里，退出日（当天已不在车上）之后没用的天数，按那一期分到的钱按天折算。
 * 期初结清的期金额不详，不计入。默认用最早一笔未用收款的币种，跨币种按退出日汇总，parts 保留原币种明细；缺汇率返回 NaN
 */
export function suggestedLeaveRefund(state: AppState, s: Subscription, m: ShareMember, currency?: string) {
  const cut = firstPeriodCut(s, m, collectCurrencyOf(state.settings));
  // 按没退出算各期，才能对上退出日之后提前收了的期
  const parts = !m.left
    ? []
    : memberLedger(s, { ...m, left: undefined }, m.left, collectCurrencyOf(state.settings), m.left).periods.flatMap((p) => {
        if (p.status !== 'paid' || p.share == null || p.until < m.left!) return [];
        const unusedFrom = p.from > m.left! ? p.from : m.left!;
        const unusedDays = diffDays(unusedFrom, p.until) + 1;
        let amount = (p.share * unusedDays) / (diffDays(p.from, p.until) + 1);
        // 首期截到退出前一天、应收按截短的算：最多退多收的部分（按截短后的应收收的就不用退）
        if (cut && p.from === cut.from) {
          const ccy = p.receipt!.currency;
          const used = cut.currency === ccy ? cut.amount : convertOn(cut.amount, cut.currency, ccy, m.left!, state.fxHistory, state.fx);
          amount = Math.max(0, Math.min(amount, p.share - used));
          if (amount < 0.005) return [];
        }
        return [{ from: p.from, until: p.until, unusedDays, amount, currency: p.receipt!.currency }];
      });
  const ccy = currency ?? parts[0]?.currency ?? m.feeCurrency ?? collectCurrencyOf(state.settings);
  const amount = parts.reduce((sum, p) => sum + convertOn(p.amount, p.currency, ccy, m.left!, state.fxHistory, state.fx), 0);
  const factor = 10 ** currencyDecimals(ccy);
  return { amount: Math.round(amount * factor) / factor, currency: ccy, unusedDays: parts.reduce((sum, p) => sum + p.unusedDays, 0), parts };
}

/**
 * 合租账本：订阅本身多少钱、我付出去多少、从成员身上收回多少，算出净成本（负数就是赚了）。
 * 预计按年算：订阅一年的费用对比成员一年应交；实际从开始合租那天（缺省为最早一笔收款）累计。
 */
export function carLedger(state: AppState, s: Subscription, today: string) {
  const cur = currentPhase(s, today);
  const members = s.share?.members ?? [];
  // 缺汇率的部分为 NaN（与收回、退款的 memberFlowValue 同一口径），不当成 0
  const yearCost = toBaseOrNaN(state, monthlyGross(cur, today) * 12, cur.currency);
  // 预计收入只算还在车上的；实际收回保留所有人（包括已退出的）的历史收款
  const yearRefunded = members.reduce((sum, m) => {
    const r = m.leaveRefund;
    return sum + (r && r.date.slice(0, 4) === today.slice(0, 4) && r.date <= today ? memberFlowValue(state, r) : 0);
  }, 0);
  // 买断的车只收一次，没有每年的收入；一次性收款算在发起至今的收回里
  const yearIncome =
    (isStopped(effectiveStatus(s, today)) || cur.cycle.unit === 'lifetime'
      ? 0
      : members.reduce((a, m) => {
          const rate = memberFee(state, s, m, today);
          return a + (m.exempt || !memberAboard(m, today) ? 0 : toBaseOrNaN(state, (rate.amount * 12) / memberBillMonths(s, m, today), rate.currency));
        }, 0)) - yearRefunded;
  const firstPay = members
    .flatMap(memberCashFlows)
    .filter((p) => p.kind === 'receipt')
    .reduce<string | undefined>((a, p) => (!a || p.date < a ? p.date : a), undefined);
  // 发起日：没填就依次用第一笔收款、最早加入的成员、订阅开始日，「发起至今」总能算出来
  const firstJoin = members.map((m) => m.joined).reduce<string | undefined>((a, d) => (d && (!a || d < a) ? d : a), undefined);
  const since = s.share?.since ?? firstPay ?? firstJoin ?? s.start;
  const paid = chargesBetween(s, since, today, today).reduce((a, c) => a + chargeBaseOrNaN(state, c), 0);
  const received = members.flatMap(memberCashFlows).reduce((a, p) => a + memberFlowValue(state, p), 0);
  const paidTotal = chargesTotal(state, chargesBetween(s, since, today, today));
  const receivedTotal = sumTotals(members.flatMap(memberCashFlows).map((p) => convertedTotal(state, p.amount, p.currency, p.date)));
  const yearCostTotal = convertedTotal(state, monthlyGross(cur, today) * 12, cur.currency);
  const yearRefundTotal = sumTotals(
    members.flatMap((m) =>
      m.leaveRefund && m.leaveRefund.date.slice(0, 4) === today.slice(0, 4) && m.leaveRefund.date <= today
        ? [convertedTotal(state, m.leaveRefund.amount, m.leaveRefund.currency, m.leaveRefund.date)]
        : [],
    ),
  );
  const yearIncomeTotal = sumTotals([
    isStopped(effectiveStatus(s, today)) || cur.cycle.unit === 'lifetime'
      ? emptyTotal()
      : sumTotals(
          members
            .filter((m) => !m.exempt && memberAboard(m, today))
            .map((m) => {
              const rate = memberFee(state, s, m, today);
              return convertedTotal(state, (rate.amount * 12) / memberBillMonths(s, m, today), rate.currency);
            }),
        ),
    scaleTotal(yearRefundTotal, -1),
  ]);
  return {
    partial: {
      paid: paidTotal,
      received: receivedTotal,
      net: sumTotals([paidTotal, scaleTotal(receivedTotal, -1)]),
      yearCost: yearCostTotal,
      yearIncome: yearIncomeTotal,
      yearNet: sumTotals([yearCostTotal, scaleTotal(yearIncomeTotal, -1)]),
    },
    hasRecords: members.some((m) => memberCashFlows(m).length > 0),
    yearCost,
    yearIncome,
    yearRefunded,
    yearNet: yearCost - yearIncome,
    since,
    paid,
    received,
    net: paid - received,
  };
}

/**
 * 一辆车今年（自然年）的盈亏：成本是今年已扣加剩下预计要扣的；收入是成员今年已经交的，
 * 加上今年里还该收的各期（含已逾期没收的）。都折成本币，买断与停止的车同样适用
 */
export function carYear(state: AppState, s: Subscription, today: string, y = today.slice(0, 4)) {
  const ccy = collectCurrencyOf(state.settings);
  const cost = yearCost(state, s, today, y);
  const members = s.share?.members ?? [];
  const received = members
    .flatMap(memberCashFlows)
    .filter((p) => p.date.slice(0, 4) === y && p.date <= today)
    .reduce((a, p) => a + memberFlowValue(state, p), 0);
  const expected = members
    .filter((m) => !m.exempt)
    .flatMap((m) =>
      memberLedger(s, m, today, ccy, `${y}-12-31`)
        .periods.filter((p) => !isSettled(p) && p.from.slice(0, 4) === y)
        .map((p) => toBaseOrNaN(state, p.due, p.currency, p.from)),
    )
    .reduce((a, v) => a + v, 0);
  const income = received + expected;
  const costTotal = chargesTotal(state, chargesBetween(s, `${y}-01-01`, `${y}-12-31`, today));
  const incomeTotal = sumTotals([
    ...members
      .flatMap(memberCashFlows)
      .filter((p) => p.date.slice(0, 4) === y && p.date <= today)
      .map((p) => convertedTotal(state, p.amount, p.currency, p.date)),
    ...members
      .filter((m) => !m.exempt)
      .flatMap((m) =>
        memberLedger(s, m, today, ccy, `${y}-12-31`)
          .periods.filter((p) => !isSettled(p) && p.from.slice(0, 4) === y)
          .map((p) => convertedTotal(state, p.due, p.currency, p.from)),
      ),
  ]);
  return { cost, income, net: income - cost, partial: { cost: costTotal, income: incomeTotal, net: sumTotals([incomeTotal, scaleTotal(costTotal, -1)]) } };
}

/**
 * 我发起的合租今年（自然年）合计盈亏：各车 carYear 相加。进行中的车都算；已停止的车只算今年还有成本或收入的。
 * 报告年卡与 MCP 共用这一处口径
 */
export function carpoolYear(state: AppState, today: string, year = today.slice(0, 4)) {
  const cars = state.subscriptions
    .filter((s) => s.share?.role === 'owner')
    .map((s) => ({ s, y: carYear(state, s, today, year) }))
    // 进行中的车只在今年及以后的年份算；往年只看那年有没有成本或收入
    .filter(
      ({ s, y }) =>
        (year >= today.slice(0, 4) && !isStopped(effectiveStatus(s, today))) ||
        y.partial.cost.value !== 0 ||
        y.partial.income.value !== 0 ||
        y.partial.net.incomplete,
    );
  return {
    subs: cars.map((c) => c.s),
    net: cars.reduce((a, c) => a + c.y.net, 0),
    partial: { net: sumTotals(cars.map((c) => c.y.partial.net)) },
  };
}

/** 订阅一期大约几个月，用来把「每期份额」换算成按月 / 季 / 年收的金额 */
export function cycleMonths(s: Subscription): number {
  // 买断没有周期：按收一次（与成员的买断收费周期一致）算，份额就是一次性的那份
  if (s.cycle.unit === 'lifetime') return LIFETIME_BILL_MONTHS;
  return Math.max(0.25, cycleDays(s.cycle) / DAYS_PER_MONTH);
}

/** 每次向这位成员收多少：填了收费标准就用它，否则由每期份额换算（订阅币种） */
export function memberFee(state: AppState, s: Subscription, m: ShareMember, day = memberSince(s, m)): { amount: number; currency: string } {
  const ccy = collectCurrencyOf(state.settings);
  return memberRate(s, m, day, ccy);
}

/** 首次调价固定旧基线；只插入收费标准，绝不改写历史收款。 */
export function changeMemberFee(state: AppState, s: Subscription, m: ShareMember, point: MemberFeePoint, today: string): ShareMember {
  const baseline = memberRate(s, m, memberSince(s, m), collectCurrencyOf(state.settings));
  const history = m.feeHistory?.length
    ? m.feeHistory
    : [
        {
          from: [memberSince(s, m), point.from].sort()[0],
          fee: baseline.amount,
          currency: baseline.currency,
          billEvery: baseline.billEvery,
          share: m.share,
        },
      ];
  const feeHistory = [
    ...history.filter((p) => p.from !== point.from),
    { ...point, share: shareFromFee(state, s, point.fee, point.currency, point.billEvery) },
  ].sort((a, b) => a.from.localeCompare(b.from));
  const next = { ...m, feeHistory };
  const current = memberRate(s, next, today, collectCurrencyOf(state.settings));
  return {
    ...next,
    fee: current.amount,
    feeCurrency: current.currency,
    billEvery: current.billEvery,
    share: m.exempt ? 0 : shareFromFee(state, s, current.amount, current.currency, current.billEvery),
  };
}

/** 由收费标准反推每期份额（订阅币种），用于算我自己的份额与成员应交 */
export function shareFromFee(state: AppState, s: Subscription, fee: number, ccy: string, billEvery: number): number {
  return Math.round(((toBaseAt(state, fee, ccy, undefined, s.currency) * cycleMonths(s)) / billEvery) * 100) / 100;
}

/**
 * 订阅换了币种或计费周期后，成员按收费标准（fee）重新折算每期份额。
 * 份额是保存成员时按当时的币种、周期算好存下的，不重算会把 ¥60 当成 $60
 */
export function resyncShares(state: AppState, prev: Subscription | undefined, next: Subscription): Subscription {
  if (!next.share || !prev || (prev.currency === next.currency && cycleMonths(prev) === cycleMonths(next))) return next;
  const ccy = collectCurrencyOf(state.settings);
  return {
    ...next,
    share: {
      ...next.share,
      members: next.share.members.map((m) =>
        m.fee != null && !m.exempt
          ? {
              ...m,
              share: shareFromFee(state, next, m.fee, m.feeCurrency ?? ccy, m.billEvery ?? memberBillMonths(next, m)),
              feeHistory: m.feeHistory?.map((p) => ({ ...p, share: shareFromFee(state, next, p.fee, p.currency, p.billEvery) })),
            }
          : m,
      ),
    },
  };
}

/** 两条收费标准是否相同（金额容差一分钱） */
export const sameRule = (a: CarRule, b: CarRule) => a.billEvery === b.billEvery && a.currency === b.currency && Math.abs(a.fee - b.fee) < 0.005;

/**
 * 车的收款规则：存了就用存的；老数据没存时，取在车成员里最常见的收费标准（周期 + 金额 + 币种）。
 * 没有可参考的成员时按订阅价格除以座位、周期同订阅推一个默认值。
 */
export function carRule(state: AppState, s: Subscription, today: string): CarRule {
  if (s.share?.rule) return s.share.rule;
  const ccy = collectCurrencyOf(state.settings);
  const counts = new Map<string, { rule: CarRule; n: number }>();
  for (const m of s.share?.members ?? []) {
    if (m.exempt || (m.left && m.left <= today)) continue;
    const r = memberRate(s, m, today, ccy);
    const rule = { billEvery: r.billEvery, fee: r.amount, currency: r.currency };
    const key = `${rule.billEvery}|${rule.currency}|${rule.fee}`;
    counts.set(key, { rule, n: (counts.get(key)?.n ?? 0) + 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (top) return top.rule;
  const months = Math.max(1, Math.round(cycleMonths(s)));
  const fee = toBaseAt(state, s.price / Math.max(1, s.share?.seats ?? 1), s.currency, undefined, ccy);
  return { billEvery: months, fee: Math.round(fee * 100) / 100, currency: ccy };
}

/** 提示订阅成本变化的窗口：生效后 60 天内、生效前 31 天内 */
const COST_CHANGE_AFTER = 60;
const COST_CHANGE_BEFORE = 31;

/**
 * 订阅最近一次成本变化（价格、币种或周期变了），供合租提示「是否调整收费标准」；只提示，不改任何收费。
 * 只看窗口内已生效或将生效的；那天或之后有在付的成员改过收费（车的收费标准改过）就不再提示
 */
export function costChange(s: Subscription, today: string) {
  const cost = (day: string) => {
    const p = currentPhase(s, day);
    return { price: priceAt(s, day), currency: p.currency, cycle: p.cycle };
  };
  const key = (c: ReturnType<typeof cost>) => `${c.price}|${c.currency}|${c.cycle.unit}|${c.cycle.every ?? 1}`;
  const days = [
    ...(s.phases ?? []).flatMap((p) => [p.start, ...(p.priceHistory ?? []).map((h) => h.from), ...(p.intro ? [p.intro.until] : [])]),
    ...(s.priceHistory ?? []).map((h) => h.from),
    ...(s.intro ? [s.intro.until] : []),
  ];
  const from = [...new Set(days)]
    .filter((d) => d > s.start && d <= addDays(today, COST_CHANGE_BEFORE) && d >= addDays(today, -COST_CHANGE_AFTER))
    .sort()
    .reverse()
    .find((d) => key(cost(d)) !== key(cost(addDays(d, -1))));
  if (!from) return undefined;
  const payers = (s.share?.members ?? []).filter((m) => !m.exempt && !(m.left && m.left <= today));
  if (!payers.length || payers.some((m) => (m.feeHistory ?? []).some((h) => h.from >= from))) return undefined;
  return { from, before: cost(addDays(from, -1)), after: cost(from) };
}

/** 车的收款日：从基准日起每隔 billEvery 个月一次；day 是不是其中一天 */
const onCarRhythm = (s: Subscription, billEvery: number, day: string) => nextCollectionDay(s, billEvery, addDays(day, -1)) === day;

/** 成员今天之后另起的收款节奏（restarts）不在车的收款日上：成员按自己的日子收 */
function offCarRhythm(s: Subscription, m: ShareMember, today: string): boolean {
  return (m.restarts ?? []).some((r) => r > today && !onCarRhythm(s, memberBillMonths(s, m, r), r));
}

/** 成员是否跟随车的规则：没标自定义、要分摊、收款日跟车走；老数据未存规则时，收费与规则一致才算跟随 */
export function followsCar(state: AppState, s: Subscription, m: ShareMember, today: string): boolean {
  if (m.custom || m.exempt || offCarRhythm(s, m, today)) return false;
  if (s.share?.rule) return true;
  const r = memberRate(s, m, today, collectCurrencyOf(state.settings));
  return sameRule({ billEvery: r.billEvery, fee: r.amount, currency: r.currency }, carRule(state, s, today));
}

/** 改单期应收：期起始日 → 新应收，null 表示恢复按收费标准算 */
export type PeriodDueChanges = Record<string, number | null>;

/** 把单期应收的改动并进成员的 periodDues：按期起始日排序，改完一条不剩时为 undefined */
export function putPeriodDues(list: ShareMember['periodDues'], changes: PeriodDueChanges): ShareMember['periodDues'] {
  const kept = (list ?? []).filter((d) => !(d.from in changes));
  const set = Object.entries(changes).flatMap(([from, amount]) => (amount == null ? [] : [{ from, amount }]));
  const out = [...kept, ...set].sort((a, b) => a.from.localeCompare(b.from));
  return out.length ? out : undefined;
}

/**
 * 取消「不分摊」：不分摊那段时间的期本来不该收。「不分摊」没有生效日，取消时把 from 之前还没结清的期记一笔免收，
 * 免得一取消就把不分摊期间全算成欠款；已经收过、免过的期不动
 */
export function waiveExemptSpan(s: Subscription, m: ShareMember, from: string, today: string, collectCurrency: string): ShareMember {
  const keys = memberLedger(s, m, today, collectCurrency, from)
    .periods.filter((p) => p.from < from && !isSettled(p) && p.due > 0)
    .map((p) => p.key);
  if (!keys.length) return m;
  return { ...m, ...putRecord(m, 'waiver', { id: uid(), date: today, periods: keys }, memberPeriods(s, m, from, collectCurrency)) };
}

/**
 * 改车的收款日（collectFrom）：新加入的成员按新日子对齐；已经加入的成员钉住原来的基准日，
 * 历史各期、已收的期都不重切，从新收款日起按新节奏接着收（那天不是现成的期起点时记一个 restarts）
 */
export function moveCollectFrom(s: Subscription, next: string): Subscription {
  if (!s.share) return s;
  const before = collectionAnchor(s);
  if (before === next) return { ...s, share: { ...s.share, collectFrom: next } };
  const members = s.share.members.map((m) => {
    if (memberSince(s, m) >= next) return m;
    const pinned: ShareMember = { ...m, anchor: m.anchor ?? before };
    if (m.left && m.left <= next) return pinned;
    const starts = memberPeriods(s, pinned, next, s.currency).map((p) => p.from);
    return starts.includes(next) || (pinned.restarts ?? []).includes(next) ? pinned : { ...pinned, restarts: [...(pinned.restarts ?? []), next].sort() };
  });
  return { ...s, share: { ...s.share, collectFrom: next, members } };
}

/**
 * 改车的收款规则：存下新规则，跟随车的成员从生效日起改用新标准（沿用调价机制，历史收款不变）；
 * 自定义收费、不分摊、已退出的成员不动。
 */
export function applyCarRule(state: AppState, s: Subscription, rule: CarRule, from: string, today: string): Subscription {
  if (!s.share) return s;
  const members = s.share.members.map((m) => {
    if (m.left && (m.left <= today || m.left <= from)) return m;
    // 规则第一次存下时，原本就与车不一致的成员明确标为自定义，之后不会被当成跟随车
    if (!followsCar(state, s, m, today)) return m.exempt || m.custom ? m : { ...m, custom: true };
    const r = memberRate(s, m, from, collectCurrencyOf(state.settings));
    if (sameRule({ billEvery: r.billEvery, fee: r.amount, currency: r.currency }, rule)) return m;
    return changeMemberFee(state, s, m, { from, fee: rule.fee, currency: rule.currency, billEvery: rule.billEvery }, today);
  });
  return { ...s, share: { ...s.share, rule, members } };
}

/**
 * 成员改回跟随车：从生效日起套用车的规则，收款日也回到车的节奏——去掉生效日之后成员自己另起的节奏，
 * 生效日后车的第一个收款日不是成员的期起点时从那天重起（那一期按天折算），历史各期不动
 */
export function followCarRule(state: AppState, s: Subscription, m: ShareMember, from: string, today: string): ShareMember {
  const rule = carRule(state, s, today);
  const r = memberRate(s, m, from, collectCurrencyOf(state.settings));
  const restarts = (m.restarts ?? []).filter((d) => d <= from || onCarRhythm(s, rule.billEvery, d));
  const plain = { ...m, custom: undefined, restarts: restarts.length ? restarts : undefined };
  const next = sameRule({ billEvery: r.billEvery, fee: r.amount, currency: r.currency }, rule)
    ? plain
    : changeMemberFee(state, s, plain, { from, fee: rule.fee, currency: rule.currency, billEvery: rule.billEvery }, today);
  const day = nextCollectionDay(s, rule.billEvery, addDays(from, -1));
  const aligned =
    memberSince(s, next) >= day || (next.left && next.left <= day) || memberPeriods(s, next, day, s.currency).some((p) => p.from === day)
      ? next
      : { ...next, restarts: [...(next.restarts ?? []), day].sort() };
  return dropReshaped(s, m, aligned);
}

/**
 * 对齐后起止变了的期：没有金额的期初结清和免收不再盖住它（原来盖的是三个月，不能变成盖半年）；
 * 实收的钱留在原来的期上，由用户自己调整
 */
export function dropReshaped(s: Subscription, before: ShareMember, after: ShareMember): ShareMember {
  const keys = [...(before.receipts ?? []), ...(before.waivers ?? [])].flatMap((r) => r.periods);
  if (!keys.length) return after;
  const last = keys.sort().at(-1)!;
  const span = (m: ShareMember) => new Map(memberPeriods(s, m, last, s.currency).map((p) => [p.key, p.until]));
  const was = span(before);
  const now = span(after);
  const reshaped = (k: string) => was.has(k) && was.get(k) !== now.get(k);
  if (!keys.some(reshaped)) return after;
  const keep = <T extends { periods: string[] }>(r: T) => ({ ...r, periods: r.periods.filter((k) => !reshaped(k)) });
  const receipts = after.receipts?.map((r) => (r.opening ? keep(r) : r)).filter((r) => r.periods.length);
  const waivers = after.waivers?.map(keep).filter((w) => w.periods.length);
  return { ...after, receipts: receipts?.length ? receipts : undefined, waivers: waivers?.length ? waivers : undefined };
}

/**
 * 改已有成员的加入日：新加入日之前整期落在外面的收款、免收删掉这几期（一笔分几期时只去掉这几期和分到的金额）；
 * 跨过新加入日的那期挪到新的首期上。收款、免收取 after 上的；dropped 是删掉的期，界面保存前提示
 */
export function moveMemberJoin(
  s: Subscription,
  before: ShareMember,
  after: ShareMember,
  today: string,
  collectCurrency: string,
): { member: ShareMember; dropped: LedgerPeriod[] } {
  const joined = memberSince(s, after);
  if (joined === memberSince(s, before)) return { member: after, dropped: [] };
  // 记录以 after 上的为准，期按原来的加入日切
  let r: Receivable = { receipts: after.receipts, waivers: after.waivers };
  const was = memberLedger(s, { ...before, ...r }, today, collectCurrency).periods;
  const dropped: LedgerPeriod[] = [];
  for (const p of was.filter((p) => p.until < joined)) {
    const rec = p.receipt ?? p.waiver;
    if (!rec) continue;
    r = removeRecordPeriod(r, rec.id, p, was);
    dropped.push(p);
  }
  const cut = was.find((p) => p.from < joined && joined <= p.until && (p.receipt || p.waiver));
  if (cut) {
    const first = memberPeriods(s, after, joined, collectCurrency).find((p) => p.from <= joined && joined <= p.until);
    const shift = <T extends { periods: string[] }>(x: T) => ({
      ...x,
      periods: x.periods.map((k) => (first && resolveKey(was, k) === cut.key ? first.key : k)),
    });
    r = { receipts: r.receipts?.map(shift), waivers: r.waivers?.map(shift) };
  }
  const receipts = r.receipts?.length ? r.receipts : undefined;
  const waivers = r.waivers?.length ? r.waivers : undefined;
  return { member: { ...after, receipts, waivers }, dropped };
}

/** 几期应收的合计：金额折成第一期的币种相加（收款表单按选中的期预填金额） */
export function periodsTotal(state: AppState, periods: Period[]) {
  const ccy = periods[0]?.currency ?? collectCurrencyOf(state.settings);
  const amount = periods.reduce((a, p) => a + (p.currency === ccy ? p.due : convertOn(p.due, p.currency, ccy, p.from, state.fxHistory, state.fx)), 0);
  const d = 10 ** currencyDecimals(ccy);
  return { amount: Math.round(amount * d) / d, currency: ccy };
}

/**
 * 按车的收款节奏（基准日每隔 billEvery 个月一次），今天之后的下一次收款日。
 * 收费规则里的「下期收款日」：新标准从这天起执行，改这个日期就是把全车的收款节奏挪到这天
 */
export function nextCollectionDay(s: Subscription, billEvery: number, today: string): string {
  return collectionPeriod(s, billEvery, today).next;
}

/** 今天所在的收款期：从上一次收款日起，到下一次收款日前一天；详情「本期」里与订阅周期并排 */
export function collectionPeriod(s: Subscription, billEvery: number, today: string): { from: string; next: string } {
  const anchor = collectionAnchor(s);
  const every = Math.max(1, billEvery);
  let k = Math.ceil(((Number(today.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(anchor.slice(5, 7))) / every) - 1;
  while (addMonths(anchor, k * every) > today) k--;
  while (addMonths(anchor, k * every) <= today) k++;
  return { from: addMonths(anchor, (k - 1) * every), next: addMonths(anchor, k * every) };
}

import { addDays, memberUnpaidFrom, memberCollection, memberDues } from './billing.ts';
import { periodCellKind, visibleStripPeriods } from './period-grid.ts';

/** 成员一行的收款状态：逾期几天 / 待收 / 已结清，合租表格和收费弹窗共用 */
export function memberStatus(state: AppState, s: Subscription, m: ShareMember, today: string) {
  const collect = collectCurrencyOf(state.settings);
  const d = memberDues(s, today, collect, state).find((x) => x.member.id === m.id);
  const next = memberCollection(s, m, memberUnpaidFrom(s, m), collect);
  const owe = !!d && d.periodsOwed > 0;
  // 本期：今天所在的这个人自己的收费期；还没加入或已经退出时取最早没结清的一期
  const now = memberLedger(s, m, today, collect).periods.find((p) => p.from <= today && p.until >= today);
  const period = now ? { from: now.from, until: now.until, paid: isSettled(now) } : { from: next.from, until: next.until, paid: false };
  return {
    owe,
    period,
    owed: owe ? d!.owed : undefined,
    currency: d?.currency ?? collect,
    late: owe && next.from < today ? diffDays(next.from, today) : 0,
    next,
    gone: !!m.left && next.from >= m.left,
  };
}

/** 成员时间条上的一段：已收、免收（含免费）、该收没收（到今天为止）、还没到期的下一期，以及退出后没用完的已付天数 */
export interface MemberSegment {
  from: string;
  until: string;
  kind: 'paid' | 'due' | 'future' | 'unused' | 'waived';
}

/**
 * 成员在时间窗口内的各期：按这个人自己的收费周期切分，每期按收款、免收推算状态，可以不连续。
 * 已退出的截到退出前一天；不分摊的没有分段。
 */
export function memberSegments(s: Subscription, m: ShareMember, today: string, start: string, end: string): MemberSegment[] {
  if (m.exempt) return [];
  const stop = m.left ? addDays(m.left, -1) : end;
  const out: MemberSegment[] = [];
  const push = (from: string, until: string, kind: MemberSegment['kind']) => {
    const a = from < start ? start : from;
    const b = [until, stop, end].sort()[0];
    if (a <= b) out.push({ from: a, until: b, kind });
  };
  const { periods } = memberLedger(s, m, today, s.currency, end);
  // 与成员弹窗的期数网格同一口径：已开始的各期、预收的未来各期，再加下一期未收的
  for (const p of visibleStripPeriods(periods, today)) {
    if (p.until < start || p.from > end) continue;
    const kind = periodCellKind(p, today);
    push(p.from, p.until, kind === 'paid' ? 'paid' : kind === 'due' ? 'due' : kind === 'upcoming' ? 'future' : 'waived');
  }
  // 退出时已付到退出日之后、又没退钱：退出后到已付至的那段画成没用完
  const paid =
    m.left && !m.leaveRefund
      ? memberLedger(s, { ...m, left: undefined }, today, s.currency, m.left).periods.filter(
          // 截到退出前一天的首期：只收了截短后应收的就没有「没用完」的部分（与退款建议同一口径）
          (p) => {
            if (p.status !== 'paid' || p.until < m.left!) return false;
            const cut = firstPeriodCut(s, m, s.currency);
            return !(cut && p.from === cut.from && p.receipt?.currency === cut.currency && (p.share ?? 0) - cut.amount < 0.005);
          },
        )
      : [];
  if (paid.length) {
    const from = [m.left!, start].sort().at(-1)!;
    const last = paid.at(-1)!.until;
    const until = last < end ? last : end;
    if (from <= until) out.push({ from, until, kind: 'unused' });
  }
  return out;
}

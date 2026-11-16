import { amountTotal, chargesTotal, formatTotal, scaleTotal, totalNote } from '../../../../shared/fx-total.ts';
import { DAYS_PER_MONTH } from '../../../../shared/billing.ts';
import { copyParts } from '../../components/copy.tsx';
import { isStopped } from '../../../../shared/billing.ts';
import { ArrowRight, TrendingDown, TrendingUp } from 'lucide-react';
import {
  chargeDay,
  currentPhase,
  cycleDays,
  diffDays,
  effectiveStatus,
  chargesBetween,
  historyStart,
  chargeServicePeriod,
  isPostpaid,
  isSeparate,
  monthlyGross,
  overdueBills,
  phaseSubs,
  servedTime,
  type Charge,
} from '../../../../shared/billing.ts';
import { flow, cnDateAuto, cnDateFull, relDays } from '../../../../shared/format.ts';
import { netCost, transfersOf } from '../../../../shared/transfers.ts';
import { chargeBaseOrNaN } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import type { ReactNode } from 'react';
import { Panel } from '../../components/DetailKit.tsx';
import { MetricCards, Metric } from '../../components/ui.tsx';
import { toBase } from '../../derive.ts';
import { t } from '../../../../shared/i18n.ts';
import { detailForecast, detailHistoryEnd } from '../detail-data.ts';
import { regular } from './shared.tsx';

/** 分开记的各期账单（截至今天、同一期的已缴与未缴合成一条），用于比较账单单价 */
function billPrices(sub: Subscription, today: string): Charge[] {
  const bills = new Map<string, Charge>();
  for (const c of chargesBetween(sub, historyStart(sub), today, today)) {
    if (c.kind || c.amount <= 0) continue;
    const key = `${c.sub.start}|${c.date}`;
    const prev = bills.get(key);
    bills.set(key, prev ? { ...prev, amount: Math.round((prev.amount + c.amount) * 100) / 100 } : c);
  }
  return [...bills.values()];
}

/** 涨跌角标：花费类数字，降了是好事（绿），涨了是坏事（红） */
export function Trend({ pct }: { pct: number | undefined }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const flat = Math.abs(pct) < 0.005;
  const cls = flat ? '' : pct < 0 ? 'ok' : 'bad';
  return (
    <span className={`dt-badge ${cls}`}>
      {flat ? <ArrowRight size={12} /> : pct < 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
      {flat ? '0%' : `${(Math.abs(pct) * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%`}
    </span>
  );
}

/**
 * 顶部指标：一张卡里竖线分格，有用量指标时下面再一行用量，行间横线。四格内容跟着状态走：
 * 计费中、试用中是 下次扣款 · 订了多久 · 累计 · 每月；已结束是 结束于 · 订了多久 · 累计 · 每月；
 * 买断、暂停没有下一笔，是 订了多久 · 累计 · 每月。
 * 累计按每笔扣款当天的汇率；合租发起人这里是付出去的全额，成员分摊在「合租」页看。
 */
export function Kpis({
  sub,
  state,
  today,
  history,
  usage,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  history: Charge[];
  /** 有用量指标时的第二行（见 usageMetrics） */
  usage?: ReactNode[];
}) {
  const base = state.settings.baseCurrency;
  const st = effectiveStatus(sub, today);
  const end = detailHistoryEnd(sub, today);
  // 累计 = 服务付款 + 买入 − 卖出；有一笔转让缺汇率就不能求和：显示「—」，不能把缺的那笔当 0
  const cost = netCost(state, sub, today, base);
  const transferred = transfersOf(sub).some((tr) => tr.date <= today);
  // 停用日不详时时长与均价算不准；卖出日已知则持有期到卖出为止，照常计算
  const undated = end.unknown && !transfersOf(sub).some((tr) => tr.kind === 'sell' && tr.date <= today);
  const total = cost.net;
  // 缺汇率的那笔不参与均价与走势（不能当 0 拉低平均）
  // 分开记：走势比的是首期与当前这期的账单单价，不看哪笔缴了多少
  // 折成每月再比：月付首期 $15 换年付 $300，比的是 $15/月 对 $25/月，不是 15 对 300
  // 按名义周期折算（不按实际天数），同价的 1 月与 11 月账单不会因 31/30 天出现走势
  const perMonthOf = (c: Charge) => {
    const days = cycleDays(c.sub.cycle);
    return Number.isFinite(days) && days > 0 ? (chargeBaseOrNaN(state, c, base) * DAYS_PER_MONTH) / days : NaN;
  };
  const per = (phaseSubs(sub).some(isSeparate) ? billPrices(sub, today) : regular(history)).map(perMonthOf).filter(Number.isFinite);
  // 实际在订的天数：各段到今天（或结束日）为止，不算断档，并行的不重复计
  const served = servedTime(sub, today);
  // 有转让时按持有期：最早买入起，卖出那天止
  const active = transferred ? cost.days : served.days;
  const gaps = served.gaps.length;
  // 按平均月长取整：11-24 到次年 10-24 是 11 个月，不能因为差几天算成 10 个月
  const span = active < 30 ? 0 : Math.round(active / DAYS_PER_MONTH);
  const years = Math.floor(span / 12);
  const months = span % 12;
  const lifetime = sub.cycle.unit === 'lifetime' && phaseSubs(sub).length === 1;
  // 订了不到一个月（或只有一笔）时，「实际每月」没有意义：改用标价折算的预计每月
  // An incomplete imported history cannot establish an average over the original service lifetime.
  const young = !!sub.estimateFrom || active < 30 || (regular(history).length < 2 && !transferred);
  // 均摊分母与 MCP 同一口径：预付费算到已付那期结束，有转让时按持有期（见 netCost）
  const spreadMonths = Math.max(1, cost.spreadDays / DAYS_PER_MONTH);
  const perMonth = young ? toBase(state, monthlyGross(currentPhase(sub, today), today, state.fx), currentPhase(sub, today).currency) : cost.perMonth;
  // 后付费账单随用量起落（电费头几期可能只有几块），首末两期之比不是涨价，不画走势
  const perTrend =
    !cost.incomplete && !young && !phaseSubs(sub).some(isPostpaid) && per.length > 1 && per[0] > 0 ? per[per.length - 1] / per[0] - 1 : undefined;
  const duration =
    active < 1
      ? t('detail.kpi.startedToday')
      : years
        ? months
          ? t('detail.stats.yearsMonths', { years, months })
          : t('detail.stats.years', { count: years })
        : months
          ? t('detail.stats.months', { count: months })
          : t('detail.stats.days', { count: active });
  const cumulative = formatTotal(cost.partial, base, { direction: -1, compact: true, main: true });
  // 每月：买断按订了多久平摊，其余按实际（或刚开始时按标价预计）
  const monthly = lifetime ? total / spreadMonths : perMonth;

  const monthlyPartial =
    !lifetime && young
      ? amountTotal(monthlyGross(currentPhase(sub, today), today, state.fx), currentPhase(sub, today).currency, perMonth)
      : scaleTotal(cost.spread, 1 / spreadMonths);
  const monthlyAmount = formatTotal(monthlyPartial, base, { direction: -1, compact: true, main: true, average: true });
  // 今年付了多少：跟累计同一口径（实付、扣失败的不算），按扣款记录的归年（后付费账单归所属周期）。
  // 今年与累计不同时第三格改写今年、累计降为小字；相同（今年才开始，或以前几年合计为 0）照旧只写累计，免得同一个数出现两次。
  // 有转让时第三格是净花费或净赚，今年净额不为正（只剩退款）也不叫「花了」：这两种照旧写累计
  const year = today.slice(0, 4);
  // 某年里、截至某天已经出账的实付：按归年（后付费账单归所属周期），出账日不晚于截止日
  const paidIn = (y: string, until: string) =>
    chargesTotal(
      state,
      history.filter((c) => c.kind !== 'failed' && chargeDay(c).slice(0, 4) === y && c.date <= until),
    );
  const yearTotal = paidIn(year, today);
  // 同比：去年截至去年的今天已出账的那些，同一口径；今年没过完，不拿去年全年比。
  // 出账日也截在去年的今天：后付费 10 月账单 11 月才出，今年还没出的那张去年同期也不算。去年同期没花钱或缺汇率就不画角标
  const lastYear = String(Number(year) - 1);
  const lastSame = paidIn(lastYear, `${lastYear}${today.slice(4)}`);
  const yearTrend = !lastSame.incomplete && lastSame.value > 0.005 ? yearTotal.value / lastSame.value - 1 : undefined;
  const showYear =
    !transferred && !cost.incomplete && !yearTotal.incomplete && yearTotal.value > 0.005 && Math.abs(yearTotal.value - cost.partial.value) > 0.005;
  const postpaid = isPostpaid(currentPhase(sub, today));
  // 今年每月只给后付费（按用量出账、每期金额不同）：今年出账的实付 ÷ 这些账单覆盖的服务期，还没出的账单不进分母。
  // 预付费定价订阅照旧写实际每月，调价由单价走势表达；与全程平均差不到 5% 时也不换格
  // 分母取账单服务期的并集：分次缴的同一期、并行阶段的重叠期只算一次；0 元账单的天数照算，没出的本期不算。
  // 换格判断拿同口径的全程月均比（全程实付 ÷ 全部账单服务期），免得全程月均被本期未出账的天数摊低而误换
  const billedDays = (inYear: boolean) => {
    const periods = history
      .filter((c) => !c.kind && c.date <= today && (!inYear || chargeDay(c).slice(0, 4) === year))
      .map((c) => chargeServicePeriod(c.sub, c.date, c.serviceDate))
      .sort((x, y) => x.from.localeCompare(y.from));
    let days = 0;
    let reach = '';
    for (const p of periods) {
      const from = p.from > reach ? p.from : reach;
      if (p.until > from) days += diffDays(from, p.until);
      if (p.until > reach) reach = p.until;
    }
    return days;
  };
  const yearDays = billedDays(true);
  const yearMonthly = postpaid && showYear && !lifetime && !young && !undated && yearDays >= 28 ? (yearTotal.value * DAYS_PER_MONTH) / yearDays : NaN;
  const billedAll = Number.isFinite(yearMonthly)
    ? chargesTotal(
        state,
        history.filter((c) => c.kind !== 'failed' && c.date <= today),
      )
    : undefined;
  const allDays = billedAll ? billedDays(false) : 0;
  const billedMonthly = billedAll && !billedAll.incomplete && allDays > 0 ? (billedAll.value * DAYS_PER_MONTH) / allDays : NaN;
  const showYearMonthly = Number.isFinite(billedMonthly) && billedMonthly > 0 && Math.abs(yearMonthly / billedMonthly - 1) >= 0.05;
  // 后付费停止、暂停后仍有最后一张账单
  const next = st === 'lifetime' || (!postpaid && ['ended', 'terminated', 'paused'].includes(st)) ? undefined : detailForecast(sub, today).charges[0];
  const nextValue = next ? chargeBaseOrNaN(state, next, base) : NaN;
  // 账单与缴费分开记且有欠缴时，第一格换成最早未缴的那期：欠几期、共欠多少
  const owed = overdueBills(sub, today);
  // 停止的订阅由下方停止卡片写停止日，这里不再重复
  const ended = isStopped(st) && sub.end && !phaseSubs(sub).some((p) => p.stop);
  const durationCell = (
    <Metric
      label={transferred ? t('detail.transfer.held') : lifetime ? t('detail.stats.owned') : t('detail.stats.subscribed')}
      value={undated ? '—' : duration}
      note={
        undated
          ? copyParts([t('detail.field.endedUnknown'), t('detail.stats.count', { count: history.length })].join('\n'))
          : copyParts(
              [
                gaps > 0 ? t('detail.stats.gaps', { count: gaps }) : t('detail.period.since', { date: cnDateFull(transferred ? cost.from : sub.start) }),
                t('detail.stats.count', { count: history.length }),
              ].join('\n'),
            )
      }
    />
  );

  return (
    <Panel className="dt-metrics metric-stack">
      <MetricCards inline>
        {owed.length ? (
          <Metric
            label={t('detail.settlement.earliest')}
            value={cnDateAuto(owed[0].date, today)}
            valueClassName="warn"
            note={copyParts(
              [t('detail.settlement.owed', { count: owed.length }), formatTotal(chargesTotal(state, owed), base, { direction: -1, compact: true })].join('\n'),
            )}
          />
        ) : next ? (
          <Metric
            label={st === 'trial' ? t('detail.renewal.afterTrial') : isPostpaid(next.sub) ? t('detail.billing.nextBill') : t('detail.ev.next')}
            value={cnDateAuto(next.date, today)}
            note={copyParts(
              [Number.isFinite(nextValue) ? flow(-nextValue, base) : flow(-next.amount, next.currency), relDays(diffDays(today, next.date))].join('\n'),
            )}
          />
        ) : ended ? (
          <Metric label={t('detail.field.endedOn')} value={cnDateAuto(sub.end!, today)} note={relDays(diffDays(today, sub.end!))} />
        ) : (
          durationCell
        )}
        {(owed.length || next || ended) && durationCell}
        {/* 只有一笔时累计就是那一笔，扣款记录里已有，不再占一格 */}
        {/* 导入边界之前的历史没有记录：没有一笔时写「—」，小字说明只算导入之后 */}
        {/* 有转让时是净花费：买入、卖出各自的金额在下方转让卡片，这里只写合计 */}
        {(history.length !== 1 || transferred) && (
          <Metric
            accessory={showYear ? <Trend pct={yearTrend} /> : undefined}
            label={
              showYear
                ? t('detail.stats.spentThisYear')
                : transferred
                  ? t(total < 0 ? 'detail.transfer.netGain' : 'detail.transfer.net')
                  : t('detail.stats.spent')
            }
            value={
              showYear
                ? formatTotal(yearTotal, base, { direction: -1, compact: true, main: true })
                : sub.estimateFrom && !history.length && !transferred
                  ? '—'
                  : cumulative
            }
            note={
              showYear
                ? t('detail.stats.allTime', { amount: formatTotal(cost.partial, base, { direction: -1, compact: true }) })
                : cost.incomplete
                  ? cost.partial.known
                    ? totalNote(cost.partial)
                    : undefined
                  : transferred
                    ? t('detail.transfer.included')
                    : undefined
            }
          />
        )}
        <Metric
          label={
            showYearMonthly
              ? t('detail.kpi.thisYearMonthly')
              : lifetime
                ? t('detail.kpi.amortizedCost')
                : young
                  ? t('detail.kpi.expectedMonthly')
                  : t('detail.stats.perMonth')
          }
          value={
            showYearMonthly
              ? formatTotal(scaleTotal(yearTotal, DAYS_PER_MONTH / yearDays), base, { direction: -1, compact: true, main: true, average: true })
              : undated || (sub.estimateFrom && lifetime && !history.length)
                ? '—'
                : lifetime
                  ? t('detail.kpi.perMonthValue', { amount: monthlyAmount })
                  : monthlyAmount
          }
          // 与其他格一样三行：折到每天多少；算不出来就不写这一行
          note={
            showYearMonthly ? (
              // 小字的全程平均与换格判断同口径（全部已出账服务期），方向不会与主数相反；每天排在同一行，放不下就不显示
              <span className="copy-fit">
                {copyParts(
                  [
                    t('detail.kpi.averageMonthly', {
                      amount: formatTotal(scaleTotal(billedAll!, DAYS_PER_MONTH / allDays), base, { direction: -1, compact: true, average: true }),
                    }),
                    t('detail.kpi.dailyAmount', { amount: flow(-billedMonthly / DAYS_PER_MONTH, base) }),
                  ].join('\n'),
                )}
              </span>
            ) : !undated ? (
              monthlyPartial.incomplete ? (
                [
                  monthlyPartial.known || Object.keys(monthlyPartial.unconverted).length > 1 ? totalNote(monthlyPartial) : '',
                  t('detail.kpi.perDay', { amount: formatTotal(scaleTotal(monthlyPartial, 1 / DAYS_PER_MONTH), base, { direction: -1, average: true }) }),
                ]
                  .filter(Boolean)
                  .join('\n')
              ) : Number.isFinite(monthly) ? (
                t('detail.kpi.perDay', { amount: flow(-monthly / DAYS_PER_MONTH, base) })
              ) : undefined
            ) : undefined
          }
          // 写今年每月时不挂单价走势：角标会被读成「今年每月涨了多少」，今年比去年已在第三格
          accessory={!lifetime && !undated && !transferred && !showYearMonthly ? <Trend pct={perTrend} /> : undefined}
        />
      </MetricCards>
      {usage && <MetricCards inline>{usage}</MetricCards>}
    </Panel>
  );
}

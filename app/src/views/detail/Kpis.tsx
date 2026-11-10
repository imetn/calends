import { amountTotal, formatTotal, scaleTotal, totalNote } from '../../../../shared/fx-total.ts';
import { DAYS_PER_MONTH } from '../../../../shared/billing.ts';
import { copyParts } from '../../components/copy.tsx';
import { isStopped } from '../../../../shared/billing.ts';
import { ArrowRight, TrendingDown, TrendingUp } from 'lucide-react';
import { currentPhase, diffDays, effectiveStatus, isPostpaid, monthlyGross, phaseSubs, servedTime, type Charge } from '../../../../shared/billing.ts';
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
  const per = regular(history)
    .map((c) => chargeBaseOrNaN(state, c, base))
    .filter(Number.isFinite);
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
  const perMonth = young
    ? toBase(state, monthlyGross(currentPhase(sub, today), today, state.fx), currentPhase(sub, today).currency)
    : total / spreadMonths;
  const perTrend = !cost.incomplete && !young && per.length > 1 && per[0] > 0 ? per[per.length - 1] / per[0] - 1 : undefined;
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
      : scaleTotal(cost.partial, 1 / spreadMonths);
  const monthlyAmount = formatTotal(monthlyPartial, base, { direction: -1, compact: true, main: true, average: true });
  const postpaid = isPostpaid(currentPhase(sub, today));
  // 后付费停止、暂停后仍有最后一张账单
  const next = st === 'lifetime' || (!postpaid && ['ended', 'terminated', 'paused'].includes(st)) ? undefined : detailForecast(sub, today).charges[0];
  const nextValue = next ? chargeBaseOrNaN(state, next, base) : NaN;
  // 停止的订阅由下方停止卡片写停止日，这里不再重复
  const ended = isStopped(st) && sub.end && !phaseSubs(sub).some((p) => p.stop);
  const durationCell = (
    <Metric
      label={transferred ? t('detail.transfer.held') : lifetime ? t('detail.stats.owned') : t('detail.stats.subscribed')}
      value={undated ? '—' : duration}
      note={
        undated
          ? t('detail.field.endedUnknown')
          : gaps > 0
            ? t('detail.stats.gaps', { count: gaps })
            : t('detail.period.since', { date: cnDateFull(transferred ? cost.from : sub.start) })
      }
    />
  );

  return (
    <Panel className="dt-metrics metric-stack">
      <MetricCards inline>
        {next ? (
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
        {(next || ended) && durationCell}
        {/* 只有一笔时累计就是那一笔，扣款记录里已有，不再占一格 */}
        {/* 导入边界之前的历史没有记录：没有一笔时写「—」，小字说明只算导入之后 */}
        {/* 有转让时是净花费：买入、卖出各自的金额在下方转让卡片，这里只写合计 */}
        {(history.length !== 1 || transferred) && (
          <Metric
            label={transferred ? t(total < 0 ? 'detail.transfer.netGain' : 'detail.transfer.net') : t('detail.stats.spent')}
            value={sub.estimateFrom && !history.length && !transferred ? '—' : cumulative}
            note={
              cost.incomplete
                ? cost.partial.known
                  ? totalNote(cost.partial)
                  : t('detail.stats.count', { count: history.length })
                : transferred
                  ? copyParts([t('detail.stats.count', { count: history.length }), t('detail.transfer.included')].join('\n'))
                  : t('detail.stats.count', { count: history.length })
            }
          />
        )}
        <Metric
          label={lifetime ? t('detail.kpi.amortizedCost') : young ? t('detail.kpi.expectedMonthly') : t('detail.stats.perMonth')}
          value={
            undated || (sub.estimateFrom && lifetime && !history.length)
              ? '—'
              : lifetime
                ? t('detail.kpi.perMonthValue', { amount: monthlyAmount })
                : monthlyAmount
          }
          // 与其他格一样三行：折到每天多少；算不出来就不写这一行
          note={
            !undated
              ? monthlyPartial.incomplete
                ? [
                    monthlyPartial.known || Object.keys(monthlyPartial.unconverted).length > 1 ? totalNote(monthlyPartial) : '',
                    t('detail.kpi.perDay', { amount: formatTotal(scaleTotal(monthlyPartial, 1 / DAYS_PER_MONTH), base, { direction: -1, average: true }) }),
                  ]
                    .filter(Boolean)
                    .join('\n')
                : Number.isFinite(monthly)
                  ? t('detail.kpi.perDay', { amount: flow(-monthly / DAYS_PER_MONTH, base) })
                  : undefined
              : undefined
          }
          accessory={!lifetime && !undated && !transferred ? <Trend pct={perTrend} /> : undefined}
        />
      </MetricCards>
      {usage && <MetricCards inline>{usage}</MetricCards>}
    </Panel>
  );
}

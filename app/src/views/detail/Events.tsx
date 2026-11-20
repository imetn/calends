import { durationLabel } from '../../../../shared/billing.ts';
import { copyParts } from '../../components/copy.tsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CalendarClock,
  CircleStop,
  Flag,
  Hourglass,
  Pause,
  Play,
  Repeat2,
  ScrollText,
  Tag,
  TrendingDown,
  TrendingUp,
  Undo2,
  Unlink,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { addDays, coveredUntil, cycleLabel, diffDays, isGap, phaseSubs, servedTime, upcomingPhase } from '../../../../shared/billing.ts';
import { contractEvents } from '../../../../shared/contract.ts';
import { cnDateFull, money } from '../../../../shared/format.ts';
import { transfersOf } from '../../../../shared/transfers.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { pricePoints } from '../../../../shared/phases.ts';
import { t } from '../../../../shared/i18n.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { Seg } from '../../components/inputs.tsx';
import { priceSeries, type PriceSeries } from '../../../../shared/price-steps.ts';
import { moneyTick } from '../../../../shared/format.ts';
import { phaseLanes } from '../../../../shared/billing.ts';
import { PriceSteps, type ChartLane } from '../DetailChart.tsx';
import { detailHistoryEnd } from '../detail-data.ts';
import { LANE_COLORS, Region } from './shared.tsx';
import { methodOf } from './shared.tsx';

export interface Ev {
  date: string;
  /** 节点里的小图标：一眼看出是哪类变化 */
  icon: LucideIcon;
  title: string;
  sub?: ReactNode;
  tone?: 'acc' | 'ok' | 'warn' | 'bad' | 'ink';
  future?: boolean;
}

/** 历程：开始、换方案、调价、断档、暂停、结束，以及计划中的变更 */
export function Events({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const [all, setAll] = useState(false);
  const [view, setView] = useState<'list' | 'trend'>('list');
  const vs = phaseSubs(sub);
  const plan = (v: Subscription) => {
    const m = methodOf(state, v.methodId);
    return (
      <span className="dt-inline">
        {v.region && <Region cc={v.region} />}
        {copyParts([`${money(pricePoints(v)[0].amount, v.currency)} ${cycleLabel(v.cycle)}`, m?.name].filter(Boolean).join('\n'))}
      </span>
    );
  };
  const evs: Ev[] = [];
  vs.forEach((v, i) => {
    const until = coveredUntil(vs, i);
    if (i > 0 && isGap(until, v.start)) {
      evs.push({
        date: until!,
        icon: Unlink,
        // 「断更 N 个月」本身就是标题，不再另起一行重复「断更」
        title: durationLabel(diffDays(until!, v.start), 'gap'),
        tone: 'warn',
      });
    }
    if (v.start <= today || !v.planned)
      evs.push({
        date: v.start,
        icon: i === 0 ? Play : Repeat2,
        title: i === 0 ? t('detail.ev.start') : t('detail.ev.switch'),
        sub: plan(v),
        tone: 'acc',
        future: v.start > today,
      });
    const hist = pricePoints(v);
    hist.forEach((p, k) => {
      if (!k || p.from === v.start) return;
      const prev = hist[k - 1].amount;
      evs.push({
        date: p.from,
        icon: p.amount > prev ? TrendingUp : TrendingDown,
        title: t('detail.ev.price'),
        sub: `${money(prev, v.currency)} → ${money(p.amount, v.currency)}${prev > 0 ? ` (${p.amount > prev ? '+' : '−'}${Math.round(Math.abs(p.amount / prev - 1) * 100)}%)` : ''}`,
        tone: p.amount > prev ? 'bad' : 'ok',
        future: p.from > today,
      });
    });
  });
  if (sub.intro && sub.intro.until <= today) evs.push({ date: sub.intro.until, icon: Tag, title: t('detail.intro.title'), sub: t('detail.ev.introEnd') });
  if (sub.trialEnd) evs.push({ date: sub.trialEnd, icon: Hourglass, title: t('detail.field.trialEnd'), future: sub.trialEnd > today });
  if (sub.pausedAt && sub.status === 'paused') evs.push({ date: sub.pausedAt, icon: Pause, title: t('detail.ev.paused'), tone: 'warn' });
  if (sub.share?.since)
    evs.push({
      date: sub.share.since,
      icon: Users,
      title: t('detail.ev.shareStart'),
      sub: t(`editor.share.${sub.share.role}`),
      tone: 'ok',
    });
  const up = upcomingPhase(sub, today);
  if (up?.planned) evs.push({ date: up.start, icon: CalendarClock, title: t('detail.up.planned').split('\n')[0], sub: plan(up), future: true });
  for (const v of vs) {
    if (v.stop)
      evs.push({
        date: v.stop.date,
        icon: v.stop.kind === 'terminate' ? Ban : CircleStop,
        title: t(v.stop.kind === 'terminate' ? 'core.stop.terminate' : 'core.stop.cancel'),
        sub: v.stop.kind === 'terminate' ? v.stop.reason : undefined,
        tone: v.stop.kind === 'terminate' ? 'bad' : 'ink',
      });
    for (const p of v.payments ?? [])
      if (p.kind === 'refund')
        evs.push({
          date: p.date,
          icon: Undo2,
          title: t('editor.payment.kind.refund'),
          tone: 'ok',
          future: p.date > today,
        });
  }
  // 转让只记发生了什么，金额在转让卡片里
  for (const tr of transfersOf(sub))
    evs.push({
      date: tr.date,
      icon: tr.kind === 'sell' ? ArrowUpFromLine : ArrowDownToLine,
      title: t(`detail.transfer.kind.${tr.kind}`),
      sub: tr.note,
      tone: tr.kind === 'sell' ? 'ok' : 'acc',
      future: tr.date > today,
    });
  // 合同续约与到期：已发生的都列，未来只列下一次
  const contract = contractEvents(sub, sub.start, addDays(today, 3660), today);
  for (const e of contract.filter((e, i) => e.date <= today || i === contract.findIndex((x) => x.date > today)))
    evs.push({
      date: e.kind === 'end' ? e.until : e.date,
      icon: ScrollText,
      title: t(`core.contract.${e.kind === 'end' ? (e.until < today ? 'ended' : 'ending') : e.date <= today ? 'renewed' : 'renewing'}`),
      tone: e.kind === 'end' ? 'ink' : undefined,
      future: e.date > today,
    });
  if (sub.end && !sub.stop)
    evs.push({ date: sub.end, icon: Flag, title: sub.end <= today ? t('detail.ev.ended') : t('detail.ev.ending'), tone: 'ink', future: sub.end > today });
  // 一条时间线，新的在上
  evs.sort((a, b) => b.date.localeCompare(a.date));

  // 只有开始订阅、开始合租这类一两条时，开始日已在摘要、方案在走势下方，不单独成卡
  if (evs.length < 3) return null;
  const shown = all || evs.length <= 6 ? evs : evs.slice(0, 6);
  const gaps = servedTime(sub, today).gaps.length;
  // 标价走势：价格变过才有，见 priceSeries
  const series = priceSeries(
    vs,
    vs.map((v) => detailHistoryEnd(v, today).date ?? v.end),
    today,
    state.settings.baseCurrency,
    state.fxHistory,
    state.fx,
  );
  const trend = series && view === 'trend';
  return (
    <Panel
      className={`dt-events ${trend ? 'dt-chart' : ''}`}
      title={
        <>
          {t('detail.history')}
          <small className="dt-title-note">
            {copyParts(`${t('detail.ev.phases', { count: vs.length })}\n${gaps ? t('detail.stats.gaps', { count: gaps }) : t('detail.kpi.noGaps')}`)}
          </small>
        </>
      }
      aside={
        series && (
          <Seg
            small
            value={view}
            onChange={setView}
            options={[
              ['list', t('detail.ev.list')],
              ['trend', t('detail.ev.trend')],
            ]}
          />
        )
      }
    >
      {trend ? (
        <PriceTrend sub={sub} state={state} series={series} events={evs} />
      ) : (
        <EventList shown={shown} more={evs.length - shown.length} onMore={() => setAll(true)} />
      )}
    </Panel>
  );
}

function EventList({ shown, more, onMore }: { shown: Ev[]; more: number; onMore: () => void }) {
  return (
    <>
      <ol className="dt-evs">
        {shown.map((e, i) => (
          <li key={`${e.date}-${i}`} className={`dt-ev ${e.future ? 'fut' : ''} ${e.tone ?? ''}`}>
            <i aria-hidden>
              <e.icon size={12} strokeWidth={2.2} />
            </i>
            {/* 事件名一列对齐，说明从同一位置起排，日期靠右 */}
            <b>{e.title}</b>
            {e.sub && <small>{e.sub}</small>}
            <time dateTime={e.date}>{cnDateFull(e.date)}</time>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <button className="dt-link" onClick={onMore}>
          {t('detail.ev.more', { count: more })}
        </button>
      )}
    </>
  );
}

/** 走势视图：标价台阶加方案轨道；悬停一级时写它从哪天起、怎么来的（开始、切换方案或调价），说明与列表里同一条一致 */
function PriceTrend({ sub, state, series, events }: { sub: Subscription; state: AppState; series: PriceSeries; events: Ev[] }) {
  const { steps, currency, perMonth } = series;
  const vs = phaseSubs(sub).filter((v) => steps.some((s) => s.phase === v.start));
  const laneIdx = phaseLanes(vs);
  const methodIds = [...new Set(vs.map((v) => v.methodId ?? ''))];
  const lanes: ChartLane[] = vs.map((v, i) => {
    const own = steps.filter((s) => s.phase === v.start);
    // 轨道写这段画到的最后一级标价，与折线末端一致；v.price 可能是今天之后才生效的调价
    const price = money(own[own.length - 1].price, v.currency);
    return {
      key: v.start,
      from: own[0].from,
      to: own[own.length - 1].to,
      lane: laneIdx[i],
      color: LANE_COLORS[methodIds.indexOf(v.methodId ?? '') % LANE_COLORS.length],
      label: (
        <>
          {v.region && <Region cc={v.region} />}
          {price} {cycleLabel(v.cycle)}
        </>
      ),
      short: (
        <>
          {v.region && <Region cc={v.region} />}
          {price}
        </>
      ),
      aside: methodOf(state, v.methodId)?.name,
    };
  });
  const fmt = (v: number) => (perMonth ? t('detail.kpi.perMonthValue', { amount: money(v, currency) }) : money(v, currency));
  return (
    <PriceSteps
      steps={steps}
      fmt={fmt}
      tick={(v) => (Number.isInteger(v) ? moneyTick(v, currency) : money(v, currency))}
      lanes={lanes}
      tip={(i) => {
        const s = steps[i];
        const ev = events.find(
          (e) => e.date === s.from && e.title === t(s.kind === 'price' ? 'detail.ev.price' : s.kind === 'switch' ? 'detail.ev.switch' : 'detail.ev.start'),
        );
        return (
          <>
            <div className="cc-tip-h">
              <b>{cnDateFull(s.from)}</b>
              <span>{ev?.title}</span>
            </div>
            {ev?.sub && (
              <div className="cc-tip-r">
                <span>{ev.sub}</span>
              </div>
            )}
            {/* 折成本位币或按月折算时，图上的高度不是标价本身，写出折合值 */}
            {(perMonth || vs.find((v) => v.start === s.phase)?.currency !== currency) && (
              <div className="cc-tip-r">
                <span>{t('detail.chart.converted')}</span>
                <b>{fmt(s.amount)}</b>
              </div>
            )}
          </>
        );
      }}
    />
  );
}

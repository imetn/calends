import { amountTotal, chargesTotal, formatTotal, sumTotals } from '../../../../shared/fx-total.ts';
import { copyParts } from '../../components/copy.tsx';
import { chargeMethodId } from '../../../../shared/billing.ts';
import { useRef, useState } from 'react';
import { useSnapshotRender } from '../../snapshot-render.tsx';
import {
  addDays,
  addMonths,
  chargeDay,
  chargeServicePeriod,
  chargesBetween,
  currentPhase,
  cycleDays,
  cycleLabel,
  diffDays,
  effectiveStatus,
  isPostpaid,
  midDay,
  phaseLanes,
  phaseSubs,
  priceAt,
  type Charge,
} from '../../../../shared/billing.ts';
import { cnDate, cnDateFull, money } from '../../../../shared/format.ts';
import { chargeBaseOrNaN, chargeValue } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Seg } from '../../components/inputs.tsx';
import { t } from '../../../../shared/i18n.ts';
import { ChargeBars, type ChartLane } from '../DetailChart.tsx';
import { detailForecast, detailHistoryEnd } from '../detail-data.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { meterRows } from '../../../../shared/meters.ts';
import { ChargeTip, chargeUsage } from './ChargeTip.tsx';
import { LANE_COLORS } from './shared.tsx';
import { Region } from './shared.tsx';
import { methodOf } from './shared.tsx';
import { regular } from './shared.tsx';

export type Range = 'all' | '1y' | '6m';

/**
 * 柱子位置：后付费的周期账单画在所属周期中间（8 月电费在 8 月中），与用量柱对齐；其余在扣款日。
 * 还没出的账单若中间日已过（周期还没走完），挪到周期末日，不画在「今天」左边
 */
export function barDay(c: Charge, today: string): string {
  if (c.kind || !isPostpaid(c.sub)) return c.date;
  const p = chargeServicePeriod(c.sub, c.date, c.serviceDate);
  const last = addDays(p.until, -1);
  const mid = midDay(p.from, last);
  return c.date > today && mid <= today ? last : mid;
}

/**
 * 费用走势的时间范围与横轴：详情页据此同时驱动费用图和用量图，两张图日期对齐、范围同步。
 * 预测长度按周期：月付及更短看半年，更长的看一个周期（至少半年、至多两年）。
 */
export function timelineAxis(sub: Subscription, today: string, history: Charge[], picked?: Range) {
  const st = effectiveStatus(sub, today);
  const cur = currentPhase(sub, today);
  const reg = regular(history);
  const live = !['ended', 'terminated', 'lifetime', 'paused'].includes(st);
  const end = detailHistoryEnd(sub, today);
  const anchor = end.date ?? today;
  const next = live ? detailForecast(sub, today).charges[0] : undefined;
  const days = cycleDays(cur.cycle);
  let until = live ? addDays(today, days <= 31 ? 183 : Math.min(731, Math.max(183, Math.ceil(days) + 1))) : anchor;
  if (next && next.date > until) until = next.date;
  const future = live ? chargesBetween(sub, addDays(today, 1), until, today).filter((c) => !c.kind) : [];

  // 只有范围内至少三笔、且比全部少时才给这个范围：两年付、年付这类稀疏记录不显示无意义的「1 年 / 6 个月」
  // 范围按归期日筛（后付费归到所属周期），横轴按柱子位置算
  const within = (months: number) => reg.filter((c) => chargeDay(c) >= addMonths(anchor, -months)).length;
  const ranges: Array<[Range, string]> = [
    ['all', t('detail.chart.all')],
    ...(
      [
        ['1y', t('detail.chart.y1'), 12],
        ['6m', t('detail.chart.m6'), 6],
      ] as const
    )
      .filter(([, , m]) => within(m) >= 3 && within(m) < reg.length)
      .map(([k, l]) => [k, l] as [Range, string]),
  ];
  // 月付及更短默认看最近一年，柱子不至于挤成一片；更长的周期默认看全部
  const fallback: Range = days <= 31 && ranges.some(([k]) => k === '1y') ? '1y' : 'all';
  const range = picked && ranges.some(([k]) => k === picked) ? picked : fallback;
  const since = range === 'all' ? '' : addMonths(anchor, range === '1y' ? -12 : -6);
  const past = reg.filter((c) => chargeDay(c) >= since);
  // Preserve late payments after a known service end without extending the service lane.
  const dayOf = (c: Charge | undefined) => (c ? barDay(c, today) : anchor);
  const firstDate = dayOf(past[0] ?? future[0]);
  const lastDate = dayOf(future[future.length - 1] ?? past[past.length - 1]);
  const first = firstDate < anchor ? firstDate : anchor;
  const lastBar = lastDate > anchor ? lastDate : anchor;
  const pad = Math.max(4, Math.round(diffDays(first, lastBar) * 0.03));
  return {
    cur,
    reg,
    live,
    end,
    anchor,
    future,
    ranges,
    range,
    since,
    past,
    from: addDays(first, -pad),
    to: addDays(lastBar, pad),
    /** 画得出来：费用图至少两根柱 */
    drawn: past.length + future.length >= 2,
  };
}

/**
 * 扣款时间轴：今天之前是每笔实际扣款，之后是预测，中间一条「今天」虚线。
 * 下次扣款的日期与金额在顶部四格；已结束、暂停按实际边界截断，未知结束日仅显示已知付款范围。
 * 范围可由详情页传入（与用量图同步），不传时自己记。
 */
export function Timeline({
  sub,
  state,
  today,
  history,
  range: rangeProp,
  onRange,
  snapshotSelection,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  history: Charge[];
  range?: Range;
  onRange?: (r: Range) => void;
  snapshotSelection?: { range: Range; unit: 'base' | 'orig' };
}) {
  const base = state.settings.baseCurrency;
  const [ownRange, setOwnRange] = useState<Range | undefined>(() => snapshotSelection?.range);
  const ax = timelineAxis(sub, today, history, snapshotSelection?.range ?? rangeProp ?? ownRange);
  const { reg, live, end, anchor, future, ranges, range, past, from, to } = ax;
  const setRange = (r: Range) => (onRange ? onRange(r) : setOwnRange(r));
  // 单位：记账货币，或（所有扣款同一种外币时）原币；原币下卡上另币种结算的那笔没有原币实扣，按标价画
  const ccys = [...new Set([...reg, ...future].map((c) => c.currency))];
  const origCcy = ccys.length === 1 && ccys[0] !== base ? ccys[0] : undefined;
  // 过去的扣款全都换算不了本位币时默认按原币画，否则本位币下全是 0 高的柱子，像没花钱
  const [unit, setUnit] = useState<'base' | 'orig'>(
    () => snapshotSelection?.unit ?? (origCcy && reg.length && reg.every((c) => !Number.isFinite(chargeBaseOrNaN(state, c, base))) ? 'orig' : 'base'),
  );
  const captureRef = useRef<HTMLElement>(null);
  useSnapshotRender(captureRef, () => <Timeline sub={sub} state={state} today={today} history={history} snapshotSelection={{ range, unit }} />);
  // 图表在柱子太密时按月、季、年汇总，图例里写明一根柱代表多久的合计
  const [bucket, setBucket] = useState(0);
  const ccy = unit === 'orig' && origCcy ? origCcy : base;
  const each = [...past.map((c) => ({ c, future: false })), ...future.map((c) => ({ c, future: true }))].map((r) => {
    const v = ccy === base ? chargeValue(state, r.c, base) : r.c.amount;
    // 首期优惠：这一笔按优惠价扣，原价减去的部分在柱顶画成虚框（按这一笔同样的折算比例）
    const regularPrice = r.c.sub.intro && r.c.date < r.c.sub.intro.until && !r.c.kind ? priceAt({ ...r.c.sub, intro: undefined }, r.c.date) : undefined;
    const full = regularPrice && r.c.amount > 0 && regularPrice > r.c.amount ? (v * regularPrice) / r.c.amount : undefined;
    return {
      ...r,
      date: barDay(r.c, today),
      phase: r.c.sub.start,
      v,
      full: full != null && Number.isFinite(full) ? full : undefined,
    };
  });
  // 柱子太密时由图表按宽度自动按月、季、年汇总，这里给出每一笔
  const rows = each;
  if (rows.length < 2) return null;

  const fmt = (v: number) => money(v, ccy, { compact: true });
  // 有用量指标时提示框带上这一笔结算期内的用量（第一个指标，与扣款记录的用量列一致）
  const meter = sub.meters?.[0];
  const readings = meter && sub.cycle.unit !== 'lifetime' ? meterRows(sub, meter, today) : undefined;
  const lanesSrc = phaseSubs(sub);
  const laneIdx = phaseLanes(lanesSrc);
  const methodIds = [...new Set(lanesSrc.map((v) => v.methodId ?? ''))];
  const lanes: ChartLane[] = lanesSrc.map((v, i) => ({
    key: v.start,
    from: v.start,
    to: [detailHistoryEnd(v, today).date ?? v.end ?? to, live ? to : anchor].sort()[0],
    lane: laneIdx[i],
    color: LANE_COLORS[methodIds.indexOf(v.methodId ?? '') % LANE_COLORS.length],
    label: (
      <>
        {v.region && <Region cc={v.region} />}
        {money(v.price, v.currency)} {cycleLabel(v.cycle)}
      </>
    ),
    short: (
      <>
        {v.region && <Region cc={v.region} />}
        {money(v.price, v.currency)}
      </>
    ),
    aside: methodOf(state, v.methodId)?.name,
  }));
  const chartTotal = (list: Charge[]) =>
    ccy === base ? chargesTotal(state, list, ccy) : sumTotals(list.map((c) => amountTotal(c.amount, c.currency, c.amount)));
  const planned = chartTotal(each.filter((r) => r.future).map((r) => r.c));

  return (
    <Panel
      className="dt-chart"
      snapshotRef={captureRef}
      title={t('detail.chart.title', { ccy })}
      aside={
        <>
          {origCcy && (
            <Seg
              small
              value={unit}
              onChange={setUnit}
              options={[
                ['base', base],
                ['orig', origCcy],
              ]}
            />
          )}
          {ranges.length > 1 && <Seg small value={range} onChange={setRange} options={ranges} />}
        </>
      }
    >
      <ChargeBars
        bars={rows}
        from={from}
        to={to}
        today={today}
        todayLabel={t('calendar.today')}
        midMonth={isPostpaid(sub)}
        fmt={fmt}
        lanes={lanes}
        onBucket={setBucket}
        tip={(idx, summed) => {
          // 汇总柱（太密时按月、季、年合计）：写起止日期、笔数与合计
          if (summed && idx.length > 1) {
            const sum = chartTotal(idx.map((i) => rows[i].c));
            return (
              <>
                <div className="cc-tip-h">
                  <b>
                    {cnDateFull(chargeDay(rows[idx[0]].c))} – {cnDateFull(chargeDay(rows[idx[idx.length - 1]].c))}
                  </b>
                </div>
                <div className="cc-tip-r">
                  <i className={rows[idx[0]].future ? 'k-f' : 'k-v'} />
                  <span>{t('detail.stats.count', { count: idx.length })}</span>
                  <b>{formatTotal(sum, ccy, { direction: -1 })}</b>
                </div>
              </>
            );
          }
          // 挨在一起的几笔（换方案、换卡、并行方案）：逐笔列出
          if (idx.length > 1) {
            const sum = chartTotal(idx.map((i) => rows[i].c));
            return (
              <>
                <div className="cc-tip-h">
                  <b>{cnDateFull(chargeDay(rows[idx[0]].c))}</b>
                  <span>{t('detail.stats.count', { count: idx.length })}</span>
                </div>
                {idx.map((i) => {
                  const r = rows[i];
                  return (
                    <div className="cc-tip-r" key={i}>
                      <i className={r.future ? 'k-f' : 'k-v'} />
                      <span>
                        {copyParts(
                          [cnDate(chargeDay(r.c)), methodOf(state, chargeMethodId(r.c))?.name ?? t('ui.method.none'), r.c.sub.region ?? '']
                            .filter(Boolean)
                            .join('\n'),
                        )}
                      </span>
                      <b>{formatTotal(chartTotal([r.c]), ccy, { direction: -1 })}</b>
                    </div>
                  );
                })}
                <div className="cc-tip-f">{formatTotal(sum, ccy, { direction: -1 })}</div>
              </>
            );
          }
          const r = rows[idx[0]];
          return (
            <ChargeTip
              c={r.c}
              state={state}
              future={r.future}
              converted={r.c.currency !== ccy ? formatTotal(chartTotal([r.c]), ccy, { direction: -1 }) : undefined}
              full={r.full != null ? money(r.full, ccy) : undefined}
              usage={chargeUsage(readings, r.c)}
              meter={meter}
            />
          );
        }}
      />
      {/* 图例：实色是已扣，虚框是预测；预测合计按今天的汇率 */}
      <div className="dt-legend">
        {end.unknown && <span>{t('detail.chart.unknownEnd')}</span>}
        <span>
          <i className="k-v" />
          {t('detail.timeline.paid')}
        </span>
        {bucket > 0 && <span>{t(`detail.chart.bucket.m${bucket}`)}</span>}
        {each.some((r) => r.full != null) && (
          <span>
            <i className="k-f" />
            {t('detail.chart.saved')}
          </span>
        )}
        {future.length > 0 && (
          <span>
            <i className="k-f" />
            {t('detail.timeline.planned')}
            {copyParts(t('detail.upcoming.total', { count: future.length, amount: formatTotal(planned, ccy, { direction: -1 }) }))}
          </span>
        )}
      </div>
    </Panel>
  );
}

import { amountTotal, chargesTotal, formatTotal, sumTotals } from '../../../../shared/fx-total.ts';
import { copyParts } from '../../components/copy.tsx';
import { chargeMethodId } from '../../../../shared/billing.ts';
import { useRef, useState } from 'react';
import { useSnapshotRender } from '../../snapshot-render.tsx';
import {
  addDays,
  addMonths,
  chargesBetween,
  currentPhase,
  cycleDays,
  cycleLabel,
  diffDays,
  effectiveStatus,
  phaseLanes,
  phaseSubs,
  priceAt,
  type Charge,
} from '../../../../shared/billing.ts';
import { flow, cnDate, cnDateFull, money, weekdayOf } from '../../../../shared/format.ts';
import { chargeBaseOrNaN, chargeValue, convertOn, rateOn } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Seg } from '../../components/inputs.tsx';
import { PayBadge } from '../../components/marks.tsx';
import { t } from '../../../../shared/i18n.ts';
import { ChargeBars, type ChartLane } from '../DetailChart.tsx';
import { detailForecast, detailHistoryEnd } from '../detail-data.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { LANE_COLORS } from './shared.tsx';
import { Region } from './shared.tsx';
import { methodOf } from './shared.tsx';
import { regular } from './shared.tsx';

export type Range = 'all' | '1y' | '6m';

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
  const within = (months: number) => reg.filter((c) => c.date >= addMonths(anchor, -months)).length;
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
  const past = reg.filter((c) => c.date >= since);
  // Preserve late payments after a known service end without extending the service lane.
  const firstDate = (past[0] ?? future[0])?.date ?? anchor;
  const lastDate = (future[future.length - 1] ?? past[past.length - 1])?.date ?? anchor;
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
  // 标价参照：每一段按它首笔扣款那天的汇率折算，柱子高出或低于这条线就是汇率带来的涨跌
  const firstOf = new Map<string, string>();
  for (const c of reg) if (!firstOf.has(c.sub.start)) firstOf.set(c.sub.start, c.date);
  const each = [...past.map((c) => ({ c, future: false })), ...future.map((c) => ({ c, future: true }))].map((r) => {
    const price = priceAt(r.c.sub, r.c.date);
    const list = ccy === base ? convertOn(price, r.c.currency, base, firstOf.get(r.c.sub.start) ?? r.c.date, state.fxHistory, state.fx) : price;
    const v = ccy === base ? chargeValue(state, r.c, base) : r.c.amount;
    // 首期优惠：这一笔按优惠价扣，原价减去的部分在柱顶画成虚框（按这一笔同样的折算比例）
    const regularPrice = r.c.sub.intro && r.c.date < r.c.sub.intro.until && !r.c.kind ? priceAt({ ...r.c.sub, intro: undefined }, r.c.date) : undefined;
    const full = regularPrice && r.c.amount > 0 && regularPrice > r.c.amount ? (v * regularPrice) / r.c.amount : undefined;
    return {
      ...r,
      date: r.c.date,
      phase: r.c.sub.start,
      v,
      list: Number.isFinite(list) ? list : undefined,
      full: full != null && Number.isFinite(full) ? full : undefined,
    };
  });
  // 标价与实际几乎一样（同币种、未调价）时不画参照线，免得压在柱顶上重复
  const showList = each.some((r) => r.list != null && Number.isFinite(r.v) && Math.abs(r.list - r.v) > Math.abs(r.v) * 0.005);
  // 柱子太密时由图表按宽度自动按月、季、年汇总，这里给出每一笔
  const rows = showList ? each : each.map((r) => ({ ...r, list: undefined }));
  if (rows.length < 2) return null;

  const fmt = (v: number) => money(v, ccy, { compact: true });
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
                    {cnDateFull(rows[idx[0]].c.date)} – {cnDateFull(rows[idx[idx.length - 1]].c.date)}
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
                  <b>{cnDateFull(rows[idx[0]].c.date)}</b>
                  <span>{t('detail.stats.count', { count: idx.length })}</span>
                </div>
                {idx.map((i) => {
                  const r = rows[i];
                  return (
                    <div className="cc-tip-r" key={i}>
                      <i className={r.future ? 'k-f' : 'k-v'} />
                      <span>
                        {copyParts(
                          [cnDate(r.c.date), methodOf(state, chargeMethodId(r.c))?.name ?? t('ui.method.none'), r.c.sub.region ?? '']
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
          const c = r.c;
          const m = methodOf(state, chargeMethodId(c));
          const rate = rateOn(state.fxHistory, c.currency, c.date);
          const rb = rateOn(state.fxHistory, base, c.date);
          return (
            <>
              <div className="cc-tip-h">
                <b>{cnDateFull(c.date)}</b>
                <span>{weekdayOf(c.date)}</span>
              </div>
              <div className="cc-tip-r">
                <i className={r.future ? 'k-f' : 'k-v'} />
                <span>{r.future ? t('detail.timeline.planned') : t('detail.chart.perCharge')}</span>
                <b>{formatTotal(chartTotal([r.c]), ccy, { direction: -1 })}</b>
              </div>
              {r.full != null && (
                <div className="cc-tip-r">
                  <i className="k-f" />
                  <span>{t('detail.chart.regular')}</span>
                  <b className="m">{money(r.full, ccy)}</b>
                </div>
              )}
              {r.list != null && (
                <div className="cc-tip-r">
                  <i className="k-l" />
                  <span>{ccy === base ? t('detail.chart.list') : t('detail.chart.listOrig')}</span>
                  <b className="m">{money(r.list, ccy)}</b>
                </div>
              )}
              {c.currency !== ccy && (
                <div className="cc-tip-r">
                  <i />
                  <span>{t('detail.chart.origAmount')}</span>
                  <b className="m">{flow(-c.amount, c.currency)}</b>
                </div>
              )}
              <div className="cc-tip-f">
                <PayBadge m={m} />
                {copyParts(
                  !r.future &&
                    ccy === base &&
                    c.currency !== base &&
                    rate &&
                    rb &&
                    `\n1 ${c.currency} = ${((1 / rate.rate) * rb.rate).toFixed(c.currency === 'NGN' ? 5 : 4)} ${base}`,
                )}
              </div>
            </>
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
        {showList && (
          <span>
            <i className="k-l" />
            {ccy === base ? t('detail.chart.list') : t('detail.chart.listOrig')}
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

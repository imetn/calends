import { amountTotal, averageLine, chargesTotal, formatTotal, sumTotals, type FxTotal } from '../../../../shared/fx-total.ts';
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
  isSeparate,
  midDay,
  overdueBills,
  phaseLanes,
  phaseSubs,
  priceAt,
  type Charge,
} from '../../../../shared/billing.ts';
import { cnDate, cnDateFull, money, moneyTick, wholeCurrencies, wholeOpts } from '../../../../shared/format.ts';
import { chargeBaseOrNaN, chargeValue } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Seg } from '../../components/inputs.tsx';
import { t } from '../../../../shared/i18n.ts';
import { ChargeBars, type ChartLane } from '../DetailChart.tsx';
import { detailForecast, detailHistoryEnd } from '../detail-data.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { meterDecimals, meterRows, meterView } from '../../../../shared/meters.ts';
import { ChargeTip, chargeOpen, chargeUsage } from './ChargeTip.tsx';
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
 * 分开记的每期账单柱：按阶段与账单日合成一期，有缴费（含预缴的未来账单）的画实柱，没缴的部分叠在同一根柱上画斜纹；
 * 完全没缴的今天及以前的那期归 owed（虚线），今天之后的只取下一期。不是分开记时为 undefined
 */
function separateBars(sub: Subscription, today: string, until: string) {
  if (!phaseSubs(sub).some(isSeparate)) return undefined;
  const groups = new Map<string, Charge[]>();
  for (const c of chargesBetween(sub, sub.start, until > today ? until : today, today))
    if (!c.kind && c.amount > 0) groups.set(`${c.sub.start}|${c.date}`, [...(groups.get(`${c.sub.start}|${c.date}`) ?? []), c]);
  const merge = (cs: Charge[]): Charge => {
    const main = cs.find((c) => c.paidOn) ?? cs[0];
    return cs.length < 2 ? main : { ...main, amount: Math.round(cs.reduce((a, c) => a + c.amount, 0) * 100) / 100 };
  };
  const paid: Charge[] = [];
  const owed: Charge[] = [];
  const next: Charge[] = [];
  const remainder = new Map<Charge, Charge>();
  for (const cs of groups.values()) {
    const done = cs.filter((c) => !c.unpaid);
    const left = cs.filter((c) => c.unpaid);
    if (done.length) {
      const bar = merge(done);
      paid.push(bar);
      if (left.length) remainder.set(bar, merge(left));
    } else if (left[0].date <= today) owed.push(merge(left));
    else if (!next.length) next.push(merge(left));
  }
  return { paid: paid.filter((c) => c.date <= today || c.paidOn), owed, next, remainder };
}

/**
 * 费用走势的时间范围与横轴：详情页据此同时驱动费用图和用量图，两张图日期对齐、范围同步。
 * 未来只画下一期。
 */
export function timelineAxis(sub: Subscription, today: string, history: Charge[], picked?: Range) {
  const st = effectiveStatus(sub, today);
  const cur = currentPhase(sub, today);
  // 分开记时一期一根柱：平均线、范围按已缴（含部分已缴）的各期算，见 separateBars
  const reg = phaseSubs(sub).some(isSeparate) ? (separateBars(sub, today, today)?.paid ?? []) : regular(history);
  const live = !['ended', 'terminated', 'lifetime', 'paused'].includes(st);
  const end = detailHistoryEnd(sub, today);
  const anchor = end.date ?? today;
  const next = live ? detailForecast(sub, today).charges[0] : undefined;
  // 未来只画下一期：再往后都是同样的柱子，没有信息量；下一笔的金额与日期在顶部「下张账单」卡里
  const days = cycleDays(cur.cycle);
  const until = next && next.date > today ? next.date : anchor;
  const future =
    live && next
      ? chargesBetween(sub, addDays(today, 1), until, today)
          .filter((c) => !c.kind && !c.paidOn)
          .slice(0, 1)
      : [];

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
  const bills = separateBars(sub, today, until);
  const past = (bills?.paid ?? reg).filter((c) => chargeDay(c) >= since);
  // 账单与缴费分开记：账单日已过（含今天）还没缴的那期，和预测一样画虚线
  const owed = (bills?.owed ?? overdueBills(sub, today)).filter((c) => chargeDay(c) >= since);
  if (bills) future.splice(0, future.length, ...bills.next);
  // Preserve late payments after a known service end without extending the service lane.
  // 按柱子位置取首末：补交的旧账单扣款日晚，柱子却画在更早的所属周期，不能按扣款顺序取
  const barDays = [...past, ...owed, ...future].map((c) => barDay(c, today)).sort();
  const firstDate = barDays[0] ?? anchor;
  const lastDate = barDays[barDays.length - 1] ?? anchor;
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
    owed,
    /** 分开记时部分已缴的那期：已缴那根柱 → 同一期还没缴的部分 */
    remainder: bills?.remainder,
    from: addDays(first, -pad),
    to: addDays(lastBar, pad),
    /** 画得出来：费用图至少两根柱 */
    drawn: past.length + owed.length + future.length >= 2,
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
  const { reg, live, end, anchor, future, ranges, range, past, owed, remainder, from, to } = ax;
  const setRange = (r: Range) => (onRange ? onRange(r) : setOwnRange(r));
  // 单位：记账货币，或（所有扣款同一种外币时）原币；原币下卡上另币种结算的那笔没有原币实扣，按标价画
  const ccys = [...new Set([...reg, ...owed, ...future].map((c) => c.currency))];
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
  // 平均线：与用量图一样按全部实际记录算，只画在已发生的柱上；缺汇率的不算进去，不能当 0
  const average = averageLine(reg.map((c) => (ccy === base ? chargeBaseOrNaN(state, c, base) : c.amount)));
  const ordered = [...past.map((c) => ({ c, future: false })), ...owed.map((c) => ({ c, future: true })), ...future.map((c) => ({ c, future: true }))];
  // 分开记时逾期账单、预缴的未来账单插在中间，要按日期重排；其余订阅保持原有顺序
  const each = (remainder ? ordered.sort((a, b) => a.c.date.localeCompare(b.c.date)) : ordered).map((r) => {
    // 缺汇率的是 NaN：图表画占位短柱，也不算进汇总后的平均线
    const v = ccy === base ? chargeBaseOrNaN(state, r.c, base) : r.c.amount;
    // 首期优惠：这一笔按优惠价扣，原价减去的部分在柱顶画成斜纹（按这一笔同样的折算比例）
    const regularPrice = r.c.sub.intro && r.c.date < r.c.sub.intro.until && !r.c.kind ? priceAt({ ...r.c.sub, intro: undefined }, r.c.date) : undefined;
    const intro = regularPrice && r.c.amount > 0 && regularPrice > r.c.amount ? (v * regularPrice) / r.c.amount : undefined;
    // 部分已缴：没缴的部分叠在柱顶画斜纹（与首期优惠同一种画法），整根柱高是本期应缴
    const owedPart = remainder?.get(r.c);
    const full = owedPart ? v + (ccy === base ? chargeBaseOrNaN(state, owedPart, base) : owedPart.amount) : intro;
    return {
      ...r,
      date: barDay(r.c, today),
      phase: r.c.sub.start,
      v,
      ref: r.future ? undefined : average,
      full: full != null && Number.isFinite(full) ? full : undefined,
      intro: intro != null,
      owedPart,
    };
  });
  // 柱子太密时由图表按宽度自动按月、季、年汇总，这里给出每一笔
  const rows = each;
  if (rows.length < 2) return null;

  // 最高柱顶的金额：与提示框、扣款记录同一种写法（某币种全是整数时不写 .00）
  const whole = wholeCurrencies(history);
  // 整价判断看全部扣款与预测，不随所选范围变化，与扣款记录同一份数据
  const wholeChart = wholeCurrencies(
    [...reg, ...owed, ...future].map((c) => ({ amount: ccy === base ? chargeValue(state, c, base) : c.amount, currency: ccy })),
  );
  const fmt = (v: number) => money(v, ccy, wholeOpts(v, ccy, wholeChart));
  const spent = (total: FxTotal) => formatTotal(total, ccy, { direction: -1, ...(wholeChart.has(ccy) ? { decimals: 0 } : {}) });
  // 有用量指标时提示框带上这一笔结算期内的用量（第一个指标，与扣款记录的用量列一致）
  const usageSub = meterView(sub, state.subscriptions);
  const meter = usageSub.meters?.[0];
  const readings = meter && sub.cycle.unit !== 'lifetime' ? meterRows(usageSub, meter, today) : undefined;
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
        // 金额很小时刻度是 0.25、0.5，取整会出现两个相同的标签
        tick={(v) => (Number.isInteger(v) ? moneyTick(v, ccy) : money(v, ccy))}
        lanes={lanes}
        onBucket={setBucket}
        tip={(idx, summed) => {
          // 汇总柱（太密时按月、季、年合计）：写起止日期、笔数与合计
          if (summed && idx.length > 1) {
            const sum = chartTotal(idx.map((i) => rows[i].c));
            return (
              <>
                <div className="cc-tip-h">
                  {/* 同一天的几笔合成一根柱时只写这一天 */}
                  <b>
                    {chargeDay(rows[idx[0]].c) === chargeDay(rows[idx[idx.length - 1]].c)
                      ? cnDateFull(chargeDay(rows[idx[0]].c))
                      : `${cnDateFull(chargeDay(rows[idx[0]].c))} – ${cnDateFull(chargeDay(rows[idx[idx.length - 1]].c))}`}
                  </b>
                </div>
                <div className="cc-tip-r">
                  <i className={rows[idx[0]].future ? 'k-f' : 'k-v'} />
                  <span>{t('detail.stats.count', { count: idx.length })}</span>
                  <b>{spent(sum)}</b>
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
                      <b>{spent(chartTotal([r.c]))}</b>
                    </div>
                  );
                })}
                <div className="cc-tip-f">{spent(sum)}</div>
              </>
            );
          }
          const r = rows[idx[0]];
          return (
            <ChargeTip
              c={r.c}
              state={state}
              today={today}
              whole={whole}
              future={r.future}
              converted={r.c.currency !== ccy ? spent(chartTotal([r.c])) : undefined}
              full={r.intro && r.full != null ? money(r.full, ccy) : undefined}
              owed={r.owedPart}
              usage={chargeUsage(readings, r.c)}
              open={chargeOpen(readings, r.c)}
              meter={meter}
              decimals={meter && meterDecimals(usageSub, meter.id)}
            />
          );
        }}
      />
      {/* 实色是已扣、斜纹是预计，一看就知道，图例只写看不出来的事 */}
      {(end.unknown || bucket > 0 || each.some((r) => r.intro)) && (
        <div className="dt-legend">
          {end.unknown && <span>{t('detail.chart.unknownEnd')}</span>}
          {bucket > 0 && <span>{t(`detail.chart.bucket.m${bucket}`)}</span>}
          {each.some((r) => r.intro) && (
            <span>
              <i className="k-f" />
              {t('detail.chart.saved')}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

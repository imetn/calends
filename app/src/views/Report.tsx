import { Composition } from '../components/Composition.tsx';
import { chargesTotal, emptyTotal, formatTotal, scaleTotal, sumTotals, totalNote } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { CopyImageButton } from '../components/CopyImageButton.tsx';
import { snapshotCard } from '../snapshot.ts';
import { copyParts } from '../components/copy.tsx';
import { base as appPath } from '../base.ts';
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMonths, DAYS_PER_MONTH, diffDays, effectiveStatus, isStopped } from '../../../shared/billing.ts';
import { flow, cnDate, money, moneyTick, monthLabel } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { tx } from '../i18n.ts';
import {
  cashVsAccrual,
  events,
  insights,
  monthEnd,
  monthMovement,
  prepaidValue,
  stopHistory,
  stopLosses,
  topUpPlan,
  type EventKind,
} from '../../../shared/metrics.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { AreaChart, BarLine } from '../components/charts.tsx';
import { MetricCards, Metric, IconButton, CardTitle, Toolbar } from '../components/ui.tsx';
import { Seg } from '../components/inputs.tsx';
import { MethodMark, SubIcon } from '../components/marks.tsx';
import { Icon } from '../components/icons.tsx';
import { tipProps } from '../components/overlays.tsx';
import { allCharges, toBase, firstStart } from '../derive.ts';
import { SpendingDelta } from '../components/ScopeReport.tsx';
import { allOutlook, cumulativeTrend, spendPiecesBetween, subscriptionTenure, yearOutlook, type YearDriver } from '../../../shared/scope-report.ts';
import { Picker } from '../components/Picker.tsx';
import { carpoolYear } from '../../../shared/carpool.ts';
import { proxyYear } from '../../../shared/proxy.ts';
import { go } from '../router.ts';

const mLabel = (m: string) => (m.endsWith('-01') ? t('report.axis.year', { yy: m.slice(2, 4), year: m.slice(0, 4) }) : monthLabel(m, { year: false }));
const perMonth = (amount: string) => t('report.perMonth', { amount });

export function Report({
  state,
  today,
  onOpen,
  onReview,
}: {
  state: AppState;
  today: string;
  onOpen: (s: Subscription) => void;
  onReview: (year: string) => void;
}) {
  const base = state.settings.baseCurrency;
  const cur = Number(today.slice(0, 4));
  // 可选：全部，或账本第一年到明年（新的在前）
  // 代付不算自己的支出，起始年与累计口径一致地排除
  const first = Math.min(cur, Number(firstStart(ownState(state), today).slice(0, 4)));
  const [pick, setPick] = useState(String(cur));
  const all = pick === 'all';
  const pieces = useMemo(
    () => (all ? allOutlook(state, today).pieces : spendPiecesBetween(state, `${pick}-01-01`, `${pick}-12-31`, today)),
    [all, pick, state, today],
  );
  const year = all ? cur : Number(pick);
  const now = !all && year === cur;
  const future = !all && year > cur;
  const options = [
    { value: 'all', label: t('report.pick.all') },
    ...Array.from({ length: cur + 2 - first }, (_, i) => String(cur + 1 - i)).map((y) => ({ value: y, label: t('report.pick.year', { year: y }) })),
  ];
  const pageRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <Toolbar title={t('report.title')}>
        {/* 鼠标移到分享上才出现：复制整份报告为一张图（卡片上的复制只取那一张）；「分享年度回顾」是另做的个性化回顾 */}
        <span className="report-share">
          <CopyImageButton render={() => snapshotCard(pageRef.current!)} />
          <YearStep value={pick} options={options} onChange={setPick} />
          {/* 回顾只回看今年及以前；全部是从第一笔到今天的累计回顾 */}
          <button className="btn" disabled={future} onClick={() => onReview(pick)}>
            <Icon name="share" /> {all ? t('report.shareAll') : t('report.shareReview', { year })}
          </button>
        </span>
      </Toolbar>
      {/* 整页跟随所选年份；构成按所选年份实付；体检、充值描述的是现在，只在今年出现。
          全部：累计花了多少、累计构成（分类／支付方式／币种／周期）、订阅能留多久、逐年现金、停用损失；按月、按年的变化明细不再出现 */}
      <div className="page fade-in stack" ref={pageRef}>
        {all ? (
          <>
            <AllHero state={state} today={today} />
            <AllCard state={state} today={today} first={first} onOpen={onOpen} />
            <CashCard state={state} today={today} year={null} />
            <Composition state={state} today={today} onOpen={onOpen} pieces={pieces} hint={t('report.comp.basisAll')} />
            <TenureCard state={state} today={today} onOpen={onOpen} />
            <StopsCard state={state} today={today} year={null} onOpen={onOpen} />
          </>
        ) : (
          <>
            <Hero state={state} today={today} year={year} />
            <YearCard state={state} today={today} year={year} onOpen={onOpen} />
            <CashCard state={state} today={today} year={year} />
            <Composition state={state} today={today} onOpen={onOpen} pieces={pieces} hint={t('report.comp.basisYear')} />
            {now ? (
              <div className="grid g-2">
                <Waterfall key={year} state={state} today={today} year={year} onOpen={onOpen} />
                <Checkup state={state} today={today} onOpen={onOpen} />
              </div>
            ) : (
              !future && (
                <div className="grid g-2 report-bottom">
                  <Waterfall key={year} state={state} today={today} year={year} onOpen={onOpen} />
                  <Changelog state={state} today={today} year={year} onOpen={onOpen} base={base} />
                </div>
              )
            )}
            {!future && <StopsCard state={state} today={today} year={year} onOpen={onOpen} />}
            {now && (
              <div className="grid g-2 report-bottom">
                <TopUps state={state} today={today} />
                <Changelog state={state} today={today} year={year} onOpen={onOpen} base={base} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 年份胶囊：两侧淡色箭头逐个切换，中间仍可下拉；按时间顺序循环，最晚一年之后是全部，再回到第一年 */
function YearStep({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) {
  // 下拉里最新的在上；循环按时间从早到晚，全部排在最后
  const order = [
    ...options
      .filter((o) => o.value !== 'all')
      .map((o) => o.value)
      .reverse(),
    'all',
  ];
  // 当前值不在列表里（如最早的年份已被删掉）时，下一个从第一年起，上一个从全部起
  const step = (d: number) => {
    const i = order.indexOf(value);
    onChange(order[i < 0 ? (d > 0 ? 0 : order.length - 1) : (i + d + order.length) % order.length]);
  };
  return (
    <span className="year-step">
      <button type="button" className="year-step-arrow" aria-label={t('report.pick.prev')} title={t('report.pick.prev')} onClick={() => step(-1)}>
        <Icon name="left" />
      </button>
      <Picker variant="btn" value={value} options={options} onChange={onChange} ariaLabel={t('report.pick.label')} search={false} />
      <button type="button" className="year-step-arrow" aria-label={t('report.pick.next')} title={t('report.pick.next')} onClick={() => step(1)}>
        <Icon name="right" />
      </button>
    </span>
  );
}

/** 头部：所选年份全年已付加预计，与上一年比较（今年比同期）；走势为逐月累计，今天所在月起是预计 */
function Hero({ state, today, year }: { state: AppState; today: string; year: number }) {
  const base = state.settings.baseCurrency;
  const r = useMemo(() => yearOutlook(state, today, year), [state, today, year]);
  const cur = Number(today.slice(0, 4));
  const change = r.samePeriod.change;
  const delta = change?.amount ?? NaN;
  const trend = useMemo(() => cumulativeTrend(r.months, today), [r, today]);
  const peak = r.months.reduce((a, m) => (m.total > a.total ? m : a), r.months[0]);
  const amount = (total: Parameters<typeof formatTotal>[0]) => formatTotal(total, base, { direction: -1, compact: true });
  const arrow = (v: number) => (!Number.isFinite(v) ? '—' : `${v > 0.005 ? '↑' : v < -0.005 ? '↓' : ''} ${money(Math.abs(v), base, { compact: true })}`.trim());
  return (
    <div className="card hero-card copy-card" data-copy-card>
      {/* 复制按钮与其他卡片一样放在整张卡片右上角 */}
      <div className="copy-corner">
        <CopyImageButton hover />
      </div>
      <div className="hero-l">
        <CardTitle as="div" className="stat-label" hint={t('report.year.basis')}>
          {t('report.hero.label')}
        </CardTitle>
        <div className="hero-num">
          <FxAmount total={r.current.partial.total} ccy={base} direction={-1} />
        </div>
        <div className="hero-delta stmt-delta">
          {change && Number.isFinite(delta) && (
            <>
              <span className={delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : ''}>{copyParts(arrow(delta))}</span>
              {t(year === cur ? 'report.year.vsLast' : 'report.year.vsPrev')}
            </>
          )}
        </div>
        <MetricCards plain>
          {/* 往年全已付、明年全待扣，这两格会与大数字重复，只在今年出现 */}
          {year === cur && (
            <>
              <Metric label={t('report.hero.paid')} value={formatTotal(r.current.partial.paid, base, { direction: -1, compact: true, main: true })} />
              <Metric label={t('scope.pending')} value={formatTotal(r.current.partial.pending, base, { direction: -1, compact: true, main: true })} />
            </>
          )}
          <Metric
            label={t('report.hero.avg')}
            value={formatTotal(scaleTotal(r.current.partial.total, 1 / 12), base, { direction: -1, compact: true, main: true })}
          />
          <Metric
            label={peak.total > 0.005 ? t('report.hero.peakAt', { when: monthLabel(peak.month, { year: false }) }) : t('report.hero.peak')}
            value={peak.total > 0.005 ? formatTotal(peak.partial.total, base, { direction: -1, compact: true, main: true }) : '—'}
          />
        </MetricCards>
      </div>
      <div className="hero-r">
        <AreaChart
          values={trend.values}
          fmt={(v) => moneyTick(v, base)}
          labels={r.months.map((m) => mLabel(m.month))}
          months={r.months.map((m) => m.month)}
          now={trend.now}
          tip={(i) => (
            <>
              <b>{monthLabel(r.months[i].month, { year: false })}</b> <span className="copy-gap" aria-hidden="true" />{' '}
              {copyParts(
                // 今天所在月还有待扣时单列，免得当月数看着比已付多
                t(r.months[i].month === today.slice(0, 7) && r.months[i].pending > 0.005 ? 'report.hero.tipNow' : 'report.hero.tip', {
                  month: amount(r.months[i].partial.total),
                  pending: amount(r.months[i].partial.pending),
                  total: amount(sumTotals(r.months.slice(0, i + 1).map((m) => m.partial.total))),
                }),
              )}
            </>
          )}
        />
      </div>
    </div>
  );
}

/** 全部：从第一笔扣款到今天的累计支出；走势为逐月累计，全是已发生 */
function AllHero({ state, today }: { state: AppState; today: string }) {
  const base = state.settings.baseCurrency;
  const r = useMemo(() => allOutlook(state, today), [state, today]);
  const cum = r.months.reduce<number[]>((acc, m) => [...acc, (acc[acc.length - 1] ?? 0) + (Number.isFinite(m.total) ? m.total : 0)], []);
  // 年均按实际经过的天数折算；不足一年时就是累计本身
  const years = Math.max(1, (diffDays(r.since, today) + 1) / 365);
  const peak = r.years.reduce((a, y) => (y.paid > a.paid ? y : a), r.years[0]);
  const peakMonth = r.months.reduce((a, m) => (m.total > a.total ? m : a), r.months[0]);
  const amount = (total: Parameters<typeof formatTotal>[0]) => formatTotal(total, base, { direction: -1, compact: true });
  return (
    <div className="card hero-card copy-card" data-copy-card>
      {/* 复制按钮与其他卡片一样放在整张卡片右上角 */}
      <div className="copy-corner">
        <CopyImageButton hover />
      </div>
      <div className="hero-l">
        <CardTitle as="div" className="stat-label" hint={t('report.all.basis')}>
          {t('report.all.label')}
        </CardTitle>
        <div className="hero-num">
          <FxAmount total={r.total} ccy={base} direction={-1} />
        </div>
        <div className="hero-delta">{t('report.all.since', { date: monthLabel(r.since.slice(0, 7)) })}</div>
        <MetricCards plain>
          <Metric
            label={t('report.all.last12')}
            value={formatTotal(sumTotals(r.months.slice(-12).map((m) => m.partial.total)), base, { direction: -1, compact: true, main: true })}
          />
          <Metric label={t('report.all.avg')} value={formatTotal(scaleTotal(r.total, 1 / years), base, { direction: -1, compact: true, main: true })} />
          <Metric
            label={peak && peak.paid > 0.005 ? t('report.hero.peakAt', { when: t('report.pick.year', { year: peak.year }) }) : t('report.all.peak')}
            value={peak && peak.paid > 0.005 ? formatTotal(peak.partial.paid, base, { direction: -1, compact: true, main: true }) : '—'}
          />
          <Metric
            label={peakMonth && peakMonth.total > 0.005 ? t('report.hero.peakAt', { when: monthLabel(peakMonth.month) }) : t('report.hero.peak')}
            value={peakMonth && peakMonth.total > 0.005 ? formatTotal(peakMonth.partial.total, base, { direction: -1, compact: true, main: true }) : '—'}
          />
        </MetricCards>
      </div>
      <div className="hero-r">
        <AreaChart
          values={cum}
          fmt={(v) => moneyTick(v, base)}
          labels={r.months.map((m) => mLabel(m.month))}
          months={r.months.map((m) => m.month)}
          tip={(i) => (
            <>
              <b>{monthLabel(r.months[i].month)}</b> <span className="copy-gap" aria-hidden="true" />{' '}
              {copyParts(
                t('report.hero.tip', {
                  month: amount(r.months[i].partial.total),
                  total: amount(sumTotals(r.months.slice(0, i + 1).map((m) => m.partial.total))),
                }),
              )}
            </>
          )}
        />
      </div>
    </div>
  );
}

/** 全部：用过多少订阅、停了多少，以及合租、代付历年盈亏之和（今年含预计）；没有合租、代付就只有前两格 */
function AllCard({ state, today, first, onOpen }: { state: AppState; today: string; first: number; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const subs = useMemo(() => allOutlook(state, today).bySub.map((x) => x.sub), [state, today]);
  const stopped = state.subscriptions.filter((s) => !s.proxy && isStopped(effectiveStatus(s, today)));
  const extras = useMemo(() => {
    const years = Array.from({ length: Number(today.slice(0, 4)) - first + 1 }, (_, i) => String(first + i));
    const cars = years.map((y) => carpoolYear(state, today, y));
    const pxs = years.map((y) => proxyYear(state, today, y));
    const uniq = (list: Subscription[]) => [...new Map(list.map((s) => [s.id, s])).values()];
    const car = { subs: uniq(cars.flatMap((c) => c.subs)), net: cars.reduce((a, c) => a + c.net, 0), total: sumTotals(cars.map((c) => c.partial.net)) };
    const px = { subs: uniq(pxs.flatMap((p) => p.subs)), net: pxs.reduce((a, p) => a + p.diff, 0), total: sumTotals(pxs.map((p) => p.partial.diff)) };
    return [car.subs.length > 0 && { key: 'carpool' as const, ...car }, px.subs.length > 0 && { key: 'proxy' as const, ...px }].filter((x) => !!x);
  }, [state, today, first]);
  const icons = (lead: string, list: Subscription[]) => (
    <div className="ins-subs" style={{ flexWrap: 'nowrap', alignItems: 'center', overflow: 'hidden' }} data-snapshot-list>
      <small style={{ marginRight: 2, whiteSpace: 'nowrap' }}>{lead}</small>
      {list.slice(0, 3).map((s) => (
        <button type="button" data-snapshot-keep key={s.id} onClick={() => onOpen(s)} title={s.name} aria-label={s.name}>
          <SubIcon sub={s} size={18} />
        </button>
      ))}
    </div>
  );
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={t('report.all.basis')}>
          {t('report.all.detail')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <MetricCards inline>
        <Metric label={t('report.all.subs')} value={subs.length} note={icons(t('report.year.count', { count: subs.length }), subs)} />
        <Metric
          label={t('report.year.stopped')}
          value={stopped.length}
          note={stopped.length > 0 && icons(t('report.year.count', { count: stopped.length }), stopped)}
        />
        {extras.map((g) => (
          // 赚了写盈利、亏了写亏损，金额带正负号；缺汇率时只写盈亏
          <Metric
            key={g.key}
            label={t(`report.year.${g.key}${g.total.incomplete ? 'Net' : Math.abs(g.net) < 0.5 ? 'Even' : g.net > 0 ? 'Gain' : 'Loss'}`)}
            value={formatTotal(g.total, base, { direction: 1, compact: true })}
            valueClassName={g.total.incomplete || Math.abs(g.net) < 0.5 ? '' : g.net > 0 ? 'gain' : 'loss'}
            note={totalNote(g.total) || icons(t('report.year.count', { count: g.subs.length }), g.subs)}
          />
        ))}
      </MetricCards>
    </div>
  );
}

/** 全部：订阅能留多久——平均使用时长、试了就停、在用订阅数走势和用得最久的几个 */
function TenureCard({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const r = useMemo(() => subscriptionTenure(state, today), [state, today]);
  const peak = r.byMonth.reduce((a, m) => (m.count > a.count ? m : a), r.byMonth[0]);
  const top = r.longest.slice(0, 6);
  if (!peak || !top.length) return null;
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={t('report.tenure.basis')}>
          {t('report.tenure.title')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <MetricCards inline>
        <Metric label={t('report.tenure.active')} value={span(r.active.avgDays)} />
        <Metric label={t('report.tenure.stopped')} value={r.stopped.count ? span(r.stopped.avgDays) : '—'} />
        <Metric
          label={t('report.tenure.quick')}
          value={r.quick.length}
          note={
            r.quick.length > 0 && (
              <div className="ins-subs" style={{ flexWrap: 'nowrap', overflow: 'hidden' }} data-snapshot-list>
                {r.quick.slice(0, 4).map((s) => (
                  <button type="button" data-snapshot-keep key={s.id} onClick={() => onOpen(s)} title={s.name} aria-label={s.name}>
                    <SubIcon sub={s} size={18} />
                  </button>
                ))}
              </div>
            )
          }
        />
        <Metric label={t('report.tenure.peak')} value={peak.count} note={<small>{monthLabel(peak.month)}</small>} />
      </MetricCards>
      <div className="stat-label" style={{ margin: '18px 0 6px' }}>
        {t('report.tenure.longest')}
      </div>
      {/* 与退订与停用同一行样式：宽卡片分两列，先排满左列再排右列 */}
      <div className="stop-list" style={{ gridTemplateRows: `repeat(${Math.ceil(top.length / 2)}, auto)` }} data-snapshot-list>
        {top.map((x) => (
          <button type="button" className="stop-row" data-snapshot-keep key={x.sub.id} onClick={() => onOpen(x.sub)}>
            <span className="stop-name">
              <SubIcon sub={x.sub} size={24} />
              <b>{x.sub.name}</b>
            </span>
            <span className="stop-meta">
              <span>{t('report.all.since', { date: monthLabel(x.since.slice(0, 7)) })}</span>
            </span>
            <span className="stop-amount">
              <b className="num">{span(x.days)}</b>
            </span>
          </button>
        ))}
      </div>
      <div className="stat-label" style={{ margin: '18px 0 6px' }}>
        {t('report.tenure.count')}
      </div>
      <AreaChart
        values={r.byMonth.map((m) => m.count)}
        labels={r.byMonth.map((m) => mLabel(m.month))}
        months={r.byMonth.map((m) => m.month)}
        tip={(i) => (
          <>
            <b>{monthLabel(r.byMonth[i].month)}</b> <span className="copy-gap" aria-hidden="true" /> {t('report.year.count', { count: r.byMonth[i].count })}
          </>
        )}
      />
    </div>
  );
}

/** 时长：满一年写几年几个月，不足一个月写天数；与详情页同一写法 */
function span(days: number) {
  const n = days < 30 ? 0 : Math.round(days / DAYS_PER_MONTH);
  const years = Math.floor(n / 12);
  const months = n % 12;
  if (years) return months ? t('detail.stats.yearsMonths', { years, months }) : t('detail.stats.years', { count: years });
  return months ? t('detail.stats.months', { count: months }) : t('detail.stats.days', { count: Math.round(days) });
}

/** 月度变动瀑布：上月末 → 新增 → 涨价 → 降价 → 退订 → 本月 */
function Waterfall({ state, today, year, onOpen }: { state: AppState; today: string; year: number; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  // 只在所选年份内翻月：今年从本月起，往年从 12 月起
  const min = (year - Number(today.slice(0, 4))) * 12 - (Number(today.slice(5, 7)) - 1);
  const max = Math.min(0, min + 11);
  const [offset, setOffset] = useState(max);
  const month = addMonths(today.slice(0, 8) + '01', offset).slice(0, 7);
  const end = offset === 0 ? today : monthEnd(month);
  const mv = useMemo(() => monthMovement(state, end, offset !== 0), [state, month, end, offset]);
  const steps = [
    { k: t('report.wf.from'), v: mv.from, kind: 'total' },
    { k: t('report.wf.added'), v: mv.added, kind: 'up' },
    { k: t('report.wf.expansion'), v: mv.expansion, kind: 'up' },
    { k: t('report.wf.contraction'), v: -mv.contraction, kind: 'down' },
    { k: t('report.wf.churned'), v: -mv.churned, kind: 'down' },
    { k: t('report.wf.fx'), v: mv.fx, kind: mv.fx >= 0 ? 'up' : 'down' },
    { k: offset === 0 ? t('report.wf.now') : t('report.wf.monthEnd'), v: mv.to, kind: 'total' },
  ];
  // 不画瀑布：总额两千多、变化几十上百，放在一根轴上变化量只剩几条细线。
  // 改成「一句结论 + 变化来源清单」，清单的横条只在各项之间比大小
  const drivers = steps.filter((x) => x.kind !== 'total' && Math.abs(x.v) >= 0.5);
  const peak = Math.max(1, ...drivers.map((x) => Math.abs(x.v)));
  const delta = mv.to - mv.from;
  const singleDriver = drivers.length === 1 && Math.abs(drivers[0].v - delta) < 0.005;
  const singleItem = Math.abs(delta) >= 0.5 && mv.items.length === 1 && Math.abs(mv.items[0].delta - delta) < 0.005;
  const pct = mv.from > 0 ? delta / mv.from : 0;
  const kindLabel = (k: 'added' | 'expansion' | 'contraction' | 'churned') => t(`report.wf.${k}`);
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle>{t('report.wf.title', { n: Number(month.slice(5)), month: monthLabel(month, { year: false, long: true }) })}</CardTitle>
        <div className="row copy-controls" style={{ gap: 4 }}>
          <CopyImageButton hover />
          <IconButton aria-label={t('report.wf.prev')} disabled={offset <= min} onClick={() => setOffset(offset - 1)}>
            <Icon name="left" />
          </IconButton>
          <IconButton
            aria-label={t('report.wf.next')}
            disabled={offset >= max}

            onClick={() => setOffset(offset + 1)}
          >
            <Icon name="right" />
          </IconButton>
        </div>
      </div>
      <MetricCards inline>
        {offset !== 0 && (
          <Metric
            label={offset === 0 ? t('report.wf.now') : t('report.wf.monthEnd')}
            value={perMonth(formatTotal(mv.partial.to, base, { direction: -1, compact: true }))}
          />
        )}
        <Metric
          label={t('report.wf.vsFrom', { amount: formatTotal(mv.partial.from, base, { direction: -1, compact: true }) })}
          value={Math.abs(delta) < 0.5 ? t('report.wf.flat') : <SpendingDelta value={{ amount: delta, percent: mv.from > 0 ? pct : undefined }} base={base} />}
          valueClassName={Math.abs(delta) < 0.5 ? '' : delta > 0 ? 'loss' : 'gain'}
        />
      </MetricCards>
      {drivers.length > 0 && !singleDriver && (
        <div className="mv-rows">
          {drivers.map((x) => (
            <div key={x.k} className="mv-row">
              <span>{x.k}</span>
              <div className="mv-bar">
                <i style={{ width: `${(Math.abs(x.v) / peak) * 100}%` }} />
              </div>
              <b className="num">
                {x.v > 0 ? '↑' : '↓'} {money(Math.abs(x.v), base, { compact: true })}
              </b>
            </div>
          ))}
        </div>
      )}
      <div className="wf-items">
        {mv.items.length === 0 && (
          <div className="muted" style={{ fontSize: 'var(--fs-2)', padding: '8px 0' }}>
            {Math.abs(mv.fx) >= 0.5
              ? t('report.wf.emptyFx', { amount: `${mv.fx > 0 ? '↑' : '↓'} ${money(Math.abs(mv.fx), base, { compact: true })}` })
              : t('report.wf.empty')}
          </div>
        )}
        {mv.items.slice(0, 4).map((it) => (
          <button key={it.sub.id} className="wf-item" data-snapshot-keep onClick={() => onOpen(it.sub)}>
            <SubIcon sub={it.sub} size={24} />
            <span className="wf-name">{it.sub.name}</span>
            <em>{kindLabel(it.kind)}</em>
            {!singleItem && (
              // 新增、停用是生命周期事件，只写月额不带涨跌箭头；升降级才有方向
              <b className="num">
                {it.kind === 'expansion' ? '↑ ' : it.kind === 'contraction' ? '↓ ' : ''}
                {money(Math.abs(it.delta), base, { compact: true })}
              </b>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 体检：规则驱动的提醒与洞察 */
function Checkup({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const list = useMemo(() => insights(state, today).filter((i) => i.id !== 'unused'), [state, today]);
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 5);
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle>{t('report.checkup.title')}</CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
          <span className="meta">{t('report.checkup.warn', { count: list.filter((i) => i.tone === 'warn').length })}</span>
        </div>
      </div>
      <div className="insights" data-snapshot-list data-snapshot-total={list.length}>
        {shown.map((i) => (
          <div key={i.id} className={`insight ${i.tone}`}>
            <i className="dot" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ins-t">{i.title}</div>
              <div className="ins-b">{i.body}</div>
              {!!(i.subs?.length || i.methods?.length) && (
                <div className="ins-subs">
                  {i.methods?.map((m) => (
                    <a className="icon-btn sub-shortcut" data-snapshot-keep key={m.id} href={appPath('/wallet')} title={m.name} aria-label={m.name}>
                      <MethodMark m={m} size={22} />
                    </a>
                  ))}
                  {(i.subs ?? []).slice(0, 6).map((s) => (
                    <IconButton className="sub-shortcut" data-snapshot-keep key={s.id} onClick={() => onOpen(s)} title={s.name} aria-label={s.name}>
                      <SubIcon sub={s} size={22} />
                    </IconButton>
                  ))}
                </div>
              )}
            </div>
            {i.href && (
              <a className="btn plain" href={i.href}>
                {t('report.checkup.fix')}
              </a>
            )}
          </div>
        ))}
      </div>
      {list.length > 5 && (
        <button className="btn plain" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
          {all ? t('report.checkup.less') : t('report.checkup.more', { count: list.length - 5 })}
        </button>
      )}
    </div>
  );
}

/** 所选年份较上一年的变化来源，以及当年合租、代付盈亏 */
function YearCard({ state, today, year, onOpen }: { state: AppState; today: string; year: number; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const r = useMemo(() => yearOutlook(state, today, year), [state, today, year]);
  const same = r.samePeriod;
  const change = same.change;
  const ok = !!change && Number.isFinite(change.amount);
  const kindLabel = (k: YearDriver['kind']) => t(`report.year.${k}`);
  const short = (v: number) => money(v, base, { compact: true });
  const arrow = (v: number) => (!Number.isFinite(v) ? '—' : `${v > 0.005 ? '↑' : v < -0.005 ? '↓' : ''} ${short(Math.abs(v))}`.trim());
  // 较去年同期的变化来源按类型汇总：新增、停用、多付、少付，各写差额合计与项数；今年合计与同期差额在顶部大数字区
  const groups = (['added', 'stopped', 'up', 'down'] as const).map((kind) => {
    const items = r.drivers.filter((d) => d.kind === kind);
    return { kind, items, delta: items.reduce((n, d) => n + d.delta, 0) };
  });
  const used = groups.filter((g) => g.items.length > 0);
  const solo = used.length === 1 && !!change && Math.abs(used[0].delta - change.amount) < 0.5;
  // 第二排后两格是动态的：有合租时倒数第二格换成今年的合租盈亏，有代付时最后一格换成今年的代付盈亏；没有就仍是多付、少付
  const car = useMemo(() => carpoolYear(state, today, String(year)), [state, today, year]);
  const px = useMemo(() => proxyYear(state, today, String(year)), [state, today, year]);
  const extras = [
    car.subs.length > 0 && {
      key: 'carpool' as const,
      total: car.partial.net,
      net: car.net,
      subs: car.subs,
      lead: t('report.year.count', { count: car.subs.length }),
    },
    px.subs.length > 0 && {
      key: 'proxy' as const,
      total: px.partial.diff,
      net: px.diff,
      subs: px.subs,
      lead: px.open.length
        ? t('family.pool.owedAmount', { amount: formatTotal(px.partial.owed, base, { compact: true }) })
        : t('report.year.count', { count: px.subs.length }),
    },
  ];
  // 始终四格：比不出差额时变化来源各格写「—」，合租、代付照常显示；都没有就整张卡不出
  const slots = (ok && used.length > 0) || extras.some(Boolean) ? [groups[0], groups[1], extras[0] || groups[2], extras[1] || groups[3]] : [];
  const subsNote = (lead: string | false, subs: Subscription[]) => (
    // 项数在前，后面跟最多 3 个订阅图标，点开详情；一行放不下时截掉图标，不换行
    <div className="ins-subs" style={{ flexWrap: 'nowrap', alignItems: 'center', overflow: 'hidden' }} data-snapshot-list>
      {lead && <small style={{ marginRight: 2, whiteSpace: 'nowrap' }}>{lead}</small>}
      {subs.slice(0, 3).map((s) => (
        <button type="button" data-snapshot-keep key={s.id} onClick={() => onOpen(s)} title={s.name} aria-label={s.name}>
          <SubIcon sub={s} size={18} />
        </button>
      ))}
    </div>
  );
  if (!slots.length) return null;
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={t('report.year.basis')}>
          {t('report.year.title')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <MetricCards inline>
        {slots.map((g) =>
          'kind' in g ? (
            <Metric
              key={g.kind}
              label={kindLabel(g.kind)}
              // 只有一类且就是全部差额时，金额与上方「较去年同期」重复，改写项数
              value={!ok || !g.items.length ? '—' : solo ? t('report.year.count', { count: g.items.length }) : arrow(g.delta)}
              note={
                ok &&
                g.items.length > 0 &&
                subsNote(
                  !solo && t('report.year.count', { count: g.items.length }),
                  g.items.map((d) => d.sub),
                )
              }
            />
          ) : (
            // 赚了写盈利、亏了写亏损，金额带正负号；缺汇率时只写盈亏
            <Metric
              key={g.key}
              label={t(`report.year.${g.key}${g.total.incomplete ? 'Net' : Math.abs(g.net) < 0.5 ? 'Even' : g.net > 0 ? 'Gain' : 'Loss'}`)}
              value={formatTotal(g.total, base, { direction: 1, compact: true })}
              valueClassName={g.total.incomplete || Math.abs(g.net) < 0.5 ? '' : g.net > 0 ? 'gain' : 'loss'}
              note={totalNote(g.total) || subsNote(g.lead, g.subs)}
            />
          ),
        )}
      </MetricCards>
      {ok && used.length === 0 && (
        <div className="muted" style={{ fontSize: 'var(--fs-2)', paddingTop: 12 }}>
          {t('report.year.empty')}
        </div>
      )}
    </div>
  );
}

const ownState = (state: AppState): AppState => ({ ...state, subscriptions: state.subscriptions.filter((s) => !s.proxy) });

/** 现金 vs 权责：所选年份 1–12 月；全部（year 为 null）按年合并，从第一年到本月。预付余值与未来 90 天只在今年出现 */
function CashCard({ state, today, year }: { state: AppState; today: string; year: number | null }) {
  const base = state.settings.baseCurrency;
  const cur = Number(today.slice(0, 4));
  const now = year === cur;
  const from = year ?? Math.min(cur, Number(firstStart(ownState(state), today).slice(0, 4)));
  // 相对今天所在月：往回到起始年 1 月，往后到所选年（全部为今年）12 月；往年 fwd 为负
  const back = (cur - from) * 12 + Number(today.slice(5, 7)) - 1;
  // 全部只到本月，与头部「到今天为止」同一口径
  const fwd = year === null ? 0 : (year - from) * 12 + 11 - back;
  const rows = useMemo(() => {
    const list = cashVsAccrual(state, today, back, fwd);
    if (year !== null) return list;
    // 按年合并；现金取累计口径（到今天为止、含转让），与头部最高年等数字一致
    const paid = new Map(allOutlook(state, today).years.map((y) => [y.year, y]));
    const years = [...new Set(list.map((r) => r.month.slice(0, 4)))];
    return years.map((y) => {
      const xs = list.filter((r) => r.month.startsWith(y));
      const p = paid.get(y);
      return {
        month: y,
        cash: p?.total ?? 0,
        accrual: xs.reduce((a, r) => a + r.accrual, 0),
        partial: { cash: p?.partial.total ?? emptyTotal(), accrual: sumTotals(xs.map((r) => r.partial.accrual)) },
        projected: xs.some((r) => r.projected),
      };
    });
  }, [state, today, back, fwd, year]);
  const pv = useMemo(() => prepaidValue(state, today), [state, today]);
  const next90 = chargesTotal(state, allCharges(state, addDays(today, 1), addDays(today, 90), today));
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={t('scope.cashBasis')}>
          {t('report.cash.title')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
          <div className="legend-inline">
            <span>
              <i style={{ background: 'var(--chart-ink-2)' }} />
              {t('report.cash.legendCash')}
            </span>
            <span>
              <i style={{ background: 'var(--chart-ink)', height: 3 }} />
              {t('report.cash.legendAccrual')}
            </span>
          </div>
        </div>
      </div>
      <div className="cash-grid">
        <BarLine
          bars={rows.map((r) => r.partial.cash.value)}
          // 缺汇率的柱子只有部分金额，不标数字，完整金额看浮窗
          fmt={(v, i) => (rows[i].partial.cash.incomplete ? '' : moneyTick(v, base))}
          // 点柱子去日历看这个月（全部模式是这一年）有哪几笔
          onPick={(i) => go(year === null ? `calendar?year=${rows[i].month}` : `calendar?month=${rows[i].month}`)}
          line={rows.map((r) => r.partial.accrual.value)}
          future={rows.map((r) => r.projected)}
          labels={rows.map((r) => (year === null ? r.month : mLabel(r.month)))}
          months={year === null ? undefined : rows.map((r) => r.month)}
          tip={(i) => (
            <>
              <b>{year === null ? t('report.pick.year', { year: rows[i].month }) : rows[i].month}</b>
              {copyParts(rows[i].projected ? t('report.cash.forecast') : '')}
              <br />
              {copyParts(
                t('report.cash.tip', {
                  cash: formatTotal(rows[i].partial.cash, base, { direction: -1, compact: true }),
                  cost: formatTotal(rows[i].partial.accrual, base, { direction: -1, compact: true }),
                }),
              )}
              {copyParts(t(year === null ? 'report.cash.openYear' : 'report.cash.open'))}
            </>
          )}
        />
        {now && (
          <MetricCards inline>
            <Metric
              {...tipProps(() =>
                pv.items
                  .slice(0, 6)
                  .map((x) => (
                    <div key={x.sub.id}>
                      {copyParts(t('report.cash.prepaidItem', { name: x.sub.name, amount: formatTotal(x.partial, base, { compact: true }), until: x.until }))}
                    </div>
                  )),
              )}
              label={t('report.cash.prepaid')}
              value={<FxAmount plain total={pv.partial} ccy={base} compact />}
              note={<small>{totalNote(pv.partial) || t('report.cash.prepaidSub', { count: pv.items.length })}</small>}
            />
            <Metric
              label={t('report.cash.next90')}
              value={<FxAmount total={next90} direction={-1} ccy={base} compact />}
              note={<small>{totalNote(next90) || t('report.cash.fullPaidHint')}</small>}
            />
          </MetricCards>
        )}
      </div>
    </div>
  );
}

/** 所选年份内（或全部）停止的订阅与未退款损失。明细先放 5 条，其余折叠 */
function StopsCard({ state, today, year, onOpen }: { state: AppState; today: string; year: number | null; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  // 全部（null）：不限时间
  const range = useMemo(() => (year === null ? undefined : { from: `${year}-01-01`, to: `${year}-12-31` }), [year]);
  const losses = useMemo(() => stopLosses(state, today, range), [state, today, range]);
  const stops = useMemo(() => stopHistory(state, today, range), [state, today, range]);
  const count = (kind: 'cancel' | 'terminate') => stops.filter((i) => i.kind === kind).length;
  const [all, setAll] = useState(false);
  const shown = all ? losses.items : losses.items.slice(0, 5);
  return (
    <div className="card stop-report copy-card" data-copy-card id="report-stops">
      <div className="copy-corner">
        <CopyImageButton hover />
      </div>
      <div className="card-h">
        {/* 口径说明收进 ⓘ，卡片里只留数字和明细 */}
        <CardTitle hint={t(year === null ? 'report.stops.basisAll' : 'report.stops.basis')}>{t('report.stops.title')}</CardTitle>
      </div>
      <MetricCards inline>
        <Metric
          label={t('report.stops.loss')}
          value={<FxAmount total={losses.partial} ccy={base} direction={-1} compact />}
          // 没有损失时 ¥0 不标红
          valueClassName={losses.total > 0 || !Number.isFinite(losses.total) ? 'loss' : ''}
          note={losses.items.length > 0 && t('report.year.count', { count: losses.items.length })}
        />
        {count('cancel') > 0 && <Metric label={t('report.stops.cancel')} value={count('cancel')} />}
        {count('terminate') > 0 && <Metric label={t('core.stop.terminate')} value={count('terminate')} />}
      </MetricCards>
      {losses.incomplete && <p className="stop-basis red">{totalNote(losses.partial)}</p>}
      {/* 没有未退款损失时，上面的指标已写 ¥0，不再放一个空的明细区块 */}
      {losses.items.length > 0 && (
        <>
          {/* 宽卡片分两列，先排满左列再排右列 */}
          <div
            className="stop-list"
            style={{ gridTemplateRows: `repeat(${Math.ceil(shown.length / 2)}, auto)` }}
            data-snapshot-list
            data-snapshot-total={losses.items.length}
          >
            {shown.map((i) => (
              <button key={`${i.sub.id}-${i.phaseIndex}`} className="stop-row" data-snapshot-keep onClick={() => onOpen(i.sub)}>
                <span className="stop-name">
                  <SubIcon sub={i.sub} size={24} />
                  <b>{i.sub.name}</b>
                </span>
                <span className="stop-meta">
                  <span>{cnDate(i.date)}</span> <span>{i.kind === 'terminate' ? t('core.stop.terminate') : t('report.stops.cancel')}</span>{' '}
                  <span style={i.refunded > 0 ? { color: 'var(--green)' } : undefined}>
                    {i.refundStatus === 'none' ? t('core.stop.refundNo') : t('core.stop.partial', { money: flow(i.refunded, i.currency) })}
                  </span>{' '}
                  <span className="stop-days">
                    {/* 条长是这笔付款里没用上又没退回的比例 */}
                    <i className="stop-bar" aria-hidden="true">
                      <i style={{ width: `${Math.round(Math.min(1, Math.max(0, i.paidBase > 0 ? i.lossBase / i.paidBase : 0)) * 100)}%` }} />
                    </i>
                    {t('core.stop.lossDays', { count: i.wastedDays })}
                  </span>
                </span>
                <span className="stop-amount">
                  <b className="red">{flow(-i.lossBase, base)}</b>
                  {i.currency !== base && <small>{flow(-i.loss, i.currency)}</small>}
                </span>
              </button>
            ))}
          </div>
          {losses.items.length > 5 && (
            <button className="btn plain" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
              {all ? t('report.checkup.less') : t('report.checkup.more', { count: losses.items.length - 5 })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 礼品卡 / 话费充值计划 */
function TopUps({ state, today }: { state: AppState; today: string }) {
  const [months, setMonths] = useState<'3' | '6' | '12'>('6');
  const plan = useMemo(() => topUpPlan(state, today, Number(months)), [state, today, months]);
  const span = t(`report.topup.span${months}`);
  const base = state.settings.baseCurrency;
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle>{t('report.topup.title')}</CardTitle>
        <div className="copy-controls">
          <CopyImageButton hover />
          <Seg
            small
            value={months}
            onChange={setMonths}
            options={[
              ['3', t('report.topup.range3')],
              ['6', t('report.topup.range6')],
              ['12', t('report.topup.range12')],
            ]}
          />{' '}
        </div>
      </div>
      {plan.length === 0 && (
        <div className="empty">
          {t('report.topup.empty')}
          <br />
          <a className="btn plain" href={appPath('/wallet')}>
            {t('report.topup.emptyCta')}
          </a>
        </div>
      )}
      {plan.map((p) => (
        <div key={p.method.id} className="topup">
          <MethodMark m={p.method} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{p.method.name}</div>
            <div className="muted" style={{ fontSize: 'var(--fs-1)' }}>
              {copyParts(
                t('report.topup.summary', {
                  balance: formatTotal(p.partial.current, p.method.currency, { compact: true }),
                  monthly: formatTotal(p.partial.monthly, p.method.currency, { direction: -1, compact: true }),
                }),
              )}
            </div>
            {p.incomplete ? (
              <div className="topup-why soft">{totalNote(p.partial.need)}</div>
            ) : p.need > 0 ? (
              <>
                <div className="topup-why">
                  {t('report.topup.why', {
                    span,
                    due: flow(-p.due, p.method.currency, { compact: true }),
                    balance: formatTotal(p.partial.current, p.method.currency, { compact: true }),
                    need: money(p.need, p.method.currency, { compact: true }),
                  })}
                  {p.deadline && p.minNeed > 0 && p.minNeed < p.need - 0.01 && (
                    <>{tx('report.topup.urgent', { date: cnDate(p.deadline), min: <b>{money(p.minNeed, p.method.currency, { compact: true })}</b> })}</>
                  )}
                </div>
                {p.cards.length > 0 ? (
                  <div className="cards-row">
                    <small>{t('report.topup.cards')}</small>
                    {/* 同面额合并成「×N」，不再一张张平铺 */}
                    {[...p.cards.reduce((m2, c) => m2.set(c, (m2.get(c) ?? 0) + 1), new Map<number, number>())]
                      .sort((x, y) => y[0] - x[0])
                      .map(([c, n]) => (
                        <span key={c} className="gift">
                          {money(c, p.method.currency, { compact: true })}
                          {n > 1 && <em>×{n}</em>}
                        </span>
                      ))}
                  </div>
                ) : (
                  <div className="topup-why soft">{t('report.topup.anyAmount')}</div>
                )}
              </>
            ) : !Number.isFinite(p.need) ? (
              // 缺汇率算不出要充多少：不能说「够用」
              <div className="topup-why soft">{t('core.fxIncomplete')}</div>
            ) : (
              <div className="green" style={{ fontSize: 'var(--fs-2)', marginTop: 6 }}>
                {t(`report.topup.enough${months}`)}
              </div>
            )}
          </div>
          {(p.need > 0 || p.incomplete) && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>
                <FxAmount plain total={p.partial.need} ccy={p.method.currency} compact />
              </div>
              <div className="muted" style={{ fontSize: 'var(--fs-1)' }}>
                {!p.incomplete && <>≈ {money(toBase(state, p.need, p.method.currency), base, { compact: true })}</>}
              </div>
              {p.deadline && (
                <div className={diffDays(today, p.deadline) <= 7 ? 'red' : 'muted'} style={{ fontSize: 'var(--fs-1)', fontWeight: 600 }}>
                  {t('report.topup.by', { date: cnDate(p.deadline) })}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 事件类型 → [文案键, 色调]。开始、停止、暂停只说明用或不用，不分好坏，一律中性；同一订阅变贵变便宜才标涨跌 */
const EV: Record<EventKind, [string, string]> = {
  start: ['start', 'neutral'],
  end: ['end', 'neutral'],
  terminate: ['terminate', 'neutral'],
  price: ['price', 'up'],
  'intro-end': ['introEnd', 'up'],
  buy: ['buy', 'buy'],
  pause: ['pause', 'neutral'],
  switch: ['switch', 'up'],
  resume: ['resume', 'neutral'],
};

/** 变更日志 */
function Changelog({ state, today, year, onOpen, base }: { state: AppState; today: string; year: number; onOpen: (s: Subscription) => void; base: string }) {
  const list = useMemo(() => events(state, today).filter((e) => e.date.startsWith(`${year}-`)), [state, today, year]);
  const [fit, setFit] = useState<number | null>(null);
  const [extra, setExtra] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const n = (fit ?? 8) + extra;
  // 右卡不撑高桌面网格；按左卡留下的空间显示完整条目，包含跨年的标题。
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const desktop = matchMedia('(min-width: 681px)');
    const measure = () => {
      if (!desktop.matches) {
        setFit(null);
        return;
      }
      if (extra > 0) return;
      const row = el.querySelector<HTMLElement>('.log-item');
      const year = el.querySelector<HTMLElement>('.log-year');
      if (!row || !year) return;
      const rowHeight = row.getBoundingClientRect().height;
      const yearHeight = year.getBoundingClientRect().height;
      const available = el.getBoundingClientRect().height;
      let height = 0;
      let count = 0;
      let last = '';
      for (const event of list) {
        const yr = event.date.slice(0, 4);
        const next = height + rowHeight + (yr !== last ? yearHeight : 0);
        if (next > available) break;
        height = next;
        last = yr;
        count++;
      }
      setFit(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const row = el.querySelector('.log-item');
    const year = el.querySelector('.log-year');
    if (row) observer.observe(row);
    if (year) observer.observe(year);
    desktop.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      desktop.removeEventListener('change', measure);
    };
  }, [list, extra]);
  return (
    <div className={`card report-log copy-card ${extra > 0 ? 'expanded' : ''}`} data-copy-card>
      <div className="card-h">
        <CardTitle>{t('report.log.title')}</CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
          <span className="meta">{t('report.log.decisions', { count: list.length })}</span>
        </div>
      </div>
      <div className="log" ref={log} data-snapshot-list=".log-item" data-snapshot-total={list.length}>
        {list.slice(0, n).map((e, i) => {
          const yr = e.date.slice(0, 4);
          const showYear = i === 0 || list[i - 1].date.slice(0, 4) !== yr;
          const [labelKey, tone] = EV[e.kind];
          const label = e.kind === 'terminate' ? t('core.stop.terminate') : t(`report.ev.${labelKey}`);
          const up = e.delta > 0;
          const neutral = tone === 'neutral';
          return (
            <Fragment key={e.sub.id + e.kind + e.date + i}>
              {showYear && <div className="log-year">{yr}</div>}
              <button className="log-item" data-snapshot-keep onClick={() => onOpen(e.sub)}>
                <span className="log-date num">{e.date.slice(5).replace('-', '/')}</span>
                <i className={`log-dot ${neutral ? '' : up ? 'up' : 'down'}`} />
                <SubIcon sub={e.sub} size={24} />
                <span className="log-name">
                  {e.sub.name}
                  <small>
                    {label}
                    {e.note ? ` ${e.note}` : ''}
                  </small>
                </span>
                <b className={`num ${tone === 'buy' || neutral ? '' : up ? 'red' : 'green'}`}>
                  {copyParts(
                    tone === 'buy'
                      ? e.partial
                        ? formatTotal(e.partial, base, { compact: true })
                        : money(e.delta, base, { compact: true })
                      : perMonth(
                          Number.isFinite(e.delta)
                            ? `${neutral ? '' : e.delta > 0 ? '↑ ' : e.delta < 0 ? '↓ ' : ''}${money(Math.abs(e.delta), base, { compact: true })}`
                            : e.partial
                              ? formatTotal(e.partial, base, { compact: true })
                              : '—',
                        ),
                  )}
                </b>
              </button>
            </Fragment>
          );
        })}
      </div>
      <div className="log-actions">
        {list.length > n && (
          <button className="btn plain" onClick={() => setExtra(extra + 12)}>
            {t('report.log.more')}
          </button>
        )}
      </div>
    </div>
  );
}

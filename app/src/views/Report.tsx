import { Composition } from '../components/Composition.tsx';
import { chargesTotal, formatTotal, scaleTotal, totalNote } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { DAYS_PER_MONTH } from '../../../shared/billing.ts';
import { CopyImageButton } from '../components/CopyImageButton.tsx';
import { snapshotCard } from '../snapshot.ts';
import { copyParts } from '../components/copy.tsx';
import { base as appPath } from '../base.ts';
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMonths, diffDays, totals } from '../../../shared/billing.ts';
import { flow, cnDate, money, monthLabel } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { tx } from '../i18n.ts';
import {
  cashVsAccrual,
  chartMonths,
  events,
  insights,
  monthEnd,
  monthMovement,
  mrrSeries,
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
import { yearOutlook, type Comparison, type YearDriver } from '../../../shared/scope-report.ts';
import './year-card.css';

const mLabel = (m: string) => (m.endsWith('-01') ? t('report.axis.year', { yy: m.slice(2, 4), year: m.slice(0, 4) }) : monthLabel(m, { year: false }));
const perMonth = (amount: string) => t('report.perMonth', { amount });

export function Report({ state, today, onOpen, onReview }: { state: AppState; today: string; onOpen: (s: Subscription) => void; onReview: () => void }) {
  const base = state.settings.baseCurrency;
  const y = Number(today.slice(0, 4));
  const pageRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <Toolbar title={t('report.title')}>
        {/* 鼠标移到分享上才出现：复制整份报告为一张图（卡片上的复制只取那一张）；「分享年度回顾」是另做的个性化回顾 */}
        <span className="report-share">
          <CopyImageButton render={() => snapshotCard(pageRef.current!)} />
          <button className="btn" onClick={onReview}>
            <Icon name="share" /> {t('report.shareReview', { year: y })}
          </button>
        </span>
      </Toolbar>
      <div className="page fade-in stack" ref={pageRef}>
        <Hero state={state} today={today} />
        <YearCard state={state} today={today} onOpen={onOpen} />
        {/* 先看钱的全貌（现金与真实成本、钱花在哪），再看本月变动与体检 */}
        <CashCard state={state} today={today} />
        <Composition state={state} today={today} onOpen={onOpen} />
        <div className="grid g-2">
          <Waterfall state={state} today={today} onOpen={onOpen} />
          <Checkup state={state} today={today} onOpen={onOpen} />
        </div>
        <StopsCard state={state} today={today} onOpen={onOpen} />
        <div className="grid g-2 report-bottom">
          <TopUps state={state} today={today} />
          <Changelog state={state} today={today} onOpen={onOpen} base={base} />
        </div>
      </div>
    </>
  );
}

/** 头部：负 MRR + 历史走势 */
function Hero({ state, today }: { state: AppState; today: string }) {
  const base = state.settings.baseCurrency;
  const [hist, setHist] = useState(true);
  // 固定看最近 12 个月，多取一个点让起点正好是「一年前」；账本更短时从第一笔数据开始
  const months = chartMonths(firstStart(state, today), today, 13);
  const series = useMemo(() => mrrSeries(state, today, months, hist), [state, today, months, hist]);
  const tot = totals(state, today);
  const current = series[series.length - 1].partial;
  const yearAgo = series.length > 12 ? series[series.length - 13].mrr : undefined;
  const evDates = new Set(
    events(state, today)
      .filter((e) => e.kind !== 'buy')
      .map((e) => e.date.slice(0, 7)),
  );
  const markers = series.map((p, i) => (evDates.has(p.month) ? i : -1)).filter((i) => i >= 0);
  /** 带正负号的金额：支出为负、收入为正 */
  const signed = (v: number, compact = true) => flow(v, base, { compact });
  return (
    <div className="card hero-card copy-card" data-copy-card>
      <div className="hero-l">
        <CardTitle as="div" className="stat-label" hint={t('scope.mrrBasis')}>
          {t('report.hero.label')}
        </CardTitle>
        <div className="hero-num">
          <FxAmount total={current} ccy={base} direction={-1} />
        </div>
        <div className="hero-delta">
          {yearAgo != null && yearAgo > 0 && <span className="muted">{copyParts(t('report.hero.yearAgo', { amount: signed(-yearAgo) }))}</span>}
        </div>
        <MetricCards plain>
          <Metric label={t('report.hero.annual')} value={formatTotal(scaleTotal(current, 12), base, { direction: -1, compact: true, main: true })} />
          <Metric
            label={t('report.hero.perDay')}
            value={formatTotal(scaleTotal(current, 1 / DAYS_PER_MONTH), base, { direction: -1, main: true, average: true })}
          />
          <Metric label={t('report.hero.active')} value={tot.activeCount} note={totalNote(current) || undefined} />
          {(tot.recoverMrr > 1 || tot.partial.recover.incomplete) && (
            <Metric
              label={t('report.hero.recover')}
              value={formatTotal(tot.partial.recover, base, { direction: 1, compact: true, main: true })}
              valueClassName="gain"
            />
          )}
        </MetricCards>
      </div>
      <div className="hero-r">
        <div className="row copy-controls" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
          <CopyImageButton hover />
          <Seg
            small
            value={hist ? 'h' : 'c'}
            onChange={(v) => setHist(v === 'h')}
            options={[
              ['h', t('report.hero.fxHist')],
              ['c', t('report.hero.fxNow')],
            ]}
          />
        </div>
        <AreaChart
          values={series.map((p) => p.partial.value)}
          labels={series.map((p) => mLabel(p.month))}
          months={series.map((p) => p.month)}
          markers={markers}
          tip={(i) => (
            <>
              <b>{series[i].month}</b> <span className="copy-gap" aria-hidden="true" />{' '}
              {perMonth(formatTotal(series[i].partial, base, { direction: -1, compact: true }))}
            </>
          )}
        />
      </div>
    </div>
  );
}

/** 月度变动瀑布：上月末 → 新增 → 涨价 → 降价 → 退订 → 本月 */
function Waterfall({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const [offset, setOffset] = useState(0);
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
          <IconButton aria-label={t('report.wf.prev')} onClick={() => setOffset(offset - 1)}>
            <Icon name="left" />
          </IconButton>
          <IconButton
            aria-label={t('report.wf.next')}
            disabled={offset >= 0}

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

/** 现金 vs 权责 + 预付余值 */
/** 本年净现金：已付加预计，同期比较与变化来源，下月与明年预计 */
function YearCard({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const r = useMemo(() => yearOutlook(state, today), [state, today]);
  const same = r.samePeriod;
  const change = same.change;
  const ok = !!change && Number.isFinite(change.amount);
  const amount = (total: Parameters<typeof formatTotal>[0]) => formatTotal(total, base, { direction: -1, compact: true });
  const kindLabel = (k: YearDriver['kind']) => t(`report.year.${k}`);
  const short = (v: number) => money(v, base, { compact: true });
  const arrow = (v: number) => (!Number.isFinite(v) ? '—' : `${v > 0.005 ? '↑' : v < -0.005 ? '↓' : ''} ${short(Math.abs(v))}`.trim());
  const versus = (key: 'vsMonth' | 'vsYear', c?: Comparison) => c && <small>{t(`report.year.${key}`, { delta: arrow(c.amount) })}</small>;
  const shown = r.drivers.slice(0, 6);
  const peak = Math.max(1, ...shown.map((d) => Math.abs(d.delta)));
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={t('report.year.basis')}>
          {t('report.year.title', { year: r.year })}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <MetricCards inline>
        <Metric
          label={t('scope.yearTotal')}
          value={<FxAmount total={r.current.partial.total} ccy={base} direction={-1} compact />}
          note={<small>{totalNote(r.current.partial.total) || t('scope.paidAmount', { amount: amount(r.current.partial.paid) })}</small>}
        />
        {change && (
          <Metric
            label={t('report.year.vsLast')}
            value={<SpendingDelta value={change} base={base} compact />}
            valueClassName={!ok || Math.abs(change.amount) < 0.5 ? '' : change.amount > 0 ? 'loss' : 'gain'}
            note={<small>{t('report.year.lastAmount', { amount: amount(same.partial.previous) })}</small>}
          />
        )}
        <Metric
          label={t('report.year.nextMonth', { month: monthLabel(r.nextMonth.month, { year: false }) })}
          value={<FxAmount total={r.nextMonth.partial.total} ccy={base} direction={-1} compact />}
          note={totalNote(r.nextMonth.partial.total) || versus('vsMonth', r.nextMonth.change)}
        />
        <Metric
          label={t('report.year.nextYear', { year: r.nextYear.year })}
          value={<FxAmount total={r.nextYear.partial.total} ccy={base} direction={-1} compact />}
          note={totalNote(r.nextYear.partial.total) || versus('vsYear', r.nextYear.change)}
        />
      </MetricCards>
      {ok && (
        <div className="wf-items">
          <h4 className="stop-list-title" style={{ marginTop: 6 }}>
            {t('report.year.changes')}
          </h4>
          {r.drivers.length === 0 ? (
            <div className="muted" style={{ fontSize: 'var(--fs-2)', padding: '8px 0' }}>
              {t('report.year.empty')}
            </div>
          ) : (
            <div className="yr-drivers" data-snapshot-list>
              {shown.map((d) => (
                <button type="button" className="scope-row scope-tap yr-driver" data-snapshot-keep key={d.sub.id} onClick={() => onOpen(d.sub)}>
                  <span className="scope-sub">
                    <SubIcon sub={d.sub} size={24} />
                    <span>
                      <span className="scope-name">{d.sub.name}</span>
                      <small>
                        {kindLabel(d.kind)}
                        {/* 新增、停用的一端是 0，右侧差额已说明，不再写前后金额 */}
                        {(d.kind === 'up' || d.kind === 'down') && (
                          <>
                            {' '}
                            <span className="copy-gap" aria-hidden="true" />{' '}
                            <span className="num">{t('report.year.fromTo', { from: short(d.previous), to: short(d.current) })}</span>
                          </>
                        )}
                      </small>
                    </span>
                  </span>
                  {/* 只有一项时比例条恒满、差额与上方同期差额重复，都不画 */}
                  {shown.length > 1 ? (
                    <span className="mv-bar" aria-hidden="true">
                      <i style={{ width: `${(Math.abs(d.delta) / peak) * 100}%` }} />
                    </span>
                  ) : (
                    <span />
                  )}
                  <b className="num">{shown.length > 1 ? arrow(d.delta) : ''}</b>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CashCard({ state, today }: { state: AppState; today: string }) {
  const base = state.settings.baseCurrency;
  // 往回最多 2 年，但不早于账本第一笔数据所在月
  // 预测月数不超过已有的月数，账本短时不让未来的空柱占满整张图
  const back = chartMonths(firstStart(state, today), today, 24) - 1;
  const ahead = Math.min(12, Math.max(3, back + 1));
  const rows = useMemo(() => cashVsAccrual(state, today, back, ahead), [state, today, back, ahead]);
  const pv = useMemo(() => prepaidValue(state, today), [state, today]);
  const next90 = chargesTotal(state, allCharges(state, addDays(today, 1), addDays(today, 90), today));
  const peak = rows.filter((r) => r.projected).sort((a, b) => b.cash - a.cash)[0];
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
          line={rows.map((r) => r.partial.accrual.value)}
          future={rows.map((r) => r.projected)}
          labels={rows.map((r) => mLabel(r.month))}
          months={rows.map((r) => r.month)}
          tip={(i) => (
            <>
              <b>{rows[i].month}</b>
              {copyParts(rows[i].projected ? t('report.cash.forecast') : '')}
              <br />
              {copyParts(
                t('report.cash.tip', {
                  cash: formatTotal(rows[i].partial.cash, base, { direction: -1, compact: true }),
                  cost: formatTotal(rows[i].partial.accrual, base, { direction: -1, compact: true }),
                }),
              )}
            </>
          )}
        />
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
            note={
              <>
                <small>{totalNote(next90) || t('report.cash.fullPaidHint')}</small>
                <small>
                  {copyParts(
                    peak
                      ? t('report.cash.peak', {
                          n: Number(peak.month.slice(5)),
                          month: monthLabel(peak.month.slice(0, 7), { year: false }),
                          amount: formatTotal(peak.partial.cash, base, { direction: -1, compact: true }),
                        })
                      : '',
                  )}
                </small>
              </>
            }
          />
        </MetricCards>
      </div>
    </div>
  );
}

/** 未退款损失，截至今天、全部历史。明细先放 5 条，其余折叠 */
function StopsCard({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const losses = useMemo(() => stopLosses(state, today), [state, today]);
  const stops = useMemo(() => stopHistory(state, today), [state, today]);
  const count = (kind: 'cancel' | 'terminate') => stops.filter((i) => i.kind === kind).length;
  const [all, setAll] = useState(false);
  const shown = all ? losses.items : losses.items.slice(0, 5);
  return (
    <div className="card stop-report copy-card" data-copy-card id="report-stops">
      <div className="copy-corner">
        <CopyImageButton hover />
      </div>
      <div className="card-h">
        <CardTitle>{t('report.stops.title')}</CardTitle>
      </div>
      <p className="stop-basis">{copyParts(t('report.stops.basis'))}</p>
      <MetricCards inline>
        <Metric
          label={t('report.stops.loss')}
          value={<FxAmount total={losses.partial} ccy={base} direction={-1} compact />}
          // 没有损失时 ¥0 不标红
          valueClassName={losses.total > 0 || !Number.isFinite(losses.total) ? 'loss' : ''}
          note={t('report.stops.lossHint')}
        />
        {count('cancel') > 0 && <Metric label={t('report.stops.cancel')} value={count('cancel')} />}
        {count('terminate') > 0 && <Metric label={t('core.stop.terminate')} value={count('terminate')} />}
      </MetricCards>
      {losses.incomplete && <p className="stop-basis red">{totalNote(losses.partial)}</p>}
      {/* 没有未退款损失时，上面的指标已写 ¥0，不再放一个空的明细区块 */}
      {losses.items.length > 0 && (
        <>
          <h4 className="stop-list-title">{t('report.stops.details')}</h4>
          <div className="stop-list" data-snapshot-list data-snapshot-total={losses.items.length}>
            {shown.map((i) => (
              <button key={`${i.sub.id}-${i.phaseIndex}`} className="stop-row" data-snapshot-keep onClick={() => onOpen(i.sub)}>
                <SubIcon sub={i.sub} size={32} />
                <span className="stop-info">
                  <b>{i.sub.name}</b>
                  <small>
                    {cnDate(i.date)} <span className="copy-gap" aria-hidden="true" />{' '}
                    {i.kind === 'terminate' ? t('core.stop.terminate') : t('report.stops.cancel')}
                    {copyParts(i.reason ? `\n${i.reason}` : '')}
                  </small>
                  <small style={i.refunded > 0 ? { color: 'var(--green)' } : undefined}>
                    {i.refundStatus === 'none' ? t('core.stop.refundNo') : t('core.stop.partial', { money: flow(i.refunded, i.currency) })}
                  </small>
                </span>
                <span className="stop-amount">
                  <b className="red">
                    <span className="stop-days">
                      {t('core.stop.lossDays', { count: i.wastedDays })} <span className="copy-gap" aria-hidden="true" />{' '}
                    </span>
                    <span>{flow(-i.lossBase, base)}</span>
                  </b>
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
function Changelog({ state, today, onOpen, base }: { state: AppState; today: string; onOpen: (s: Subscription) => void; base: string }) {
  const list = useMemo(() => events(state, today), [state, today]);
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

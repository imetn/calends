import { chargesTotal, formatTotal, sumTotals, type FxTotal } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { canUseSingleKey } from '../keyboard.ts';
import { copyParts } from '../components/copy.tsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Maximize2 } from 'lucide-react';
import {
  addDays,
  addMonths,
  billingPeriod,
  diffDays,
  parseDay,
  cycleLabel,
  currentPhase,
  effectiveStatus,
  nextCharge,
  type Charge,
  chargeMethodId,
  isStopped,
} from '../../../shared/billing.ts';
import { flow, cnDate, cnDateAuto, monthLabel, relDays, weekdayShort } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { IconButton, MetricCards, Metric, CardTitle, Toolbar } from '../components/ui.tsx';
import { Seg, useWidth } from '../components/inputs.tsx';
import { Icon } from '../components/icons.tsx';
import { PayBadge, RegionTag, subRegion, SubIcon } from '../components/marks.tsx';
import { TipTable, tipProps } from '../components/overlays.tsx';
import { chargeBaseOrNaN } from '../../../shared/fx.ts';
import { allCharges } from '../derive.ts';
import { useMoneyPair } from '../components/MoneyPair.tsx';
import { usePref } from '../prefs.ts';
import { calendarJump } from './calendar-jump.ts';
import { monthReport } from '../../../shared/scope-report.ts';
import { ScopeReport, SpendingDelta } from '../components/ScopeReport.tsx';
import { StopText, stopDescription, stopLabel } from '../components/StopPanel.tsx';

/** 表头的星期简称，按周起始日排好 */
const dows = (weekStart: 0 | 1) => Array.from({ length: 7 }, (_, i) => weekdayShort((i + weekStart) % 7, true));

/** weekStart：周起始日，设置里选的，缺省周一 */
function monthGrid(month: string, weekStart: 0 | 1) {
  const first = month + '-01';
  const dow = (new Date(parseDay(first)).getUTCDay() + 7 - weekStart) % 7;
  const start = addDays(first, -dow);
  const last = addDays(addMonths(first, 1), -1);
  const cells = Math.ceil((dow + Number(last.slice(8))) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => addDays(start, i));
}

export function Calendar({ state, today, onOpen, onIcs }: { state: AppState; today: string; onOpen: (s: Subscription) => void; onIcs: () => void }) {
  // 大字 / 小字金额跟随显示货币设置
  const pair = useMoneyPair(state);
  const weekStart = state.settings.weekStart ?? 1;
  const DOW = dows(weekStart);
  // 从别处跳来时地址可带 ?month=YYYY-MM 或 ?year=YYYY（报告页点柱子），打开对应的月或年；读完即从地址去掉
  const [jump] = useState(() => calendarJump(location.search, today));
  const [month, setMonth] = useState(jump?.month ?? today.slice(0, 7));
  const [savedMode, setMode] = usePref<'month' | 'year'>('cal-mode', 'month', (v): v is 'month' | 'year' => v === 'month' || v === 'year');
  // 跳来的视图只管这一次，不改写记住的月／年偏好；手动切换后回到偏好
  const [jumpMode, setJumpMode] = useState(jump?.mode ?? null);
  const mode = jumpMode ?? savedMode;
  useLayoutEffect(() => {
    if (jump) history.replaceState(history.state, '', location.pathname);
  }, [jump]);
  // 月、年切换的「神奇移动」：当前月的月历与年视图里那一格共用 view-transition-name，浏览器在两者之间缩放过渡；
  // 不支持视图过渡或开了「减少动态效果」时直接切换
  const switchMode = (next: 'month' | 'year', pick?: string) => {
    const apply = () =>
      flushSync(() => {
        if (pick) goMonth(pick);
        setJumpMode(null);
        setMode(next);
      });
    if (next === mode && !pick) return;
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return apply();
    // 放大进月视图时，右侧列表与报告要等日历框放大后再淡入：用根元素上的类区分方向
    const root = document.documentElement;
    // vt-cal：侧栏与工具栏单独成层，过渡中不跟着整页淡出；vt-zoom-in：放大进月视图的节奏
    root.classList.add('vt-cal');
    root.classList.toggle('vt-zoom-in', next === 'month');
    const transition = document.startViewTransition(apply);
    void transition.finished.finally(() => root.classList.remove('vt-cal', 'vt-zoom-in'));
  };
  const [sel, setSel] = useState<string | null>(jump && !today.startsWith(jump.month) ? null : today);
  const [reportMode, setReportMode] = usePref<'mini' | 'full'>('cal-report-mode', 'mini', (v): v is 'mini' | 'full' => v === 'mini' || v === 'full');
  const report = useMemo(() => (mode === 'month' ? monthReport(state, month, today) : null), [state, month, today, mode]);
  const base = state.settings.baseCurrency;

  const year = month.slice(0, 4);
  const grid = monthGrid(month, weekStart);
  // 取整年与月网格的并集（网格会带出上下月的几天）
  const from = grid[0] < `${year}-01-01` ? grid[0] : `${year}-01-01`;
  const to = grid[grid.length - 1] > `${year}-12-31` ? grid[grid.length - 1] : `${year}-12-31`;
  const charges = allCharges(state, from, to, today).filter((c) => c.kind !== 'failed');
  // 图标只排一行、叠放约四成：按格子实际宽度算能放几个，放不下的换成「+N」，格子高度始终不变。
  // 悬停格子时依次轻浮一下，悬停某个图标时它浮到最上层；是哪几项看右侧当天列表
  const [gridRef, gridW] = useWidth();
  const narrow = gridW > 0 && gridW < 560;
  const icon = narrow ? 17 : 24;
  const step = Math.round(icon * 0.6);
  const inner = gridW / 7 - (narrow ? 6 : 14);
  const MORE_W = 20;
  const iconCap = gridW ? Math.max(2, Math.floor((inner - icon - MORE_W) / step) + 1) : 4;
  /** 不叠也放得下（间隔 3px）就平铺，放不下才叠 */
  const fits = (n: number) => icon * n + 3 * (n - 1) <= inner;
  const byDay = new Map<string, Charge[]>();
  for (const c of charges) byDay.set(c.date, [...(byDay.get(c.date) ?? []), c]);
  // 显示用合计：有一笔缺汇率就显示「—」，不按 0 算
  const sumOf = (list: Charge[] = []) => chargesTotal(state, list);
  const monthCharges = charges.filter((c) => c.date.startsWith(month));
  const yearCharges = charges.filter((c) => c.date.startsWith(year));
  // 翻月清空选择；今天按钮和 T 明确选中今天。
  const goMonth = (m: string) => {
    setMonth(m);
    setSel(null);
  };
  const goToday = () => {
    setMonth(today.slice(0, 7));
    setSel(today);
  };
  const shift = (n: number) => goMonth(addMonths(month + '-01', mode === 'year' ? n * 12 : n).slice(0, 7));
  // ← → 翻上/下一页（月视图翻月，年视图翻年），T 回到今天；输入框里、弹层打开时不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canUseSingleKey(e)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        goMonth(addMonths(month + '-01', (e.key === 'ArrowLeft' ? -1 : 1) * (mode === 'year' ? 12 : 1)).slice(0, 7));
      } else if (e.key === 't' || e.key === 'T') {
        goToday();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [month, mode, today]);
  const selList = (sel && byDay.get(sel)) || [];
  const selection = useRef<HTMLDivElement>(null);
  const hasSelection = selList.length > 0;
  useEffect(() => {
    if (mode !== 'month' || reportMode !== 'full' || !hasSelection) return;
    const el = selection.current;
    if (!el) return;
    const bounds = el.getBoundingClientRect();
    const toolbarBottom = document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? 0;
    el.style.scrollMarginTop = `${toolbarBottom}px`;
    if (bounds.top < toolbarBottom || bounds.bottom > window.innerHeight) {
      el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  }, [sel, reportMode, mode, hasSelection]);
  const list = mode === 'month' ? monthCharges : yearCharges;

  return (
    <>
      <Toolbar
        title={mode === 'month' ? monthLabel(month, { long: true }) : t('calendar.yearTitle', { year })}
        // 月视图的笔数与合计放进右侧的指标卡；年视图没有右栏，仍写在标题下
        sub={
          mode === 'year' ? t('calendar.summary', { count: list.length, amount: formatTotal(sumOf(list), base, { direction: -1, compact: true }) }) : undefined
        }
      >
        <Seg
          value={mode}
          onChange={(v) => switchMode(v)}
          options={[
            ['month', t('calendar.mode.month')],
            ['year', t('calendar.mode.year')],
          ]}
        />
        <IconButton aria-label={t('calendar.prev')} title={`${t('calendar.prev')} ←`} onClick={() => shift(-1)}>
          <Icon name="left" />
        </IconButton>
        <button
          className="btn"
          title={`${t('calendar.today')} T`}
          onClick={() => {
            goToday();
          }}
        >
          {t('calendar.today')}
        </button>
        <IconButton aria-label={t('calendar.next')} title={`${t('calendar.next')} →`} onClick={() => shift(1)}>
          <Icon name="right" />
        </IconButton>
        {!state.readonly && (
          <IconButton onClick={onIcs} title={t('calendar.ics')} aria-label={t('calendar.ics')}>
            <Icon name="share" />
          </IconButton>
        )}
      </Toolbar>
      <div className="page fade-in">
        {mode === 'year' ? (
          <YearHeat
            weekStart={weekStart}
            year={year}
            byDay={byDay}
            today={today}
            sumOf={sumOf}
            base={base}
            focus={month}
            onPick={(m) => switchMode('month', m)}
          />
        ) : (
          <div className="cal-wrap">
            {/* 左：日历与选中日明细或月报告；右：整月列表 */}
            <div className="stack">
              <div className="card cal" style={{ viewTransitionName: 'cal-month' }}>
                <div className="cal-grid" ref={gridRef}>
                  {DOW.map((d, i) => (
                    <div key={i} className="cal-dow">
                      {d}
                    </div>
                  ))}
                  {grid.map((d) => {
                    const items = byDay.get(d) ?? [];
                    const shown = items.length > iconCap ? items.slice(0, iconCap) : items;
                    return (
                      <button
                        key={d}
                        className={`cal-cell ${d.startsWith(month) ? '' : 'out'} ${d === today ? 'today' : ''} ${d === sel ? 'sel' : ''}`}
                        aria-pressed={d === sel}
                        aria-current={d === today ? 'date' : undefined}
                        aria-label={cnDate(d, true)}
                        onClick={() => setSel((current) => (current === d ? null : d))}
                      >
                        <div className="cal-day">
                          <b>{Number(d.slice(8))}</b>
                          {items.length > 0 && (
                            <span className="sum">
                              <FxAmount total={sumOf(items)} direction={-1} ccy={base} decimals={0} />
                            </span>
                          )}
                        </div>
                        <div className="cal-icons" style={{ '--m0': `${fits(shown.length) ? 3 : step - icon}px` } as Record<string, string>}>
                          {shown.map((c, i) => (
                            <span
                              // 同一订阅同一天可能既扣款又返佣，订阅 ID 会重复
                              key={`${c.sub.id}-${i}`}
                              style={{ '--i': i } as Record<string, number>}
                              {...tipProps(() => `${c.sub.name}\n${flow(-c.amount, c.currency)}`)}
                            >
                              <SubIcon sub={c.sub} size={24} />
                            </span>
                          ))}
                          {items.length > shown.length && <span className="cal-more">+{items.length - shown.length}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              {sel && hasSelection ? (
                <div className="stack cal-selection" ref={selection}>
                  <section className="cal-dayhead">
                    <CardTitle as="h3" hint={t('report.cash.fullPaidHint')}>
                      {copyParts(`${cnDate(sel, true)}\n${relDays(diffDays(today, sel))}`)}
                    </CardTitle>
                  </section>
                  <div className="cal-daycards">
                    {selList.map((c, i) => {
                      const amt = pair(-c.amount, c.currency, { value: -chargeBaseOrNaN(state, c) });
                      const sub = state.subscriptions.find((s) => s.id === c.sub.id) ?? c.sub;
                      const cur = currentPhase(sub, today);
                      const status = effectiveStatus(sub, today);
                      const next = nextCharge(sub, addDays(today, 1));
                      const period = c.kind !== 'refund' && c.sub.cycle.unit !== 'lifetime' ? billingPeriod(c.sub, c.date) : undefined;
                      const endedOn = cur.stop?.date ?? cur.end;
                      const stopped = !state.readonly && c.kind !== 'refund' && stopLabel(cur, today);
                      return (
                        <button key={`${c.sub.id}-${i}`} className="card cal-daycard" onClick={() => onOpen(sub)}>
                          <SubIcon sub={sub} size={48} />
                          <span className="cal-dc-main">
                            <b>{sub.name}</b>
                            <span className="cal-dc-meta">
                              <PayBadge m={state.methods.find((m) => m.id === chargeMethodId(c))} />
                              <RegionTag
                                cc={subRegion(
                                  c.sub,
                                  state.methods.find((m) => m.id === chargeMethodId(c)),
                                )}
                              />
                              <span>{cycleLabel(c.sub.cycle)}</span>
                              {status !== 'active' && !(status === 'lifetime' && c.sub.cycle.unit === 'lifetime') && (
                                <span className="badge">{t(`list.status.${status}`)}</span>
                              )}
                              {c.kind === 'refund' && <span className="badge green">{t('detail.charges.kind.refund')}</span>}
                            </span>
                          </span>
                          <span className="cal-dc-info">
                            {c.sub.cycle.unit === 'lifetime' && c.kind !== 'refund' && (
                              <small>
                                {t('editor.field.purchased')} <span className="copy-gap" aria-hidden="true" /> {cnDateAuto(c.sub.start, today)}
                              </small>
                            )}
                            {period && (
                              <small>
                                {cnDateAuto(period.from, today)} – {cnDateAuto(period.paidThrough, today)}
                              </small>
                            )}
                            {status === 'paused' ? (
                              cur.pausedAt && (
                                <small>
                                  {t('detail.ev.paused')} <span className="copy-gap" aria-hidden="true" /> {cnDateAuto(cur.pausedAt, today)}
                                </small>
                              )
                            ) : isStopped(status) ? (
                              endedOn && <small>{t('list.endedOn', { date: cnDateAuto(endedOn, today) })}</small>
                            ) : status === 'ending' && cur.end ? (
                              <small>{t('core.stop.paidThrough', { date: cnDateAuto(cur.end, today) })}</small>
                            ) : next && next !== c.date ? (
                              // 下次扣款就是选中的这一天时，标题已写明日期，不再重复
                              <small>{copyParts(t('calendar.nextCharge', { date: cnDateAuto(next, today) }))}</small>
                            ) : null}
                            {stopped && (
                              <small title={stopDescription(cur, today)}>
                                <StopText sub={cur} today={today} />
                              </small>
                            )}
                          </span>
                          <span className="cal-dc-amt">
                            {amt.main}
                            {/* 已扣/预计与原币合成一行：「预计 · −₺499.99」 */}
                            {(amt.alt || c.kind !== 'refund') && (
                              <small>
                                {copyParts(
                                  [c.kind !== 'refund' && (c.projected ? t('calendar.projected') : t('calendar.charged')), amt.alt].filter(Boolean).join('\n'),
                                )}
                              </small>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : !sel && reportMode !== 'full' ? (
                <div className="cal-none">{t('calendar.pickDay')}</div>
              ) : null}
              {reportMode === 'full' && report && (
                <ScopeReport
                  key={month}
                  report={report}
                  state={state}
                  today={today}
                  onOpen={onOpen}
                  title={t('scope.monthTitle', { month: monthLabel(month, { long: true }) })}
                  animate={true}
                  open={true}
                  onToggle={() => setReportMode('mini')}
                  selectedChargeDate={sel ?? undefined}
                />
              )}
            </div>
            <div className="stack">
              {reportMode === 'mini' && report && <MiniReport report={report} base={base} today={today} onExpand={() => setReportMode('full')} />}
              <section className="card cal-charges">
                <div className="card-h">
                  <CardTitle>{copyParts(t('calendar.monthAll', { month: monthLabel(month, { year: false }) }))}</CardTitle>
                </div>
                {monthCharges.length === 0 && <div className="cell muted">{t('calendar.noneMonth')}</div>}
                <div className="cal-charge-list">
                  {[...byDay]
                    .filter(([date]) => date.startsWith(month))
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, items]) => (
                      <section key={date} data-date={date} className="cal-charge-group">
                        <h4 className={`cal-charge-day ${date === today ? 'today' : ''}`} aria-label={cnDate(date, true)}>
                          <span>{Number(date.slice(8))}</span>
                          <i aria-hidden="true" />
                        </h4>
                        {items.map((c, i) => {
                          const amt = pair(-c.amount, c.currency, { value: -chargeBaseOrNaN(state, c) });
                          return (
                            <button
                              type="button"
                              className="cal-charge-row"
                              key={c.sub.id + date + i}
                              onClick={() => onOpen(state.subscriptions.find((s) => s.id === c.sub.id) ?? c.sub)}
                            >
                              <span className="row cal-name">
                                <SubIcon sub={c.sub} size={24} />
                                <span>{c.sub.name}</span>
                              </span>
                              <span className="cal-charge-amount" title={amt.alt}>
                                {amt.main}
                              </span>
                            </button>
                          );
                        })}
                      </section>
                    ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function YearHeat({
  year,
  byDay,
  today,
  sumOf,
  base,
  onPick,
  weekStart,
  focus,
}: {
  year: string;
  byDay: Map<string, Charge[]>;
  today: string;
  sumOf: (l?: Charge[]) => FxTotal;
  base: string;
  onPick: (m: string) => void;
  weekStart: 0 | 1;
  /** 月视图正在看的月份：它的小卡与月历共用过渡名，切换时一个缩放成另一个 */
  focus: string;
}) {
  const DOW = dows(weekStart);
  return (
    <div className="heat">
      {Array.from({ length: 12 }, (_, i) => {
        const m = `${year}-${String(i + 1).padStart(2, '0')}`;
        // 固定 6 行，让 12 张月卡等高对齐
        const grid = Array.from({ length: 42 }, (_, k) => addDays(monthGrid(m, weekStart)[0], k));
        const days = grid.filter((d) => d.startsWith(m));
        const total = sumTotals(days.map((d) => sumOf(byDay.get(d))));
        const count = days.reduce((a, d) => a + (byDay.get(d)?.length ?? 0), 0);
        return (
          <button
            key={m}
            className={`heat-m ${today.startsWith(m) ? 'cur' : ''} ${m < today.slice(0, 7) ? 'past' : ''}`}
            style={m === focus ? { viewTransitionName: 'cal-month' } : undefined}
            onClick={(e) => {
              // 点哪个月就从哪一格放大：过渡开始前把过渡名挪到这一格
              for (const el of e.currentTarget.parentElement?.children ?? []) (el as HTMLElement).style.viewTransitionName = '';
              e.currentTarget.style.viewTransitionName = 'cal-month';
              onPick(m);
            }}
          >
            <div className="heat-h">
              {monthLabel(m, { year: false })}
              <span>
                {copyParts(count ? t('calendar.heatCount', { count }) : '')}
                {formatTotal(total, base, { direction: -1, compact: true })}
              </span>
            </div>
            <div className="heat-g">
              {DOW.map((w, k) => (
                <em key={k}>{w}</em>
              ))}
              {grid.map((d) => {
                if (!d.startsWith(m)) return <i key={d} className="hd out" />;
                const list = (byDay.get(d) ?? []).slice().sort((x, y) => y.amount - x.amount);
                const cls = `hd ${d === today ? 'today' : ''} ${list.length ? 'has' : ''} ${d < today ? 'gone' : ''}`;
                if (!list.length)
                  return (
                    <i key={d} className={cls}>
                      {Number(d.slice(8))}
                    </i>
                  );
                return (
                  <i
                    key={d}
                    className={cls}
                    {...tipProps(() => (
                      <TipTable
                        head={[cnDate(d, true), list.length > 1 ? formatTotal(sumOf(list), base, { direction: -1, compact: true }) : '']}
                        rows={list.map((c, i) => ({ key: `${c.sub.id}-${i}`, label: c.sub.name, value: flow(-c.amount, c.currency) }))}
                      />
                    ))}
                  >
                    {/* 同一天多笔：只画第一个图标，右上角标出总笔数（格子太小，叠起来只剩一道边） */}
                    <span className="hd-stack">
                      <SubIcon sub={list[0].sub} size={20} />
                      {list.length > 1 && <b className="hd-more">{list.length}</b>}
                    </span>
                  </i>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** 月度净现金只读 monthReport 的结果，迷你和完整报告共用同一口径。 */
function MiniReport({ report, base, today, onExpand }: { report: ReturnType<typeof monthReport>; base: string; today: string; onExpand: () => void }) {
  const headline = report.blocks.find((b) => b.type === 'headline');
  if (!headline || headline.mode !== 'month') return null;
  const peak = Math.max(1, ...report.months.map((r) => Math.abs(r.partial!.paid.value) + Math.abs(r.partial!.pending.value)));
  return (
    <section className="card cal-stat">
      <div className="cal-mini-head">
        <CardTitle as="span" hint={t('scope.cashBasis')}>
          {t('scope.monthTotal')}
        </CardTitle>
        <IconButton type="button" className="cal-expand" aria-label={t('calendar.expandReport')} title={t('calendar.expandReport')} onClick={onExpand}>
          <Maximize2 size={15} />
        </IconButton>
      </div>
      <div className="cal-stat-big">
        <b className={headline.total < 0 ? 'green' : undefined}>{formatTotal(headline.partial!.total, base, { direction: -1 })}</b>
      </div>
      {/* 既有已扣又有待扣时才写待扣多少；全过去或全未来时与合计相同 */}
      {headline.pending !== 0 && headline.paid !== 0 && (
        <small>
          {t('scope.pending')} {formatTotal(headline.partial!.pending, base, { direction: -1 })}
        </small>
      )}
      {/* 上月、下月与本月并排；涉及今天以后的月份标「预计」 */}
      <MetricCards inline>
        {[report.months.at(-2)!, report.next].map((r) => (
          <Metric
            key={r.month}
            label={monthLabel(r.month, { year: false })}
            value={formatTotal(r.partial.total, base, { direction: -1 })}
            note={r.pending !== 0 ? t('scope.forecast') : undefined}
          />
        ))}
      </MetricCards>
      {headline.yearly && (
        <div className="cal-comparisons">
          <div>
            <span>{t('scope.previousYear')}</span>
            <SpendingDelta value={headline.yearly} base={base} />
          </div>
        </div>
      )}
      <div className="cal-mini-chart">
        {report.months.map((r) => (
          <div
            key={r.month}
            role="img"
            aria-label={`${monthLabel(r.month)}\n${formatTotal(r.partial!.total, base, { direction: -1 })}`}
            className={`cal-mini-month ${r.month === headline.month ? 'current' : ''}`}
            {...tipProps(
              () =>
                `${monthLabel(r.month)}\n${formatTotal(r.partial!.total, base, { direction: -1 })}${r.month >= today.slice(0, 7) && r.pending !== 0 ? `\n${t('scope.forecast')}` : ''}`,
            )}
          >
            <div className={`cal-mini-bars ${report.months.some((m) => m.partial!.paid.value < 0 || m.partial!.pending.value < 0) ? 'signed' : ''}`}>
              <div className="cal-mini-positive">
                <i style={{ height: `${(Math.max(0, r.partial!.paid.value) / peak) * 100}%` }} />
                <i className="forecast" style={{ height: `${(Math.max(0, r.partial!.pending.value) / peak) * 100}%` }} />
              </div>
              <div className="cal-mini-negative">
                <i style={{ height: `${(Math.max(0, -r.partial!.paid.value) / peak) * 100}%` }} />
                <i className="forecast" style={{ height: `${(Math.max(0, -r.partial!.pending.value) / peak) * 100}%` }} />
              </div>
            </div>
            <small>{monthLabel(r.month, { year: false })}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

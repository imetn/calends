import { ScopeLifecycleReport } from './ScopeLifecycleReport.tsx';
import { formatTotal, scaleTotal, totalNote, totalsNote, type FxTotal } from '../../../shared/fx-total.ts';
import { CopyImageButton } from './CopyImageButton.tsx';
import { copyParts } from './copy.tsx';
import { numberFormat } from '../../../shared/intl.ts';
import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ChevronUp, Layers, Minimize2 } from 'lucide-react';
import { cnDateAuto, cnDateFull, flow, money, monthLabel } from '../../../shared/format.ts';
import { intlLocale, t } from '../../../shared/i18n.ts';
import type { Block, ChargeRow, Comparison, MovementRow, ReportEvent, ScopeReport as ReportData } from '../../../shared/scope-report.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { snapshot } from '../snapshot.ts';
import { bankOf, brandOf, catColor, methodLogo } from '../derive.ts';
import { BarLine } from './charts.tsx';
import { MetricCards, Metric, IconButton, CardTitle } from './ui.tsx';
import { CatIcon, MethodMark, SubIcon } from './marks.tsx';
import { Icon } from './icons.tsx';
import './scope-report.css';

interface Props {
  report: ReportData;
  state: AppState;
  today: string;
  onOpen: (sub: Subscription) => void;
  title: string;
  animate: boolean;
  open: boolean;
  onToggle: () => void;
  /** The calendar owns these charge rows above the report divider. Aggregates stay complete. */
  selectedChargeDate?: string;
}

/** Starting or stopping says whether a subscription is used, not whether money was saved; these rows stay neutral. */
const LIFECYCLE = new Set<ReportEvent['kind']>(['start', 'end', 'cancel', 'terminate', 'trial', 'pause', 'resume']);

/** Spending increases use the same direction and unsigned comparison in both calendar modes. */
export function SpendingDelta({ value, base }: { value: Comparison; base: string }) {
  const direction = value.amount > 0.005 ? 'up' : value.amount < -0.005 ? 'down' : '';
  return (
    <span className={`chip-d ${direction}`}>
      {copyParts(direction === 'up' ? '↑' : direction === 'down' ? '↓' : '')} {money(Math.abs(value.amount), base)}
      {copyParts(
        value.percent != null &&
          Number.isFinite(value.percent) &&
          `\n${numberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(value.percent))}`,
      )}
    </span>
  );
}

/** Shared presentation for subscription selections and calendar months; callers own disclosure state. */
export function ScopeReport({ report, state, today, onOpen, title, animate, open, onToggle, selectedChargeDate }: Props) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'done'>('idle');
  const copying = copyState === 'copying';
  const expanded = open || copying;
  const copyImage = () => {
    if (!root.current || copying) return Promise.reject(new Error('PNG'));
    const el = root.current;
    // 同步关闭动画并锁定操作，以便 Safari 在点击内创建 ClipboardItem。
    flushSync(() => setCopyState('copying'));
    const blob = (async () => {
      try {
        // 等待图表布局稳定，组装动画在复制后保持关闭。
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const image = await snapshot(el, {
          card: true,
          style: { backgroundColor: getComputedStyle(el).getPropertyValue('--bg'), padding: '20px', borderRadius: 'var(--radius-lg)' },
          filter: (n) => !(n instanceof Element && n.matches('.scope-actions')),
        });
        if (!image) throw new Error(t('ui.error.requestFailed', { status: 'PNG' }));
        return image;
      } finally {
        setCopyState('done');
      }
    })();
    return blob;
  };
  const base = state.settings.baseCurrency;
  const monthly = report.blocks.some((b) => b.type === 'headline' && b.mode === 'month');
  const monthlyMovement = report.blocks.find((b) => b.type === 'trend' && b.mode === 'month');
  const events = report.blocks.find((b) => b.type === 'events')?.rows ?? [];
  const movementEvents = (row: MovementRow) => events.filter((e) => e.sub.id === row.sub.id && e.date >= row.since && e.date <= row.until);
  const remainingEvents = events.filter(
    (e) => monthlyMovement?.mode !== 'month' || !monthlyMovement.movement.items.some((row) => movementEvents(row).includes(e)),
  );
  const top = report.blocks.find((b) => b.type === 'top' && b.mode === 'month');
  const visibleCharges = (rows: ChargeRow[]) => rows.filter((r) => copying || !monthly || r.date !== selectedChargeDate);
  const upcomingRows = (rows: ChargeRow[]) =>
    visibleCharges(rows)
      .filter((r) => !top?.rows.includes(r))
      .slice(0, 5);
  const blocks = report.blocks.filter((b) =>
    b.type === 'events' && monthlyMovement?.mode === 'month'
      ? false
      : b.type === 'upcoming'
        ? upcomingRows(b.rows).length > 0
        : b.type === 'top'
          ? b.mode === 'month'
            ? visibleCharges(b.rows).length > 0
            : b.rows.length > 1
          : b.type === 'losses'
            ? b.rows.length > 0 || visibleCharges(b.refunds).length > 0 || b.incomplete
            : true,
  );
  const losses = report.blocks.find((b) => b.type === 'losses');
  const expense = (v: number, part?: FxTotal) => (part ? formatTotal(part, base, { direction: -1 }) : flow(-v, base));
  const income = (v: number, part?: FxTotal) => (part ? formatTotal(part, base, { direction: 1 }) : flow(v, base));
  const percent = (v: number) => (Number.isFinite(v) ? numberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(v)) : '—');
  const delta = (value: Comparison) => <SpendingDelta value={value} base={base} />;
  const fact = (label: string, value: ReactNode, part?: FxTotal, direction: 1 | -1 = -1) => (
    <Metric label={label} value={part ? formatTotal(part, base, { direction, main: true, average: label === t('scope.average') }) : value} />
  );
  const name = (sub: Subscription, meta?: ReactNode) => (
    <span className="scope-sub">
      <SubIcon sub={sub} size={24} proxied />
      <span>
        <span className="scope-name">{sub.name}</span>
        {meta && <small>{meta}</small>}
      </span>
    </span>
  );
  const chargeRows = (rows: ChargeRow[]) =>
    rows.map((r, i) => (
      <button type="button" className="scope-row scope-tap" data-snapshot-keep key={`${r.sub.id}-${r.date}-${i}`} onClick={() => onOpen(r.sub)}>
        {name(r.sub, cnDateAuto(r.date, today))}
        <b className="num">{expense(r.amount, r.partial)}</b>
      </button>
    ));
  const eventLabel = (r: ReportEvent) => t(`scope.event.${r.kind === 'price' || r.kind === 'intro-end' ? (r.delta >= 0 ? 'increase' : 'decrease') : r.kind}`);
  const eventRows = (rows: ReportEvent[]) =>
    rows.map((r, i) => (
      <button type="button" className="scope-row scope-tap" data-snapshot-keep key={`${r.sub.id}-${r.date}-${r.kind}-${i}`} onClick={() => onOpen(r.sub)}>
        {name(
          r.sub,
          <>
            {cnDateAuto(r.date, today)} <span className="copy-gap" aria-hidden="true" /> {eventLabel(r)}
          </>,
        )}
        {r.delta !== 0 &&
          (!Number.isFinite(r.delta) ? (
            r.partial ? (
              formatTotal(r.partial, base)
            ) : (
              '—'
            )
          ) : LIFECYCLE.has(r.kind) ? (
            // 开始、停止只说明用或不用，不算多花或省下：中性显示金额，不带箭头和红绿
            <span className="chip-d">{money(Math.abs(r.delta), base)}</span>
          ) : (
            delta({ amount: r.delta })
          ))}
      </button>
    ));
  const heading = (key: string, hint?: string, count?: number) => (
    <div className="card-h">
      <CardTitle hint={hint ? t(`scope.${hint}`) : undefined}>{t(`scope.${key}`, { count })}</CardTitle>
    </div>
  );
  const headlineHeading = (label: string, hint?: string) => (
    <div className="scope-headline-header">
      {label && (
        <CardTitle as="div" className="stat-label" hint={hint ? t(hint) : undefined}>
          {t(label)}
        </CardTitle>
      )}
      <div className="scope-actions">
        <CopyImageButton render={copyImage} disabled={copying} />
        <IconButton
          type="button"

          title={t(monthly ? 'scope.minimize' : 'scope.collapse')}
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={t(monthly ? 'scope.minimize' : 'scope.collapse')}
          onClick={onToggle}
          disabled={copying}
        >
          {monthly ? <Minimize2 size={15} /> : <ChevronUp size={15} />}
        </IconButton>
      </div>
    </div>
  );
  const headlineNote = (block: Extract<Block, { type: 'headline' }>) =>
    totalsNote([
      [
        t(block.mode === 'scope' ? 'scope.monthly' : block.mode === 'month' ? 'scope.monthTotal' : 'scope.totalSpent'),
        block.partial?.mrr ?? block.partial?.total,
      ],
      [
        t(block.mode === 'scope' ? 'scope.yearTotal' : 'scope.yearPaid'),
        block.mode === 'scope' ? block.partial?.year : block.mode === 'total' ? block.partial?.yearPaid : undefined,
      ],
      [t('scope.includedLoss'), block.partial?.loss],
    ]);
  const render = (block: Block, wide = false): ReactNode => {
    switch (block.type) {
      case 'headline':
        if (block.mode === 'total')
          return (
            <>
              {headlineHeading('scope.totalSpent', 'scope.totalBasis')}
              <div className="hero-num num">
                {block.partial?.total ? formatTotal(block.partial.total, base, { direction: -1, main: true }) : expense(block.total)}
              </div>
              <div className="hero-delta">
                {headlineNote(block)}
                <span className="muted">{t('scope.totalSince', { date: cnDateFull(block.since) })}</span>
              </div>
              <MetricCards inline>
                {fact(t('scope.subsCount'), block.count)}
                {block.count > 1 && fact(t('scope.average'), expense(block.average), block.partial?.average)}
                {block.yearPaid !== 0 && fact(t('scope.yearPaid'), expense(block.yearPaid), block.partial?.yearPaid)}
              </MetricCards>
            </>
          );
        return block.mode === 'scope' ? (
          <>
            {headlineHeading('scope.monthly', 'scope.mrrBasis')}
            <div className="hero-num num">{block.partial?.mrr ? formatTotal(block.partial.mrr, base, { direction: -1, main: true }) : expense(block.mrr)}</div>
            <div className="hero-delta">
              {headlineNote(block)}
              {delta(block.change)}
              <span className="muted">{t('scope.previousEnd')}</span>
            </div>
            <MetricCards inline>
              {fact(t('scope.annual'), expense(block.annual), block.partial?.annual)}
              {fact(t('scope.active'), block.activeCount)}
              <Metric
                label={t('scope.yearTotal')}
                value={block.partial?.year ? formatTotal(block.partial.year, base, { direction: -1, main: true }) : expense(block.year)}
                note={<small>{t('scope.paidAmount', { amount: expense(block.paid, block.partial?.paid) })}</small>}
              />
              {(block.loss > 0 || !Number.isFinite(block.loss)) &&
                block.loss !== losses?.loss &&
                fact(t('scope.includedLoss'), expense(block.loss), block.partial?.loss)}
            </MetricCards>
          </>
        ) : (
          <>
            {headlineHeading('scope.monthTotal', 'scope.cashBasis')}
            <div className={`hero-num num ${block.total < 0 ? 'green' : ''}`}>
              {block.partial?.total ? formatTotal(block.partial.total, base, { direction: -1, main: true }) : expense(block.total)}
            </div>
            <div className="hero-delta">
              {headlineNote(block)}
              <span className="scope-comparison">
                {delta(block.previous)}
                <span className="muted">{t('scope.previousMonth')}</span>
              </span>
              {block.yearly && (
                <span className="scope-comparison">
                  {delta(block.yearly)}
                  <span className="muted">{t('scope.previousYear')}</span>
                </span>
              )}
            </div>
            <MetricCards inline>
              {fact(t('scope.paid'), expense(block.paid), block.partial?.paid)}
              {fact(t('scope.pending'), expense(block.pending), block.partial?.pending)}
              {fact(t('scope.count'), block.count)}
            </MetricCards>
          </>
        );
      case 'trend': {
        if (block.mode === 'scope')
          return (
            <>
              {heading('cash', report.lifecycle ? 'lifecycle.cashWindow' : 'cashWindow')}
              <BarLine
                bars={block.rows.map((r) => r.partial.cash.value)}
                line={[]}
                future={report.lifecycle ? [] : block.rows.map((r) => r.projected)}
                labels={block.rows.map((r) => monthLabel(r.month, { year: false }))}
                tip={(i) => (
                  <>
                    {monthLabel(block.rows[i].month)} <span className="copy-gap" aria-hidden="true" /> {expense(block.rows[i].cash, block.rows[i].partial.cash)}
                    {copyParts(block.rows[i].projected && `\n${t('scope.forecast')}`)}
                  </>
                )}
              />
              {!report.lifecycle && (
                <details className="scope-chart-data">
                  <summary>{t('scope.chartData')}</summary>
                  {block.rows.map((r) => (
                    <div className="scope-row" key={r.month}>
                      <span>
                        {monthLabel(r.month)}
                        {copyParts(r.projected && `\n${t('scope.forecast')}`)}
                      </span>
                      <b className="num">{expense(r.cash, r.partial.cash)}</b>
                    </div>
                  ))}
                </details>
              )}
            </>
          );
        const mv = block.movement;
        const drivers = [
          { key: 'added', amount: mv.added },
          { key: 'expansion', amount: mv.expansion },
          { key: 'contraction', amount: -mv.contraction },
          { key: 'churned', amount: -mv.churned },
          { key: 'fx', amount: mv.fx },
        ].filter((r) => Math.abs(r.amount) >= 0.005);
        const peak = Math.max(1, ...drivers.map((r) => Math.abs(r.amount)));
        const net = mv.to - mv.from;
        const singleDriver = drivers.length === 1 && Math.abs(drivers[0].amount - net) < 0.005;
        return (
          <>
            <div className="card-h">
              <CardTitle hint={t('scope.movementBasis')}>{t('scope.movement', { month: monthLabel(block.month) })}</CardTitle>
            </div>
            <div className="hero-delta">
              {!singleDriver && delta({ amount: net })}
              <span className="muted">{t('scope.previousEnd')}</span>
            </div>
            <div className="mv-rows">
              {drivers.map((r) => (
                <div className="mv-row" key={r.key}>
                  <span>{t(`scope.${r.key}`)}</span>
                  <div className="mv-bar">
                    <i style={{ width: `${(Math.abs(r.amount) / peak) * 100}%` }} />
                  </div>
                  <b className="num">
                    {r.amount > 0 ? '↑' : '↓'} {money(Math.abs(r.amount), base)}
                  </b>
                </div>
              ))}
            </div>
            <div className="scope-movements" data-snapshot-list>
              {mv.items.map((r) => (
                <button type="button" className="scope-row scope-tap" data-snapshot-keep key={r.sub.id} onClick={() => onOpen(r.sub)}>
                  {name(
                    r.sub,
                    <>
                      {t(`scope.${r.kind}`)}
                      {movementEvents(r).map((e, i, rows) => {
                        const redundant =
                          (e.kind === 'start' && r.kind === 'added') ||
                          ((e.kind === 'price' || e.kind === 'intro-end') &&
                            ((e.delta > 0 && r.kind === 'expansion') || (e.delta < 0 && r.kind === 'contraction')));
                        return redundant ? null : (
                          <span key={`${e.date}-${e.kind}-${i}`}>
                            {copyParts('\n')}
                            {eventLabel(e)}
                            {rows.length > 1 && ` (${cnDateAuto(e.date, today)})`}
                          </span>
                        );
                      })}
                      {copyParts(
                        movementEvents(r).some((e) => e.kind === 'cancel' || e.kind === 'terminate') && r.sub.stop?.reason && `\n${r.sub.stop.reason}`,
                      )}
                      {copyParts('\n')}
                      <span className="num">
                        {money(r.from, base)} → {money(r.to, base)}
                      </span>
                      <span className="scope-movement-date">
                        {cnDateAuto(r.since, today)}
                        {r.until !== r.since && ` – ${cnDateAuto(r.until, today)}`}
                      </span>
                    </>,
                  )}
                </button>
              ))}
              {eventRows(remainingEvents)}
            </div>
          </>
        );
      }
      case 'composition':
        return (
          <>
            {heading('composition', monthly ? 'debitBasis' : undefined)}
            <div className="scope-compositions">
              {(['categories', 'methods'] as const).map(
                (dim) =>
                  block[dim].length > 0 && (
                    <div className="scope-composition" key={dim}>
                      <h4>{t(`scope.${dim}`)}</h4>
                      {block[dim].map((r) => {
                        const method = state.methods.find((m) => m.id === r.key);
                        const color = r.other ? 'var(--label-3)' : dim === 'categories' ? catColor(r.key) : 'var(--chart-ink)';
                        return (
                          <div className="scope-share" key={r.other ? 'other' : `key-${r.key}`}>
                            <div className="scope-row">
                              <span className="scope-sub">
                                {r.other ? (
                                  <span className="scope-cat">
                                    <Layers size={18} />
                                  </span>
                                ) : dim === 'categories' ? (
                                  <span className="scope-cat" style={{ color }}>
                                    <CatIcon cat={r.key} size={18} />
                                  </span>
                                ) : method && (bankOf(method) || brandOf(method) || methodLogo(method)) ? (
                                  <MethodMark m={method} size={24} proxied />
                                ) : (
                                  <span className="scope-cat" style={{ color }}>
                                    <Icon name="wallet" size={18} />
                                  </span>
                                )}
                                <span>
                                  {r.other
                                    ? t('scope.other')
                                    : dim === 'categories'
                                      ? r.key || t('scope.uncategorized')
                                      : (method?.name ?? t('scope.noMethod'))}
                                </span>
                              </span>
                              <b className="num">
                                {expense(r.amount, r.partial)} <span className="copy-gap" aria-hidden="true" /> {percent(r.share)}
                              </b>
                            </div>
                            <div className="mv-bar">
                              <i style={{ width: `${Number.isFinite(r.share) ? r.share * 100 : 0}%`, background: color }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ),
              )}
            </div>
          </>
        );
      case 'top':
        return (
          <>
            {heading(
              block.mode === 'scope' ? 'topMonthly' : block.mode === 'total' ? 'topTotal' : 'topCharges',
              block.mode === 'month' ? 'debitBasis' : undefined,
              block.mode === 'month' ? visibleCharges(block.rows).length : block.rows.length,
            )}
            {block.mode === 'month'
              ? chargeRows(visibleCharges(block.rows))
              : (() => {
                  const list = block.rows.map((r, n) => (
                    <button type="button" className="scope-row scope-tap" data-snapshot-keep key={r.sub.id} onClick={() => onOpen(r.sub)}>
                      {name(r.sub)}
                      <span className="scope-rank-amount">
                        {/* 只给前三名标名次：金、银、铜 */}
                        {wide && n < 3 && <span className={`scope-medal m${n + 1}`}>No.{n + 1}</span>}
                        <b className="num">{expense(r.amount, r.partial)}</b>
                      </span>
                    </button>
                  ));
                  // 独占整行时分两列竖排：左列 1–5，右列 6–10
                  return wide ? (
                    <div className="scope-movements scope-ranks" style={{ '--rank-rows': Math.ceil(list.length / 2) } as CSSProperties}>
                      {list}
                    </div>
                  ) : (
                    list
                  );
                })()}
          </>
        );
      case 'upcoming':
        return (
          <>
            {heading('upcoming')}
            {!monthly && block.rows.length > 1 && <p className="scope-note num">{expense(block.total, block.partial?.total)}</p>}
            {chargeRows(upcomingRows(block.rows))}
          </>
        );
      case 'events':
        return (
          <>
            {heading('events')}
            <div className="scope-movements" data-snapshot-list>
              {eventRows(block.rows)}
            </div>
          </>
        );
      case 'losses':
        return (
          <>
            {heading('losses')}
            <MetricCards inline>
              {block.rows.length > 1 && fact(t('scope.loss'), expense(block.loss, block.partial?.loss))}
              {block.refunds.length > 1 && fact(t('scope.refunded'), income(block.refunded, block.partial?.refunded))}
            </MetricCards>
            {block.incomplete && <p className="scope-note red">{block.partial?.loss ? totalNote(block.partial.loss) : t('scope.incomplete')}</p>}
            <div data-snapshot-list>
              {block.rows.map((r) => (
                <button type="button" className="scope-row scope-tap" data-snapshot-keep key={`${r.sub.id}-${r.phaseIndex}`} onClick={() => onOpen(r.sub)}>
                  {name(
                    r.sub,
                    events.some((e) => e.sub.id === r.sub.id && e.date === r.date && (e.kind === 'cancel' || e.kind === 'terminate')) ? undefined : (
                      <>
                        {cnDateAuto(r.date, today)} <span className="copy-gap" aria-hidden="true" />{' '}
                        {t(`scope.event.${r.kind === 'terminate' ? 'terminate' : 'cancel'}`)}
                      </>
                    ),
                  )}
                  <span>
                    <b className="num">{expense(r.lossBase)}</b>
                    {r.currency !== base && <small>{flow(-r.loss, r.currency)}</small>}
                  </span>
                </button>
              ))}
              {visibleCharges(block.refunds).map((r, i) => (
                <button
                  type="button"
                  className="scope-row scope-tap"
                  data-snapshot-keep
                  key={`refund-${r.sub.id}-${r.date}-${i}`}
                  onClick={() => onOpen(r.sub)}
                >
                  {name(
                    r.sub,
                    <>
                      {cnDateAuto(r.date, today)} <span className="copy-gap" aria-hidden="true" /> {t('scope.refunded')}
                    </>,
                  )}
                  <b className="num green">{income(-r.amount, r.partial ? scaleTotal(r.partial, -1) : undefined)}</b>
                </button>
              ))}
            </div>
          </>
        );
      case 'sharing':
        return (
          <>
            {heading('sharing', 'sharingBasis')}
            {block.rows.length > 1 && (
              <MetricCards inline>
                {block.received !== 0 && fact(t('scope.received'), income(block.received, block.partial?.received))}
                {(block.owed > 0 || block.partial?.owed.incomplete) && fact(t('scope.owed'), income(block.owed, block.partial?.owed))}
              </MetricCards>
            )}
            <div data-snapshot-list>
              {block.rows.map((r) => (
                <button type="button" className="scope-row scope-tap" data-snapshot-keep key={r.sub.id} onClick={() => onOpen(r.sub)}>
                  {name(r.sub)}
                  <span>
                    {r.received !== 0 && <b className="num green">{t('scope.receivedAmount', { amount: income(r.received, r.partial?.received) })}</b>}
                    {(r.owed > 0 || r.partial?.owed.incomplete) && (
                      <small className="num">{t('scope.owedAmount', { amount: income(r.owed, r.partial?.owed) })}</small>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </>
        );
    }
  };
  // 半宽卡片两两并排；落单的（如买断报告只有排行、没有即将扣款）铺满整行，不留右侧空缺
  const FULL = new Set<Block['type']>(['headline', 'trend', 'events', 'losses', 'composition']);
  const alone = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    if (FULL.has(blocks[i].type)) continue;
    if (i + 1 < blocks.length && !FULL.has(blocks[i + 1].type)) i++;
    else alone.add(i);
  }
  if (report.lifecycle)
    return (
      <section ref={root} className="scope-report" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="scope-header">
          {expanded ? (
            <span className="scope-title">{title}</span>
          ) : (
            <button type="button" className="scope-trigger" aria-expanded={false} aria-controls={id} onClick={onToggle}>
              {title} / {t('scope.expand')}
            </button>
          )}
        </h2>
        {expanded && (
          <ScopeLifecycleReport
            report={report}
            state={state}
            today={today}
            onOpen={onOpen}
            id={id}
            copying={copying}
            actions={headlineHeading('')}
            renderBlock={render}
          />
        )}
      </section>
    );
  return (
    <section ref={root} className={`scope-report ${animate && copyState === 'idle' ? 'scope-animate' : ''}`} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="scope-header">
        {expanded ? (
          <span className="scope-title">{title}</span>
        ) : (
          <button type="button" className="scope-trigger" aria-expanded={false} aria-controls={id} onClick={onToggle}>
            {t('scope.expand')}
          </button>
        )}
      </h2>
      {expanded && (
        <div id={id} className="scope-grid">
          {blocks.map((block, i) => (
            <div
              className={`card scope-block scope-${block.type} ${alone.has(i) ? 'scope-alone' : ''}`}
              key={block.type}
              style={{ animationDelay: `${i * 65}ms` }}
            >
              {render(block, alone.has(i))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

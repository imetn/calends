import { useState, type ReactNode } from 'react';
import { durationLabel } from '../../../shared/billing.ts';
import { flow } from '../../../shared/format.ts';
import { formatTotal, totalNote } from '../../../shared/fx-total.ts';
import { t } from '../../../shared/i18n.ts';
import type { Block, ScopeReport } from '../../../shared/scope-report.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { Gantt } from '../views/Gantt.tsx';
import { MetricCards, Metric, CardTitle } from './ui.tsx';

/** Lifecycle presentation is exclusive to list selections; calendar blocks retain their renderer. */
export function ScopeLifecycleReport({
  report,
  state,
  today,
  onOpen,
  id,
  copying,
  actions,
  renderBlock,
}: {
  report: ScopeReport;
  state: AppState;
  today: string;
  onOpen: (s: Subscription) => void;
  id: string;
  copying: boolean;
  actions: ReactNode;
  renderBlock: (block: Block) => ReactNode;
}) {
  const [allEvents, setAllEvents] = useState(false);
  const data = report.lifecycle!;
  const base = state.settings.baseCurrency;
  const head = report.blocks.find((b) => b.type === 'headline');
  const trend = report.blocks.find((b) => b.type === 'trend');
  const events = report.blocks.find((b) => b.type === 'events');
  const upcoming = report.blocks.find((b) => b.type === 'upcoming');
  const mrr = head?.mode === 'scope' ? head.partial?.mrr : undefined;
  const count = (n: number) => t('scope.lifecycle.times', { count: n });
  const amount = (total: Parameters<typeof formatTotal>[0]) => formatTotal(total, base, { direction: -1, main: true });
  return (
    <div id={id} className="scope-grid scope-lifecycle">
      <div className="scope-headline scope-block">
        {actions}
        <MetricCards>
          <Metric
            label={
              <CardTitle as="span" className="icon-text" hint={[t('scope.totalBasis'), totalNote(data.spent)].filter(Boolean).join('\n')}>
                {t('scope.totalSpent')}
              </CardTitle>
            }
            value={amount(data.spent)}
            note={totalNote(data.spent) || undefined}
          />
          <Metric
            label={t(data.activeCount || !data.stoppedCount ? 'scope.monthly' : 'scope.lifecycle.stoppedMonthly')}
            value={data.activeCount ? (mrr ? amount(mrr) : flow(0, base)) : data.stoppedCount ? amount(data.stoppedMonthly) : '—'}
            note={
              data.activeCount && head?.mode === 'scope'
                ? `${t('scope.previousEnd')} / ${flow(-head.change.amount, base)}`
                : t(data.stoppedCount === data.timeline.length + data.omitted ? 'scope.lifecycle.allStopped' : 'scope.lifecycle.noActive')
            }
          />
          <Metric
            label={t(data.terminatedCount ? 'core.stop.terminate' : 'scope.lifecycle.stopped')}
            value={data.terminatedCount || data.stoppedCount ? count(data.terminatedCount || data.stoppedCount) : '—'}
            note={
              data.terminatedCount ? (
                <span className={data.terminationLoss.value > 0 || data.terminationLoss.incomplete ? 'loss' : ''}>
                  {t('report.stops.loss')} / {amount(data.terminationLoss)}
                </span>
              ) : undefined
            }
          />
          <Metric label={t('scope.lifecycle.averageDuration')} value={durationLabel(data.averageDays)} />
        </MetricCards>
      </div>
      {data.timeline.length > 0 && (
        <div className="card scope-block scope-alone">
          <div className="card-h">
            <CardTitle>{t('list.view.gantt')}</CardTitle>
          </div>
          <Gantt rows={data.timeline} state={state} today={today} onOpen={onOpen} compact />
          {data.omitted > 0 && <p className="scope-note">{t('scope.lifecycle.omitted', { count: data.omitted })}</p>}
        </div>
      )}
      {trend && <div className="card scope-block scope-cash scope-alone">{renderBlock(trend)}</div>}
      {events && (
        <div className="card scope-block scope-events">
          {renderBlock({ ...events, rows: allEvents || copying ? events.rows : events.rows.slice(0, 6) })}
          {events.rows.length > 6 && !copying && (
            <button type="button" className="btn plain" aria-expanded={allEvents} onClick={() => setAllEvents(!allEvents)}>
              {allEvents ? t('report.checkup.less') : t('report.checkup.more', { count: events.rows.length - 6 })}
            </button>
          )}
        </div>
      )}
      {upcoming && <div className="card scope-block scope-alone">{renderBlock(upcoming)}</div>}
    </div>
  );
}

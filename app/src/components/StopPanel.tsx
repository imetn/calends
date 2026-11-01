import { useState } from 'react';
import {
  nonrenewalDate,
  renewalDates,
  chargesBetween,
  currentPhase,
  effectiveStatus,
  isPostpaid,
  phaseSubs,
  stopSummary,
  isStopped,
} from '../../../shared/billing.ts';
import { flow, cnDateFull } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { reactivate } from '../../../shared/phases.ts';
import { applyStopForm, stopForm, stopPreview, type StopForm, type StopMode } from '../../../shared/stop-form.ts';
import type { Subscription } from '../../../shared/types.ts';
import { getState } from '../store.ts';
import { toast } from '../toast.ts';
import { DatePicker } from './DatePicker.tsx';
import { CurrencySelect, Picker } from './Picker.tsx';
import { Cell } from './ui.tsx';
import { useSubmit } from './inputs.tsx';

export function stopLabel(sub: Subscription, today: string): string | undefined {
  const summary = stopSummary(sub, today);
  if (!summary || summary.date > today) return undefined;
  // 后付费没有预付，也就谈不上退款；有退款记录时才写
  if (isPostpaid(sub) && summary.refunded <= 0) return undefined;
  if (summary.refunded > 0)
    return t(summary.refundStatus === 'full' ? 'core.stop.refunded' : 'core.stop.partial', { money: flow(summary.refunded, sub.currency) });
  return summary.unusedValue > 0 ? t('core.stop.unrefunded', { money: flow(-summary.unusedValue, sub.currency) }) : t('core.stop.refundNo');
}

/** 与 stopLabel 同一句话，金额单独加粗着色：未退款损失为红色（与时间轴灰段金额一致），已退款为绿色 */
export function StopText({ sub, today }: { sub: Subscription; today: string }) {
  const summary = stopSummary(sub, today);
  if (!summary || summary.date > today || (isPostpaid(sub) && summary.refunded <= 0)) return null;
  const [key, money, tone] =
    summary.refunded > 0
      ? [summary.refundStatus === 'full' ? 'core.stop.refunded' : 'core.stop.partial', flow(summary.refunded, sub.currency), 'gain']
      : summary.unusedValue > 0
        ? ['core.stop.unrefunded', flow(-summary.unusedValue, sub.currency), 'loss']
        : ['core.stop.refundNo', '', ''];
  if (!money) return <>{t(key)}</>;
  const [before, after = ''] = t(key, { money: '\u0000' }).split('\u0000');
  return (
    <>
      {before}
      <b className={`stop-money ${tone}`}>{money}</b>
      {after}
    </>
  );
}

export function stopDescription(sub: Subscription, today: string): string {
  const summary = stopSummary(sub, today);
  if (!summary) return '';
  return [
    cnDateFull(summary.date),
    t(summary.kind === 'terminate' ? 'core.stop.terminate' : 'core.stop.cancel'),
    summary.reason ? `(${summary.reason})` : '',
    summary.refundStatus === 'full'
      ? t('core.stop.fullyRefunded')
      : summary.refunded > 0
        ? t('core.stop.partial', { money: flow(summary.refunded, sub.currency) })
        : isPostpaid(sub)
          ? ''
          : t('core.stop.refundNo'),
    summary.unusedValue > 0
      ? t('core.stop.unused', { days: t('core.stop.lossDays', { count: summary.wastedDays }), money: flow(-summary.unusedValue, sub.currency) })
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function StopBadge({ sub, today }: { sub: Subscription; today: string }) {
  const cur = currentPhase(sub, today);
  const label = stopLabel(cur, today);
  return label ? (
    <span className="badge stop-badge" title={stopDescription(cur, today)}>
      <StopText sub={cur} today={today} />
    </span>
  ) : null;
}

/** Standalone detail action: fields plus an explicit confirmation. */
export function StopPanel({ sub, today, onApply }: { sub: Subscription; today: string; onApply: (s: Subscription) => unknown }) {
  const [form, setForm] = useState(() => stopForm(sub, today, getState()));
  const ended = isStopped(effectiveStatus(sub, today));
  const stops = phaseSubs(sub).filter((p) => p.stop);
  const [busy, submit] = useSubmit();
  const apply = () =>
    submit(() => {
      try {
        return onApply(applyStopForm(sub, form, today));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  const restore = () => submit(() => onApply(reactivate(sub, today)));
  if (sub.stop || ended)
    return (
      <div className="stop-panel">
        {stops.map((p) => (
          <div className="stop-summary" key={p.start}>
            <b>{stopDescription(p, today)}</b>
            {!isPostpaid(p) && <small>{t('core.stop.paidThrough', { date: cnDateFull(p.stop!.paidThrough) })}</small>}
          </div>
        ))}
        {sub.stop?.kind !== 'terminate' && sub.status !== 'terminated' && (
          <div className="cell">
            <button type="button" className="btn" disabled={busy} onClick={restore}>
              {t('core.stop.restore')}
            </button>
          </div>
        )}
      </div>
    );
  return (
    <div className="stop-panel">
      <StopFields sub={sub} today={today} value={form} onChange={setForm} />
      <div className="cell sheet-actions">
        {sub.end && (
          <button type="button" className="btn" disabled={busy} onClick={restore}>
            {t('core.stop.restore')}
          </button>
        )}
        <button type="button" className="btn primary" disabled={busy} onClick={apply}>
          {t('core.stop.title')}
        </button>
      </div>
    </div>
  );
}

/** Controlled fields: the editor owns this draft and submits it with Done. */
export function StopFields({ sub, today, value, onChange }: { sub: Subscription; today: string; value: StopForm; onChange: (value: StopForm) => void }) {
  const { mode, date, refund, amount, refundDate, reason, settled, settledCurrency } = value;
  const up = (patch: Partial<StopForm>) => onChange({ ...value, ...patch });
  const { cur, period, summary: preview } = stopPreview(sub, value, today);
  const priorRefunds = cur.stop ? (cur.payments?.filter((p) => p.kind === 'refund' && p.date >= cur.stop!.date).length ?? 0) : 0;
  const terminated = sub.stop?.kind === 'terminate' || sub.status === 'terminated';
  // 后付费：没有预付期，不提示已付至、续费日扣款与退款，最后一张账单照出
  const postpaid = isPostpaid(cur);
  return (
    <div className="stop-panel">
      <Cell label={t('core.stop.method')}>
        <Picker
          value={mode}
          onChange={(v) => {
            up({
              mode: v as StopMode,
              date: v === 'nonrenew' ? nonrenewalDate(sub, today) : today,
              amount: sub.stop ? amount : undefined,
              refundDate: sub.stop ? refundDate : undefined,
            });
          }}
          options={(terminated ? (['terminate'] as const) : (['nonrenew', 'cancel', 'terminate'] as const)).map((value) => ({
            value,
            label: t(`core.stop.${value}`),
          }))}
          ariaLabel={t('core.stop.method')}
        />
      </Cell>
      <Cell
        label={t('core.stop.date')}
        // 结束日当天正好是续费日时仍会扣款：提醒改成前一天
        sub={
          mode === 'nonrenew' &&
          !postpaid &&
          chargesBetween({ ...cur, end: undefined, stop: undefined, status: sub.status === 'trial' ? 'trial' : 'active' }, date, date, today).some(
            (c) => !c.kind && c.amount > 0,
          ) ? (
            <span className="stop-warn">{t('core.stop.chargeOnEnd')}</span>
          ) : undefined
        }
      >
        <DatePicker
          value={date}
          onChange={(value) => {
            if (value) {
              up({ date: value, amount: sub.stop ? amount : undefined });
            }
          }}
        />
      </Cell>
      {mode === 'nonrenew' && !postpaid && renewalDates(sub, today).cancelBy && today > renewalDates(sub, today).cancelBy! && (
        <p className="stop-warn">{t('core.renewal.tooLate')}</p>
      )}
      {mode !== 'nonrenew' && (
        <>
          {!postpaid && <p className="stop-hint">{t('core.stop.paidThrough', { date: cnDateFull(period.paidThrough) })}</p>}
          {mode === 'terminate' && (
            <Cell label={t('core.stop.reason')}>
              <input value={reason} onChange={(e) => up({ reason: e.target.value })} />
            </Cell>
          )}
          {!postpaid && (
            <Cell label={t('editor.payment.kind.refund')} sub={priorRefunds > 1 ? t('core.stop.latestRefundHint') : undefined}>
              <Picker
                value={refund ? 'yes' : 'no'}
                onChange={(v) => up({ refund: v === 'yes' })}
                options={[
                  { value: 'no', label: t('core.stop.refundNo') },
                  { value: 'yes', label: t('core.stop.refundYes') },
                ]}
                ariaLabel={t('editor.payment.kind.refund')}
              />
            </Cell>
          )}
          {refund && !postpaid && (
            <>
              <Cell label={`${t('core.stop.refundAmount')}\n${cur.currency}`} sub={t('core.stop.currencyHint', { currency: cur.currency })}>
                <input
                  className="num"
                  inputMode="decimal"
                  value={amount ?? String(preview!.suggestedRefund)}
                  onChange={(e) => up({ amount: e.target.value })}
                />
              </Cell>
              <Cell label={t('core.stop.refundDate')}>
                <DatePicker value={refundDate ?? date} min={date} onChange={(v) => up({ refundDate: v })} />
              </Cell>
              <Cell label={t('editor.payment.settledCcy')}>
                <CurrencySelect value={settledCurrency} onChange={(v) => up({ settledCurrency: v })} />
              </Cell>
              <Cell label={t('editor.payment.settledAmount')}>
                <input
                  className="num"
                  inputMode="decimal"
                  value={settled}
                  placeholder={t('editor.field.optional')}
                  onChange={(e) => up({ settled: e.target.value })}
                />
              </Cell>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Transient stop fields owned by the editor or the standalone stop dialog.
import { nonrenewalDate, pausedFromOf, stopBillingPeriod, currentPhase, effectiveStatus, stopSummary, subError, undatedStop } from './billing.ts';
import { cancelAtEnd, reopenStopped, statusChangeError, stopSubscription } from './phases.ts';
import { t } from './i18n.ts';
import { settlementCurrencyOf } from './fx.ts';
import { DEFAULT_SETTINGS, type AppState } from './types.ts';
import type { Subscription } from './types.ts';

export type StopMode = 'nonrenew' | 'cancel' | 'terminate';
export interface StopForm {
  mode: StopMode;
  date: string;
  refund: boolean;
  amount?: string;
  refundDate?: string;
  reason: string;
  settled: string;
  settledCurrency: string;
  /** 日期未知时表单里的日期只是占位，用户动过才算数 */
  dateUnset?: boolean;
}

/** Existing refunds remain ordinary payment records; the fields edit the latest stop refund. */
export function stopForm(
  sub: Subscription,
  today: string,
  state: Pick<AppState, 'methods' | 'settings'> = { methods: [], settings: DEFAULT_SETTINGS },
): StopForm {
  const cur = currentPhase(sub, sub.stop?.date ?? today);
  const paid = nonrenewalDate(cur, today);
  const payment = cur.stop ? cur.payments?.filter((p) => p.kind === 'refund' && p.date >= cur.stop!.date).at(-1) : undefined;
  return {
    mode: sub.stop?.kind ?? (sub.status === 'terminated' ? 'terminate' : 'nonrenew'),
    date: sub.stop?.date ?? sub.end ?? (undatedStop(sub) ? today : paid),
    refund: !!payment,
    amount: payment ? String(-payment.amount) : undefined,
    refundDate: payment?.date,
    reason: sub.stop?.reason ?? '',
    settled: payment?.settled ? String(-payment.settled.amount) : '',
    settledCurrency: payment?.settled?.currency ?? settlementCurrencyOf(state, cur.currency, payment?.methodId ?? cur.methodId),
    dateUnset: undatedStop(sub) && !sub.stop ? true : undefined,
  };
}

export function stopPreview(sub: Subscription, form: StopForm, today: string) {
  const cur = currentPhase(sub, form.date);
  const period = stopBillingPeriod(cur, form.date, today);
  return {
    cur,
    period,
    summary: stopSummary({ ...cur, stop: { kind: form.mode === 'terminate' ? 'terminate' : 'cancel', date: form.date, paidThrough: period.paidThrough } })!,
  };
}

/** 结算币种只是默认值，随设置变化；没填实退金额时不算改动 */
const stopFormKey = (f: StopForm) => JSON.stringify({ ...f, settledCurrency: f.settled ? f.settledCurrency : '', date: f.dateUnset ? '' : f.date });
const sameStopForm = (a: StopForm, b: StopForm) => stopFormKey(a) === stopFormKey(b);

/** Validate only on the owner's submit. Never persist partial date or amount inputs. */
export function applyStopForm(sub: Subscription, form: StopForm, today: string): Subscription {
  // 表单没动就不写：日期未知的停用尤其不能因为保存别的字段变成今天
  if (sameStopForm(form, stopForm(sub, today)) && (sub.stop || undatedStop(sub) || (sub.status === 'cancelled' && sub.end))) return sub;
  const terminated = sub.stop?.kind === 'terminate' || sub.status === 'terminated';
  if (terminated && form.mode !== 'terminate') throw new Error(t('mcp.error.terminatedReactivate'));
  let open = sub;
  if (sub.stop || sub.end || sub.status === 'cancelled' || sub.status === 'terminated') {
    // Reopen only this local calculation; the resulting record must still pass the provider-termination constraint.
    open = reopenStopped(sub);
    // 只是改停用信息，不是恢复订阅：暂停的事实留着
    const pausedAt = pausedFromOf(sub);
    if (pausedAt) open = { ...open, status: 'paused', pausedAt };
  }
  if (form.mode === 'nonrenew') return cancelAtEnd(open, form.date, today);
  const { summary } = stopPreview(sub, form, today);
  if (
    form.refund &&
    (form.amount === '' || !Number.isFinite(Number(form.amount ?? summary.suggestedRefund)) || Number(form.amount ?? summary.suggestedRefund) < 0)
  )
    throw new Error(t('mcp.error.invalidRefund'));
  if (form.refund && form.settled !== '' && (!Number.isFinite(Number(form.settled)) || Number(form.settled) < 0)) throw new Error(t('mcp.error.invalidRefund'));
  // Replace just the latest refund shown in the fields; retain all other payments and earlier refunds.
  const cur = currentPhase(sub, sub.stop?.date ?? today);
  const previous = cur.stop ? cur.payments?.filter((p) => p.kind === 'refund' && p.date >= cur.stop!.date).at(-1) : undefined;
  if (previous) {
    const index = cur.payments!.indexOf(previous);
    const payments = cur.payments!.filter((_, i) => i !== index);
    if (open.phases?.length) {
      const phases = open.phases.map((p) => (p.start === cur.start ? { ...p, payments } : p));
      open = { ...open, phases };
    } else open = { ...open, payments };
  }
  const next = stopSubscription(
    open,
    today,
    form.mode,
    form.date,
    form.reason,
    form.refund
      ? {
          amount: Number(form.amount ?? summary.suggestedRefund),
          date: form.refundDate ?? form.date,
          settled: form.settled !== '' ? { amount: Number(form.settled), currency: form.settledCurrency } : undefined,
        }
      : undefined,
  );
  const error = subError(next) ?? statusChangeError(sub, next, today);
  if (error) throw new Error(error);
  return next;
}

/** Changes to an existing stop; omitted fields keep the recorded values. */
export interface StopEdit {
  mode: StopMode;
  date?: string;
  reason?: string | null;
  refund?: { amount: number; date?: string; currency?: string; settled?: { amount: number; currency: string } } | null;
}

/**
 * Edit an already stopped subscription through the same reopen-then-stop path as the web stop fields.
 * Provider termination stays termination; an undated stop needs an explicit date.
 */
export function editStop(sub: Subscription, edit: StopEdit, today: string): Subscription {
  const stopped = !!sub.stop || sub.status === 'cancelled' || sub.status === 'terminated' || effectiveStatus(sub, today) === 'ended';
  if (!stopped) throw new Error(t('mcp.error.notStopped'));
  if (edit.date === undefined && !sub.stop && !sub.end) throw new Error(t('mcp.error.editStopDate'));
  if (edit.mode === 'nonrenew' && edit.refund) throw new Error(t('mcp.error.invalidStop'));
  if (edit.mode !== 'terminate' && edit.reason) throw new Error(t('mcp.error.invalidStop'));
  const form = stopForm(sub, today);
  const next: StopForm = {
    ...form,
    mode: edit.mode,
    date: edit.date ?? form.date,
    dateUnset: edit.date === undefined ? form.dateUnset : undefined,
    reason: edit.mode !== 'terminate' ? '' : edit.reason === undefined ? form.reason : (edit.reason ?? ''),
  };
  // A kept refund dated on the stop day moves with the stop date; other refund dates stay as recorded.
  if (edit.refund === undefined && form.refund && form.refundDate === form.date) next.refundDate = next.date;
  if (edit.refund === null) Object.assign(next, { refund: false, amount: undefined, refundDate: undefined, settled: '' });
  else if (edit.refund) {
    const r = edit.refund;
    if (r.currency && r.currency !== currentPhase(sub, sub.stop?.date ?? next.date).currency) throw new Error(t('mcp.error.refundCurrency'));
    Object.assign(next, {
      refund: true,
      amount: String(r.amount),
      refundDate: r.date ?? next.date,
      settled: r.settled ? String(r.settled.amount) : '',
      settledCurrency: r.settled?.currency ?? form.settledCurrency,
    });
  }
  return applyStopForm(sub, next, today);
}

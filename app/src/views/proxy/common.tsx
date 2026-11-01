import { formatTotal, scaleTotal, totalNote } from '../../../../shared/fx-total.ts';
import { effectiveStatus, nextCharge, isStopped } from '../../../../shared/billing.ts';
import { cnDate } from '../../../../shared/format.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Metric } from '../../components/ui.tsx';
import { proxyRows, proxyTotals, type ProxyRow } from '../../../../shared/proxy.ts';
import { t } from '../../../../shared/i18n.ts';

/** 代付的状态文案：进行中、到期停付、已停止是代付自己的说法，其余沿用订阅状态 */
export const statusLabel = (st: string): string => (['active', 'ending', 'ended'].includes(st) ? t(`proxy.status.${st}`) : t(`list.status.${st}`));

export type Row = ProxyRow;

export const rows = proxyRows;

/** 某个代付订阅还有几期没收回 */
export function proxyOwed(state: AppState, s: Subscription, today: string): number {
  return rows(state, s, today).filter((r) => r.receivedBase == null).length;
}

/** 代付总账：待收多少、收回的钱和实扣相比赚了还是亏了 */
export function proxySummary(state: AppState, today: string) {
  // 进行中的在前，已停止的排到最后
  const subs = state.subscriptions
    .filter((s) => s.proxy)
    .sort((a, b) => Number(isStopped(effectiveStatus(a, today))) - Number(isStopped(effectiveStatus(b, today))));
  const all = subs.flatMap((s) => rows(state, s, today));
  const { done, open, charged, owed, received, diff, lastIn, partial } = proxyTotals(all);
  const live = subs.filter((s) => !isStopped(effectiveStatus(s, today)));
  return {
    partial,
    subs,
    live: live.length,
    next: live.map((s) => nextCharge(s, today)).reduce<string | undefined>((a, d) => (d && (!a || d < a) ? d : a), undefined),
    lastIn,
    closedCount: done.length,
    count: all.length,
    charged,
    owed,
    owedCount: open.length,
    received,
    diff,
  };
}

/**
 * 右上角的状态胶囊：已停止 > 待收 > 已预收到哪期 > 已结清（各期都收回）；其余按订阅状态，计费中不显示。
 * 结清后第三格改为盈亏，「已结清」只在这里说一次
 */
export function proxyStatus(st: string, list: Row[], ahead: Row[]): ['stop' | 'owe' | 'done' | 'ok' | 'notice', string] {
  if (isStopped(st)) return ['stop', t('proxy.status.ended')];
  if (list.some((r) => r.receivedBase == null)) return ['owe', t('proxy.owed')];
  if (ahead.length) return ['done', t('proxy.prepaidTo', { date: cnDate(ahead[0].date) })];
  if (list.length) return ['done', t('proxy.settled')];
  return [st === 'active' || st === 'lifetime' ? 'ok' : 'notice', statusLabel(st)];
}

/**
 * 第三格：还有没收的期就是待收；全部结清后不再写「已结清」，改为这笔代付最终赚了还是亏了（收回 − 实扣）
 */
export function OwedOrNet({ list, base, exact = false }: { list: Row[]; base: string; exact?: boolean }) {
  const { open, diff: net, partial } = proxyTotals(list);
  if (open.length)
    return (
      <Metric
        label={t('proxy.owedPeriods', { count: open.length })}
        value={formatTotal(partial.owed, base, { compact: !exact, main: true, approx: true })}
        note={totalNote(partial.owed) || (exact ? t('proxy.page.owedRate') : undefined)}
        valueClassName="warn"
      />
    );
  // 走到这里各期都已收回，盈亏就是全部期的收回 − 实扣
  const even = Math.abs(net) < 0.5;
  return (
    <Metric
      label={t('family.strip.profit')}
      value={even ? t('proxy.table.even') : formatTotal(partial.diff, base, { direction: 1, compact: !exact, main: true })}
      // 持平时不写平均每期（会显示成 −¥0.00）
      note={
        totalNote(partial.diff) ||
        (exact && list.length && !even
          ? t('proxy.page.perPeriod', { amount: formatTotal(scaleTotal(partial.diff, 1 / list.length), base, { direction: 1, average: true }) })
          : undefined)
      }
      valueClassName={partial.diff.incomplete || even ? '' : net > 0 ? 'done' : 'loss'}
    />
  );
}

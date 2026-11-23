// 合同期：与付费周期分开的签约期限（如年险月付）。只用于展示与续约提醒，扣款、历史与统计都不读它。
import { addDays, currentPhase, cycleDays, diffDays, effectiveStatus, isStopped, nthCharge, pausedFromOf, phaseSubs, undatedStop } from './billing.ts';
import { availActiveSpans, availCoversDay, availPausedOn } from './bundle.ts';
import type { Contract, Subscription } from './types.ts';

export interface ContractTerm {
  /** 第几期合同，0 为首期 */
  index: number;
  from: string;
  /** 本期最后一天（含） */
  until: string;
  /** 下一期开始日，也就是续约日；不续约时是合同失效的第一天 */
  next: string;
  renews: boolean;
  /** 续约（或到期）提醒日；没设提醒时没有 */
  noticeBy?: string;
}

/** day 所在的合同期；开始日之前算首期，不续约的合同期满后没有 */
export function contractTerm(c: Contract, day: string): ContractTerm | undefined {
  const at = (k: number) => nthCharge(c.start, c.term, k);
  let k = day <= c.start ? 0 : Math.max(0, Math.floor(diffDays(c.start, day) / cycleDays(c.term)) - 1);
  while (at(k + 1) <= day) k++;
  while (k > 0 && at(k) > day) k--;
  const renews = c.renew !== 'none';
  if (!renews && k > 0) return undefined;
  const next = at(k + 1);
  const until = addDays(next, -1);
  return { index: k, from: at(k), until, next, renews, noticeBy: noticeDay(c.noticeDays, renews ? next : until) };
}

/** 续约提醒按续约日倒数，到期提醒按最后一天倒数 */
const noticeDay = (days: number | undefined, day: string) => (days != null ? addDays(day, -days) : undefined);

/** 同一份合同：起始日与期限相同（换套餐沿用时是同一份） */
const same = (a: Contract | undefined, b: Contract) => !!a && a.start === b.start && a.term.unit === b.term.unit && a.term.every === b.term.every;

/** day 仍在服务内、且带着这份合同的阶段（跟随父订阅的阶段同步检查父可用期） */
const contractPhaseAt = (s: Subscription, day: string, c: Contract) =>
  phaseSubs(s).findLast((p) => same(p.contract, c) && p.start <= day && (!p.end || day <= p.end) && (!p.bundleAvail || availCoversDay(p.bundleAvail, day)));

/** 今天的合同期；订阅已停、买断或今天不在合同期内时没有。订阅在续约日前结束时不算续约 */
export function currentContract(s: Subscription, today: string): ContractTerm | undefined {
  const status = effectiveStatus(s, today);
  if (isStopped(status) || status === 'lifetime' || undatedStop(s)) return undefined;
  const c = currentPhase(s, today).contract;
  const term = c && contractTerm(c, today);
  if (!term || !term.renews || contractPhaseAt(s, term.next, c)) return term;
  // 不再续约：服务正好跑到合同最后一天时提醒到期；更早结束的不提醒，与 contractEvents 一致
  const end = contractPhaseAt(s, today, c)?.end;
  return { ...term, renews: false, noticeBy: end && end < term.until ? undefined : noticeDay(c.noticeDays, term.until) };
}

export interface ContractEvent {
  /** renew：date 起续约新一期；end：合同期满不再续，date 是失效的第一天 */
  kind: 'renew' | 'end';
  date: string;
  /** 刚结束的这一期 */
  from: string;
  until: string;
  noticeDays?: number;
}

/** [from, to] 内的合同续约与到期；未知停用日、暂停后的未来日子不预测 */
export function contractEvents(s: Subscription, from: string, to: string, today: string): ContractEvent[] {
  const out = new Map<string, ContractEvent>();
  const paused = pausedFromOf(s);
  const undated = undatedStop(s);
  for (const p of phaseSubs(s)) {
    const c = p.contract;
    if (!c || c.start > to) continue;
    const avail = p.bundleAvail;
    let availEnd: string | undefined;
    if (avail) {
      const activeSpans = availActiveSpans(p.start, p.end, avail);
      if (!activeSpans.length) continue;
      if (!activeSpans.some((sp) => !sp.to)) availEnd = activeSpans.at(-1)!.to;
    }
    const first = contractTerm(c, from < c.start ? c.start : from);
    for (let k = Math.max(1, first ? first.index : 1), n = 0; n < 1200; k++, n++) {
      if (c.renew === 'none' && k > 1) break;
      const date = nthCharge(c.start, c.term, k);
      if (date > to) break;
      if (date < from) continue;
      if (date >= today && (undated || (paused && paused <= date) || avail?.undatedStop || (avail && availPausedOn(avail, date)))) break;
      const until = addDays(date, -1);
      const prev = nthCharge(c.start, c.term, k - 1);
      // 这一期须在本阶段里跑过；续约日落在别的阶段时由那一段（或下一轮循环）负责
      if ((p.end && until > p.end) || (availEnd && until > availEnd)) break;
      if (until < p.start || (avail && !availCoversDay(avail, until))) continue;
      const renewing = c.renew !== 'none' && !!contractPhaseAt(s, date, c);
      const kind = renewing ? 'renew' : c.renew === 'none' || p.end === until ? 'end' : undefined;
      if (kind && !out.has(date)) out.set(date, { kind, date, from: prev, until, noticeDays: c.noticeDays });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

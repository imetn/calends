// 记收款、免收、改删收款、记代付实扣：合租成员与代付共用。界面与 MCP / AI 助手都走这里，校验只在一处。
// 纯函数，不碰存储；返回改好的订阅，由调用方写入。
import { addMonths, collectCurrencyOf, collectionAnchor, memberLedger, validDay } from './billing.ts';
import { bundleView } from './bundle.ts';
import { periodsTotal } from './carpool.ts';
import { convertOn } from './fx.ts';
import { t } from './i18n.ts';
import { proxyLedger } from './proxy.ts';
import { isSettled, putRecord, removeRecord, resolveKey, type LedgerPeriod, type Receivable } from './receivables.ts';
import type { AppState, ProxyCharge, Receipt, ShareMember, Subscription, Waiver } from './types.ts';

/** 往后最多推算多少年的期，用来提前收、提前免 */
const AHEAD_YEARS = 10;

/** 一笔应收账：合租里的一位成员，或一笔代付 */
export type ReceivableTarget = { kind: 'share'; member: ShareMember } | { kind: 'proxy' };

/** 这笔账的各期（含 through 之前的未来期）、现有收款与免收，以及把新的记录写回订阅的方法 */
export function receivableOf(st: AppState, s: Subscription, target: ReceivableTarget, today: string, through = addMonths(today, 12 * AHEAD_YEARS)) {
  const ccy = collectCurrencyOf(st.settings);
  if (target.kind === 'proxy') {
    if (!s.proxy) throw new Error(t('mcp.error.notProxy', { name: s.name }));
    const proxy = s.proxy;
    const { periods, unmatched } = proxyLedger(s, today, through);
    return { periods, unmatched, record: proxy as Receivable, save: (r: Receivable): Subscription => ({ ...s, proxy: { ...proxy, ...r } }) };
  }
  if (!s.share || s.share.role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
  const share = s.share;
  const m = target.member;
  const vs = bundleView(s, st.subscriptions);
  const { periods, unmatched } = memberLedger(vs, m, today, ccy, through);
  return {
    periods,
    unmatched,
    record: m as Receivable,
    // 收款节奏的基准日写死：以后改成员、改规则都不会让已经收过的期挪位置
    save: (r: Receivable): Subscription => ({
      ...s,
      share: { ...share, collectFrom: collectionAnchor(s), members: share.members.map((x) => (x.id === m.id ? { ...x, ...r } : x)) },
    }),
  };
}

/** 没指定哪几期时：从最早没结清的期起取 count 期（先补欠着的，再往后提前收） */
export function openPeriods(periods: LedgerPeriod[], count: number): LedgerPeriod[] {
  const open = periods.filter((p) => !isSettled(p));
  if (open.length < count) throw new Error(t('mcp.error.periodsShort', { count: open.length }));
  return open.slice(0, count);
}

export interface ReceiptInput {
  id: string;
  date: string;
  /** 缺省按这几期的应收合计（折成 currency） */
  amount?: number;
  currency?: string;
  periods: string[];
  note?: string;
}

/** 记一笔收款（id 已存在则替换）：金额缺省为这几期应收的合计，币种缺省同应收 */
export function recordReceipt(st: AppState, s: Subscription, target: ReceivableTarget, input: ReceiptInput, today: string) {
  if (!validDay(input.date)) throw new Error(t('mcp.error.invalidTarget'));
  const r = receivableOf(st, s, target, today);
  // 期可以写这一期里的任何一天（与 putRecord 同一套 resolveKey），默认金额按对上的期算，不会因为没写起始日变成 0
  const picked = input.periods.map((k) => r.periods.find((p) => p.key === resolveKey(r.periods, k))).filter((p): p is LedgerPeriod => !!p);
  const total = periodsTotal(st, picked);
  const currency = (input.currency ?? total.currency).toUpperCase();
  const amount =
    input.amount ??
    (currency === total.currency ? total.amount : Math.round(convertOn(total.amount, total.currency, currency, input.date, st.fxHistory, st.fx) * 100) / 100);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(t('mcp.error.invalidTarget'));
  const old = r.record.receipts?.find((x) => x.id === input.id);
  const receipt: Receipt = { id: input.id, date: input.date, amount, currency, periods: input.periods, ...(input.note ? { note: input.note } : {}) };
  return { after: r.save(putRecord(r.record, 'receipt', receipt, r.periods)), before: old ?? null, record: receipt };
}

/** 免收这几期（id 已存在则替换） */
export function recordWaiver(st: AppState, s: Subscription, target: ReceivableTarget, input: Omit<Waiver, 'periods'> & { periods: string[] }, today: string) {
  if (!validDay(input.date)) throw new Error(t('mcp.error.invalidTarget'));
  const r = receivableOf(st, s, target, today);
  const old = r.record.waivers?.find((x) => x.id === input.id);
  const waiver: Waiver = { id: input.id, date: input.date, periods: input.periods, ...(input.note ? { note: input.note } : {}) };
  return { after: r.save(putRecord(r.record, 'waiver', waiver, r.periods)), before: old ?? null, record: waiver };
}

/** 删掉一笔收款或免收，那几期恢复为没结清 */
export function deleteRecord(st: AppState, s: Subscription, target: ReceivableTarget, id: string, today: string) {
  const r = receivableOf(st, s, target, today);
  const old = [...(r.record.receipts ?? []), ...(r.record.waivers ?? [])].find((x) => x.id === id);
  return { after: r.save(removeRecord(r.record, id)), before: old ?? null, record: null };
}

/** 记代付某一期卡上的实扣（必须是一次扣款的日期）；amount 为空则去掉这条修正，按订阅价算 */
export function recordProxyCharge(s: Subscription, c: ProxyCharge, today: string) {
  if (!s.proxy) throw new Error(t('mcp.error.notProxy', { name: s.name }));
  if (!validDay(c.charge) || (c.amount != null && (!Number.isFinite(c.amount) || c.amount < 0))) throw new Error(t('mcp.error.invalidTarget'));
  if (!proxyLedger(s, today, c.charge).periods.some((p) => p.key === c.charge)) throw new Error(t('mcp.error.periodUnknown', { period: c.charge }));
  const old = s.proxy.charged?.find((x) => x.charge === c.charge);
  const rest = (s.proxy.charged ?? []).filter((x) => x.charge !== c.charge);
  const keep = c.amount != null || c.note;
  const charged = [...rest, ...(keep ? [c] : [])].sort((a, b) => a.charge.localeCompare(b.charge));
  return { after: { ...s, proxy: { ...s.proxy, charged } }, before: old ?? null, record: keep ? c : null };
}

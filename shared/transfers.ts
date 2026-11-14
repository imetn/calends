import { amountTotal, chargesTotal, scaleTotal, sumTotals, type FxTotal } from './fx-total.ts';
import { DAYS_PER_MONTH } from './billing.ts';
// 转让收付：二手买入时付给原主的钱、卖出时收到的钱。都是实际现金，不推算剩余服务价值。
// 不是服务商扣款：不进 MRR、续费预测、余额消耗、退款与扣款笔数；只进生命周期净成本和年度、月度现金流。
import { cashChargesBetween, chargesBetween, CURRENCY_CODE, diffDays, isSeparate, paidServedDays, phaseSubs, servedTime, validDay } from './billing.ts';
import { chargeBaseOrNaN, convertOn } from './fx.ts';
import { t } from './i18n.ts';
import type { AppState, Subscription, Transfer } from './types.ts';

/** 按日期排好的转让记录（同一天保持存储顺序）；没有时为空 */
export function transfersOf(s: Pick<Subscription, 'transfers'>): Transfer[] {
  return (s.transfers ?? [])
    .map((tr, i) => ({ tr, i }))
    .sort((a, b) => a.tr.date.localeCompare(b.tr.date) || a.i - b.i)
    .map((x) => x.tr);
}

/** 现金方向：买入付出去为正（成本），卖出收回来为负 */
export const transferSign = (tr: Pick<Transfer, 'kind'>) => (tr.kind === 'buy' ? 1 : -1);

/** 转让当天汇率折成 to；历史缺失时回落当前汇率，仍缺则为 NaN，不当成 0 */
export function transferValue(state: AppState, tr: Transfer, to = state.settings.baseCurrency): number {
  return convertOn(tr.amount, tr.currency, to, tr.date, state.fxHistory, state.fx);
}

/** 最后一笔卖出的日期：那天起不再是我的（之后若又买入，则视为仍在持有） */
export function soldOn(s: Pick<Subscription, 'transfers'>): string | undefined {
  const last = transfersOf(s).at(-1);
  return last?.kind === 'sell' ? last.date : undefined;
}

/**
 * 持有期：起点取最早一笔买入（早于订阅开始时），终点取最后一笔卖出（不含当天），否则到今天。
 * 天数沿用实际在订天数（不算断档），买入早于开始的那段另加。
 */
export function holdingPeriod(s: Subscription, today: string): { from: string; until: string; days: number } {
  const buy = transfersOf(s).find((tr) => tr.kind === 'buy');
  const sold = soldOn(s);
  const until = sold && sold < today ? sold : today;
  const from = buy && buy.date < s.start ? buy.date : s.start;
  const lead = from < s.start ? Math.max(0, diffDays(from, s.start < until ? s.start : until)) : 0;
  return { from, until, days: servedTime(s, until).days + lead };
}

export interface NetCost {
  partial: FxTotal;
  currency: string;
  /** 服务商扣款（实扣、退款为负），同详情「累计」口径；有扣款缺汇率时为 NaN */
  service: number;
  /** 至今的服务扣款笔数：不含退款与失败 */
  charges: number;
  /** 买入付出的钱、卖出收回的钱（正数）；缺汇率时为 NaN */
  bought: number;
  sold: number;
  net: number;
  from: string;
  until: string;
  days: number;
  /** 月均、日均的分母：有转让时同持有期，否则算到预付已付那期结束（见 paidServedDays）；分开记时算到今天所在账单期结束 */
  spreadDays: number;
  /** 月均、日均的分子：一般同 partial；分开记时按账单，截至今天的各期应缴（含未缴，不含预缴的未来账单） */
  spread: FxTotal;
  perMonth: number;
  perDay: number;
  /** 有服务扣款或转让缺少可用汇率：本位币合计不可用 */
  incomplete: boolean;
}

/** 生命周期净成本 = 服务付款 + 买入 − 卖出；月均、日均按持有期摊（今天之后的转让不计） */
export function netCost(state: AppState, s: Subscription, today: string, to = state.settings.baseCurrency): NetCost {
  // 累计按实际付款：账单与缴费分开记时预缴的钱算进去，没缴的欠款不算
  const history = cashChargesBetween(s, s.start, today, today).filter((c) => c.kind !== 'failed');
  const service = history.reduce((a, c) => a + chargeBaseOrNaN(state, c, to), 0);
  let bought = 0;
  let sold = 0;
  for (const tr of transfersOf(s)) {
    if (tr.date > today) continue;
    const v = transferValue(state, tr, to);
    if (tr.kind === 'buy') bought += v;
    else sold += v;
  }
  const net = service + bought - sold;
  const held = holdingPeriod(s, today);
  // 分开记：均摊按账单算，缴早缴晚、欠没欠都不改变每月花多少（欠着的那期也算到它的账期结束）
  const billed = phaseSubs(s).some(isSeparate) ? chargesBetween(s, s.start, today, today).filter((c) => !c.kind) : undefined;
  const spreadDays = transfersOf(s).some((tr) => tr.date <= today)
    ? held.days
    : paidServedDays(s, billed?.map((c) => (c.unpaid ? { ...c, projected: false } : c)) ?? history, today);
  const traded = transfersOf(s)
    .filter((tr) => tr.date <= today)
    .map((tr) => scaleTotal(amountTotal(tr.amount, tr.currency, transferValue(state, tr, to)), transferSign(tr)));
  const partial = sumTotals([chargesTotal(state, history, to), ...traded]);
  const spread = billed ? sumTotals([chargesTotal(state, billed, to), ...traded]) : partial;
  const spreadNet = billed ? billed.reduce((a, c) => a + chargeBaseOrNaN(state, c, to), 0) + bought - sold : net;
  const perMonth = spreadNet / Math.max(1, spreadDays / DAYS_PER_MONTH);
  return {
    partial,
    spread,
    currency: to,
    service,
    charges: history.filter((c) => c.kind !== 'refund' && c.kind !== 'failed').length,
    bought,
    sold,
    net,
    ...held,
    spreadDays,
    perMonth,
    perDay: perMonth / DAYS_PER_MONTH,
    incomplete: !Number.isFinite(service) || !Number.isFinite(bought) || !Number.isFinite(sold),
  };
}

/**
 * 停止阶段的剩余服务是否已随卖出收回：卖出发生在该阶段开始到已付截止日之间。
 * 这时没有「已付未用」损失，钱已经算在卖出里。
 */
export function transferredStop(phase: Subscription): Transfer | undefined {
  if (!phase.stop) return undefined;
  return transfersOf(phase).find((tr) => tr.kind === 'sell' && tr.date >= phase.start && tr.date <= phase.stop!.paidThrough);
}

export interface TransferRow {
  sub: Subscription;
  date: string;
  /** 本位币，买入为正、卖出为负；缺汇率为 NaN */
  amount: number;
  transfer: Transfer;
}

/** [from, to] 内的转让现金（不含今天之后），供年度回顾、月报的现金流 */
export function transferRows(state: AppState, from: string, to: string, today: string): TransferRow[] {
  const end = to < today ? to : today;
  return state.subscriptions
    .filter((s) => !s.proxy)
    .flatMap((sub) =>
      transfersOf(sub)
        .filter((tr) => tr.date >= from && tr.date <= end)
        .map((transfer) => ({ sub, date: transfer.date, amount: transferSign(transfer) * transferValue(state, transfer), transfer })),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.sub.id.localeCompare(b.sub.id));
}

/** 保存前校验：种类、日期、正数金额、三位币种、备注为文本 */
export function transferError(s: Pick<Subscription, 'transfers'>): string | undefined {
  if (s.transfers == null) return undefined;
  if (!Array.isArray(s.transfers)) return t('core.subError.transfer');
  for (const tr of s.transfers) {
    if (
      !tr ||
      (tr.kind !== 'buy' && tr.kind !== 'sell') ||
      typeof tr.date !== 'string' ||
      !validDay(tr.date) ||
      typeof tr.amount !== 'number' ||
      !Number.isFinite(tr.amount) ||
      tr.amount <= 0 ||
      typeof tr.currency !== 'string' ||
      !CURRENCY_CODE.test(tr.currency) ||
      (tr.note != null && typeof tr.note !== 'string')
    )
      return t('core.subError.transfer');
  }
  return undefined;
}

/** 写入入口共用：去掉空备注、空列表 */
export function cleanTransfers(list: Transfer[] | undefined): Transfer[] | undefined {
  const out = (list ?? []).map(({ kind, date, amount, currency, note }) => ({
    kind,
    date,
    amount,
    currency: currency.toUpperCase(),
    ...(note?.trim() ? { note: note.trim() } : {}),
  }));
  return out.length ? out : undefined;
}

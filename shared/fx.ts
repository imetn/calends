// 历史汇率：每笔已发生的扣款按「扣款当天」的汇率折算，未来预测按当前汇率。
// 数据以 USD 为基准：rates[CCY] = 1 USD 可换多少 CCY。
import type { AppState, FxHistory, FxTable } from './types.ts';

export const FX_SOURCES = {
  /** fawazahmed0/currency-api：全币种（含 NGN），2024-03-02 起每日快照 */
  currencyApi: (d: string) => [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.min.json`,
    `https://${d}.currency-api.pages.dev/v1/currencies/usd.min.json`,
  ],
  /** Frankfurter（欧洲央行）：1999 年起，覆盖 CNY/TRY/PHP/USD 等主要币种，无 NGN */
  frankfurter: (d: string) => `https://api.frankfurter.dev/v1/${d}?base=USD`,
  currencyApiSince: '2024-03-02',
};

interface Index {
  /** 每个币种按日期升序的 [date, rate] */
  byCcy: Map<string, Array<[string, number]>>;
}

const cache = new WeakMap<FxHistory, Index>();

function index(h: FxHistory): Index {
  let idx = cache.get(h);
  if (idx) return idx;
  const byCcy = new Map<string, Array<[string, number]>>();
  for (const d of Object.keys(h).sort()) {
    for (const [c, r] of Object.entries(h[d])) {
      if (!(r > 0)) continue;
      let arr = byCcy.get(c);
      if (!arr) byCcy.set(c, (arr = []));
      arr.push([d, r]);
    }
  }
  idx = { byCcy };
  cache.set(h, idx);
  return idx;
}

/** 某币种在 date 当天（或之前最近一天，再不行取之后最近一天）的汇率 */
export function rateOn(h: FxHistory | undefined, ccy: string, date: string): { rate: number; date: string } | undefined {
  if (ccy === 'USD') return { rate: 1, date };
  if (!h) return undefined;
  const arr = index(h).byCcy.get(ccy);
  if (!arr?.length) return undefined;
  let lo = 0;
  let hi = arr.length - 1;
  if (date < arr[0][0]) return { rate: arr[0][1], date: arr[0][0] };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid][0] <= date) lo = mid;
    else hi = mid - 1;
  }
  return { rate: arr[lo][1], date: arr[lo][0] };
}

/** 按 date 当天汇率换算；缺历史数据时回落到当前汇率 */
export function convertOn(amount: number, from: string, to: string, date: string, h: FxHistory | undefined, current: FxTable): number {
  if (from === to) return amount;
  const a = rateOn(h, from, date)?.rate ?? current.rates[from];
  const b = rateOn(h, to, date)?.rate ?? current.rates[to];
  if (!a || !b) return NaN;
  return (amount / a) * b;
}

/** 解析两个数据源的响应，统一为大写币种、USD 基准 */
export function parseCurrencyApi(body: unknown, keep?: Set<string>): Record<string, number> | undefined {
  const usd = (body as { usd?: Record<string, number> })?.usd;
  if (!usd) return undefined;
  const out: Record<string, number> = { USD: 1 };
  for (const [k, v] of Object.entries(usd)) {
    const c = k.toUpperCase();
    if ((!keep || keep.has(c)) && typeof v === 'number' && v > 0) out[c] = v;
  }
  return out;
}

export function parseFrankfurter(body: unknown, keep?: Set<string>): Record<string, number> | undefined {
  const rates = (body as { rates?: Record<string, number> })?.rates;
  if (!rates) return undefined;
  const out: Record<string, number> = { USD: 1 };
  for (const [c, v] of Object.entries(rates)) if ((!keep || keep.has(c)) && v > 0) out[c] = v;
  return out;
}

/** 换算到 to（缺省本位币）：date 在未来或缺省时用当前汇率；折算不了（缺汇率）为 NaN，不当成 0 */
export function toBaseOrNaN(state: AppState, amount: number, ccy: string, date?: string, to = state.settings.baseCurrency): number {
  return date ? convertOn(amount, ccy, to, date, state.fxHistory, state.fx) : convertOn(amount, ccy, to, '9999-12-31', undefined, state.fx);
}

type ChargeLike = { amount: number; currency: string; date: string; paidOn?: string; projected: boolean; settled?: { amount: number; currency: string } };

/** 一笔扣款的本位币金额：已发生的按扣款当天汇率（记了卡上实扣时按实扣），预测的按当前汇率；缺汇率为 NaN */
export function chargeBaseOrNaN(state: AppState, c: ChargeLike, to = state.settings.baseCurrency): number {
  // 分开记的账单按实际缴费那天的汇率（paidOn），不按账单日
  const day = c.paidOn ?? c.date;
  // 记了卡上实际扣款时按它算：汇差、手续费都算进真实成本
  if (c.settled && !c.projected) return toBaseOrNaN(state, c.settled.amount, c.settled.currency, day, to);
  return toBaseOrNaN(state, c.amount, c.currency, c.projected ? undefined : day, to);
}

/** 旧口径：同 toBaseOrNaN，但缺汇率时返回 0。新代码用 toBaseOrNaN 并标记不完整 */
export function toBaseAt(state: AppState, amount: number, ccy: string, date?: string, to = state.settings.baseCurrency): number {
  const v = toBaseOrNaN(state, amount, ccy, date, to);
  return Number.isFinite(v) ? v : 0;
}

/** chargeValue() 折算不了（缺汇率）时为 true：那时它返回 0，调用方需要标记不完整而不是当成 0 */
export function chargeFxMissing(state: AppState, c: ChargeLike, to = state.settings.baseCurrency): boolean {
  return !Number.isFinite(chargeBaseOrNaN(state, c, to));
}

/** 旧口径：同 chargeBaseOrNaN，但缺汇率时返回 0。新代码用 chargeBaseOrNaN 并标记不完整 */
export function chargeValue(state: AppState, c: ChargeLike, to = state.settings.baseCurrency): number {
  const v = chargeBaseOrNaN(state, c, to);
  return Number.isFinite(v) ? v : 0;
}

/** Actual-card amount defaults to the selected account's currency, or base currency for a same-currency/no-card bill. */
export function settlementCurrencyOf(state: Pick<AppState, 'methods' | 'settings'>, billCurrency: string, methodId?: string): string {
  const currency = state.methods.find((m) => m.id === methodId)?.currency;
  return currency && currency !== billCurrency ? currency : state.settings.baseCurrency;
}

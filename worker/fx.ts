import { addDays, addMonths, chargesBetween, todayIn } from '../shared/billing.ts';
import { CURRENCIES } from '../shared/format.ts';
import { FX_SOURCES, parseCurrencyApi, parseFrankfurter } from '../shared/fx.ts';
import type { AppState, FxHistory, FxTable } from '../shared/types.ts';
import type { Env } from './env.ts';
import { t } from '../shared/i18n.ts';
import { edgeCache } from './http.ts';
import { getSettings, putKv } from './store.ts';

/** 需要保存的币种：常用列表 + 订阅和账户实际用到的 */
export function keepSet(state: Pick<AppState, 'subscriptions' | 'methods' | 'settings'>): Set<string> {
  return new Set([
    ...CURRENCIES,
    'USD',
    'CNY',
    state.settings.baseCurrency,
    ...state.subscriptions.map((s) => s.currency),
    ...state.methods.map((m) => m.currency),
  ]);
}

/** 需要历史汇率的日期：所有已发生的扣款日、每个月末（MRR 走势）、余额校准日 */
function neededDates(state: AppState): string[] {
  const today = todayIn(state.settings.timezone);
  const set = new Set<string>();
  let first = today;
  for (const s of state.subscriptions) {
    if (s.start < first) first = s.start;
    for (const c of chargesBetween(s, s.start, today, today)) set.add(c.date);
  }
  for (const m of state.methods) if (m.balanceAsOf && m.balanceAsOf <= today) set.add(m.balanceAsOf);
  for (let d = first.slice(0, 8) + '01'; d <= today; d = addMonths(d, 1)) {
    const end = addDays(addMonths(d, 1), -1);
    set.add(end < today ? end : today);
  }
  return [...set].sort();
}

export function slimFxHistory(rows: Array<{ date: string; rates: string }>, keep: Set<string>): FxHistory {
  const out: FxHistory = {};
  for (const r of rows) {
    const all = JSON.parse(r.rates) as Record<string, number>;
    const slim: Record<string, number> = {};
    for (const c of keep) if (all[c]) slim[c] = all[c];
    out[r.date] = slim;
  }
  return out;
}

/** 写入某一天的历史汇率；同一天已有时覆盖 */
export function putFxDayStmt(env: Env, date: string, rates: Record<string, number>, source: string): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO fx_daily (date, rates, source) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET rates = excluded.rates, source = excluded.source',
  ).bind(date, JSON.stringify(rates), source);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, edgeCache(86400 * 30, true));
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/** 抓取某一天的汇率：2024-03-02 之后用全币种源，之前用欧洲央行 */
async function fetchDay(date: string, keep: Set<string>): Promise<{ rates: Record<string, number>; source: string } | undefined> {
  if (date >= FX_SOURCES.currencyApiSince) {
    for (const url of FX_SOURCES.currencyApi(date)) {
      try {
        const r = parseCurrencyApi(await getJson(url), keep);
        if (r && Object.keys(r).length > 3) return { rates: r, source: 'currency-api' };
      } catch {
        /* 换下一个镜像 */
      }
    }
  }
  try {
    const r = parseFrankfurter(await getJson(FX_SOURCES.frankfurter(date)), keep);
    if (r && Object.keys(r).length > 3) return { rates: r, source: 'ecb' };
  } catch {
    /* 返回 undefined，由调用方计入失败 */
  }
  return undefined;
}

export async function fxStatus(env: Env, state: AppState) {
  const need = neededDates(state);
  const rows = await env.DB.prepare('SELECT date, source FROM fx_daily').all<{ date: string; source: string }>();
  const have = new Map(rows.results.map((r) => [r.date, r.source]));
  const missing = need.filter((d) => !have.has(d));
  const sources: Record<string, number> = {};
  for (const d of need) {
    const s = have.get(d);
    if (s) sources[s] = (sources[s] ?? 0) + 1;
  }
  return { needed: need.length, covered: need.length - missing.length, missing, sources, first: need[0] };
}

/** 每次补齐一批，避免单次请求子请求过多；前端循环调用直到 remaining 为 0 */
export async function backfill(env: Env, state: AppState, batch = 24) {
  const st = await fxStatus(env, state);
  const keep = keepSet(state);
  // 新的日期优先：最近的账单最常看
  const todo = st.missing.slice().reverse().slice(0, batch);
  let filled = 0;
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i += 6) {
    const chunk = todo.slice(i, i + 6);
    const got = await Promise.all(chunk.map((d) => fetchDay(d, keep).then((r) => [d, r] as const)));
    const stmts = [];
    for (const [d, r] of got) {
      if (!r) {
        failed.push(d);
        continue;
      }
      stmts.push(putFxDayStmt(env, d, r.rates, r.source));
      filled++;
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  return { filled, failed, remaining: st.missing.length - filled - failed.length, needed: st.needed };
}

/** cron：把当天的实时汇率也记进历史 */
export async function recordToday(env: Env, fx: FxTable, tz: string): Promise<void> {
  await env.DB.prepare('INSERT INTO fx_daily (date, rates, source) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO NOTHING')
    .bind(todayIn(tz), JSON.stringify(fx.rates), 'er-api')
    .run();
}

/** 刷新当前汇率表，并把当天的汇率记进历史；接口出错时抛错，原表不变 */
export async function refreshFx(env: Env): Promise<FxTable> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', edgeCache(3600));
  // 非 2xx（限流、上游故障页）不去解析正文，直接按汇率接口出错处理，当前汇率表保持不变
  if (!res.ok) throw new Error(t('server.fxApiError'));
  const body = (await res.json().catch(() => ({}))) as { result?: string; rates?: Record<string, number> };
  if (body.result !== 'success' || !body.rates) throw new Error(t('server.fxApiError'));
  const fx: FxTable = { base: 'USD', rates: body.rates, fetchedAt: new Date().toISOString() };
  await putKv(env, 'fx', fx);
  await recordToday(env, fx, (await getSettings(env)).timezone);
  return fx;
}

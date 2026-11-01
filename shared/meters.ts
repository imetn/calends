// 业务数据：订阅上用户自定义的指标（电量、里程、出站流量……）与按期记录。
// 读数和付款分开存：服务器年付但按月看流量、车险一年一交但里程随时记。这里只放纯计算与校验，浏览器与 Worker 共用。
import { addDays, chargeServicePeriod, chargesBetween, fnv1a, isPostpaid, nthCharge, validDay } from './billing.ts';
import { t } from './i18n.ts';
import type { Charge } from './billing.ts';
import type { Meter, Reading, Subscription } from './types.ts';

/** 某个指标在一条记录上的派生结果 */
export interface MeterRow {
  reading: Reading;
  /** 记录里填的数：本期用量型是用量，累计读数型是读数 */
  value: number;
  /** 本期用量；累计读数型的首条、读数回退时没有 */
  usage?: number;
  /** 期间起点（不含）：上一条有该指标数值的记录日；本期用量型的首条为订阅开始前一天，累计读数型的首条没有 */
  since?: string;
  /** 期间 (since, date] 内实际扣款合计；同期没有扣款或混有多种币种时没有 */
  cost?: { amount: number; currency: string };
  /** 单价 = 费用 ÷ 本期用量；用量为 0 或缺失、没有费用时没有 */
  unitPrice?: number;
}

/** 按日期排好的记录（同一天保持存储顺序） */
export function readingsOf(s: Pick<Subscription, 'readings'>): Reading[] {
  return (s.readings ?? [])
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => a.date.localeCompare(b.date) || i - j)
    .map(([r]) => r);
}

/**
 * (from, to] 内已发生的实际扣款合计，按原币；排除扣款失败与预测；没有扣款或币种不一时返回 undefined。
 * 后付费的一笔按它结清的服务期末日归期：10 月 1 日交的 9 月电费，算进截至 9 月 30 日的那条记录
 */
export function costBetween(s: Subscription, from: string, to: string, today: string): { amount: number; currency: string } | undefined {
  if (to <= from) return undefined;
  const dayOf = (c: Charge) => (isPostpaid(c.sub) ? addDays(chargeServicePeriod(c.sub, c.date, c.serviceDate).until, -1) : c.date);
  // 后付费的账单在服务期之后才出，往后多取一年再按归期筛
  const charges = chargesBetween(s, addDays(from, 1), addDays(to, 400), today).filter((c) => {
    if (c.projected || c.kind === 'failed') return false;
    const day = dayOf(c);
    return day > from && day <= to;
  });
  if (!charges.length) return undefined;
  const currencies = new Set(charges.map((c) => c.currency));
  if (currencies.size !== 1) return undefined;
  return { amount: Math.round(charges.reduce((a, c) => a + c.amount, 0) * 1e6) / 1e6, currency: charges[0].currency };
}

function firstSince(s: Subscription, date: string): string {
  const open = addDays(s.start, -1);
  if (s.cycle.unit === 'lifetime') return open;
  const back = nthCharge(date, s.cycle, -1);
  return back > open ? back : open;
}

/** 一个指标逐条记录的本期用量与单价，按日期从早到晚 */
export function meterRows(s: Subscription, meter: Meter, today: string): MeterRow[] {
  const out: MeterRow[] = [];
  let prev: MeterRow | undefined;
  for (const reading of readingsOf(s)) {
    const value = reading.values[meter.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let usage: number | undefined = value;
    if (meter.kind === 'reading') {
      // 累计读数：与上一条有该指标的记录之差；首条没有用量，读数回退（换表、录错）不算成 0 或负数
      usage = prev ? value - prev.value : undefined;
      if (usage != null) usage = usage < 0 ? undefined : Math.round(usage * 1e6) / 1e6;
    }
    // 本期用量型的首条：期间往前推一个周期，最早到订阅开始；中途才开始记录时不把更早的扣款摊进来
    const since = prev?.reading.date ?? (meter.kind === 'reading' ? undefined : firstSince(s, reading.date));
    const cost = since ? costBetween(s, since, reading.date, today) : undefined;
    const row: MeterRow = { reading, value, ...(usage != null ? { usage } : {}), ...(since ? { since } : {}), ...(cost ? { cost } : {}) };
    if (cost && usage != null && usage > 0) row.unitPrice = cost.amount / usage;
    out.push(row);
    prev = row;
  }
  return out;
}

/** 指标汇总：最近一期、累计用量（可按记录日的时间窗 [from, to]）、最近有单价的一期 */
export function meterSummary(s: Subscription, meter: Meter, today: string, from?: string, to?: string) {
  const rows = meterRows(s, meter, today);
  const inWindow = rows.filter((r) => (!from || r.reading.date >= from) && (!to || r.reading.date <= to));
  const used = inWindow.filter((r) => r.usage != null);
  return {
    rows,
    latest: rows.at(-1),
    latestPriced: rows.findLast((r) => r.unitPrice != null),
    total: Math.round(used.reduce((a, r) => a + r.usage!, 0) * 1e6) / 1e6,
    /** 累计里实际计入的期数 */
    periods: used.length,
    from: inWindow[0]?.reading.date,
  };
}

/** 记录日落在 [from, until) 内的用量合计，供扣款记录按每笔覆盖的服务期显示用量；没有有用量的记录时返回 undefined */
export function usageWithin(rows: MeterRow[], from: string, until: string): number | undefined {
  const hit = rows.filter((r) => r.usage != null && r.reading.date >= from && r.reading.date < until);
  return hit.length ? Math.round(hit.reduce((a, r) => a + r.usage!, 0) * 1e6) / 1e6 : undefined;
}

/** 走势统计：平均每期用量、平均单价（有单价各期的费用合计 ÷ 用量合计）、用量最高的一期 */
export function meterStats(rows: MeterRow[]) {
  const used = rows.filter((r) => r.usage != null);
  const priced = rows.filter((r) => r.unitPrice != null);
  const currency = priced[0]?.cost!.currency;
  const same = priced.every((r) => r.cost!.currency === currency);
  const pricedUsage = priced.reduce((a, r) => a + r.usage!, 0);
  return {
    average: used.length ? used.reduce((a, r) => a + r.usage!, 0) / used.length : undefined,
    unitPrice:
      priced.length && same && pricedUsage > 0 ? { amount: priced.reduce((a, r) => a + r.cost!.amount, 0) / pricedUsage, currency: currency! } : undefined,
    peak: used.reduce<MeterRow | undefined>((m, r) => (!m || r.usage! > m.usage! ? r : m), undefined),
  };
}

/** 删除一个指标：同时从各条记录里删掉它的数值，删完没有数值的空记录一并删掉 */
export function removeMeter(s: Subscription, meterId: string): Subscription {
  const meters = (s.meters ?? []).filter((m) => m.id !== meterId);
  const readings = (s.readings ?? [])
    .map((r) => {
      if (!(meterId in r.values)) return r;
      const { [meterId]: _drop, ...values } = r.values;
      return { ...r, values };
    })
    .filter((r) => Object.keys(r.values).length > 0);
  return { ...s, meters: meters.length ? meters : undefined, readings: readings.length ? readings : undefined };
}

/** 用一组新的指标定义替换：不在新列表里的指标按 removeMeter 清掉历史数值 */
export function replaceMeters(s: Subscription, meters: Meter[]): Subscription {
  const keep = new Set(meters.map((m) => m.id));
  let next: Subscription = s;
  for (const m of s.meters ?? []) if (!keep.has(m.id)) next = removeMeter(next, m.id);
  return { ...next, meters: meters.length ? meters : undefined };
}

/** 稳定 id：同样的输入得到同样的 id（AI 预览与确认写入一致），与已有 id 冲突时顺延 */
export function stableId(prefix: string, seed: string, taken: Set<string>): string {
  for (let i = 0; ; i++) {
    const id = `${prefix}${fnv1a(`${seed}#${i}`).toString(36)}`;
    if (!taken.has(id)) return id;
  }
}

/** 名称 + 单位的组合，供添加指标时作为建议：别的订阅里用过的，按使用次数排序，排除本订阅已有的同名指标 */
export function meterSuggestions(subs: Subscription[], current?: Subscription): Array<Pick<Meter, 'name' | 'unit' | 'kind'>> {
  const own = new Set((current?.meters ?? []).map((m) => m.name.trim().toLowerCase()));
  const seen = new Map<string, { name: string; unit: string; kind?: 'reading'; count: number }>();
  for (const s of subs) {
    if (s.id === current?.id) continue;
    for (const m of s.meters ?? []) {
      const name = m.name.trim();
      if (!name || own.has(name.toLowerCase())) continue;
      const key = `${name.toLowerCase()}\u0000${m.unit.trim()}`;
      const hit = seen.get(key);
      if (hit) hit.count++;
      else seen.set(key, { name, unit: m.unit.trim(), ...(m.kind === 'reading' ? { kind: 'reading' as const } : {}), count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map(({ count: _c, ...m }) => m);
}

/** 写入校验：指标 id 唯一、名称非空；记录 id 唯一、日期合法、数值有限、只引用已定义的指标 */
export function meterError(s: Pick<Subscription, 'meters' | 'readings'>): string | undefined {
  if (s.meters == null && s.readings == null) return undefined;
  if (s.meters != null && !Array.isArray(s.meters)) return t('core.subError.meter');
  if (s.readings != null && !Array.isArray(s.readings)) return t('core.subError.reading');
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const m of s.meters ?? []) {
    if (
      !m ||
      typeof m.id !== 'string' ||
      !m.id ||
      ids.has(m.id) ||
      typeof m.name !== 'string' ||
      !m.name.trim() ||
      names.has(m.name.trim()) ||
      typeof m.unit !== 'string' ||
      (m.kind != null && m.kind !== 'reading')
    )
      return t('core.subError.meter');
    ids.add(m.id);
    names.add(m.name.trim());
  }
  const readingIds = new Set<string>();
  for (const r of s.readings ?? []) {
    if (
      !r ||
      typeof r.id !== 'string' ||
      !r.id ||
      readingIds.has(r.id) ||
      typeof r.date !== 'string' ||
      !validDay(r.date) ||
      !r.values ||
      typeof r.values !== 'object' ||
      Array.isArray(r.values) ||
      (r.note != null && typeof r.note !== 'string')
    )
      return t('core.subError.reading');
    readingIds.add(r.id);
    for (const [key, value] of Object.entries(r.values)) {
      if (!ids.has(key)) return t('core.subError.readingMeter');
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('core.subError.reading');
    }
  }
  return undefined;
}

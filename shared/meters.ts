// 业务数据：订阅上用户自定义的指标（电量、里程、出站流量……）与按期记录。
// 读数和付款分开存：服务器年付但按月看流量、车险一年一交但里程随时记。这里只放纯计算与校验，浏览器与 Worker 共用。
import { addDays, chargeServicePeriod, chargesBetween, diffDays, fnv1a, isPostpaid, nthCharge, phaseSubs, shareLastDay, validDay } from './billing.ts';
import { t } from './i18n.ts';
import type { Charge } from './billing.ts';
import type { Meter, Reading, Subscription } from './types.ts';

/** 某个指标在一条记录上的派生结果 */
export interface MeterRow {
  reading: Reading;
  /** 记录里填的数：本期用量型是用量，累计读数型是读数 */
  value: number;
  /** 本期用量；累计读数型的首条、读数回退、本期用量型记在订阅开始之前时没有 */
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
      usage = prev && !reading.base ? value - prev.value : undefined;
      if (usage != null) usage = usage < 0 ? undefined : Math.round(usage * 1e6) / 1e6;
    }
    // 本期用量型的首条：期间往前推一个周期，最早到订阅开始；中途才开始记录时不把更早的扣款摊进来
    const since = prev?.reading.date ?? (meter.kind === 'reading' ? undefined : firstSince(s, reading.date));
    // 本期用量型记在订阅开始之前：不属于任何计费周期，与扣款记录按服务期合计的用量一致，不计入累计、平均与走势
    if (meter.kind !== 'reading' && reading.date < s.start) usage = undefined;
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
    /** 累计的起点：累计读数型是首条读数（基数），本期用量型是首条计入的记录（订阅开始前的不算） */
    from: (meter.kind === 'reading' ? inWindow[0] : used[0])?.reading.date,
  };
}

/** 一个指标记下的数最多几位小数（至多 3 位）：同一指标的用量、读数、累计按同一位数显示，一列里不混排 24 与 12.67 */
export function meterDecimals(s: Pick<Subscription, 'readings'>, meterId: string): number {
  let d = 0;
  for (const r of s.readings ?? []) {
    const v = r.values[meterId];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    while (d < 3 && Math.abs(Math.round(v * 10 ** d) - v * 10 ** d) > 1e-6) d++;
  }
  return d;
}

/** 记录日落在 [from, until) 内的用量合计，供扣款记录按每笔覆盖的服务期显示用量；没有有用量的记录时返回 undefined */
export function usageWithin(rows: MeterRow[], from: string, until: string): number | undefined {
  const hit = rows.filter((r) => r.usage != null && r.reading.date >= from && r.reading.date < until);
  return hit.length ? Math.round(hit.reduce((a, r) => a + r.usage!, 0) * 1e6) / 1e6 : undefined;
}

/** 一段计费周期 [from, until) 里记下这个指标的记录（不给指标时任意一条）：有多条时取最晚的；扣款弹窗按周期填用量用 */
export function periodReading(s: Pick<Subscription, 'readings'>, from: string, until: string, meterId?: string): Reading | undefined {
  return readingsOf(s).findLast((r) => r.date >= from && r.date < until && (meterId == null || meterId in r.values));
}

/** 周期内记了这个指标的记录条数：多于一条时扣款弹窗不让改（用量要合计），回到柱子上逐条改 */
export function periodReadingCount(s: Pick<Subscription, 'readings'>, from: string, until: string, meterId: string): number {
  return (s.readings ?? []).filter((r) => r.date >= from && r.date < until && meterId in r.values).length;
}

/**
 * 按计费周期写用量：每个指标改周期内记了它的那条记录（periodReading），没有就写进周期内任意一条，
 * 再没有就新建一条（id、日期由调用方给）。values 只放改动的指标，undefined 表示清掉；
 * 清空的记录一并删掉（与读数弹窗、MCP 一样，一条记录至少有一个数）
 */
export function setPeriodValues(
  s: Subscription,
  from: string,
  until: string,
  values: Record<string, number | undefined>,
  create: { id: string; date: string },
): Subscription {
  let list = s.readings ?? [];
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    const num = typeof v === 'number' && Number.isFinite(v);
    const hit = periodReading({ readings: list }, from, until, k) ?? (num ? periodReading({ readings: list }, from, until) : undefined);
    if (!hit) {
      if (num) list = [...list, { id: create.id, date: create.date, values: { [k]: v } }];
      changed ||= num;
      continue;
    }
    const merged = { ...hit.values };
    if (num) merged[k] = v;
    else delete merged[k];
    const next = { ...hit, values: merged };
    list = Object.keys(merged).length ? list.map((r) => (r === hit ? next : r)) : list.filter((r) => r !== hit);
    changed = true;
  }
  return changed ? { ...s, readings: list.length ? list : undefined } : s;
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

/** 关联指标的来源：订阅和指标都还在、来源是它自己存数的指标（只有一层）才算数；否则显示为来源已不存在 */
export function meterSource(s: Pick<Subscription, 'id'>, meter: Meter, subs: Subscription[]): { sub: Subscription; meter: Meter } | undefined {
  if (!meter.link || meter.link.subId === s.id) return undefined;
  const sub = subs.find((x) => x.id === meter.link!.subId);
  const source = sub?.meters?.find((m) => m.id === meter.link!.meterId);
  return sub && source && !source.link ? { sub, meter: source } : undefined;
}

/** 关联累计读数时，开始服务前多久以内的读数还能当基数 */
const BASE_MAX_DAYS = 31;

/**
 * 显示用的只读副本：把关联指标的名称、单位、类型换成来源的，并把来源记录并进 readings（只带这个指标的值，id 仍是来源记录的 id）。
 * 算用量、走势都用这个副本，保存永远用原始订阅；副本存回去会被 meterError 拒绝。
 * 只取这个订阅真正服务的日子里的记录；累计读数型每段服务开始处重新起算，跨断档的差不算用量。来源不存在时不并入，上层显示说明而不是 0
 */
export function meterView(s: Subscription, subs: Subscription[]): Subscription {
  if (!s.meters?.some((m) => m.link)) return s;
  // 只算真正在服务的日子：阶段之间的空档、暂停之后、停用之后都不算；相邻或并行的阶段并成一段连续服务
  const spans: Array<{ from: string; to?: string }> = [];
  for (const p of phaseSubs(s)
    .map((p) => ({ from: p.start, to: [shareLastDay(p), p.stop?.date].filter((d): d is string => !!d).sort()[0] }))
    .sort((a, b) => a.from.localeCompare(b.from))) {
    const last = spans.at(-1);
    if (!last || (last.to && p.from > addDays(last.to, 1))) spans.push({ ...p });
    else if (last.to) last.to = p.to && p.to > last.to ? p.to : p.to ? last.to : undefined;
  }
  const spanOf = (day: string) => spans.find(({ from, to }) => day >= from && (!to || day <= to));
  const readings = [...(s.readings ?? [])];
  const meters = s.meters.map((m) => {
    const source = meterSource(s, m, subs);
    if (!source) return m;
    const kind = source.meter.kind;
    const rows = readingsOf(source.sub).filter((r) => source.meter.id in r.values);
    rows.forEach((r, i) => {
      const span = spanOf(r.date);
      if (!span) return;
      const add = (x: Reading, base?: boolean) =>
        readings.push({
          id: x.id,
          date: x.date,
          values: { [m.id]: x.values[source.meter.id] },
          ...(x.note ? { note: x.note } : {}),
          ...(base ? { base } : {}),
        });
      const prior = rows[i - 1];
      // 累计读数这一段服务的第一条：紧挨着的前一条作基数；前一条离得太远或属于上一段服务，就以这一条为基数，宁可少算，也不把没服务时的用量算进来
      if (kind === 'reading' && prior && prior.date < span.from) {
        if (spanOf(prior.date) || diffDays(prior.date, span.from) > BASE_MAX_DAYS) return void add(r, true);
        add(prior, true);
      }
      add(r);
    });
    const { kind: _old, ...rest } = m;
    return { ...rest, name: source.meter.name, unit: source.meter.unit, ...(kind ? { kind } : {}) };
  });
  return { ...s, meters, readings };
}

/** 别的订阅上可以关联的指标：对方自己存数的（只有一层），本订阅还没关联过的 */
export function linkableMeters(subs: Subscription[], current: Subscription): Array<{ sub: Subscription; meter: Meter }> {
  const linked = new Set((current.meters ?? []).map((m) => m.link && `${m.link.subId}\u0000${m.link.meterId}`));
  return subs.flatMap((sub) =>
    sub.id === current.id ? [] : (sub.meters ?? []).filter((m) => !m.link && !linked.has(`${sub.id}\u0000${m.id}`)).map((meter) => ({ sub, meter })),
  );
}

/**
 * 引用校验：比较写入前后的整个账本，只拒绝这次写入造成的坏引用（来源不存在、自引用、来源本身也是关联来的）。
 * 删来源、删指标、把来源改成关联、导入覆盖来源都由同一条规则拦住；早就坏掉的引用放行，免得无关修改存不进去
 */
export function meterLinkError(before: Subscription[], after: Subscription[]): string | undefined {
  for (const s of after)
    for (const m of s.meters ?? []) {
      if (!m.link || meterSource(s, m, after)) continue;
      const prev = before.find((x) => x.id === s.id);
      const old = prev?.meters?.find((x) => x.id === m.id && x.link?.subId === m.link!.subId && x.link?.meterId === m.link!.meterId);
      if (!old) return t('core.subError.meterLink');
      if (meterSource(prev!, old, before)) return t('core.subError.meterLinkUsed', { name: s.name, meter: old.name });
    }
  return undefined;
}

/**
 * 写一条记录的这些指标（scope），同一条里别的指标不动：关联页改里程不能带掉来源记录上的电量。
 * 改日期时别的指标留在原日期，这几个指标拆成新的一条；新增时 id 已存在（上次其实存上了）就覆盖，重试不重复记
 */
export function writeReading(s: Subscription, scope: string[], item: Reading, editId?: string): Subscription {
  const list = s.readings ?? [];
  const prev = list.find((r) => r.id === (editId ?? item.id));
  if (!prev) return { ...s, readings: [...list, item] };
  const rest = Object.fromEntries(Object.entries(prev.values).filter(([k]) => !scope.includes(k)));
  if (prev.date !== item.date && Object.keys(rest).length) {
    const id = stableId('r', `${prev.id}|${item.date}`, new Set(list.map((r) => r.id)));
    return { ...s, readings: [...list.map((r) => (r === prev ? { ...r, values: rest } : r)), { ...item, id }] };
  }
  return { ...s, readings: list.map((r) => (r === prev ? { ...item, id: prev.id, values: { ...rest, ...item.values } } : r)) };
}

/** 删一条记录上这些指标的值，别的指标留着；没有数了才删掉整条 */
export function removeReading(s: Subscription, scope: string[], id: string): Subscription {
  const readings = (s.readings ?? [])
    .map((r) => (r.id === id ? { ...r, values: Object.fromEntries(Object.entries(r.values).filter(([k]) => !scope.includes(k))) } : r))
    .filter((r) => Object.keys(r.values).length > 0);
  return { ...s, readings: readings.length ? readings : undefined };
}

/**
 * 一笔扣款覆盖好几条记录时（车险年付、里程按月记）的平均单价：已记录那段时间摊到的费用 ÷ 这段时间的用量。
 * 费用与用量都截至最后一条已出账的记录，晚记不会让单价自己上涨；还没出账的后付费当期、暂停空档里的记录不进分母。
 * 退款、补差按所在服务期摊进费用，失败的不算。一笔扣款最多覆盖一条记录时返回 undefined，走逐期单价；
 * 涉及多种币种或费用已全退时 price 为空，不把不同币种相加
 */
export function spreadUnitPrice(s: Subscription, rows: MeterRow[], today: string): { price?: { amount: number; currency: string }; asOf: string } | undefined {
  if (s.cycle.unit === 'lifetime') return undefined;
  // 提前扣款的首笔可能早于订阅开始
  const actual = chargesBetween(s, addDays(s.start, -400), addDays(today, 400), today).filter((c) => !c.projected && c.kind !== 'failed');
  const billed = actual.filter((c) => !c.kind).map((c) => ({ c, p: chargeServicePeriod(c.sub, c.date, c.serviceDate) }));
  // 退款、补差不在计费边界上，归到日期所在的那一期；服务结束后才退的归最后一期。正常扣款按自己的服务期，现金日可能在期外（后付费、提前续费）
  const spent = [
    ...billed,
    ...actual
      .filter((c) => c.kind)
      .map((c) => ({ c, p: billed.findLast(({ p }) => p.from <= c.date)?.p ?? chargeServicePeriod(c.sub, c.date, c.serviceDate) })),
  ];
  const inside = (r: MeterRow, p: { from: string; until: string }) => r.reading.date >= p.from && r.reading.date < p.until;
  const used = rows.filter((r) => r.usage != null && billed.some(({ p }) => inside(r, p)));
  if (!billed.some(({ p }) => used.filter((r) => inside(r, p)).length > 1)) return undefined;
  const first = used[0];
  const asOf = used.at(-1)!.reading.date;
  // 中途才开始记录：首条之前没有上一条，只算它所在的那一期，不把更早的费用摊进来
  const from = rows[rows.indexOf(first) - 1] ? addDays(first.since!, 1) : billed.find(({ p }) => inside(first, p))!.p.from;
  const until = addDays(asOf, 1);
  const shares = spent
    .map(({ c, p }) => ({ c, days: diffDays(p.from, p.until), part: diffDays(p.from > from ? p.from : from, p.until < until ? p.until : until) }))
    .filter(({ days, part }) => days > 0 && part > 0);
  const usage = used.reduce((a, r) => a + r.usage!, 0);
  const cost = shares.reduce((sum, { c, days, part }) => sum + (c.amount * part) / days, 0);
  if (new Set(shares.map(({ c }) => c.currency)).size !== 1 || usage <= 0 || cost <= 0) return { asOf };
  return { price: { amount: cost / usage, currency: shares[0].c.currency }, asOf };
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
      (m.kind != null && m.kind !== 'reading') ||
      (m.link != null && (typeof m.link.subId !== 'string' || !m.link.subId || typeof m.link.meterId !== 'string' || !m.link.meterId))
    )
      return t('core.subError.meter');
    ids.add(m.id);
    names.add(m.name.trim());
  }
  // 关联指标的数值只存在来源订阅上
  const linked = new Set((s.meters ?? []).filter((m) => m.link).map((m) => m.id));
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
      if (!ids.has(key) || linked.has(key)) return t('core.subError.readingMeter');
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('core.subError.reading');
    }
  }
  return undefined;
}

// 关联订阅（附赠与加购）：纯领域规则、父订阅可用期派生与引用校验，浏览器与 Worker 共用。
import {
  addDays,
  chargeServicePeriod,
  chargesBetween,
  currentPhase,
  diffDays,
  historyStart,
  isPostpaid,
  lastCharge,
  phaseSubs,
  undatedStop,
} from './billing.ts';
import { t } from './i18n.ts';
import type { AppState, BundleLink, Cycle, ParentAvailability, Phase, Subscription } from './types.ts';

/** 当前阶段或单阶段订阅指向的父订阅 id */
export const bundleParentId = (s: Pick<Subscription, 'bundle'>): string | undefined => s.bundle?.parentId;

/** 这一段是否跟随主订阅（缺省 / true 为跟随；false 为独立周期） */
export const followsParent = (s: Pick<Subscription, 'bundle'>): boolean => !!s.bundle?.parentId && s.bundle.follow !== false;

/**
 * 这一段是否是附赠的免费权益（零标价且没有正价首期优惠或调价历史）。
 * 计费、提醒、体检、编辑器、详情、列表、甘特图与公开页共用同一判定；
 * 公开页隐藏父订阅后 bundle 被剥离，仍通过非识别字段 included 保持同一口径。
 */
export function isFreeBundlePhase(s: Pick<Subscription, 'bundle' | 'included' | 'price' | 'intro' | 'priceHistory'>): boolean {
  if (!s.bundle?.parentId && !s.included) return false;
  if (s.price > 0) return false;
  if (s.intro && s.intro.price > 0) return false;
  if (s.priceHistory?.some((p) => p.amount > 0)) return false;
  return true;
}

/** 原始记录里的所有阶段（多阶段直接看 s.phases，不走会截断未来阶段的 phaseSubs，也不受过时顶层镜像影响） */
export function rawPhases(s: Pick<Subscription, 'phases' | 'bundle' | 'start'>): Array<Pick<Phase, 'start' | 'bundle'>> {
  return s.phases?.length ? s.phases : [s];
}

/** 订阅任意阶段（含历史与计划阶段）上记下的所有关联引用 */
export function bundleLinksOf(s: Pick<Subscription, 'phases' | 'bundle' | 'start'>): Array<{ start: string; link: BundleLink }> {
  return rawPhases(s).flatMap((p) => (p.bundle?.parentId ? [{ start: p.start, link: p.bundle }] : []));
}

/** 订阅在任意阶段上是否存在关联到父订阅的记录 */
export const hasAnyBundleLink = (s: Pick<Subscription, 'phases' | 'bundle' | 'start'>): boolean => bundleLinksOf(s).length > 0;

/** 合并重叠或相邻的闭区间 [from, to]（to 缺省表示无止境） */
export function mergeInclusiveSpans(spans: Array<{ from: string; to?: string }>): Array<{ from: string; to?: string }> {
  const valid = spans
    .filter((x) => !x.to || x.from <= x.to)
    .map((x) => ({ from: x.from, ...(x.to ? { to: x.to } : {}) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const out: Array<{ from: string; to?: string }> = [];
  for (const sp of valid) {
    const last = out.at(-1);
    if (!last) {
      out.push(sp);
      continue;
    }
    if (!last.to) continue;
    if (sp.from <= addDays(last.to, 1)) {
      if (!sp.to) delete last.to;
      else if (sp.to > last.to) last.to = sp.to;
    } else {
      out.push(sp);
    }
  }
  return out;
}

/** 合并重叠或相邻的半开区间 [from, to)（to 缺省表示无限延续） */
function mergeHalfOpen(spans: Array<{ from: string; to?: string }>): Array<{ from: string; to?: string }> {
  const valid = spans
    .filter((x) => !x.to || x.from < x.to)
    .map((x) => ({ from: x.from, ...(x.to ? { to: x.to } : {}) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const out: Array<{ from: string; to?: string }> = [];
  for (const sp of valid) {
    const last = out.at(-1);
    if (!last) {
      out.push(sp);
      continue;
    }
    if (!last.to) continue;
    if (sp.from <= last.to) {
      if (!sp.to) delete last.to;
      else if (sp.to > last.to) last.to = sp.to;
    } else {
      out.push(sp);
    }
  }
  return out;
}

/** 从半开区间 [from, to) 中减去若干闭区间 [s.from, s.to]（用于判断历史阶段暂停是否被另一并行活跃阶段覆盖） */
function subtractClosed(interval: { from: string; to: string }, covers: Array<{ from: string; to?: string }>): Array<{ from: string; to: string }> {
  let parts: Array<{ from: string; to: string }> = [interval];
  for (const c of covers) {
    const cEnd = c.to ? addDays(c.to, 1) : undefined;
    const next: Array<{ from: string; to: string }> = [];
    for (const p of parts) {
      if (c.from >= p.to || (cEnd && cEnd <= p.from)) {
        next.push(p);
        continue;
      }
      if (c.from > p.from) next.push({ from: p.from, to: c.from });
      if (cEnd && cEnd < p.to) next.push({ from: cEnd, to: p.to });
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

const availCache = new WeakMap<Subscription, ParentAvailability>();

/** 未知日期停用的父订阅最后确定在服务的一天：最后一笔已知扣款所覆盖服务期的最后一天（没有扣款时按开始日那一期） */
function undatedKnownThrough(parent: Subscription, vs: Subscription[]): string | undefined {
  const last = vs.at(-1);
  if (!last || last.cycle.unit === 'lifetime') return undefined;
  const dates = [parent.start, ...vs.flatMap((v) => [...(v.payments ?? []).map((p) => p.date), ...(v.nextDue ? [v.nextDue] : [])])];
  const horizon = dates.reduce((a, d) => (d > a ? d : a));
  const charge = lastCharge(parent, horizon) ?? parent.start;
  const phase = vs.filter((v) => v.start <= charge).at(-1) ?? last;
  return isPostpaid(phase) ? charge : addDays(chargeServicePeriod(phase, charge).until, -1);
}

/**
 * 派生父订阅的只读可用区间（与查询日无关，按父订阅对象身份缓存）。
 * - spans：所有阶段有效覆盖日的并集（处理重叠阶段与多段断更；停用阶段截至停用日前一天）
 * - pauses：父订阅已结束暂停、当前暂停，以及历史上记在 Stop.pausedAt 里的暂停（被并行活跃阶段覆盖的天除外）
 * - cycles：父订阅各阶段的周期列表，供免费跟随权益按查询日取当前显示周期（不被未来计划阶段提前覆盖）
 */
export function parentAvailability(parent: Subscription): ParentAvailability {
  const hit = availCache.get(parent);
  if (hit) return hit;

  const vs = phaseSubs(parent);
  const rawSpans: Array<{ from: string; to?: string; phase: Subscription }> = [];
  for (const v of vs) {
    // 停用当日已不再有效（与 effectiveStatus 的 stop.date <= today 一致）；非停用 end 含当天
    const to = v.stop ? addDays(v.stop.date, -1) : v.end;
    if (!to || v.start <= to) rawSpans.push({ from: v.start, ...(to ? { to } : {}), phase: v });
  }
  const merged = mergeInclusiveSpans(rawSpans);
  const open = merged.some((sp) => !sp.to);
  // 未知日期停用：父订阅只确定服务到最后一笔已知扣款覆盖的那天，跟随的子订阅同样只算到那天（与父订阅自身的扣款口径一致），不整段清零
  const known = undatedStop(parent) ? undatedKnownThrough(parent, vs) : undefined;
  const spans = known ? merged.filter((sp) => sp.from <= known).map((sp) => (!sp.to || sp.to > known ? { from: sp.from, to: known } : sp)) : merged;

  const pauseList: Array<{ from: string; to?: string }> = [];
  for (const p of parent.pauses ?? []) pauseList.push({ from: p.from, to: p.to });
  // 停用中保留的 pausedAt（含历史阶段停用）：暂停起至停用前一天；若另有并行的未暂停阶段覆盖其中某些天，不把那些天标成暂停
  for (const v of vs) {
    if (!v.stop?.pausedAt) continue;
    const from = v.stop.pausedAt < v.start ? v.start : v.stop.pausedAt;
    const to = addDays(v.stop.date, 1);
    if (from >= to) continue;
    const otherCovers = rawSpans.filter((x) => x.phase !== v && !x.phase.stop?.pausedAt).map(({ from: a, to: b }) => ({ from: a, ...(b ? { to: b } : {}) }));
    pauseList.push(...subtractClosed({ from, to }, otherCovers));
  }
  if (parent.status === 'paused') pauseList.push({ from: parent.pausedAt ?? '0000-01-01' });
  const pauses = mergeHalfOpen(pauseList);

  const undated: ParentAvailability['undatedStop'] = undatedStop(parent) ? (parent.status === 'terminated' ? 'terminate' : 'cancel') : undefined;
  const trial = parent.status === 'trial' && parent.trialEnd ? { from: parent.start, until: parent.trialEnd } : undefined;

  let ended: ParentAvailability['ended'];
  if (undated) {
    ended = { kind: 'undated', stopKind: undated };
  } else if (!open) {
    // 找决定整体最晚覆盖日的阶段：若没有其他阶段跑过停用前一天，记为 stop 结束，否则记为到期 end
    const lastCovered = spans.at(-1)?.to;
    const stoppedPhases = vs.filter((v) => v.stop);
    const decisiveStop = stoppedPhases
      .filter((v) => !lastCovered || addDays(v.stop!.date, -1) >= lastCovered)
      .sort((a, b) => b.stop!.date.localeCompare(a.stop!.date))[0];
    if (decisiveStop?.stop) {
      ended = { kind: 'stop', date: decisiveStop.stop.date, stopKind: decisiveStop.stop.kind };
    } else if (lastCovered) {
      ended = { kind: 'end', date: lastCovered };
    }
  }

  const cycles = vs.map((v) => ({
    from: v.start,
    ...(v.end ? { to: v.end } : {}),
    cycle: v.cycle,
  }));

  const result: ParentAvailability = {
    spans,
    pauses,
    ...(undated ? { undatedStop: undated } : {}),
    ...(trial ? { trial } : {}),
    ...(ended ? { ended } : {}),
    cycles,
  };
  availCache.set(parent, result);
  return result;
}

/** 闭区间 [from, to] 与父订阅覆盖区间 spans 的交集（用于状态判定、已订时长与甘特图） */
export function intersectSpans(from: string, to: string | undefined, avail: ParentAvailability): Array<{ from: string; to?: string }> {
  if (to && from > to) return [];
  const out: Array<{ from: string; to?: string }> = [];
  for (const sp of avail.spans) {
    const a = from > sp.from ? from : sp.from;
    const b = to && sp.to ? (to < sp.to ? to : sp.to) : (to ?? sp.to);
    if (!b || a <= b) out.push({ from: a, ...(b ? { to: b } : {}) });
  }
  return out;
}

/** day 是否落在父订阅的覆盖区间内 */
export const availInSpan = (avail: ParentAvailability, day: string): boolean => avail.spans.some((sp) => sp.from <= day && (!sp.to || day <= sp.to));

/** day 是否落在父订阅的暂停区间内 */
export const availPausedOn = (avail: ParentAvailability, day: string): boolean => avail.pauses.some((p) => p.from <= day && (!p.to || day < p.to));

/** day 当天父订阅是否处于可用（在覆盖区间内、未暂停；未知日期停用已把覆盖区间截到最后已知服务日） */
export function availCoversDay(avail: ParentAvailability, day: string): boolean {
  return availInSpan(avail, day) && !availPausedOn(avail, day);
}

/**
 * 半开区间 [from, until) 内，父订阅真正可用的天数（与 avail.spans 求交，再减去 avail.pauses）。
 * 供后付费加购按实际可用天数折算账单（覆盖暂停中恢复、期中停用、父阶段断更）。
 */
export function availActiveDays(avail: ParentAvailability, from: string, until: string): number {
  if (from >= until) return 0;
  let active: Array<{ from: string; to: string }> = [];
  for (const sp of avail.spans) {
    const a = from > sp.from ? from : sp.from;
    const spEnd = sp.to ? addDays(sp.to, 1) : until;
    const b = until < spEnd ? until : spEnd;
    if (a < b) active.push({ from: a, to: b });
  }
  for (const p of avail.pauses) {
    const next: Array<{ from: string; to: string }> = [];
    for (const seg of active) {
      if (p.from >= seg.to || (p.to && p.to <= seg.from)) {
        next.push(seg);
        continue;
      }
      if (p.from > seg.from) next.push({ from: seg.from, to: p.from });
      if (p.to && p.to < seg.to) next.push({ from: p.to, to: seg.to });
    }
    active = next;
    if (!active.length) break;
  }
  return active.reduce((sum, seg) => sum + diffDays(seg.from, seg.to), 0);
}

/**
 * 免费跟随权益在 day 当天用于展示的周期（与 currentPhase 同一选择规则：正在覆盖 day 的最晚段 → 之前最近一段 → 首段）。
 * 直接检查 bundleAvail，公开页隐藏父订阅剥离 bundle 后同样有效；付费加购永远保持自己的计费周期。
 */
export function displayCycle(v: Pick<Subscription, 'cycle' | 'bundle' | 'included' | 'price' | 'intro' | 'priceHistory' | 'bundleAvail'>, day: string): Cycle {
  if (!isFreeBundlePhase(v) || !v.bundleAvail?.cycles.length) return v.cycle;
  const list = v.bundleAvail.cycles;
  const active = list.filter((c) => c.from <= day && (!c.to || c.to >= day)).pop();
  if (active) return active.cycle;
  return list.filter((c) => c.from <= day).pop()?.cycle ?? list[0].cycle;
}

/** 判断目标父订阅在账本中是否合法（存在、非自身、非代付、本身无任何关联，保证严格一层无环） */
export function validBundleParent(subId: string, parentId: string, subs: readonly Subscription[]): Subscription | undefined {
  if (!parentId || parentId === subId) return undefined;
  const parent = subs.find((x) => x.id === parentId);
  if (!parent || parent.proxy || hasAnyBundleLink(parent)) return undefined;
  return parent;
}

/** 当前阶段（或指定日期所在阶段）关联到的有效父订阅；来源不存在或无效时返回 undefined */
export function bundleSource(
  s: Subscription,
  subs: readonly Subscription[],
  day?: string,
): { parent: Subscription; link: BundleLink; phase: Subscription } | undefined {
  const phase = day ? currentPhase(s, day) : s.phases?.length ? phaseSubs(s).at(-1)! : s;
  if (!phase.bundle?.parentId) return undefined;
  const parent = validBundleParent(s.id, phase.bundle.parentId, subs);
  return parent ? { parent, link: phase.bundle, phase } : undefined;
}

/** 闭区间 [from, to] 与父订阅可用区间（spans 减去 pauses）的交集，保留开放右端 */
export function availActiveSpans(from: string, to: string | undefined, avail: ParentAvailability): Array<{ from: string; to?: string }> {
  if (to && from > to) return [];
  let parts = intersectSpans(from, to, avail);
  for (const p of avail.pauses) {
    const next: Array<{ from: string; to?: string }> = [];
    for (const seg of parts) {
      if (seg.to && p.from > seg.to) {
        next.push(seg);
        continue;
      }
      if (p.to && p.to <= seg.from) {
        next.push(seg);
        continue;
      }
      if (p.from > seg.from) next.push({ from: seg.from, to: addDays(p.from, -1) });
      if (p.to && (!seg.to || p.to <= seg.to)) next.push({ from: p.to, ...(seg.to ? { to: seg.to } : {}) });
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

/** 哪些订阅在当前或未来阶段关联到 parentId（供父订阅详情与 MCP 展示，返回实际匹配关联的解析阶段） */
export function childrenOf(
  parentId: string,
  subs: readonly Subscription[],
  today: string,
): Array<{ sub: Subscription; link: BundleLink; phase: Subscription; upcoming: boolean }> {
  const out: Array<{ sub: Subscription; link: BundleLink; phase: Subscription; upcoming: boolean }> = [];
  for (const s of subs) {
    if (s.id === parentId || s.proxy) continue;
    const view = bundleView(s, subs);
    const cur = currentPhase(view, today);
    if (cur.bundle?.parentId === parentId) {
      out.push({ sub: s, link: cur.bundle, phase: cur, upcoming: cur.start > today });
      continue;
    }
    const up = phaseSubs(view).find((p) => p.start > today && p.bundle?.parentId === parentId);
    if (up?.bundle) out.push({ sub: s, link: up.bundle, phase: up, upcoming: true });
  }
  return out;
}

/** 所有在任意原始阶段（含历史与计划）引用了 parentId 的订阅（供删除拦截与引用检查） */
export function allChildrenOf(parentId: string, subs: readonly Subscription[]): Subscription[] {
  return subs.filter((s) => s.id !== parentId && bundleLinksOf(s).some((x) => x.link.parentId === parentId));
}

/** 可作为主订阅的候选列表：排除自身、代付、已关联他人的订阅；若 current 已有子订阅则不可再挂到他人名下 */
export function linkableParents(subs: readonly Subscription[], current?: Pick<Subscription, 'id'>): Subscription[] {
  if (current?.id && allChildrenOf(current.id, subs).length > 0) return [];
  return subs.filter((x) => x.id !== current?.id && !x.proxy && !hasAnyBundleLink(x));
}

const viewCache = new WeakMap<readonly Subscription[], WeakMap<Subscription, Subscription>>();
const listCache = new WeakMap<readonly Subscription[], Subscription[]>();

/**
 * 为订阅的跟随阶段挂上只读的 bundleAvail（不修改原始记录、不拆分阶段、不改写 start/end/stop/cycle/payments）。
 * 同时按 (subs 数组身份, sub 对象身份) 两级缓存，草稿对象不会撞上已保存记录的缓存。
 * 若阶段已携带 bundleAvail（如全账本解析后的子集、或隐藏父订阅的公开投影）且 subs 中无父订阅，则原样保留。
 */
export function bundleView(sub: Subscription, subs: readonly Subscription[]): Subscription {
  if (!hasAnyBundleLink(sub)) return sub;
  let inner = viewCache.get(subs);
  if (!inner) {
    inner = new WeakMap();
    viewCache.set(subs, inner);
  }
  const hit = inner.get(sub);
  if (hit) return hit;

  const availFor = (link: BundleLink | undefined, existing: ParentAvailability | undefined): ParentAvailability | undefined => {
    if (!link?.parentId || link.follow === false) return undefined;
    const parent = validBundleParent(sub.id, link.parentId, subs);
    return parent ? parentAvailability(parent) : existing;
  };

  let out: Subscription = sub;
  if (sub.phases?.length) {
    let changed = false;
    const phases: Phase[] = sub.phases.map((p): Phase => {
      const bundleAvail = availFor(p.bundle, p.bundleAvail);
      if (bundleAvail === p.bundleAvail) return p;
      changed = true;
      return bundleAvail ? { ...p, bundleAvail } : (({ bundleAvail: _drop, ...rest }) => rest)(p);
    });
    // 多阶段订阅不在顶层镜像末段 bundleAvail，避免未来关联阶段的父暂停/结束倒改当前独立阶段
    if (changed || sub.bundleAvail !== undefined) {
      out = { ...sub, phases, bundleAvail: undefined };
    }
  } else {
    const bundleAvail = availFor(sub.bundle, sub.bundleAvail);
    if (bundleAvail !== sub.bundleAvail) {
      out = bundleAvail ? { ...sub, bundleAvail } : { ...sub, bundleAvail: undefined };
    }
  }

  inner.set(sub, out);
  return out;
}

/** 整份订阅列表的只读解析视图（按数组身份缓存；无任何关联订阅时 O(n) 快路径原样返回） */
export function resolveSubs(subs: readonly Subscription[]): Subscription[] {
  const hit = listCache.get(subs);
  if (hit) return hit;
  if (!subs.some(hasAnyBundleLink)) {
    const same = subs as Subscription[];
    listCache.set(subs, same);
    return same;
  }
  const resolved = subs.map((s) => bundleView(s, subs));
  listCache.set(subs, resolved);
  return resolved;
}

/** 整本账的只读解析视图：只替换 subscriptions，保留最新 fx / settings / prefs / readonly */
export function resolveState(state: AppState): AppState {
  const subscriptions = resolveSubs(state.subscriptions);
  return subscriptions === state.subscriptions ? state : { ...state, subscriptions };
}

/**
 * 隐藏父订阅后的公开投影：对 bundleAvail 做脱敏裁剪（本身不含任何父 ID 或名称）。
 * keepHistory 为 false 时只保留查询日判定状态与显示周期所需的最小信息，不暴露完整历史日期。
 */
export function publicBundleAvail(avail: ParentAvailability, today: string, keepHistory: boolean): ParentAvailability {
  if (keepHistory) {
    return {
      spans: avail.spans.map((s) => ({ from: s.from, ...(s.to ? { to: s.to } : {}) })),
      pauses: avail.pauses.map((p) => ({ from: p.from, ...(p.to ? { to: p.to } : {}) })),
      ...(avail.undatedStop ? { undatedStop: avail.undatedStop } : {}),
      ...(avail.trial ? { trial: { ...avail.trial } } : {}),
      ...(avail.ended ? { ended: { ...avail.ended } } : {}),
      cycles: avail.cycles.map((c) => ({ from: c.from, ...(c.to ? { to: c.to } : {}), cycle: { ...c.cycle } })),
    };
  }
  const activeSpan = avail.spans.find((s) => s.from <= today && (!s.to || s.to >= today));
  const prevSpan = avail.spans.filter((s) => s.from <= today).at(-1);
  const futureSpan = avail.spans.find((s) => s.from > today);
  const lastSpan = avail.spans.at(-1);
  const open = avail.spans.some((s) => !s.to);
  const spans = activeSpan
    ? [{ from: activeSpan.from, ...(activeSpan.to ? { to: activeSpan.to } : {}) }]
    : prevSpan && futureSpan
      ? [
          { from: prevSpan.from, ...(prevSpan.to ? { to: prevSpan.to } : {}) },
          { from: futureSpan.from, ...(futureSpan.to ? { to: futureSpan.to } : {}) },
        ]
      : futureSpan
        ? [{ from: futureSpan.from, ...(futureSpan.to ? { to: futureSpan.to } : {}) }]
        : lastSpan
          ? [{ from: lastSpan.from, ...(lastSpan.to ? { to: lastSpan.to } : {}) }]
          : [];
  const pause = avail.pauses.find((p) => p.from <= today && (!p.to || today < p.to));
  const activeCycle =
    avail.cycles.filter((c) => c.from <= today && (!c.to || c.to >= today)).pop() ?? avail.cycles.filter((c) => c.from <= today).pop() ?? avail.cycles[0];
  return {
    spans,
    pauses: pause ? [{ from: pause.from, ...(pause.to ? { to: pause.to } : {}) }] : [],
    ...(avail.undatedStop ? { undatedStop: avail.undatedStop } : {}),
    ...(avail.trial && today < avail.trial.until ? { trial: { ...avail.trial } } : {}),
    ...(!open && avail.ended ? { ended: { ...avail.ended } } : {}),
    cycles: activeCycle ? [{ from: activeCycle.from, ...(activeCycle.to ? { to: activeCycle.to } : {}), cycle: { ...activeCycle.cycle } }] : [],
  };
}

/** 判断一条订阅是否存在任何真实的财务历史（多阶段、任意实付/退款/补差记录、转让、或非零扣款），供详情简化布局判断 */
export function hasFinancialHistory(sub: Subscription, paidCharges: ReadonlyArray<{ amount: number }> = []): boolean {
  if ((sub.phases?.length ?? 0) > 1) return true;
  if (sub.payments?.length) return true;
  if (sub.phases?.some((p) => (p.payments?.length ?? 0) > 0)) return true;
  if (sub.transfers?.length) return true;
  if (paidCharges.some((c) => c.amount !== 0)) return true;
  return false;
}

/** 单条订阅的关联结构校验（进入 subError，覆盖所有私有写入与备份恢复结构检查） */
export function bundleError(s: Subscription): string | undefined {
  const check = (x: Pick<Phase, 'bundle' | 'included' | 'bundleAvail'>): string | undefined => {
    if (x.included !== undefined || x.bundleAvail !== undefined) return t('core.subError.bundle');
    if (x.bundle == null) return undefined;
    if (typeof x.bundle !== 'object' || Array.isArray(x.bundle)) return t('core.subError.bundle');
    if (typeof x.bundle.parentId !== 'string' || !x.bundle.parentId.trim()) return t('core.subError.bundle');
    if (x.bundle.follow != null && typeof x.bundle.follow !== 'boolean') return t('core.subError.bundle');
    return undefined;
  };
  const topErr = check(s);
  if (topErr) return topErr;
  for (const p of s.phases ?? []) {
    const err = check(p);
    if (err) return err;
  }
  if (s.proxy && hasAnyBundleLink(s)) return t('core.subError.bundleProxy');
  return undefined;
}

/**
 * 整本账的关联引用校验（与 meterLinkError 同一口径）：
 * 比较写入前后的原始记录，只拦本次写入新引入或破坏的有效引用；已存在的坏引用放行，免得无关修改或挪开始日存不进去。
 * 按 (子订阅 id, 父订阅 id) 识别旧引用，不绑死在阶段 start 上。
 */
export function bundleLinkError(before: readonly Subscription[], after: readonly Subscription[]): string | undefined {
  // 先收集每个父订阅被破坏的有效引用，删除或变更父订阅时把所有阻塞子订阅一并报出
  const brokenParents = new Map<string, Set<string>>();
  for (const s of after) {
    const prev = before.find((x) => x.id === s.id);
    const prevParents = new Set(prev ? bundleLinksOf(prev).map((x) => x.link.parentId) : []);
    for (const { link } of bundleLinksOf(s)) {
      if (validBundleParent(s.id, link.parentId, after)) continue;
      if (!prevParents.has(link.parentId)) return t('core.subError.bundleLink');
      if (prev && validBundleParent(prev.id, link.parentId, before)) {
        const set = brokenParents.get(link.parentId) ?? new Set<string>();
        set.add(s.name);
        brokenParents.set(link.parentId, set);
      }
    }
  }
  const firstBroken = brokenParents.entries().next().value as [string, Set<string>] | undefined;
  if (firstBroken) return t('core.subError.bundleUsed', { names: [...firstBroken[1]].join(t('core.listSep')) });
  return undefined;
}

/**
 * 新加或改动的关联不能悄悄抹掉已发生的扣款：这次写入新出现了 (阶段开始日, 父订阅, 是否跟随) 组合时，
 * 比较写入前后今天之前的扣款，任一币种的合计变少就拒绝（已有独立扣款历史的订阅应在换方案里从关联日起另开一段）。
 * 未改关联的普通编辑（含单独改价）不受影响。
 */
export function bundleHistoryError(
  previous: Subscription | undefined,
  sub: Subscription,
  before: readonly Subscription[],
  after: readonly Subscription[],
  today: string,
): string | undefined {
  if (!previous) return undefined;
  const key = (start: string, l: BundleLink) => `${start}|${l.parentId}|${l.follow !== false}`;
  const old = new Set(bundleLinksOf(previous).map((x) => key(x.start, x.link)));
  const added = bundleLinksOf(sub).filter((x) => !old.has(key(x.start, x.link)));
  if (!added.length) return undefined;
  const prevStarts = new Set(rawPhases(previous).map((p) => p.start));
  // 已有阶段原地关联：检查今天之前的全部已发生扣款不能变少；
  // 换方案新增的关联阶段（新 start）：允许从切换日起按新关联计费，但切换日之前的历史扣款不能变少
  const cutoff = added.some((x) => prevStarts.has(x.start)) ? addDays(today, -1) : addDays(added.map((x) => x.start).sort()[0], -1);
  const sums = (s: Subscription) => {
    const out = new Map<string, number>();
    if (cutoff < historyStart(s)) return out;
    for (const c of chargesBetween(s, historyStart(s), cutoff, today)) if (c.kind !== 'failed') out.set(c.currency, (out.get(c.currency) ?? 0) + c.amount);
    return out;
  };
  const was = sums(bundleView(previous, before));
  const now = sums(bundleView(sub, after));
  for (const [ccy, amount] of was) if ((now.get(ccy) ?? 0) < amount - 0.005) return t('core.subError.bundleHistory');
  return undefined;
}

import { personSummary } from '../../shared/avatar.ts';
import { parseAppStorePlans } from '../../shared/appstore-plans.ts';
import { reconcileRenewalRules, preserveRenewalHistory, renewalDates } from '../../shared/billing.ts';
// MCP 工具：查询订阅、扣款、统计，以及新增 / 维护订阅。全部复用 shared/ 里的计费与统计逻辑，和后台界面算出来的数一致。
import {
  activePhases,
  addDays,
  addMonths,
  chargesBetween,
  currentPhase,
  cycleLabel,
  diffDays,
  effectiveStatus,
  lastCharge,
  memberDues,
  collectionAnchor,
  type MemberDue,
  memberBillMonths,
  memberCollection,
  memberUnpaidFrom,
  monthlyGross,
  myShareFactor,
  memberAboard,
  nextCharge,
  phaseSubs,
  priceAt,
  runwayFor,
  stopSummary,
  todayIn,
  totals,
  uid,
  type Charge,
  validDay,
} from '../../shared/billing.ts';
import { chargeValue, convertOn, toBaseAt } from '../../shared/fx.ts';
import { cancelSavings, cashVsAccrual, events, insights, movement, mrrSeries, prepaidValue, stopLosses, topUpPlan, yearReview } from '../../shared/metrics.ts';
import {
  editPhase,
  removePhase,
  changePrice,
  editPricePoint,
  removePricePoint,
  affectedPriceCharges,
  confirmPlan,
  deletePayment,
  dropPlan,
  prependPlan,
  resume,
  savePayment,
  switchPlan,
  syncPhase,
  toEditForm,
  stopSubscription,
  reactivate,
  statusChangeError,
  cancelAtEnd,
} from '../../shared/phases.ts';
import { matchEntries } from '../../shared/proxy.ts';
import { normName, peopleLedger, type PersonLedger } from '../../shared/people.ts';
import type { AppState, Payment, PaymentMethod, Person, ShareMember, Subscription } from '../../shared/types.ts';
import type { Env } from '../env.ts';
import { loadState, saveLedgerEdit, upsert } from '../store.ts';
import {
  applyCarRule,
  suggestedLeaveRefund,
  updateMemberLeave,
  carLedger,
  carRule,
  followCarRule,
  followsCar,
  memberFee,
  changeMemberFee,
  resyncShares,
  sameRule,
  shareFromFee,
} from '../../shared/carpool.ts';
import { t } from '../../shared/i18n.ts';
import { ledgerTools, paymentMethodTool } from './ledger-tools.ts';
import { validateToolInput, type Schema } from '../../shared/tool-schema.ts';
import { subError } from '../../shared/billing.ts';
import { validateCurrency, reviseReceivable, categoryEdit } from '../../shared/ledger-edit.ts';
import { categoryCounts, categoryList, presetCategory, PRESETS, type Category } from '../../shared/categories.ts';
import { CATEGORY_ALIASES } from '../../shared/locales/categories.gen.ts';

/** App Store 搜索（也接受 App Store 链接，按 id 精确查找）；后台的名称联想和 AI 共用 */
const storeCountry = (country: string) =>
  country
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 2) || 'us';

export async function searchAppStore(query: string, country = 'us') {
  const term = query.trim().slice(0, 80);
  const cc = storeCountry(country);
  if (!term) return [];
  const id = term.match(/id(\d{6,})/)?.[1];
  const api = id
    ? `https://itunes.apple.com/lookup?id=${id}&country=${cc}`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=8&country=${cc}`;
  const res = await fetch(api, { cf: { cacheTtl: 86400 } });
  const body = (await res.json().catch(() => ({}))) as { results?: Array<Record<string, unknown>> };
  return (body.results ?? []).map((r) => ({
    id: String(r.trackId),
    name: r.trackName as string,
    icon: r.artworkUrl100 as string,
    url: r.trackViewUrl as string,
    seller: r.sellerName as string,
    genre: r.primaryGenreName as string,
  }));
}

/**
 * App 的内购套餐：iTunes 接口不给内购，只能读商店详情页；币种取同一地区 lookup 的结果。
 * 页面改版、地区没有这个 App 或读不到币种时返回空列表，前端照常手填。
 */
export async function appStorePlans(id: string, country = 'us') {
  const appId = /^\d{6,12}$/.test(id) ? id : '';
  const cc = storeCountry(country);
  if (!appId) return { currency: undefined, plans: [] };
  const [page, lookup] = await Promise.all([
    fetch(`https://apps.apple.com/${cc}/app/id${appId}`, { cf: { cacheTtl: 86400 }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${cc}`, { cf: { cacheTtl: 86400 } })
      .then((r) => r.json() as Promise<{ results?: Array<{ currency?: string }> }>)
      .catch(() => ({ results: [] as Array<{ currency?: string }> })),
  ]);
  const currency = lookup.results?.[0]?.currency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { currency: undefined, plans: [] };
  return { currency, plans: parseAppStorePlans(page).slice(0, 20) };
}

export interface ToolCtx {
  env: Env;
  /**
   * 草稿叠加层（AI 助手用）：同一轮里先出的草稿（dry_run）叠在真实数据上，后面的工具能看到它们，
   * 于是「新建订阅 → 设为合租 → 加成员」可以一口气出完草稿。null 表示这一轮里删除了。
   */
  overlay?: Map<string, Subscription | null>;
  draftState?: Partial<AppState>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}

// ---------- 公共小工具 ----------

export async function state(ctx: ToolCtx): Promise<{ st: AppState; today: string }> {
  const st = { ...(await loadState(ctx.env, false)), ...ctx.draftState };
  if (ctx.overlay?.size) {
    const subs = st.subscriptions.filter((s) => !ctx.overlay!.has(s.id)).concat([...ctx.overlay.values()].filter((s): s is Subscription => !!s));
    st.subscriptions = subs;
  }
  return { st, today: todayIn(st.settings.timezone) };
}

/** 金额：原币 + 折算成目标币种（默认本位币） */
export function money(st: AppState, amount: number, currency: string, date?: string, to = st.settings.baseCurrency) {
  const conv = !Number.isFinite(amount) ? NaN : currency === to ? amount : toBaseAt(st, amount, currency, date, to);
  return { amount: round(amount), currency, converted: round(conv), convertedCurrency: to };
}
export const round = (n: number) => Math.round(n * 100) / 100;

/** 工具的显示名（随语言变化，所以不写在 TOOLS 里） */
export const toolTitle = (name: string) => t(`mcp.tool.${name}`);

/** 候选列表：「名称（id）、名称（id）」 */
const candidates = (xs: Array<{ name: string; id: string }>) => xs.map((x) => t('mcp.item', { name: x.name, id: x.id })).join(t('mcp.sep'));

/** 按 id 或名称找订阅；名称模糊匹配到多个时报错并列出候选，让 AI 选 */
export function findSub(st: AppState, ref: unknown): Subscription {
  const q = String(ref ?? '').trim();
  if (!q) throw new Error(t('mcp.error.needSub'));
  const byId = st.subscriptions.find((s) => s.id === q);
  if (byId) return byId;
  const k = q.toLowerCase();
  const exact = st.subscriptions.filter((s) => s.name.toLowerCase() === k);
  if (exact.length === 1) return exact[0];
  const fuzzy = exact.length ? exact : st.subscriptions.filter((s) => s.name.toLowerCase().includes(k));
  if (fuzzy.length === 1) return fuzzy[0];
  if (!fuzzy.length) throw new Error(t('mcp.error.subNotFound', { q }));
  throw new Error(t('mcp.error.subAmbiguous', { q, count: fuzzy.length, list: candidates(fuzzy) }));
}

/** 按 id 或称呼找人；称呼模糊匹配到多个时报错并列出候选 */
export function findPerson(st: AppState, ref: unknown): Person {
  const q = String(ref ?? '').trim();
  const people = st.people ?? [];
  const byId = people.find((p) => p.id === q);
  if (byId) return byId;
  const k = normName(q);
  const exact = people.filter((p) => normName(p.name) === k);
  if (exact.length === 1) return exact[0];
  const fuzzy = exact.length ? exact : k ? people.filter((p) => normName(p.name).includes(k)) : [];
  if (fuzzy.length === 1) return fuzzy[0];
  if (!fuzzy.length) throw new Error(t('mcp.error.personNotFound', { q }));
  throw new Error(t('mcp.error.personAmbiguous', { q, count: fuzzy.length, list: candidates(fuzzy) }));
}

/** 联系渠道在数据里存的是中文代码，给 AI 的输出统一换成英文名 */
const VIA_EN: Record<string, string> = { 微信: 'WeChat', 邮箱: 'Email', 手机: 'Phone', 其他: '' };
const contactLine = (p: Pick<Person, 'contactVia' | 'contact'>) => {
  if (!p.contact) return null;
  const via = p.contactVia ? (VIA_EN[p.contactVia] ?? p.contactVia) : '';
  return via ? `${via} ${p.contact}` : p.contact;
};

/** 一个人的应收：在哪些合租 / 代付里、欠多少、收回多少 */
function personRow(st: AppState, l: PersonLedger, out: string, today: string) {
  const conv = (v: number) => round(toBaseAt(st, v, st.settings.baseCurrency, undefined, out));
  return {
    person_id: l.person.id || null,
    name: l.person.name,
    contact: contactLine(l.person),
    note: l.person.note ?? null,
    has_avatar: !!l.person.avatar,
    record: personSummary(l.person),
    owed: conv(l.owed),
    periods_owed: l.periodsOwed,
    received: conv(l.received),
    last_paid: l.lastPaid ?? null,
    in: l.items.map((i) => ({
      subscription_id: i.sub.id,
      name: i.sub.name,
      kind: i.kind,
      member_id: i.member?.id ?? null,
      ...(i.member ? { account: i.member.account ?? null } : {}),
      active: i.active,
      left: i.member?.left && i.member.left <= today ? i.member.left : null,
      owed: conv(i.owed),
      periods_owed: i.periodsOwed,
      received: conv(i.received),
      last_paid: i.lastPaid ?? null,
      paid_until: i.paidUntil ?? null,
      ...(i.member ? { leave_refund: i.member.leaveRefund ?? null } : {}),
    })),
  };
}

/** 收款摘要：日期是最早未付的覆盖起点（可能已逾期），金额由 shared 计算。 */
function collectionSummary(st: AppState, s: Subscription, m: ShareMember, due: MemberDue | undefined, today: string) {
  const rule = s.share?.role === 'owner' ? carRule(st, s, today) : undefined;
  const currency = st.settings.collectCurrency ?? st.settings.baseCurrency;
  const first = memberCollection(s, m, m.joined ?? s.share?.since ?? s.start, currency);
  const next = memberCollection(s, m, memberUnpaidFrom(s, m), currency);
  return {
    follows_rule: rule ? followsCar(st, s, m, today) : false,
    collect_from: collectionAnchor(s),
    paid_until: m.paidUntil ?? null,
    leave_refund: m.leaveRefund ?? null,
    first_collection: first,
    next_collection: next,
    next_collection_date: next.from,
    overdue_days: due && due.periodsOwed > 0 && next.from < today ? diffDays(next.from, today) : 0,
    is_first_period: next.from <= first.until,
    pending_amount: money(st, due?.owed ?? 0, due?.currency ?? next.currency),
  };
}

/** 车的收款规则；stored=false 表示老数据没存规则，按成员最常见的收费推断 */
function ruleOut(st: AppState, s: Subscription, today: string) {
  const r = carRule(st, s, today);
  return { fee: r.fee, currency: r.currency, every_months: r.billEvery, stored: !!s.share?.rule };
}

/** 时间范围：today / next_3_days / next_7_days / next_30_days / this_month / next_month / last_30_days / this_year / custom */
function rangeOf(period: unknown, today: string, from?: unknown, to?: unknown): [string, string] {
  const p = String(period ?? 'next_30_days');
  const ym = today.slice(0, 7);
  switch (p) {
    case 'today':
      return [today, today];
    case 'next_3_days':
      return [today, addDays(today, 2)];
    case 'next_7_days':
      return [today, addDays(today, 6)];
    case 'next_30_days':
      return [today, addDays(today, 29)];
    case 'this_month':
      return [`${ym}-01`, addDays(addMonths(`${ym}-01`, 1), -1)];
    case 'next_month': {
      const n = addMonths(`${ym}-01`, 1);
      return [n, addDays(addMonths(n, 1), -1)];
    }
    case 'last_30_days':
      return [addDays(today, -29), today];
    case 'this_year':
      return [`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`];
    case 'custom': {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!re.test(String(from)) || !re.test(String(to))) throw new Error(t('mcp.error.customRange'));
      return [String(from), String(to)];
    }
    default:
      throw new Error(t('mcp.error.unknownPeriod', { period: p }));
  }
}

const PERIODS = ['today', 'next_3_days', 'next_7_days', 'next_30_days', 'this_month', 'next_month', 'last_30_days', 'this_year', 'custom'];

// ---------- 订阅的统一表示 ----------

type Scope = 'mine' | 'share_owner' | 'share_member' | 'proxy';
const kindOf = (s: Subscription): Scope =>
  s.proxy ? 'proxy' : s.share?.role === 'owner' ? 'share_owner' : s.share?.role === 'member' ? 'share_member' : 'mine';

/** 列表里的一行：当前生效的那一段 + 状态 + 下次扣款 + 每月成本 */
function row(st: AppState, s: Subscription, today: string, out?: string) {
  const cur = currentPhase(s, today);
  const next = nextCharge(s, today);
  // 换区后旧阶段还在跑：每月成本按并行各段之和，另列出同时进行的旧阶段
  const monthly = monthlyGross(s, today, st.fx);
  const parallel = s.phases?.length ? activePhases(s, today).filter((v) => v.start !== cur.start) : [];
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    tags: s.tags,
    status: effectiveStatus(s, today),
    kind: kindOf(s),
    price: money(st, next && (!cur.end || next < cur.end) ? priceAt(s, next) : cur.price, cur.currency, undefined, out),
    cycle: cycleLabel(cur.cycle),
    monthly: money(st, monthly, cur.currency, undefined, out),
    my_share_factor: round(myShareFactor(cur, today)),
    next_charge: next ?? null,
    service_expires: renewalDates(s, today).serviceExpires ?? null,
    cancel_by: renewalDates(s, today).cancelBy ?? null,
    last_charge: lastCharge(s, today) ?? null,
    method: st.methods.find((m) => m.id === cur.methodId)?.name ?? null,
    method_id: cur.methodId ?? null,
    region: cur.region ?? null,
    start: s.start,
    end: s.end ?? null,
    stop: stopSummary(cur, today) ?? null,
    has_planned_change: !!s.phases?.some((p) => p.planned),
    ...(parallel.length
      ? {
          also_running: parallel.map((v) => ({
            start: v.start,
            until: v.end ?? null,
            price: money(st, v.price, v.currency, undefined, out),
            cycle: cycleLabel(v.cycle),
            region: v.region ?? null,
            method: st.methods.find((m) => m.id === v.methodId)?.name ?? null,
          })),
        }
      : {}),
  };
}

/** 一笔扣款：原币 + 折算；scope=mine 时 my_amount 只算我承担的部分 */
function chargeRow(st: AppState, c: Charge, out?: string) {
  const sub = st.subscriptions.find((x) => x.id === c.sub.id) ?? c.sub;
  const v = chargeValue(st, c, out ?? st.settings.baseCurrency);
  return {
    date: c.date,
    subscription_id: c.sub.id,
    name: sub.name,
    amount: { amount: round(c.amount), currency: c.currency, converted: round(v), convertedCurrency: out ?? st.settings.baseCurrency },
    my_amount: round(v * myShareFactor(c.sub, c.date)),
    projected: c.projected,
    kind: c.kind ?? 'charge',
    method: st.methods.find((m) => m.id === c.sub.methodId)?.name ?? null,
    ...(c.settled ? { settled: c.settled } : {}),
    ...(c.note ? { note: c.note } : {}),
  };
}

function chargesIn(st: AppState, from: string, to: string, today: string, scope: string) {
  return st.subscriptions
    .filter((s) => (scope === 'proxy' ? !!s.proxy : scope === 'all' || scope === 'gross' ? true : !s.proxy))
    .flatMap((s) => chargesBetween(s, from, to, today))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 花费汇总的分组：返回 [分组键, 显示名] */
function groupOf(by: string, c: Charge, sub: Subscription, m: PaymentMethod | undefined): [string, string] {
  switch (by) {
    case 'month':
      return [c.date.slice(0, 7), c.date.slice(0, 7)];
    case 'year':
      return [c.date.slice(0, 4), c.date.slice(0, 4)];
    case 'category':
      return [sub.category, sub.category];
    case 'method':
      return [m?.id ?? 'none', m?.name ?? t('mcp.label.unassigned')];
    case 'currency':
      return [c.currency, c.currency];
    case 'region':
      return [c.sub.region ?? '—', c.sub.region ?? t('mcp.label.anyRegion')];
    case 'subscription':
      return [sub.id, sub.name];
    default:
      return ['all', t('mcp.label.total')];
  }
}

const outCcy = (st: AppState, a: Record<string, unknown>) => {
  const c = a.currency_out ? String(a.currency_out).toUpperCase() : undefined;
  if (c && !st.fx.rates[c]) throw new Error(t('mcp.error.unsupportedCurrency', { code: c }));
  return c;
};

const DATE = { format: 'date', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const SUBREF = { type: 'string', description: 'Subscription id, or its name (fuzzy match; ambiguous names return candidates).' };
const CURRENCY_OUT = { type: 'string', description: 'Convert amounts into this currency (ISO code). Defaults to the ledger base currency.' };
const PERIOD = { type: 'string', enum: PERIODS, description: 'Time window. custom requires from/to.' };
const CYCLE = {
  type: 'object',
  properties: { unit: { type: 'string', enum: ['day', 'week', 'month', 'year', 'lifetime'] }, every: { type: 'integer', minimum: 1, default: 1 } },
  required: ['unit'],
  description: 'Billing cycle, e.g. {"unit":"month","every":1}; lifetime = one-time purchase.',
};
const DRY = { type: 'boolean', default: false, description: 'Preview the result without saving.' };
const CATEGORY = { type: 'string', description: 'Existing category code or name from list_categories; localized names are case-insensitive.' };
const CATEGORY_CREATE = {
  create_category: { type: 'boolean', default: false, description: 'If category is unknown, explicitly create it. Ambiguous references always fail.' },
  category_icon: { type: ['string', 'null'], description: 'New category only: Lucide icon name or emoji; same validation as save_category set.icon.' },
  category_color: { type: ['string', 'null'], description: 'New category only: palette code or #rrggbb; same validation as save_category set.color.' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** 写入：dry_run 只返回预览；否则保存并返回最新一行 + 接下来几笔扣款 */
/** 模型偶尔把名称里的 & 等写成 HTML 实体（AT&amp;T），存之前还原 */
export const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e]!);

type CategoryCreation = { category: Category; categories: Category[] };

export async function commit(
  ctx: ToolCtx,
  st: AppState,
  today: string,
  after: Subscription,
  dry: unknown,
  changed: string[],
  categoryCreation?: CategoryCreation,
) {
  after = reconcileRenewalRules(
    st.subscriptions.find((s) => s.id === after.id),
    after,
    today,
  );
  after = resyncShares(
    st,
    st.subscriptions.find((s) => s.id === after.id),
    after,
  );
  for (const member of after.share?.members ?? []) if (!Number.isFinite(member.share)) throw new Error(t('mcp.error.notNumber', { what: 'member.share' }));
  for (const v of phaseSubs(after)) {
    const error = subError(v);
    if (error) throw new Error(error);
    validateCurrency(st, v.currency);
  }
  const invalid = subError(after);
  if (invalid) throw new Error(invalid);
  const errs = statusChangeError(
    st.subscriptions.find((x) => x.id === after.id),
    after,
    today,
  );
  if (errs) throw new Error(errs);
  const preview = {
    subscription: row(st, after, today),
    before: st.subscriptions.find((s) => s.id === after.id) ?? null,
    after,
    references: { subscription: after.id },
    changed,
    ...(categoryCreation
      ? {
          created_category: categoryCreation.category,
          category_notice: t(dry ? 'mcp.label.createCategory' : 'mcp.label.createdCategory', { name: categoryCreation.category.name }),
        }
      : {}),
    next_charges: chargesBetween(after, today, addMonths(today, 13), today)
      .slice(0, 3)
      .map((c) => ({ date: c.date, amount: round(c.amount), currency: c.currency })),
  };
  if (dry) {
    if (categoryCreation) ctx.draftState = { ...ctx.draftState, settings: { ...st.settings, categories: categoryCreation.categories } };
    ctx.overlay?.set(after.id, after);
    return { dry_run: true, ...preview };
  }
  const saved = { ...after, updatedAt: new Date().toISOString() };
  if (categoryCreation) await saveLedgerEdit(ctx.env, { subscriptions: [saved], settings: { ...st.settings, categories: categoryCreation.categories } });
  else await upsert(ctx.env, 'subscriptions', saved.id, saved);
  return { ok: true, ...preview };
}

const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));
const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(t('mcp.error.notNumber', { what }));
  return n;
};
const date = (v: unknown, what: string, fallback?: string) => {
  const d = v == null ? fallback : String(v);
  if (!d || !validDay(d)) throw new Error(t('mcp.error.notDate', { what }));
  return d;
};
export const methodRef = (st: AppState, v: unknown) => {
  const q = str(v);
  if (!q) return undefined;
  const byId = st.methods.find((x) => x.id === q);
  if (byId) return byId.id;
  const exact = st.methods.filter((x) => x.name === q);
  const matches = exact.length ? exact : st.methods.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length !== 1) throw new Error(t('mcp.error.noMethod', { q, list: candidates(matches.length ? matches : st.methods) }));
  const m = matches[0];
  return m.id;
};

/** Exact code/name first, then case-insensitive names (including localized preset aliases); never fuzzy. */
function categoryMatches(list: Category[], q: string): Category[] {
  const exact = list.filter((c) => c.name === q || c.preset === q);
  if (exact.length) return exact;
  const key = q.toLowerCase();
  return list.filter(
    (c) =>
      c.name.toLowerCase() === key ||
      (c.preset && [...(CATEGORY_ALIASES[c.preset] ?? []), ...(PRESETS.find((p) => p.code === c.preset)?.legacy ?? [])].some((n) => n.toLowerCase() === key)),
  );
}

export const categoryRef = (st: AppState, v: unknown): string | undefined => {
  if (v == null) return undefined;
  const q = String(v).trim();
  const list = categoryList(st.settings, st.subscriptions);
  const matches = categoryMatches(list, q);
  if (matches.length !== 1)
    throw new Error(
      t('mcp.error.noCategory', { q, list: candidates((matches.length ? matches : list).map((c) => ({ name: c.name, id: c.preset ?? c.name }))) }),
    );
  return matches[0].name;
};

function subscriptionCategory(st: AppState, v: unknown, args: Record<string, unknown>): { name: string; creation?: CategoryCreation } {
  const q = String(v).trim();
  const list = categoryList(st.settings, st.subscriptions);
  if (args.create_category === true && !categoryMatches(list, q).length) {
    const { categories } = categoryEdit(st, 'create', undefined, { name: q, icon: str(args.category_icon), color: str(args.category_color) });
    const category = categories.find((c) => c.name === q)!;
    return { name: category.name, creation: { category, categories } };
  }
  return { name: categoryRef(st, q)! };
}

// ---------- 工具 ----------

const CATALOGUE: Tool[] = [
  ...ledgerTools,
  {
    name: 'get_overview',
    description:
      'Snapshot of the subscription ledger: today, base currency, my monthly recurring spend (MRR — excludes proxy payments made on behalf of others, counts only my share of shared plans), active count, payment methods (ids), categories and regions in use, top insights. Call this first to learn ids and categories.',
    inputSchema: obj({ currency_out: CURRENCY_OUT }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a) ?? st.settings.baseCurrency;
      const t = totals(st, today);
      const conv = (v: number) => round(toBaseAt(st, v, st.settings.baseCurrency, undefined, out));
      return {
        today,
        base_currency: st.settings.baseCurrency,
        currency_out: out,
        mrr: conv(t.mrr),
        yearly: conv(t.mrr * 12),
        gross_mrr: conv(t.grossMrr),
        share_recovered_mrr: conv(t.recoverMrr),
        active_count: t.activeCount,
        subscription_count: st.subscriptions.length,
        methods: st.methods.map((m) => ({ id: m.id, name: m.name, kind: m.kind, currency: m.currency, region: m.region ?? null, balance: m.balance ?? null })),
        // 分类按用户排的顺序，只列用到的；图标颜色等见 list_categories
        categories: categoryList(st.settings, st.subscriptions)
          .map((c) => c.name)
          .filter((n) => st.subscriptions.some((s) => s.category === n)),
        regions: [...new Set(st.subscriptions.flatMap((s) => phaseSubs(s).map((v) => v.region)).filter(Boolean))],
        insights: insights(st, today)
          .slice(0, 5)
          .map((i) => ({ tone: i.tone, title: i.title, body: i.body })),
      };
    },
  },
  {
    name: 'list_categories',
    description:
      'List the user’s categories in display order: name, icon (a Lucide icon name or an emoji), color, built-in code if any, and how many subscriptions use it (total / live). Call this before assigning categories. Use an existing code/name in create_subscription and update_subscription; unknown names fail unless create_category=true. For a missing category use save_category action=create or explicitly set create_category=true.',
    inputSchema: obj({}),
    async run(_a, ctx) {
      const { st, today } = await state(ctx);
      const all = categoryCounts(st.subscriptions);
      const live = categoryCounts(st.subscriptions.filter((s) => ['active', 'trial', 'ending', 'paused'].includes(effectiveStatus(s, today))));
      return {
        items: categoryList(st.settings, st.subscriptions).map((c) => ({
          name: c.name,
          icon: c.icon ?? null,
          color: c.color ?? null,
          builtin: c.preset ?? null,
          subscriptions: all.get(c.name) ?? 0,
          live: live.get(c.name) ?? 0,
        })),
      };
    },
  },
  {
    name: 'list_subscriptions',
    description:
      'List subscriptions with status, current price, monthly cost, next/last charge, payment method and region. Filter by fuzzy name query, status, kind (mine / share_owner = shared plan I organize / share_member = shared plan I joined / proxy = paid on behalf of someone), category, method or region. Stop summaries distinguish non-renewal (end only), voluntary immediate cancellation and provider termination; stop includes kind, date, paidThrough, reason, refunded, refundStatus (none / partial / full; a pro-rata refund of the remaining days counts as full), unusedDays (stop date to paidThrough), unusedValue and wastedDays (days not covered by the refund). Use query to find a subscription id.',
    inputSchema: obj({
      query: { type: 'string', description: 'Fuzzy match on name, tags, notes, category.' },
      status: {
        type: 'string',
        enum: ['active', 'trial', 'paused', 'ending', 'ended', 'terminated', 'upcoming', 'lifetime', 'live', 'all'],
        default: 'live',
        description: 'live = active+trial+ending+paused.',
      },
      kind: { type: 'string', enum: ['mine', 'share_owner', 'share_member', 'proxy', 'all'], default: 'all' },
      category: { type: 'string' },
      method: { type: 'string', description: 'Payment method id or name.' },
      region: { type: 'string', description: 'ISO country code, e.g. TR.' },
      sort: { type: 'string', enum: ['next_charge', 'monthly_cost', 'name', 'start'], default: 'next_charge' },
      limit: { type: 'integer', default: 100 },
      currency_out: CURRENCY_OUT,
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a);
      const q = str(a.query)?.toLowerCase();
      const status = str(a.status) ?? 'live';
      const method = a.method ? methodRef(st, a.method) : undefined;
      let rows = st.subscriptions
        .filter((s) => !q || `${s.name} ${s.tags.join(' ')} ${s.notes ?? ''} ${s.category}`.toLowerCase().includes(q))
        .map((s) => row(st, s, today, out))
        .filter((r) => status === 'all' || (status === 'live' ? ['active', 'trial', 'ending', 'paused'].includes(r.status) : r.status === status))
        .filter((r) => !a.kind || a.kind === 'all' || r.kind === a.kind)
        .filter((r) => !a.category || r.category === a.category)
        .filter((r) => !method || r.method_id === method)
        .filter((r) => !a.region || r.region === String(a.region).toUpperCase());
      const sort = str(a.sort) ?? 'next_charge';
      rows.sort((x, y) =>
        sort === 'monthly_cost'
          ? y.monthly.converted - x.monthly.converted
          : sort === 'name'
            ? x.name.localeCompare(y.name)
            : sort === 'start'
              ? y.start.localeCompare(x.start)
              : (x.next_charge ?? '9').localeCompare(y.next_charge ?? '9'),
      );
      rows = rows.slice(0, Number(a.limit ?? 100));
      return { count: rows.length, items: rows };
    },
  },
  {
    name: 'get_subscription',
    description:
      'Full detail of one subscription: every phase (region or plan switches, gaps = lapses), price history, intro/bonus periods, recent and upcoming charges, shared-plan member dues, proxy repayments, and totals spent so far. Stop summaries include provider termination reasons, refunds and paid-but-unused days/value for each phase.',
    inputSchema: obj(
      { subscription: SUBREF, months_back: { type: 'integer', default: 12 }, months_forward: { type: 'integer', default: 6 }, currency_out: CURRENCY_OUT },
      ['subscription'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a);
      const s = findSub(st, a.subscription);
      const all = chargesBetween(s, s.start, today, today);
      const spent = all.reduce((t, c) => t + chargeValue(st, c, out ?? st.settings.baseCurrency), 0);
      const from = addMonths(today, -Number(a.months_back ?? 12));
      const to = addMonths(today, Number(a.months_forward ?? 6));
      const px = s.proxy;
      const matched = px
        ? matchEntries(
            px.entries,
            all.map((c) => c.date),
          )
        : undefined;
      return {
        ...row(st, s, today, out),
        record: s, // Complete editable history, stable receipt indices and original currencies.
        notes: s.notes ?? null,
        account: s.account ?? null,
        url: s.url ?? null,
        intro: s.intro ?? null,
        bonus: s.bonus ?? null,
        expires: renewalDates(s, today).serviceExpires ?? null,
        spent_total: { amount: round(spent), currency: out ?? st.settings.baseCurrency, charges: all.length },
        phases: phaseSubs(s).map((v) => ({
          start: v.start,
          end: v.end ?? null,
          stop: stopSummary(v, today) ?? null,
          price: v.price,
          currency: v.currency,
          cycle: cycleLabel(v.cycle),
          region: v.region ?? null,
          method: st.methods.find((m) => m.id === v.methodId)?.name ?? null,
          price_history: v.priceHistory ?? null,
          planned: !!v.planned,
        })),
        charges: chargesBetween(s, from, to, today).map((c) => chargeRow(st, c, out)),
        share: s.share
          ? {
              role: s.share.role,
              collect_from: collectionAnchor(s),
              seats: s.share.seats,
              members: s.share.members.map((m) => ({
                id: m.id,
                name: m.name,
                paid_until: m.paidUntil ?? null,
                joined: m.joined ?? null,
                first_period: m.firstPeriod ?? 'prorate',
                first_amount: m.firstAmount ?? null,
                left: m.left ?? null,
                leave_refund: m.leaveRefund ?? null,
                exempt: !!m.exempt,
              })),
              dues: memberDues(s, today, st.settings.collectCurrency ?? st.settings.baseCurrency, st)
                .filter((d) => d.periodsOwed > 0)
                .map((d) => ({ member: d.member.name, periods_owed: d.periodsOwed, owed: money(st, d.owed, d.currency, undefined, out) })),
            }
          : null,
        proxy: px
          ? {
              for: px.forName,
              entries: all.map((c) => ({
                charge: c.date,
                received: matched!.get(c.date)?.received ?? null,
                received_currency: matched!.get(c.date)?.receivedCurrency ?? null,
              })),
            }
          : null,
      };
    },
  },
  {
    name: 'list_charges',
    description:
      'Charges (actual and projected) in a period: today, next 3 days, next 7/30 days, this or next month, last 30 days, this year, or custom from/to. scope=mine excludes proxy payments and reports my_amount as my share for shared plans; gross = full card charges incl. proxy payments; proxy = only proxy payments.',
    inputSchema: obj({
      period: { ...PERIOD, default: 'next_30_days' },
      from: DATE,
      to: DATE,
      scope: { type: 'string', enum: ['mine', 'gross', 'proxy'], default: 'mine' },
      subscription: SUBREF,
      method: { type: 'string', description: 'Payment method id or name.' },
      include_projected: { type: 'boolean', default: true },
      currency_out: CURRENCY_OUT,
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a);
      const [from, to] = rangeOf(a.period ?? 'next_30_days', today, a.from, a.to);
      const sub = a.subscription ? findSub(st, a.subscription) : undefined;
      const method = a.method ? methodRef(st, a.method) : undefined;
      const scope = str(a.scope) ?? 'mine';
      const items = (sub ? chargesBetween(sub, from, to, today) : chargesIn(st, from, to, today, scope))
        .filter((c) => !method || c.sub.methodId === method)
        .filter((c) => a.include_projected !== false || !c.projected)
        .map((c) => chargeRow(st, c, out));
      const sum = (k: 'converted' | 'my') => round(items.reduce((t, i) => t + (k === 'my' ? i.my_amount : i.amount.converted), 0));
      return { from, to, today, currency: out ?? st.settings.baseCurrency, count: items.length, total: sum('converted'), my_total: sum('my'), items };
    },
  },
  {
    name: 'spending_stats',
    description:
      'Aggregate spending over a period, grouped by month, year, category, payment method, currency, region or subscription. Cash basis: each past charge converted at its own day’s FX rate. scope=mine (default) excludes proxy payments and counts my share of shared plans.',
    inputSchema: obj({
      period: { ...PERIOD, default: 'this_year' },
      from: DATE,
      to: DATE,
      group_by: { type: 'string', enum: ['month', 'year', 'category', 'method', 'currency', 'region', 'subscription', 'none'], default: 'category' },
      scope: { type: 'string', enum: ['mine', 'gross', 'proxy'], default: 'mine' },
      include_projected: { type: 'boolean', default: true, description: 'Include projected (future) charges inside the period.' },
      top: { type: 'integer', default: 30 },
      currency_out: CURRENCY_OUT,
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a) ?? st.settings.baseCurrency;
      const [from, to] = rangeOf(a.period ?? 'this_year', today, a.from, a.to);
      const scope = str(a.scope) ?? 'mine';
      const by = str(a.group_by) ?? 'category';
      const groups = new Map<string, { key: string; label: string; total: number; count: number }>();
      let total = 0;
      for (const c of chargesIn(st, from, to, today, scope)) {
        if (a.include_projected === false && c.projected) continue;
        const sub = st.subscriptions.find((x) => x.id === c.sub.id) ?? c.sub;
        const v = chargeValue(st, c, out) * (scope === 'mine' ? myShareFactor(c.sub, c.date) : 1);
        const m = st.methods.find((x) => x.id === c.sub.methodId);
        const [key, label] = groupOf(by, c, sub, m);
        const g = groups.get(key) ?? { key, label, total: 0, count: 0 };
        g.total += v;
        g.count++;
        groups.set(key, g);
        total += v;
      }
      const list = [...groups.values()].sort((x, y) => (by === 'month' || by === 'year' ? x.key.localeCompare(y.key) : y.total - x.total));
      return {
        from,
        to,
        currency: out,
        scope,
        total: round(total),
        groups: list
          .slice(0, Number(a.top ?? 30))
          .map((g) => ({ ...g, total: round(g.total), share_pct: total > 0 ? Math.round((g.total / total) * 1000) / 10 : 0 })),
      };
    },
  },
  {
    name: 'get_trends',
    description:
      'Time series: monthly MRR history, cash-vs-accrual by month (cash = what was charged; accrual = cost spread over the period it covers), or MRR movement between two dates (added / expansion / contraction / churn / FX effect).',
    inputSchema: obj({
      metric: { type: 'string', enum: ['mrr', 'cash_vs_accrual', 'movement'], default: 'mrr' },
      months_back: { type: 'integer', default: 12 },
      months_forward: { type: 'integer', default: 3, description: 'cash_vs_accrual only.' },
      from: { ...DATE, description: 'movement only: start date (default: one month ago).' },
      to: { ...DATE, description: 'movement only: end date (default: today).' },
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const metric = str(a.metric) ?? 'mrr';
      if (metric === 'mrr') return { currency: st.settings.baseCurrency, points: mrrSeries(st, today, Number(a.months_back ?? 12)).map((p) => roundAll(p)) };
      if (metric === 'cash_vs_accrual')
        return {
          currency: st.settings.baseCurrency,
          points: cashVsAccrual(st, today, Number(a.months_back ?? 12), Number(a.months_forward ?? 3)).map((p) => roundAll(p)),
        };
      const mv = movement(st, date(a.from, 'from', addMonths(today, -1)), date(a.to, 'to', today));
      return {
        currency: st.settings.baseCurrency,
        ...roundAll({ ...mv, items: undefined }),
        items: mv.items.map((i) => ({ name: i.sub.name, kind: i.kind, delta: round(i.delta) })),
      };
    },
  },
  {
    name: 'list_payment_methods',
    description:
      'Payment methods (bank cards, App Store region balances, crypto cards, prepaid balances…) with current estimated balance, monthly drain, runway (how long the balance lasts, first shortfall) and a top-up suggestion.',
    inputSchema: obj({ topup_months: { type: 'integer', default: 6 } }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const plans = topUpPlan(st, today, Number(a.topup_months ?? 6));
      return {
        items: st.methods.map((m) => {
          const r = runwayFor(m, st, today);
          const p = plans.find((x) => x.method.id === m.id);
          return {
            record: m,
            top_ups: (m.topUps ?? []).map((p, index) => ({ index, ...p })),
            id: m.id,
            name: m.name,
            kind: m.kind,
            currency: m.currency,
            region: m.region ?? null,
            balance: r ? round(r.current) : (m.balance ?? null),
            balance_as_of: m.balanceAsOf ?? null,
            subscriptions: st.subscriptions
              .filter(
                (s) =>
                  [currentPhase(s, today), ...activePhases(s, today)].some((v) => v.methodId === m.id) &&
                  ['active', 'trial', 'ending'].includes(effectiveStatus(s, today)),
              )
              .map((s) => s.name),
            runway: r
              ? {
                  monthly_drain: round(r.monthlyDrain),
                  covered_charges: r.coveredCharges,
                  runs_out_on: r.runsOutOn ?? null,
                  shortfall: r.shortfall ? { date: r.shortfall.date, name: r.shortfall.sub.name, amount: round(r.shortfall.amount) } : null,
                }
              : null,
            topup: p && p.need > 0 ? { need: round(p.need), min_need: round(p.minNeed), deadline: p.deadline ?? null } : null,
          };
        }),
      };
    },
  },
  {
    name: 'list_people',
    description:
      'People in the ledger (shared-plan members and people I pay on behalf of, each listed once): contact, which shared plans / proxy payments they are in and the separate account on each shared plan, how much they owe me now, how much they have paid so far and when they last paid. Use query to find someone by name.',
    inputSchema: obj({
      query: { type: 'string', description: 'Fuzzy name filter.' },
      owing_only: { type: 'boolean', default: false },
      currency_out: CURRENCY_OUT,
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a) ?? st.settings.baseCurrency;
      const q = normName(str(a.query));
      const list = peopleLedger(st, today).filter((l) => (!q || normName(l.person.name).includes(q)) && (!a.owing_only || l.periodsOwed > 0));
      const rows = list.map((l) => personRow(st, l, out, today));
      return { currency: out, count: rows.length, total_owed: round(rows.reduce((x, r) => x + r.owed, 0)), people: rows };
    },
  },
  {
    name: 'get_receivables',
    description:
      'Money others owe me: by_person totals each person across all their shared plans and proxy payments; share lists shared-plan members whose payment is due/overdue; proxy lists charges paid on behalf of someone not yet repaid.',
    inputSchema: obj({ kind: { type: 'string', enum: ['share', 'proxy', 'all'], default: 'all' }, currency_out: CURRENCY_OUT }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const out = outCcy(st, a) ?? st.settings.baseCurrency;
      const kind = str(a.kind) ?? 'all';
      const share =
        kind === 'proxy'
          ? []
          : st.subscriptions.flatMap((s) =>
              memberDues(s, today, st.settings.collectCurrency ?? st.settings.baseCurrency, st)
                .filter((d) => d.periodsOwed > 0)
                .map((d) => ({
                  subscription_id: s.id,
                  name: s.name,
                  person_id: d.member.personId ?? null,
                  member: d.member.name,
                  contact: d.member.contact ?? null,
                  periods_owed: d.periodsOwed,
                  paid_until: d.member.paidUntil ?? null,
                  owed: money(st, d.owed, d.currency, undefined, out),
                })),
            );
      const proxy =
        kind === 'share'
          ? []
          : st.subscriptions
              .filter((s) => s.proxy)
              .flatMap((s) => {
                const cs = chargesBetween(s, s.start, today, today);
                const m = matchEntries(
                  s.proxy!.entries,
                  cs.map((c) => c.date),
                );
                return cs
                  .filter((c) => m.get(c.date)?.received == null)
                  .map((c) => {
                    const e = m.get(c.date);
                    const charged = e?.charged ?? c.amount;
                    const ccy = e?.chargedCurrency ?? c.currency;
                    return {
                      subscription_id: s.id,
                      name: s.name,
                      person_id: s.proxy!.personId ?? null,
                      for: s.proxy!.forName,
                      charge: c.date,
                      charged: money(st, charged, ccy, c.date, out),
                    };
                  });
              });
      const total = share.reduce((t, x) => t + x.owed.converted, 0) + proxy.reduce((t, x) => t + x.charged.converted, 0);
      // 按人汇总：只列现在欠钱的人，金额与下面的明细同源（memberDues / 代付逐期对账）
      const by_person = peopleLedger(st, today)
        .map((l) => ({ ...l, items: l.items.filter((i) => i.periodsOwed > 0 && (kind === 'all' || i.kind === kind)) }))
        .filter((l) => l.items.length)
        .map((l) => ({ ...l, owed: l.items.reduce((a, i) => a + i.owed, 0), periodsOwed: l.items.reduce((a, i) => a + i.periodsOwed, 0) }))
        .map((l) => personRow(st, l, out, today))
        .sort((a, b) => b.owed - a.owed);
      return { currency: out, total_outstanding: round(total), by_person, share, proxy };
    },
  },
  {
    name: 'get_insights',
    description:
      'Health check and reports: insights (renewals, price hikes, low balances, duplicates), year_review (spending and losses from stops in that year), prepaid (remaining prepaid value), cancel_savings (money saved by cancelling), stop_losses (unrefunded unused service after cancellation or provider termination, by phase and type). Stop losses cover all history through today, exclude proxy payments and count only my share, using stop-date FX; prorated full refunds have no loss. Missing FX keeps original amounts but returns null base amounts/totals with an incomplete flag.',
    inputSchema: obj({
      section: { type: 'string', enum: ['insights', 'year_review', 'prepaid', 'cancel_savings', 'stop_losses'], default: 'insights' },
      year: { type: 'string', description: 'year_review only, e.g. 2025.' },
    }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const sec = str(a.section) ?? 'insights';
      const base = st.settings.baseCurrency;
      if (sec === 'insights')
        return { items: insights(st, today).map((i) => ({ tone: i.tone, title: i.title, body: i.body, subscriptions: i.subs?.map((s) => s.name) ?? [] })) };
      if (sec === 'year_review') {
        const r = yearReview(st, today, str(a.year) ?? today.slice(0, 4));
        return {
          currency: base,
          year: r.year,
          stop_loss: Number.isFinite(r.stopLoss) ? round(r.stopLoss) : null,
          stop_loss_incomplete: !Number.isFinite(r.stopLoss),
          total: round(r.total),
          charges: r.charges,
          per_day: round(r.perDay),
          currencies: r.currencies,
          top: r.items.slice(0, 10).map((x) => ({ name: x.sub.name, total: round(x.sum) })),
          longest: r.longest ? { name: r.longest.sub.name, days: r.longest.days } : null,
          busiest_month: r.busiestMonth ? { month: r.busiestMonth.month, total: round(r.busiestMonth.sum) } : null,
          new: r.newSubs.map((s) => s.name),
          ended: r.ended.map((s) => s.name),
        };
      }
      if (sec === 'prepaid') {
        const p = prepaidValue(st, today);
        return {
          currency: base,
          total: round(p.total),
          unused_total: Number.isFinite(p.unusedTotal) ? round(p.unusedTotal) : null,
          unused_incomplete: p.unusedIncomplete,
          unused_items: p.unusedItems.map((i) => ({ name: i.sub.name, value: Number.isFinite(i.value) ? round(i.value) : null, until: i.until })),
          items: p.items.map((i) => ({ name: i.sub.name, value: round(i.value), until: i.until })),
        };
      }
      if (sec === 'stop_losses') {
        const losses = stopLosses(st, today);
        const baseAmount = (n: number) => (Number.isFinite(n) ? round(n) : null);
        return {
          currency: base,
          as_of: today,
          total: baseAmount(losses.total),
          incomplete: losses.incomplete,
          by_type: { cancel: baseAmount(losses.byKind.cancel), terminate: baseAmount(losses.byKind.terminate) },
          items: losses.items.map((i) => ({
            subscription_id: i.sub.id,
            name: i.sub.name,
            phase_index: i.phaseIndex,
            phase_start: i.phase.start,
            kind: i.kind,
            date: i.date,
            paid_through: i.paidThrough,
            ...(i.kind === 'terminate' && i.reason ? { reason: i.reason } : {}),
            currency: i.currency,
            paid: round(i.paid),
            paid_base: baseAmount(i.paidBase),
            refunded: round(i.refunded),
            refunded_base: baseAmount(i.refundedBase),
            loss: round(i.loss),
            loss_base: baseAmount(i.lossBase),
            fx_missing: i.fxMissing,
            refund_status: i.refundStatus,
            wasted_days: i.wastedDays,
          })),
        };
      }
      const c = cancelSavings(st, today);
      return {
        currency: base,
        total: round(c.total),
        items: c.items.map((i) => ({ name: i.sub.name, saved: round(i.saved), since: i.since, monthly: round(i.monthly) })),
      };
    },
  },
  {
    name: 'list_events',
    description:
      'Changelog of spending decisions: subscriptions started, ended, paused, resumed, price changes and plan/region switches, each with its effect on monthly spend (base currency).',
    inputSchema: obj({ since: DATE, until: DATE, subscription: SUBREF, limit: { type: 'integer', default: 50 } }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const sub = a.subscription ? findSub(st, a.subscription) : undefined;
      const items = events(st, today)
        .filter((e) => (!a.since || e.date >= String(a.since)) && (!a.until || e.date <= String(a.until)) && (!sub || e.sub.id === sub.id))
        .slice(0, Number(a.limit ?? 50))
        .map((e) => ({ date: e.date, subscription_id: e.sub.id, name: e.sub.name, kind: e.kind, monthly_delta: round(e.delta), note: e.note ?? null }));
      return { currency: st.settings.baseCurrency, count: items.length, items };
    },
  },

  // ---------- 写入 ----------
  {
    name: 'search_app_store',
    description:
      'Look up an app on the App Store by name or App Store link: returns name, icon URL, store URL, seller and genre. Use it to fill icon and url when creating a subscription for an app.',
    inputSchema: obj({ query: { type: 'string' }, country: { type: 'string', description: 'Two-letter store region, e.g. us, tr, cn. Defaults to us.' } }, [
      'query',
    ]),
    async run(a) {
      return { results: await searchAppStore(String(a.query ?? ''), str(a.country) ?? 'us') };
    },
  },
  {
    name: 'create_subscription',
    description:
      'Create a subscription. price is per cycle in the given currency. Rejects a duplicate (same name and start date) unless force=true. Use dry_run=true to preview first. Call list_categories first and reuse an existing code/name. Unknown categories fail; use save_category action=create or create_category=true with optional category_icon/category_color to explicitly create one.',
    write: true,
    inputSchema: obj(
      {
        name: { type: 'string' },
        price: { type: 'number', minimum: 0 },
        currency: { type: 'string', description: 'ISO code, e.g. USD, CNY, TRY.' },
        cycle: CYCLE,
        start: { ...DATE, description: 'First charge / purchase date. Defaults to today.' },
        category: { ...CATEGORY, description: `${CATEGORY.description} Defaults to the existing Tools category; if absent, specify an existing category.` },
        ...CATEGORY_CREATE,
        tags: { type: 'array', items: { type: 'string' } },
        method: { type: 'string', description: 'Payment method id or name.' },
        region: { type: 'string', description: 'ISO country code for region-priced stores (App Store TR, NG…).' },
        url: { type: 'string' },
        icon: { type: 'string', description: 'Icon image URL (https), e.g. artwork from search_app_store.' },
        notes: { type: 'string' },
        account: { type: 'string', description: 'Login account: email, phone number (for carriers) or username shown on the receipt.' },
        status: { type: 'string', enum: ['active', 'trial'], default: 'active' },
        trial_end: DATE,
        chargeLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
        cancelLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
        end: { ...DATE, description: 'Will not renew after this date.' },
        intro: {
          type: 'object',
          properties: { price: { type: 'number' }, until: DATE },
          required: ['price', 'until'],
          description: 'Intro price until a date.',
        },
        payments: {
          type: 'array',
          description:
            'Actual past charges with their real amounts (e.g. a monthly bill history). When given they become the whole charge history, so include EVERY period, including ones equal to price; future charges continue at price from the last one. Dates on or after start and not after today.',
          items: obj({ date: DATE, amount: { type: 'number', minimum: 0 }, note: { type: 'string' } }, ['date', 'amount']),
        },
        force: { type: 'boolean', default: false },
        id: { type: 'string', description: 'Internal: keep this id (used when confirming an earlier draft).' },
        dry_run: DRY,
      },
      ['name', 'price', 'currency', 'cycle'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const name = decodeEntities(String(a.name ?? '').trim());
      const start = date(a.start, 'start', today);
      const currency = String(a.currency ?? '').toUpperCase();
      // 历史扣款：按日期排序，必须落在开始日到今天之间
      const payments = (Array.isArray(a.payments) ? (a.payments as Array<Record<string, unknown>>) : [])
        .map((p) => {
          const d = date(p.date, 'payments.date');
          if (d < start || d > today) throw new Error(t('mcp.error.paymentOutOfRange', { date: d }));
          return { date: d, amount: Math.abs(num(p.amount, 'payments.amount')), ...(str(p.note) ? { note: str(p.note) } : {}) };
        })
        .sort((x, y) => x.date.localeCompare(y.date));
      if (!st.fx.rates[currency]) throw new Error(t('mcp.error.unsupportedCurrency', { code: currency }));
      if (!a.force && st.subscriptions.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.start === start))
        throw new Error(t('mcp.error.duplicateSub', { name }));
      const category =
        a.category === undefined
          ? { name: categoryRef(st, presetCategory(categoryList(st.settings, st.subscriptions), 'tools'))! }
          : subscriptionCategory(st, a.category, a);
      const cyc = a.cycle as { unit: Subscription['cycle']['unit']; every?: number };
      const sub: Subscription = {
        // 确认草稿时沿用草稿里生成的 id，后续基于它的草稿（合租、成员）才能对上
        id: str(a.id) && !st.subscriptions.some((s) => s.id === str(a.id)) ? str(a.id)! : uid(),
        name,
        category: category.name,
        tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
        price: num(a.price, 'price'),
        currency,
        cycle: { unit: cyc?.unit, every: Math.max(1, Number(cyc?.every ?? 1)) },
        start,
        chargeLeadDays: a.chargeLeadDays == null ? undefined : Number(a.chargeLeadDays),
        cancelLeadDays: a.cancelLeadDays == null ? undefined : Number(a.cancelLeadDays),
        status: a.status === 'trial' ? 'trial' : 'active',
        methodId: methodRef(st, a.method) ?? st.settings.defaultMethodId,
        region: str(a.region)?.toUpperCase(),
        url: str(a.url),
        icon: str(a.icon)?.startsWith('https://') ? str(a.icon) : undefined,
        notes: str(a.notes),
        account: str(a.account),
        trialEnd: a.trial_end ? date(a.trial_end, 'trial_end') : undefined,
        end: a.end ? date(a.end, 'end') : undefined,
        intro: a.intro
          ? { price: num((a.intro as { price: unknown }).price, 'intro.price'), until: date((a.intro as { until: unknown }).until, 'intro.until') }
          : undefined,
        ...(payments.length ? { payments } : {}),
        createdAt: today,
      };
      return commit(ctx, st, today, sub, a.dry_run, ['created'], category.creation);
    },
  },
  {
    name: 'update_subscription',
    description:
      'Change descriptive fields and settings of a subscription (name, category, tags, url, notes, payment method, region, reminder days, end date (no renewal after it), next due date, trial end). Only provided keys change. For price changes use change_price; for plan/region switches use change_plan. Call list_categories before assigning a category. Unknown names fail; use save_category action=create or create_category=true with optional category_icon/category_color to explicitly create one.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        set: obj({
          icon: { type: ['string', 'null'] },
          show_on_public: { type: 'boolean' },
          start: DATE,
          intro: {
            type: ['object', 'null'],
            properties: { price: { type: 'number', minimum: 0 }, until: DATE },
            required: ['price', 'until'],
            additionalProperties: false,
          },
          bonus: { type: ['object', 'null'], properties: { from: DATE, until: DATE }, required: ['from', 'until'], additionalProperties: false },
          name: { type: 'string' },
          category: CATEGORY,
          tags: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          manage_url: { type: 'string' },
          notes: { type: 'string' },
          account: { type: 'string', description: 'Login account (email / phone / username).' },
          method: { type: ['string', 'null'], description: 'Payment method id or name.' },
          region: { type: 'string' },
          remind_days: { type: ['integer', 'null'], minimum: -1, description: '-1 disables; null restores the global setting.' },
          end: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear (will renew again).' },
          next_due: { type: ['string', 'null'] },
          trial_end: { type: ['string', 'null'] },
          expires: { type: ['string', 'null'] },
          chargeLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
          cancelLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
        }),
        ...CATEGORY_CREATE,
        dry_run: DRY,
      },
      ['subscription', 'set'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const set = (a.set ?? {}) as Record<string, unknown>;
      // 多段订阅：顶层字段先换成今天所在的那段，改完再同步回去
      const next: Subscription = toEditForm({ ...s }, today);
      const changed: string[] = [];
      const put = <K extends keyof Subscription>(k: K, v: Subscription[K], label = String(k)) => {
        next[k] = v;
        changed.push(label);
      };
      if ('chargeLeadDays' in set) put('chargeLeadDays', Number(set.chargeLeadDays));
      if ('cancelLeadDays' in set) put('cancelLeadDays', Number(set.cancelLeadDays));
      if ('icon' in set) put('icon', str(set.icon));
      if ('show_on_public' in set) put('showOnPublic', set.show_on_public as boolean);
      if ('start' in set) {
        if (s.phases?.length) throw new Error(t('mcp.error.invalidInput', { field: 'start: use change_plan edit for phased subscriptions' }));
        put('start', date(set.start, 'start'));
      }
      if ('intro' in set) put('intro', set.intro == null ? undefined : (set.intro as Subscription['intro']));
      if ('bonus' in set) put('bonus', set.bonus == null ? undefined : (set.bonus as Subscription['bonus']));
      if ('name' in set) put('name', String(set.name).trim());
      const category = 'category' in set ? subscriptionCategory(st, set.category, a) : undefined;
      if (category) put('category', category.name);
      if ('tags' in set) put('tags', Array.isArray(set.tags) ? set.tags.map(String) : []);
      if ('url' in set) put('url', str(set.url));
      if ('manage_url' in set) put('manageUrl', str(set.manage_url), 'manage_url');
      if ('notes' in set) put('notes', str(set.notes));
      if ('account' in set) put('account', str(set.account));
      if ('method' in set) put('methodId', methodRef(st, set.method), 'method');
      if ('region' in set) put('region', str(set.region)?.toUpperCase());
      if ('remind_days' in set) put('remindDays', set.remind_days == null ? undefined : Number(set.remind_days), 'remind_days');
      for (const [k, f] of [
        ['end', 'end'],
        ['next_due', 'nextDue'],
        ['trial_end', 'trialEnd'],
        ['expires', 'expires'],
      ] as const) {
        if (k in set) put(f, set[k] == null ? undefined : date(set[k], k), k);
      }
      if (!changed.length) throw new Error(t('mcp.error.noFields'));
      return commit(ctx, st, today, syncPhase(preserveRenewalHistory(s, next, today), today), a.dry_run, changed, category?.creation);
    },
  },
  {
    name: 'change_price',
    description:
      'Add (default), edit or remove a dated price point in an existing plan. edit/remove require phase and original_from. The initial price can be edited but not removed. Dates must be within the phase and unique. Past estimated charges are recalculated; recorded payments stay unchanged. Preview reports affected_estimated_charges.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        action: {
          type: 'string',
          enum: ['add', 'edit', 'remove'],
          description: 'Default add (upsert by date). edit/remove target an existing point using phase and original_from. The initial point cannot be removed.',
        },
        phase: { ...DATE, description: 'Exact phase start; required for edit/remove, including single-phase subscriptions.' },
        original_from: { ...DATE, description: 'Original effective date; required for edit/remove.' },
        amount: { type: 'number', minimum: 0 },
        from: { ...DATE, description: 'Effective date; defaults to today for add, original_from for edit.' },
        dry_run: DRY,
      },
      ['subscription'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const action = a.action ?? 'add';
      const phase = action === 'add' ? undefined : date(a.phase, 'phase');
      const original = action === 'add' ? undefined : date(a.original_from, 'original_from');
      const after =
        action === 'remove'
          ? removePricePoint(s, phase!, original!)
          : action === 'edit'
            ? editPricePoint(s, phase!, original!, { from: date(a.from, 'from', original), amount: num(a.amount, 'amount') })
            : changePrice(s, date(a.from, 'from', today), num(a.amount, 'amount'));
      return { ...(await commit(ctx, st, today, after, a.dry_run, ['price'])), affected_estimated_charges: affectedPriceCharges(s, after, today) };
    },
  },
  {
    name: 'change_plan',
    destructive: true,
    description:
      'Correct an existing phase using action=edit, at=its exact start date, set=only changed fields (camelCase; null clears); preserves unrelated phases and payments. action=remove deletes that phase and its payments, requires at least two phases. Preview before rewriting history. Start a new phase of the same subscription: switch plan, region, currency or payment method from a date (action=switch), resubscribe after a gap or provider termination (action=resume, preserves the stopped phase), add missing history BEFORE the subscription’s start (action=earlier: at = when that earlier phase began, e.g. a one-time purchase before it became a subscription; it runs until the current first phase starts, or until earlier_until if there was a gap), or confirm / drop a planned future phase (action=confirm|drop, at = that phase’s start). Set plan.planned=true for an uncertain future switch. For action=switch, keep_previous_until keeps the previous phase running (and billing) in parallel until that date — e.g. a new Turkey account while the prepaid US one runs out; omit it for a seamless switch.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        action: { type: 'string', enum: ['switch', 'resume', 'earlier', 'confirm', 'drop', 'edit', 'remove'] },
        at: DATE,
        set: obj({
          start: DATE,
          end: { type: ['string', 'null'], format: 'date' },
          price: { type: 'number', minimum: 0 },
          currency: { type: 'string' },
          cycle: CYCLE,
          method: { type: ['string', 'null'] },
          region: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
          nextDue: { type: ['string', 'null'], format: 'date' },
          planned: { type: 'boolean' },
          priceHistory: {
            type: ['array', 'null'],
            description:
              'Full replacement, retaining the initial effective date; use change_price action=edit to move that initial date. Latest amount becomes phase price.',
            items: obj({ from: DATE, amount: { type: 'number', minimum: 0 } }, ['from', 'amount']),
          },
          intro: {
            type: ['object', 'null'],
            properties: { price: { type: 'number', minimum: 0 }, until: DATE },
            required: ['price', 'until'],
            additionalProperties: false,
          },
          bonus: { type: ['object', 'null'], properties: { from: DATE, until: DATE }, required: ['from', 'until'], additionalProperties: false },
        }),
        plan: obj(
          {
            price: { type: 'number' },
            currency: { type: 'string' },
            cycle: CYCLE,
            method: { type: ['string', 'null'] },
            region: { type: 'string' },
            note: { type: 'string' },
            planned: { type: 'boolean' },
          },
          ['price', 'currency', 'cycle'],
        ),
        keep_previous_until: {
          ...DATE,
          description: 'action=switch only: the previous phase keeps running until this date (after `at`), overlapping the new one.',
        },
        earlier_until: { ...DATE, description: 'action=earlier only: the earlier phase ended on this date (a gap before the next one).' },
        dry_run: DRY,
      },
      ['subscription', 'action', 'at'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const at = date(a.at, 'at');
      const act = String(a.action);
      if (act === 'edit' || act === 'remove') {
        const phases = s.phases?.length ? s.phases : [{ ...s, phases: undefined }];
        const index = phases.findIndex((p) => p.start === at);
        if (index < 0 || (act === 'remove' && phases.length < 2)) throw new Error(t('mcp.error.invalidTarget'));
        const patch = { ...((a.set ?? {}) as Record<string, unknown>) };
        if ('method' in patch) {
          patch.methodId = methodRef(st, patch.method) ?? null;
          delete patch.method;
        }
        if (patch.currency) validateCurrency(st, String(patch.currency));
        const after = act === 'remove' ? removePhase(s, index) : editPhase(s, at, patch);
        return {
          ...(await commit(ctx, st, today, after, a.dry_run, [act])),
          affected_estimated_charges: affectedPriceCharges(s, after, today),
          before: phases[index],
          after: act === 'remove' ? null : after.phases?.find((p) => p.start === (patch.start ?? at)),
          references: { subscription: s.id, phase: at, removed_payments: act === 'remove' ? (phases[index].payments ?? []) : [] },
        };
      }
      if (act === 'confirm') return commit(ctx, st, today, confirmPlan(s, at), a.dry_run, ['confirm_plan']);
      if (act === 'drop') return commit(ctx, st, today, dropPlan(s, at), a.dry_run, ['drop_plan']);
      const p = a.plan as Record<string, unknown> | undefined;
      if (!p) throw new Error(t('mcp.error.needPlan'));
      const cyc = p.cycle as { unit: Subscription['cycle']['unit']; every?: number };
      const plan = {
        price: num(p.price, 'plan.price'),
        currency: String(p.currency).toUpperCase(),
        cycle: { unit: cyc.unit, every: Math.max(1, Number(cyc.every ?? 1)) },
        methodId: 'method' in p ? methodRef(st, p.method) : currentPhase(s, today).methodId,
        region: str(p.region)?.toUpperCase(),
        note: str(p.note),
        planned: p.planned ? true : undefined,
      };
      if (!st.fx.rates[plan.currency]) throw new Error(t('mcp.error.unsupportedCurrency', { code: plan.currency }));
      if (act === 'earlier')
        return commit(ctx, st, today, prependPlan(s, at, plan, a.earlier_until != null ? date(a.earlier_until, 'earlier_until') : undefined), a.dry_run, [act]);
      const keep = act === 'switch' && a.keep_previous_until != null ? date(a.keep_previous_until, 'keep_previous_until') : undefined;
      return commit(
        ctx,
        st,
        today,
        act === 'resume' ? resume(s, at, plan) : switchPlan(s, at, plan, keep),
        a.dry_run,
        keep ? [act, 'keep_previous_until'] : [act],
      );
    },
  },
  {
    name: 'set_status',
    description:
      'Mark as trial (action=trial, trial_end is the first paid charge date; null clears; stopped subscriptions must resume a new phase first); pause (recoverable); cancel with immediate=false (default): do not renew after at, the last service day; cancel with immediate=true: voluntarily stop using it on at; terminate: provider disabled access on at, with optional reason. Immediate cancel and terminate compute the original paidThrough and accept an optional refund (positive amount, stored negative in the subscription currency; settled is the actual card refund). No refund means unrefunded. Preview includes paidThrough, suggestedRefund, unusedDays, unusedValue and wastedDays. Terminated subscriptions cannot reactivate; use change_plan action=resume to resubscribe with a new phase. Reactivate clears pause, stop and end for other subscriptions.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        action: { type: 'string', enum: ['pause', 'cancel', 'terminate', 'reactivate', 'trial'] },
        at: { ...DATE, description: 'Defaults to today. Non-immediate cancel: last service day. Immediate cancel / terminate: actual stop day.' },
        trial_end: { ...DATE, type: ['string', 'null'], description: 'trial only: first paid charge date; null clears, omitted preserves the existing value.' },
        immediate: { type: 'boolean', default: false, description: 'cancel only: stop using the service immediately instead of non-renewal.' },
        reason: { type: 'string', description: 'Optional provider termination reason; terminate only.' },
        refund: obj(
          {
            amount: { type: 'number', minimum: 0 },
            date: DATE,
            currency: { type: 'string', description: 'Must equal the subscription currency; usually omit.' },
            settled: obj({ amount: { type: 'number', minimum: 0 }, currency: { type: 'string' } }, ['amount', 'currency']),
          },
          ['amount'],
        ),
        dry_run: DRY,
      },
      ['subscription', 'action'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const at = date(a.at, 'at', today);
      const act = String(a.action);
      let next: Subscription;
      if (act === 'reactivate') next = reactivate(s, today);
      else if (act === 'terminate' || (act === 'cancel' && a.immediate === true)) {
        const r = a.refund as { amount: unknown; date?: unknown; currency?: unknown; settled?: { amount: unknown; currency: unknown } } | undefined;
        next = stopSubscription(
          s,
          today,
          act === 'terminate' ? 'terminate' : 'cancel',
          at,
          str(a.reason),
          r
            ? {
                amount: num(r.amount, 'refund.amount'),
                date: date(r.date, 'refund.date', at),
                currency: str(r.currency)?.toUpperCase(),
                settled: r.settled ? { amount: num(r.settled.amount, 'refund.settled.amount'), currency: String(r.settled.currency).toUpperCase() } : undefined,
              }
            : undefined,
        );
      } else {
        if (['ended', 'terminated'].includes(effectiveStatus(s, today)) || s.stop) throw new Error(t('mcp.error.subscriptionEnded'));
        if (act === 'trial')
          next = {
            ...s,
            status: 'trial',
            pausedAt: undefined,
            trialEnd: 'trial_end' in a ? (a.trial_end == null ? undefined : date(a.trial_end, 'trial_end')) : s.trialEnd,
          };
        else if (act === 'pause') next = { ...s, status: 'paused', pausedAt: at };
        else if (act === 'cancel') {
          if (a.refund) throw new Error(t('mcp.error.invalidStop'));
          next = cancelAtEnd(s, at, today);
        } else throw new Error(t('mcp.error.invalidStop'));
      }
      return commit(ctx, st, today, next, a.dry_run, [act]);
    },
  },
  {
    name: 'record_payment',
    description:
      'Record or replace an actual charge (replace={date,index}, same-day zero-based index; phase selects overlapping history), refund (positive amount — stored negative; total refunds cannot exceed the current period paid amount), adjustment or failed charge for a subscription, in the subscription’s currency. Optional currency must equal the selected phase currency for refunds. settled = what the card was actually charged in another currency (e.g. TRY subscription billed in USD). Rejects same-day same-amount duplicates unless allow_duplicate.',
    write: true,
    inputSchema: obj(
      {
        replace: obj({ date: DATE, index: { type: 'integer', minimum: 0 } }, ['date', 'index']),
        subscription: SUBREF,
        date: { ...DATE, description: 'Defaults to today.' },
        amount: { type: 'number', minimum: 0 },
        currency: {
          type: 'string',
          description: 'Refund currency must equal the subscription / selected phase currency. Use settled for a different card currency.',
        },
        kind: { type: 'string', enum: ['charge', 'refund', 'adjust', 'failed'], default: 'charge' },
        settled: obj({ amount: { type: 'number' }, currency: { type: 'string' } }, ['amount', 'currency']),
        note: { type: 'string' },
        allow_duplicate: { type: 'boolean', default: false },
        phase: {
          ...DATE,
          description:
            'Start date of the phase this payment belongs to; only needed when two phases overlap on that date (defaults to the latest-started one).',
        },
        dry_run: DRY,
      },
      ['subscription', 'amount'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const d = date(a.date, 'date', today);
      const kind = str(a.kind) ?? 'charge';
      const sign = kind === 'refund' ? -1 : 1;
      const amount = sign * Math.abs(num(a.amount, 'amount'));
      const existing = chargesBetween(s, d, d, today).filter((c) => !c.projected && Math.abs(c.amount - amount) < 0.005);
      const isRecorded = [...(s.payments ?? []), ...(s.phases ?? []).flatMap((p) => p.payments ?? [])].some(
        (p) => p.date === d && Math.abs(p.amount - amount) < 0.005,
      );
      if (isRecorded && existing.length && !a.allow_duplicate && !a.replace) throw new Error(t('mcp.error.duplicatePayment', { date: d, amount }));
      const st2 = a.settled as { amount: unknown; currency: unknown } | undefined;
      const pay: Payment = {
        date: d,
        currency: str(a.currency)?.toUpperCase(),
        amount,
        kind: kind === 'charge' ? undefined : (kind as Payment['kind']),
        settled: st2 ? { amount: sign * Math.abs(num(st2.amount, 'settled.amount')), currency: String(st2.currency).toUpperCase() } : undefined,
        note: str(a.note),
      };
      return commit(
        ctx,
        st,
        today,
        savePayment(s, today, pay, a.replace as { date: string; index: number } | undefined, a.phase != null ? date(a.phase, 'phase') : undefined),
        a.dry_run,
        ['payment'],
      );
    },
  },
  {
    name: 'delete_payment',
    description: 'Delete one recorded payment of a subscription by date (index picks among several on the same day, 0-based).',
    write: true,
    destructive: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        date: DATE,
        index: { type: 'integer', default: 0 },
        phase: { ...DATE, description: 'Start date of the phase holding the payment, when two phases overlap.' },
        dry_run: DRY,
      },
      ['subscription', 'date'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      return commit(
        ctx,
        st,
        today,
        deletePayment(s, today, date(a.date, 'date'), Number(a.index ?? 0), a.phase != null ? date(a.phase, 'phase') : undefined),
        a.dry_run,
        ['delete_payment'],
      );
    },
  },
  {
    name: 'get_carpool',
    description:
      'Shared plans (carpools): for each plan I organize (role owner) or joined (role member): seats taken / total and free seats, the shared collection anchor (collect_from), the plan collection rule (rule: fee, currency, every_months; stored=false means inferred from the most common member rate); members with their actual leave_refund (null when not refunded), fee and billing months, follows_rule (true = fee follows the plan rule, false = custom fee or exempt), overdue_days (days the next unpaid collection is past due, 0 if not), alignment anchor, paid_until, first_collection (join date through aligned end, inclusive, and first fee), next_collection and next_collection_date (earliest unpaid coverage start, possibly overdue; free partial first periods are skipped), is_first_period (whether that next unpaid period is the first), and pending_amount (total currently owed, zero when nothing is due); per year: cost, expected income from members, and i_pay (what I still pay myself) or i_earn (profit when members pay more than the cost); since the carpool started: paid, received, and i_pay / i_earn to date. Amounts in the base currency unless noted.',
    inputSchema: obj({ subscription: { ...SUBREF, description: 'Optional: only this plan.' } }),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const subs = a.subscription ? [findSub(st, a.subscription)] : st.subscriptions.filter((s) => s.share);
      const base = st.settings.baseCurrency;
      return {
        currency: base,
        plans: subs
          .filter((s) => s.share)
          .map((s) => {
            const sh = s.share!;
            const live = sh.members.filter((m) => memberAboard(m, today));
            const dues = new Map(memberDues(s, today, st.settings.collectCurrency ?? st.settings.baseCurrency, st).map((d) => [d.member.id, d]));
            const book = carLedger(st, s, today);
            return {
              id: s.id,
              name: s.name,
              role: sh.role,
              price: money(st, s.price, s.currency),
              cycle: cycleLabel(s.cycle),
              seats: { total: sh.seats, taken: live.length + 1, free: Math.max(0, sh.seats - live.length - 1) },
              owner: sh.role === 'member' ? (sh.ownerName ?? null) : undefined,
              since: book.since ?? null,
              collect_from: collectionAnchor(s),
              rule: sh.role === 'owner' ? ruleOut(st, s, today) : null,
              // 方向写清楚：i_pay = 我自己净掏的钱，i_earn = 收的比付的多（赚了）；两者至多一个大于 0
              year: {
                cost: round(book.yearCost),
                expected_income: round(book.yearIncome),
                i_pay: round(Math.max(0, book.yearNet)),
                i_earn: round(Math.max(0, -book.yearNet)),
              },
              to_date: {
                paid: round(book.paid),
                received: round(book.received),
                i_pay: round(Math.max(0, book.net)),
                i_earn: round(Math.max(0, -book.net)),
              },
              members: sh.members.map((m) => {
                const fee = memberFee(st, s, m, today);
                const d = dues.get(m.id);
                return {
                  id: m.id,
                  name: m.name,
                  exempt: !!m.exempt,
                  active: memberAboard(m, today),
                  joined: m.joined ?? null,
                  left: m.left ?? null,
                  fee: { amount: fee.amount, currency: fee.currency, every_months: memberBillMonths(s, m, today) },
                  ...collectionSummary(st, s, m, d, today),
                  first_period: m.firstPeriod ?? 'prorate',
                  first_amount: m.firstAmount ?? null,
                  owed: d && d.periodsOwed > 0 ? money(st, d.owed, d.currency) : null,
                  payments: (m.payments ?? []).length,
                };
              }),
            };
          }),
      };
    },
  },
  {
    name: 'delete_subscription',
    description: 'Delete a subscription and its whole history. Irreversible: always preview with dry_run first; the user confirms.',
    write: true,
    destructive: true,
    inputSchema: obj({ subscription: SUBREF, dry_run: DRY }, ['subscription']),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      const preview = {
        before: s,
        after: null,
        subscription: row(st, s, today),
        changed: ['deleted'],
        references: {
          phases: s.phases?.length ?? 1,
          payments: (s.payments?.length ?? 0) + (s.phases ?? []).reduce((n, p) => n + (p.payments?.length ?? 0), 0),
          share: s.share ?? null,
          proxy: s.proxy ?? null,
          default_public_hidden: st.settings.publicHidden?.includes(s.id) ?? false,
        },
      };
      if (a.dry_run) {
        ctx.overlay?.set(s.id, null);
        ctx.draftState = { ...ctx.draftState, settings: { ...st.settings, publicHidden: st.settings.publicHidden?.filter((id) => id !== s.id) } };
        return { dry_run: true, ...preview };
      }
      await saveLedgerEdit(ctx.env, { settings: { ...st.settings, publicHidden: st.settings.publicHidden?.filter((id) => id !== s.id) } }, [], [s.id]);
      return { ok: true, ...preview };
    },
  },
  {
    name: 'set_share',
    destructive: true,
    description:
      'Turn a subscription into a shared plan or change its sharing: role owner (I pay the full price and collect from members) or member (I joined someone else’s plan; price is my part), seats = total seats including me, owner_name for member role, since = date the carpool started. collect_from optionally overrides the shared collection anchor; otherwise since, earliest recorded coverage start (or a period inferred from paid-until when coverage starts are absent), then subscription start is inferred. Returns the effective collect_from in both previews and saves. Only the joining period aligns to the anchor; later collections start after individual paid-through. Null clears since/collect_from/owner_name so defaults can be inferred again. role none stops sharing. rule sets the owner plan collection rule {fee, fee_currency, bill_every}: members following the rule get the new fee from rule_from (default today) as a dated fee change, keeping receipts and earlier periods; custom-fee, exempt and departed members are untouched. The first time a rule is saved, members whose fee differs are marked custom. Returns the effective rule. Describe the returned fee, cycle, date and affected members; do not infer annual income or savings from this result.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        role: { type: 'string', enum: ['owner', 'member', 'none'] },
        seats: { type: 'integer', minimum: 1, description: 'Total seats including me.' },
        owner_name: { type: ['string', 'null'] },
        since: { ...DATE, type: ['string', 'null'] },
        collect_from: {
          ...DATE,
          type: ['string', 'null'],
          description:
            'Optional shared collection anchor. Members align to this date + k × bill_every months, preserving month-end alignment. Omit to preserve the existing anchor or infer from since, recorded coverage / paid-until, then subscription start.',
        },
        rule: {
          type: 'object',
          description: 'Owner only: the plan collection rule followed by non-custom members.',
          properties: {
            fee: { type: 'number', minimum: 0, description: 'Amount collected from each member per bill.' },
            fee_currency: { type: 'string', description: 'Defaults to the current rule currency, else the collection currency.' },
            bill_every: { type: 'integer', enum: [1, 3, 6, 12] },
          },
          additionalProperties: false,
        },
        rule_from: { ...DATE, description: 'Effective date for the rule change; defaults to today. Whole periods starting on/after it use the new fee.' },
        dry_run: DRY,
      },
      ['subscription', 'role'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      if (a.role === 'none') return commit(ctx, st, today, { ...s, share: undefined }, a.dry_run, ['share_removed']);
      const role = a.role === 'member' ? 'member' : 'owner';
      const cur = s.share;
      const share = {
        role,
        seats: Math.max(1, Math.round(Number(a.seats ?? cur?.seats ?? 2))),
        members: cur?.members ?? [],
        ownerName: role === 'member' ? ('owner_name' in a ? str(a.owner_name) : cur?.ownerName) : undefined,
        since: 'since' in a ? (a.since == null ? undefined : date(a.since, 'since')) : cur ? cur.since : today,
        collectFrom: 'collect_from' in a ? (a.collect_from == null ? undefined : date(a.collect_from, 'collect_from')) : cur?.collectFrom,
        rule: role === 'owner' ? cur?.rule : undefined,
      } as NonNullable<Subscription['share']>;
      let after: Subscription = { ...s, share };
      if (a.rule != null) {
        if (role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
        const r = a.rule as Record<string, unknown>;
        const prev = carRule(st, after, today);
        const currency = (str(r.fee_currency) ?? prev.currency).toUpperCase();
        validateCurrency(st, currency);
        const billEvery = r.bill_every != null ? Number(r.bill_every) : prev.billEvery;
        if (![1, 3, 6, 12].includes(billEvery)) throw new Error(t('mcp.error.invalidInput', { field: 'rule.bill_every' }));
        const rule = { fee: r.fee != null ? num(r.fee, 'rule.fee') : prev.fee, currency, billEvery };
        after = applyCarRule(st, after, rule, date(a.rule_from, 'rule_from', today), today);
      }
      return {
        ...(await commit(ctx, st, today, after, a.dry_run, [cur ? 'share_updated' : 'share_created', ...(a.rule != null ? ['rule_updated'] : [])])),
        collect_from: collectionAnchor(after),
        ...(after.share?.role === 'owner' ? { rule: ruleOut(st, after, today) } : {}),
      };
    },
  },
  {
    name: 'save_share_member',
    description:
      'Add a member to a shared plan I organize, or update one (pass member = id or name to update). fee = how much they pay each time, in fee_currency (defaults to the collection currency), every bill_every months (1 monthly, 3 quarterly, 6 half-yearly, 12 yearly). exempt = takes a seat but pays nothing. paid_until = already paid through this date. Only the joining period aligns to the shared anchor; later collections advance from individual paid-through. Fee changes use fee_from (default today), preserve the old rate and receipts, and apply to whole periods starting on/after that date. A mid-period join covers joined through the aligned period end inclusive: first_period prorate (default, actual days / full period days, rounded to cents), full, or free. first_amount optionally overrides the first amount in fee_currency; free always charges zero. Later periods use the regular fee. Use save_person for name/contact changes of a linked roster person; person=null detaches the link. New members default to the plan collection rule (see get_carpool rule) when fee and bill_every are omitted. follow_rule=true makes the member follow the plan rule from fee_from (default today); follow_rule=false keeps their own fee. Changing fee, fee_currency or bill_every without follow_rule marks the member custom unless the result at fee_from equals the rule. Each call inserts/replaces one dated fee point; later fee_history points remain. For an ongoing custom rate, also replace conflicting later points with the same fee and cycle. Do not postpone fee_from to avoid them; omit it to start today. Set left to retain all join/receipt history. Optional leave_refund stores the actual positive refund, with date defaulting to left and currency to the suggested refund currency; null means no refund. left=null also clears the refund. Preview returns suggested_refund (including original-currency parts) and unused_days; never save the suggestion as an actual refund without user confirmation. Preview and save return member.first_collection (inclusive coverage and amount), follows_rule, collect_from, paid_until, next_collection_date and overdue_days.',
    write: true,
    inputSchema: obj(
      {
        subscription: SUBREF,
        person: { type: ['string', 'null'], description: 'Link an existing roster person by id/name; copies their name/contact.' },
        member: { type: 'string', description: 'Existing member id or name to update; omit to add a new member.' },
        id: { type: 'string', description: 'Internal: id for a new member (used when confirming an earlier draft).' },
        name: { type: 'string' },
        fee: { type: 'number', minimum: 0 },
        fee_currency: { type: 'string' },
        fee_from: {
          ...DATE,
          description:
            'Effective date for a fee/currency/billing-cycle change; omit when the user gave no date (today), including follow_rule switches. Do not align it to a future plan-rule date. Period start selects the whole-period rate; no split at price changes.',
        },
        bill_every: { type: 'integer', enum: [1, 3, 6, 12] },
        follow_rule: { type: 'boolean', description: 'true = follow the plan collection rule (ignores fee/fee_currency/bill_every); false = custom fee.' },
        first_period: {
          type: 'string',
          enum: ['prorate', 'full', 'free'],
          description:
            'Partial first period only: prorate (default, actual inclusive days / full aligned period days, rounded to cents), full (regular fee), or free (zero; skipped for the next collection). Later periods charge the regular fee.',
        },
        first_amount: { type: ['number', 'null'], minimum: 0, description: 'Custom first-period fee; null resets to calculated amount.' },
        exempt: { type: 'boolean' },
        paid_until: { ...DATE, type: ['string', 'null'] },
        joined: {
          ...DATE,
          type: ['string', 'null'],
          description: 'Join date, inclusive; defaults to today for a new member. A mid-period join covers this day through the shared aligned period end.',
        },
        left: { ...DATE, type: ['string', 'null'], description: 'Left the plan on this date (keeps history). null also clears leave_refund.' },
        leave_refund: {
          type: ['object', 'null'],
          description: 'Actual refund on leaving, positive amount. Requires left; null clears it. Omit to preserve. Date cannot precede joining.',
          properties: {
            amount: { type: 'number', exclusiveMinimum: 0 },
            date: DATE,
            currency: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['amount'],
          additionalProperties: false,
        },
        source: { type: 'string' },
        contact_via: { type: 'string', description: 'e.g. 微信, Telegram, 邮箱' },
        contact: { type: 'string' },
        account: { type: 'string', description: 'This person’s account on this shared plan (arbitrary text: email, phone number, username or ID).' },
        note: { type: 'string' },
        dry_run: DRY,
      },
      ['subscription'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      if (!s.share || s.share.role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
      const q = str(a.member)?.toLowerCase();
      const old = q ? s.share.members.find((m) => m.id === q || m.name.toLowerCase() === q) : undefined;
      if (q && !old) throw new Error(t('mcp.error.noMember', { list: candidates(s.share.members) }));
      const live = s.share.members.filter((m) => memberAboard(m, today));
      if (!old && live.length + 1 >= s.share.seats) throw new Error(t('mcp.error.shareFull', { name: s.name, seats: s.share.seats }));
      const feeArgs = a.follow_rule === true ? {} : a;
      const ccy = (str(feeArgs.fee_currency) ?? old?.feeCurrency ?? st.settings.collectCurrency ?? st.settings.baseCurrency).toUpperCase();
      validateCurrency(st, ccy);
      // 新成员没给收费标准时按车的收款规则
      const rule = carRule(st, s, today);
      const ruleDefault = !old && a.fee == null && a.bill_every == null && a.fee_currency == null;
      const billEvery =
        feeArgs.bill_every != null
          ? Number(feeArgs.bill_every)
          : old
            ? memberBillMonths(s, old, a.fee_from ? date(a.fee_from, 'fee_from') : today)
            : ruleDefault
              ? rule.billEvery
              : 1;
      if (a.first_period != null && !['prorate', 'full', 'free'].includes(String(a.first_period))) throw new Error(t('mcp.error.invalidFirstPeriod'));
      let m: ShareMember = {
        ...(old ?? { id: str(a.id) ?? uid(), name: '', share: 0 }),
        name: str(a.name) ?? old?.name ?? '',
        ...(feeArgs.fee != null ? { fee: num(feeArgs.fee, 'fee'), feeCurrency: ccy } : ruleDefault ? { fee: rule.fee, feeCurrency: rule.currency } : {}),
        billEvery,
        ...(a.first_period != null
          ? {
              firstPeriod: a.first_period as ShareMember['firstPeriod'],
              ...(a.first_period !== (old?.firstPeriod ?? 'prorate') ? { firstAmount: undefined } : {}),
            }
          : {}),
        ...('first_amount' in a ? { firstAmount: a.first_amount == null ? undefined : num(a.first_amount, 'first_amount') } : {}),
        ...(a.exempt != null ? { exempt: !!a.exempt } : {}),
        ...(a.paid_until ? { paidUntil: date(a.paid_until, 'paid_until') } : {}),
        ...(a.joined ? { joined: date(a.joined, 'joined') } : !old ? { joined: today } : {}),
        ...(a.left ? { left: date(a.left, 'left') } : {}),
        ...(a.contact_via ? { contactVia: String(a.contact_via) } : {}),
        ...(a.contact ? { contact: String(a.contact) } : {}),
        ...(a.account ? { account: String(a.account) } : {}),
        ...(a.note ? { note: String(a.note) } : {}),
      };
      if ('fee_currency' in feeArgs) m.feeCurrency = ccy;
      if (a.person === null) m.personId = undefined;
      if (a.person) {
        const p = findPerson(st, a.person);
        Object.assign(m, { personId: p.id, name: p.name, contactVia: p.contactVia, contact: p.contact });
      }
      for (const [input, field] of [
        ['paid_until', 'paidUntil'],
        ['left', 'left'],
        ['joined', 'joined'],
      ] as const)
        if (a[input] === null) m[field] = undefined;
      for (const [input, field] of [
        ['contact_via', 'contactVia'],
        ['contact', 'contact'],
        ['account', 'account'],
        ['note', 'note'],
        ['source', 'source'],
      ] as const)
        if (input in a) m[field] = field === 'account' ? str(a[input])?.trim() || undefined : str(a[input]);
      if ('leave_refund' in a && a.leave_refund !== null) {
        if (!m.left) throw new Error(t('core.subError.refundDate'));
        const r = a.leave_refund as Record<string, unknown>;
        const suggestion = suggestedLeaveRefund(st, s, m);
        const currency = (str(r.currency) ?? suggestion.currency).toUpperCase();
        validateCurrency(st, currency);
        m.leaveRefund = {
          amount: num(r.amount, 'leave_refund.amount'),
          date: date(r.date, 'leave_refund.date', m.left),
          currency,
          ...(r.note ? { note: String(r.note) } : {}),
        };
      } else if (a.leave_refund === null) m.leaveRefund = undefined;
      m = updateMemberLeave(m, {});
      if (!m.name) throw new Error(t('mcp.error.needMemberName'));
      const feeEdited = ['fee', 'fee_currency', 'bill_every'].some((key) => key in a);
      if (old && feeEdited && a.follow_rule !== true) {
        const from = date(a.fee_from, 'fee_from', today);
        const prev = memberFee(st, s, old, from);
        m = changeMemberFee(
          st,
          s,
          { ...m, fee: old.fee, feeCurrency: old.feeCurrency, billEvery: old.billEvery },
          {
            from,
            fee: a.fee == null ? prev.amount : num(a.fee, 'fee'),
            currency: a.fee_currency == null ? prev.currency : ccy,
            billEvery,
          },
          today,
        );
      }
      if (a.follow_rule === true)
        m = old
          ? followCarRule(st, s, m, date(a.fee_from, 'fee_from', today), today)
          : { ...m, custom: undefined, fee: rule.fee, feeCurrency: rule.currency, billEvery: rule.billEvery };
      else if (a.follow_rule === false) m = { ...m, custom: true };
      else if (feeEdited) {
        const from = date(a.fee_from, 'fee_from', today);
        const r = memberFee(st, s, m, from);
        m = { ...m, custom: sameRule({ fee: r.amount, currency: r.currency, billEvery: memberBillMonths(s, m, from) }, rule) ? undefined : true };
      }
      // 每期份额（订阅币种）由收费标准换算；不分摊的为 0
      m.share = m.exempt ? 0 : m.fee != null ? shareFromFee(st, s, m.fee, m.feeCurrency ?? ccy, memberBillMonths(s, m, today)) : m.share;
      const members = old ? s.share.members.map((x) => (x.id === old.id ? m : x)) : [...s.share.members, m];
      const after = { ...s, share: { ...s.share, collectFrom: collectionAnchor(s), members } };
      const suggestion = suggestedLeaveRefund(st, after, m);
      return {
        ...(await commit(ctx, st, today, after, a.dry_run, [old ? `member_updated:${m.name}` : `member_added:${m.name}`])),
        suggested_refund: suggestion,
        unused_days: suggestion.unusedDays,
        member: {
          id: m.id,
          name: m.name,
          custom: !!m.custom,
          fee_history: m.feeHistory ?? [],
          ...collectionSummary(
            st,
            after,
            m,
            memberDues(after, today, st.settings.collectCurrency ?? st.settings.baseCurrency, st).find((d) => d.member.id === m.id),
            today,
          ),
        },
      };
    },
  },
  {
    name: 'remove_share_member',
    description: 'Remove a member from a shared plan entirely (their payment history goes too). To keep history, use save_share_member with left instead.',
    write: true,
    destructive: true,
    inputSchema: obj({ subscription: SUBREF, member: { type: 'string' }, dry_run: DRY }, ['subscription', 'member']),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription);
      if (!s.share) throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
      const q = String(a.member).trim().toLowerCase();
      const m = s.share.members.find((x) => x.id === q || x.name.toLowerCase() === q);
      if (!m) throw new Error(t('mcp.error.noMember', { list: candidates(s.share.members) }));
      return commit(
        ctx,
        st,
        today,
        { ...s, share: { ...s.share, collectFrom: collectionAnchor(s), members: s.share.members.filter((x) => x.id !== m.id) } },
        a.dry_run,
        [`member_removed:${m.name}`],
      );
    },
  },
  {
    name: 'record_receivable',
    destructive: true,
    description:
      'Record, update or delete actual receivables. Use action=update|delete with kind=share, member and index to revise/remove a receipt (receipt patch); with kind=proxy and exact charge to revise/remove a proxy entry (entry patch includes charged/received fields; action=record with entry can create a charged-only record; null clears). Read full records/indices with get_subscription. Removing proxy entries restores inferred unpaid charges. Record money received from others: a shared-plan member paid their share (kind=share; omitted coverage and amount default to their next unpaid collection, including a prorated first period; free partial first periods are skipped. Explicit amount is the actual receipt even if different from the suggested fee, and covers the selected period without leaving a balance. Returns receipt plus member paid_until and next_collection_date after recording), or a proxy charge was repaid (kind=proxy; charge = the charge date being repaid). Pass person (name or id) instead of subscription/member/kind to record it for that person: their only open item is picked (pass subscription when they owe on several).',
    write: true,
    inputSchema: obj(
      {
        action: {
          type: 'string',
          enum: ['record', 'update', 'delete'],
          description: 'Default record. Update/delete require exact kind and existing share member/index or proxy charge; no implicit target selection.',
        },
        index: { type: 'integer', minimum: 0, description: 'Share receipt zero-based index in get_subscription.record.share.members[].payments.' },
        receipt: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date' },
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string' },
            from: { type: ['string', 'null'], format: 'date' },
            until: { type: 'string', format: 'date' },
            note: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
        entry: {
          type: 'object',
          properties: {
            charge: { type: 'string', format: 'date' },
            charged: { type: ['number', 'null'], minimum: 0 },
            chargedCurrency: { type: ['string', 'null'] },
            received: { type: ['number', 'null'], minimum: 0 },
            receivedCurrency: { type: ['string', 'null'] },
            receivedOn: { type: ['string', 'null'], format: 'date' },
            note: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
        paid_until: {
          type: ['string', 'null'],
          format: 'date',
          description: 'Update/delete share receipt: explicit known coverage, otherwise recompute from remaining receipts (none clears).',
        },
        subscription: {
          ...SUBREF,
          description: 'Subscription id or name. Optional when person is given and only one of their plans / proxy payments matches.',
        },
        person: { type: 'string', description: 'Person id or name (see list_people). Picks the matching member or proxy payment automatically.' },
        kind: { type: 'string', enum: ['share', 'proxy'], description: 'Inferred when person is given.' },
        member: { type: 'string', description: 'share: member id or name.' },
        charge: { ...DATE, description: 'proxy: which charge date is being repaid (defaults to the oldest unpaid).' },
        amount: {
          type: 'number',
          minimum: 0,
          description:
            'Actual amount received; share only: omit to use the next unpaid collection amount. An explicit zero or different amount is recorded as-is. Required for proxy.',
        },
        currency: {
          type: 'string',
          description:
            'With an explicit amount, defaults to the collection currency setting (legacy behavior). With a default share amount, defaults to that fee currency; an explicit currency converts the suggested amount using receipt-date FX.',
        },
        date: { ...DATE, description: 'When the money arrived; defaults to today.' },
        from: { ...DATE, description: 'share: coverage start, inclusive; defaults to the next unpaid collection start, independently of receipt date.' },
        until: {
          ...DATE,
          description:
            'share: coverage end, inclusive; defaults to one member billing period from coverage start (only the joining period aligns to the shared anchor). Overrides automatic advance; paid_until never moves backward.',
        },
        note: { type: 'string' },
        dry_run: DRY,
      },
      [],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      if (a.action === 'update' || a.action === 'delete' || (a.kind === 'proxy' && a.entry)) {
        if (!['share', 'proxy'].includes(String(a.kind))) throw new Error(t('mcp.error.needKind'));
        const s = findSub(st, a.subscription);
        const result = reviseReceivable(st, s, { ...a, action: a.action ?? 'record' });
        return {
          ...(await commit(ctx, st, today, result.after, a.dry_run, [`receivable_${a.action}`])),
          before: result.before,
          after: result.record,
          references: { subscription: s.id, kind: a.kind, member: a.member ?? null, charge: a.charge ?? null, index: a.index ?? null },
        };
      }
      if (a.person != null && String(a.person).trim()) a = { ...a, ...personTarget(st, a, today) };
      if (!a.subscription) throw new Error(t('mcp.error.needSubOrPerson'));
      // 没写 kind：给了成员就是合租收款，给了扣款日就是代付还款
      if (a.kind !== 'share' && a.kind !== 'proxy') a = { ...a, kind: a.member ? 'share' : a.charge ? 'proxy' : a.kind };
      if (a.kind !== 'share' && a.kind !== 'proxy') throw new Error(t('mcp.error.needKind'));
      const s = findSub(st, a.subscription);
      const on = date(a.date, 'date', today);
      const ccy = (str(a.currency) ?? st.settings.collectCurrency ?? st.settings.baseCurrency).toUpperCase();
      validateCurrency(st, ccy);
      if (a.kind === 'share') {
        if (!s.share || s.share.role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
        const q = String(a.member ?? '')
          .trim()
          .toLowerCase();
        const ms = s.share.members.filter((m) => m.id === q || m.name.toLowerCase() === q || (q && m.name.toLowerCase().includes(q)));
        if (ms.length !== 1)
          throw new Error(
            ms.length
              ? t('mcp.error.memberAmbiguous', { q: String(a.member), list: candidates(ms) })
              : t('mcp.error.noMember', { list: candidates(s.share.members) }),
          );
        const m = ms[0];
        const from = a.from ? date(a.from, 'from') : memberUnpaidFrom(s, m);
        const collection = memberCollection(s, m, from, st.settings.collectCurrency ?? st.settings.baseCurrency);
        const until = a.until ? date(a.until, 'until') : collection.until;
        const currency = a.amount == null ? (str(a.currency)?.toUpperCase() ?? collection.currency) : ccy;
        validateCurrency(st, currency);
        const amount =
          a.amount == null
            ? round(num(convertOn(collection.amount, collection.currency, currency, on, st.fxHistory, st.fx), 'amount'))
            : num(a.amount, 'amount');
        const receipt = { date: on, amount, currency, from, until, note: str(a.note) };
        const members = s.share.members.map((x) =>
          x.id === m.id
            ? {
                ...x,
                paidUntil: !x.paidUntil || until > x.paidUntil ? until : x.paidUntil,
                payments: [...(x.payments ?? []), receipt],
              }
            : x,
        );
        const after = { ...s, share: { ...s.share, collectFrom: collectionAnchor(s), members } };
        const updated = members.find((x) => x.id === m.id)!;
        return {
          ...(await commit(ctx, st, today, after, a.dry_run, [`share_payment:${m.name}`])),
          receipt,
          member: {
            id: m.id,
            name: m.name,
            ...collectionSummary(
              st,
              after,
              updated,
              memberDues(after, today, st.settings.collectCurrency ?? st.settings.baseCurrency, st).find((d) => d.member.id === m.id),
              today,
            ),
          },
        };
      }
      const amount = num(a.amount, 'amount');
      if (!s.proxy) throw new Error(t('mcp.error.notProxy', { name: s.name }));
      const cs = chargesBetween(s, s.start, today, today);
      const matched = matchEntries(
        s.proxy.entries,
        cs.map((c) => c.date),
      );
      const charge = a.charge ? date(a.charge, 'charge') : cs.find((c) => matched.get(c.date)?.received == null)?.date;
      if (!charge) throw new Error(t('mcp.error.noPendingProxy'));
      const old = matched.get(charge);
      const entry = { ...(old ?? { charge }), charge, received: amount, receivedCurrency: ccy, receivedOn: on, note: str(a.note) ?? old?.note };
      const entries = [...s.proxy.entries.filter((e) => e !== old), entry].sort((x, y) => x.charge.localeCompare(y.charge));
      return commit(ctx, st, today, { ...s, proxy: { ...s.proxy, entries } }, a.dry_run, [`proxy_received:${charge}`]);
    },
  },
  paymentMethodTool,
];

/** record_receivable 按人记账：在这个人的合租、代付里找出要记的那一笔（优先现在欠钱的） */
function personTarget(st: AppState, a: Record<string, unknown>, today: string): { subscription: string; kind: 'share' | 'proxy'; member?: string } {
  const p = findPerson(st, a.person);
  const sub = a.subscription ? findSub(st, a.subscription) : undefined;
  const items = (peopleLedger(st, today).find((l) => l.person.id === p.id)?.items ?? []).filter(
    (i) => (!sub || i.sub.id === sub.id) && (!a.kind || i.kind === a.kind),
  );
  const open = items.filter((i) => i.periodsOwed > 0);
  const live = items.filter((i) => i.active);
  const pick = open.length ? open : live.length === 1 ? live : items;
  if (!pick.length) throw new Error(t('mcp.error.personNoItems', { name: p.name }));
  if (pick.length > 1)
    throw new Error(t('mcp.error.personItemsAmbiguous', { name: p.name, list: candidates(pick.map((i) => ({ name: i.sub.name, id: i.sub.id }))) }));
  const i = pick[0];
  return { subscription: i.sub.id, kind: i.kind, member: i.member?.id };
}

function roundAll<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]),
  ) as T;
}

// Enforce the advertised schema on both transports, including nested field allowlists.
export const TOOLS: Tool[] = CATALOGUE.map((tool) => ({
  ...tool,
  run: async (args, ctx) => {
    validateToolInput(tool.inputSchema as Schema, args);
    return tool.run(args, ctx);
  },
}));

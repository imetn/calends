import { personSummary } from '../../shared/avatar.ts';
import { addDays, addMonths, chargesBetween, todayIn, type Charge, validDay } from '../../shared/billing.ts';
import { normName, peopleLedger } from '../../shared/people.ts';
import type { AppState, Payment, PaymentMethod, Person, ShareMember, Subscription } from '../../shared/types.ts';
import type { Env } from '../env.ts';
import { loadState, saveLedgerEdit } from '../store.ts';
import { resyncShares } from '../../shared/carpool.ts';
import { t } from '../../shared/i18n.ts';
import { objectSchema as obj } from '../../shared/tool-schema.ts';
import { prepareSubWrite } from '../../shared/sub-write.ts';
import { categoryEdit } from '../../shared/ledger-edit.ts';
import { categoryList, presetCategory, PRESETS, type Category } from '../../shared/categories.ts';
import { CATEGORY_ALIASES } from '../../shared/locales/categories.gen.ts';
import { round, row } from './tool-views.ts';

export interface ToolCtx {
  env: Env;
  access?: { client: 'mcp' | 'assistant'; scope: 'read' | 'write' };
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

export async function state(ctx: ToolCtx): Promise<{ st: AppState; today: string }> {
  const st = { ...(await loadState(ctx.env, false)), ...ctx.draftState };
  if (ctx.overlay?.size) {
    const subs = st.subscriptions.filter((s) => !ctx.overlay!.has(s.id)).concat([...ctx.overlay.values()].filter((s): s is Subscription => !!s));
    st.subscriptions = subs;
  }
  return { st, today: todayIn(st.settings.timezone) };
}

export const candidates = (xs: Array<{ name: string; id: string }>) => xs.map((x) => t('mcp.item', { name: x.name, id: x.id })).join(t('mcp.sep'));

export const subCandidates = (st: AppState, xs: Subscription[]) =>
  candidates(xs.map((s) => ({ id: s.id, name: [s.name, s.account, s.region, st.methods.find((m) => m.id === s.methodId)?.name].filter(Boolean).join(' · ') })));

export function findSub(st: AppState, ref: unknown, opts: { exact?: boolean } = {}): Subscription {
  const q = String(ref ?? '').trim();
  if (!q) throw new Error(t('mcp.error.needSub'));
  const byId = st.subscriptions.find((s) => s.id === q);
  if (byId) return byId;
  const k = q.toLowerCase();
  const exact = st.subscriptions.filter((s) => s.name.toLowerCase() === k);
  if (exact.length === 1) return exact[0];
  const fuzzy = exact.length ? exact : st.subscriptions.filter((s) => s.name.toLowerCase().includes(k));
  if (opts.exact && !exact.length) {
    if (fuzzy.length) throw new Error(t('mcp.error.subNotExact', { q, list: subCandidates(st, fuzzy) }));
    throw new Error(t('mcp.error.subNotFound', { q }));
  }
  if (fuzzy.length === 1) return fuzzy[0];
  if (!fuzzy.length) throw new Error(t('mcp.error.subNotFound', { q }));
  throw new Error(t('mcp.error.subAmbiguous', { q, count: fuzzy.length, list: subCandidates(st, fuzzy) }));
}

export function findMember(s: Subscription, ref: unknown, opts: { fuzzy?: boolean } = {}): ShareMember {
  const members = s.share?.members ?? [];
  const raw = String(ref ?? '').trim();
  const byId = members.find((m) => m.id === raw);
  if (byId) return byId;
  const q = raw.toLowerCase();
  const exact = q ? members.filter((m) => m.name.toLowerCase() === q) : [];
  const hits = exact.length || !opts.fuzzy ? exact : q ? members.filter((m) => m.name.toLowerCase().includes(q)) : [];
  if (hits.length === 1) return hits[0];
  if (hits.length) throw new Error(t('mcp.error.memberAmbiguous', { q: raw, list: candidates(hits) }));
  throw new Error(t('mcp.error.noMember', { list: candidates(members) }));
}

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

export function rangeOf(period: unknown, today: string, from?: unknown, to?: unknown): [string, string] {
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

export const PERIODS = ['today', 'next_3_days', 'next_7_days', 'next_30_days', 'this_month', 'next_month', 'last_30_days', 'this_year', 'custom'];

export function chargesIn(st: AppState, from: string, to: string, today: string, scope: string) {
  return st.subscriptions
    .filter((s) => (scope === 'proxy' ? !!s.proxy : scope === 'all' || scope === 'gross' ? true : !s.proxy))
    .flatMap((s) => chargesBetween(s, from, to, today))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function groupOf(by: string, c: Charge, sub: Subscription, m: PaymentMethod | undefined): [string, string] {
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

export const missingRates = (st: AppState, ccys: string[]) => [...new Set(ccys.filter((c) => c !== 'USD' && !(st.fx.rates[c] > 0)))].sort();

export const outCcy = (st: AppState, a: Record<string, unknown>) => {
  const c = a.currency_out ? String(a.currency_out).toUpperCase() : undefined;
  if (c && !st.fx.rates[c]) throw new Error(t('mcp.error.unsupportedCurrency', { code: c }));
  return c;
};

export const DATE = { format: 'date', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };

export const SUBREF = { type: 'string', description: 'Subscription id, or its name (fuzzy match; ambiguous names return candidates).' };

export const SUBREF_EXACT = {
  type: 'string',
  description: 'Subscription id, or its exact full name (case-insensitive). Partial names are rejected with candidates for this destructive action.',
};

export const CURRENCY_OUT = { type: 'string', description: 'Convert amounts into this currency (ISO code). Defaults to the ledger base currency.' };

export const PERIOD = { type: 'string', enum: PERIODS, description: 'Time window. custom requires from/to.' };

export const CYCLE = {
  type: 'object',
  properties: { unit: { type: 'string', enum: ['day', 'week', 'month', 'year', 'lifetime'] }, every: { type: 'integer', minimum: 1, default: 1 } },
  required: ['unit'],
  description: 'Billing cycle, e.g. {"unit":"month","every":1}; lifetime = one-time purchase.',
};

export const ICON_DESCRIPTION =
  'Icon: an http(s) image URL (e.g. artwork from search_app_store), a site path such as /ai/claude.svg, or one emoji / short symbol (up to 4 characters). Invalid values are rejected.';

export const SHIFT_BILLING = {
  type: 'boolean',
  default: false,
  description:
    'Only with a start change. Default false keeps the original billing anchor, like the web editor: later charge dates stay the same and cycles added before it follow the original day. true moves the anchor with the start, shifting every estimated future charge.',
};

export const CATEGORY = { type: 'string', description: 'Existing category code or name from list_categories; localized names are case-insensitive.' };

export const CATEGORY_CREATE = {
  create_category: { type: 'boolean', default: false, description: 'If category is unknown, explicitly create it. Ambiguous references always fail.' },
  category_icon: { type: ['string', 'null'], description: 'New category only: Lucide icon name or emoji; same validation as save_category set.icon.' },
  category_color: { type: ['string', 'null'], description: 'New category only: palette code or #rrggbb; same validation as save_category set.color.' },
};

export const FUNDING = {
  type: ['array', 'null'],
  description:
    'Split one order across several sources, e.g. [{"method":"PayPal","amount":168.05},{"method":"Balance","amount":10.75}] for 178.80. Amounts in the subscription currency, positive, at least two different methods, summing to amount. Replaces method for this charge.',
  items: obj({ method: { type: 'string', description: 'Payment method id or name.' }, amount: { type: 'number', minimum: 0 } }, ['method', 'amount']),
};

export const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e]!);

export type CategoryCreation = { category: Category; categories: Category[] };

export async function commit(
  ctx: ToolCtx,
  st: AppState,
  today: string,
  after: Subscription,
  dry: unknown,
  changed: string[],
  categoryCreation?: CategoryCreation,
  personCreation?: Person,
) {
  // 续费规则历史、清退出日连带清退款、完整校验、引用校验与状态迁移都交给与网页整条保存同一个 prepareSubWrite
  after = resyncShares(
    st,
    st.subscriptions.find((s) => s.id === after.id),
    after,
  );
  for (const member of after.share?.members ?? []) if (!Number.isFinite(member.share)) throw new Error(t('mcp.error.notNumber', { what: 'member.share' }));
  // 与网页整条保存同一套引用校验：新写入的支付方式要存在、币种要可用；记录里原有的值放行
  const prepared = prepareSubWrite(
    st.subscriptions.find((x) => x.id === after.id),
    after,
    today,
    st,
  );
  if (prepared.error !== undefined) throw new Error(prepared.error);
  return persist(ctx, st, today, prepared.sub, dry, changed, categoryCreation, undefined, personCreation);
}

export async function persist(
  ctx: ToolCtx,
  st: AppState,
  today: string,
  after: Subscription,
  dry: unknown,
  changed: string[],
  categoryCreation?: CategoryCreation,
  extra: Record<string, unknown> = {},
  personCreation?: Person,
) {
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
    ...(personCreation
      ? {
          created_person: personSummary(personCreation),
          person_notice: t(dry ? 'mcp.label.createPerson' : 'mcp.label.createdPerson', { name: personCreation.name }),
        }
      : {}),
    next_charges: chargesBetween(after, today, addMonths(today, 13), today)
      .filter((c) => !c.paidOn)
      .slice(0, 3)
      .map((c) => ({ date: c.date, amount: round(c.amount), currency: c.currency })),
    ...extra,
  };
  // 新建的分类、人与订阅同一个事务写入
  return writeLedger(
    ctx,
    st,
    {
      subscriptions: [after],
      ...(categoryCreation ? { settings: { ...st.settings, categories: categoryCreation.categories } } : {}),
      ...(personCreation ? { people: [...(st.people ?? []), personCreation] } : {}),
    },
    preview,
    dry,
  );
}

export interface LedgerWrite extends Pick<Partial<AppState>, 'subscriptions' | 'methods' | 'settings' | 'people' | 'prefs'> {
  deletedMethods?: string[];
  deletedSubscriptions?: string[];
}

export async function writeLedger(ctx: ToolCtx, st: AppState, w: LedgerWrite, preview: object, dry: unknown) {
  const { subscriptions, methods, deletedMethods = [], deletedSubscriptions = [], ...rest } = w;
  if (dry) {
    ctx.draftState = {
      ...ctx.draftState,
      ...rest,
      ...(methods || deletedMethods.length
        ? { methods: [...st.methods.filter((m) => !deletedMethods.includes(m.id) && !methods?.some((n) => n.id === m.id)), ...(methods ?? [])] }
        : {}),
    };
    for (const s of subscriptions ?? []) ctx.overlay?.set(s.id, s);
    for (const id of deletedSubscriptions) ctx.overlay?.set(id, null);
    return { dry_run: true, ...preview };
  }
  // 存储层会给订阅记 updatedAt：写副本，预览里的对象保持原样
  await saveLedgerEdit(ctx.env, { ...rest, subscriptions: subscriptions?.map((s) => ({ ...s })), methods }, deletedMethods, deletedSubscriptions);
  return { ok: true, ...preview };
}

export const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));

export const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(t('mcp.error.notNumber', { what }));
  return n;
};

export const date = (v: unknown, what: string, fallback?: string) => {
  const d = v == null ? fallback : String(v);
  if (!d || !validDay(d)) throw new Error(t('mcp.error.notDate', { what }));
  return d;
};

export const allPayments = (s: Subscription): Payment[] => [...(s.payments ?? []), ...(s.phases ?? []).flatMap((p) => p.payments ?? [])];

export function refundInput(raw: unknown, fallback?: string) {
  const r = raw as { amount: unknown; date?: unknown; currency?: unknown; settled?: { amount: unknown; currency: unknown } };
  return {
    amount: num(r.amount, 'refund.amount'),
    date: r.date == null ? fallback : date(r.date, 'refund.date'),
    currency: str(r.currency)?.toUpperCase(),
    settled: r.settled ? { amount: num(r.settled.amount, 'refund.settled.amount'), currency: String(r.settled.currency).toUpperCase() } : undefined,
  };
}

export function assertNotDuplicate(st: AppState, name: string, start: string, account: string | undefined) {
  const dup = st.subscriptions.some(
    (s) =>
      s.name.toLowerCase() === name.toLowerCase() &&
      s.start === start &&
      !(account && s.account?.trim() && account.toLowerCase() !== s.account.trim().toLowerCase()),
  );
  if (dup) throw new Error(t('mcp.error.duplicateSub', { name }));
}

export const defaultCategory = (st: AppState) => categoryRef(st, presetCategory(categoryList(st.settings, st.subscriptions), 'tools'))!;

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

export const fundingOf = (st: AppState, v: unknown, sign: number): Payment['funding'] => {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error(t('core.subError.funding'));
  return v.map((f: { method?: unknown; amount?: unknown }) => {
    const methodId = methodRef(st, f?.method);
    if (!methodId) throw new Error(t('core.subError.funding'));
    return { methodId, amount: sign * Math.abs(num(f.amount, 'funding.amount')) };
  });
};

export function categoryMatches(list: Category[], q: string): Category[] {
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

export function subscriptionCategory(st: AppState, v: unknown, args: Record<string, unknown>): { name: string; creation?: CategoryCreation } {
  const q = String(v).trim();
  const list = categoryList(st.settings, st.subscriptions);
  if (args.create_category === true && !categoryMatches(list, q).length) {
    const { categories } = categoryEdit(st, 'create', undefined, { name: q, icon: str(args.category_icon), color: str(args.category_color) });
    const category = categories.find((c) => c.name === q)!;
    return { name: category.name, creation: { category, categories } };
  }
  return { name: categoryRef(st, q)! };
}

export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (x === null || x === undefined ? [] : [[k, dropNulls(x)]])));
  return v;
}

export function personTarget(st: AppState, a: Record<string, unknown>, today: string): { subscription: string; kind: 'share' | 'proxy'; member?: string } {
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

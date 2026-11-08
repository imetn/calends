import { validatePeopleAvatars } from './avatar.ts';
import { CURRENCY_CODE, newShapeError } from './billing.ts';
// Ledger references and non-secret settings. Pure functions; no storage or platform APIs.
import { categoryList, cleanCategories, renameInSubs, type Category } from './categories.ts';
import { mergePeople, refsFor, syncPerson } from './people.ts';
import { channelsOf, DEFAULT_SETTINGS, type AppState, type Payment, type PaymentMethod, type Person, type Settings, type Subscription } from './types.ts';
import { PREF_KEYS, mergePrefs } from './prefs.ts';
import { isLocale, t } from './i18n.ts';
import { objectSchema, textSchema, daySchema, nullable } from './tool-schema.ts';
import { PUBLIC_TITLE_MAX, validPublicAvatar, validPublicPage } from './public-layout.ts';

const START_PAGE_PATHS = ['overview', 'list', 'calendar', 'report', 'wallet', 'family', 'behalf', 'assistant', 'connect'];

export const METHOD_FIELDS = objectSchema({
  name: textSchema,
  kind: {
    type: 'string',
    enum: ['debit', 'credit', 'alipay', 'wechat', 'paypal', 'appstore', 'googleplay', 'giftcard', 'prepaid', 'phone', 'crypto', 'other'],
  },
  currency: textSchema,
  balance: nullable({ type: 'number' }),
  balanceAsOf: nullable(daySchema),
  balanceExpires: nullable(daySchema),
  ...Object.fromEntries(['last4', 'color', 'region', 'notes', 'brand', 'logo', 'bank', 'phone', 'url'].map((k) => [k, nullable(textSchema)])),
  network: nullable({ type: 'string', enum: ['visa', 'mastercard', 'unionpay', 'jcb', 'american-express', 'discover', 'diners', 'maestro'] }),
  logoWide: { type: 'boolean' },
  order: { type: 'integer', minimum: 0 },
  lowRunwayDays: nullable({ type: 'number', minimum: 0 }),
  cashback: nullable({ type: 'number', minimum: 0 }),
});
export const TOP_UP_FIELDS = objectSchema({
  date: daySchema,
  amount: { type: 'number', minimum: 0 },
  cost: nullable({ type: 'number', minimum: 0 }),
  costCurrency: nullable(textSchema),
  note: nullable(textSchema),
});
export const SETTINGS_FIELDS = objectSchema({
  baseCurrency: textSchema,
  collectCurrency: nullable(textSchema),
  defaultMethodId: nullable(textSchema),
  signedAmounts: { type: 'boolean' },
  gainColor: { type: 'string', enum: ['green', 'red'] },
  remindDays: { type: 'integer', minimum: -1, maximum: 365 },
  notifyHour: { type: 'integer', minimum: 0, maximum: 23 },
  timezone: textSchema,
  publicView: { type: 'boolean' },
  publicHidden: nullable({ type: 'array', items: textSchema }),
  monthlyDigest: { type: 'boolean' },
  displayName: textSchema,
  avatar: nullable(textSchema),
  publicTitle: nullable(textSchema),
  sidebarUpcoming: { type: 'boolean' },
  upcomingDays: { type: 'integer', minimum: 0 },
  hiddenNav: nullable({ type: 'array', items: textSchema }),
  navOrder: nullable({ type: 'array', items: textSchema }),
  startPage: {
    type: ['string', 'null'],
    enum: [...START_PAGE_PATHS, '', null],
    description:
      'Startup route: use list for Subscriptions, report for Reports, family for Shared plans, behalf for Paid for others. Empty/null resets to Overview.',
  },
  weekStart: { type: 'integer', enum: [0, 1] },
  language: nullable(textSchema),
});
export const PREF_FIELDS = objectSchema(Object.fromEntries(PREF_KEYS.map((k) => [k, nullable(textSchema)])));
export const excludedAccess =
  'Never exposes or changes authentication, passwords, Passkeys, sessions, MCP tokens, backup/restore/reset/migration, whole-ledger deletion, or outbound notification credentials. Channel access is limited to existing channel enable switches; no config/address/secret fields.';

export function applyFields<T extends object>(current: T, patch: Record<string, unknown>): T {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
export const referenceSummary = (subs: Subscription[]) => subs.map((s) => ({ id: s.id, name: s.name }));
export function requireMigration(references: unknown[], into: string | undefined): void {
  if (references.length && !into) throw new Error(t('mcp.error.references', { references: JSON.stringify(references) }));
}
/** 一笔扣款引用到的支付方式：单独记的与拆分来源 */
const payMethodIds = (x: Payment) => [x.methodId, ...(x.funding ?? []).map((f) => f?.methodId)].filter((m): m is string => !!m);
const usesMethod = (x: Payment, id: string) => payMethodIds(x).includes(id);

export function methodReferences(st: AppState, id: string) {
  return [
    ...st.subscriptions.flatMap((s) => [
      ...(s.methodId === id ? [{ subscription: s.id, name: s.name, kind: 'subscription' }] : []),
      ...(s.phases ?? [])
        .filter((p) => p.methodId === id)
        .map((p) => ({ subscription: s.id, name: s.name, kind: 'phase', start: p.start, payments: p.payments?.length ?? 0 })),
      // 单笔扣款单独记的支付方式也算引用：删卡时一起迁移，不留下指向已删卡的记录
      ...[s, ...(s.phases ?? [])].flatMap((p) =>
        (p.payments ?? []).filter((x) => usesMethod(x, id)).map((x) => ({ subscription: s.id, name: s.name, kind: 'payment', date: x.date })),
      ),
    ]),
    ...(st.settings.defaultMethodId === id ? [{ kind: 'default_method' }] : []),
  ];
}
/**
 * 删除支付方式：所有层级的引用（订阅、阶段、单笔扣款、拆分来源、默认支付方式）一起处理。
 * into 为另一张卡的 id 时迁过去；into === null 表示清空引用（仅网页删卡用，MCP 只给迁移）；
 * 省略时有引用就拒绝。清空时含这张卡的拆分付款不再拆分（剩余金额无法再凑成合计），单笔记的卡回落到所在阶段的支付方式。
 */
export function deleteMethodData(st: AppState, id: string, into?: string | null) {
  const references = methodReferences(st, id);
  if (into === id || (into && !st.methods.some((m) => m.id === into))) throw new Error(t('mcp.error.invalidTarget'));
  if (into !== null) requireMigration(references, into);
  const target = into ?? undefined;
  const uses = (pays?: Payment[]) => pays?.some((x) => usesMethod(x, id));
  // 拆分付款里的来源一起迁移；迁到同一笔里已有的来源时合并成一份
  const moveFunding = (parts: NonNullable<Payment['funding']>, to: string) => {
    const merged = new Map<string, number>();
    for (const f of parts) {
      const key = f.methodId === id ? to : f.methodId;
      merged.set(key, (merged.get(key) ?? 0) + f.amount);
    }
    return [...merged].map(([methodId, amount]) => ({ methodId, amount: Math.round(amount * 100) / 100 }));
  };
  const move = (pays?: Payment[]) =>
    pays?.map((x) => {
      let next = x.methodId === id ? { ...x, methodId: target } : x;
      if (x.funding?.some((f) => f.methodId === id)) {
        if (!target) return { ...next, funding: undefined };
        const funding = moveFunding(x.funding, target);
        // 合并后只剩一个来源：不再算拆分，记成这一笔单独的支付方式
        next = funding.length > 1 ? { ...next, funding } : { ...next, funding: undefined, methodId: funding[0].methodId };
      }
      return next;
    });
  const subscriptions = st.subscriptions
    .filter((s) => s.methodId === id || uses(s.payments) || s.phases?.some((p) => p.methodId === id || uses(p.payments)))
    .map((s) => ({
      ...s,
      methodId: s.methodId === id ? target : s.methodId,
      payments: move(s.payments),
      phases: s.phases?.map((p) => ({ ...p, methodId: p.methodId === id ? target : p.methodId, payments: move(p.payments) })),
    }));
  return { references, subscriptions, settings: st.settings.defaultMethodId === id ? { ...st.settings, defaultMethodId: target } : st.settings };
}
/** 删除订阅时一并去掉它在公开页隐藏列表里的 id（网页删订阅与 MCP delete_subscription 共用） */
export function deleteSubscriptionSettings(settings: Settings, id: string): Settings {
  return settings.publicHidden?.includes(id) ? { ...settings, publicHidden: settings.publicHidden.filter((x) => x !== id) } : settings;
}
/**
 * 去掉设置里已失效的引用：公开页隐藏列表中不存在的订阅、已删除的默认支付方式。
 * 旧版网页删除不清这些引用；读取时在内存里剔除，下次保存设置时自然写回干净的值，不做批量迁移。
 */
export function pruneSettingsRefs(settings: Settings, subs: Pick<Subscription, 'id'>[], methods: Pick<PaymentMethod, 'id'>[]): Settings {
  const hidden = settings.publicHidden?.filter((id) => subs.some((s) => s.id === id));
  const staleHidden = hidden && hidden.length !== settings.publicHidden!.length;
  const staleDefault = !!settings.defaultMethodId && !methods.some((m) => m.id === settings.defaultMethodId);
  if (!staleHidden && !staleDefault) return settings;
  const next = { ...settings, ...(staleHidden ? { publicHidden: hidden } : {}) };
  if (staleDefault) delete next.defaultMethodId;
  return next;
}
export function categoryEdit(st: AppState, action: string, ref: string | undefined, patch: Partial<Category>, into?: string, order?: string[]) {
  let categories = categoryList(st.settings, st.subscriptions);
  const old = categories.find((c) => c.name === ref);
  if (action !== 'create' && action !== 'reorder' && !old) throw new Error(t('mcp.error.invalidTarget'));
  const references = referenceSummary(st.subscriptions.filter((s) => s.category === ref));
  const renames: Record<string, string> = Object.create(null);
  if (action === 'reorder') {
    if (!order || order.length !== categories.length || new Set(order).size !== categories.length || order.some((n) => !categories.some((c) => c.name === n)))
      throw new Error(t('mcp.error.invalidTarget'));
    categories = order.map((n) => categories.find((c) => c.name === n)!);
  } else if (action === 'delete') {
    if (into === ref || (into && !categories.some((c) => c.name === into))) throw new Error(t('mcp.error.invalidTarget'));
    requireMigration(references, into);
    categories = categories.filter((c) => c !== old);
    if (into && ref) renames[ref] = into;
  } else {
    const next = applyFields(old ?? {}, patch) as Category;
    if (action === 'create') categories = [...categories, next];
    else {
      categories = categories.map((c) => (c === old ? next : c));
      if (next.name !== ref) renames[ref!] = next.name;
    }
  }
  const cleaned = cleanCategories(categories);
  if ('error' in cleaned) throw new Error(cleaned.error);
  return { categories: cleaned.list, subscriptions: renameInSubs(st.subscriptions, renames), references };
}
export function personReferences(st: AppState, id: string) {
  return refsFor(st.subscriptions, id).map((r) => ({
    subscription: r.sub.id,
    name: r.sub.name,
    kind: r.kind,
    ...(r.kind === 'member' ? { member: r.member.id } : {}),
  }));
}
export function personEdit(st: AppState, person: Person, deleting: boolean, into?: string) {
  const references = personReferences(st, person.id);
  if (deleting) {
    if (into === person.id || (into && !(st.people ?? []).some((p) => p.id === into))) throw new Error(t('mcp.error.invalidTarget'));
    requireMigration(references, into);
    const result = into
      ? mergePeople(st.people ?? [], st.subscriptions, person.id, into)
      : { people: (st.people ?? []).filter((p) => p.id !== person.id), subs: [] };
    return { people: result.people, subscriptions: result.subs, references };
  }
  if (!person.name.trim()) throw new Error(t('mcp.error.invalidInput', { field: 'name' }));
  const people = [...(st.people ?? []).filter((p) => p.id !== person.id), person];
  validatePeopleAvatars(people);
  return { people, subscriptions: syncPerson(st.subscriptions, person), references };
}
export function validateCurrency(st: Pick<AppState, 'fx'>, code: string): void {
  if (!CURRENCY_CODE.test(code) || !(st.fx.rates[code] > 0)) throw new Error(t('mcp.error.unsupportedCurrency', { code }));
}
export function validateMethod(st: Pick<AppState, 'fx'>, m: PaymentMethod): void {
  if (!m.name?.trim()) throw new Error(t('mcp.error.invalidInput', { field: 'name' }));
  validateCurrency(st, m.currency);
}
export function safeSettings(st: AppState) {
  return {
    settings: Object.fromEntries(
      Object.keys(SETTINGS_FIELDS.properties!)
        .filter((k) => k in st.settings)
        .map((k) => [k, st.settings[k as keyof Settings]]),
    ),
    channels: channelsOf(st.settings).map((c) => ({ id: c.id, kind: c.kind, name: c.name, enabled: c.enabled })),
    prefs: Object.fromEntries(PREF_KEYS.filter((k) => st.prefs?.[k] !== undefined).map((k) => [k, st.prefs![k]])),
  };
}
/**
 * 设置写入的共用校验（网页 PUT /api/settings 与 MCP update_settings）：只校验相对 prev 改动过的字段，
 * 已存的旧值即使不再合法也不拦，避免一处历史脏数据让所有设置都存不了。公开页隐藏列表只校验新加的 id。
 */
export function checkSettings(st: Pick<AppState, 'fx' | 'methods' | 'subscriptions'>, prev: Settings, next: Settings): void {
  const changed = (k: keyof Settings) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
  if (changed('baseCurrency')) validateCurrency(st, next.baseCurrency);
  if (next.collectCurrency && changed('collectCurrency')) validateCurrency(st, next.collectCurrency);
  if (next.defaultMethodId && changed('defaultMethodId') && !st.methods.some((m) => m.id === next.defaultMethodId))
    throw new Error(t('mcp.error.invalidTarget'));
  if (changed('timezone'))
    try {
      new Intl.DateTimeFormat('en', { timeZone: next.timezone }).format();
    } catch {
      throw new Error(t('mcp.error.invalidInput', { field: 'timezone' }));
    }
  if (next.language && changed('language') && !isLocale(next.language)) throw new Error(t('mcp.error.invalidInput', { field: 'language' }));
  if (next.gainColor !== undefined && changed('gainColor') && next.gainColor !== 'green' && next.gainColor !== 'red')
    throw new Error(t('mcp.error.invalidInput', { field: 'gainColor' }));
  if (next.startPage && changed('startPage') && !START_PAGE_PATHS.includes(next.startPage))
    throw new Error(t('mcp.error.invalidInput', { field: 'startPage' }));
  const added = next.publicHidden?.filter((id) => !prev.publicHidden?.includes(id)) ?? [];
  if (added.some((id) => !st.subscriptions.some((s) => s.id === id))) throw new Error(t('mcp.error.invalidTarget'));
  if (next.avatar && changed('avatar') && (!/^(https?:\/\/|data:image\/(png|jpeg|webp|gif|svg\+xml);base64,)/.test(next.avatar) || next.avatar.length > 300000))
    throw new Error(t('server.invalidAvatar'));
  if (next.publicTitle != null && changed('publicTitle') && (typeof next.publicTitle !== 'string' || next.publicTitle.length > PUBLIC_TITLE_MAX))
    throw new Error(t('mcp.error.invalidInput', { field: 'publicTitle' }));
  if (next.publicPage && changed('publicPage') && !validPublicAvatar(next.publicPage.avatar)) throw new Error(t('server.invalidAvatar'));
  if (next.publicPage && changed('publicPage') && !validPublicPage(next.publicPage)) throw new Error(t('mcp.error.invalidInput', { field: 'publicPage' }));
}
export function settingsEdit(
  st: AppState,
  patch: Record<string, unknown>,
  switches: Array<{ id: string; enabled: boolean }> = [],
  prefs: Record<string, string | null> = {},
) {
  const prev = { ...DEFAULT_SETTINGS, ...st.settings };
  const patched = { ...DEFAULT_SETTINGS, ...applyFields(st.settings, patch) };
  // 先校验本次改动（新加的非法值报错），再剔除早已失效的旧引用
  checkSettings(st, prev, patched);
  const settings = pruneSettingsRefs(patched, st.subscriptions, st.methods);
  if (switches.length) {
    const channels = channelsOf(settings);
    if (new Set(switches.map((x) => x.id)).size !== switches.length || switches.some((x) => !channels.some((c) => c.id === x.id)))
      throw new Error(t('mcp.error.invalidTarget'));
    settings.channels = channels.map((c) => ({ ...c, enabled: switches.find((x) => x.id === c.id)?.enabled ?? c.enabled }));
  }
  return { settings, prefs: mergePrefs(st.prefs ?? {}, prefs) };
}

/** 一条订阅里引用到的所有支付方式：顶层、各阶段、单笔与拆分来源 */
export function methodIdsOf(s: Subscription | undefined): string[] {
  const ids = new Set<string>();
  for (const p of s ? [s, ...(s.phases ?? [])] : []) {
    if (p.methodId) ids.add(p.methodId);
    for (const pay of p.payments ?? []) for (const m of payMethodIds(pay)) ids.add(m);
  }
  return [...ids];
}
const currenciesOf = (s: Subscription | undefined) => (s ? [s.currency, ...(s.phases ?? []).map((p) => p.currency)] : []);
/**
 * 整条订阅写入的引用校验（网页 PUT /api/subscriptions、MCP save_subscription 与其余订阅写工具共用）：
 * 新写入的支付方式必须存在，新写入的币种必须有汇率。previous 里本来就有的值放行（删卡遗留、汇率表变化），
 * 这样未改动的历史记录仍能保存，只拒绝本次新引入的非法值。字段格式（各阶段的日期、价格、币种、周期等）同样按此放行旧值，见 newShapeError。
 */
export function subRefsError(st: Pick<AppState, 'fx' | 'methods'>, previous: Subscription | undefined, next: Subscription): string | undefined {
  const shape = newShapeError(previous, next);
  if (shape) return shape;
  const knownMethods = new Set(methodIdsOf(previous));
  for (const id of methodIdsOf(next))
    if (!knownMethods.has(id) && !st.methods.some((m) => m.id === id))
      return t('mcp.error.noMethod', { q: id, list: st.methods.map((m) => t('mcp.item', { name: m.name, id: m.id })).join(t('mcp.sep')) });
  const knownCurrencies = new Set(currenciesOf(previous));
  for (const code of currenciesOf(next))
    if (!knownCurrencies.has(code))
      try {
        validateCurrency(st, code);
      } catch (e) {
        return (e as Error).message;
      }
  return undefined;
}

// Replace/delete one indexed record, with optional optimistic snapshot protection.
export function editRecord<T>(records: T[], index: number, replacement: T | undefined, expected?: T): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= records.length) throw new Error(t('mcp.error.invalidTarget'));
  if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(records[index])) throw new Error(t('mcp.error.staleRecord'));
  return records.flatMap((x, i) => (i === index ? (replacement === undefined ? [] : [replacement]) : [x]));
}

/**
 * 只把这次表单里真正改动的字段合并到最新数据上：
 * 打开表单期间别处（另一个标签页、同步脚本）改过的其他字段不会被旧数据覆盖。
 */
export function mergeEdits<T extends { id: string }>(original: T, edited: T, latest: T | undefined): T {
  // 打开表单期间在别处被删掉了：不按旧表单把它写回来
  if (!latest) throw new Error(t('ui.error.deletedElsewhere'));
  const out: Record<string, unknown> = { ...latest };
  const keys = new Set([...Object.keys(original), ...Object.keys(edited)]);
  for (const k of keys) {
    const a = (original as Record<string, unknown>)[k];
    const b = (edited as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = b;
  }
  return out as T;
}

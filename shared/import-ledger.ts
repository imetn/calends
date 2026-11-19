import { addDays, CURRENCY_CODE, subError, uid, validDay } from './billing.ts';
import { importCycle, parseCsv, importSubscriptionsCsv } from './csv.ts';

export { importCycle };
import type { Contract, Cycle, PaymentMethod, Subscription } from './types.ts';
import { t } from './i18n.ts';

/** 导入文件（CSV、ZIP、数据库）大小与解压总量的上限 */
export const IMPORT_LIMIT = 32 * 1024 * 1024;

export interface ImportRow {
  key: string;
  user?: string;
  name: string;
  price: number;
  currency?: string;
  cycle?: Cycle;
  start?: string;
  nextDue?: string;
  status?: Subscription['status'];
  paymentMethod?: PaymentMethod;
  inactive: boolean;
  manual: boolean;
  category: string;
  method?: string;
  notes?: string;
  account?: string;
  tags?: string[];
  icon?: string;
  url?: string;
  end?: string;
  region?: string;
  remindDays?: number;
  contract?: Contract;
}

export interface ImportSource {
  rows: ImportRow[];
  users: Array<{ id: string; name: string }>;
  /**
   * 来源自带完整的计费规则（本站或 iOS Subscriptions 导出的 CSV）：照原样推算历史扣款，不设导入边界。
   * Wallos 等外部账本没有逐笔记录，导入日之前的推算扣款不计入支出（estimateFrom）
   */
  historyComplete?: boolean;
}

export type ImportFixes = Record<string, { currency?: string; cycle?: Cycle; start?: string; price?: number }>;
export interface ImportPreview {
  subscriptions: Subscription[];
  methods: PaymentMethod[];
  created: PaymentMethod[];
  issues: Array<{ key: string; name: string; message: string }>;
}

const text = (x: unknown) => (x == null ? '' : String(x).trim());
// Preserve malformed source dates so preview validation blocks them instead of inventing a schedule.
const day = (x: unknown) => text(x) || undefined;
const webUrl = (x: unknown) => {
  const value = text(x);
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Exported symbols such as $ and ¥ are deliberately not resolved to a currency code. */
function currencyOf(code: string, price: string): string | undefined {
  if (CURRENCY_CODE.test(code.toUpperCase())) return code.toUpperCase();
  const explicit = price.match(/\b([A-Z]{3})\b/);
  if (explicit) return explicit[1];
  return Object.entries({ '€': 'EUR', '£': 'GBP', '₺': 'TRY', '₹': 'INR', '₩': 'KRW', '₱': 'PHP', '₫': 'VND', '₽': 'RUB' }).find(([symbol]) =>
    price.includes(symbol),
  )?.[1];
}

export function readImportCsv(csv: string, existing: PaymentMethod[], today: string): ImportSource {
  const rows = parseCsv(csv);
  const headers = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  if (!headers.includes('name')) throw new Error(t('core.import.invalid'));
  if (!headers.includes('payment cycle')) {
    const legacy = importSubscriptionsCsv(csv, existing, today);
    return {
      users: [],
      historyComplete: true,
      rows: legacy.subscriptions.map((s, i) => ({
        key: String(i),
        name: s.name,
        price: s.price,
        currency: s.currency,
        cycle: s.cycle,
        start: s.start,
        inactive: false,
        status: s.status,
        paymentMethod: legacy.methods.find((m) => m.id === s.methodId),
        manual: false,
        category: s.category,
        method: legacy.methods.find((m) => m.id === s.methodId)?.name,
        notes: s.notes,
        account: s.account,
        tags: s.tags,
        url: webUrl(s.url),
        end: s.end,
        region: s.region,
        contract: s.contract,
      })),
    };
  }
  const col = (r: string[], key: string) => text(r[headers.indexOf(key)]);
  return {
    users: [],
    rows: rows
      .filter((r) => col(r, 'name'))
      .map((r, i) => {
        const price = col(r, 'price');
        const numeric = price.replace(/[^\d.,+-]/g, '');
        // Comma-only decimals are ambiguous in CSV exports; require a price with unambiguous precision.
        const parsed = /^[-+]?\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric) : NaN;
        return {
          key: String(i),
          name: col(r, 'name'),
          price: parsed,
          currency: currencyOf(col(r, 'currency'), price),
          cycle: importCycle(col(r, 'payment cycle')),
          start: day(col(r, 'start date')),
          nextDue: day(col(r, 'next payment')),
          inactive: col(r, 'state').toLowerCase() === 'disabled' || col(r, 'active').toLowerCase() === 'no',
          manual: col(r, 'renewal').toLowerCase() === 'manual',
          category: col(r, 'category'),
          method: col(r, 'payment method') || undefined,
          notes:
            [
              col(r, 'notes'),
              col(r, 'paid by') ? `${t('core.import.payers')}: ${col(r, 'paid by')}` : '',
              col(r, 'cancellation date') ? `${t('core.renewal.cancelBy')}: ${col(r, 'cancellation date')}` : '',
            ]
              .filter(Boolean)
              .join('\n') || undefined,
          url: webUrl(col(r, 'url')),
          remindDays: col(r, 'notifications').toLowerCase() === 'disabled' ? -1 : undefined,
        };
      }),
  };
}

/** Only whitelisted business tables/columns are read from an offline backup. */
export function readImportTables(tables: Record<string, Array<Record<string, unknown>>>): ImportSource {
  if (!tables.subscriptions || !tables.currencies) throw new Error(t('core.import.invalid'));
  const lookup = (table: string, id: unknown, column = 'name') => text(tables[table]?.find((r) => text(r.id) === text(id))?.[column]);
  const users = (tables.user ?? []).map((u) => ({ id: text(u.id), name: text(u.username) || text(u.id) }));
  const rows = tables.subscriptions.map((r): ImportRow => {
    const code = lookup('currencies', r.currency_id, 'code').toUpperCase();
    const categoryIds = (tables.subscription_categories ?? []).filter((c) => c.subscription_id === r.id).map((c) => c.category_id);
    const categoryNames = (categoryIds.length ? categoryIds : [r.category_id]).map((id) => lookup('categories', id)).filter(Boolean);
    const payers = (tables.subscription_payers ?? []).filter((p) => p.subscription_id === r.id).map((p) => p.payer_id);
    const payerNames = (payers.length ? payers : [r.payer_user_id]).map((id) => lookup('household', id)).filter(Boolean);
    const notes = [
      text(r.notes),
      payerNames.length ? `${t('core.import.payers')}: ${payerNames.join(', ')}` : '',
      text(r.cancellation_date) ? `${t('core.renewal.cancelBy')}: ${text(r.cancellation_date)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const unit = ({ 1: 'day', 2: 'week', 3: 'month', 4: 'year', 5: 'lifetime' } as const)[Number(r.cycle) as 1 | 2 | 3 | 4 | 5];
    return {
      key: text(r.id),
      user: text(r.user_id) || users[0]?.id,
      name: text(r.name),
      price: r.price == null || text(r.price) === '' ? NaN : Number(r.price),
      currency: code || undefined,
      cycle: unit ? { unit, every: unit === 'lifetime' ? 1 : Number(r.frequency ?? 1) } : undefined,
      start: day(r.start_date),
      nextDue: day(r.next_payment),
      inactive: Number(r.inactive ?? 0) === 1,
      manual: Number(r.auto_renew ?? 1) === 0,
      category: categoryNames[0] ?? '',
      tags: categoryNames.slice(1),
      method: lookup('payment_methods', r.payment_method_id) || undefined,
      notes: notes || undefined,
      url: webUrl(r.url),
      remindDays: Number(r.notify) === 0 ? -1 : Number(r.notify_days_before) >= 0 ? Number(r.notify_days_before) : undefined,
    };
  });
  const owners = [...new Set(rows.map((r) => r.user).filter((id): id is string => !!id))];
  return { rows, users: owners.map((id) => users.find((u) => u.id === id) ?? { id, name: id }) };
}

/** No name-based subscription deduplication; preview IDs remain stable until confirmation. */
export function prepareImport(
  source: ImportSource,
  existing: PaymentMethod[],
  today: string,
  fixes: ImportFixes = {},
  user?: string,
  allowedCurrencies?: string[],
): ImportPreview {
  const subscriptions: Subscription[] = [],
    methods: PaymentMethod[] = [],
    created: PaymentMethod[] = [];
  const issues: ImportPreview['issues'] = [];
  if (source.users.length > 1 && !user) return { subscriptions, methods, created, issues: [{ key: '', name: '', message: t('core.import.selectUser') }] };
  for (const r of source.rows.filter((r) => !user || r.user === user)) {
    const fix = fixes[r.key] ?? {};
    if (!r.name.trim()) {
      issues.push({ key: r.key, name: r.name, message: t('core.import.invalid') });
      continue;
    }
    const currency = fix.currency || r.currency;
    const cycle = fix.cycle ?? r.cycle;
    if (!currency || !CURRENCY_CODE.test(currency) || (allowedCurrencies && !allowedCurrencies.includes(currency))) {
      issues.push({ key: r.key, name: r.name, message: t('core.import.currency') });
      continue;
    }
    if (!cycle || !Number.isInteger(cycle.every) || cycle.every < 1) {
      issues.push({ key: r.key, name: r.name, message: t('core.import.cycle') });
      continue;
    }
    const price = fix.price ?? r.price;
    if (!Number.isFinite(price) || price < 0) {
      issues.push({ key: r.key, name: r.name, message: t('core.import.price') });
      continue;
    }
    const start = fix.start || r.start || today;
    // 开始日可在预览里修正，格式不对就拦下；下次扣款日、结束日没有修正入口，格式不对时不导入这两项，原值写进备注
    if (!validDay(start)) {
      issues.push({ key: r.key, name: r.name, message: t('core.import.date') });
      continue;
    }
    // 同名钱包优先取同币种的；没有就复用同名的那一个（一张卡可以付多种币种），不再新建同名钱包
    const pool = [...existing, ...created];
    let method =
      pool.find((m) => m.name === r.method && (r.paymentMethod != null || m.currency === currency)) ?? pool.find((m) => !!r.method && m.name === r.method);
    if (r.method && !method) {
      method = r.paymentMethod
        ? { ...r.paymentMethod, id: uid(), currency: r.paymentMethod.currency || currency }
        : { id: uid(), name: r.method, kind: 'other', currency };
      created.push(method);
    }
    if (method && !methods.some((m) => m.id === method!.id)) methods.push(method);
    const nextDue = r.nextDue && validDay(r.nextDue) ? r.nextDue : undefined;
    const end = r.end && validDay(r.end) ? r.end : undefined;
    const notes = [
      r.notes,
      !r.start ? t('core.import.unknownStart') : '',
      r.manual ? t('core.import.manual') : '',
      r.nextDue && !nextDue ? t('core.import.badDate', { field: t('core.import.nextDue'), value: r.nextDue }) : '',
      r.end && !end ? t('core.import.badDate', { field: t('core.import.end'), value: r.end }) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const sub: Subscription = {
      id: uid(),
      name: r.name,
      account: r.account,
      category: r.category || t('core.csv.otherCategory'),
      tags: r.tags ?? [],
      price,
      currency,
      cycle,
      start,
      estimateFrom: source.historyComplete ? undefined : today,
      nextDue,
      end,
      region: r.region,
      url: r.url,
      status: r.status ?? (r.inactive || r.manual ? 'paused' : 'active'),
      pausedAt: r.inactive || r.manual ? today : undefined,
      methodId: method?.id,
      notes: notes || undefined,
      createdAt: today,
      remindDays: r.remindDays,
      ...(r.icon ? { icon: r.icon } : {}),
      ...(r.contract ? { contract: r.contract } : {}),
    };
    // An old next-payment date is preserved as source metadata, not invented as a payment.
    if (sub.nextDue && sub.nextDue < start) sub.billingStart = sub.nextDue;
    if (sub.cycle.unit === 'lifetime' && !source.historyComplete) sub.estimateFrom = addDays(today, 1);
    const error = subError(sub);
    if (error) issues.push({ key: r.key, name: r.name, message: error });
    else subscriptions.push(sub);
  }
  return { subscriptions, methods, created, issues };
}

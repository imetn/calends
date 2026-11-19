import type { AppState, Contract, Cycle, MethodKind, PaymentMethod, Subscription } from './types.ts';
import { uid } from './billing.ts';
import { t } from './i18n.ts';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function toCsvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(toCsvCell).join(',')).join('\n');
}

export function importCycle(raw: unknown): Cycle | undefined {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (/^(one[- ]time|lifetime|once)$/.test(value)) return { unit: 'lifetime', every: 1 };
  const common: Record<string, Cycle> = {
    daily: { unit: 'day', every: 1 },
    weekly: { unit: 'week', every: 1 },
    monthly: { unit: 'month', every: 1 },
    quarterly: { unit: 'month', every: 3 },
    yearly: { unit: 'year', every: 1 },
    annually: { unit: 'year', every: 1 },
  };
  if (common[value]) return common[value];
  const match = value.match(/^every\s+(\d+)\s+(day|week|month|year)s?$/);
  return match && Number(match[1]) > 0 ? { unit: match[2] as Cycle['unit'], every: Number(match[1]) } : undefined;
}

/** 导出的周期写法，importCycle 能原样读回 */
export function exportCycle(c: Cycle): string {
  if (c.unit === 'lifetime') return 'Lifetime';
  return c.every === 1 ? { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[c.unit] : `Every ${c.every} ${c.unit}s`;
}

/** 本站导出的 CSV：Subscriptions 应用的列，加上合同期四列；顶层字段即最后一段 */
export function exportSubscriptionsCsv(state: Pick<AppState, 'subscriptions' | 'methods'>): string {
  const head = ['Name', 'Currency', 'Price', 'Category', 'Cycle', 'Starts', 'Ends', 'Tags', 'Payment Account', 'URL', 'Notes'];
  const contractHead = ['Contract Start', 'Contract Term', 'Contract Renews', 'Contract Notice Days'];
  const rows = state.subscriptions.map((x) => [
    x.name,
    x.currency,
    x.price,
    x.category,
    exportCycle(x.cycle),
    x.start,
    x.end ?? '',
    x.tags.join(' '),
    state.methods.find((m) => m.id === x.methodId)?.name ?? '',
    x.url ?? '',
    x.notes ?? '',
    x.contract?.start ?? '',
    x.contract ? exportCycle(x.contract.term) : '',
    x.contract ? (x.contract.renew === 'none' ? 'No' : 'Yes') : '',
    x.contract?.noticeDays ?? '',
  ]);
  return toCsv([[...head, ...contractHead], ...rows]);
}

function mdy(s: string): string | undefined {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return s.trim();
  return undefined;
}

/** 认不出的金额（含逗号小数、千分位等有歧义的写法）为 NaN，交给 prepareImport 在预览里拦下 */
function amount(s: string): number {
  const numeric = s.replace(/[^\d.,+-]/g, '');
  return /^[-+]?\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric) : NaN;
}

/** 依据账户名称推断类型 */
function guessKind(name: string): MethodKind {
  if (/支付宝|alipay/i.test(name)) return 'alipay';
  if (/微信|wechat/i.test(name)) return 'wechat';
  if (/paypal/i.test(name)) return 'paypal';
  if (/电话卡|手机卡|话费|smart|globe|load/i.test(name)) return 'phone';
  if (/app ?store|apple|礼品卡|余额/i.test(name)) return 'appstore';
  if (/信用卡|credit|visa|master|amex/i.test(name)) return 'credit';
  if (/银行|bank|card|卡/i.test(name)) return 'debit';
  return 'other';
}

const REGION_BY_CCY: Record<string, string> = { TRY: 'TR', NGN: 'NG', PHP: 'PH', INR: 'IN', PKR: 'PK', EGP: 'EG', CNY: 'CN', USD: 'US' };

/** 币种、周期、开始日可能缺失或认不出：原样交给 prepareImport 报问题，不替用户猜 */
export type ImportedSubscription = Omit<Subscription, 'currency' | 'cycle' | 'start'> & { currency?: string; cycle?: Cycle; start?: string };

export interface ImportResult {
  subscriptions: ImportedSubscription[];
  /** 要写入的支付方式：新建的加上被引用到的已有的 */
  methods: PaymentMethod[];
  /** 其中新建的 */
  created: PaymentMethod[];
}

/**
 * 导入 Subscriptions（iOS/macOS）导出的 CSV：
 * Name,Currency,Price,Category,Cycle,Starts,Ends,Tags,Payment Account,URL,Notes
 * 也兼容本站导出的 CSV（同名表头）。
 */
export function importSubscriptionsCsv(text: string, existing: PaymentMethod[], today: string): ImportResult {
  const rows = parseCsv(text);
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  if (head.includes('payment cycle')) throw new Error(t('core.import.reviewRequired'));
  const col = (r: string[], ...names: string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return (r[i] ?? '').trim();
    }
    return '';
  };
  const methods = [...existing];
  const created: PaymentMethod[] = [];
  const methodFor = (name: string, ccy: string): string | undefined => {
    let label = name.trim();
    if (!label) {
      // 空账户的外币订阅，多为对应区 App Store 余额（礼品卡）支付
      const region = REGION_BY_CCY[ccy];
      if (!region || region === 'CN' || region === 'US') return undefined;
      label = t('core.csv.appStoreBalance', { region });
    }
    let m = methods.find((x) => x.name === label);
    if (!m) {
      const kind = guessKind(label);
      m = {
        id: uid(),
        name: label,
        kind,
        currency: kind === 'debit' || kind === 'credit' || kind === 'alipay' || kind === 'wechat' ? 'CNY' : ccy,
        region: kind === 'appstore' || kind === 'phone' ? REGION_BY_CCY[ccy] : undefined,
      };
      methods.push(m);
      created.push(m);
    }
    return m.id;
  };
  // 没有名称的行（空行、合计行等）直接跳过，不让整批导入失败
  const subscriptions: ImportedSubscription[] = rows
    .filter((r) => col(r, 'name'))
    .map((r) => {
      const ccy = col(r, 'currency').toUpperCase();
      // 空开始日交给 prepareImport 按今天并在备注说明；认不出的保留原文，预览里拦下待修正
      const rawStart = col(r, 'starts', 'start');
      const start = mdy(rawStart) ?? (rawStart || undefined);
      const rawEnd = col(r, 'ends', 'end');
      const end = mdy(rawEnd);
      const cycle = importCycle(col(r, 'cycle'));
      const tags = col(r, 'tags')
        .split(/[\s,，]+/)
        .filter(Boolean);
      // 合同期：开始日和期限都空时没有；认不出的原样保留，交给 prepareImport 报错
      const contractStart = col(r, 'contract start');
      const contractTerm = col(r, 'contract term');
      const notice = col(r, 'contract notice days');
      const contract: Contract | undefined =
        contractStart || contractTerm
          ? {
              start: mdy(contractStart) ?? contractStart,
              term: importCycle(contractTerm) as Cycle,
              ...(/^(no|false|0)$/i.test(col(r, 'contract renews')) ? { renew: 'none' as const } : {}),
              ...(notice ? { noticeDays: /^\d+$/.test(notice) ? Number(notice) : NaN } : {}),
            }
          : undefined;
      const sub: ImportedSubscription = {
        id: uid(),
        name: col(r, 'name'),
        category: col(r, 'category') || t('core.csv.otherCategory'),
        tags,
        price: amount(col(r, 'price')),
        currency: ccy || undefined,
        cycle,
        start,
        end: end ?? (rawEnd || undefined),
        status: end && end < today ? 'cancelled' : 'active',
        methodId: methodFor(col(r, 'payment account', 'payment method'), ccy),
        url: col(r, 'url') || undefined,
        notes: col(r, 'notes') || undefined,
        region: REGION_BY_CCY[ccy] !== 'CN' && REGION_BY_CCY[ccy] !== 'US' ? REGION_BY_CCY[ccy] : undefined,
        ...(contract ? { contract } : {}),
        createdAt: today,
      };
      return sub;
    });
  // 除新建的，也带上被引用到的已有支付方式：「替换全部」会清空支付方式，不带上引用就悬空了
  const used = new Set(subscriptions.map((x) => x.methodId));
  return { subscriptions, methods: methods.filter((m) => created.includes(m) || used.has(m.id)), created };
}

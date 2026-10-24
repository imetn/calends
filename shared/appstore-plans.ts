// App Store 详情页里的「App 内购买项目」：只有名称和带符号的价格，没有币种代码和周期。
// 币种由调用方按商店地区给；周期只从名称里认常见写法，认不出就不给，绝不把读不出的价格当 0。
import type { Cycle } from './types.ts';

export interface AppStorePlan {
  name: string;
  /** 商店原样显示的价格，如「22,99 €」 */
  priceText: string;
  price?: number;
  cycle?: Cycle;
}

/** 从详情页 HTML 取内购列表；页面结构变了或没有内购时返回空数组 */
export function parseAppStorePlans(html: string): AppStorePlan[] {
  const m = /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  // 页面里只有内购这一块是「名称 + 价格」的 textPair 列表；标题随语言变，所以按结构找
  const found: AppStorePlan[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 40) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (o.$kind === 'Annotation' && Array.isArray(o.items)) {
      const pairs = o.items.filter((x): x is { leadingText: string; trailingText: string } => {
        const p = x as Record<string, unknown>;
        return p?.$kind === 'textPair' && typeof p.leadingText === 'string' && typeof p.trailingText === 'string';
      });
      for (const p of pairs) {
        const name = p.leadingText.trim();
        const priceText = p.trailingText.replace(/\s+/g, ' ').trim();
        const key = `${name}\u0000${priceText}`;
        if (!name || !priceText || seen.has(key)) continue;
        seen.add(key);
        found.push({ name, priceText, price: parsePrice(priceText), cycle: guessCycle(name) });
      }
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  return found;
}

/**
 * 「$19.99」「22,99 €」「¥3,000」「Rp 299.000」「1.299,00 TL」→ 数值。
 * 只有一种分隔符且后面正好三位数时当千分位，否则当小数点；两种都有时最后一个是小数点。
 */
export function parsePrice(text: string): number | undefined {
  const s = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return undefined;
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let n: number;
  if (last < 0) n = Number(s);
  else {
    const seps = new Set(s.replace(/\d/g, ''));
    const tail = s.slice(last + 1);
    const thousands = seps.size === 1 && (tail.length === 3 || s.split(s[last]).length > 2);
    n = thousands ? Number(s.replace(/[.,]/g, '')) : Number(`${s.slice(0, last).replace(/[.,]/g, '')}.${tail}`);
  }
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 「3 个月」「6 months」「12 Monate」这类带数字的先按数字算；其余按单位词认，「年」排在「月」前
const N_MONTHS = /(\d{1,2})\s*(?:个|個|か|ヶ)?\s*(?:月|months?|monate?|mois|meses|mes|mesi|ay|tháng|개월|месяц\S*|bulan)/i;
const CYCLE_WORDS: Array<[RegExp, Cycle]> = [
  [/lifetime|终身|終身|永久|買い切り|평생|lebenslang|vitalicio|vitalício|à vie|ömür boyu|trọn đời|навсегда|seumur hidup/i, { unit: 'lifetime', every: 1 }],
  [/半年|semestral|semestriel|halbjährlich/i, { unit: 'month', every: 6 }],
  [/季|quarter|trimestral|trimestriel|vierteljährlich/i, { unit: 'month', every: 3 }],
  [/年|year|annual|jahr|jähr|anual|annuel|année|anno|annuale|yıl|năm|연간|년|год|tahun/i, { unit: 'year', every: 1 }],
  [/月|month|monat|mensal|mensuel|mois|mese|mensile|aylık|tháng|월|месяц|bulan/i, { unit: 'month', every: 1 }],
  [/周|週|week|woche|semana|semaine|settiman|hafta|tuần|주간|недел|minggu/i, { unit: 'week', every: 1 }],
];

/** 按套餐名猜计费周期；认不出返回 undefined，由用户自己选 */
export function guessCycle(name: string): Cycle | undefined {
  const n = Number(N_MONTHS.exec(name)?.[1]);
  if (n === 12) return { unit: 'year', every: 1 };
  if (n >= 1 && n < 12) return { unit: 'month', every: n };
  return CYCLE_WORDS.find(([re]) => re.test(name))?.[1];
}

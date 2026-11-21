// 常用服务目录的类型与匹配规则（数据在 app/src/catalog/，网页联想与 MCP 共用）。
import { CATALOG_ALIASES } from './locales/catalog-aliases.gen.ts';

export type CatalogCat =
  'ai' | 'tools' | 'productivity' | 'domains' | 'storage' | 'media' | 'music' | 'shopping' | 'education' | 'news' | 'social' | 'developer';

export interface ServiceEntry {
  name: string;
  file?: string;
  aka: string[];
  cat: string;
  url: string;
  icon: string;
  localized?: boolean;
  chargeLeadDays?: number;
  cancelLeadDays?: number;
}

/** 目录里只存分类代码；localized 的条目在 catalog.name.<file> 里有译名，按当前语言显示，原名与译名均参与搜索 */
export type CatalogEntry = ServiceEntry & {
  file: string;
  cat: CatalogCat;
};

/** 比较时忽略大小写、全半角、空格和标点 */
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const namesOf = (e: ServiceEntry, aliases: Record<string, string[]>) => {
  const extra = e.localized && e.file ? (aliases[e.file] ?? []) : [];
  return [e.name, ...e.aka, ...extra].map(norm).filter(Boolean);
};

/** 反向包含阈值：2 字中文/日韩品牌名（豆包、优酷、得到等）可匹配带套餐后缀的查询；纯拉丁缩写保留 ≥3 避免误匹配 */
const minReverseLen = (n: string) => (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(n) ? 2 : 3);

/** 按当前语言取显示名称；未译或非 localized 条目回退原名 */
export function serviceDisplayName(e: ServiceEntry, tr: (key: string) => string): string {
  if (!e.localized || !e.file) return e.name;
  const key = `catalog.name.${e.file}`;
  const label = tr(key);
  return label === key ? e.name : label;
}

/** 模糊搜索：完全一致 > 前缀 > 包含 */
export function searchServices<T extends ServiceEntry>(entries: T[], query: string, limit = 8, aliases: Record<string, string[]> = CATALOG_ALIASES): T[] {
  const k = norm(query);
  if (!k) return [];
  const score = (e: T) => {
    const names = namesOf(e, aliases);
    if (names.includes(k)) return 3;
    if (names.some((n) => n.startsWith(k))) return 2;
    return names.some((n) => n.includes(k) || (k.length >= 3 && n.length >= minReverseLen(n) && k.includes(n))) ? 1 : 0;
  };
  return entries
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

/** 自动填充只认名称或别名完全一致，避免把相近的名字写成别家的图标和官网 */
export const exactServices = <T extends ServiceEntry>(entries: T[], name: string, aliases: Record<string, string[]> = CATALOG_ALIASES): T[] => {
  const k = norm(name);
  return k ? entries.filter((e) => namesOf(e, aliases).includes(k)) : [];
};

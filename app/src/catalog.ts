// 常用服务目录：新建订阅时按名称联想，选中后带出 logo、分类和官网。不带价格，价格变得太快，留给用户自己填。
// 条目按分包放在 catalog/ 下，构建时自动收录；删掉某个分包文件即去掉这批条目，不影响构建。
// 收录规则：只收 App Store 搜索覆盖不好的服务（网页订阅、AI、域名、开发者账号等），或需要预设续费规则的；
// 图标放在 public 下的本地文件，不外链。
import { t } from '../../shared/i18n.ts';
import { presetCat } from './derive.ts';

export interface CatalogItem {
  name: string;
  /** 别名、厂商名、中文名，都参与搜索 */
  aka: string[];
  icon: string;
  category: string;
  url: string;
  chargeLeadDays?: number;
  cancelLeadDays?: number;
}

export type CatalogCat =
  'ai' | 'tools' | 'productivity' | 'domains' | 'storage' | 'media' | 'music' | 'shopping' | 'education' | 'news' | 'social' | 'developer';
/** 目录里只存分类代码；localized 的条目在 catalog.name.<file> 里有译名，按当前语言显示，原名仍参与搜索 */
export type CatalogEntry = {
  name: string;
  file: string;
  aka: string[];
  cat: CatalogCat;
  url: string;
  icon: string;
  localized?: boolean;
  chargeLeadDays?: number;
  cancelLeadDays?: number;
};

const PACKS = import.meta.glob<{ default: CatalogEntry[] }>('./catalog/*.ts', { eager: true });
const CATALOG: CatalogEntry[] = Object.values(PACKS).flatMap((m) => m.default);

/** 选中目录项时才取文案：分类会写进订阅，所以按当前语言给默认值 */
function resolve(e: CatalogEntry): CatalogItem {
  const name = e.localized ? t(`catalog.name.${e.file}`) : e.name;
  return {
    name,
    aka: name === e.name ? e.aka : [e.name, ...e.aka],
    icon: e.icon,
    chargeLeadDays: e.chargeLeadDays,
    cancelLeadDays: e.cancelLeadDays,
    category: presetCat(e.cat),
    url: e.url,
  };
}

/** 名称联想：前缀命中排前面，其次是包含 */
export function searchCatalog(q: string, limit = 4): CatalogItem[] {
  const k = q.trim().toLowerCase();
  if (k.length < 1) return [];
  const score = (c: CatalogEntry) => {
    const names = [c.name, ...c.aka].map((x) => x.toLowerCase());
    if (names.some((n) => n === k)) return 3;
    if (names.some((n) => n.startsWith(k))) return 2;
    if (names.some((n) => n.includes(k) || (k.length >= 3 && k.includes(n)))) return 1;
    return 0;
  };
  return CATALOG.map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => resolve(x.c));
}

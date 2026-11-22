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

/**
 * 单独维护的可安全自动填充别名（按条目的 file 索引）：只收明确指向同一服务的产品名、套餐名或标准译名。
 * 目录条目里的 aka 还包含厂商名（vercel、apple、openai、cloudflare 等）和泛称（domain、域名、copilot、流程图等），
 * 只用于模糊联想，不参与新建订阅时的静默自动填充。
 */
export const EXACT_ALIASES: Record<string, string[]> = {
  opencode: ['opencode zen', 'opencode go'],
  openai: ['chatgpt plus', 'chatgpt pro'],
  claude: ['claude pro', 'claude max'],
  gemini: ['google ai pro', 'google one ai'],
  grok: ['supergrok'],
  perplexity: ['perplexity pro'],
  kimi: ['kimi code'],
  mistral: ['le chat'],
  copilot: ['copilot pro', 'microsoft 365 copilot'],
  cursor: ['cursor pro'],
  runway: ['runwayml'],
  kling: ['kling'],
  elevenlabs: ['11labs'],
  notion: ['notion ai'],
  baidupan: ['baidupan', 'baidu pan'],
  '115': ['115网盘', '115云盘', '115 pan'],
  alipan: ['alipan', '阿里网盘', 'aliyun drive'],
  quark: ['夸克云盘', 'quark drive'],
  iqiyi: ['iqiyi'],
  youku: ['youku'],
  mgtv: ['mgtv'],
  bilibili: ['bilibili', 'b站', '哔哩哔哩'],
  netflix: ['奈飞'],
  spotify: ['声田'],
  qqmusic: ['qqmusic'],
  taobao: ['88vip'],
  yhd: ['一号会员店'],
  dedao: ['得到app'],
  zhihu: ['知乎会员'],
  weread: ['weread'],
  qqvip: ['qqvip'],
  youtube: ['yt premium'],
  duolingo: ['duolingo'],
  mubu: ['幕布文档'],
  microsoft365: ['office 365', 'ms365'],
  icloud: ['apple icloud'],
  weiyun: ['腾讯微云'],
  miCloud: ['小米云', 'micloud', 'xiaomi cloud'],
  appledev: ['apple developer', '苹果开发者'],
  leigod: ['leigod'],
};

/** 比较时忽略大小写、全半角、空格和标点 */
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const searchNamesOf = (e: ServiceEntry, aliases: Record<string, string[]>, exactAliases: Record<string, string[]>) => {
  const localized = e.localized && e.file ? (aliases[e.file] ?? []) : [];
  const safe = e.file ? (exactAliases[e.file] ?? []) : [];
  return [e.name, ...e.aka, ...localized, ...safe].map(norm).filter(Boolean);
};

const exactNamesOf = (e: ServiceEntry, aliases: Record<string, string[]>, exactAliases: Record<string, string[]>) => {
  const localized = e.localized && e.file ? (aliases[e.file] ?? []) : [];
  const safe = e.file ? (exactAliases[e.file] ?? []) : [];
  return [e.name, ...localized, ...safe].map(norm).filter(Boolean);
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
export function searchServices<T extends ServiceEntry>(
  entries: T[],
  query: string,
  limit = 8,
  aliases: Record<string, string[]> = CATALOG_ALIASES,
  exactAliases: Record<string, string[]> = EXACT_ALIASES,
): T[] {
  const k = norm(query);
  if (!k) return [];
  const score = (e: T) => {
    const names = searchNamesOf(e, aliases, exactAliases);
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

/** 自动填充只认原名、各语言译名与单独维护的安全别名；aka 里的厂商名与泛称只留给联想 */
export const exactServices = <T extends ServiceEntry>(
  entries: T[],
  name: string,
  aliases: Record<string, string[]> = CATALOG_ALIASES,
  exactAliases: Record<string, string[]> = EXACT_ALIASES,
): T[] => {
  const k = norm(name);
  return k ? entries.filter((e) => exactNamesOf(e, aliases, exactAliases).includes(k)) : [];
};

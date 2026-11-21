// 常用服务目录：新建订阅时按名称联想，选中后带出 logo、分类和官网。不带价格，价格变得太快，留给用户自己填。
// 条目按分包放在 catalog/ 下，构建时自动收录；删掉某个分包文件即去掉这批条目，不影响构建。
// 收录规则：只收 App Store 搜索覆盖不好的服务（网页订阅、AI、域名、开发者账号等），或需要预设续费规则的；
// 图标放在 public 下的本地文件，不外链。
import { t } from '../../shared/i18n.ts';
import { searchServices, serviceDisplayName, type CatalogCat, type CatalogEntry } from '../../shared/service-catalog.ts';
import { presetCat } from './derive.ts';

export type { CatalogCat, CatalogEntry };

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

const PACKS = import.meta.glob<{ default: CatalogEntry[] }>('./catalog/*.ts', { eager: true });
const CATALOG: CatalogEntry[] = Object.values(PACKS).flatMap((m) => m.default);

/** 选中目录项时才取文案：分类会写进订阅，所以按当前语言给默认值 */
function resolve(e: CatalogEntry): CatalogItem {
  const name = serviceDisplayName(e, t);
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

/** 名称联想：复用 shared/service-catalog.ts（完全一致 > 前缀 > 包含） */
export function searchCatalog(q: string, limit = 4): CatalogItem[] {
  return searchServices(CATALOG, q, limit).map(resolve);
}

// App Store 查询：后台的名称联想、套餐预填与 AI 工具共用；只读公开接口和商店页，不写账本
import { parseAppStorePlans } from '../shared/appstore-plans.ts';
import { appStoreHits, appStoreSearchUrl, storeCountry } from '../shared/appstore-search.ts';
import { edgeCache, HttpError } from './http.ts';

/** App Store 搜索（也接受 App Store 链接，按 id 精确查找）；后台的名称联想和 AI 共用。苹果限流或出错时抛 502，不当成没有结果 */
export async function searchAppStore(query: string, country = 'us') {
  const api = appStoreSearchUrl(query, country);
  if (!api) return [];
  const res = await fetch(api, edgeCache(86400));
  if (!res.ok) throw new HttpError(502, `App Store ${res.status}`);
  return appStoreHits(await res.json().catch(() => ({})));
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
    fetch(`https://apps.apple.com/${cc}/app/id${appId}`, { ...edgeCache(86400), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${cc}`, edgeCache(86400))
      .then((r) => r.json() as Promise<{ results?: Array<{ currency?: string }> }>)
      .catch(() => ({ results: [] as Array<{ currency?: string }> })),
  ]);
  const currency = lookup.results?.[0]?.currency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { currency: undefined, plans: [] };
  return { currency, plans: parseAppStorePlans(page).slice(0, 20) };
}

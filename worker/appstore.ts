// App Store 查询：后台的名称联想、套餐预填与 AI 工具共用；只读公开接口和商店页，不写账本
import { parseAppStorePlans } from '../shared/appstore-plans.ts';

/** 两位商店地区代码，缺省 us */
const storeCountry = (country: string) =>
  country
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 2) || 'us';

/** App Store 搜索（也接受 App Store 链接，按 id 精确查找）；后台的名称联想和 AI 共用 */
export async function searchAppStore(query: string, country = 'us') {
  // 先从完整输入里取 id：中文名编码后的链接常超 80 字，id 在末尾会被截掉
  const id = query.match(/id(\d{6,})/)?.[1];
  const term = query.trim().slice(0, 80);
  const cc = storeCountry(country);
  if (!term) return [];
  const api = id
    ? `https://itunes.apple.com/lookup?id=${id}&country=${cc}`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=8&country=${cc}`;
  const res = await fetch(api, { cf: { cacheTtl: 86400 } });
  const body = (await res.json().catch(() => ({}))) as { results?: Array<Record<string, unknown>> };
  return (body.results ?? []).map((r) => ({
    id: String(r.trackId),
    name: r.trackName as string,
    icon: r.artworkUrl100 as string,
    url: r.trackViewUrl as string,
    seller: r.sellerName as string,
    genre: r.primaryGenreName as string,
  }));
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
    fetch(`https://apps.apple.com/${cc}/app/id${appId}`, { cf: { cacheTtl: 86400 }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${cc}`, { cf: { cacheTtl: 86400 } })
      .then((r) => r.json() as Promise<{ results?: Array<{ currency?: string }> }>)
      .catch(() => ({ results: [] as Array<{ currency?: string }> })),
  ]);
  const currency = lookup.results?.[0]?.currency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { currency: undefined, plans: [] };
  return { currency, plans: parseAppStorePlans(page).slice(0, 20) };
}

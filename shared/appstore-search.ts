// App Store 搜索的请求地址与结果整理：Worker 和浏览器共用。
// 苹果按出口 IP 限流，Cloudflare 的共享出口常被限；服务端查不到时浏览器用同一地址直连，结果一致。

/** 两位商店地区代码，缺省 us */
export const storeCountry = (country: string) =>
  country
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 2) || 'us';

/** 搜索地址；输入里带 App ID（App Store 链接）时按 id 精确查找，没有内容时为 undefined */
export function appStoreSearchUrl(query: string, country = 'us') {
  // 先从完整输入里取 id：中文名编码后的链接常超 80 字，id 在末尾会被截掉
  const id = query.match(/id(\d{6,})/)?.[1];
  const term = query.trim().slice(0, 80);
  const cc = storeCountry(country);
  if (!term) return undefined;
  return id
    ? `https://itunes.apple.com/lookup?id=${id}&country=${cc}`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=8&country=${cc}`;
}

/** iTunes 接口返回的结果整理成联想条目 */
export function appStoreHits(body: unknown) {
  const results = (body as { results?: Array<Record<string, unknown>> } | null)?.results ?? [];
  return results.map((r) => ({
    id: String(r.trackId),
    name: r.trackName as string,
    icon: r.artworkUrl100 as string,
    url: r.trackViewUrl as string,
    seller: r.sellerName as string,
    genre: r.primaryGenreName as string,
  }));
}

/**
 * 先走服务端；服务端出口被苹果限流（5xx）时，用调用方的网络直连同一接口。
 * 未登录等其他错误照原样抛出，不绕过；直连也失败时抛服务端的错误。
 */
export async function searchWithFallback<T>(server: () => Promise<T[]>, query: string, country: string, fetchFn: typeof fetch = fetch) {
  try {
    return await server();
  } catch (e) {
    const url = appStoreSearchUrl(query, country);
    if (!url || !((e as { status?: number }).status! >= 500)) throw e;
    const res = await fetchFn(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) throw e;
    return appStoreHits(await res.json());
  }
}

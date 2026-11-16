/**
 * 版本号比较与「检查更新」的纯逻辑：不碰浏览器和网络，浏览器端的请求与缓存在 app/src/update-check.ts。
 */

/** 发布仓库：最新稳定版取它的 releases/latest（GitHub 已排除 prerelease 和 draft） */
export const RELEASE_REPO = 'imetn/calends';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
/** 每台设备自动检查的最短间隔 */
export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

/** 解析 x.y.z（可带 v 前缀、-预发布、+构建信息）；不是语义化版本返回 null */
export function parseVersion(input: string): SemVer | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** 按语义化版本优先级比较：a 较新为正、较旧为负、相同为 0；任一方无法解析返回 null */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // 正式版高于同号预发布版
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** latest 是否比 current 新；任一方不是语义化版本（如开发构建）时不算有新版 */
export function isNewer(latest: string | undefined, current: string): boolean {
  if (!latest) return false;
  const c = compareVersions(latest, current);
  return c !== null && c > 0;
}

/** 显示用：去掉 v 前缀 */
export const plainVersion = (v: string) => v.trim().replace(/^v/, '');

export interface ReleaseInfo {
  version: string;
  url: string;
}

/** 从 GitHub releases/latest 的响应里取版本和发布页；草稿、预发布、非语义化标签或别处的链接一律不认 */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  const v = parseVersion(r.tag_name);
  if (!v || v.pre.length) return null;
  if (!r.html_url.startsWith(`https://github.com/${RELEASE_REPO}/releases/`)) return null;
  return { version: plainVersion(r.tag_name).replace(/\+.*$/, ''), url: r.html_url };
}

/** 设备上缓存的检查结果：checkedAt 是最近一次尝试（成功或失败）的时间，latest 是最近一次成功读到的版本 */
export interface UpdateCache {
  checkedAt: number;
  latest?: ReleaseInfo;
}

/** 读回缓存：形状不对就当没有 */
export function parseUpdateCache(raw: string | null): UpdateCache | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { checkedAt?: unknown; latest?: unknown };
    if (typeof j.checkedAt !== 'number' || !Number.isFinite(j.checkedAt)) return null;
    const latest = j.latest as { version?: unknown; url?: unknown } | undefined;
    const ok = latest && typeof latest.version === 'string' && typeof latest.url === 'string' && parseVersion(latest.version);
    return { checkedAt: j.checkedAt, latest: ok ? { version: latest.version as string, url: latest.url as string } : undefined };
  } catch {
    return null;
  }
}

/** 自动检查是否到期：从没查过、已满间隔，或记录的时间在未来（设备时钟被调过）时到期 */
export function autoCheckDue(cache: UpdateCache | null, now: number, interval = UPDATE_CHECK_INTERVAL): boolean {
  if (!cache) return true;
  return now - cache.checkedAt >= interval || cache.checkedAt > now;
}

/** 一次检查后的新缓存：失败只记尝试时间，保留上次读到的版本 */
export function nextUpdateCache(prev: UpdateCache | null, now: number, latest: ReleaseInfo | null): UpdateCache {
  return { checkedAt: now, latest: latest ?? prev?.latest };
}

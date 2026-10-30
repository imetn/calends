// 网上搜 Logo：从订阅官网抓图标，再退回两套开源图标库和图片搜索。
// 只负责「找图」，选中后由前端写进订阅的 icon 字段，不碰名称、分类等其他字段。
//
// 为什么先找官网：图片搜索按名称查「Vmiss logo」这类词，命中的多是同名公司或
// 测评文章配图。官网首页自带的图标和页头 logo 才是这家服务真正在用的图，
// 所以先用网页搜索定位官网，再从官网自己的 HTML 里取图，最后才用图片搜索兜底。
import { getKv, putKv } from '../store.ts';
import { fetchPublic, isPublicHttpsUrl } from '../url-guard.ts';
import type { Env } from '../env.ts';

export interface LogoHit {
  /** 可直接放进 <img src> 的地址；经过本站代理或图库 CDN */
  url: string;
  /** 展示用的缩略图，与 url 相同或更小 */
  thumb: string;
  /** 来源，前端按它分组 */
  source: 'site' | 'selfhst' | 'dashboard' | 'web';
  /** 图库里的名称，便于同一张图去重 */
  name: string;
  width?: number;
  height?: number;
}

/** 图库索引缓存在 KV 里，一天一更；索引本身约 1MB，不每次请求都拉 */
const INDEX_TTL = 86400;
const MAX_RESULTS = 24;
/** 官网首页只读前 600KB：大站点首页能到 2MB，图标都在头部 */
const MAX_HTML = 600_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

type SelfhstEntry = { Name: string; Reference: string; PNG?: string; SVG?: string; WebP?: string };
type DashTree = { png?: string[]; svg?: string[]; webp?: string[] };

const SELFHST_INDEX = 'https://raw.githubusercontent.com/selfhst/icons/main/index.json';
const DASH_INDEX = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/tree.json';
const SELFHST_BASE = 'https://raw.githubusercontent.com/selfhst/icons/main';
const DASH_BASE = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main';

async function cachedIndex<T>(env: Env, key: string, url: string): Promise<T | undefined> {
  const cached = await getKv<{ at: number; data: T }>(env, key);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.at < INDEX_TTL) return cached.data;
  try {
    const res = await fetch(url, { cf: { cacheTtl: INDEX_TTL, cacheEverything: true } });
    if (!res.ok) return cached?.data;
    const data = (await res.json()) as T;
    // 走到这里说明缓存已过期（或没有），内容没变也要写回，刷新时间戳，否则之后每次搜索都会重新下载
    await putKv(env, key, { at: now, data });
    return data;
  } catch {
    // 拉取失败时退回旧索引，总比没有结果好
    return cached?.data;
  }
}

/** 名称里出现过查询词就算命中，短的排前面（越接近越可能是想要的） */
function score(text: string, q: string): number {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i < 0) return -1;
  return (t === q ? 200 : t.startsWith(q) ? 100 : 0) - t.length;
}

async function searchSelfhst(env: Env, q: string): Promise<LogoHit[]> {
  const index = await cachedIndex<SelfhstEntry[]>(env, 'logo-index-selfhst', SELFHST_INDEX);
  if (!index) return [];
  return index
    .map((e) => ({ e, s: Math.max(score(e.Name, q), score(e.Reference, q)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_RESULTS)
    .map(({ e }) => ({
      // PNG 最稳（部分图标没有 SVG），统一走 GitHub 原始地址
      url: `${SELFHST_BASE}/png/${e.Reference}.png`,
      thumb: `${SELFHST_BASE}/png/${e.Reference}.png`,
      source: 'selfhst' as const,
      name: e.Name,
    }));
}

async function searchDashboard(env: Env, q: string): Promise<LogoHit[]> {
  const tree = await cachedIndex<DashTree>(env, 'logo-index-dashboard', DASH_INDEX);
  if (!tree) return [];
  const files = [...(tree.png ?? [])];
  return files
    .map((f) => {
      const slug = f.replace(/\.png$/, '');
      // 跳过 light/dark 变体，基础图标够用
      return { slug, s: /-(light|dark)$/.test(slug) ? -1 : score(slug, q) };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_RESULTS)
    .map(({ slug }) => ({
      url: `${DASH_BASE}/png/${slug}.png`,
      thumb: `${DASH_BASE}/png/${slug}.png`,
      source: 'dashboard' as const,
      name: slug,
    }));
}

// ---------- 官网 ----------

/**
 * 这些站上的「logo」不是某个服务自己的图：百科、应用商店、点评站、社交平台。
 * 注意不要把 B 站、YouTube、GitHub 这类「用户会订阅的站」列进来——
 * 搜它们的名字时，它们本身就是官网。
 */
const NOT_OFFICIAL =
  /(zhihu|csdn|jianshu|v2ex|baike\.baidu|wikipedia|fandom|amazon\.|apps\.apple\.com|apps\.microsoft|play\.google|apkpure|apkmirror|wandoujia|crunchbase|linkedin|facebook|twitter|x\.com|pinterest|reddit|medium\.com|producthunt|g2\.com|capterra|trustpilot|similarweb|hostloc|nodeseek|sohu|toutiao|weibo|douban)/i;

/**
 * 页面里方向不对的图：合作方 logo 墙、轮播、头像、二维码、国旗。
 * 客户 logo 常见于 swiper/carousel 轮播里，和自家页头 logo 的 class 有明显区别。
 */
const NOT_A_LOGO =
  /(client|customer|partner|press|sponsor|avatar|qrcode|qr-code|banner|screenshot|bg-|background|swiper|carousel|slide|marquee|flagcdn|flag|hero|shape|spinner|clippy|overlay|bubble|sprite|placeholder|loading|arrow|close|search|rank|selected|addlist|badge|icon-account|icon-\d)/i;

/** 各家的页头 logo 习惯用这些 class，命中就大幅加分 */
const REAL_LOGO_CLASS = /(custom-logo|site-logo|navbar-brand|header-logo|brand-logo|main-logo|logo-img)/i;

/** 图片所在的第三方域名只当图标源：国旗、头像站这类明显不是品牌图 */
const NOT_LOGO_HOST = /(flagcdn|gravatar|ui-avatars|placehold|via\.placeholder|dummyimage)/i;

/** 域名形状的查询（wap.ac、vmiss.com）：直接当官网，不必再搜 */
const DOMAIN_Q = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i;

const IMAGE_EXT = /\.(png|svg|webp|jpe?g|ico)(\?|#|$)/i;

/** 查询词的可比对形式：只留字母数字，中文原样保留 */
function keyOf(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function decodeEntities(s: string): string {
  // &quot; 必须解：Bing 把结果 JSON 整个 HTML 转义后放进 m 属性，
  // 不解开就 JSON.parse 不了（属性名带着 &quot; 会被当成非法字符）
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/** 只读响应体的前 max 字节就停止下载，避免超大页面占满内存和流量 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
    if (at >= out.length) break;
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  try {
    // 官网地址可能来自用户输入的域名：只抓公网 https，跳转的每一跳也检查
    const res = await fetchPublic(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res?.ok) return '';
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(type)) return '';
    return new TextDecoder().decode(await readCapped(res, MAX_HTML));
  } catch {
    return '';
  }
}

/**
 * 用网页搜索找官网：Bing 把每条自然结果放在 <li class="b_algo"> 里，
 * 取首条链接的域名。域名里含查询词的排在前面（vmiss → vmiss.com），
 * 论坛测评类站点直接丢掉——那里的图不是服务自己的。
 */
async function findOfficialHosts(q: string): Promise<string[]> {
  // 「wap.ac」这种本身就是域名的查询，直接访问它，不用搜索引擎猜
  if (DOMAIN_Q.test(q.trim())) return [q.trim().toLowerCase(), `www.${q.trim().toLowerCase()}`];
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}`);
  if (!html) return [];
  const key = q.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hosts: Array<{ host: string; rank: number; order: number }> = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  blocks.forEach((block, i) => {
    const href = block.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/)?.[1];
    if (!href) return;
    let host: string;
    try {
      host = new URL(decodeEntities(href)).hostname.toLowerCase();
    } catch {
      return;
    }
    if (NOT_OFFICIAL.test(host)) return;
    const bare = host.replace(/[^a-z0-9]/g, '');
    // 域名里带查询词几乎一定是官网；纯中文查询没有可比对的字串，只信第一条
    if (key.length >= 3) {
      if (!bare.includes(key)) return;
      hosts.push({ host, rank: 100 - i, order: i });
    } else if (i === 0) {
      hosts.push({ host, rank: 50, order: i });
    }
  });
  const seen = new Set<string>();
  return hosts
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .filter((h) => (seen.has(h.host) ? false : seen.add(h.host)))
    .map((h) => h.host)
    .slice(0, 2);
}

interface Candidate {
  url: string;
  /** 越大越像我们要的图标 */
  rank: number;
  name: string;
}

/**
 * 从首页 HTML 里挑图。顺序按可靠性：apple-touch-icon → 页头里的 logo → favicon → og:image。
 * img 只收带 logo 强信号的，正文配图和轮播图因此自然被跳过。
 */
function iconsFromHtml(html: string, base: string, q: string): Candidate[] {
  const out: Candidate[] = [];
  const abs = (u: string): string | null => {
    const v = decodeEntities(u.trim());
    if (!v || v.startsWith('data:')) return null;
    try {
      const full = new URL(v, base).toString();
      if (!isPublicHttpsUrl(full)) return null;
      return NOT_LOGO_HOST.test(new URL(full).hostname) ? null : full;
    } catch {
      return null;
    }
  };

  // 1) apple-touch-icon：手机主屏图标，通常是干净的方形 logo，尺寸也够（180 上下）。
  //    同一站点常声明多个尺寸，只取最大的那张
  let touch: { url: string; size: number } | null = null;
  for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
    if (!/rel=["']?apple-touch-icon/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)/)?.[1];
    const url = href && abs(href);
    if (!url) continue;
    const size = Number(tag.match(/sizes=["'](\d+)/)?.[1] ?? 180);
    if (!touch || size > touch.size) touch = { url, size };
  }
  if (touch) out.push({ url: touch.url, rank: 300, name: q });

  // 2) 页面里的 img。只在有强信号时收：class 带 logo/brand 一类，或文件名/alt 里写着 logo。
  //    各家页头 logo 的写法高度一致，靠这一条就能跳过正文配图、客户 logo 墙和轮播图。
  //    位置只用来排序，不限制区域：有些站把 logo 放在 <header> 之前。
  const key = keyOf(q);
  const at = (tag: string) => html.indexOf(tag, 0);
  for (const tag of html.match(/<img[^>]+>/gi) ?? []) {
    const src = tag.match(/\ssrc=["']([^"']+)/)?.[1];
    const url = src && abs(src);
    if (!url || !IMAGE_EXT.test(url)) continue;
    const alt = decodeEntities(tag.match(/alt=["']([^"']*)/)?.[1] ?? '');
    const cls = tag.match(/class=["']([^"']*)/)?.[1] ?? '';
    const text = `${url} ${alt} ${cls}`;
    if (NOT_A_LOGO.test(text)) continue;
    const isLogoClass = REAL_LOGO_CLASS.test(cls);
    // 文件名里写着 logo 才算；alt 里出现 brand 的常是「Brand Vision」这类宣传图，不作数
    const saysLogo = /logo/i.test(new URL(url).pathname) || /logo/i.test(alt);
    if (!isLogoClass && !saysLogo) continue;
    // 客户 logo 墙：文件名/alt 里的品牌名不是本次查询的那家（如 Notion 首页上的
    // 「Ramp_Business_Corporation_Logo_1.svg」）。自家 logo 要么就叫 logo.svg，要么带自家名字。
    const stem = (new URL(url).pathname.split('/').pop() ?? '').replace(/[-_.]/g, ' ');
    const named = `${alt} ${stem}`;
    const mentionsQuery = key.length >= 2 && new RegExp(key, 'i').test(named);
    const genericLogo = /^logo([-_.\d]|$)/i.test(stem.trim()) || /^(logo|brand|icon|home|首页)$/i.test(alt.trim());
    if (/logo/i.test(named) && !mentionsQuery && !genericLogo) continue;
    // 声明尺寸很扁的是横条（客户 logo 墙常见 96x24），不是能单独用的图标
    const dw = Number(tag.match(/width=["'](\d+)/)?.[1] ?? 0);
    const dh = Number(tag.match(/height=["'](\d+)/)?.[1] ?? 0);
    if (dw && dh && dh < 32) continue;
    let rank = 0;
    if (isLogoClass) rank += 150;
    if (saysLogo) rank += 60;
    if (/\/logo[.-]/i.test(url)) rank += 30;
    if (alt) rank += 10;
    // 越靠前越可能是页头
    const pos = at(tag);
    if (pos >= 0 && pos < html.length * 0.35) rank += 25;
    if (key.length >= 3 && new RegExp(key, 'i').test(`${alt} ${cls}`)) rank += 30;
    // 太扁的多是横幅；页头 logo 常见 3:1 以内
    if (dw && dh && dw / dh > 5) rank -= 60;
    out.push({ url, rank, name: alt || q });
  }

  // 3) favicon.ico：页头用的纯文字品牌（如 WHMCS 模板）没有 logo 图，只有站点小图标
  if (out.every((c) => c.rank < 60)) {
    for (const rel of ['/favicon.ico', '/favicon.png']) {
      const url = abs(rel);
      if (url) out.push({ url, rank: 60, name: q });
    }
  }

  // 4) og:image：常是整张宣传图，只在前面都没找到时才用
  if (out.length === 0) {
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i)?.[0];
    const ogUrl = og && abs(og.match(/content=["']([^"']+)/)?.[1] ?? '');
    if (ogUrl) out.push({ url: ogUrl, rank: 40, name: q });
  }

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.url) ? false : seen.add(c.url))).sort((a, b) => b.rank - a.rank);
}

/**
 * 读图片头拿到真实尺寸：文件名和 alt 都能骗人，能骗人的还有 hero 大图和装饰性 svg。
 * 只看前 2KB，PNG/WebP/JPEG/GIF 的尺寸都写在开头；拿不到就返回 null（不因此淘汰）。
 */
async function probeSize(url: string): Promise<{ w: number; h: number } | null> {
  try {
    const res = await fetchPublic(url, { headers: { 'user-agent': UA, range: 'bytes=0-2047' } });
    if (!res?.ok) return null;
    // 服务器不一定认 Range，所以自己只读前 2KB
    const buf = await readCapped(res, 2048);
    const dv = new DataView(buf.buffer);
    // PNG：IHDR 里的宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length >= 24) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    // WebP（VP8X / VP8 / VP8L）
    if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58)
        return { w: (dv.getUint16(24, true) & 0x3fff) + 1, h: (dv.getUint16(27, true) & 0x3fff) + 1 };
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20)
        return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
    // JPEG：扫 SOF 段
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        i += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 图标要够大、别太扁：小于 48px 的没法和文字并排，长宽比超过 3 的多是横幅 */
function fitsIcon(size: { w: number; h: number } | null, ext: string): boolean {
  if (ext === 'svg') return true; // 矢量图没有固定尺寸，交给前端按框缩放
  if (!size) return true; // 拿不到尺寸就不淘汰
  const max = Math.max(size.w, size.h);
  const min = Math.min(size.w, size.h);
  if (max < 48) return false;
  return max / min <= 3;
}

/**
 * 官网图：先搜官网域名，再读首页 HTML 抓图标。
 * 首页体积不可控，只读前 600KB；任一环节失败都当没找到，前端照常显示其他来源。
 */
async function searchOfficialSite(q: string): Promise<LogoHit[]> {
  const hosts = await findOfficialHosts(q);
  if (!hosts.length) return [];
  const pages = await Promise.all(
    hosts.map(async (host) => {
      const base = `https://${host}/`;
      const html = await fetchText(base);
      return html ? iconsFromHtml(html, base, q) : [];
    }),
  );
  // 候选合并后再探尺寸：每页最多 6 张，跨两页共 12 张，并发读图片头代价可接受
  const cands: Array<{ url: string; name: string }> = [];
  const seen = new Set<string>();
  for (const [i, list] of pages.entries()) {
    for (const c of list.slice(0, 6)) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      cands.push({ url: c.url, name: c.name || hosts[i] });
      if (cands.length >= 12) break;
    }
    if (cands.length >= 12) break;
  }
  const sized = await Promise.all(
    cands.map(async (c) => {
      const ext = (new URL(c.url).pathname.split('.').pop() ?? '').toLowerCase();
      const size = await probeSize(c.url);
      return { c, size, ok: fitsIcon(size, ext) };
    }),
  );
  return sized
    .filter((x) => x.ok)
    .slice(0, 8)
    .map(({ c, size }) => ({
      url: c.url,
      thumb: c.url,
      source: 'site' as const,
      name: c.name,
      ...(size ? { width: size.w, height: size.h } : {}),
    }));
}

// ---------- 搜索引擎图片兜底 ----------

/**
 * Bing 图片搜索：解析结果页里每张图的 murl（原图）、turl（缩略图）和标题。
 * 比 DuckDuckGo 稳：DDG 的 i.js 会返回反爬挑战，纯 fetch 拿不到结果。
 * 页面改版就失效，失败一律返回空数组。
 */
/**
 * 图片搜索的候选：Bing 一条结果全在 <a class="iusc"> 里 —— m 属性是 JSON
 * （原图 murl、缩略图 turl、标题 t），href 里带原图尺寸 expw/exph。
 */
function parseBingImages(html: string, q: string): LogoHit[] {
  const hits: Array<LogoHit & { rank: number }> = [];
  const seen = new Set<string>();
  // 按 <a 切块再判断，不用标签正则：m 属性里的 JSON 含 >，宽松正则会吞掉别的元素
  for (const chunk of html.split(/<a\s/).slice(1)) {
    const tag = chunk.slice(0, 3000);
    if (!/class="iusc"/.test(tag)) continue;
    const meta = tag.match(/\sm="([^"]+)"/)?.[1];
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!meta || !href) continue;

    let data: { murl?: string; turl?: string; t?: string };
    try {
      data = JSON.parse(decodeEntities(meta));
    } catch {
      continue;
    }
    const image = data.murl ?? '';
    const turl = data.turl ?? '';
    const title = data.t ?? '';
    if (!image.startsWith('https://') || seen.has(image)) continue;
    if (!IMAGE_EXT.test(image)) continue;
    // 测评、教程、下载站上的图不是图标本身
    if (/测评|教程|优惠码|购买|怎么样|官网入口|攻略|百科|下载站/i.test(title)) continue;

    const link = decodeEntities(href);
    const w = Number(link.match(/expw=(\d+)/)?.[1] ?? 0);
    const h = Number(link.match(/exph=(\d+)/)?.[1] ?? 0);
    if (w && h) {
      const max = Math.max(w, h);
      const min = Math.min(w, h);
      // 太小放大就糊；太大的多是海报和整屏截图。图标并排显示，1024 已经够用
      if (max < 64 || max > 1024) continue;
      if (max / min > 3) continue; // 太扁，是横幅
    }
    seen.add(image);

    const file = image.split('/').pop() ?? '';
    let rank = 0;
    if (/logo|icon/i.test(file)) rank += 10;
    if (/\.svg$/i.test(image)) rank += 5;
    // 越接近方形越像图标
    if (w && h && Math.abs(w - h) / Math.max(w, h) < 0.15) rank += 5;

    // 缩略图交给 Bing 自己的缩放服务（同一张图可按需出任意尺寸），
    // 面板只拉小图：原图上千像素，还可能超过 /api/img 的 1MB 上限
    const thumb = turl ? `${turl}&w=256&h=256&c=7` : image;
    hits.push({ url: image, thumb, source: 'web', name: title.slice(0, 60) || q, rank, ...(w && h ? { width: w, height: h } : {}) });
  }
  return hits.sort((a, b) => b.rank - a.rank);
}

/**
 * 图片搜索：先要透明背景的（最像图标），结果不够再退回全部。
 * 透明滤镜会顺带把一大批结果标成非图片文件，光用它反而让候选变得很少。
 */
async function searchWebImages(q: string): Promise<LogoHit[]> {
  const fetchPage = async (transparent: boolean): Promise<LogoHit[]> => {
    try {
      const qft = transparent ? `&qft=${encodeURIComponent('+filterui:photo-transparent')}` : '';
      const url = `https://www.bing.com/images/search?q=${encodeURIComponent(`${q} logo`)}&form=HDRSC2&first=1${qft}`;
      const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
      if (!res.ok) return [];
      return parseBingImages(await res.text(), q);
    } catch {
      return [];
    }
  };
  const transparent = await fetchPage(true);
  if (transparent.length >= 6) return transparent.slice(0, MAX_RESULTS);
  const all = await fetchPage(false);
  // 透明背景的排前面，其余按相关度接在后面
  const seen = new Set(transparent.map((h) => h.url));
  return [...transparent, ...all.filter((h) => !seen.has(h.url))].slice(0, MAX_RESULTS);
}

/** 四路并行查询，任一来源失败不影响其他来源；官网结果排在最前，最可能是本人想要的那张 */
export async function searchLogos(env: Env, query: string): Promise<LogoHit[]> {
  const q = query.trim().slice(0, 60);
  if (q.length < 2) return [];
  const lower = q.toLowerCase();
  const [site, selfhst, dashboard, web] = await Promise.all([
    searchOfficialSite(q).catch(() => []),
    searchSelfhst(env, lower).catch(() => []),
    searchDashboard(env, lower).catch(() => []),
    searchWebImages(q).catch(() => []),
  ]);
  return [...site, ...selfhst, ...dashboard, ...web];
}

/**
 * 版本号比较与「检查更新」的纯逻辑：不碰浏览器和网络，浏览器端的请求与缓存在 app/src/update-check.ts。
 */

/** 发布仓库：最新稳定版取它的 releases/latest（GitHub 已排除 prerelease 和 draft） */
export const RELEASE_REPO = 'imetn/calends';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
/** 全部版本列表：跨了几个版本升级时，中间版本的说明只能去这里看 */
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`;
/** 每台设备自动检查的最短间隔：一天可能发几个版本，按天查会让「已是最新」和更新红点过时（issue #21） */
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
/** 打开设置页时，上次检查早于这个间隔就再查一次，版本行不显示过时的「已是最新」 */
export const SETTINGS_CHECK_INTERVAL = 5 * 60 * 1000;

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

/** 更新内容摘录的一块：小标题、段落或列表项，都是纯文本 */
export interface ReleaseNote {
  kind: 'h' | 'p' | 'li';
  text: string;
}

export interface ReleaseInfo {
  version: string;
  url: string;
  /** release 正文的摘录；没有正文、或是旧版本存下的缓存时没有这一项 */
  notes?: ReleaseNote[];
}

/** 摘录最多保留的段落和列表项（小标题不计） */
export const RELEASE_NOTES_MAX = 8;
const NOTE_TEXT_MAX = 300;
const NOTES_STORED_MAX = 40;
/** 只有命令、校验值、附件的小节：对决定升不升级没帮助 */
const SKIP_SECTION = /^(images?|docker( images?)?|assets|checksums?|镜像)\b/i;
/** 升级注意事项（迁移、不兼容改动）优先保留，不被前面的条目挤掉 */
const PIN_SECTION = /upgrad|breaking|migrat|升级|迁移/i;

/** 行内 Markdown 去掉标记只留文字：图片、链接地址、HTML 标签、强调和代码记号都不保留 */
function plainInline(s: string): string {
  const text = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*([^*\s][^*]*?)\*/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > NOTE_TEXT_MAX ? `${text.slice(0, NOTE_TEXT_MAX - 1).trimEnd()}…` : text;
}

/**
 * 把 release 正文（Markdown）摘成几句纯文本：去掉代码块、表格和镜像等小节，
 * 升级注意事项优先，其余按原顺序取到 max 条为止；没有小标题时就是前 max 条。
 */
export function releaseNotes(body: string, max = RELEASE_NOTES_MAX): ReleaseNote[] {
  interface Section {
    heading?: string;
    items: string[];
    kinds: Array<'p' | 'li'>;
  }
  const sections: Section[] = [{ items: [], kinds: [] }];
  let cur = sections[0];
  let para: string[] = [];
  let inList = false;
  let fence: string | null = null;
  const flush = () => {
    if (para.length) {
      cur.items.push(para.join(' '));
      cur.kinds.push('p');
    }
    para = [];
  };
  const src = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of src.split('\n')) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      flush();
      inList = false;
      fence = fenceMark;
      continue;
    }
    const line = raw.replace(/^\s*>\s?/, '');
    if (!line.trim()) {
      flush();
      inList = false;
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      inList = false;
      cur = { heading: plainInline(heading[1]), items: [], kinds: [] };
      sections.push(cur);
      continue;
    }
    // 分隔线、表格不进摘录
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|/.test(line)) {
      flush();
      inList = false;
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      cur.items.push(item[1]);
      cur.kinds.push('li');
      inList = true;
      continue;
    }
    // 列表项的续行接到上一项
    if (inList && /^\s+\S/.test(line)) cur.items[cur.items.length - 1] += ` ${line.trim()}`;
    else {
      inList = false;
      para.push(line.trim());
    }
  }
  flush();

  const kept = sections.filter((s) => !(s.heading && SKIP_SECTION.test(s.heading))).map((s) => ({ ...s, texts: s.items.map(plainInline) }));
  // 先给升级注意事项留位置，再按原顺序填满
  const picked = new Set<string>();
  const take = (filter: (s: (typeof kept)[number]) => boolean) => {
    kept.forEach((s, si) =>
      s.texts.forEach((text, ii) => {
        if (picked.size < max && text && filter(s)) picked.add(`${si}:${ii}`);
      }),
    );
  };
  take((s) => !!s.heading && PIN_SECTION.test(s.heading));
  take(() => true);

  const out: ReleaseNote[] = [];
  kept.forEach((s, si) => {
    const rows = s.texts.flatMap((text, ii) => (picked.has(`${si}:${ii}`) ? [{ kind: s.kinds[ii], text }] : []));
    if (!rows.length) return;
    if (s.heading) out.push({ kind: 'h', text: s.heading });
    out.push(...rows);
  });
  return out;
}

/** 缓存读回的摘录：形状不对、超长就整段不要，不影响版本信息 */
function parseNotes(raw: unknown): ReleaseNote[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > NOTES_STORED_MAX) return undefined;
  const ok = raw.every(
    (n) =>
      n &&
      typeof n === 'object' &&
      ['h', 'p', 'li'].includes((n as ReleaseNote).kind) &&
      typeof (n as ReleaseNote).text === 'string' &&
      (n as ReleaseNote).text.length <= NOTE_TEXT_MAX,
  );
  return ok ? raw.map((n: ReleaseNote) => ({ kind: n.kind, text: n.text })) : undefined;
}

/** 从 GitHub releases/latest 的响应里取版本、发布页和正文摘录；草稿、预发布、非语义化标签或别处的链接一律不认 */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; body?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  const v = parseVersion(r.tag_name);
  if (!v || v.pre.length) return null;
  if (!r.html_url.startsWith(`https://github.com/${RELEASE_REPO}/releases/`)) return null;
  const info: ReleaseInfo = { version: plainVersion(r.tag_name).replace(/\+.*$/, ''), url: r.html_url };
  const notes = typeof r.body === 'string' ? releaseNotes(r.body) : [];
  if (notes.length) info.notes = notes;
  return info;
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
    const latest = j.latest as { version?: unknown; url?: unknown; notes?: unknown } | undefined;
    const ok = latest && typeof latest.version === 'string' && typeof latest.url === 'string' && parseVersion(latest.version);
    if (!ok) return { checkedAt: j.checkedAt, latest: undefined };
    const info: ReleaseInfo = { version: latest.version as string, url: latest.url as string };
    const notes = parseNotes(latest.notes);
    if (notes) info.notes = notes;
    return { checkedAt: j.checkedAt, latest: info };
  } catch {
    return null;
  }
}

/** 自动检查是否到期：从没查过、已满间隔，或记录的时间在未来（设备时钟被调过）时到期 */
export function autoCheckDue(cache: UpdateCache | null, now: number, interval = UPDATE_CHECK_INTERVAL, current?: string): boolean {
  if (!cache) return true;
  // 刚升级过：缓存里的「最新版」比正在运行的还旧，多半是升级前查的，按设置页的短间隔重查；
  // 不直接放行，GitHub 的 latest 落后于运行版本（先部署后建 Release、自改版本号）时会每次都请求、耗尽限额
  if (current && cache.latest && isNewer(current, cache.latest.version)) interval = Math.min(interval, SETTINGS_CHECK_INTERVAL);
  return now - cache.checkedAt >= interval || cache.checkedAt > now;
}

/** 一次检查后的新缓存：失败只记尝试时间，保留上次读到的版本 */
export function nextUpdateCache(prev: UpdateCache | null, now: number, latest: ReleaseInfo | null): UpdateCache {
  return { checkedAt: now, latest: latest ?? prev?.latest };
}

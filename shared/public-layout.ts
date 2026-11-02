// 公开页的组件布局：组件白名单、12 栏网格上的摆放规则、可见性。浏览器、Worker 和脱敏共用
import type { PublicPageConfig, PublicSectionConfig } from './types.ts';

export const PUBLIC_TITLE_MAX = 100;
export const PUBLIC_BIO_MAX = 200;
export const PUBLIC_COLUMNS = 12;

export const PUBLIC_MAX_ROW = 1000;
export const PUBLIC_MAX_HEIGHT = 200;

/** 网格里的组件：默认位置等于现有公开页的排列，高度取小值让内容撑开；min 是内容不被挤坏的最小栏数 */
export const PUBLIC_GRID_SECTIONS = [
  { id: 'hero', x: 0, y: 0, w: 12, h: 6, min: 8 },
  { id: 'composition', x: 0, y: 6, w: 6, h: 6, min: 4 },
  { id: 'fx', x: 6, y: 6, w: 6, h: 6, min: 5 },
  { id: 'list', x: 0, y: 12, w: 12, h: 6, min: 6 },
  { id: 'ended', x: 0, y: 18, w: 6, h: 6, min: 5 },
  { id: 'lifetime', x: 6, y: 18, w: 6, h: 6, min: 4 },
] as const;
/** 固定在页面底部的组件：只能隐藏，不参与摆放 */
export const PUBLIC_BOTTOM_SECTIONS = ['footer', 'pile'] as const;
/** 主卡的三部分：可分别隐藏，全部隐藏时主卡不显示 */
export const PUBLIC_HERO_PARTS = ['stats', 'timeline', 'chart'] as const;

export type PublicGridId = (typeof PUBLIC_GRID_SECTIONS)[number]['id'];
export type PublicBottomId = (typeof PUBLIC_BOTTOM_SECTIONS)[number];
export type PublicHeroPart = (typeof PUBLIC_HERO_PARTS)[number];
/** 决定下发哪些数据的最小单位：主卡按三部分算，其余按组件算 */
export type PublicPart = Exclude<PublicGridId, 'hero'> | PublicBottomId | PublicHeroPart;

export interface PublicRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PublicGridItem extends PublicRect {
  id: PublicGridId;
  min: number;
  hidden: boolean;
}

const gridDef = (id: string) => PUBLIC_GRID_SECTIONS.find((s) => s.id === id);
const isBottom = (id: string): id is PublicBottomId => (PUBLIC_BOTTOM_SECTIONS as readonly string[]).includes(id);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const hasRect = (s?: PublicSectionConfig): s is PublicSectionConfig & PublicRect => !!s && [s.x, s.y, s.w, s.h].every((v) => typeof v === 'number' && Number.isFinite(v));
const overlaps = (a: PublicRect, b: PublicRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byPosition = (a: PublicRect, b: PublicRect) => a.y - b.y || a.x - b.x;

/** 没摆放过的页面：按组件顺序排，每行补满，和访客看到的流式排列一致 */
function flowRects(items: PublicGridItem[]): PublicGridItem[] {
  const spans = fillRows(items.filter((s) => !s.hidden).map((s) => s.w));
  let i = 0;
  let x = 0;
  let y = 0;
  return items.map((s) => {
    if (s.hidden) return s;
    const w = spans[i++];
    const out = { ...s, x, y, w };
    x += w;
    if (x >= PUBLIC_COLUMNS) {
      x = 0;
      y += s.h;
    }
    return out;
  });
}

/** 从上往下摆：压到前面已摆好的卡片就推到它下面；fixed 放在最前面，位置不动 */
function settle(items: PublicGridItem[], fixed?: PublicGridItem): PublicGridItem[] {
  const done: PublicGridItem[] = fixed && !fixed.hidden ? [fixed] : [];
  for (const item of items.filter((s) => !s.hidden && s.id !== fixed?.id).sort(byPosition)) {
    let y = item.y;
    for (let hit = done.find((d) => overlaps(d, { ...item, y })); hit; hit = done.find((d) => overlaps(d, { ...item, y }))) y = hit.y + hit.h;
    done.push({ ...item, y });
  }
  const hidden = items.filter((s) => s.hidden).map((s) => (s.id === fixed?.id ? fixed : s));
  return [...done.sort(byPosition), ...hidden];
}

const fitRect = (def: { min: number }, r: PublicRect): PublicRect => {
  const w = clamp(r.w, def.min, PUBLIC_COLUMNS);
  return { x: clamp(r.x, 0, PUBLIC_COLUMNS - w), y: clamp(r.y, 0, PUBLIC_MAX_ROW), w, h: clamp(r.h, 1, PUBLIC_MAX_HEIGHT) };
};

/** 主人是否摆放过：没摆过的页面按原有的流式排列显示 */
export const isCustomLayout = (cfg?: PublicPageConfig) => !!cfg?.sections?.some((s) => gridDef(s.id) && hasRect(s));

/** 存下来的配置摊开成完整列表：不认识的 id 忽略，配置里没有的组件（以后新增的）放到最下面，互相压住的往下推 */
export function publicGrid(cfg?: PublicPageConfig): PublicGridItem[] {
  const saved = new Map<string, PublicSectionConfig>();
  for (const s of cfg?.sections ?? []) if (!saved.has(s.id)) saved.set(s.id, s);
  const custom = isCustomLayout(cfg);
  const items: PublicGridItem[] = [];
  const missing: PublicGridItem[] = [];
  for (const def of PUBLIC_GRID_SECTIONS) {
    const s = saved.get(def.id);
    const hidden = !!s?.hidden;
    if (hasRect(s)) items.push({ id: def.id, min: def.min, hidden, ...fitRect(def, s) });
    else (custom && !hidden ? missing : items).push({ id: def.id, x: def.x, y: def.y, w: def.w, h: def.h, min: def.min, hidden });
  }
  let bottom = publicGridBottom(items);
  for (const item of missing) {
    items.push({ ...item, x: 0, y: bottom });
    bottom += item.h;
  }
  return settle(custom ? items : flowRects(items));
}

const flowSections = (items: PublicGridItem[]): PublicSectionConfig[] => items.filter((s) => s.hidden).map((s) => ({ id: s.id, hidden: true }));
/** 主人只隐藏过组件、没动过位置：这种网格不存几何，页面继续按流式排列 */
export const isFlowGrid = (items: PublicGridItem[]) => JSON.stringify(items) === JSON.stringify(publicGrid({ sections: flowSections(items) }));
/** 网格转成要存的字段：没动过位置时只存隐藏了哪些 */
export const gridConfig = (items: PublicGridItem[]): PublicSectionConfig[] => (isFlowGrid(items) ? flowSections(items) : gridSections(items));

/** 最下面一张可见卡片的下边缘 */
export const publicGridBottom = (items: PublicGridItem[]) => items.reduce((max, s) => (s.hidden ? max : Math.max(max, s.y + s.h)), 0);

/** 把一张卡放到新位置：位置不合规的夹回范围内，被压到的卡片往下推，其余不动 */
export function placeItem(items: PublicGridItem[], id: string, rect: PublicRect): PublicGridItem[] {
  const item = items.find((s) => s.id === id);
  return item ? settle(items, { ...item, ...fitRect(item, rect) }) : items;
}

/** 重新添加：没摆放过的页面回到原位，摆放过的放回页面最下面 */
export function showItem(items: PublicGridItem[], id: string): PublicGridItem[] {
  const item = items.find((s) => s.id === id);
  if (item && isFlowGrid(items)) return publicGrid({ sections: flowSections(items.map((s) => (s.id === id ? { ...s, hidden: false } : s))) });
  return item ? placeItem(items.map((s) => (s.id === id ? { ...s, hidden: false } : s)), id, { ...item, x: 0, y: publicGridBottom(items) }) : items;
}

/** 移除：没摆放过的页面重新补满；摆放过的只收起它独占的整行，其余不动 */
export function hideItem(items: PublicGridItem[], id: string): PublicGridItem[] {
  const next = items.map((s) => (s.id === id ? { ...s, hidden: true } : s));
  if (isFlowGrid(items)) return publicGrid({ sections: flowSections(next) });
  const kept = collapseEmpty(items, (x) => x === id);
  return publicGrid({ sections: gridSections([...kept, ...next.filter((s) => s.hidden)]) });
}

/** 高度补到内容需要的行数。原来同一排同样高的卡片一起变，并排的两张不会变成一高一矮 */
export function fitHeights(items: PublicGridItem[], need: Record<string, number>): PublicGridItem[] {
  const shown = items.filter((s) => !s.hidden);
  return settle(items.map((s) => (s.hidden ? s : { ...s, h: Math.max(s.h, ...shown.filter((o) => o.y === s.y && o.h === s.h).map((o) => Math.min(need[o.id] ?? 0, PUBLIC_MAX_HEIGHT))) })));
}

/** 去掉没有内容的卡片（没有退订、没有买断），只有它们占着的整行一起收起 */
export function collapseEmpty(items: PublicGridItem[], isEmpty: (id: PublicGridId) => boolean): PublicGridItem[] {
  const shown = items.filter((s) => !s.hidden);
  const kept = shown.filter((s) => !isEmpty(s.id));
  const freed = new Set<number>();
  for (const s of shown) if (isEmpty(s.id)) for (let row = s.y; row < s.y + s.h; row++) if (!kept.some((k) => row >= k.y && row < k.y + k.h)) freed.add(row);
  return kept.map((s) => ({ ...s, y: s.y - [...freed].filter((row) => row < s.y).length }));
}

/** 网格转成要存的字段 */
export const gridSections = (items: PublicGridItem[]): PublicSectionConfig[] => items.map(({ id, x, y, w, h, hidden }) => ({ id, x, y, w, h, ...(hidden ? { hidden: true } : {}) }));

export const publicBottomShown = (cfg: PublicPageConfig | undefined, id: PublicBottomId) => !cfg?.sections?.some((s) => s.id === id && s.hidden);
export const publicHeroShown = (cfg: PublicPageConfig | undefined, part: PublicHeroPart) => cfg?.heroParts?.[part] !== false;

/** 实际可见的部分。缺省配置时全部可见 */
export function publicParts(cfg?: PublicPageConfig): Set<PublicPart> {
  const out = new Set<PublicPart>();
  for (const s of publicGrid(cfg)) {
    if (s.hidden) continue;
    if (s.id === 'hero') {
      for (const part of PUBLIC_HERO_PARTS) if (publicHeroShown(cfg, part)) out.add(part);
    } else out.add(s.id);
  }
  for (const id of PUBLIC_BOTTOM_SECTIONS) if (publicBottomShown(cfg, id)) out.add(id);
  return out;
}

/** 没摆放过的页面：每行最后一张卡补满剩余栏数：不留空洞，组件因没有数据而不显示时也不露缺口 */
export function fillRows(spans: number[]): number[] {
  const out = [...spans];
  let used = 0;
  for (let i = 0; i < out.length; i++) {
    if (used + out[i] > PUBLIC_COLUMNS) {
      out[i - 1] += PUBLIC_COLUMNS - used;
      used = 0;
    }
    used += out[i];
    if (used === PUBLIC_COLUMNS) used = 0;
  }
  if (used && out.length) out[out.length - 1] += PUBLIC_COLUMNS - used;
  return out;
}

/** 流式页面实际要显示的卡片（没数据的已去掉）各占几栏：按组件的默认宽度重新补满，网格里的宽度是没去掉时算的 */
export const flowSpans = (ids: PublicGridId[]) => fillRows(ids.map((id) => gridDef(id)!.w));

/** 平板只分半宽和全宽 */
export const tabletSpan = (span: number) => (span <= 6 ? 6 : PUBLIC_COLUMNS);

const AVATAR = /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/;
export const validPublicAvatar = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 300000 && AVATAR.test(v));

/** 校验要存的配置：只放行白名单内的字段，非法值返回 false */
export function validPublicPage(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  if (Object.keys(c).some((k) => !['browserTitle', 'bio', 'avatar', 'sections', 'heroParts'].includes(k))) return false;
  const text = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);
  if (!text(c.browserTitle, PUBLIC_TITLE_MAX) || !text(c.bio, PUBLIC_BIO_MAX)) return false;
  if (!validPublicAvatar(c.avatar)) return false;
  if (c.heroParts !== undefined) {
    if (!c.heroParts || typeof c.heroParts !== 'object' || Array.isArray(c.heroParts)) return false;
    for (const [k, v] of Object.entries(c.heroParts)) if (!(PUBLIC_HERO_PARTS as readonly string[]).includes(k) || typeof v !== 'boolean') return false;
  }
  if (c.sections !== undefined) {
    if (!Array.isArray(c.sections)) return false;
    const seen = new Set<string>();
    for (const raw of c.sections as PublicSectionConfig[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) return false;
      seen.add(raw.id);
      if (Object.keys(raw).some((k) => !['id', 'hidden', 'x', 'y', 'w', 'h'].includes(k))) return false;
      if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') return false;
      const def = gridDef(raw.id);
      if (!def && !isBottom(raw.id)) return false;
      const rect = [raw.x, raw.y, raw.w, raw.h];
      if (rect.every((v) => v === undefined)) continue;
      if (!def || !rect.every(Number.isInteger)) return false;
      const { x, y, w, h } = raw as PublicRect;
      if (x < 0 || w < def.min || x + w > PUBLIC_COLUMNS || y < 0 || y > PUBLIC_MAX_ROW + PUBLIC_GRID_SECTIONS.length * PUBLIC_MAX_HEIGHT || h < 1 || h > PUBLIC_MAX_HEIGHT) return false;
    }
  }
  return true;
}

/** 下发给访客的配置：只留页面需要的字段（头像已合并到 settings.avatar，不重复下发） */
export function publicConfigForVisitors(cfg?: PublicPageConfig): PublicPageConfig | undefined {
  if (!cfg) return undefined;
  const items = publicGrid(cfg);
  const grid = isCustomLayout(cfg) ? gridSections(items) : items.filter((s) => s.hidden).map((s) => ({ id: s.id as string, hidden: true }));
  const bottom = PUBLIC_BOTTOM_SECTIONS.filter((id) => !publicBottomShown(cfg, id)).map((id) => ({ id: id as string, hidden: true }));
  return {
    browserTitle: cfg.browserTitle?.trim() || undefined,
    bio: cfg.bio?.trim() || undefined,
    sections: [...grid, ...bottom],
    heroParts: cfg.heroParts && { ...cfg.heroParts },
  };
}

/** 编辑页和 iframe 预览之间的消息；只在同源父子窗口间传，内容都已脱敏 */
export const PUBLIC_PREVIEW_READY = 'calends:public-preview-ready';
export const PUBLIC_PREVIEW_DATA = 'calends:public-preview-data';
export const PUBLIC_PREVIEW_DRAFT = 'calends:public-preview-draft';
/** 画布（iframe）发回编辑页：摆放结果，或要隐藏的组件 */
export const PUBLIC_PREVIEW_LAYOUT = 'calends:public-preview-layout';

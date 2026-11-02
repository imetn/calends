// 公开页的组件布局：组件白名单、12 栏规则、可见性。浏览器、Worker 和脱敏共用
import type { PublicPageConfig, PublicSectionConfig } from './types.ts';

export const PUBLIC_TITLE_MAX = 100;
export const PUBLIC_BIO_MAX = 200;
export const PUBLIC_COLUMNS = 12;

/** 网格里的组件：默认顺序就是现有公开页的顺序；min 是内容不被挤坏的最小栏数 */
export const PUBLIC_GRID_SECTIONS = [
  { id: 'hero', span: 12, min: 8 },
  { id: 'composition', span: 6, min: 4 },
  { id: 'fx', span: 6, min: 5 },
  { id: 'list', span: 12, min: 6 },
  { id: 'ended', span: 6, min: 5 },
  { id: 'lifetime', span: 6, min: 4 },
] as const;
/** 固定在页面底部的组件：只能隐藏，不参与排序和分栏 */
export const PUBLIC_BOTTOM_SECTIONS = ['footer', 'pile'] as const;
/** 主卡的三部分：可分别隐藏，全部隐藏时主卡不显示 */
export const PUBLIC_HERO_PARTS = ['stats', 'timeline', 'chart'] as const;

export type PublicGridId = (typeof PUBLIC_GRID_SECTIONS)[number]['id'];
export type PublicBottomId = (typeof PUBLIC_BOTTOM_SECTIONS)[number];
export type PublicHeroPart = (typeof PUBLIC_HERO_PARTS)[number];
/** 决定下发哪些数据的最小单位：主卡按三部分算，其余按组件算 */
export type PublicPart = Exclude<PublicGridId, 'hero'> | PublicBottomId | PublicHeroPart;

export interface PublicGridItem {
  id: PublicGridId;
  span: number;
  min: number;
  hidden: boolean;
}

const gridDef = (id: string) => PUBLIC_GRID_SECTIONS.find((s) => s.id === id);
const isBottom = (id: string): id is PublicBottomId => (PUBLIC_BOTTOM_SECTIONS as readonly string[]).includes(id);

/** 存下来的配置摊开成完整列表：不认识的 id 忽略，配置里没有的组件（以后新增的）回到默认位置，栏数夹到允许范围 */
export function publicGrid(cfg?: PublicPageConfig): PublicGridItem[] {
  const saved = new Map((cfg?.sections ?? []).map((s) => [s.id, s]));
  const known = (cfg?.sections ?? []).filter((s, i, all) => gridDef(s.id) && all.findIndex((x) => x.id === s.id) === i).map((s) => s.id);
  const rest = PUBLIC_GRID_SECTIONS.filter((d) => !known.includes(d.id)).map((d) => d.id as string);
  const placed = [...known];
  // 新组件插回它在默认顺序里前一个组件的后面；已存顺序保持不变
  for (const id of rest) {
    const order = PUBLIC_GRID_SECTIONS.map((d) => d.id as string);
    const before = order.slice(0, order.indexOf(id)).reverse().find((x) => placed.includes(x));
    placed.splice(before ? placed.indexOf(before) + 1 : 0, 0, id);
  }
  return placed.map((id) => {
    const def = gridDef(id)!;
    const s = saved.get(id);
    const span = typeof s?.span === 'number' && Number.isFinite(s.span) ? Math.min(PUBLIC_COLUMNS, Math.max(def.min, Math.round(s.span))) : def.span;
    return { id: def.id, span, min: def.min, hidden: !!s?.hidden };
  });
}

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

/** 每行最后一张卡补满剩余栏数：不留空洞，组件因没有数据而不显示时也不露缺口 */
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
      if (Object.keys(raw).some((k) => !['id', 'hidden', 'span'].includes(k))) return false;
      if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') return false;
      const def = gridDef(raw.id);
      if (!def && !isBottom(raw.id)) return false;
      if (raw.span !== undefined && (!def || !Number.isInteger(raw.span) || raw.span < def.min || raw.span > PUBLIC_COLUMNS)) return false;
    }
  }
  return true;
}

/** 下发给访客的配置：只留页面需要的字段（头像已合并到 settings.avatar，不重复下发） */
export function publicConfigForVisitors(cfg?: PublicPageConfig): PublicPageConfig | undefined {
  if (!cfg) return undefined;
  const grid = publicGrid(cfg).map((s) => ({ id: s.id as string, span: s.span, ...(s.hidden ? { hidden: true } : {}) }));
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

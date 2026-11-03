// 公开页的组件布局：组件白名单、12 栏网格上的摆放规则、可见性。浏览器、Worker 和脱敏共用
import type { PublicMetricCard, PublicMetricTemplate, PublicPageConfig, PublicSectionConfig } from './types.ts';

export type { PublicMetricCard, PublicMetricTemplate };

export const PUBLIC_TITLE_MAX = 100;
export const PUBLIC_BIO_MAX = 200;
export const PUBLIC_COLUMNS = 12;

export const PUBLIC_MAX_ROW = 1000;
export const PUBLIC_MAX_HEIGHT = 200;

/** 组件注册表：默认位置等于现有公开页的排列，高度取小值让内容撑开；min 是内容不被挤坏的最小栏数；off 的组件默认不上页面，主人拖进来才显示和下发数据 */
export const PUBLIC_GRID_SECTIONS: readonly { id: PublicGridId; x: number; y: number; w: number; h: number; min: number; off?: boolean }[] = [
  { id: 'stats', x: 0, y: 0, w: 12, h: 4, min: 5 },
  { id: 'timeline', x: 0, y: 4, w: 12, h: 6, min: 6 },
  { id: 'chart', x: 0, y: 10, w: 12, h: 6, min: 6 },
  { id: 'composition', x: 0, y: 16, w: 6, h: 6, min: 4 },
  { id: 'fx', x: 6, y: 16, w: 6, h: 6, min: 5 },
  { id: 'list', x: 0, y: 22, w: 12, h: 6, min: 6 },
  { id: 'ended', x: 0, y: 28, w: 6, h: 6, min: 5 },
  { id: 'lifetime', x: 6, y: 28, w: 6, h: 6, min: 4 },
  { id: 'calendar', x: 0, y: 34, w: 6, h: 12, min: 5, off: true },
  { id: 'years', x: 0, y: 46, w: 12, h: 10, min: 6, off: true },
  { id: 'tenure', x: 0, y: 56, w: 6, h: 13, min: 4, off: true },
  { id: 'treemap', x: 0, y: 69, w: 6, h: 8, min: 4, off: true },
  { id: 'changes', x: 0, y: 77, w: 6, h: 13, min: 4, off: true },
  { id: 'waterfall', x: 0, y: 90, w: 6, h: 6, min: 5, off: true },
];
/** 固定在页面底部的组件：只能隐藏，不参与摆放 */
export const PUBLIC_BOTTOM_SECTIONS = ['footer', 'pile'] as const;

/** 指标卡的模板：一张卡可以有几个数据、数据需要带什么，由模板决定 */
export const PUBLIC_METRIC_TEMPLATES = ['number', 'trend', 'compare', 'share', 'rows'] as const;
/** 指标卡可选的数据。needs 是它和哪个组件用同一类数据，脱敏据此决定下发什么；series、prev、share 表示能配哪种模板 */
export const PUBLIC_METRICS = [
  { id: 'monthly', needs: ['stats'], series: true, prev: true },
  { id: 'yearly', needs: ['stats'], prev: true },
  { id: 'active', needs: ['stats'] },
  { id: 'avgPerSub', needs: ['stats'] },
  { id: 'paidTotal', needs: ['stats'] },
  { id: 'paidYear', needs: ['stats'], prev: true },
  { id: 'paidMonth', needs: ['stats'], series: true, prev: true },
  { id: 'next30', needs: ['stats'] },
  { id: 'topSub', needs: ['stats', 'list'], share: true },
  { id: 'topCategory', needs: ['stats', 'composition'], share: true },
  { id: 'endedCount', needs: ['stats'] },
  { id: 'lifetimeCount', needs: ['stats'] },
  { id: 'fxEffect', needs: ['fx'] },
] as const satisfies readonly { id: string; needs: readonly PublicPart[]; series?: boolean; prev?: boolean; share?: boolean }[];
/** 一页最多放多少张指标卡 */
export const PUBLIC_METRIC_CARDS_MAX = 24;
/** 多指标行模板最多放几个数据 */
export const PUBLIC_METRIC_ROWS_MAX = 4;

export type PublicGridId = 'stats' | 'timeline' | 'chart' | 'composition' | 'fx' | 'list' | 'ended' | 'lifetime' | 'calendar' | 'years' | 'tenure' | 'treemap' | 'changes' | 'waterfall';
export type PublicBottomId = (typeof PUBLIC_BOTTOM_SECTIONS)[number];
/** 决定下发哪些数据的最小单位 */
export type PublicPart = PublicGridId | PublicBottomId;
export type PublicMetricId = (typeof PUBLIC_METRICS)[number]['id'];

export interface PublicRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PublicGridItem extends PublicRect {
  /** 注册表里的组件 id，或指标卡的 metric-N */
  id: string;
  min: number;
  hidden: boolean;
  metric?: PublicMetricCard;
}

/** 指标卡同一模板可以放多张，每张有自己的 id */
const METRIC_ID = /^metric-\d{1,6}$/;
/** 几个模板同高，并排时不会一高一低 */
const METRIC_DEF = { w: 3, h: 4, min: 3 };
const METRIC_ROWS_DEF = { w: 6, h: 4, min: 3 };
export const metricDef = (template: PublicMetricTemplate) => (template === 'rows' ? METRIC_ROWS_DEF : METRIC_DEF);
const metricOf = (id: string) => PUBLIC_METRICS.find((m) => m.id === id);
/** 这个模板能选哪些数据：趋势要有序列，对比要有上期，占比要有总量 */
export const metricsFor = (template: PublicMetricTemplate) =>
  PUBLIC_METRICS.filter((m) => (template === 'trend' ? 'series' in m : template === 'compare' ? 'prev' in m : template === 'share' ? 'share' in m : true));
const DEFAULT_METRIC: Record<PublicMetricTemplate, PublicMetricId[]> = { number: ['monthly'], trend: ['monthly'], compare: ['monthly'], share: ['topCategory'], rows: ['monthly', 'yearly', 'active'] };
/** 概览卡已经显示的数，新指标卡默认不再选 */
const STATS_SHOWS = ['monthly', 'yearly', 'active', 'paidTotal'];
/** 新指标卡默认选页面上还没出现过的数据，同一个数不在页面上放两遍；都用过了才退回模板默认 */
function freshMetrics(items: PublicGridItem[], template: PublicMetricTemplate): string[] {
  const used = new Set(items.flatMap((s) => (s.hidden ? [] : s.metric?.items ?? (s.id === 'stats' ? STATS_SHOWS : []))));
  const fresh = metricsFor(template).map((m) => m.id as string).filter((id) => !used.has(id));
  const count = DEFAULT_METRIC[template].length;
  return fresh.length >= count ? fresh.slice(0, count) : DEFAULT_METRIC[template];
}
/** 拖进来的新指标卡：id 取现有最大号的下一个 */
export function newMetricItem(items: PublicGridItem[], template: PublicMetricTemplate): PublicGridItem {
  const n = items.reduce((max, s) => (METRIC_ID.test(s.id) ? Math.max(max, Number(s.id.slice(7))) : max), 0) + 1;
  const def = metricDef(template);
  return { id: `metric-${n}`, x: 0, y: publicGridBottom(items), w: def.w, h: def.h, min: def.min, hidden: false, metric: { template, items: freshMetrics(items, template) } };
}
/** 换模板时留下仍能配的数据，都不能配就用模板默认的；单数据模板只留第一个 */
export function metricWithTemplate(card: PublicMetricCard, template: PublicMetricTemplate): PublicMetricCard {
  const allowed = new Set<string>(metricsFor(template).map((m) => m.id));
  const kept = card.items.filter((id) => allowed.has(id)).slice(0, template === 'rows' ? PUBLIC_METRIC_ROWS_MAX : 1);
  return { template, items: kept.length ? kept : DEFAULT_METRIC[template] };
}
const validMetric = (m: unknown): m is PublicMetricCard => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const c = m as Record<string, unknown>;
  if (Object.keys(c).some((k) => k !== 'template' && k !== 'items')) return false;
  if (!(PUBLIC_METRIC_TEMPLATES as readonly unknown[]).includes(c.template) || !Array.isArray(c.items)) return false;
  const template = c.template as PublicMetricTemplate;
  const allowed = new Set<unknown>(metricsFor(template).map((x) => x.id));
  const max = template === 'rows' ? PUBLIC_METRIC_ROWS_MAX : 1;
  return c.items.length >= 1 && c.items.length <= max && new Set(c.items).size === c.items.length && c.items.every((x) => allowed.has(x));
};

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
export const isCustomLayout = (cfg?: PublicPageConfig) => !!cfg?.sections?.some((s) => (gridDef(s.id) || METRIC_ID.test(s.id)) && hasRect(s));

/** 存下来的配置摊开成完整列表：不认识的 id 忽略，配置里没有的组件（以后新增的）放到最下面，互相压住的往下推 */
export function publicGrid(cfg?: PublicPageConfig): PublicGridItem[] {
  const saved = new Map<string, PublicSectionConfig>();
  for (const s of cfg?.sections ?? []) if (!saved.has(s.id)) saved.set(s.id, s);
  const custom = isCustomLayout(cfg);
  const items: PublicGridItem[] = [];
  const missing: PublicGridItem[] = [];
  for (const def of PUBLIC_GRID_SECTIONS) {
    const s = saved.get(def.id);
    const hidden = s ? !!s.hidden : !!def.off;
    if (hasRect(s)) items.push({ id: def.id, min: def.min, hidden, ...fitRect(def, s) });
    else (custom && !hidden ? missing : items).push({ id: def.id, x: def.x, y: def.y, w: def.w, h: def.h, min: def.min, hidden });
  }
  for (const s of saved.values()) {
    if (!METRIC_ID.test(s.id) || !hasRect(s) || !validMetric(s.metric)) continue;
    items.push({ id: s.id, min: metricDef(s.metric.template).min, hidden: false, metric: s.metric, ...fitRect(metricDef(s.metric.template), s) });
  }
  let bottom = publicGridBottom(items);
  for (const item of missing) {
    items.push({ ...item, x: 0, y: bottom });
    bottom += item.h;
  }
  return settle(custom ? items : flowRects(items));
}

/** 流式页面只记主人隐藏了哪些默认显示的组件；默认不显示的不用记 */
const flowSections = (items: PublicGridItem[]): PublicSectionConfig[] => items.filter((s) => s.hidden && !gridDef(s.id)?.off).map((s) => ({ id: s.id, hidden: true }));
/** 主人只隐藏过组件、没动过位置：这种网格不存几何，页面继续按流式排列 */
export const isFlowGrid = (items: PublicGridItem[]) => JSON.stringify(items) === JSON.stringify(publicGrid({ sections: flowSections(items) }));
/** 网格转成要存的字段：没动过位置时只存隐藏了哪些 */
export const gridConfig = (items: PublicGridItem[]): PublicSectionConfig[] => (isFlowGrid(items) ? flowSections(items) : gridSections(items));

/** 最下面一张可见卡片的下边缘 */
export const publicGridBottom = (items: PublicGridItem[]) => items.reduce((max, s) => (s.hidden ? max : Math.max(max, s.y + s.h)), 0);

/** 指标卡配置变了：只换它自己，位置不动 */
export const setMetric = (items: PublicGridItem[], id: string, metric: PublicMetricCard) => items.map((s) => (s.id === id ? { ...s, metric, min: metricDef(metric.template).min, w: Math.max(s.w, metricDef(metric.template).min) } : s));

/** 把一张卡放到新位置：位置不合规的夹回范围内，被压到的卡片往下推，其余不动 */
export function placeItem(items: PublicGridItem[], id: string, rect: PublicRect): PublicGridItem[] {
  const item = items.find((s) => s.id === id);
  return item ? settle(items, { ...item, ...fitRect(item, rect) }) : items;
}

/** 两次摆放是否一样：指针还在同一格时不用重画 */
export const samePlacement = (a: PublicGridItem[], b: PublicGridItem[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i].id && s.x === b[i].x && s.y === b[i].y && s.w === b[i].w && s.h === b[i].h && !s.hidden === !b[i].hidden);

/** 重新添加：没摆放过的页面回到原位（默认不显示的组件没有原位，放上去就算摆放过）；摆放过的放回页面最下面 */
export function showItem(items: PublicGridItem[], id: string): PublicGridItem[] {
  const item = items.find((s) => s.id === id);
  if (!item) return items;
  if (isFlowGrid(items) && !gridDef(id)?.off) return publicGrid({ sections: flowSections(items.map((s) => (s.id === id ? { ...s, hidden: false } : s))) });
  const placed = isFlowGrid(items) ? publicGrid({ sections: gridSections(items) }) : items;
  return placeItem(placed.map((s) => (s.id === id ? { ...s, hidden: false } : s)), id, { ...item, x: 0, y: publicGridBottom(placed) });
}

/** 移除：没摆放过的页面重新补满；摆放过的只收起它独占的整行，其余不动。指标卡直接删掉，不留隐藏项 */
export function hideItem(items: PublicGridItem[], id: string): PublicGridItem[] {
  if (isFlowGrid(items)) return publicGrid({ sections: flowSections(items.map((s) => (s.id === id ? { ...s, hidden: true } : s))) });
  const next = items.map((s) => (s.id === id ? { ...s, hidden: true } : s)).filter((s) => !(s.hidden && s.metric));
  const kept = collapseEmpty(items, (x) => x === id);
  return publicGrid({ sections: gridSections([...kept, ...next.filter((s) => s.hidden)]) });
}

/** 高度补到内容需要的行数。原来同一排同样高的卡片一起变，并排的两张不会变成一高一矮 */
export function fitHeights(items: PublicGridItem[], need: Record<string, number>): PublicGridItem[] {
  const shown = items.filter((s) => !s.hidden);
  return settle(items.map((s) => (s.hidden ? s : { ...s, h: Math.max(s.h, ...shown.filter((o) => o.y === s.y && o.h === s.h).map((o) => Math.min(need[o.id] ?? 0, PUBLIC_MAX_HEIGHT))) })));
}

/** 去掉没有内容的卡片（没有退订、没有买断），只有它们占着的整行一起收起 */
export function collapseEmpty(items: PublicGridItem[], isEmpty: (id: string) => boolean): PublicGridItem[] {
  const shown = items.filter((s) => !s.hidden);
  const kept = shown.filter((s) => !isEmpty(s.id));
  const freed = new Set<number>();
  for (const s of shown) if (isEmpty(s.id)) for (let row = s.y; row < s.y + s.h; row++) if (!kept.some((k) => row >= k.y && row < k.y + k.h)) freed.add(row);
  return kept.map((s) => ({ ...s, y: s.y - [...freed].filter((row) => row < s.y).length }));
}

/** 网格转成要存的字段 */
export const gridSections = (items: PublicGridItem[]): PublicSectionConfig[] => items.map(({ id, x, y, w, h, hidden, metric }) => ({ id, x, y, w, h, ...(hidden ? { hidden: true } : {}), ...(metric ? { metric } : {}) }));

export const publicBottomShown = (cfg: PublicPageConfig | undefined, id: PublicBottomId) => !cfg?.sections?.some((s) => s.id === id && s.hidden);

/** 实际可见的部分。缺省配置时默认组件可见；指标卡按它选的数据算 */
export function publicParts(cfg?: PublicPageConfig): Set<PublicPart> {
  const out = new Set<PublicPart>();
  for (const s of publicGrid(cfg)) {
    if (s.hidden) continue;
    if (s.metric) for (const id of s.metric.items) for (const part of metricOf(id)?.needs ?? []) out.add(part);
    else out.add(s.id as PublicGridId);
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
export const flowSpans = (ids: string[]) => fillRows(ids.map((id) => gridDef(id)!.w));

/** 平板只分半宽和全宽 */
export const tabletSpan = (span: number) => (span <= 6 ? 6 : PUBLIC_COLUMNS);

const AVATAR = /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/;
export const validPublicAvatar = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 300000 && AVATAR.test(v));

/** 校验要存的配置：只放行白名单内的字段，非法值返回 false */
export function validPublicPage(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  if (Object.keys(c).some((k) => !['browserTitle', 'bio', 'avatar', 'sections'].includes(k))) return false;
  const text = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);
  if (!text(c.browserTitle, PUBLIC_TITLE_MAX) || !text(c.bio, PUBLIC_BIO_MAX)) return false;
  if (!validPublicAvatar(c.avatar)) return false;
  if (c.sections !== undefined) {
    if (!Array.isArray(c.sections)) return false;
    const seen = new Set<string>();
    if ((c.sections as PublicSectionConfig[]).filter((x) => METRIC_ID.test(x?.id)).length > PUBLIC_METRIC_CARDS_MAX) return false;
    for (const raw of c.sections as PublicSectionConfig[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) return false;
      seen.add(raw.id);
      if (Object.keys(raw).some((k) => !['id', 'hidden', 'x', 'y', 'w', 'h', 'metric'].includes(k))) return false;
      if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') return false;
      const metric = METRIC_ID.test(raw.id);
      if (metric ? !validMetric(raw.metric) || raw.hidden : raw.metric !== undefined) return false;
      const def = metric ? metricDef(raw.metric!.template) : gridDef(raw.id);
      if (!def && !isBottom(raw.id)) return false;
      const rect = [raw.x, raw.y, raw.w, raw.h];
      if (rect.every((v) => v === undefined) && !metric) continue;
      if (!def || !rect.every(Number.isInteger)) return false;
      const { x, y, w, h } = raw as PublicRect;
      const maxRow = PUBLIC_MAX_ROW + (PUBLIC_GRID_SECTIONS.length + PUBLIC_METRIC_CARDS_MAX) * PUBLIC_MAX_HEIGHT;
      if (x < 0 || w < def.min || x + w > PUBLIC_COLUMNS || y < 0 || y > maxRow || h < 1 || h > PUBLIC_MAX_HEIGHT) return false;
    }
  }
  return true;
}

/** 恢复旧备份：去掉已不认识的字段和组件，其余（简介、头像、摆放）保留；单项非法只丢这一项，隐藏的组件摆放非法时仍保持隐藏 */
export function restorablePublicPage(raw: unknown): PublicPageConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['browserTitle', 'bio', 'avatar']) if (c[k] !== undefined && validPublicPage({ [k]: c[k] })) out[k] = c[k];
  if (Array.isArray(c.sections)) {
    const seen = new Set<string>();
    let cards = 0;
    out.sections = (c.sections as PublicSectionConfig[]).flatMap((s) => {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || seen.has(s.id)) return [];
      const kept = validPublicPage({ sections: [s] }) ? s : s.hidden === true && validPublicPage({ sections: [{ id: s.id, hidden: true }] }) ? { id: s.id, hidden: true } : undefined;
      if (!kept || (METRIC_ID.test(s.id) && ++cards > PUBLIC_METRIC_CARDS_MAX)) return [];
      seen.add(s.id);
      return [kept];
    });
  }
  return validPublicPage(out) ? (out as PublicPageConfig) : undefined;
}

/** 下发给访客的配置：只留页面需要的字段（头像已合并到 settings.avatar，不重复下发） */
export function publicConfigForVisitors(cfg?: PublicPageConfig): PublicPageConfig | undefined {
  if (!cfg) return undefined;
  const items = publicGrid(cfg);
  const grid = isCustomLayout(cfg) ? gridSections(items) : flowSections(items);
  const bottom = PUBLIC_BOTTOM_SECTIONS.filter((id) => !publicBottomShown(cfg, id)).map((id) => ({ id: id as string, hidden: true }));
  return {
    browserTitle: cfg.browserTitle?.trim() || undefined,
    bio: cfg.bio?.trim() || undefined,
    sections: [...grid, ...bottom],
  };
}

/** 编辑页和 iframe 预览之间的消息；只在同源父子窗口间传，内容都已脱敏 */
export const PUBLIC_PREVIEW_READY = 'calends:public-preview-ready';
export const PUBLIC_PREVIEW_DATA = 'calends:public-preview-data';
export const PUBLIC_PREVIEW_DRAFT = 'calends:public-preview-draft';
/** 画布（iframe）发回编辑页：摆放结果、要隐藏的组件，或选中的指标卡 */
export const PUBLIC_PREVIEW_LAYOUT = 'calends:public-preview-layout';
/** 编辑页发给画布：组件库里拖着的组件走到哪了。指针被编辑页捕获，iframe 收不到指针事件 */
export const PUBLIC_PREVIEW_DROP = 'calends:public-preview-drop';

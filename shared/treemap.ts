// 方块图：纯算法和公开页方块图的数据，浏览器与测试共用
import { effectiveStatus } from './billing.ts';
import { categoryList } from './categories.ts';
import { contributionOn } from './metrics.ts';
import type { AppState } from './types.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  i: number;
}

/** Squarified treemap（Bruls et al.），坐标为百分比 */
export function squarify(values: number[], x = 0, y = 0, w = 100, h = 100): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const items = values
    .map((v, i) => ({ v: (v / total) * w * h, i }))
    .filter((t) => t.v > 0)
    .sort(byAmountDesc);
  const out: Rect[] = [];
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row);
    const mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  let rect = { x, y, w, h };
  let row: typeof items = [];
  const layout = (r: typeof items) => {
    const s = r.reduce((a, b) => a + b.v, 0);
    if (rect.w >= rect.h) {
      const cw = s / rect.h;
      let cy = rect.y;
      for (const t of r) {
        const ch = t.v / cw;
        out.push({ x: rect.x, y: cy, w: cw, h: ch, i: t.i });
        cy += ch;
      }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const ch = s / rect.w;
      let cx = rect.x;
      for (const t of r) {
        const cw = t.v / ch;
        out.push({ x: cx, y: rect.y, w: cw, h: ch, i: t.i });
        cx += cw;
      }
      rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
    }
  };
  for (const t of items) {
    const side = Math.min(rect.w, rect.h);
    if (
      !row.length ||
      worst([...row.map((r) => r.v), t.v], side) <=
        worst(
          row.map((r) => r.v),
          side,
        )
    )
      row.push(t);
    else {
      layout(row);
      row = [t];
    }
  }
  if (row.length) layout(row);
  return out;
}

export interface SpendSub {
  id: string;
  name: string;
  v: number;
}
export interface SpendGroup {
  name: string;
  /** 在公开页「构成」里的名次，决定分类颜色 */
  rank: number;
  v: number;
  subs: SpendSub[];
}
export interface SpendMap {
  groups: SpendGroup[];
  /** 能折算的合计，缺汇率的不在内 */
  total: number;
  /** 缺汇率、没法算面积的订阅数 */
  missing: number;
}

/** 金额从大到小；缺汇率的 NaN 排最后，不打乱其他项的顺序 */
export const byAmountDesc = (a: { v: number }, b: { v: number }) => (Number.isFinite(b.v) ? b.v : -Infinity) - (Number.isFinite(a.v) ? a.v : -Infinity) || 0;

/** 当前每月开销按分类分组（基准币种）。在用范围、分类顺序和排序与「构成」卡一致，缺汇率的不当成 0，单独计数 */
export function spendingMap(state: AppState, today: string): SpendMap {
  const live = state.subscriptions
    .map((s) => ({ s, v: contributionOn(state, s, today) }))
    .filter((x) => ['active', 'ending', 'trial', 'paused'].includes(effectiveStatus(x.s, today)))
    .sort(byAmountDesc);
  const cats = new Map<string, { v: number; items: typeof live }>();
  for (const c of categoryList(state.settings, state.subscriptions)) if (live.some((x) => x.s.category === c.name)) cats.set(c.name, { v: 0, items: [] });
  for (const x of live) {
    const c = cats.get(x.s.category) ?? { v: 0, items: [] };
    c.v += x.v;
    c.items.push(x);
    cats.set(x.s.category, c);
  }
  const groups = [...cats.entries()]
    .sort((a, b) => byAmountDesc(a[1], b[1]))
    .map(([name, c], rank) => {
      const subs = c.items.filter((x) => x.v > 0).map((x) => ({ id: x.s.id, name: x.s.name, v: x.v }));
      return { name, rank, v: subs.reduce((a, x) => a + x.v, 0), subs };
    })
    .filter((g) => g.subs.length);
  return { groups, total: groups.reduce((a, g) => a + g.v, 0), missing: live.filter((x) => !Number.isFinite(x.v)).length };
}

export interface SpendTile extends Rect {
  sub: SpendSub;
  group: SpendGroup;
}

/** 两层方块（先分类、再订阅）的像素坐标：块间留 gap，外缘贴齐 W×H */
export function spendTiles(groups: SpendGroup[], W: number, H: number, gap = 2): SpendTile[] {
  if (W <= 0 || H <= 0) return [];
  const half = gap / 2;
  return squarify(
    groups.map((g) => g.v),
    -half,
    -half,
    W + gap,
    H + gap,
  ).flatMap((b) => {
    const group = groups[b.i];
    return squarify(
      group.subs.map((s) => s.v),
      b.x,
      b.y,
      b.w,
      b.h,
    ).map((r) => ({ ...r, x: r.x + half, y: r.y + half, w: Math.max(r.w - gap, 1), h: Math.max(r.h - gap, 1), sub: group.subs[r.i], group }));
  });
}

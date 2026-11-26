// 文件页瀑布流：按预览图比例排版，逐张放进当前最矮的一列，各列底部不对齐；横向的跨两列。
// 只在桌面宽度用（至少三列）；手机仍是整齐的两列网格。

export interface Tile {
  key: string;
  /** 宽 / 高；还不知道时为 undefined，先按竖版纸张占位 */
  ratio?: number;
}

export interface Placed {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  span: 1 | 2;
}

export const MASONRY = {
  minCol: 240,
  gap: 18,
  /** 未知比例时的占位：A4 竖版 */
  fallback: 1 / Math.SQRT2,
  /** 宽高比达到这个值算横向，跨两列 */
  wide: 1.2,
  /** 单列最瘦：再长的截图也只显示到 1:2，顶部对齐裁掉下面 */
  minTall: 0.5,
  /** 单列最扁：接近方形的单列不再更扁 */
  maxSingle: 1.15,
  /** 双列最瘦与最扁：超长横幅裁到 3:1 */
  minWide: 1.2,
  maxWide: 3,
  /** 横向卡下方允许的空洞：超过这么多列宽就先用单列卡填 */
  hole: 0.25,
  /** 最多往后找几张单列卡来填，避免横向卡被推得太靠后 */
  lookahead: 4,
} as const;

export const masonryCols = (width: number) => Math.max(1, Math.floor((width + MASONRY.gap) / (MASONRY.minCol + MASONRY.gap)));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 按容器宽度给每张卡算位置；返回 null 表示列数不足三列，交给普通网格。
 *  跨两列的卡要从两列中较高者的下沿开始，两列高差大时较矮那列会留下空洞：
 *  这时先放后面几张单列卡把空洞填上，再放这张横向卡。 */
export function layoutMasonry(tiles: readonly Tile[], width: number): { items: Placed[]; height: number } | null {
  const cols = masonryCols(width);
  if (cols < 3) return null;
  const { gap } = MASONRY;
  const col = (width - gap * (cols - 1)) / cols;
  const tops = Array<number>(cols).fill(0);
  const shape = tiles.map((t) => {
    const r = t.ratio && Number.isFinite(t.ratio) && t.ratio > 0 ? t.ratio : MASONRY.fallback;
    const span: 1 | 2 = r >= MASONRY.wide ? 2 : 1;
    const w = span === 2 ? col * 2 + gap : col;
    const shown = span === 2 ? clamp(r, MASONRY.minWide, MASONRY.maxWide) : clamp(r, MASONRY.minTall, MASONRY.maxSingle);
    return { span, w, height: Math.round(w / shown) };
  });
  /** 最高的位置；同高时空洞小的优先，再靠左 */
  const slot = (span: 1 | 2) => {
    let best = { at: 0, top: Infinity, hole: Infinity };
    for (let i = 0; i + span <= cols; i++) {
      const top = span === 2 ? Math.max(tops[i], tops[i + 1]) : tops[i];
      const hole = span === 2 ? Math.abs(tops[i] - tops[i + 1]) : 0;
      if (top < best.top - 0.5 || (Math.abs(top - best.top) <= 0.5 && hole < best.hole - 0.5)) best = { at: i, top, hole };
    }
    return best;
  };
  const out: Placed[] = Array(tiles.length);
  const put = (i: number) => {
    const { span, w, height } = shape[i];
    const { at, top } = slot(span);
    for (let c = at; c < at + span; c++) tops[c] = top + height + gap;
    out[i] = { key: tiles[i].key, left: Math.round(at * (col + gap)), top: Math.round(top), width: Math.round(w), height, span };
  };
  const done = Array<boolean>(tiles.length).fill(false);
  for (let i = 0; i < tiles.length; i++) {
    if (done[i]) continue;
    if (shape[i].span === 2) {
      // 空洞超过 HOLE 列宽时，从后面 LOOKAHEAD 张里取单列卡先填
      for (let j = i + 1, seen = 0; j < tiles.length && seen < MASONRY.lookahead && slot(2).hole > col * MASONRY.hole; j++) {
        if (done[j] || shape[j].span !== 1) continue;
        seen++;
        put(j);
        done[j] = true;
      }
    }
    put(i);
    done[i] = true;
  }
  return { items: out, height: Math.max(0, Math.max(...tops) - gap) };
}

const KEY = 'calends.fileRatio';
let cache: Record<string, number> | undefined;

/** 预览图比例按文件 id 记在本地，下次打开直接按真实比例排，不再跳动 */
export function knownRatio(id: string): number | undefined {
  cache ??= read();
  return cache[id];
}

export function rememberRatio(id: string, ratio: number): boolean {
  cache ??= read();
  const r = Math.round(ratio * 1000) / 1000;
  if (!Number.isFinite(r) || r <= 0 || cache[id] === r) return false;
  cache[id] = r;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 存不下只影响下次的首帧
  }
  return true;
}

function read(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

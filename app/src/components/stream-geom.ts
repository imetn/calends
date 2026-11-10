import { streamLayers } from '../../../shared/chart-data.ts';

/** 河流图的几何：列中心之间用水平切线的三次曲线连起来，两端延伸到边缘 */
export function streamGeom(cols: Array<Map<string, number>>, width: number, height: number) {
  const n = cols.length;
  const { keys, y0, y1, peak } = streamLayers(cols);
  // 与 .act-bars 的列一致：列宽 = (总宽 − 间隙) / 列数；间隙 6px，窄屏 3px（styles.css 同一断点）
  const gap = typeof matchMedia === 'function' && matchMedia('(max-width: 680px)').matches ? 3 : 6;
  const cw = (width - gap * (n - 1)) / n;
  const cx = (i: number) => i * (cw + gap) + cw / 2;
  const xs = [0, ...Array.from({ length: n }, (_, i) => cx(i)), width];
  const scale = peak > 0 ? (height * 0.92) / peak : 0;
  const Y = (v: number) => height / 2 - v * scale;
  const ext = (row: number[]) => [row[0], ...row, row[n - 1]];
  const line = (row: number[], back: boolean) => {
    const pts = ext(row).map((v, i) => [xs[i], Y(v)] as const);
    if (back) pts.reverse();
    return pts
      .map(([x, y], i) => (i ? `C${(pts[i - 1][0] + x) / 2},${pts[i - 1][1]} ${(pts[i - 1][0] + x) / 2},${y} ${x},${y}` : `${back ? 'L' : 'M'}${x},${y}`))
      .join('');
  };
  // 每层从自己的上沿一直铺到最底下一层的下沿，后画的盖住先画的：相邻层只有一条边，抗锯齿不会漏出底色
  const paths = keys.map((_, i) => `${line(y1[i], false)}${line(y0[0], true)}Z`);
  /** 指针位置 → 所在列与所在层；曲线按与绘制相同的三次贝塞尔求值 */
  const hit = (px: number, py: number): { col: number; key: string | undefined } => {
    const col = Math.max(0, Math.min(n - 1, Math.floor((px + gap / 2) / (cw + gap))));
    // 指针越过右缘（宽度取整造成的不足 1px）时归入最后一段
    const found = xs.findIndex((x, i) => i > 0 && px <= x);
    const seg = found < 0 ? xs.length - 2 : Math.max(0, found - 1);
    const [xa, xb] = [xs[seg], xs[seg + 1]];
    const f = xb > xa ? Math.max(0, Math.min(1, (px - xa) / (xb - xa))) : 0;
    // x(u) = 1.5u − 1.5u² + u³ 单调，二分求 u；y 按 3u² − 2u³ 插值
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 20; k++) {
      const u = (lo + hi) / 2;
      if (1.5 * u - 1.5 * u * u + u * u * u < f) lo = u;
      else hi = u;
    }
    const u = (lo + hi) / 2;
    const w = 3 * u * u - 2 * u * u * u;
    const at = (row: number[]) => {
      const e = ext(row);
      return e[seg] + (e[seg + 1] - e[seg]) * w;
    };
    const v = scale > 0 ? (height / 2 - py) / scale : NaN;
    const i = keys.findIndex((_, j) => at(y0[j]) <= v && v <= at(y1[j]) && at(y1[j]) > at(y0[j]));
    // 列间过渡带里插值出的细层，在最近那列没有金额时不算命中，免得高亮了表里没有的一行
    const key = i >= 0 && (cols[col].get(keys[i]) ?? 0) > 0 ? keys[i] : undefined;
    return { col, key };
  };
  return { n, keys, peak, cx, paths, hit };
}

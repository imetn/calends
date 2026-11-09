const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const POLYLINE = /^M#,#(?:L#,#)*Z?$/;

const shapeOf = (d: string) => d.replace(NUM, '#');
const numbersOf = (d: string) => (d.match(NUM) ?? []).map(Number);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const trim = (v: number) => String(+v.toFixed(2));

type Point = [number, number];

function pointsOf(d: string): Point[] {
  const n = numbersOf(d);
  return Array.from({ length: n.length / 2 }, (_, i): Point => [n[2 * i], n[2 * i + 1]]);
}

/** 按下标均匀取样到 count 个点：沿原折线插值，形状不变 */
function resample(points: Point[], count: number): Point[] {
  if (points.length === count || points.length < 2) return Array.from({ length: count }, (_, i) => points[Math.min(i, points.length - 1)]);
  return Array.from({ length: count }, (_, k): Point => {
    const at = count === 1 ? 0 : (k / (count - 1)) * (points.length - 1);
    const i = Math.min(Math.floor(at), points.length - 2);
    return [lerp(points[i][0], points[i + 1][0], at - i), lerp(points[i][1], points[i + 1][1], at - i)];
  });
}

/**
 * 两条路径之间的插值函数；无法对应时返回 null，由调用方直接跳到新形状。
 * 结构相同的路径逐数对应；点数不同的折线先取样到相同点数。闭合折线（面积图）末两点是基线，单独对应。
 */
export function morphPath(from: string, to: string): ((t: number) => string) | null {
  const shape = shapeOf(from);
  const target = shapeOf(to);
  if (shape === target) {
    const a = numbersOf(from);
    const b = numbersOf(to);
    const text = to.split(NUM);
    return (t) => text.reduce((out, part, i) => out + part + (i < b.length ? trim(lerp(a[i], b[i], t)) : ''), '');
  }
  const closed = shape.endsWith('Z');
  if (!POLYLINE.test(shape) || !POLYLINE.test(target) || closed !== target.endsWith('Z')) return null;
  const tail = closed ? 2 : 0;
  const p = pointsOf(from);
  const q = pointsOf(to);
  if (p.length <= tail || q.length <= tail) return null;
  const count = Math.max(p.length, q.length) - tail;
  const a = [...resample(p.slice(0, p.length - tail), count), ...p.slice(p.length - tail)];
  const b = [...resample(q.slice(0, q.length - tail), count), ...q.slice(q.length - tail)];
  return (t) => a.map(([x, y], i) => `${i ? 'L' : 'M'}${trim(lerp(x, b[i][0], t))},${trim(lerp(y, b[i][1], t))}`).join('') + (closed ? 'Z' : '');
}

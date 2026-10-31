/**
 * 从图标像素里挑卡片背景渐变用的颜色（纯函数，取像素在 iconTint.ts）。
 * 跳过近白、近黑、透明和灰色的像素，按色相分桶（每桶 30°）、以饱和度加权，
 * 按权重取最多三桶的平均色，次要色至少占主色的 18%。
 * 一张渐变里不让蓝（190–250°）和紫（250–320°）同时出现；只有一种颜色时补一个相邻色相、略亮的颜色，
 * 蓝色往青色那边偏，避免补成蓝紫。彩色像素太少（纯黑白图标）时返回 null。
 */
type Rgb = [number, number, number];

function hsl([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
  }
  return [(h * 60 + 360) % 360, s, l];
}

function rgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const isBlue = (h: number) => h >= 190 && h < 250;
const isPurple = (h: number) => h >= 250 && h < 320;
const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;

export function pickPalette(d: ArrayLike<number>): string[] | null {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const px: Rgb = [d[i], d[i + 1], d[i + 2]];
    const a = d[i + 3];
    if (a < 128) continue;
    const [h, s, l] = hsl(px);
    if (l > 0.92 || l < 0.1 || s < 0.25) continue;
    const w = s * (a / 255);
    const bk = buckets[Math.floor(h / 30) % 12];
    bk.w += w;
    bk.r += px[0] * w;
    bk.g += px[1] * w;
    bk.b += px[2] * w;
  }
  const ranked = buckets
    .filter((b) => b.w > 0)
    .sort((x, y) => y.w - x.w)
    .map((b) => {
      const c: Rgb = [Math.round(b.r / b.w), Math.round(b.g / b.w), Math.round(b.b / b.w)];
      return { w: b.w, c, h: hsl(c)[0] };
    });
  const best = ranked[0];
  // 彩色像素太少（只是边缘一点点）也不算
  if (!best || best.w < (d.length / 4) * 0.03) return null;
  const picked = [best];
  for (const b of ranked.slice(1)) {
    if (picked.length === 3 || b.w < best.w * 0.18) break;
    if ((isBlue(b.h) && picked.some((p) => isPurple(p.h))) || (isPurple(b.h) && picked.some((p) => isBlue(p.h)))) continue;
    picked.push(b);
  }
  if (picked.length === 1) {
    const [h, s, l] = hsl(best.c);
    return [css(best.c), css(rgb((h + (isBlue(h) ? -28 : 28) + 360) % 360, s, Math.min(0.78, l + 0.08)))];
  }
  return picked.map((p) => css(p.c));
}

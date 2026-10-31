import { base } from './base.ts';
import { useEffect, useState } from 'react';
import { pickPalette } from './icon-palette.ts';

/**
 * 从图标里取两三种主色，给卡片背景渐变用（挑色规则见 icon-palette.ts）。很多图标外圈是白底
 * （站点 favicon、Cloudflare 等），直接把图片模糊铺开只会得到一片白，所以按像素挑色。
 * 取不到（纯黑白图标、加载失败）时返回 null。
 * 外站图片走同源的 /api/img 代理，canvas 才能读像素。结果按地址缓存。
 */
const cache = new Map<string, Promise<string[] | null>>();

function sample(src: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const N = 32;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(img, 0, 0, N, N);
        resolve(pickPalette(g.getImageData(0, 0, N, N).data));
      } catch {
        resolve(null);
      }
    };
    img.src = /^https?:/.test(src) ? base(`/api/img?u=${encodeURIComponent(src)}`) : base(src);
  });
}

export function iconPalette(src: string): Promise<string[] | null> {
  let p = cache.get(src);
  if (!p) cache.set(src, (p = sample(src)));
  return p;
}

/** 图标主色（按权重排序，最多三种）；还没算出来或取不到时为 null */
export function useIconPalette(src: string | undefined): string[] | null {
  const [tint, setTint] = useState<string[] | null>(null);
  useEffect(() => {
    if (!src) return setTint(null);
    let live = true;
    void iconPalette(src).then((c) => live && setTint(c));
    return () => {
      live = false;
    };
  }, [src]);
  return tint;
}

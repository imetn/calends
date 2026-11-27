// 缩略图编码：纯函数，浏览器与测试共用

/** 缩略图上限 64 KB，放不下时降质量再试 */
export const THUMB_BYTES = 64 * 1024;

type Encodable = { convertToBlob(options: { type: string; quality: number }): Promise<Blob> };

/**
 * 优先 WebP；iPhone 上的 Safari 编不出 WebP（会退回 PNG），改用 JPEG。
 * 底色已垫白，JPEG 没有透明度也不影响。各档质量都超出上限时返回 undefined。
 */
export async function encodeThumb(canvas: Encodable): Promise<Blob | undefined> {
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of [0.8, 0.6, 0.4]) {
      const out = await canvas.convertToBlob({ type, quality });
      if (out.type !== type) break;
      if (out.size <= THUMB_BYTES) return out;
    }
  }
  return undefined;
}

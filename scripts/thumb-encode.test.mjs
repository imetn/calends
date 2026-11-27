// 缩略图编码：iPhone Safari 编不出 WebP 时改用 JPEG（线上反馈：手机上传的 PDF 在文件列表没有首页预览）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeThumb, THUMB_BYTES } from '../app/src/thumb-encode.ts';

const canvas = (supported, sizeOf = () => 1000) => {
  const calls = [];
  return {
    calls,
    convertToBlob: async ({ type, quality }) => {
      calls.push(`${type}@${quality}`);
      const out = supported.includes(type) ? type : 'image/png';
      return new Blob([new Uint8Array(sizeOf(out, quality))], { type: out });
    },
  };
};

test('browsers that encode WebP get a WebP thumbnail', async () => {
  const c = canvas(['image/webp', 'image/jpeg']);
  assert.equal((await encodeThumb(c)).type, 'image/webp');
  assert.deepEqual(c.calls, ['image/webp@0.8']);
});

test('Safari without WebP encoding falls back to JPEG instead of giving up', async () => {
  const c = canvas(['image/jpeg']);
  assert.equal((await encodeThumb(c)).type, 'image/jpeg');
  assert.deepEqual(c.calls, ['image/webp@0.8', 'image/jpeg@0.8']);
});

test('quality steps down until the thumbnail fits, and gives up when nothing fits', async () => {
  const c = canvas(['image/jpeg'], (_, q) => (q > 0.5 ? THUMB_BYTES + 1 : 10));
  const out = await encodeThumb(c);
  assert.equal(out.type, 'image/jpeg');
  assert.deepEqual(c.calls.slice(1), ['image/jpeg@0.8', 'image/jpeg@0.6', 'image/jpeg@0.4']);
  assert.equal(await encodeThumb(canvas(['image/jpeg'], () => THUMB_BYTES + 1)), undefined);
  assert.equal(await encodeThumb(canvas([])), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconFit, iconInput, isDataIcon, isImageIcon, registrarIcon, shortLink } from './icon.ts';

test('域名订阅的注册商图标：上传的内嵌图片、网址、站内路径都生效，emoji 和空值回落 Cloudflare', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(registrarIcon(png), png);
  assert.equal(registrarIcon('https://example.com/r.png'), 'https://example.com/r.png');
  assert.equal(registrarIcon('/brands/namecheap.svg'), '/brands/namecheap.svg');
  assert.equal(registrarIcon('🌐'), '/brands/cloudflare.svg');
  assert.equal(registrarIcon(undefined), '/brands/cloudflare.svg');
});

test('订阅图标：网址、站内路径和 png/jpeg/webp 内嵌图片是图片，其余当 emoji', () => {
  assert.ok(isImageIcon('https://example.test/a.png'));
  assert.ok(isImageIcon('/ai/claude.svg'));
  assert.ok(isImageIcon('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(isDataIcon('data:image/webp;base64,UklGRg=='));
  // svg 内嵌图片不认（可能带脚本），当文字处理也不会执行
  assert.ok(!isDataIcon('data:image/svg+xml;base64,PHN2Zz4='));
  assert.ok(!isImageIcon('🎬'));
  assert.ok(!isImageIcon(undefined));
});

test('iconInput：接受网址、站内路径、内嵌图片和 emoji，空值清除，其余报错', () => {
  assert.equal(iconInput(' 🎬 '), '🎬');
  assert.equal(iconInput('🇯🇵'), '🇯🇵');
  assert.equal(iconInput('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(iconInput('/ai/claude.svg'), '/ai/claude.svg');
  assert.equal(iconInput('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(iconInput(''), undefined);
  assert.equal(iconInput(null), undefined);
  for (const bad of [
    'javascript:alert(1)',
    'mailto:a@example.test',
    'https://',
    '//evil.test/x',
    'two words',
    'abcdefgh',
    'data:image/svg+xml;base64,PHN2Zz4=',
    `data:image/png;base64,${'A'.repeat(90000)}`,
  ])
    assert.throws(() => iconInput(bad), undefined, bad);
});

test('iconFit：等比缩进 128 见方并居中，小图不放大，非法尺寸返回 undefined', () => {
  assert.deepEqual(iconFit(1024, 1024), { x: 0, y: 0, w: 128, h: 128 });
  assert.deepEqual(iconFit(1000, 250), { x: 0, y: 48, w: 128, h: 32 });
  assert.deepEqual(iconFit(300, 1200), { x: 48, y: 0, w: 32, h: 128 });
  assert.deepEqual(iconFit(64, 32), { x: 32, y: 48, w: 64, h: 32 });
  assert.deepEqual(iconFit(4000, 1), { x: 0, y: 63, w: 128, h: 1 });
  for (const [w, h] of [
    [0, 10],
    [10, Number.NaN],
    [-1, 5],
    [10000, 10000],
  ])
    assert.equal(iconFit(w, h), undefined);
});

test('长图片链接失焦时只留域名和文件名，短链接、emoji、站内路径原样', () => {
  assert.equal(shortLink('https://cdn.example.com/uploads/2026/11/avatar-final.png?v=3&size=256'), 'cdn.example.com/…/avatar-final.png');
  assert.equal(shortLink('https://www.example.com/assets/a-very-long-generated-file-name-0123456789.webp'), 'example.com/…/a-very-long…3456789.webp');
  assert.equal(shortLink('https://images.example.org/x?token=abcdefghijklmnopqrstuvwxyz'), 'images.example.org/x');
  assert.equal(shortLink('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(shortLink('🎬'), '🎬');
  assert.equal(shortLink('/brands/namecheap.svg'), '/brands/namecheap.svg');
  assert.equal(shortLink('not a url but quite a long piece of text here'), 'not a url but quite a long piece of text here');
});

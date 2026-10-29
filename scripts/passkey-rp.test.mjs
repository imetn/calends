import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rp } from '../worker/auth.ts';

// issue #8：Docker 里 wrangler 只走 http，HTTPS 反代后 req.url 是 http://域名，Passkey 的 origin 必须以 SITE_URL 为准
test('Passkey 的 RP 优先取 SITE_URL，不受容器内 http 地址影响', () => {
  const req = new Request('http://bill.example.com/api/auth/passkey/register/verify', { headers: { origin: 'https://bill.example.com' } });
  assert.deepEqual(rp(req, { SITE_URL: 'https://bill.example.com' }), { rpID: 'bill.example.com', origin: 'https://bill.example.com' });
  // 带安装前缀的 SITE_URL 只取 origin
  assert.deepEqual(rp(new Request('http://127.0.0.1:8788/x'), { SITE_URL: 'https://example.com/calends' }), {
    rpID: 'example.com',
    origin: 'https://example.com',
  });
});

test('没有 SITE_URL 时按请求地址；本地免登录开发以浏览器 Origin 为准', () => {
  assert.deepEqual(rp(new Request('https://subs.example.com/x'), {}), { rpID: 'subs.example.com', origin: 'https://subs.example.com' });
  const dev = new Request('https://subs.example.com/x', { headers: { origin: 'http://localhost:5173' } });
  assert.deepEqual(rp(dev, { DEV_BYPASS_AUTH: '1', SITE_URL: 'https://subs.example.com' }), { rpID: 'localhost', origin: 'http://localhost:5173' });
});

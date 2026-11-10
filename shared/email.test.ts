import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { FALLBACK_FX } from './billing.ts';
import { fallbackChain, flatten, setLocale, type Locale, type Messages } from './i18n.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { renderEmail } from '../worker/email.ts';
import { buildDaily, buildMonthly } from '../worker/notify.ts';

// Worker 里文案经打包从 JSON 导入；这里直接读文件
function loadLocale(loc: Locale) {
  const pack = (l: Locale): Messages => {
    const m: Messages = {};
    for (const ns of ['common', 'core', 'notify']) flatten(ns, JSON.parse(readFileSync(new URL(`./locales/${l}/${ns}.json`, import.meta.url), 'utf8')), m);
    return m;
  };
  setLocale(loc, fallbackChain(loc).map(pack));
}

const SITE = 'https://ledger.example.com';
const sub = (o: Partial<Subscription>): Subscription => ({
  id: 'x',
  name: 'X',
  category: 'AI',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-04',
  status: 'active',
  ...o,
});

const state = (subs: Subscription[]): AppState => ({
  subscriptions: subs,
  methods: [{ id: 'visa', name: 'Visa ·4821', kind: 'credit', currency: 'USD' }],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY', remindDays: 3, monthlyDigest: true },
  fx: FALLBACK_FX,
});

test('到期提醒：金额、折合、日期、距今天数、支付方式', () => {
  loadLocale('zh-CN');
  const d = buildDaily(state([sub({ name: 'Netflix', price: 15.49, methodId: 'visa', icon: 'https://cdn.example.com/n.png' })]), '2026-11-01')!;
  assert.ok(d);
  const { html, text } = renderEmail(d, `${SITE}/`);
  assert.match(html, /\$15\.49/);
  assert.match(html, /≈ ¥\d+\.\d\d/);
  assert.match(html, /11月4日/);
  assert.match(html, /3天后/);
  assert.match(html, /Visa ·4821/);
  assert.match(html, /src="https:\/\/cdn\.example\.com\/n\.png"/);
  // 站点地址末尾的斜杠不会变成双斜杠
  assert.ok(html.includes(`href="${SITE}/"`));
  assert.ok(html.includes(`src="${SITE}/icons/icon-192.png"`));
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /<html lang="zh-CN">/);
  // 纯文本备用正文同样有关键信息
  assert.match(text, /Netflix {2}\$15\.49 \(≈ ¥/);
  assert.ok(text.includes(`${SITE}/`));
});

test('订阅名称与图标里的 HTML 一律转义', () => {
  loadLocale('en');
  const evil = '<script>alert(1)</script> Tom & Jerry';
  const d = buildDaily(state([sub({ name: evil, icon: 'https://x.test/a.png"><img src=x onerror=alert(1)>' })]), '2026-11-01')!;
  const { html } = renderEmail(d, SITE);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('onerror=alert(1)>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Tom &amp; Jerry'));
});

test('图标：emoji 原样显示，图标库 SVG 换成 PNG，其余 SVG 与 data: 改用首字母', () => {
  loadLocale('en');
  const s = state([
    sub({ id: 'a', name: 'Alpha', icon: '☁️' }),
    sub({ id: 'b', name: 'beta', icon: '/ai/claude.svg' }),
    sub({ id: 'c', name: 'Gamma', icon: 'data:image/png;base64,AAAA' }),
    sub({ id: 'd', name: 'delta', icon: 'https://cdn.example.com/d.svg' }),
  ]);
  const { html } = renderEmail(buildDaily(s, '2026-11-01')!, SITE);
  assert.ok(html.includes('☁️'));
  assert.ok(html.includes(`src="${SITE}/mail/ai/claude.png"`));
  assert.ok(!html.includes('.svg'));
  assert.ok(!html.includes('data:image'));
  assert.match(html, />D<\/td>/);
});

// 线上反馈：余额预警行没有图标（Plasma 的 logo 是 SVG；App Store 没设 logo，卡面按类型推出平台图标）
test('余额预警：支付方式图标与卡面同一规则，SVG 换成 PNG', () => {
  loadLocale('zh-CN');
  const bal = { currency: 'USD', balance: 50, balanceAsOf: '2026-10-01', balanceExpires: '2026-12-01' } as const;
  const s = state([]);
  s.methods = [
    { id: 'p', name: 'Plasma 卡', kind: 'crypto', logo: '/brands/plasma.svg', ...bal },
    { id: 'a', name: '美国区', kind: 'appstore', ...bal },
    // 认得出的银行即使设了自定义 logo，也和卡面一样用银行图标
    { id: 'b', name: '招商银行储蓄卡', kind: 'debit', logo: 'https://cdn.example.com/custom.png', ...bal },
    { id: 'd', name: '上传图片', kind: 'prepaid', logo: 'data:image/png;base64,AAAA', url: 'www.wallet.example.com/x', ...bal },
  ];
  const { html } = renderEmail(buildDaily(s, '2026-11-01')!, SITE);
  for (const p of ['/mail/brands/plasma.png', '/mail/brands/appstore.png', '/mail/banks/cmbchina-rect.png']) assert.ok(html.includes(`src="${SITE}${p}"`), p);
  assert.ok(html.includes('src="https://www.google.com/s2/favicons?domain=wallet.example.com&amp;sz=128"'));
  assert.ok(!html.includes('data:image'));
  assert.ok(!html.includes('custom.png'));
});

test('邮件图标：图标库里每个 SVG 都有对应的 PNG', () => {
  const pub = new URL('../app/public/', import.meta.url);
  const svgs = (dir: string, ok: (f: string) => boolean = () => true) =>
    readdirSync(new URL(dir, pub))
      .filter((f) => f.endsWith('.svg') && ok(f))
      .map((f) => `${dir}${f.slice(0, -4)}`);
  const missing = [...svgs('ai/'), ...svgs('brands/'), ...svgs('banks/', (f) => f.endsWith('-rect.svg'))].filter(
    (id) => !existsSync(new URL(`mail/${id}.png`, pub)),
  );
  assert.deepEqual(missing, [], '运行 node scripts/email-icons.mjs');
});

test('月度账单：逐笔列出并给出合计', () => {
  loadLocale('en');
  const d = buildMonthly(
    state([sub({ id: 'a', name: 'Alpha', price: 10, start: '2026-01-05' }), sub({ id: 'b', name: 'Beta', price: 30, currency: 'CNY', start: '2026-01-20' })]),
    '2026-11-01',
  )!;
  assert.equal(d.sections[0].rows.length, 2);
  assert.ok(d.sections[0].total);
  assert.equal(d.stats?.length, 3);
  const { html, text } = renderEmail(d, SITE);
  assert.ok(html.indexOf('Alpha') < html.indexOf('Beta'));
  assert.ok(html.includes(d.sections[0].total!.amount));
  assert.match(html, /Total this month/);
  assert.match(text, /Total this month {2}≈ ¥/);
  assert.match(html, /Nov 5/);
});

test('测试邮件没有条目时显示说明', () => {
  loadLocale('ja');
  const { html, text } = renderEmail({ key: 't', kind: 'test', subject: 'S', intro: 'I', sections: [], date: '2026-11-01' }, SITE);
  assert.match(html, /テストメール/);
  assert.match(text, /テストメール/);
});

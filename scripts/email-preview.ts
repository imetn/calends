// 本地预览提醒邮件：用示例数据把每种邮件渲染成 HTML，写到 .preview/email/（已被 git 忽略），不发送任何东西。
// 用法：npm run email:preview                         中文与英文
//       npm run email:preview -- ja ko                指定语言
//       SITE_URL=https://example.com npm run email:preview   图片、链接用线上地址（默认指向本地 app/public/）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addMonths, FALLBACK_FX } from '../shared/billing.ts';
import { fallbackChain, flatten, isLocale, setLocale, t, type Locale, type Messages } from '../shared/i18n.ts';
import { DEFAULT_SETTINGS, type AppState, type PaymentMethod, type Subscription } from '../shared/types.ts';
import { renderEmail } from '../worker/email.ts';
import { buildDaily, buildMonthly, type Digest } from '../worker/notify.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.preview/email');
const SITE = (process.env.SITE_URL ?? pathToFileURL(join(ROOT, 'app/public')).href).replace(/\/+$/, '');
/** 示例日期取某月 1 日：当天既有到期提醒，也有月度账单 */
const TODAY = '2026-11-01';

/** 与 worker/i18n.ts 相同的回退规则；Node 直接跑 TS 时不经过打包，JSON 用 fs 读 */
function loadLocale(loc: Locale) {
  const pack = (l: Locale): Messages => {
    const m: Messages = {};
    const dir = join(ROOT, 'shared/locales', l);
    // en-AU 等地区变体没有自己的目录，文案全部来自回退语言
    if (!existsSync(dir)) return m;
    for (const ns of ['common', 'core', 'server', 'notify']) {
      if (readdirSync(dir).includes(`${ns}.json`)) flatten(ns, JSON.parse(readFileSync(join(dir, `${ns}.json`), 'utf8')), m);
    }
    return m;
  };
  setLocale(loc, fallbackChain(loc).map(pack));
}

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

function sampleState(loc: Locale): AppState {
  const zh = loc.startsWith('zh');
  const methods: PaymentMethod[] = [
    { id: 'visa', name: zh ? '招商银行 Visa ·4821' : 'Sapphire Visa ·4821', kind: 'credit', currency: 'USD' },
    { id: 'alipay', name: zh ? '支付宝' : 'PayPal', kind: zh ? 'alipay' : 'paypal', currency: zh ? 'CNY' : 'USD' },
    { id: 'tr', name: zh ? 'App Store（土耳其）' : 'App Store (Türkiye)', kind: 'appstore', currency: 'TRY', balance: 80, balanceAsOf: '2026-10-25' },
  ];
  const sub = (o: Partial<Subscription> & Pick<Subscription, 'id' | 'name' | 'price' | 'currency' | 'start'>): Subscription => ({
    category: 'AI',
    tags: [],
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    ...o,
  });
  const subscriptions: Subscription[] = [
    sub({ id: 'chatgpt', name: 'ChatGPT Plus', price: 20, currency: 'USD', start: '2025-06-02', methodId: 'visa', icon: favicon('openai.com') }),
    sub({ id: 'netflix', name: 'Netflix', price: 15.49, currency: 'USD', start: '2025-03-04', methodId: 'visa', icon: favicon('netflix.com') }),
    sub({
      id: 'spotify',
      name: 'Spotify Premium',
      price: 99,
      currency: 'TRY',
      start: '2025-01-04',
      methodId: 'tr',
      region: 'TR',
      icon: favicon('spotify.com'),
    }),
    sub({
      id: 'notion',
      name: 'Notion Plus',
      price: 10,
      currency: 'USD',
      start: '2026-05-04',
      methodId: 'visa',
      intro: { price: 5, until: '2026-10-30' },
      icon: favicon('notion.so'),
    }),
    sub({
      id: 'cursor',
      name: 'Cursor Pro',
      price: 20,
      currency: 'USD',
      start: '2026-10-21',
      status: 'trial',
      trialEnd: '2026-11-04',
      icon: favicon('cursor.com'),
    }),
    sub({
      id: 'youtube',
      name: 'YouTube Premium',
      price: 22.99,
      currency: 'USD',
      start: '2025-02-20',
      methodId: 'visa',
      icon: favicon('youtube.com'),
      share: {
        role: 'owner',
        seats: 5,
        since: '2025-02-20',
        members: [
          {
            id: 'w',
            name: zh ? '小王' : 'Sam',
            share: 4.6,
            receipts: [
              {
                id: 'r',
                date: '2025-02-20',
                amount: 0,
                currency: 'USD',
                periods: Array.from({ length: 21 }, (_, k) => addMonths('2025-02-20', k)),
                opening: true,
              },
            ],
          },
        ],
      },
    }),
    sub({ id: 'icloud', name: 'iCloud+ 200GB', price: 21, currency: 'CNY', start: '2024-01-15', methodId: 'alipay', icon: '☁️' }),
    sub({ id: '1password', name: '1Password', price: 35.88, currency: 'USD', start: '2023-11-18', cycle: { unit: 'year', every: 1 }, methodId: 'visa' }),
  ];
  return {
    subscriptions,
    methods,
    settings: { ...DEFAULT_SETTINGS, baseCurrency: zh ? 'CNY' : 'USD', remindDays: 3, monthlyDigest: true },
    fx: FALLBACK_FX,
  };
}

const locales = process.argv.slice(2).filter(isLocale);
const links: string[] = [];
for (const loc of locales.length ? locales : (['zh-CN', 'en'] as Locale[])) {
  loadLocale(loc);
  const state = sampleState(loc);
  const daily = buildDaily(state, TODAY)!;
  const monthly = buildMonthly(state, TODAY)!;
  const test: Digest = {
    key: 'test',
    kind: 'test',
    subject: t('notify.test.sampleSubject'),
    intro: t('notify.test.sampleIntro'),
    sections: [],
    date: TODAY,
  };
  const dir = join(OUT, loc);
  mkdirSync(dir, { recursive: true });
  for (const [name, d] of [
    ['reminder', daily],
    ['digest', monthly],
    ['test', test],
  ] as const) {
    const { html, text } = renderEmail(d, SITE);
    writeFileSync(join(dir, `${name}.html`), html);
    writeFileSync(join(dir, `${name}.txt`), `Subject: ${d.subject}\n\n${text}\n`);
    links.push(`<li><a href="${loc}/${name}.html">${loc} · ${name}</a> — ${d.subject.replace(/</g, '&lt;')} (<a href="${loc}/${name}.txt">text</a>)</li>`);
  }
}
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Email preview</title><ul style="font:15px/1.8 system-ui">${links.join('')}</ul>`,
);
console.log(`→ ${join(OUT, 'index.html')}`);

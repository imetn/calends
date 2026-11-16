import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cnDate,
  cnDateFull,
  currencyDecimals,
  localDay,
  localTime,
  monthLabel,
  monthTicks,
  moneyTick,
  numericDate,
  symbol,
  flow,
  flowSign,
  money,
  nearDate,
  relDays,
  setSignedAmounts,
} from './format.ts';
import { setLocale } from './i18n.ts';
import { DEFAULT_SETTINGS } from './types.ts';

afterEach(() => {
  setSignedAmounts(true);
  setLocale('en', []);
});

test('cash flow signs default on, including settings saved before the option existed', () => {
  assert.equal(DEFAULT_SETTINGS.signedAmounts, undefined);
  assert.equal(flow(-66.94, 'CNY'), '−¥66.94');
  assert.equal(flow(66.94, 'CNY'), '+¥66.94');
  assert.equal(flow(0, 'CNY'), '¥0.00');
  assert.equal(flow(-0, 'CNY'), '¥0.00');
});

test('switching off removes both directions and switching back restores them', () => {
  setSignedAmounts(false);
  assert.equal(flow(-70.02, 'CNY'), '¥70.02');
  assert.equal(flow(70.02, 'CNY'), '¥70.02');
  assert.equal(flowSign(-70.02), '');
  assert.equal(flowSign(70.02), '');
  setSignedAmounts(true);
  assert.equal(flow(-70.02, 'CNY'), '−¥70.02');
  assert.equal(flow(70.02, 'CNY'), '+¥70.02');
});

test('flow preserves currency, compact, decimals and localized grouping from money', () => {
  for (const ccy of ['USD', 'JPY', 'KRW', 'VND', 'IDR', 'CHF']) {
    for (const n of [0, 7, 66.94, 12345.678]) {
      for (const opts of [{}, { compact: true }, { decimals: 3 }, { compact: true, decimals: 1 }]) {
        assert.equal(flow(-n, ccy, opts), `${n ? '−' : ''}${money(n, ccy, opts)}`);
        assert.equal(flow(n, ccy, opts), `${n ? '+' : ''}${money(n, ccy, opts)}`);
        setSignedAmounts(false);
        assert.equal(flow(-n, ccy, opts), money(n, ccy, opts));
        setSignedAmounts(true);
      }
    }
  }
  setLocale('de', []);
  assert.equal(flow(-1234.56, 'EUR'), '−€1.234,56');
  setSignedAmounts(false);
  assert.equal(flow(1234.56, 'EUR'), '€1.234,56');
});

test('unavailable financial values remain unavailable with either setting', () => {
  for (const on of [true, false]) {
    setSignedAmounts(on);
    for (const n of [NaN, Infinity, -Infinity]) {
      assert.equal(flow(n, 'USD'), '—');
      assert.equal(flowSign(n), '');
    }
    assert.equal(flowSign(0), '');
    assert.equal(flowSign(-0), '');
  }
});

test('prices and comparison signs keep money semantics regardless of cash flow setting', () => {
  for (const on of [true, false]) {
    setSignedAmounts(on);
    assert.equal(money(66.94, 'CNY'), '¥66.94');
    assert.equal(money(5, 'USD', { sign: true }), '+$5.00');
    assert.equal(money(-5, 'USD', { sign: true }), '−$5.00');
  }
});

test('unrefunded loss translations leave cash-flow signs to flow in every locale', async () => {
  const { readFileSync } = await import('node:fs');
  const { TRANSLATED_LOCALES, flatten, t } = await import('./i18n.ts');
  for (const { code: loc } of TRANSLATED_LOCALES) {
    const messages = {};
    flatten('core', JSON.parse(readFileSync(new URL(`./locales/${loc}/core.json`, import.meta.url), 'utf8')), messages);
    setLocale(loc, [messages]);
    for (const on of [true, false]) {
      setSignedAmounts(on);
      const amount = flow(-3.16, 'USD');
      const text = t('core.stop.unused', { money: amount, days: '10' });
      assert.ok(text.includes(amount));
      assert.equal((text.match(/−/g) ?? []).length, on ? 1 : 0, `${loc}: ${text}`);
    }
  }
});

test('all currency display precision follows the shared rule, including negative and compact values', () => {
  setLocale('en', []);
  for (const ccy of ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'HUF', 'TWD', 'PYG', 'MGA', 'BIF']) {
    assert.equal(currencyDecimals(ccy), 0, ccy);
    for (const opts of [{}, { compact: true }, { decimals: 2 }]) {
      assert.equal(money(19.8, ccy, opts), `${symbol(ccy)}20`);
      assert.equal(money(-19.8, ccy, opts), `−${symbol(ccy)}20`);
      assert.equal(money(1234567.89, ccy, opts), `${symbol(ccy)}1,234,568`);
      assert.equal(money(0, ccy, opts), `${symbol(ccy)}0`);
      assert.equal(flow(-19.8, ccy, opts), `−${symbol(ccy)}20`);
    }
    assert.equal(moneyTick(1470.07, ccy), `${symbol(ccy)}1.5k`);
  }
  for (const ccy of ['USD', 'CNY', 'NGN', 'TRY', 'CHF', 'KWD', 'XXX']) {
    assert.equal(currencyDecimals(ccy), 2, ccy);
    assert.equal(money(19.8, ccy), `${symbol(ccy)}19.80`);
    assert.equal(money(-1234567.89, ccy), `−${symbol(ccy)}1,234,567.89`);
    assert.equal(money(19, ccy, { compact: true }), `${symbol(ccy)}19`);
    assert.equal(money(19.8, ccy, { compact: true }), `${symbol(ccy)}19.80`);
    assert.equal(money(1234567.89, ccy, { compact: true }), `${symbol(ccy)}1,234,568`);
  }
  setLocale('de', []);
  assert.equal(money(1234567.89, 'TWD'), 'NT$1.234.568');
  assert.equal(money(1234567.89, 'USD'), '$1.234.567,89');
});

test('Intl formatters are reused per locale and options without changing output', async () => {
  const { dateFormat, numberFormat } = await import('./intl.ts');
  const o = { month: 'short', day: 'numeric', timeZone: 'UTC' } as const;
  assert.equal(dateFormat('zh-CN', o), dateFormat('zh-CN', { ...o }));
  assert.notEqual(dateFormat('zh-CN', o), dateFormat('en', o));
  const d = new Date(Date.UTC(2026, 9, 20));
  assert.equal(dateFormat('de', o).format(d), new Intl.DateTimeFormat('de', o).format(d));
  const n = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  assert.equal(numberFormat('fr', n).format(1234.5), (1234.5).toLocaleString('fr', n));
  assert.throws(() => dateFormat('en', { timeZone: 'Not/AZone' }));
});

test('relative dates use days, then months, then years for long cycles', () => {
  setLocale('en', []);
  assert.equal(relDays(5), 'in 5 days');
  assert.equal(relDays(-90), '3 months ago');
  assert.equal(relDays(365), 'in 12 months');
  // 两年付的下次扣款说「2 年后」，不说「24 个月后」
  assert.equal(relDays(730), 'in 2 years');
  assert.equal(relDays(-1461), '4 years ago');
});

test('upcoming dates share one near-day threshold, then fall back to a dated label with the year when needed', () => {
  setLocale('zh-CN', []);
  // 侧栏曾写「2 天后」、总览写「2天后」，阈值也不同（7 / 13 / 14 天）；现在统一
  assert.equal(nearDate('2026-11-02', '2026-11-02'), '今天');
  assert.equal(nearDate('2026-11-04', '2026-11-02'), relDays(2));
  assert.equal(nearDate('2026-11-16', '2026-11-02'), relDays(14));
  assert.equal(nearDate('2026-11-17', '2026-11-02'), '11月17日');
  assert.equal(nearDate('2027-01-20', '2026-11-02'), '2027年1月20日');
  // 跨年但在两周内仍说相对天数
  assert.equal(nearDate('2027-01-03', '2026-12-28'), relDays(6));
  setLocale('en', []);
});

// 用户反馈（#16）：英文下时间线写 11/10、报告图提示写 2026-10，格式不统一；en-AU 要日在前
test('displayed dates follow the interface locale: en keeps US order, en-AU puts the day first, zh-CN stays unchanged', () => {
  const cases = {
    en: {
      short: '11/15',
      numeric: '11/15/2026',
      day: 'Nov 15',
      full: 'Nov 15, 2026',
      month: 'Nov 2026',
      axis: '11/26',
      stamp: 'Nov 15, 2026, 7:03 PM',
      time: '7:03 PM',
    },
    'en-AU': {
      short: '15/11',
      numeric: '15/11/2026',
      day: '15 Nov',
      full: '15 Nov 2026',
      month: 'Nov 2026',
      axis: '11/26',
      stamp: '15 Nov 2026, 7:03 pm',
      time: '7:03 pm',
    },
    'zh-CN': {
      short: '11/15',
      numeric: '2026/11/15',
      day: '11月15日',
      full: '2026年11月15日',
      month: '2026年11月',
      axis: '26/11',
      stamp: '2026年11月15日 19:03',
      time: '19:03',
    },
  } as const;
  for (const [loc, want] of Object.entries(cases)) {
    setLocale(loc as keyof typeof cases, []);
    const got = {
      short: numericDate('2026-11-15'),
      numeric: numericDate('2026-11-15', { year: true }),
      day: cnDate('2026-11-15'),
      full: cnDateFull('2026-11-15'),
      month: monthLabel('2026-11'),
      axis: monthLabel('2026-11', { numeric: true }),
      // 服务端 UTC 时间按设置时区显示：UTC 11:03 是悉尼夏令时 22:03、上海 19:03
      stamp: localTime('2026-11-15 11:03:00', 'Asia/Shanghai'),
      time: localTime('2026-11-15T11:03:00Z', 'Asia/Shanghai', { part: 'time' }),
    };
    // Intl 在部分版本里用窄不换行空格分隔时间和 AM/PM
    for (const k of Object.keys(got) as Array<keyof typeof got>) got[k] = got[k].replace(/[\u202f\u00a0]/g, ' ');
    assert.deepEqual(got, want, loc);
  }
  setLocale('en-AU', []);
  assert.equal(localTime('2026-11-15 11:03:00', 'Australia/Sydney', { part: 'date' }), '15 Nov 2026');
  assert.equal(localTime('2026-11-15 11:03:00', 'Australia/Sydney', { today: '2026-11-16' }).replace(/[\u202f\u00a0]/g, ' '), '15 Nov, 10:03 pm');
  assert.equal(localTime('not a time', 'UTC'), 'not a time');
  // 比较用的日期仍是 ISO，跨日按设置时区算
  assert.equal(localDay('2026-11-15 14:30:00', 'Australia/Sydney'), '2026-11-16');
  assert.equal(localDay('2026-11-15T14:30:00Z', 'UTC'), '2026-11-15');
  setLocale('en', []);
});

test('display points no longer hand-build MM/DD, YY/M or YYYY-MM date strings', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../app/src/', import.meta.url);
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const handBuilt = [
    // 「11/10」：月份与日子用斜杠拼接
    /slice\(5\)\.replace\(\s*'-'\s*,\s*'\/'\s*\)/,
    /Number\([\w.]+\.slice\(5, 7\)\)\}\/\$\{Number\(/,
    // 「26/10」：两位年份拼月份
    /slice\(2, 4\)\}\/\$\{/,
    // 「2026-10-20 19:03」：sv-SE 写法只留给比较用的 localDay
    /toLocaleString\('sv-SE'/,
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, root), 'utf8');
    for (const re of handBuilt) assert.doesNotMatch(src, re, `${f} ${re}`);
  }
  const read = (f: string) => readFileSync(new URL(f, root), 'utf8');
  // 原样输出 ISO 字符串的几处显示点
  assert.doesNotMatch(read('views/Report.tsx'), /: rows\[i\]\.month\}/);
  assert.doesNotMatch(read('views/SubShare.tsx'), /\{c\.date\}/);
  assert.doesNotMatch(read('views/Wallet.tsx'), /\{tp\.date\}/);
  assert.doesNotMatch(read('views/ImportSheet.tsx'), />\{row\.nextDue\}</);
  assert.doesNotMatch(read('views/Review.tsx'), /\{ date: today \}/);
  assert.doesNotMatch(read('views/Settings.tsx'), /\{ day: preview\.day \}|\{ date: fxs\.first \}|localTime\([^)]*\)\.slice\(/);
  assert.doesNotMatch(read('components/History.tsx'), /\{ date: p\.from \}/);
  for (const f of ['views/Settings.tsx', 'views/Security.tsx', 'views/Ai.tsx']) assert.doesNotMatch(read(f), /localTime\([^)]*, true\)/, f);
  assert.doesNotMatch(readFileSync(new URL('../worker/ics.ts', import.meta.url), 'utf8'), /\{ date: deadline \}/);
});

const monthsFrom = (start: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const k = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 + i;
    return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
  });

test('month axis ticks snap to calendar boundaries and keep January for the year cue', () => {
  const three = monthsFrom('2023-11', 36);
  const pick = (max: number) => monthTicks(three, max).map((i) => three[i]);
  // 宽屏：季度
  assert.deepEqual(pick(12), [
    '2024-01',
    '2024-04',
    '2024-07',
    '2024-10',
    '2025-01',
    '2025-04',
    '2025-07',
    '2025-10',
    '2026-01',
    '2026-04',
    '2026-07',
    '2026-10',
  ]);
  // 中等：半年
  assert.deepEqual(pick(6), ['2024-01', '2024-07', '2025-01', '2025-07', '2026-01', '2026-07']);
  // 手机：只标年
  assert.deepEqual(pick(5), ['2024-01', '2025-01', '2026-01']);
  // 短区间逐月；放不下时取双月
  const six = monthsFrom('2026-05', 6);
  assert.deepEqual(monthTicks(six, 8), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(monthTicks(six, 5), [0, 2, 4]);
  // 一个也放不下逐月时退到双月，总留一个刻度
  assert.deepEqual(monthTicks(monthsFrom('2026-02', 2), 1), [1]);
});

test('整千的金额刻度不带多余的 .0', () => {
  assert.equal(moneyTick(2000, 'USD'), '$2k');
  assert.equal(moneyTick(1500, 'USD'), '$1.5k');
  assert.equal(moneyTick(2000.4, 'USD'), '$2k');
  assert.equal(moneyTick(2500, 'JPY'), `${symbol('JPY')}2.5k`);
  assert.equal(moneyTick(30_000_000, 'USD'), '$30M');
  assert.equal(moneyTick(1950, 'USD'), '$2k');
  assert.equal(moneyTick(9950, 'USD'), '$10k');
  assert.equal(moneyTick(999_600, 'USD'), '$1M');
  assert.equal(moneyTick(999_950_000, 'USD'), '$1B');
  assert.equal(moneyTick(Number.NaN, 'USD'), '—');
});

test('用户反馈：澳门元 MOP 可选，有符号，汇率同步会保留', async () => {
  const { CURRENCIES } = await import('./format.ts');
  const { keepSet } = await import('../worker/fx.ts');
  assert.ok(CURRENCIES.includes('MOP'));
  assert.equal(symbol('MOP'), 'MOP$');
  assert.ok(keepSet({ subscriptions: [], methods: [], settings: DEFAULT_SETTINGS }).has('MOP'));
});

test('Chrome 缺名称的新货币在每种语言都有名称，文案放在 Worker 也加载的命名空间', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { ccyName } = await import('./format.ts');
  const { flatten } = await import('./i18n.ts');
  const root = new URL('./locales/', import.meta.url);
  const locales = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.equal(locales.length, 14);
  assert.match(readFileSync(new URL('../scripts/i18n.mjs', import.meta.url), 'utf8'), /SERVER_NS = \[[^\]]*'core'/);
  for (const { name } of locales) {
    const core = JSON.parse(readFileSync(new URL(`${name}/core.json`, root), 'utf8'));
    for (const code of ['SLE', 'XCG', 'ZWG']) assert.ok(core.currency?.[code] && core.currency[code] !== code, `${name} ${code}`);
    if (name !== 'zh-TW') continue;
    const messages = {};
    flatten('core', core, messages);
    setLocale('zh-TW', [messages]);
    assert.equal(ccyName('SLE'), '獅子山利昂');
  }
});

test('用户反馈：墨西哥比索等货币可选，货币选择器与侧边栏同一份清单，取汇率接口的全部货币', async () => {
  const { readFileSync } = await import('node:fs');
  const picker = readFileSync(new URL('../app/src/components/Picker.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(picker, /CURRENCIES/);
  assert.match(picker, /allCurrencies\(state\?\.fx\.rates\)/);
  const app = readFileSync(new URL('../app/src/app.tsx', import.meta.url), 'utf8');
  assert.match(app, /allCurrencies\(state\.fx\.rates\)/);
  const display = readFileSync(new URL('../app/src/display.ts', import.meta.url), 'utf8');
  assert.match(display, /Object\.keys\(rates \?\? \{\}\)\.filter\(\(c\) => !HIDDEN_CCY\.has\(c\)\)/);
  assert.equal(symbol('MXN'), 'MX$');
  assert.equal(money(199, 'MXN'), 'MX$199.00');
});

test('非常用货币里 Intl 记为无小数的显示 0 位，其余 2 位；常用货币精度不变', async () => {
  const { displayCurrencyDecimals } = await import('./format.ts');
  assert.equal(displayCurrencyDecimals('ISK'), 0);
  assert.equal(displayCurrencyDecimals('UGX'), 0);
  assert.equal(displayCurrencyDecimals('KWD'), 2);
  assert.equal(displayCurrencyDecimals('MXN'), 2);
  assert.equal(displayCurrencyDecimals('PKR'), 2);
  assert.equal(displayCurrencyDecimals('TWD'), 0);
  assert.equal(displayCurrencyDecimals('USD'), 2);
  for (const c of ['ISK', 'UGX']) {
    assert.equal(currencyDecimals(c), 2);
    assert.doesNotMatch(money(101.5, c), /[.,]\d/);
  }
});

test('历史汇率入库汇率接口支持的全部币种；下发覆盖账本里所有金额字段的币种；旧的精简行缺已用币种时重抓', async () => {
  const { parseCurrencyApi, parseFrankfurter } = await import('./fx.ts');
  const { keepSet, staleRow, storeSet } = await import('../worker/fx.ts');
  assert.deepEqual(parseCurrencyApi({ usd: { mxn: 18.4, isk: 138 } }), { USD: 1, MXN: 18.4, ISK: 138 });
  assert.deepEqual(parseFrankfurter({ rates: { MXN: 18.4 } }), { USD: 1, MXN: 18.4 });
  assert.deepEqual(parseCurrencyApi({ usd: { mxn: 18.4, btc: 0.00001 } }, new Set(['MXN'])), { USD: 1, MXN: 18.4 });
  // 主币种 USD 的订阅加了 MXN 分段、UGX 实扣，账户有 ISK 成本：都要下发历史
  const state = {
    subscriptions: [{ currency: 'USD', phases: [{ currency: 'MXN' }], payments: [{ settledCurrency: 'UGX' }] }],
    methods: [{ currency: 'USD', costCcy: 'ISK' }],
    people: [],
    settings: { ...DEFAULT_SETTINGS, collectCurrency: 'PEN' },
  } as never;
  const keep = keepSet(state);
  for (const c of ['MXN', 'UGX', 'ISK', 'PEN', 'USD', 'CNY']) assert.ok(keep.has(c), c);
  // 入库：汇率接口的全部币种 + 已用，不含加密货币；兜底表时不过滤
  const rates = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [`A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, 1]),
  );
  const store = storeSet({ ...(state as object), fx: { base: 'USD', rates, fetchedAt: '' } } as never)!;
  assert.ok(store.has('MXN') && store.has('AAA') && !store.has('BTC'));
  assert.equal(storeSet({ ...(state as object), fx: { base: 'USD', rates: { USD: 1, CNY: 7 }, fetchedAt: '' } } as never), undefined);
  // 旧版精简行缺 MXN → 重抓；完整行、欧洲央行行不重抓，免得循环
  const slim = JSON.stringify({ USD: 1, CNY: 7 });
  assert.equal(staleRow({ source: 'currency-api', rates: slim }, keep), true);
  assert.equal(staleRow({ source: 'ecb', rates: slim }, keep), false);
  assert.equal(staleRow({ source: 'currency-api', rates: JSON.stringify(rates) }, keep), false);
  assert.equal(staleRow({ source: 'currency-api', rates: JSON.stringify(Object.fromEntries([...keep].map((c) => [c, 1]))) }, keep), false);
});

test('纯日期不当 UTC 零点换时区：西半球不早一天、不编造时刻', () => {
  setLocale('en', []);
  assert.equal(localDay('2026-10-19', 'America/Los_Angeles'), '2026-10-19');
  assert.equal(localTime('2026-10-19', 'America/Los_Angeles'), cnDateFull('2026-10-19'));
  assert.equal(localTime('2026-10-19', 'America/Los_Angeles', { part: 'time' }), '');
  assert.doesNotMatch(localTime('2026-10-19', 'America/Los_Angeles'), /18|PM|AM/);
});

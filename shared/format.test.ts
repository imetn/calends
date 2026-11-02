import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyDecimals, monthTicks, moneyTick, symbol, flow, flowSign, money, nearDate, relDays, setSignedAmounts } from './format.ts';
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
  const { LOCALES, flatten, t } = await import('./i18n.ts');
  for (const { code: loc } of LOCALES) {
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
    assert.equal(moneyTick(1470.07, ccy), `${symbol(ccy)}1k`);
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

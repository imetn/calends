import * as fxTotals from './fx-total.ts';
import { shouldGroupYears } from '../app/src/components/year-ledger.ts';
import { readUiSource, extractUiFunction } from '../scripts/ui-test-source.ts';
import assert from 'node:assert/strict';
import * as transfers from './transfers.ts';
import { numberFormat } from './intl.ts';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currencyDecimals, moneyDecimals, flow, flowSign, setSignedAmounts, symbol, relDays, money, cnDateAuto, cnDateFull } from './format.ts';
import { intlLocale, locale, setLocale } from './i18n.ts';
import { chargeBaseOrNaN, chargeValue } from './fx.ts';
import { FALLBACK_FX, addMonths, phaseSubs, diffDays } from './billing.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import * as billing from './billing.ts';
import { colorFor, isCustomColor } from './people.ts';
import { detailForecast, detailHistoryEnd } from '../app/src/views/detail-data.ts';
import type { AppState, Subscription } from './types.ts';

const read = (file: string) => readUiSource(new URL(file, import.meta.url));
function load(file: string, name: string, source: string, deps: Record<string, unknown>) {
  const result = transformSync(file, source.replace(/export function /g, 'function '), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  deps = { ...fxTotals, ...deps };
  return new Function(...Object.keys(deps), `${result.code}; return ${name};`)(...Object.values(deps));
}
const text = (html: string) => html.replace(/<[^>]*>/g, '');
/** 订阅详情、合租共用的按年收付款表：按调用方注入的 useState 与 t 编译真实组件 */
const yearLedger = (deps: Record<string, unknown>) => {
  const file = '../app/src/components/YearLedger.tsx';
  const src = read(file).split('export function YearLedger')[1].split('/** 年份行的支付方式')[0];
  return load(file, 'YearLedger', `function YearLedger${src}`, { React, Fragment: React.Fragment, shouldGroupYears, ...deps });
};
afterEach(() => {
  setSignedAmounts(true);
  setLocale('en', []);
});

// YearLedger.tsx 的 currencyTotals（带样式导入，不能直接加载）：同一实现
const currencyTotals = (rows: any[], amountOf: (r: any) => { currency: string; amount: number }, fmt: (sum: number, ccy: string) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const { currency, amount } = amountOf(r);
    m.set(currency, (m.get(currency) ?? 0) + amount);
  }
  return [...m].map(([c, n]) => fmt(n, c)).join('\n');
};

test('Amount renders directed flows, zero, unavailable values and neutral prices/balances with both settings', () => {
  const file = '../app/src/components/ui.tsx';
  const source = read(file).split('export function Amount(')[1].split('/** 分段控件')[0];
  const Amount = load(file, 'Amount', `function Amount(${source}`, { React, moneyDecimals, flowSign, symbol, intlLocale, numberFormat });
  for (const on of [true, false]) {
    setSignedAmounts(on);
    const render = (value: number, plain = false) => renderToStaticMarkup(React.createElement(Amount, { value, ccy: 'CNY', plain }));
    assert.equal(text(render(-66.94)), `${on ? '−' : ''}¥66.94`);
    assert.equal(text(render(10)), `${on ? '+' : ''}¥10.00`);
    assert.ok(render(10).includes('color:var(--green)'));
    for (const value of [198.65, -198.65, 0]) {
      assert.match(render(value), /class="amt-fraction" style="color:inherit;opacity:0.72"/);
    }
    assert.ok(!render(198.65, true).includes('--green'));
    const whole = renderToStaticMarkup(React.createElement(Amount, { value: 198.65, ccy: 'CNY', decimals: 0 }));
    assert.equal(text(whole), `${on ? '+' : ''}¥199`);
    assert.ok(!whole.includes('amt-fraction'));
    assert.equal(text(render(0)), '¥0.00');
    assert.equal(text(render(-0)), '¥0.00');
    assert.equal(text(render(NaN)), '—');
    assert.equal(text(render(70.02, true)), '¥70.02');
    assert.equal(text(render(1000, true)), '¥1,000.00');
    assert.equal(text(render(-10, true)), '−¥10.00'); // A balance's mathematical sign is independent of cash flow notation.
    assert.ok(!render(1000, true).includes('--green'));
  }
});

test('Amount never renders fractional markup for zero-decimal currencies, including compact/explicit precision', () => {
  const file = '../app/src/components/ui.tsx';
  const source = read(file).split('export function Amount(')[1].split('/** 分段控件')[0];
  const Amount = load(file, 'Amount', `function Amount(${source}`, { React, moneyDecimals, flowSign, symbol, intlLocale, numberFormat });
  for (const ccy of ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'HUF', 'TWD', 'PYG', 'MGA', 'BIF', 'USD', 'CNY', 'NGN', 'TRY']) {
    for (const value of [0, 19.8, -19.8, 1234567.89]) {
      for (const opts of [{}, { compact: true }, { decimals: 2 }, { plain: true }]) {
        const html = renderToStaticMarkup(React.createElement(Amount, { value, ccy, ...opts }));
        const expected = opts.plain ? money(value, ccy, opts) : flow(value, ccy, opts);
        assert.equal(text(html), expected.replace(symbol(ccy), symbol(ccy).trim()));
        if (currencyDecimals(ccy) === 0) assert.ok(!html.includes('amt-fraction'), `${ccy}: ${html}`);
      }
    }
  }
});

test('MoneyPair formats both original and converted currencies with the shared precision', () => {
  const file = '../app/src/components/ui.tsx';
  const source = read(file).split('export function Amount(')[1].split('/** 分段控件')[0];
  const Amount = load(file, 'Amount', `function Amount(${source}`, { React, moneyDecimals, flowSign, symbol, intlLocale, numberFormat });
  let orig = true;
  const useMoneyPair = load(
    'MoneyPair.tsx',
    'useMoneyPair',
    read('../app/src/components/MoneyPair.tsx').split('export function useMoneyPair')[1].replace(/^/, 'function useMoneyPair'),
    {
      React,
      Amount,
      flow,
      money,
      useOrig: () => orig,
      convert: () => 1234.56,
      toBaseAt: () => 1234.56,
    },
  );
  const state = { settings: { baseCurrency: 'JPY' } };
  for (const plain of [true, false]) {
    orig = true;
    let pair = useMoneyPair(state)(1470.07, 'TRY', { plain });
    assert.ok(text(renderToStaticMarkup(pair.main)).includes('₺1,470.07'));
    assert.ok(pair.alt.includes('JP¥1,235'));
    orig = false;
    pair = useMoneyPair(state)(1470.07, 'TRY', { plain });
    assert.ok(text(renderToStaticMarkup(pair.main)).includes('JP¥1,235'));
    assert.ok(!renderToStaticMarkup(pair.main).includes('amt-fraction'));
    assert.ok(pair.alt.includes('₺1,470.07'));
  }
});

test('currency-aware inputs reject fractional drafts with a translated hint without rounding stored values', () => {
  const file = '../app/src/components/ui.tsx';
  const source = read(file).split('export function acceptCurrencyInput(')[1].split('/** 保留字符串')[0];
  const hints: string[] = [];
  const accept = load(file, 'acceptCurrencyInput', `function acceptCurrencyInput(${source}`, {
    currencyDecimals,
    toNum: (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v)),
    notify: { error: (hint: string) => hints.push(hint) },
    t: (key: string, args: { currency: string }) => `${key}:${args.currency}`,
  });
  assert.equal(accept('19.8', 'JPY'), false);
  assert.equal(accept('-19.8', 'TWD'), false);
  assert.equal(accept('1e-1', 'HUF'), false);
  assert.equal(hints.length, 3);
  assert.equal(hints[0], 'ui.error.wholeCurrency:JPY');
  for (const text of ['', '-', '19.', '1900', '-19', '19.00']) assert.equal(accept(text, 'JPY'), true);
  assert.equal(accept('19.8', 'USD'), true);
});

test('Root applies loaded/changed signed settings before rendering and changes the app key for cached children', () => {
  const file = '../app/src/app.tsx';
  const source = read(file).split('function Root()')[1].split('initRouter();')[0];
  let state = { settings: { ...DEFAULT_SETTINGS } };
  const Root = load(file, 'Root', `function Root()${source}`, {
    React,
    useStore: () => ({ state }),
    useState: (value: unknown) => [value, () => {}],
    useEffect() {},
    locale,
    preferredLocale: () => 'en',
    setSignedAmounts,
    App: 'App',
    ErrorBoundary: 'ErrorBoundary',
  });
  // 根节点外面包着错误兜底，App 是它唯一的子节点
  const app = () => Root().props.children;
  const first = app();
  assert.equal(flow(-10, 'USD'), '−$10.00');
  state = { settings: { ...DEFAULT_SETTINGS, signedAmounts: false } };
  const disabled = app();
  assert.notEqual(disabled.key, first.key);
  assert.equal(flow(-10, 'USD'), '$10.00');
  assert.equal(flow(10, 'USD'), '$10.00');
  state = { settings: { ...DEFAULT_SETTINGS, signedAmounts: true } };
  assert.equal(app().key, first.key);
  assert.equal(flow(10, 'USD'), '+$10.00');
});

test('Detail charge rows and annual totals show expenses/refunds consistently, including after disabling signs', () => {
  const file = '../app/src/views/Detail.tsx';
  const source = extractUiFunction(new URL(file, import.meta.url), 'Charges').split('function Charges(')[1];
  const Charges = load(file, 'Charges', `function Charges(${source}`, {
    React,
    Fragment: React.Fragment,
    // 两个状态：「显示全部」为真，展开的年份为全部年份，年度小计都能看到
    useState: (initial: unknown) => (typeof initial === 'function' ? [new Set(['2025', '2026']), () => {}] : [true, () => {}]),
    YearLedger: yearLedger({
      useState: (initial: unknown) => (typeof initial === 'function' ? [new Set(['2025', '2026']), () => {}] : [true, () => {}]),
      t: (key: string) => key,
    }),
    phaseSubs,
    isPostpaid: billing.isPostpaid,
    chargeDay: billing.chargeDay,
    periodLabel: (p: { from: string }) => p.from,
    chargeServicePeriod: billing.chargeServicePeriod,
    addDays: billing.addDays,
    cnDate: (d: string) => d,
    chargeValue,
    chargeBaseOrNaN,
    diffDays,
    relDays,
    flow,
    t: (key: string) => key,
    Panel: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children),
    PayBadge: () => null,
    methodOf: () => undefined,
    cnDateFull,
    chargeMethodId: billing.chargeMethodId,
    YearMethods: () => null,
    currencyTotals,
    ChargeMethods: () => null,
    chargeMethodIds: () => [],
    copyParts: (v: unknown) => v,
    addMonths,
  });
  const sub = {
    id: 'fictional',
    name: 'Test',
    price: 20,
    currency: 'USD',
    start: '2025-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    tags: [],
    category: 'tools',
  };
  const state = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [sub] };
  const history = [
    // 年份行只在超过 12 笔且跨年时出现：2025 年 12 笔，加上 2026 年两笔，才有年度小计
    ...Array.from({ length: 12 }, (_, i) => ({ sub, date: `2025-${String(i + 1).padStart(2, '0')}-01`, amount: 20, currency: 'USD' })),
    { sub, date: '2026-01-01', amount: 10, currency: 'USD' },
    { sub, date: '2026-01-02', amount: -15, currency: 'USD', kind: 'refund' },
  ];
  for (const on of [true, false]) {
    setSignedAmounts(on);
    const html = renderToStaticMarkup(React.createElement(Charges, { sub, state, today: '2026-10-22', history, onRow() {} }));
    assert.ok(html.includes('dt-row '));
    assert.ok(html.includes('refund'));
    const content = text(html);
    assert.ok(content.includes(`${on ? '−' : ''}$20.00`));
    assert.ok(content.includes(`${on ? '+' : ''}$15.00`));
    assert.ok(content.includes(`${on ? '+' : ''}$5.00`));
    if (!on) assert.ok(!/[+−]/.test(content));
    assert.ok(html.includes('dt-in')); // Net-refund annual subtotal stays green with signs off.
  }
  // 后付费：每笔按所属周期显示、分年，扣款日只进悬停提示，不加第二行撑高行
  const power = { ...sub, id: 'fictional-power', billing: 'postpaid' };
  const bills = Array.from({ length: 13 }, (_, i) => ({ sub: power, date: billing.addMonths('2025-02-01', i), amount: 20, currency: 'USD' }));
  const post = renderToStaticMarkup(React.createElement(Charges, { sub: power, state, today: '2026-10-22', history: bills, onRow() {} }));
  assert.ok(post.includes('<time dateTime="2025-12-31">2025-12-01</time>'));
  assert.ok(!post.includes('</time><small'));
  assert.ok(post.includes('detail.chart.period'));
  assert.ok(post.includes('title="detail.charges.paidOn"'));
});

test('Detail charge history groups every year when one year has multiple rows, and sparse years stay directly editable', () => {
  const file = '../app/src/views/Detail.tsx';
  const source = extractUiFunction(new URL(file, import.meta.url), 'Charges').split('function Charges(')[1];
  // 组件里有两个状态（显示全部、展开的年份）：按调用顺序存，重新渲染时沿用
  let values: unknown[] = [];
  let cursor = 0;
  const hook = (initial: unknown) => {
    const i = cursor++;
    if (!(i in values)) values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [values[i], (v: unknown) => (values[i] = v)];
  };
  const Charges = load(file, 'Charges', `function Charges(${source}`, {
    React,
    Fragment: React.Fragment,
    useState: hook,
    YearLedger: yearLedger({ useState: hook, t: (key: string, args?: { count?: number; year?: string }) => `${key}:${args?.count ?? args?.year ?? ''}` }),
    phaseSubs,
    isPostpaid: billing.isPostpaid,
    chargeDay: billing.chargeDay,
    periodLabel: (p: { from: string }) => p.from,
    chargeServicePeriod: billing.chargeServicePeriod,
    addDays: billing.addDays,
    cnDate: (d: string) => d,
    chargeValue,
    chargeBaseOrNaN,
    addMonths,
    flow,
    t: (key: string, args?: { count?: number; year?: string }) => `${key}:${args?.count ?? args?.year ?? ''}`,
    Panel: ({ children, title }: { children: React.ReactNode; title: string }) => React.createElement('section', null, title, children),
    PayBadge: () => React.createElement('i', { 'data-pay': '' }),
    methodOf: () => undefined,
    cnDateFull,
    chargeMethodId: billing.chargeMethodId,
    YearMethods: () => null,
    currencyTotals,
    ChargeMethods: () => React.createElement('i', { 'data-pay': '' }),
    chargeMethodIds: () => [],
    copyParts: (v: unknown) => v,
  });
  const sub = {
    id: 'fictional-history',
    name: 'Fictional monthly',
    price: 12,
    currency: 'USD',
    start: '2020-01-15',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    tags: [],
    category: 'tools',
  };
  const state = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [sub] };
  const monthly = (n: number, from = 2020) =>
    Array.from({ length: n }, (_, i) => ({
      sub,
      date: `${from + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-15`,
      amount: 12,
      currency: 'USD',
    }));
  const today = '2026-10-22';
  const tree = (history: unknown[]) => {
    cursor = 0;
    return Charges({ sub, state, today, history });
  };
  const html = (history: unknown[]) => {
    cursor = 0;
    return renderToStaticMarkup(React.createElement(Charges, { sub, state, today, history }));
  };
  const count = (h: string) => (h.match(/class="ld-row dt-row/g) ?? []).length;
  const years = (h: string) => (h.match(/class="ld-row ld-year"/g) ?? []).length;
  const find = (node: React.ReactNode, test: (p: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => {
    if (!React.isValidElement(node)) return;
    // 表格本体是 YearLedger 组件：展开它渲染出的元素再找
    if (typeof node.type === 'function') return find((node.type as (p: unknown) => React.ReactNode)(node.props), test);
    const props = node.props as Record<string, unknown> & { children?: React.ReactNode };
    if (test(props)) return props;
    for (const child of React.Children.toArray(props.children)) {
      const found = find(child, test);
      if (found) return found;
    }
  };

  // 同年多条也按年聚合：点击表头后显示明细，日期与支付方式不变
  const recent = monthly(10, 2026);
  values = [];
  let h = html(recent);
  assert.equal(years(h), 1);
  assert.equal(count(h), 0);
  const recentHead = find(tree(recent), (p) => String(p.className ?? '').includes('ld-toggle'))!;
  (recentHead.onClick as () => void)();
  h = html(recent);
  assert.equal(count(h), 10);
  // 每一行都写支付方式
  assert.equal((h.match(/data-pay/g) ?? []).length, 10);
  assert.doesNotMatch(h, /detail\.charges\.all/);
  // 日期写全，不再写「几天前」
  assert.match(h, /date[tT]ime="2026-10-15"/);
  assert.doesNotMatch(text(h), /detail\.ev|relDays|ago|天前|个月前/);

  // 82 笔跨七年：按年分组，打开时全部折叠，只看年份小计
  const long = monthly(82);
  values = [];
  h = html(long);
  assert.equal(years(h), 7);
  assert.equal(count(h), 0);
  assert.match(text(h), /detail\.charges\.title/);
  assert.doesNotMatch(text(h), /detail\.charges\.title:82/);
  const textOf = (node: React.ReactNode): string =>
    typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : React.isValidElement(node)
        ? React.Children.toArray((node.props as { children?: React.ReactNode }).children)
            .map(textOf)
            .join('')
        : Array.isArray(node)
          ? node.map(textOf).join('')
          : '';
  const yearRow = (y: string, expanded: boolean) =>
    find(tree(long), (p) => p['aria-expanded'] === expanded && textOf(p.children as React.ReactNode).includes(`calendar.yearTitle:${y}`))!;
  // 点 2025 年展开这一年的 12 笔，再点收起
  (yearRow('2025', false).onClick as () => void)();
  assert.equal(count(html(long)), 12);
  (yearRow('2025', true).onClick as () => void)();
  assert.equal(count(html(long)), 0);
  // 点表头：全部展开，再点全部收起
  const head = () => find(tree(long), (p) => typeof p.onClick === 'function' && String(p.className ?? '').includes('ld-toggle'))!;
  (head().onClick as () => void)();
  assert.equal(count(html(long)), 82);
  (head().onClick as () => void)();
  assert.equal(count(html(long)), 0);
  // 每年各一笔：直接平铺，没有年份行或聚合按钮
  values = [];
  h = html([...monthly(1, 2025).map((c) => ({ ...c, date: '2025-12-15' })), ...monthly(1, 2026)]);
  assert.equal(years(h), 0);
  assert.equal(count(h), 2);
  assert.ok(!h.includes('ld-toggle table-head'));

  // 没有记录：没有表格，也没有展开按钮
  values = [];
  assert.equal(count(html([])), 0);
  assert.ok(!html([]).includes('aria-expanded'));
});

test('shared-plan avatars retain owner images, initials, dues colors and overflow in both sizes', async () => {
  const { collectCurrencyOf, memberAboard, memberDues } = await import('./billing.ts');
  const file = '../app/src/components/ShareAvatars.tsx';
  const source = read(file).split('export function ShareAvatars(')[1];
  const PersonAvatar = load(
    '../app/src/components/PersonAvatar.tsx',
    'PersonAvatar',
    read('../app/src/components/PersonAvatar.tsx').split('/** Shared private-person')[1].split('*/')[1],
    { React, useState: React.useState, colorFor, isCustomColor },
  );
  const ShareAvatars = load(file, 'ShareAvatars', `function ShareAvatars(${source}`, {
    React,
    memberAboard,
    memberDues,
    collectCurrencyOf,
    PersonAvatar,
    personFor: (state: AppState, id: string, name: string) => state.people?.find((p) => p.id === id) ?? { id, name },
    base: (path: string) => path,
    t: (key: string) => key,
  });
  const sub = {
    id: 'fictional-sharing',
    name: 'Fictional sharing',
    price: 12,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    tags: [],
    category: 'tools',
    share: {
      role: 'owner',
      seats: 12,
      since: '2026-01-01',
      members: Array.from({ length: 9 }, (_, i) => ({
        id: `member-${i}`,
        name: i === 0 ? '' : `Name ${i}`,
        share: 1,
        exempt: i === 2,
        // 第 2 位提前付到了 2027 年底
        receipts:
          i === 1
            ? [
                {
                  id: 'o',
                  date: '2026-01-01',
                  amount: 0,
                  currency: 'USD',
                  periods: Array.from({ length: 24 }, (_, k) => addMonths('2026-01-01', k)),
                  opening: true,
                },
              ]
            : undefined,
        left: i === 8 ? '2026-02-01' : undefined,
      })),
    },
  };
  const state = { settings: { ...DEFAULT_SETTINGS, avatar: 'https://example.invalid/fictional.png' }, fx: FALLBACK_FX, methods: [], subscriptions: [sub] };
  const render = (size: number, overlap: number, onMember?: () => void) =>
    renderToStaticMarkup(React.createElement(ShareAvatars, { sub, state, today: '2026-10-22', size, overlap, onMember }));
  const card = render(20, 3, () => {});
  const detail = render(36, 2);
  assert.equal(text(card), text(detail));
  assert.ok(text(card).endsWith('+4'));
  assert.ok(text(card).includes('?'));
  assert.ok(card.includes('seat on'));
  assert.ok(card.includes('seat owe'));
  assert.ok(card.includes('seat free'));
  assert.ok(card.includes('fictional.png'));
  assert.ok(!card.includes('Name 8'));
  assert.ok(card.includes('<button'));
  assert.ok(!detail.includes('<button'));
  state.settings.avatar = '';
  assert.ok(render(36, 2).includes('/icons/avatar.png'));
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const linked = { ...sub, share: { ...sub.share, members: sub.share.members.map((m, i) => (i === 1 ? { ...m, personId: 'person' } : m)) } };
  const linkedState = { ...state, people: [{ id: 'person', name: 'Linked person', avatar }] };
  const linkedHtml = renderToStaticMarkup(React.createElement(ShareAvatars, { sub: linked, state: linkedState, today: '2026-10-22' }));
  assert.ok(linkedHtml.includes(avatar));
  linkedState.people[0].avatar = 'https://tracking.invalid/avatar.png';
  const remoteHtml = renderToStaticMarkup(React.createElement(ShareAvatars, { sub: linked, state: linkedState, today: '2026-10-22' }));
  assert.ok(!remoteHtml.includes('tracking.invalid'));
});

test('Detail leads with state-aware cells, puts the next charge first, and lays out one column', () => {
  const file = '../app/src/views/Detail.tsx';
  const source = read(file);
  const empty = () => null;
  const Panel = ({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) =>
    React.createElement('section', { className }, title, children);
  const deps = {
    React,
    Fragment: React.Fragment,
    ...billing,
    ...transfers,
    detailForecast,
    detailHistoryEnd,
    money,
    cnDateFull,
    relDays,
    flow,
    chargeValue,
    chargeBaseOrNaN,
    t: (key: string) => key,
    useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, empty],
    useRef: () => ({ current: null }),
    useMoneyPair: () => (amount: number, currency: string) => ({ main: money(amount, currency), alt: '≈ ¥766.18' }),
    TONE: {},
    methodOf: empty,
    presetCat: () => 'phone',
    Panel,
    Prop: ({ k, children, hint }: { k: string; children: React.ReactNode; hint?: string }) => React.createElement('div', null, k, children, hint),
    Act: empty,
    CopyImageButton: empty,
    Sheet: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    IconButton: empty,
    regular: (h: { kind?: string; amount: number }[]) => h.filter((c) => !c.kind && c.amount > 0),
    SubIcon: empty,
    CatChip: empty,
    Region: empty,
    X: empty,
    CircleStop: empty,
    Pencil: empty,
    Pause: empty,
    Play: empty,
    Plus: empty,
    Share: empty,
    Timeline: empty,
    timelineAxis: () => ({ range: 'all', drawn: false }),
    PeriodBar: empty,
    Charges: empty,
    Transfers: empty,
    Meters: empty,
    Outcome: empty,
    Notices: empty,
    ShareCard: empty,
    Note: empty,
    Events: empty,
    PayBadge: empty,
    RegionTag: empty,
    subRegion: (s: { region?: string }) => s.region,
  };
  const Kpis = load(file, 'Kpis', extractUiFunction(new URL(file, import.meta.url), 'Kpis'), {
    ...deps,
    cnDateAuto,
    copyParts: (v: unknown) => v,
    MetricCards: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    Metric: ({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) => React.createElement('div', null, label, value, note),
    Trend: empty,
    toBase: (_s: AppState, n: number) => n,
  });
  const Summary = load(file, 'Summary', extractUiFunction(new URL(file, import.meta.url), 'Summary'), {
    ...deps,
    cnDateAuto,
    Note: empty,
    collectNow: () => undefined,
  });
  const Charges = load(file, 'Charges', extractUiFunction(new URL(file, import.meta.url), 'Charges'), {
    ...deps,
    Seg: empty,
    copyParts: (v: unknown) => v,
    YearMethods: empty,
    currencyTotals,
    ChargeMethods: empty,
    chargeMethodIds: () => [],
    YearLedger: yearLedger({ useState: React.useState, t: deps.t }),
  });
  const Detail = load(file, 'Detail', extractUiFunction(new URL(file, import.meta.url), 'Detail'), {
    ...deps,
    Summary,
    NoteBlock: empty,
    Kpis,
    Charges,
    Maximize2: empty,
    DetailHead: load('../app/src/components/DetailKit.tsx', 'DetailHead', read('../app/src/components/DetailKit.tsx').replace(/^import[\s\S]*?;\n/gm, ''), {
      React,
      t: (key: string) => key,
      IconButton: empty,
      X: empty,
      CircleStop: empty,
      Icon: empty,
      use: React.use,
      SheetNested: React.createContext(false),
    }),
    DetailSheet: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  });
  for (const [unit, end] of [['year'], ['month'], ['lifetime'], ['month', '2026-07-01']] as const) {
    const sub: Subscription = {
      id: 'fictional-renewal',
      name: 'Fictional plan',
      price: 99,
      currency: 'EUR',
      cycle: { unit, every: 1 },
      start: '2025-12-15',
      end,
      status: 'active',
      category: 'tools',
      tags: [],
    };
    const state: AppState = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [sub] };
    const props = { sub, state, today: '2026-10-22', onEdit: empty, onClose: empty, onCar: empty };
    const html = renderToStaticMarkup(React.createElement(Detail, props));
    const header = html.split('class="dt-meta"')[1].split('</header>')[0];
    assert.ok(text(header).includes('€99.00'));
    assert.ok(text(header).includes('≈ ¥766.18'));
    // 下次扣款在指标里，摘要只放支付方式、日期等，不重复
    const summary = text(renderToStaticMarkup(React.createElement(Summary, props)));
    assert.ok(!summary.includes('detail.ev.next'));
    assert.ok(!summary.includes('€99.00'));
    // 下次扣款的日期、金额与倒计时在顶部第一格；买断与已结束的没有下一笔
    const history = billing.chargesBetween(sub, sub.start, props.today, props.today);
    const cells = text(renderToStaticMarkup(React.createElement(Kpis, { ...props, history })));
    if (unit === 'lifetime' || end) {
      assert.ok(!cells.includes('detail.ev.next'));
    } else {
      const charge = detailForecast(sub, props.today).charges[0];
      assert.ok(cells.includes('detail.ev.next'));
      assert.ok(cells.includes(cnDateAuto(charge.date, props.today)));
      assert.ok(cells.includes(relDays(diffDays(props.today, charge.date))));
    }
    // 一份扣款记录；单列，没有侧栏
    assert.equal((html.match(/class="dt-charges[ "]/g) ?? []).length, 1);
    assert.ok(!html.includes('dt-side'));
    assert.equal(html.includes('dt compact'), unit === 'lifetime' || unit === 'year');
  }
  const undated: Subscription = {
    id: 'fictional-undated-stop',
    name: 'Fictional stopped plan',
    price: 20,
    currency: 'EUR',
    cycle: { unit: 'month', every: 3 },
    start: '2021-10-30',
    status: 'cancelled',
    category: 'tools',
    tags: [],
    payments: [
      { date: '2021-10-30', amount: 20 },
      { date: '2023-07-30', amount: 20 },
    ],
  };
  const undatedState = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [undated] };
  const undatedProps = { sub: undated, state: undatedState, today: '2026-10-22' };
  const undatedSummary = text(renderToStaticMarkup(React.createElement(Summary, undatedProps)));
  assert.ok(undatedSummary.includes('detail.field.endedUnknown'));
  assert.ok(!undatedSummary.includes('detail.field.present'));
  const undatedCells = text(
    renderToStaticMarkup(
      React.createElement(Kpis, {
        ...undatedProps,
        history: billing.chargesBetween(undated, undated.start, undatedProps.today, undatedProps.today),
      }),
    ),
  );
  assert.ok(undatedCells.includes('detail.field.endedUnknown'));
  assert.ok(!undatedCells.includes('detail.period.since'));
  assert.ok(!undatedCells.includes('detail.kpi.perDay'));
  // Fictional annual plans: ordinary renewals plus commissions recorded as negative charges.
  const annual: Subscription = {
    id: 'fictional-annual-commissions',
    name: 'Fictional annual with credits',
    price: 120,
    currency: 'EUR',
    cycle: { unit: 'year', every: 1 },
    start: '2020-01-15',
    status: 'active',
    category: 'tools',
    tags: [],
  };
  for (const [count, start, today] of [
    [3, '2020-01-15', '2026-10-22'], // Four charges + year heading = five rows.
    [4, '2020-01-15', '2026-10-22'], // Five charges + year heading = six rows.
    [8, '2020-01-15', '2026-10-22'], // Reported case: nine charges, mostly commissions.
    [4, '2026-01-15', '2026-10-22'], // Only one renewal: no trend line, compact single column keeps charges in the main flow.
    [5, '2026-01-15', '2026-10-22'],
    [3, '2020-01-15', '2027-01-01'], // Latest populated year is the default after ending.
    [4, '2020-01-15', '2027-01-01'],
  ] as const) {
    const sub: Subscription = {
      ...annual,
      start,
      end: '2026-12-31',
      payments: [
        ...Array.from({ length: 2027 - Number(start.slice(0, 4)) }, (_, i) => ({ date: `${Number(start.slice(0, 4)) + i}-01-15`, amount: 120 })),
        ...Array.from({ length: count }, (_, i) => ({ date: `2026-${String(i + 2).padStart(2, '0')}-02`, amount: -5 })),
      ],
    };
    const state: AppState = { settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, methods: [], subscriptions: [sub] };
    const html = renderToStaticMarkup(React.createElement(Detail, { sub, state, today, onEdit: empty, onClose: empty }));
    assert.equal((html.match(/class="dt-charges[ "]/g) ?? []).length, 1, `${count} credits from ${start} at ${today}`);
    // 任意一年多条就统一分组并全部折叠（只见年份小计）
    const charges = billing.chargesBetween(sub, sub.start, today, today);
    const grouped = shouldGroupYears(charges, (c) => c.date);
    assert.equal((html.match(/class="ld-row dt-row/g) ?? []).length, grouped ? 0 : charges.length);
    // 这张表里欧元金额都是整数，原币不写 .00（平铺时看单笔返佣，分组时看年份小计）
    if (!grouped) assert.ok(/\+[$€]5(\.00)?(?!\d)/.test(text(html)));
    else assert.ok(!/[$€]\d[\d,]*\.00/.test(text(html.split('class="ld-table')[1] ?? '')));
  }
});

test('detail timeline forecasts only the next charge, for monthly and yearly plans alike', () => {
  const file = '../app/src/views/detail/ChargeTimeline.tsx';
  const url = new URL(file, import.meta.url);
  const timelineAxis = load(file, 'timelineAxis', `${extractUiFunction(url, 'barDay')}\n${extractUiFunction(url, 'timelineAxis')}`, {
    ...billing,
    detailForecast,
    detailHistoryEnd,
    regular: (h: billing.Charge[]) => h.filter((c) => !c.kind && c.amount > 0),
    t: (k: string) => k,
  });
  const today = '2026-11-02';
  const base: Subscription = {
    id: 'f',
    name: 'Fictional',
    category: 'tools',
    tags: [],
    price: 10,
    currency: 'USD',
    start: '2025-01-05',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
  };
  for (const sub of [base, { ...base, cycle: { unit: 'year' as const, every: 1 } }]) {
    const history = billing.chargesBetween(sub, sub.start, today, today);
    const ax = timelineAxis(sub, today, history);
    assert.equal(ax.future.length, 1, sub.cycle.unit);
    assert.equal(ax.future[0].date, detailForecast(sub, today).charges[0].date);
  }
});

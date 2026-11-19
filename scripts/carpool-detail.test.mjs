import * as fxTotals from '../shared/fx-total.ts';
import { readUiSource } from './ui-test-source.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsers } from 'prettier/plugins/typescript';
import { transformSync } from 'oxc-transform-react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as billing from '../shared/billing.ts';
import * as carpool from '../shared/carpool.ts';
import * as fx from '../shared/fx.ts';
import * as format from '../shared/format.ts';
import { carpoolRoster, carpoolTimeline } from '../shared/carpool-timeline.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { flatten, setLocale, t } from '../shared/i18n.ts';

const source = readUiSource(new URL('../app/src/views/Carpool.tsx', import.meta.url));
const ast = await parsers.typescript.parse(source);
const nodes = ast.body.map((n) => n.declaration ?? n);
const locales = ['family', 'detail', 'calendar', 'core'].reduce((all, ns) => {
  return { ...all, ...flatten(ns, JSON.parse(readFileSync(new URL(`../shared/locales/en/${ns}.json`, import.meta.url), 'utf8'))) };
}, {});
setLocale('en', [locales]);
const today = '2026-10-23';
const m = (id, extra = {}) => ({ id, name: id, joined: '2026-10-01', share: 10, fee: 10, feeCurrency: 'CNY', billEvery: 1, ...extra });
const sub = (members, seats = 4) => ({
  id: 's',
  name: 'Fictional plan',
  price: 30,
  currency: 'CNY',
  start: '2026-10-01',
  cycle: { unit: 'month', every: 1 },
  status: 'active',
  tags: [],
  category: '',
  share: { role: 'owner', seats, since: '2026-10-01', rule: { billEvery: 1, fee: 10, currency: 'CNY' }, members },
});
const state = {
  subscriptions: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
  fx: { base: 'USD', rates: { CNY: 7, USD: 1 }, fetchedAt: today },
  methods: [],
};
// 合租详情的指标卡（MetricCards 里的每一格）
const metricCells = (html) => (html.split('class="metric-cards"')[1] ?? '').split('car-sheet-sec')[0].split('<small>').length - 1;
const passthrough = ({ children }) => React.createElement('span', null, children);
const DetailHead = ({ title, badge, meta, actions }) => React.createElement('header', null, title, badge, meta, actions);
const Panel = ({ title, children }) => React.createElement('section', null, title, children);
const noop = () => null;
function compile(names, extra = {}) {
  const dependencies = {
    React,
    Fragment: React.Fragment,
    useState: React.useState,
    useRef: React.useRef,
    ...billing,
    ...carpool,
    ...format,
    ...fx,
    ...fxTotals,
    carpoolRoster,
    carpoolTimeline,
    t,
    copyParts: (text) => text,
    tx: (key, parts) => React.createElement(React.Fragment, null, t(key, { amount: '' }), parts.amount),
    perBill: (key, months, values = {}) => t(key, { ...values, count: months }),
    personFor: (st, id, name) => ({ id, name }),
    PersonAvatar: () => React.createElement('i', { 'data-avatar': true }),
    memberStatus: () => ({ owe: true, late: 0, owed: '10', gone: false }),
    MemberTimeline: noop,
    TimelineAxis: noop,
    DepartedToggle: noop,
    MemberTable: noop,
    MemberRows: noop,
    OwnerSeat: noop,
    Sheet: passthrough,
    DetailSheet: passthrough,
    CarMembers: noop,
    DetailHead,
    Panel,
    NameLink: passthrough,
    CardTitle: passthrough,
    StatusPill: passthrough,
    SubIcon: noop,
    Icon: noop,
    IconButton: noop,
    CopyImageButton: noop,
    MetricCards: ({ children }) => React.createElement('div', { className: 'metric-cards' }, children),
    Eye: noop,
    EyeOff: noop,
    Seg: noop,
    YearLedger: noop,
    YearMethods: noop,
    currencyTotals: (rows, amountOf, fmt) => {
      const m = new Map();
      for (const r of rows) {
        const { currency, amount } = amountOf(r);
        m.set(currency, (m.get(currency) ?? 0) + amount);
      }
      return [...m].map(([c, n]) => fmt(n, c)).join('\n');
    },
    PayBadge: noop,
    useTimelinePan: noop,
    tipProps: () => ({}),
    collectNow: () => undefined,
    contractNow: () => undefined,
    PeriodPair: noop,
    PeriodBar: noop,
    periodLive: () => false,
    TabLabel: noop,
    ...extra,
  };
  // 成员头像统一经过 MemberAvatar（打码在那里处理），每个组件都要带上它
  const functions = [...names, 'MemberAvatar']
    .map((name) => source.slice(...nodes.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name).range))
    .join('\n');
  const compiled = transformSync('Carpool.tsx', functions, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(compiled.fatal, false);
  return new Function(...Object.keys(dependencies), `${compiled.code}; return {${names.join(',')}};`)(...Object.values(dependencies));
}

test('空位整行支持点击与键盘', () => {
  const { Vacancy } = compile(['Vacancy']);
  let opened = 0;
  for (const table of [false, true]) {
    const editable = Vacancy({ table, onAdd: () => opened++ });
    editable.props.onClick();
    editable.props.onKeyDown({ key: 'Enter', target: null, currentTarget: null, preventDefault() {} });
    assert.equal(editable.props.tabIndex, 0);
    assert.match(renderToStaticMarkup(editable), /Currently vacant/);
  }
  assert.equal(opened, 4);
});

test('详情按分摊成员、不分摊、已下车排序，空位永远在最后；满员没有添加入口', () => {
  const { MemberTable } = compile(['MemberTable', 'Vacancy']);
  // 四座：车主、分摊成员、不分摊成员各占一座，余一个空位
  const s = sub([m('exempt', { exempt: true }), m('departed', { left: today }), m('paying')], 4);
  const props = { state, s, today, win: carpoolTimeline(s, today, 1), ro: false, expanded: true, masked: false, onMember() {}, onToggle() {} };
  const html = renderToStaticMarkup(React.createElement(MemberTable, props));
  // 空位永远最后：分摊、不分摊、已退出，然后才是空位
  assert.ok(html.indexOf('aria-label="paying"') < html.indexOf('aria-label="exempt"'));
  assert.ok(html.indexOf('aria-label="exempt"') < html.indexOf('aria-label="departed"'));
  assert.ok(html.indexOf('aria-label="departed"') < html.indexOf('class="car-vacancy'));
  const full = { ...s, share: { ...s.share, seats: 3 } };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(MemberTable, { ...props, s: full })), /car-vacancy|Add member/);
});

test('打码移除真实头像、个人悬停提示和读屏称呼；手机自由备注也隐藏', () => {
  const tips = [];
  const { MemberTable, MemberRows } = compile(['MemberTable', 'MemberRows', 'Vacancy'], {
    tipProps: (render) => {
      tips.push(render);
      return {};
    },
  });
  const s = sub([m('Private Name', { account: 'private@example.test', exempt: true, note: 'Private Note' })], 1);
  const props = { state, s, today, win: carpoolTimeline(s, today, 1), ro: false, expanded: false, onMember() {}, onToggle() {} };
  const open = renderToStaticMarkup(React.createElement(MemberTable, { ...props, masked: false }));
  assert.match(open, /data-avatar/);
  assert.match(renderToStaticMarkup(tips[0]()), /private@example.test/);
  tips.length = 0;
  const masked = renderToStaticMarkup(React.createElement(MemberTable, { ...props, masked: true }));
  assert.equal(tips.length, 0);
  assert.doesNotMatch(masked, /data-avatar|aria-label="Private Name"|private@example.test/);
  assert.match(masked, /car-private.*?aria-hidden="true"/);
  const mobile = renderToStaticMarkup(React.createElement(MemberRows, { ...props, masked: true }));
  assert.doesNotMatch(mobile, /Private Note|data-avatar/);
});

test('打码时收款表的年度胶囊、头像叠放与每行胶囊都不出现真实头像', () => {
  let call = 0;
  const YearLedger = () => null;
  const { CarSheet } = compile(['CarSheet', 'Vacancy'], {
    // 第一个状态是打码开关：直接打开
    useState: (value) => [call++ === 0 ? true : value, () => {}],
    useRef: () => ({ current: null }),
    YearLedger,
  });
  const find = (node) => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (node.type === YearLedger) return node.props;
    return find(node.props?.children);
  };
  const receipts = [{ id: 'r', date: '2026-10-05', amount: 10, currency: 'CNY', periods: ['2026-10-01'] }];
  for (const members of [[m('Solo', { receipts })], [m('Alpha', { receipts }), m('Beta', { receipts })]]) {
    const s = sub(members);
    call = 0;
    const ledger = find(CarSheet({ state, s, today, ro: false, book: carpool.carLedger(state, s, today), onClose() {}, onOpenSub() {}, onMember() {} }));
    assert.ok(ledger?.keepSecond);
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null, ledger.yearCells(ledger.items).second, ...ledger.items.map((r) => ledger.row(r).second)),
    );
    assert.doesNotMatch(html, /data-avatar/);
    assert.match(html, /car-private-avatar/);
  }
  // 合租视图里真实头像只在 MemberAvatar 一处渲染
  assert.equal(source.match(/<PersonAvatar\b/g).length, 1);
});

test('详情复用累计实付、净收款与盈亏；待收为零时只呈现三格且不重复累计总额', () => {
  const { CarSheet } = compile(['CarSheet', 'Vacancy']);
  for (const settled of [false, true]) {
    const s = sub([
      m('payer', {
        // 结清时这笔收了 10 至 12 月三期；没结清时只抵了 11、12 月，10 月这期还欠着
        receipts: [
          {
            id: 'r',
            date: '2026-10-01',
            amount: 100,
            currency: 'CNY',
            periods: settled ? ['2026-10-01', '2026-11-01', '2026-12-01'] : ['2026-11-01', '2026-12-01'],
          },
        ],
        leaveRefund: { date: today, amount: 20, currency: 'CNY' },
      }),
    ]);
    const book = carpool.carLedger(state, s, today);
    const html = renderToStaticMarkup(React.createElement(CarSheet, { state, s, today, ro: false, book, onClose() {}, onOpenSub() {}, onMember() {} }));
    assert.equal(metricCells(html), settled ? 3 : 4);
    assert.equal((html.match(/<small>Paid<\/small>/g) ?? []).length, 1);
    assert.equal((html.match(/<small>Received<\/small>/g) ?? []).length, 1);
    assert.match(html, new RegExp(format.flow(book.received, 'CNY', { compact: true }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, new RegExp(format.flow(-book.net, 'CNY', { compact: true }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /class="done"/);
  }
});

test('零盈亏保持中性，亏损为红色，缺失汇率不隐藏尚未确认的待收', () => {
  const { CarSheet } = compile(['CarSheet', 'Vacancy']);
  const s = sub([m('payer')]);
  const render = (st, book) =>
    renderToStaticMarkup(React.createElement(CarSheet, { state: st, s, today, ro: false, book, onClose() {}, onOpenSub() {}, onMember() {} }));
  const book = carpool.carLedger(state, s, today);
  assert.match(render(state, book), /class="loss"/);
  assert.doesNotMatch(render(state, { ...book, net: 0 }), /class="loss"|class="done"/);
  const unavailable = { ...state, settings: { ...state.settings, baseCurrency: 'USD' }, fx: { base: 'USD', rates: {}, fetchedAt: today } };
  const html = render(unavailable, carpool.carLedger(unavailable, s, today));
  assert.equal(metricCells(html), 4);
  assert.match(html, /Unconverted/);
});

test('合租图片入口在头部，沿用当前 summary 和打码状态', async () => {
  const sourceNode = {};
  let captured;
  const CopyImageButton = () => null;
  const { CarSheet } = compile(['CarSheet', 'Vacancy'], {
    useRef: () => ({ current: sourceNode }),
    useState: (value) => [value, () => {}],
    CopyImageButton,
    carpoolSnapshot: async (node) => {
      captured = node;
      return new Blob(['PNG']);
    },
  });
  const s = sub([]);
  const tree = CarSheet({ state, s, today, ro: false, book: carpool.carLedger(state, s, today), onClose() {}, onOpenSub() {}, onMember() {} });
  const [root] = React.Children.toArray(tree.props.children);
  const head = React.Children.toArray(root.props.children).find((node) => node.type === DetailHead);
  const actions = React.Children.toArray(head.props.actions.props.children);
  const copy = actions.find((node) => node.type === CopyImageButton);
  assert.ok(copy);
  await copy.props.render();
  assert.equal(captured, sourceNode);
  assert.ok(actions.some((node) => node.props['aria-pressed'] === false));
});

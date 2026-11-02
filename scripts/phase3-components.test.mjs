import * as fxTotals from '../shared/fx-total.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import { extractUiFunction } from './ui-test-source.ts';
import { currentPhase } from '../shared/billing.ts';
import * as formatMod from '../shared/format.ts';

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment' };
function component(file, name, deps) {
  deps = { ...fxTotals, ...deps };
  const code = transformSync(name + '.tsx', extractUiFunction(new URL('../app/src/views/' + file, import.meta.url), name), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  }).code.replace(/export /g, '');
  return new Function('React', ...Object.keys(deps), code + ';return ' + name)(React, ...Object.values(deps));
}

test('proxy card price stays in the current phase when a future plan is scheduled', () => {
  const amounts = [];
  const noop = () => null;
  const deps = {
    currentPhase,
    useState: (v) => [v, noop],
    todayIn: () => '2026-10-25',
    rows: () => [],
    proxyAhead: noop,
    nextCharge: noop,
    addDays: noop,
    proxyTotals: () => ({
      open: [],
      charged: 0,
      received: 0,
      partial: { charged: fxTotals.emptyTotal(), received: fxTotals.emptyTotal(), diff: fxTotals.emptyTotal() },
    }),
    moneyDecimals: () => 0,
    effectiveStatus: () => 'active',
    isStopped: () => false,
    proxyStatus: () => ['', ''],
    money: (v, c) => {
      amounts.push([v, c]);
      return String(v);
    },
    flow: String,
    cycleLabel: () => '',
    copyParts: String,
    cnDate: String,
    t: String,
    personFor: noop,
    contactText: noop,
  };
  for (const key of ['SubIcon', 'NameLink', 'StatusPill', 'PersonAvatar', 'PayBadge', 'MetricCards', 'Metric', 'OwedOrNet', 'LedgerSheet']) deps[key] = key;
  const ProxyCard = component('Proxy.tsx', 'ProxyCard', deps);
  ProxyCard({
    state: { settings: { baseCurrency: 'CNY' }, methods: [] },
    s: {
      id: 's',
      name: 'Fictional future plan',
      start: '2026-01-01',
      price: 999,
      currency: 'EUR',
      cycle: { unit: 'month', every: 1 },
      proxy: {},
      phases: [
        { start: '2026-01-01', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
        { start: '2026-12-01', price: 999, currency: 'EUR', cycle: { unit: 'month', every: 1 }, planned: true },
      ],
    },
  });
  assert.deepEqual(amounts, [[10, 'USD']]);
});

test('proxy card metrics share one precision: a cents-only profit keeps the large totals to the cent too', () => {
  const noop = () => null;
  const cny = (v) => fxTotals.amountTotal(v, 'CNY', v);
  const render = (charged, received) => {
    const deps = {
      currentPhase,
      useState: (v) => [v, noop],
      todayIn: () => '2026-10-25',
      rows: () => [],
      proxyAhead: noop,
      nextCharge: noop,
      proxyTotals: () => ({ open: [], partial: { charged: cny(charged), received: cny(received), diff: cny(received - charged) } }),
      moneyDecimals: formatMod.moneyDecimals,
      effectiveStatus: () => 'active',
      isStopped: () => false,
      proxyStatus: () => ['', ''],
      money: String,
      flow: String,
      cycleLabel: () => '',
      copyParts: String,
      cnDate: String,
      t: String,
      personFor: noop,
      contactText: noop,
    };
    for (const key of ['SubIcon', 'NameLink', 'StatusPill', 'PersonAvatar', 'PayBadge', 'MetricCards', 'Metric', 'OwedOrNet', 'LedgerSheet']) deps[key] = key;
    const found = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'Metric') found.push(n.props.value);
      if (n.type === 'OwedOrNet') found.push(n.props.compact);
      (Array.isArray(n) ? n : [].concat(n.props?.children ?? [])).forEach(walk);
    };
    walk(
      component(
        'Proxy.tsx',
        'ProxyCard',
        deps,
      )({
        state: { settings: { baseCurrency: 'CNY' }, methods: [] },
        s: { id: 's', name: 'Fictional', start: '2026-01-01', price: 10, currency: 'CNY', cycle: { unit: 'month', every: 1 }, proxy: {} },
      }),
    );
    return found;
  };
  // 盈亏 −¥15.20 要写到分：已代付、已收也写到分，不再是 −¥3,567 / +¥3,552 配 −¥15.20
  const [charged, received, compact] = render(3567.31, 3552.11);
  assert.match(charged, /3,567\.31/);
  assert.match(received, /3,552\.11/);
  assert.equal(compact, false);
  // 三格都是整数或都过千且没有零头要写时仍然去掉小数
  assert.deepEqual(render(20, 20), ['−¥20', '+¥20', true]);
});

test('card and row badge rules distinguish empty owners, joined members and scheduled starts', () => {
  const SubBadges = component('List.tsx', 'SubBadges', {
    effectiveStatus: (s) => s.testStatus ?? 'active',
    upcomingPhase: (s) => s.testUp,
    t: String,
    StatusBadges: 'status',
    ProxyBadge: 'proxy',
  });
  const render = (s) => JSON.stringify(SubBadges({ state: {}, s, today: '2026-10-25' }));
  assert.ok(!render({ share: { role: 'owner', members: [] } }).includes('list.badge.share'));
  assert.ok(render({ share: { role: 'owner', members: [{}] } }).includes('list.badge.share'));
  assert.ok(render({ share: { role: 'member' } }).includes('list.badge.joined'));
  assert.ok(render({ proxy: {} }).includes('"type":"proxy"'));
  assert.ok(render({ testStatus: 'upcoming' }).includes('list.status.upcoming'));
  assert.ok(!render({ testStatus: 'upcoming', testUp: {} }).includes('list.status.upcoming'));
});

test('incomplete annual totals keep finite receipt decoration and unavailable percentages', () => {
  const r = { partial: { total: fxTotals.emptyTotal(), bySub: {}, byMonth: {} }, total: NaN, charges: 3, items: [], newSubs: [], ended: [] };
  const Receipt = component('Review.tsx', 'Receipt', {
    copyParts: (v) => v,
    t: String,
    Line: 'line',
    ReviewLoss: 'loss',
    location: { host: 'fictional.invalid' },
  });
  const tree = Receipt({
    r,
    year: '2026',
    whose: '',
    ongoing: true,
    m: (v) => (Number.isFinite(v) ? String(v) : '—'),
    hide: false,
    pct: () => '—',
    byMethod: [],
    today: '2026-10-25',
  });
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    nodes.push(n);
    for (const child of n.props?.children?.flat(Infinity) ?? []) walk(child);
  };
  walk(tree);
  const bars = nodes.find((n) => n.props?.className === 'rp-bars');
  assert.ok(bars.props.children.flat(Infinity).every((n) => Number.isFinite(n.props.style.width)));
  for (const total of [-100, 0]) {
    const other = Receipt({
      r: { ...r, total },
      year: '2026',
      whose: '',
      ongoing: true,
      m: String,
      hide: false,
      pct: String,
      byMethod: [],
      today: '2026-10-25',
    });
    nodes.length = 0;
    walk(other);
    const code = nodes.find((n) => n.props?.className === 'rp-bars');
    assert.ok(code.props.children.flat(Infinity).every((n) => n.props.style.width >= 1));
  }

  const Review = component('Review.tsx', 'Review', {
    useState: (v) => [v, () => {}],
    useMemo: (fn) => fn(),
    yearReview: () => r,
    totals: () => ({ mrr: NaN, partial: { mrr: fxTotals.emptyTotal() } }),
    cancelSavings: () => ({ items: [] }),
    firstStart: () => '2026-01-01',
    paymentMethodGroups: () => [],
    allCharges: () => [],
    t: String,
    STYLES: () => [],
    ShareSheet: 'share',
    Seg: 'seg',
    Receipt: 'receipt',
    Poster: 'poster',
    Card: 'card',
    Stars: 'stars',
  });
  const shared = Review({ state: { methods: [], settings: { baseCurrency: 'USD' } }, today: '2026-10-25', onClose() {} });
  const poster = shared.props.render('poster', { hide: true, m: String });
  assert.equal(poster.props.pct(10), '—');
});

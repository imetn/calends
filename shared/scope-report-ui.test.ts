import * as fxTotals from './fx-total.ts';
import { shouldGroupYears } from '../app/src/components/year-ledger.ts';
import { readUiSource } from '../scripts/ui-test-source.ts';
import * as phase2Icons from 'lucide-react';
import { metricComponents, fxAmountComponent } from '../scripts/ui-test-components.ts';
import * as transfers from './transfers.ts';
import * as listScope from './list-scope.ts';
import { canUseSingleKey } from '../app/src/keyboard.ts';
import { numberFormat } from './intl.ts';
import { loadSearch, matchText, searchIndex } from '../app/src/search.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import * as billing from './billing.ts';
import * as format from './format.ts';
import * as fx from './fx.ts';
import * as reports from './scope-report.ts';
import * as metrics from './metrics.ts';
import * as carpool from './carpool.ts';
import * as carpoolTimeline from './carpool-timeline.ts';
import * as proxy from './proxy.ts';
import * as receivables from './receivables.ts';
import * as periodGrid from './period-grid.ts';
import * as assistantFields from '../app/src/views/assistant-fields.ts';
import { detailForecast, detailHistoryEnd } from '../app/src/views/detail-data.ts';
import { calendarJump } from '../app/src/views/calendar-jump.ts';
import { PERSON_COLORS, DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

// Execute component event handlers in the existing JSX harness, retaining pure financial builders.
type Node = { type: string; props: Record<string, any>; children: unknown[] };
const all = (n: unknown): Node[] =>
  Array.isArray(n) ? n.flatMap(all) : n && typeof n === 'object' && 'type' in n ? [n as Node, ...all((n as Node).children)] : [];
const st: AppState = { subscriptions: [], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX };
// 已有成员的资料平时只读，点底部「编辑」才能改；要改资料的用例先点开
const expandMember = (nodes: Node[]) => {
  nodes
    .flatMap((n) => all(n.props.foot))
    .find((n) => n.type === 'button' && n.children.includes('detail.action.edit') && n.props['aria-expanded'] === false)
    ?.props.onClick();
};
const today = '2026-10-22';
function harness(file: string, names: string, prefs: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const source = readUiSource(new URL(file, import.meta.url))
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export \{.*\};\n/gm, '');
  const copySource = readFileSync(new URL('../app/src/components/copy.tsx', import.meta.url), 'utf8').replace(/^import.*;\n/gm, '');
  // 详情类视图共用的头部、面板与事实项在 DetailKit，与被测文件一起编译
  const kitSource = /DetailKit\.tsx/.test(readUiSource(new URL(file, import.meta.url)))
    ? readFileSync(new URL('../app/src/components/DetailKit.tsx', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '')
    : '';
  // 合租、订阅详情的收付款表共用 YearLedger：一起编译并在渲染时展开
  const ledgerSource = /YearLedger\.tsx/.test(readUiSource(new URL(file, import.meta.url)))
    ? readFileSync(new URL('../app/src/components/YearLedger.tsx', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/export function /g, 'function ')
    : '';
  // 合租与代付共用的按期收款表单：一起编译并在渲染时展开
  const receivableSource = /Receivable\.tsx/.test(readUiSource(new URL(file, import.meta.url)))
    ? readFileSync(new URL('../app/src/views/Receivable.tsx', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/export (function|const) /g, '$1 ')
    : '';
  // 联系方式工具在 components/Contact.tsx：一起编译
  const contactSource = /Contact\.tsx/.test(readUiSource(new URL(file, import.meta.url)))
    ? readFileSync(new URL('../app/src/components/Contact.tsx', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/export (function|const) /g, '$1 ')
    : '';
  const result = transformSync(file, source + '\n' + copySource + '\n' + kitSource + '\n' + ledgerSource + '\n' + receivableSource + '\n' + contactSource, {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  const values: unknown[] = [];
  let cursor = 0;
  const keys: Record<string, (e: any) => void> = {};
  const deps = {
    React: {
      Fragment: 'Fragment',
      createElement: (type: string | ((p: any) => unknown), props: Node['props'], ...children: unknown[]) =>
        typeof type === 'function' &&
        [
          'ScopeLifecycleReport',
          'FxAmount',
          'MetricCards',
          'Metric',
          'YearLedger',
          'FeeRuleFields',
          'ReceivableSheet',
          'PeriodPair',
          'PeriodStrip',
          'PeriodPop',
          'PeriodTip',
          'CopyReceiptFields',
          'BillingFields',
          'StatusFields',
          'SharingFields',
          'MoreFields',
          'ProfileFields',
        ].includes(type.name)
          ? type({ ...props, children })
          : { type, props: props ?? {}, children },
    },
    shouldGroupYears,
    canUseSingleKey,
    ...billing,
    ...listScope,
    ...transfers,
    ...format,
    ...fx,
    ...fxTotals,
    ...reports,
    ...carpool,
    statusOf: carpool.memberStatus,
    ...metrics,
    ...carpoolTimeline,
    ...proxy,
    ...receivables,
    ...periodGrid,
    ...(!source.includes('export function TipTable') ? { TipTable: 'TipTable' } : {}),
    useId: () => `test-id-${cursor++}`,
    useTimelinePan: () => ({ current: null }),
    locale: () => 'en',
    useOrig: () => false,
    useTextSearch: (texts: string[]) => {
      const indexes = new Map(texts.map((text) => [text, searchIndex(text, 'en')]));
      return (query: string, text: string) => matchText(query, indexes.get(text) ?? text, 'en');
    },
    categories: () => [],
    ...(!/export function ConfirmButton/.test(source) ? { ConfirmButton: 'ConfirmButton' } : {}),
    Picker: 'Picker',
    SortControl: 'SortControl',
    PersonAvatar: 'PersonAvatar',
    personFor: (state: AppState, id: string, name: string) => state.people?.find((p) => p.id === id) ?? { id, name },
    t: (key: string) => key,
    tipProps: () => ({ onMouseEnter() {}, onMouseLeave() {}, onFocus() {}, onBlur() {} }),
    ...(!/(let|const|var) tipSet\b/.test(source) ? { tipSet: null } : {}),
    useMemo: (fn: () => unknown) => fn(),
    useRef: () => ({ current: null }),
    useEffect: (fn: () => unknown) => fn(),
    useLayoutEffect: (fn: () => unknown) => fn(),
    calendarJump,
    location: { search: '', pathname: '/calendar' },
    history: { state: null, replaceState() {} },
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [
        values[i],
        (next: unknown) => {
          values[i] = typeof next === 'function' ? next(values[i]) : next;
        },
      ];
    },
    usePref: (key: string, fallback: string) => [
      prefs[key] ?? fallback,
      (v: string) => {
        prefs[key] = v;
      },
    ],
    useMoneyPair: () => () => ({ main: '' }),
    useSnapshotRender: () => {},
    useWidth: () => [null, 700],
    allCharges: () => [],
    sumBase: () => 0,
    // 显示用合计与排序（app/src/derive.ts）：缺汇率为 NaN
    sumBaseOrNaN: (s: AppState, rows: billing.Charge[]) => rows.reduce((n, c) => n + fx.chargeBaseOrNaN(s, c), 0),
    sortValue: (v: number) => (Number.isFinite(v) ? v : -Infinity),
    firstStart: (state: AppState, at: string) => state.subscriptions.reduce((m, x) => (x.start < m ? x.start : m), at),
    // 防重复提交（ui.tsx useSubmit）：测试里直接执行
    useSubmit: () => [false, async (fn: () => unknown) => void (await fn())],
    LoadFailed: 'LoadFailed',
    document: {
      addEventListener: (name: string, fn: (e: any) => void) => {
        keys[name] = fn;
      },
      removeEventListener() {},
      querySelector: () => null,
    },
    Cell: 'Cell',
    Group: 'Group',
    Pop: 'Pop',
    Icon: 'Icon',
    IconButton: 'button',
    CardTitle: 'h3',
    CopyImageButton: 'CopyImageButton',
    Hint: 'Hint',
    PayBadge: 'PayBadge',
    RegionTag: 'RegionTag',
    subRegion: (s: { region?: string }) => s.region,
    Seg: 'Seg',
    Stepper: 'Stepper',
    SubIcon: 'SubIcon',
    TailName: 'TailName',
    CatIcon: 'CatIcon',
    BarLine: 'BarLine',
    MethodMark: 'MethodMark',
    bankOf: () => undefined,
    brandOf: () => undefined,
    methodLogo: (m: { logo?: string }) => m.logo,
    catColor: (cat: string) => `color-${cat}`,
    Toolbar: 'Toolbar',
    ScopeReport: 'ScopeReport',
    Gantt: 'Gantt',
    Composition: 'Composition',
    useCallback: (fn: unknown) => fn,
    // 弹窗叠加层级（overlays 的 SheetNested）：测试里都当作最底层
    createContext: (value: unknown) => ({ Provider: 'Provider', value }),
    use: () => false,
    Fragment: 'Fragment',
    Timeline: 'Timeline',
    Amount: 'Amount',
    Eye: 'Eye',
    EyeOff: 'EyeOff',
    tx: (key: string, parts: Record<string, unknown>) => [key, ...Object.values(parts)],
    Maximize2: 'Maximize2',
    Minimize2: 'Minimize2',
    Layers: 'Layers',
    ChevronUp: 'ChevronUp',
    SpendingDelta: 'SpendingDelta',
    ...extra,
  };
  const components = { ...deps, ...metricComponents(deps.React) };
  Object.assign(components, { FxAmount: fxAmountComponent(deps.React, 'Amount') });
  const exports = new Function(...Object.keys(components), `${result.code.replace(/export /g, '')}; return {${names}};`)(...Object.values(components));
  return {
    prefs,
    keys,
    call: (name: string, ...args: unknown[]) => exports[name](...args),
    render: (name: string, props: unknown) => {
      cursor = 0;
      return all(exports[name](props));
    },
  };
}

test('calendar selects today, toggles off, clears on month navigation, and Today/T restore it', () => {
  const r = harness('../app/src/views/Calendar.tsx', 'Calendar');
  const render = () => r.render('Calendar', { state: st, today, onOpen() {}, onIcs() {} });
  let nodes = render();
  assert.equal(nodes.find((n) => n.props['aria-current'] === 'date')!.props['aria-pressed'], true);
  nodes.find((n) => n.props['aria-current'] === 'date')!.props.onClick();
  nodes = render();
  assert.equal(
    nodes.some((n) => n.props['aria-pressed']),
    false,
  );
  assert.ok(nodes.some((n) => n.children.includes('calendar.pickDay')));
  nodes.find((n) => n.props['aria-label'] === 'calendar.next')!.props.onClick();
  nodes = render();
  assert.equal(
    nodes.some((n) => n.props['aria-pressed']),
    false,
  );
  assert.equal(
    nodes.some((n) => n.type === 'ScopeReport'),
    false,
  );
  nodes.find((n) => n.type === 'button' && n.children.includes('calendar.today'))!.props.onClick();
  nodes = render();
  assert.equal(nodes.find((n) => n.props['aria-current'] === 'date')!.props['aria-pressed'], true);
  r.keys.keydown({ target: { tagName: 'BODY', closest: () => null, ownerDocument: { querySelectorAll: () => [] } }, key: 'ArrowRight', preventDefault() {} });
  assert.equal(
    render().some((n) => n.props['aria-pressed']),
    false,
  );
  r.keys.keydown({ target: { tagName: 'BODY', closest: () => null, ownerDocument: { querySelectorAll: () => [] } }, key: 't' });
  assert.equal(render().find((n) => n.props['aria-current'] === 'date')!.props['aria-pressed'], true);
});

test('calendar full report collapses to persisted mini with day details, expands again, and stays absent in year view', () => {
  const r = harness('../app/src/views/Calendar.tsx', 'Calendar', { 'cal-report-mode': 'full' });
  const render = () => r.render('Calendar', { state: st, today, onOpen() {}, onIcs() {} });
  const mini = (nodes: Node[]) => nodes.find((n) => typeof n.type === 'function' && n.type.name === 'MiniReport');
  let nodes = render();
  assert.equal(nodes.find((n) => n.type === 'ScopeReport')!.props.open, true);
  assert.equal(mini(nodes), undefined);
  nodes.find((n) => n.type === 'ScopeReport')!.props.onToggle();
  nodes = render();
  assert.equal(r.prefs['cal-report-mode'], 'mini');
  assert.ok(mini(nodes));
  assert.equal(
    nodes.some((n) => n.props.className === 'cal-dayhead'),
    false,
    'empty days have no block in mini mode either',
  );
  assert.equal(
    nodes.find((n) => n.type === 'ScopeReport'),
    undefined,
  );
  mini(nodes)!.props.onExpand();
  assert.equal(render().find((n) => n.type === 'ScopeReport')!.props.open, true);
  render()
    .find((n) => n.type === 'ScopeReport')!
    .props.onToggle();
  render()
    .find((n) => n.props['aria-label'] === 'calendar.next')!
    .props.onClick();
  assert.ok(mini(render()));
  r.prefs['cal-mode'] = 'year';
  nodes = render();
  assert.equal(
    nodes.some((n) => n.type === 'ScopeReport' || (typeof n.type === 'function' && n.type.name === 'MiniReport')),
    false,
  );
});

test('list report restores matching preferences without animation and requires generation for a different scope', () => {
  const r = harness('../app/src/views/List.tsx', 'ListReport', { 'list-report': JSON.stringify({ key: 'AI', open: false }) });
  const props = { reportKey: 'AI', state: st, rows: [], today, onOpen() {}, title: 'AI' };
  let nodes = r.render('ListReport', props);
  assert.equal(nodes.find((n) => n.type === 'ScopeReport')!.props.open, false);
  assert.equal(nodes.find((n) => n.type === 'ScopeReport')!.props.animate, false);
  nodes = r.render('ListReport', { ...props, reportKey: 'VPS' });
  assert.equal(
    nodes.some((n) => n.type === 'ScopeReport'),
    false,
  );
  nodes.find((n) => n.type === 'button')!.props.onClick();
  nodes = r.render('ListReport', { ...props, reportKey: 'VPS' });
  assert.equal(nodes.find((n) => n.type === 'ScopeReport')!.props.open, true);
  assert.equal(JSON.parse(r.prefs['list-report']).key, 'VPS');
});

test('overview upcoming excludes today, refunds and failed charges; timeline owns the past including today', () => {
  const sub = (id: string, start: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    start,
    price: 10,
    currency: 'USD',
    category: 'Tools',
    tags: [],
    cycle: { unit: 'month' as const, every: 1 },
    status: 'active' as const,
    ...extra,
  });
  const state = {
    ...st,
    subscriptions: [
      sub('today', today),
      sub('future', '2026-10-25'),
      sub('refund', '2026-01-01', { cycle: { unit: 'lifetime', every: 1 }, payments: [{ date: '2026-10-24', amount: -10, kind: 'refund' }] }),
      sub('failed', '2026-01-01', { cycle: { unit: 'lifetime', every: 1 }, payments: [{ date: '2026-10-24', amount: 10, kind: 'failed' }] }),
    ],
  };
  const calls: string[][] = [];
  const r = harness(
    '../app/src/views/Overview.tsx',
    'DueSoon, ChargeTimeline',
    {},
    {
      allCharges: (s: AppState, from: string, to: string, at: string) => {
        calls.push([from, to]);
        return s.subscriptions.flatMap((sub) => billing.chargesBetween(sub, from, to, at));
      },
      sumBase: (s: AppState, charges: billing.Charge[]) => charges.reduce((n, c) => n + fx.chargeValue(s, c), 0),
    },
  );
  const nodes = r.render('DueSoon', { state, today, onOpen() {} });
  const rows = nodes.filter((n) => n.props.className === 'due-row');
  assert.equal(rows.length, 1);
  assert.equal(
    all(rows[0]).some((n) => n.children.includes('future')),
    true,
  );
  assert.deepEqual(calls[0], ['2026-10-23', '2026-11-21']);
  r.render('ChargeTimeline', { state, today, onOpen() {} });
  assert.deepEqual(calls.at(-1), ['2026-09-23', today]);
  const publicView = harness(
    '../app/src/public/page.tsx',
    'derive',
    {},
    {
      syncCategories: () => [],
      periodRange: () => ['2026-10-01', '2026-10-31'],
      allCharges: (s: AppState, from: string, to: string, at: string) => s.subscriptions.flatMap((sub) => billing.chargesBetween(sub, from, to, at)),
      sumBase: (s: AppState, rows: billing.Charge[]) => rows.reduce((n, c) => n + fx.chargeValue(s, c), 0),
    },
  );
  const derived = publicView.call('derive', state, today);
  assert.deepEqual(
    derived.upcoming.map((c: billing.Charge) => c.sub.id),
    ['future'],
  );
});

test('report changes use unsigned spending direction and omit the current total already owned by the hero', () => {
  const r = harness(
    '../app/src/views/Report.tsx',
    'Waterfall',
    {},
    {
      monthMovement: () => ({
        partial: { from: fxTotals.amountTotal(100, 'USD', 100), to: fxTotals.amountTotal(80, 'USD', 80) },
        from: 100,
        to: 80,
        fx: 0,
        added: 0,
        expansion: 0,
        contraction: 0,
        churned: 20,
        items: [],
      }),
    },
  );
  const nodes = r.render('Waterfall', { state: st, today, year: Number(today.slice(0, 4)), onOpen() {} });
  const delta = nodes.find((n) => n.type === 'SpendingDelta')!;
  assert.deepEqual(delta.props.value, { amount: -20, percent: -0.2 });
  assert.equal(
    nodes.some((n) => n.children.includes('−$80.00')),
    false,
  );
  assert.equal(
    nodes.some((n) => n.props.className === 'mv-row down'),
    false,
    'a single driver must not repeat the overall delta',
  );
  const mixed = harness(
    '../app/src/views/Report.tsx',
    'Waterfall',
    {},
    {
      monthMovement: () => ({
        partial: { from: fxTotals.amountTotal(100, 'USD', 100), to: fxTotals.amountTotal(80, 'USD', 80) },
        from: 100,
        to: 110,
        fx: 0,
        added: 30,
        expansion: 0,
        contraction: 0,
        churned: 20,
        items: [],
      }),
    },
  );
  const mixedNodes = mixed.render('Waterfall', { state: st, today, year: Number(today.slice(0, 4)), onOpen() {} });
  // 分解行不分涨跌颜色，只靠方向符号
  assert.ok(!mixedNodes.some((n) => /mv-row (up|down)/.test(n.props.className ?? '')));
  const driver = mixedNodes.find((n) => n.props.className === 'mv-row' && all(n).some((c) => c.children.includes('report.wf.churned')))!;
  assert.equal(
    all(driver).some((n) => n.children.includes('↓')),
    true,
  );
  assert.equal(
    all(driver).some((n) => n.children.includes('+')),
    false,
  );
});

test('scope presentation gives single refunds/receipts one numeric owner and avoids repeated upcoming/top charge rows', () => {
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      useRef: () => ({ current: null }),
      intlLocale: () => 'en-US',
      numberFormat,
      BarLine: 'BarLine',
      Copy: 'Copy',
    },
  );
  const subscription = {
    id: 'service',
    name: 'Service',
    category: 'Tools',
    tags: [],
    price: 120,
    currency: 'USD',
    cycle: { unit: 'year' as const, every: 1 },
    start: '2026-01-01',
    status: 'cancelled' as const,
    end: '2026-10-12',
    stop: { kind: 'cancel' as const, date: '2026-10-12', paidThrough: '2026-12-31' },
    payments: [
      { date: '2026-01-01', amount: 120 },
      { date: '2026-10-22', amount: -10, kind: 'refund' as const },
    ],
  };
  const state = { ...st, subscriptions: [subscription] };
  const render = (report: reports.ScopeReport) =>
    r.render('ScopeReport', { report, state, today, onOpen() {}, title: 'Scope', animate: false, open: true, onToggle() {} });
  let nodes = render(reports.monthReport(state, '2026-10', today));
  const loss = nodes.find((n) => String(n.props.className).includes('scope-block scope-losses'))!;
  assert.equal(all(loss).filter((n) => n.children.includes('+$10.00')).length, 1);
  const mv = {
    from: 100,
    to: 80,
    fx: 0,
    added: 0,
    expansion: 0,
    contraction: 0,
    churned: 20,
    items: [{ sub: subscription, kind: 'churned' as const, delta: -20, from: 20, to: 0, since: '2026-10-12', until: '2026-10-12' }],
  };
  const trendNodes = render({ blocks: [{ type: 'trend', mode: 'month', month: '2026-10', movement: mv }] });
  assert.equal(
    trendNodes.some((n) => typeof n.type === 'function' && n.type.name === 'SpendingDelta'),
    false,
    'one driver owns the total, without repeating it in summary or single-item rows',
  );
  const root = subscription;
  nodes = render({ blocks: [{ type: 'sharing', rows: [{ sub: root, received: 10, owed: 0 }], received: 10, owed: 0 }] });
  assert.equal(
    nodes.some((n) => n.props.className === 'metric-cards'),
    false,
  );
  const upcoming = {
    ...subscription,
    id: 'next',
    status: 'active' as const,
    stop: undefined,
    end: undefined,
    start: '2026-10-25',
    cycle: { unit: 'month' as const, every: 1 },
    payments: undefined,
  };
  nodes = render(reports.monthReport({ ...st, subscriptions: [upcoming] }, '2026-10', today));
  assert.equal(
    nodes.some((n) => String(n.props.className).includes('scope-block scope-top')),
    true,
  );
  assert.equal(
    nodes.some((n) => String(n.props.className).includes('scope-block scope-upcoming')),
    false,
  );
});

test('member with a receipt and no paid-through date never claims no receipts and omits a duplicate singleton total', () => {
  const member = {
    id: 'member',
    name: 'Member',
    share: 10,
    fee: 10,
    feeCurrency: 'USD',
    receipts: [{ id: 'receipt', date: today, amount: 10, currency: 'USD', periods: ['2026-10-01'] }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2026-01-01', members: [member] },
  };
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      linkPerson: async () => ({}),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  const render = () => r.render('MemberForm', { state: { ...st, subscriptions: [sub] }, s: sub, member, onClose() {} });
  // 已付至只展示，不再有「调整」；没收过就写「还没收」，不编造日期
  const nodes = render();
  assert.equal(
    nodes.some((n) => n.type === 'button' && n.children.includes('family.collect.adjustPaid')),
    false,
  );
  assert.ok(all(nodes.find((n) => n.type === 'Cell' && n.props.label === 'family.member.paidUntil')).some((n) => n.children.includes('family.pool.noPay')));
  assert.equal(
    nodes.some((n) => all(n.props.title).some((title) => title.children.includes('family.member.payments'))),
    false,
    'no separate receipt list',
  );
  assert.equal(saved, undefined);
});

test('public rows keep the amount once for an ordinary monthly plan and distinguish trials and sharing', () => {
  const r = harness(
    '../app/src/public/page.tsx',
    'Row',
    {},
    {
      AppIcon: 'AppIcon',
      Badge: 'Badge',
      cn: (...s: string[]) => s.filter(Boolean).join(' '),
      t: (key: string, params?: { date?: string }) => (params?.date ? `${key} ${params.date}` : key),
    },
  );
  const s = {
    id: 'service',
    name: 'Service',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'month' as const, every: 1 },
    status: 'active' as const,
  };
  const render = (sub: Subscription, v: number) => r.render('Row', { s: sub, v, today, ccy: 'USD', k: 1, fmt: (n: number) => format.money(n, 'USD') });
  let nodes = render(s, 10);
  const todayNodes = render({ ...s, start: today }, 10);
  assert.ok(
    todayNodes.some((n) => n.children.includes(`public.row.renews ${format.cnDate('2026-11-22')}`)),
    'next charge starts after the already-charged day',
  );
  assert.equal(nodes.filter((n) => n.children.includes('$10.00')).length, 1);
  assert.equal(
    nodes.some((n) => n.children.includes(' $10.00')),
    false,
  );
  nodes = render({ ...s, status: 'trial', trialEnd: '2026-11-01' }, 0);
  assert.equal(
    nodes.some((n) => n.children.includes('list.status.trial')),
    true,
  );
  assert.equal(
    nodes.some((n) => n.children.includes(' $10.00')),
    true,
    'future list price remains separate from zero trial MRR',
  );
  for (const stopped of [
    { ...s, end: '2026-11-01', status: 'cancelled' as const },
    { ...s, status: 'terminated' as const, stop: { kind: 'terminate' as const, date: today, paidThrough: '2026-11-01' } },
  ]) {
    const ended = render(stopped, 0);
    assert.ok(ended.some((n) => n.children.some((child) => String(child).startsWith('public.row.ends'))));
    assert.ok(!ended.some((n) => n.children.some((child) => String(child).startsWith('public.row.renews'))));
  }
  nodes = render(s, 6);
  assert.equal(
    nodes.some((n) => n.children.includes(' $10.00')),
    true,
    'full plan price remains when my share differs',
  );
  assert.equal(
    nodes.some((n) => n.children.includes('$6.00')),
    true,
  );
});

test('a single charge owns its amount instead of repeating an identical cumulative-spend KPI', () => {
  const r = harness(
    '../app/src/views/Detail.tsx',
    'Kpis',
    {},
    { toBase: (s: AppState, n: number, ccy: string) => fx.toBaseAt(s, n, ccy), detailForecast, detailHistoryEnd },
  );
  const sub = {
    id: 'service',
    name: 'Service',
    category: 'Tools',
    tags: [],
    price: 120,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'year' as const, every: 1 },
    status: 'active' as const,
  };
  const history = billing.chargesBetween(sub, sub.start, today, today);
  assert.equal(history.length, 1);
  const nodes = r.render('Kpis', { sub, state: { ...st, subscriptions: [sub] }, today, history });
  assert.equal(
    nodes.some((n) => n.children.includes('detail.stats.spent')),
    false,
  );
  // 三格：下次扣款、本期进度、预计每月；下次扣款只在第一格
  assert.equal(nodes.filter((n) => n.props.className === 'metric').length, 3);
  assert.equal(nodes.filter((n) => n.children.includes('detail.ev.next')).length, 1);
});

test('same-currency cash pairs retain a distinct actual settlement and never hide fees behind the list price', () => {
  for (const orig of [false, true]) {
    const r = harness('../app/src/components/MoneyPair.tsx', 'useMoneyPair', {}, { useOrig: () => orig });
    const pair = r.call('useMoneyPair', st);
    const same = pair(-12, 'USD', { value: -12 });
    assert.equal(same.alt, undefined);
    const actual = pair(-12, 'USD', { value: -14 });
    assert.equal(actual.main.props.value, orig ? -12 : -14);
    assert.equal(actual.alt, orig ? '≈ −$14' : '−$12.00');
    const unknown = pair(-12, 'USD', { value: NaN });
    assert.equal(orig ? unknown.alt : format.flow(unknown.main.props.value, 'USD'), orig ? '≈ —' : '—');
  }
});

test('订阅筛选默认全部时无清空按钮，任一条件变化后清空恢复当前路由默认值', () => {
  for (const category of [undefined, 'Tools']) {
    for (const field of ['status', 'category', 'pay', 'search']) {
      const r = harness('../app/src/views/List.tsx', 'List');
      const render = () => r.render('List', { state: st, today, category, onOpen() {}, onAdd() {} });
      const clear = (nodes: Node[]) => nodes.find((n) => n.props.className === 'facet-clear');
      let nodes = render();
      assert.equal(clear(nodes), undefined, '默认全部不显示清空');
      if (field === 'search') nodes.find((n) => n.type === 'input')!.props.onChange({ target: { value: 'sample' } });
      else nodes.find((n) => n.props.label === `list.facet.${field}`)!.props.onChange(field === 'status' ? 'live' : field === 'category' ? 'Other' : 'none');
      nodes = render();
      assert.ok(clear(nodes), `${category ?? 'all'} ${field} 显示清空`);
      clear(nodes)!.props.onClick();
      nodes = render();
      assert.equal(clear(nodes), undefined);
      assert.equal(nodes.find((n) => n.props.label === 'list.facet.status')!.props.value, 'all');
      assert.equal(nodes.find((n) => n.props.label === 'list.facet.category')!.props.value, category ?? 'all');
      assert.equal(nodes.find((n) => n.props.label === 'list.facet.pay')!.props.value, 'all');
      assert.equal(nodes.find((n) => n.type === 'input')!.props.value, '');
    }
  }
});

test('subscription list pinyin filtering keeps multi-word intersection and facet counts aligned', async () => {
  await loadSearch('zh-CN');
  const sample = (id: string, name: string, category: string): Subscription => ({
    id,
    name,
    category,
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    status: 'active',
    tags: [],
  });
  const state = { ...st, subscriptions: [sample('music', '网易云音乐', '娱乐'), sample('study', '学习工具', '学习')] };
  const r = harness(
    '../app/src/views/List.tsx',
    'List',
    { 'list-view': 'gantt' },
    {
      Gantt: 'Gantt',
      categories: () => [{ name: '娱乐' }, { name: '学习' }],
      useTextSearch: (texts: string[]) => {
        const indexes = new Map(texts.map((text) => [text, searchIndex(text, 'zh-CN')]));
        return (query: string, text: string) => matchText(query, indexes.get(text) ?? text, 'zh-CN');
      },
    },
  );
  const render = () => r.render('List', { state, today, onOpen() {}, onAdd() {} });
  for (const [query, ids] of [
    ['wyyyy yl', ['music']],
    ['xuexi', ['study']],
    ['wyyyy xx', []],
  ] as const) {
    render()
      .find((n) => n.type === 'input')!
      .props.onChange({ target: { value: query } });
    const nodes = render();
    assert.deepEqual(nodes.find((n) => n.type === 'Gantt')?.props.rows.map((s: Subscription) => s.id) ?? [], ids);
    const facet = nodes.find((n) => n.props.label === 'list.facet.category')!;
    assert.equal(facet.props.options.find((o: { key: string }) => o.key === 'all').n, ids.length);
  }
});

test('calendar monthly list owns its heading inside the card in mini and full modes', () => {
  for (const mode of ['mini', 'full']) {
    const r = harness('../app/src/views/Calendar.tsx', 'Calendar', { 'cal-report-mode': mode });
    const nodes = r.render('Calendar', { state: st, today, onOpen() {}, onIcs() {} });
    const card = nodes.find((n) => n.props.className === 'card cal-charges')!;
    assert.ok(card);
    assert.ok(all(card).some((n) => n.type === 'h3' && n.children.includes('calendar.monthAll')));
    assert.equal(
      all(card).some((n) => n.type === 'Group'),
      false,
    );
    assert.equal(
      all(card).some((n) => n.props.className === 'cal-stat-big'),
      false,
    );
  }
});

test('scope subscription rows show exportable 24px icons and open details from every block', () => {
  const opened: Subscription[] = [];
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      useRef: () => ({ current: null }),
      intlLocale: () => 'en-US',
      numberFormat,
      BarLine: 'BarLine',
      t: (key: string, params?: { count?: number }) => (params?.count == null ? key : `${key} ${params.count}`),
    },
  );
  const sub: Subscription = {
    id: 's',
    name: 'Sample',
    category: 'Tools',
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    status: 'active',
    tags: [],
  };
  const charge = { sub, date: today, amount: 10, original: billing.chargesBetween(sub, today.slice(0, 8) + '01', today, today)[0] };
  const stopped: Subscription = { ...sub, status: 'cancelled', end: today, stop: { kind: 'cancel', date: today, paidThrough: '2026-10-31' } };
  const loss = metrics.stopLosses({ ...st, subscriptions: [stopped] }, today).items[0];
  const blocks: reports.Block[] = [
    { type: 'top', mode: 'scope', rows: [charge, { ...charge, sub: { ...sub, id: 's2' } }] },
    { type: 'upcoming', rows: [charge], total: 10 },
    { type: 'events', rows: [{ ...charge, kind: 'start', delta: 10 }] },
    {
      type: 'losses',
      rows: [loss],
      loss: 10,
      incomplete: false,
      refunds: [charge],
      refunded: -10,
    },
    { type: 'sharing', rows: [{ sub, received: 10, owed: 2 }], received: 10, owed: 2 },
    {
      type: 'trend',
      mode: 'month',
      month: '2026-10',
      movement: {
        from: 0,
        to: 10,
        fx: 0,
        added: 10,
        expansion: 0,
        contraction: 0,
        churned: 0,
        items: [{ sub, kind: 'added', delta: 10, from: 0, to: 10, since: '2026-01-01', until: '2026-01-01' }],
      },
    },
  ];
  const nodes = r.render('ScopeReport', {
    report: { blocks },
    state: st,
    today,
    onOpen: (sub: Subscription) => opened.push(sub),
    title: 'Scope',
    open: true,
    animate: false,
    onToggle() {},
  });
  const rows = nodes.filter((n) => n.props.className === 'scope-row scope-tap');
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.type, 'button');
    const icon = all(row).find((n) => n.type === 'SubIcon')!;
    assert.equal(icon.props.size, 24);
    assert.equal(icon.props.proxied, true);
    row.props.onClick();
    assert.equal(opened.at(-1), icon.props.sub);
    assert.equal(all(row).filter((n) => n.type === 'button').length, 1);
  }
  assert.ok(nodes.some((n) => n.type === 'h3' && n.children.includes('scope.topMonthly 2')));
});

test('scope composition uses category colors for both marks and bars and exports method images through the proxy', () => {
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      useRef: () => ({ current: null }),
      intlLocale: () => 'en-US',
      numberFormat,
      bankOf: () => undefined,
      brandOf: () => undefined,
      methodLogo: (m: { logo?: string }) => m.logo,
    },
  );
  const method = { id: 'm', name: 'Sample card', kind: 'card', currency: 'USD', logo: 'https://example.test/card.png' };
  const report = { blocks: [{ type: 'composition', categories: [{ key: 'Tools', amount: 10, share: 1 }], methods: [{ key: 'm', amount: 10, share: 1 }] }] };
  const nodes = r.render('ScopeReport', {
    report,
    state: { ...st, methods: [method] },
    today,
    onOpen() {},
    title: 'Scope',
    open: true,
    animate: false,
    onToggle() {},
  });
  assert.ok(nodes.some((n) => n.type === 'CatIcon' && n.props.cat === 'Tools'));
  assert.ok(nodes.some((n) => n.props.className === 'scope-cat' && n.props.style.color === 'color-Tools'));
  assert.ok(nodes.some((n) => n.type === 'i' && n.props.style.background === 'color-Tools'));
  assert.ok(nodes.some((n) => n.type === 'MethodMark' && n.props.m === method && n.props.proxied));
});

test('退订与停用：每笔未退款损失一行，损失合计只出现一次', () => {
  const sub: Subscription = {
    id: 's',
    name: 'Stopped',
    category: 'Tools',
    tags: [],
    price: 31,
    currency: 'USD',
    start: '2026-10-05',
    cycle: { unit: 'month', every: 1 },
    status: 'cancelled',
    end: '2026-10-19',
    stop: { kind: 'cancel', date: '2026-10-19', paidThrough: '2026-11-04' },
  };
  const r = harness('../app/src/views/Report.tsx', 'StopsCard', {}, { tipProps: () => ({}) });
  for (const count of [0, 1, 2]) {
    const state = { ...st, subscriptions: Array.from({ length: count }, (_, i) => ({ ...sub, id: String(i) })) };
    const nodes = r.render('StopsCard', { state, today, year: Number(today.slice(0, 4)), onOpen: () => {} });
    assert.equal(nodes.filter((n) => n.props.className === 'stop-row').length, count);
    assert.equal(nodes.filter((n) => n.children.includes('report.stops.loss')).length, 1);
  }
});

test('钱包续航列表不重复卡面余额和月扣；单年度分享用时长替代重复总额', () => {
  const wallet = harness('../app/src/views/Wallet.tsx', 'RunwayCard', {}, { tx: (key: string) => key });
  const method = { id: 'w', name: 'Wallet', kind: 'debit' as const, currency: 'USD', balance: 30, balanceAsOf: today };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    start: today,
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    methodId: 'w',
  };
  const state = { ...st, methods: [method], subscriptions: [sub] };
  const r = billing.runwayFor(method, state, today);
  const render = (detailsOnly: boolean) => wallet.render('RunwayCard', { r, today, state, flat: true, detailsOnly });
  assert.equal(
    render(true).find((n) => n.props.className === 'rw-bal'),
    undefined,
  );
  assert.ok(render(false).find((n) => n.props.className === 'rw-bal'));
  const share = harness('../app/src/views/SubShare.tsx', 'SYears', {}, { location: { host: 'example.test' } });
  for (const years of [
    [['2026', 10]],
    [
      ['2025', 4],
      ['2026', 6],
    ],
  ] as Array<Array<[string, number]>>) {
    const nodes = share.render('SYears', {
      sub,
      st: { years, yearMissing: new Set<string>(), total: 10, duration: '20 days', charges: [], vs: [sub], change: 0 },
      hide: false,
      m: (n: number) => format.flow(n, 'USD'),
    });
    assert.deepEqual(nodes.find((n) => n.props.className === 'sy-big')!.children, [years.length === 1 ? '20 days' : '−$10.00']);
  }
});

test('收款表单按应收预填：上面只读的收费，默认勾最早没收的一期，实际收到的日期、金额、币种、备注都按改过的记', async () => {
  for (const edit of ['none', 'amount', 'zero', 'currency']) {
    const member = { id: 'm', name: 'Member', share: 7.5, fee: 150, feeCurrency: 'CNY', billEvery: 6, joined: '2026-10-14' };
    const sub: Subscription = {
      id: 's',
      name: 'Plan',
      category: 'Tools',
      tags: [],
      price: 15,
      currency: 'USD',
      start: '2026-01-14',
      cycle: { unit: 'month', every: 1 },
      status: 'active',
      share: { role: 'owner', seats: 6, collectFrom: '2026-01-14', members: [member] },
    };
    let saved: Subscription | undefined;
    const r = harness(
      '../app/src/views/Members.tsx',
      'ReceiptForm',
      {},
      {
        ...carpool,
        statusOf: carpool.memberStatus,
        Sheet: 'Sheet',
        DatePicker: 'DatePicker',
        Toggle: 'Toggle',
        CurrencySelect: 'CurrencySelect',
        NumInput: 'NumInput',
        Picker: 'Picker',
        todayIn: () => today,
        getState: () => ({ ...st, subscriptions: [sub] }),
        linkPerson: async () => ({}),
        run: (fn: () => Promise<unknown>) => fn(),
        saveSub: async (next: Subscription) => {
          saved = next;
        },
      },
    );
    const render = () => r.render('ReceiptForm', { state: st, s: sub, member, onDone() {} });
    const cell = (label: string) => render().find((n) => n.type === 'Cell' && n.props.label === label)!;
    const input = (label: string, type: string) => all(cell(label)).find((n) => n.type === type)!;
    const due = billing.memberCollection(sub, member, billing.memberUnpaidFrom(sub, member), 'USD');
    // 收费标准只读，不是输入框
    assert.ok(cell('family.member.feeGroup'));
    assert.equal(
      all(cell('family.member.feeGroup')).some((n) => n.type === 'NumInput'),
      false,
    );
    // 默认勾选最早没收的那一期
    const checked = render().filter((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked);
    assert.equal(checked.length, 1);
    assert.equal(input('receivable.amount', 'NumInput').props.value, due.amount);
    input('receivable.note', 'input').props.onChange({ target: { value: '审查草稿' } });
    input('receivable.receivedOn', 'DatePicker').props.onChange('2026-10-21');
    if (edit === 'amount' || edit === 'zero') input('receivable.amount', 'NumInput').props.onValue(edit === 'zero' ? 0 : 12.34);
    if (edit === 'currency') input('receivable.amount', 'CurrencySelect').props.onChange('EUR');
    await all(render().find((n) => n.type === 'Sheet')!.props.foot)
      .find((n) => n.type === 'button' && n.children.includes('receivable.record'))!
      .props.onClick();
    const p = saved!.share!.members[0].receipts![0];
    assert.equal(p.note, '审查草稿');
    assert.equal(p.date, '2026-10-21');
    assert.deepEqual(p.periods, [due.from]);
    // 只换币种时，按应收在收款日的汇率折算
    const converted = Math.round(fx.convertOn(due.amount, due.currency, 'EUR', '2026-10-21', st.fxHistory, st.fx) * 100) / 100;
    assert.equal(p.amount, edit === 'amount' ? 12.34 : edit === 'zero' ? 0 : edit === 'currency' ? converted : due.amount);
    assert.equal(p.currency, edit === 'currency' ? 'EUR' : due.currency);
  }
});

test('提醒预览按所有者时区分出今天与最近发送，空预览不显示分组', () => {
  const r = harness('../app/src/views/Settings.tsx', 'ReminderPreview');
  const preview = {
    day: today,
    digests: [],
    log: [
      { dedupe_key: 'today', subject: 'Sent today', status: 'sent', sent_at: '2026-10-21 18:00:00' },
      { dedupe_key: 'yesterday', subject: 'Sent yesterday', status: 'sent', sent_at: '2026-10-21 04:01:00' },
    ],
  };
  const nodes = r.render('ReminderPreview', { preview, timezone: 'Asia/Shanghai' });
  const groups = nodes.filter((n) => n.type === 'Group');
  assert.deepEqual(
    groups.map((n) => n.props.title),
    ['settings.today.title', 'settings.today.recent'],
  );
  assert.deepEqual(
    all(groups[0])
      .filter((n) => n.type === 'Cell')
      .map((n) => all(n.props.label).flatMap((n) => n.children)),
    [['Sent today']],
  );
  assert.ok(all(groups[0]).some((n) => n.children.includes('02:00')));
  assert.ok(all(groups[1]).some((n) => n.children.includes('2026-10-21 12:01')));
  assert.equal(r.render('ReminderPreview', { preview: { ...preview, log: [] }, timezone: 'UTC' }).filter((n) => n.type === 'Group').length, 0);
  assert.equal(r.render('ReminderPreview', { preview: null, timezone: 'UTC' }).length, 0);
});

test('公开页时间线的支出和退款使用同一收支格式，关闭符号后同时移除', () => {
  let load: (from: string, to: string) => any[];
  const captured = new Error('timeline captured');
  const r = harness(
    '../app/src/public/page.tsx',
    'Ledger',
    {},
    {
      syncCategories: () => [],
      periodRange: () => ['2026-10-01', '2026-10-31'],
      AppIcon: 'AppIcon',
      useCallback: (fn: typeof load) => {
        load = fn;
        throw captured;
      },
      allCharges: () => [
        { sub: { id: 's', name: 'Service' }, date: today, amount: 10, currency: 'USD', projected: false },
        { sub: { id: 's', name: 'Service' }, date: today, amount: -3, currency: 'USD', projected: false, kind: 'refund' },
      ],
    },
  );
  try {
    for (const on of [true, false]) {
      format.setSignedAmounts(on);
      assert.throws(() => r.render('Ledger', { state: st }), captured);
      const items = load!(today, today)[0].items;
      assert.deepEqual([items[0].name, items[0].amount], ['Service', `${on ? '−' : ''}$10.00`]);
      assert.deepEqual([items[1].name, items[1].amount], ['Service', `${on ? '+' : ''}$3.00`]);
    }
  } finally {
    format.setSignedAmounts(true);
  }
});

test('小票结束语按实际状态显示停止日、到期日或下期见', () => {
  const r = harness(
    '../app/src/views/SubShare.tsx',
    'SReceipt, story',
    {},
    { location: { host: 'example.test' }, t: (key: string, p?: { date?: string }) => (p?.date ? `${key} ${p.date}` : key) },
  );
  const base: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    start: '2026-10-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
  };
  for (const [sub, key, date] of [
    [base, 'share.thanks', undefined],
    [{ ...base, status: 'cancelled', end: '2026-11-01' }, 'share.endsOn', '2026-11-01'],
    ...(['cancel', 'terminate'] as const).map((kind) => [
      { ...base, status: kind === 'cancel' ? 'cancelled' : 'terminated', end: today, stop: { kind, date: today, paidThrough: '2026-10-31' } },
      'share.stoppedOn',
      today,
    ]),
  ] as Array<[Subscription, string, string | undefined]>) {
    const story = r.call('story', { ...st, subscriptions: [sub] }, sub, today);
    const nodes = r.render('SReceipt', { sub, st: story, today, hide: false, m: (n: number) => format.flow(n, 'USD') });
    assert.deepEqual(nodes.find((n) => n.props.className === 'rc-thanks')!.children, [date ? `${key} ${format.cnDateFull(date)}` : key]);
  }
});

test('report layout keeps compact composition, five distinct upcoming rows and a monthly minimize action', () => {
  let toggles = 0;
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      useRef: () => ({ current: null }),
      intlLocale: () => 'en-US',
      numberFormat,
      BarLine: 'BarLine',
    },
  );
  const subscriptions: Subscription[] = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    name: `Sample ${i}`,
    category: `Category ${i}`,
    tags: [],
    price: 100 - i,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-25',
    status: 'active',
    methodId: String(i),
  }));
  const state = { ...st, subscriptions };
  const render = (report: reports.ScopeReport) =>
    r.render('ScopeReport', {
      report,
      state,
      today,
      onOpen() {},
      title: 'Report',
      animate: false,
      open: true,
      onToggle() {
        toggles++;
      },
    });
  const nodes = render(reports.monthReport(state, '2026-10', today));
  const minimize = nodes.find((n) => n.props['aria-label'] === 'scope.minimize')!;
  assert.equal(minimize.props.title, 'scope.minimize');
  assert.ok(all(minimize).some((n) => n.type === 'Minimize2'));
  minimize.props.onClick();
  assert.equal(toggles, 1);
  const card = (type: string) => nodes.find((n) => String(n.props.className).includes(`scope-block scope-${type}`))!;
  const rows = (node: Node) => all(node).filter((n) => n.type === 'button' && n.props.className === 'scope-row scope-tap');
  const top = rows(card('top'));
  const upcoming = rows(card('upcoming'));
  assert.equal(top.length, 5);
  assert.equal(upcoming.length, 5);
  const ids = (rows: Node[]) => rows.map((row) => all(row).find((n) => n.type === 'SubIcon')!.props.sub.id);
  assert.deepEqual(ids(upcoming), ['10', '11', '5', '6', '7']);
  assert.ok(ids(upcoming).every((id) => !ids(top).includes(id)));
  const comp = all(card('composition'));
  assert.equal(comp.filter((n) => n.props.className === 'scope-share').length, 12);
  assert.equal(comp.filter((n) => n.children.includes('scope.other')).length, 2);
  assert.equal(comp.filter((n) => n.type === 'button').length, 0);
  assert.ok(render(reports.scopeReport(state, subscriptions, today)).some((n) => n.props['aria-label'] === 'scope.collapse'));
});

test('monthly movement subtitles own unsigned before/after costs without a duplicate event card', () => {
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      useRef: () => ({ current: null }),
      intlLocale: () => 'en-US',
      numberFormat,
    },
  );
  const state: AppState = {
    ...st,
    subscriptions: [
      {
        id: 'new',
        name: 'New',
        category: 'Tools',
        tags: [],
        price: 10,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        start: '2026-10-03',
        status: 'active',
      },
    ],
  };
  const nodes = r.render('ScopeReport', {
    report: reports.monthReport(state, '2026-10', today),
    state,
    today,
    onOpen() {},
    title: 'Month',
    animate: false,
    open: true,
    onToggle() {},
  });
  const movement = nodes.find((n) => n.props.className === 'scope-movements')!;
  assert.ok(all(movement).some((n) => n.children.includes('scope.added')));
  assert.ok(all(movement).some((n) => n.children.includes('$0.00') && n.children.includes('$10.00')));
  assert.ok(all(movement).some((n) => n.props.className === 'scope-movement-date' && n.children.includes(format.cnDateAuto('2026-10-03', today))));
  assert.equal(
    nodes.some((n) => String(n.props.className).includes('scope-block scope-events')),
    false,
  );
});

test('calendar full report keeps only populated selected-day details above its divider and updates on selection', () => {
  const sub: Subscription = {
    id: 'calendar-plan',
    name: 'Fictional plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-09',
    status: 'active',
  };
  const state = { ...st, readonly: true, subscriptions: [sub] };
  const opened: Subscription[] = [];
  const r = harness(
    '../app/src/views/Calendar.tsx',
    'Calendar',
    { 'cal-report-mode': 'full' },
    {
      allCharges: (s: AppState, from: string, to: string, at: string) => s.subscriptions.flatMap((sub) => billing.chargesBetween(sub, from, to, at)),
    },
  );
  const render = () => r.render('Calendar', { state, today, onOpen: (s: Subscription) => opened.push(s), onIcs() {} });
  const pick = (day: string) =>
    render()
      .find((n) => n.props['aria-label'] === format.cnDate(day, true))!
      .props.onClick();
  const details = (nodes: Node[]) => nodes.filter((n) => n.props.className === 'card cal-daycard');
  assert.equal(
    render().some((n) => n.props.className === 'stack cal-selection'),
    false,
    'empty today has no block in full mode',
  );
  pick('2026-10-09');
  let nodes = render();
  assert.equal(details(nodes).length, 1);
  assert.ok(nodes.indexOf(details(nodes)[0]) < nodes.findIndex((n) => n.type === 'ScopeReport'));
  assert.equal(nodes.find((n) => n.type === 'ScopeReport')!.props.selectedChargeDate, '2026-10-09');
  details(nodes)[0].props.onClick();
  assert.equal(opened[0], sub);
  pick('2026-10-10');
  assert.equal(
    render().some((n) => n.props.className === 'stack cal-selection'),
    false,
  );
  pick('2026-10-09');
  assert.equal(details(render()).length, 1);
  pick('2026-10-09');
  assert.equal(details(render()).length, 0, 'second click removes the selected block');
  assert.equal(render().find((n) => n.type === 'ScopeReport')!.props.selectedChargeDate, undefined);
  pick('2026-10-09');
  render()
    .find((n) => n.props['aria-label'] === 'calendar.next')!
    .props.onClick();
  assert.equal(details(render()).length, 0, 'month navigation clears selection');
});

test('calendar full selection scrolls into view only when needed and respects reduced motion', () => {
  for (const [top, bottom, reduced, expected] of [
    [100, 250, false, undefined],
    [600, 850, false, 'smooth'],
    [30, 170, true, 'instant'],
  ] as const) {
    const scrolls: unknown[] = [];
    const element = {
      querySelector: () => null,
      style: { scrollMarginTop: '' },
      getBoundingClientRect: () => ({ top, bottom }),
      scrollIntoView: (opts: unknown) => scrolls.push(opts),
    };
    const r = harness(
      '../app/src/views/Calendar.tsx',
      'Calendar',
      { 'cal-report-mode': 'full' },
      {
        allCharges: () => [
          {
            date: today,
            amount: 10,
            currency: 'USD',
            sub: { id: 's', name: 'Fictional', start: today, price: 10, currency: 'USD', status: 'active', cycle: { unit: 'month', every: 1 } },
          },
        ],
        useRef: () => ({ current: element }),
        window: { innerHeight: 700 },
        matchMedia: () => ({ matches: reduced }),
        document: { addEventListener() {}, removeEventListener() {}, querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 60 }) }) },
        stopLabel: () => undefined,
      },
    );
    r.render('Calendar', { state: { ...st, readonly: true }, today, onOpen() {}, onIcs() {} });
    assert.deepEqual(scrolls, expected ? [{ block: 'nearest', behavior: expected }] : []);
    assert.equal(element.style.scrollMarginTop, '60px');
  }
});

test('monthly report hides selected-day charge/refund rows, restores them on deselection and keeps complete totals', () => {
  const sub: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-09',
    status: 'active',
  };
  const state = { ...st, subscriptions: [sub] };
  const row = (date: string, amount = 10): reports.ChargeRow => ({ sub, date, amount, original: { sub, date, amount, currency: 'USD', projected: false } });
  const selected = row('2026-10-26'),
    other = row('2026-10-28'),
    refund = row('2026-10-26', -3);
  const report: reports.ScopeReport = {
    blocks: [
      { type: 'headline', mode: 'month', month: '2026-10', total: 27, paid: 7, pending: 20, count: 3, previous: { amount: 0 } },
      { type: 'top', mode: 'month', rows: [selected, other] },
      { type: 'upcoming', rows: [selected, other, row('2026-10-26', 20)], total: 40 },
      { type: 'losses', rows: [], refunds: [refund], refunded: 3, loss: 0, incomplete: false },
    ],
  };
  const r = harness('../app/src/components/ScopeReport.tsx', 'ScopeReport', {}, { useId: () => 'scope', intlLocale: () => 'en-US', numberFormat });
  const render = (selectedChargeDate?: string) =>
    r.render('ScopeReport', { report, state, today, selectedChargeDate, onOpen() {}, title: 'Month', open: true, animate: false, onToggle() {} });
  const rows = (nodes: Node[]) => nodes.filter((n) => n.props.className === 'scope-row scope-tap');
  const selectedNodes = render('2026-10-26');
  assert.equal(rows(selectedNodes).length, 1, 'only the other day remains, without an empty upcoming/refund card');
  assert.ok(rows(selectedNodes)[0].children.some((n) => all(n).some((n) => n.children.includes(format.cnDateAuto(other.date, today)))));
  assert.ok(
    selectedNodes.some((n) => n.children.includes(format.flow(-27, 'USD'))),
    'headline still contains selected charges and refund',
  );
  assert.equal(rows(render()).length, 4, 'deselection restores all distinct top/upcoming/refund rows');
  const copying = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'copy',
      intlLocale: () => 'en-US',
      numberFormat,
      useState: () => ['copying', () => {}],
    },
  );
  const copied = copying.render('ScopeReport', {
    report,
    state,
    today,
    selectedChargeDate: '2026-10-26',
    onOpen() {},
    title: 'Month',
    open: true,
    animate: false,
    onToggle() {},
  });
  assert.equal(rows(copied).length, 4, 'PNG capture retains every report row, including the selected day');
});

test('monthly movement preserves provider termination, stop reason, multi-event and zero-net history in one card', () => {
  const base: Subscription = {
    id: 'stopped',
    name: 'Fictional stopped plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-01',
    status: 'terminated',
    end: '2026-10-10',
    stop: { kind: 'terminate', date: '2026-10-10', paidThrough: '2026-10-31', reason: 'Fictional provider closure' },
  };
  const price = (id: string, amounts: number[]): Subscription => ({
    ...base,
    id,
    name: id,
    status: 'active',
    end: undefined,
    stop: undefined,
    price: amounts.at(-1)!,
    priceHistory: amounts.map((amount, i) => ({ from: ['2025-01-01', '2026-10-03', '2026-10-12'][i], amount })),
  });
  const state = { ...st, subscriptions: [base, price('multi', [10, 20, 30]), price('zero-net', [10, 20, 10])] };
  const opened: Subscription[] = [];
  const r = harness('../app/src/components/ScopeReport.tsx', 'ScopeReport', {}, { useId: () => 'scope', intlLocale: () => 'en-US', numberFormat });
  const nodes = r.render('ScopeReport', {
    report: reports.monthReport(state, '2026-10', today),
    state,
    today,
    onOpen: (s: Subscription) => opened.push(s),
    title: 'Month',
    animate: false,
    open: true,
    onToggle() {},
  });
  assert.equal(
    nodes.some((n) => String(n.props.className).includes('scope-block scope-events')),
    false,
  );
  const movement = nodes.find((n) => n.props.className === 'scope-movements')!;
  const rows = all(movement).filter((n) => n.type === 'button');
  assert.equal(rows.length, 4, 'two net movements plus the two zero-net price events');
  const text = JSON.stringify(movement.children);
  assert.ok(text.includes('scope.event.terminate'));
  assert.ok(text.includes('Fictional provider closure'));
  const losses = nodes.find((n) => String(n.props.className).includes('scope-block scope-losses'))!;
  assert.equal(JSON.stringify(losses.children).includes('scope.event.terminate'), false, 'stop context is already owned by the movement row');
  assert.ok(text.includes(format.cnDateAuto('2026-10-03', today)));
  assert.ok(text.includes(format.cnDateAuto('2026-10-12', today)));
  rows.find((n) => all(n).some((c) => c.children.includes(base.name)))!.props.onClick();
  assert.equal(opened.at(-1), base);
});

test('scope history remains visible without monthly movement; unbranded payment methods use a wallet glyph', () => {
  const sub: Subscription = {
    id: 'new',
    name: 'Fictional plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-03',
    status: 'active',
  };
  const state = { ...st, subscriptions: [sub], methods: [{ id: 'plain', name: 'Demo Card 1', kind: 'card' as const, currency: 'USD' }] };
  const r = harness(
    '../app/src/components/ScopeReport.tsx',
    'ScopeReport',
    {},
    {
      useId: () => 'scope',
      intlLocale: () => 'en-US',
      numberFormat,
      bankOf: () => undefined,
      brandOf: () => undefined,
      methodLogo: () => undefined,
    },
  );
  const props = { state, today, onOpen() {}, title: 'Scope', animate: false, open: true, onToggle() {} };
  const nodes = r.render('ScopeReport', { ...props, report: reports.scopeReport(state, [sub], today) });
  const event = nodes.find((n) => String(n.props.className).includes('scope-block scope-events'))!;
  assert.ok(all(event).some((n) => n.children.includes('scope.event.start')));
  const marks = r.render('ScopeReport', {
    ...props,
    report: { blocks: [{ type: 'composition', categories: [], methods: [{ key: 'plain', amount: 10, share: 1 }] }] },
  });
  assert.ok(marks.some((n) => n.type === 'Icon' && n.props.name === 'wallet' && n.props.size === 18));
  assert.equal(
    marks.some((n) => n.type === 'MethodMark'),
    false,
  );
});

test('calendar groups dates chronologically, follows the currency preference and retains whole-row detail actions', () => {
  const subscriptions = ['Long fictional subscription name', 'Same day EUR', 'Refund'].map((name, i) => ({
    id: String(i),
    name,
    category: 'Tools',
    tags: [],
    price: 10,
    currency: i === 1 ? 'EUR' : 'USD',
    start: '2026-09-22',
    status: 'active',
    cycle: { unit: 'month', every: 1 },
  })) as Subscription[];
  const charges = [
    { sub: subscriptions[0], date: today, amount: 10, currency: 'USD', projected: false },
    { sub: subscriptions[1], date: today, amount: 5, currency: 'EUR', projected: false },
    { sub: subscriptions[2], date: '2026-10-16', amount: -3, currency: 'USD', projected: false, kind: 'refund' },
  ];
  const state = {
    ...st,
    readonly: true,
    subscriptions,
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
    fx: { base: 'USD' as const, rates: { USD: 1, CNY: 7, EUR: 0.9 }, fetchedAt: today },
  };
  for (const orig of [false, true]) {
    const money = harness('../app/src/components/MoneyPair.tsx', 'useMoneyPair', {}, { useOrig: () => orig });
    const opened: Subscription[] = [];
    const r = harness(
      '../app/src/views/Calendar.tsx',
      'Calendar',
      {},
      {
        allCharges: () => charges,
        sumBase: (s: AppState, rows: billing.Charge[]) => rows.reduce((n, c) => n + fx.chargeValue(s, c), 0),
        useMoneyPair: () => money.call('useMoneyPair', state),
      },
    );
    const render = () => r.render('Calendar', { state, today, onOpen: (sub: Subscription) => opened.push(sub), onIcs() {} });
    let nodes = render();
    assert.deepEqual(
      nodes.filter((n) => n.props['data-date']).map((n) => n.props['data-date']),
      ['2026-10-16', today],
    );
    const timeline = nodes.find((n) => n.props.className === 'cal-charge-list')!;
    const rows = all(timeline).filter((n) => n.props.className === 'cal-charge-row');
    assert.equal(rows.length, 3);
    const amounts = rows.map((n) => all(n).find((n) => n.type === 'Amount')!.props);
    assert.deepEqual(
      amounts.map((n) => n.ccy),
      orig ? ['USD', 'USD', 'EUR'] : ['CNY', 'CNY', 'CNY'],
    );
    assert.equal(amounts[0].value, orig ? 3 : 21);
    assert.equal(amounts[1].value, orig ? -10 : -70);
    const refundGrid = nodes.find((n) => n.props['aria-label'] === format.cnDate('2026-10-16', true))!;
    const gridAmount = all(refundGrid).find((n) => n.type === 'Amount')!;
    assert.equal(gridAmount.props.ccy, 'CNY');
    assert.equal(gridAmount.props.value, 21);
    assert.equal(gridAmount.props.decimals, 0);
    assert.equal(all(timeline).filter((n) => n.props.className === 'cal-charge-day today').length, 1);
    assert.ok(nodes.some((n) => n.props['data-date'] === today));
    rows[1].props.onClick();
    assert.equal(opened[0], subscriptions[0]);
    const details = nodes.filter((n) => n.props.className === 'card cal-daycard');
    assert.equal(all(details[0]).find((n) => n.type === 'Amount')!.props.ccy, orig ? 'USD' : 'CNY');
    nodes.find((n) => n.props['aria-label'] === format.cnDate('2026-10-17', true))!.props.onClick();
    nodes = render();
    assert.equal(
      nodes.some((n) => n.props.className === 'stack cal-selection' || n.props.className === 'cal-none'),
      false,
    );
    nodes.find((n) => n.props['aria-label'] === 'calendar.next')!.props.onClick();
    assert.equal(
      render().some((n) => n.props.className === 'cal-charge-day today'),
      false,
    );
  }
});

test('calendar day cards show charged coverage and real stop/pause dates without a missing next-charge placeholder', () => {
  for (const paused of [false, true]) {
    const sub: Subscription = {
      id: 's',
      name: 'Fictional',
      category: 'Tools',
      tags: [],
      price: 20,
      currency: 'USD',
      start: '2026-07-06',
      cycle: { unit: 'month', every: 1 },
      status: paused ? 'paused' : 'cancelled',
      ...(paused ? { pausedAt: '2026-10-18' } : { end: '2026-10-16', stop: { kind: 'cancel', date: '2026-10-16', paidThrough: '2026-11-05' } }),
    };
    const r = harness(
      '../app/src/views/Calendar.tsx',
      'Calendar',
      {},
      {
        allCharges: () => [{ sub, date: '2026-10-06', amount: 20, currency: 'USD', projected: false }],
        t: (key: string, args: Record<string, unknown> = {}) => `${key} ${Object.values(args).join(' ')}`,
      },
    );
    const render = () => r.render('Calendar', { state: { ...st, readonly: true, subscriptions: [sub] }, today, onOpen() {}, onIcs() {} });
    render()
      .find((n) => n.props['aria-label'] === format.cnDate('2026-10-06', true))!
      .props.onClick();
    const card = render().find((n) => n.props.className === 'card cal-daycard')!;
    const content = all(card)
      .flatMap((n) => n.children)
      .filter((n) => typeof n === 'string')
      .join(' ');
    assert.ok(content.includes(format.cnDateAuto('2026-10-06', today)) && content.includes(format.cnDateAuto('2026-11-05', today)));
    assert.ok(content.includes(format.cnDateAuto(paused ? '2026-10-18' : '2026-10-16', today)));
    assert.ok(!content.includes('calendar.nextCharge') && !content.includes('—'));
    assert.equal(all(card).find((n) => n.type === 'SubIcon')!.props.size, 48);
  }
});

test('calendar keeps a long month complete and selection never scrolls a nested list', () => {
  for (const reduced of [false, true]) {
    const scrolls: unknown[] = [];
    let refs = 0;
    const group = { getBoundingClientRect: () => ({ top: 720, bottom: 850 }) };
    const list = {
      querySelector: () => group,
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 20,
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      scrollTo: (opts: unknown) => scrolls.push(opts),
    };
    const r = harness(
      '../app/src/views/Calendar.tsx',
      'Calendar',
      {},
      {
        useRef: () => ({ current: refs++ === 0 ? null : list }),
        matchMedia: () => ({ matches: reduced }),
        allCharges: (state: AppState, from: string, to: string, day: string) =>
          state.subscriptions.flatMap((sub) => billing.chargesBetween(sub, from, to, day)),
      },
    );
    const subscriptions: Subscription[] = Array.from({ length: 24 }, (_, i) => ({
      id: `long-month-${i}`,
      name: `Fictional subscription ${i}`,
      category: 'Tools',
      tags: [],
      price: 10,
      currency: 'USD',
      cycle: { unit: 'month', every: 1 },
      start: `2022-10-${String(i + 1).padStart(2, '0')}`,
      status: 'active',
    }));
    const props = { state: { ...st, subscriptions, readonly: true }, today, onOpen() {}, onIcs() {} };
    let nodes = r.render('Calendar', props);
    assert.deepEqual(scrolls, [], 'initial selection leaves the full month in page flow');
    const rows = () => nodes.filter((n) => n.props.className === 'cal-charge-row');
    assert.equal(rows().length, 24);
    nodes.find((n) => n.props['aria-label'] === format.cnDate('2026-10-24', true))!.props.onClick();
    nodes = r.render('Calendar', props);
    assert.deepEqual(scrolls, [], 'changing the selected date never scrolls a nested list');
    assert.equal(rows().length, 24);
    assert.ok(nodes.some((n) => n.props['data-date'] === '2026-10-24'));
    assert.equal(nodes.filter((n) => n.props.className === 'cal-charge-day today').length, 1, 'today stays red independently of selection');
  }
});

test('member rows show one dynamic due date instead of claiming no receipts', () => {
  const member = { id: 'm', name: 'Fictional member', share: 5, payments: [{ date: today, amount: 5, currency: 'USD', until: '2026-10-31' }] };
  const sub: Subscription = {
    id: 'shared',
    name: 'Shared plan',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-01',
    status: 'active',
    share: { role: 'owner', seats: 2, members: [member] },
  };
  const r = harness('../app/src/views/Carpool.tsx', 'MemberRows', {}, { ...carpool, contactText: () => '', perBill: () => '' });
  const render = () => JSON.stringify(r.render('MemberRows', { state: { ...st, subscriptions: [sub] }, s: sub, today, ro: false, onMember() {} }));
  // 成员行只写一条日期：欠款「应收 某日」，结清「下次应收 某日」；有收款记录时不再出现「尚未收款」
  const rendered = render();
  assert.ok(rendered.includes('family.pool.dueOn') || rendered.includes('family.pool.nextDueOn'));
  assert.ok(!rendered.includes('family.pool.noPay'));
  sub.share!.members = [{ ...member, payments: [] }];
  assert.ok(render().includes('family.pool.dueOn'));
  assert.ok(!render().includes('family.pool.noPay'));
});

test('calendar lifetime charge has one lifetime label and a purchase date beside recurring coverage', () => {
  const subscriptions: Subscription[] = ['month', 'lifetime'].map((unit, i) => ({
    id: String(i),
    name: `Fictional ${unit}`,
    category: 'Tools',
    tags: [],
    price: 20,
    currency: 'USD',
    start: today,
    cycle: { unit: unit as 'month' | 'lifetime', every: 1 },
    status: 'active',
  }));
  const r = harness(
    '../app/src/views/Calendar.tsx',
    'Calendar',
    {},
    {
      allCharges: () => subscriptions.map((sub) => ({ sub, date: today, amount: 20, currency: 'USD', projected: false })),
    },
  );
  const nodes = r.render('Calendar', { state: { ...st, readonly: true, subscriptions }, today, onOpen() {}, onIcs() {} });
  const cards = nodes.filter((n) => n.props.className === 'card cal-daycard');
  assert.equal(cards.length, 2);
  const lifetime = all(cards[1]);
  assert.equal(
    lifetime.some((n) => n.children.includes('list.status.lifetime')),
    false,
    'cycle already identifies lifetime',
  );
  const info = lifetime.find((n) => n.props.className === 'cal-dc-info')!;
  assert.ok(all(info).some((n) => n.children.includes('editor.field.purchased') && n.children.includes(format.cnDateAuto(today, today))));
  assert.ok(
    all(cards[0]).some((n) => n.children.includes(format.cnDateAuto('2026-11-21', today))),
    'recurring coverage remains visible',
  );
});

test('payment marks fall back for missing, legacy and failed logos and recover when the logo changes', () => {
  const r = harness(
    '../app/src/components/ui.tsx',
    'MethodMark',
    {},
    {
      base: (s: string) => s,
      methodRegion: () => undefined,
      BRANDS: [],
      KIND_BG: { credit: '#222', other: '#444' },
      paletteColor: (value: string | undefined, fallback: string) => value ?? fallback,
    },
  );
  const render = (logo?: string, kind?: string) => r.render('MethodMark', { m: { id: 'm', name: 'Fictional Visa', currency: 'USD', kind, logo } });
  const glyph = (nodes: Node[]) => nodes.some((n) => typeof n.type === 'function' && n.type.name === 'Icon' && n.props.name === 'wallet');
  assert.ok(glyph(render(undefined, 'credit')));
  let nodes = render();
  assert.ok(glyph(nodes), 'legacy method without kind gets a visible glyph');
  assert.equal(nodes[0].props.style.background, '#444');
  nodes = render('/missing-logo.svg', 'credit');
  nodes.find((n) => n.type === 'img')!.props.onError();
  assert.ok(glyph(render('/missing-logo.svg', 'credit')));
  nodes = render('/replacement.svg', 'credit');
  assert.equal(glyph(nodes), false);
  assert.equal(nodes.find((n) => n.type === 'img')!.props.src, '/replacement.svg');
});

test('收款保存失败保留草稿且不关闭；重试成功只增加一条并关闭', async () => {
  const member = {
    id: 'm',
    name: 'Member',
    share: 7,
    fee: 44,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2025-10-14',
    receipts: [{ id: 'o', date: '2025-10-14', amount: 0, currency: 'CNY', periods: ['2025-10-14', '2026-04-14'], opening: true }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-10-14',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-10-14', members: [member] },
  };
  let fail = true,
    closed = 0;
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'ReceiptForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      getState: () => ({ ...st, subscriptions: [sub] }),
      run: async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch {
          /* Matches run's toast-and-retain behavior. */
        }
      },
      saveSub: async (s: Subscription) => {
        if (fail) throw Error('offline');
        saved = s;
      },
    },
  );
  const render = () =>
    r.render('ReceiptForm', {
      state: st,
      s: sub,
      member,
      onDone() {
        closed++;
      },
    });
  const note = () => render().find((n) => n.type === 'input' && n.props.placeholder === 'receivable.notePh')!;
  note().props.onChange({ target: { value: 'keep draft' } });
  const record = () =>
    all(render().find((n) => n.type === 'Sheet')!.props.foot)
      .find((n) => n.type === 'button' && n.children.includes('receivable.record'))!
      .props.onClick();
  await record();
  assert.equal(closed, 0);
  assert.equal(saved, undefined);
  assert.equal(note().props.value, 'keep draft');
  fail = false;
  await record();
  assert.equal(closed, 1);
  const receipts = saved!.share!.members[0].receipts!;
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.at(-1)!.periods, ['2026-10-14']);
});

test('成员先改收费再改生效日只留下一个调整，今天标准与旧收款保持', async () => {
  const member = {
    id: 'm',
    name: 'Member',
    share: 6.67,
    fee: 40,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2025-10-14',
    receipts: [{ id: 'o', date: '2025-10-14', amount: 0, currency: 'CNY', periods: ['2025-10-14', '2026-04-14'], opening: true }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-10-14',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-10-14', members: [member] },
  };
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      linkPerson: async () => ({}),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  const render = () => r.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  expandMember(render());
  render()
    .find((n) => n.type === 'Picker' && n.props.value === 'follow')!
    .props.onChange('custom');
  // 没改金额前不问生效日
  assert.equal(
    render().some((n) => n.type === 'Cell' && n.props.label === 'family.collect.feeFrom'),
    true,
  );
  render()
    .find((n) => n.type === 'NumInput' && n.props.value === 40)!
    .props.onValue(44);
  const dateCell = render().find((n) => n.type === 'Cell' && n.props.label === 'family.collect.feeFrom')!;
  all(dateCell)
    .find((n) => n.type === 'DatePicker')!
    .props.onChange('2026-11-01');
  await all(render().find((n) => n.type === 'Sheet')!.props.foot)
    .find((n) => n.type === 'button' && n.children.includes('family.member.save'))!
    .props.onClick();
  assert.equal(saved!.share!.members[0].fee, 40);
  assert.deepEqual(
    saved!.share!.members[0].feeHistory!.map((p) => [p.from, p.fee]),
    [
      ['2025-10-14', 40],
      ['2026-11-01', 44],
    ],
  );
});

test('删除一笔收款：它抵扣的期恢复为没收，期初结清不受影响；成员表单和收款表单里删结果一样', async () => {
  const member = {
    id: 'm',
    name: 'Member',
    share: 7,
    fee: 44,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2025-10-14',
    receipts: [
      { id: 'o', date: '2025-10-14', amount: 0, currency: 'CNY', periods: ['2025-10-14'], opening: true },
      { id: 'r1', date: '2026-04-20', amount: 44, currency: 'CNY', periods: ['2026-04-14'] },
    ],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-10-14',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-10-14', members: [member] },
  };
  let saved: Subscription | undefined;
  // 每个表单各用一份 harness：状态按调用顺序存放，不能混用
  const make = () =>
    harness(
      '../app/src/views/Members.tsx',
      'MemberForm,ReceiptForm',
      {},
      {
        ...carpool,
        statusOf: carpool.memberStatus,
        Sheet: 'Sheet',
        DatePicker: 'DatePicker',
        Toggle: 'Toggle',
        CurrencySelect: 'CurrencySelect',
        NumInput: 'NumInput',
        Picker: 'Picker',
        ConfirmButton: 'ConfirmButton',
        todayIn: () => today,
        ask: async () => {
          throw new Error('record deletion must not open ask');
        },
        getState: () => ({ ...st, subscriptions: [sub] }),
        linkPerson: async () => ({}),
        run: (fn: () => Promise<unknown>) => fn(),
        saveSub: async (next: Subscription) => {
          saved = next;
        },
      },
    );
  const r = make();
  const left = () => saved!.share!.members[0].receipts!.map((x) => x.id);
  // 成员表单里点 r1 抵扣的那一格，确认按钮在小窗内，确认后才关闭
  const form = () => r.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  form()
    .find((n) => n.type === 'button' && n.props['data-period'] === '2026-04-14')!
    .props.onClick({ currentTarget: 'cell' });
  const pop = form().find((n) => n.type === 'Pop')!;
  assert.equal(saved, undefined);
  assert.ok(
    form().some((n) => n.type === 'Pop'),
    'the confirmation stays in the popover',
  );
  all(pop)
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(left(), ['o']);
  assert.equal(
    form().some((n) => n.type === 'Pop'),
    false,
    'the popover closes after confirming',
  );
  // 点开那一笔在收款表单里删，结果一样
  saved = undefined;
  await all(
    make()
      .render('ReceiptForm', { state: st, s: sub, member, editId: 'r1', onDone() {} })
      .find((n) => n.type === 'Sheet')!.props.foot,
  )
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(left(), ['o']);
  const after = { ...sub, share: { ...sub.share!, members: saved!.share!.members } };
  assert.equal(billing.memberUnpaidFrom(after, after.share.members[0]), '2026-04-14');
});

test('person avatar drafts remain unsaved until Save; server field order does not leave Save enabled', async () => {
  const people = await import('./people.ts');
  const state = { ...st, people: [{ id: 'person', name: 'Fictional person', color: 'blue' as const }] };
  const avatar = 'data:image/webp;base64,fixture';
  let writes = 0;
  const r = harness(
    '../app/src/views/People.tsx',
    'PersonSheet',
    {},
    {
      ...people,
      PERSON_COLORS,
      Act: 'Act',
      Pencil: 'Pencil',
      Sheet: 'Sheet',
      ContactField: 'ContactField',
      contactText: () => '',
      compressAvatar: async () => avatar,
      ask: async () => true,
      run: (fn: () => Promise<unknown>) => fn(),
      savePerson: async (p: (typeof state.people)[number]) => {
        writes++;
        // Simulate normalized server field order and an added timestamp.
        const saved = { name: p.name, createdAt: '2026-10-22', ...p };
        state.people = [saved];
        return saved;
      },
    },
  );
  const render = () => r.render('PersonSheet', { state, today, l: { person: state.people[0], items: [], owed: 0, received: 0 }, onClose() {}, onOpen() {} });
  const walkFoot = (n: Node): Node[] => all(n.props.foot);
  const save = () =>
    render()
      .filter((n) => n.type === 'Sheet')
      .flatMap(walkFoot)
      .find((n) => n.type === 'button' && n.props.className === 'btn primary')!;
  assert.equal(save().props.disabled, true);
  render()
    .find((n) => n.type === 'input' && n.props.type === 'file')!
    .props.onChange({ target: { files: [{}], value: '' } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes, 0);
  assert.equal(save().props.disabled, false);
  await save().props.onClick();
  assert.equal(writes, 1);
  assert.equal(save().props.disabled, true);
  const remove = render().find((n) => n.type === 'ConfirmButton' && n.children.includes('people.avatar.remove'))!;
  await remove.props.onConfirm();
  assert.equal(writes, 1);
  assert.equal(save().props.disabled, false);
  await save().props.onClick();
  assert.equal(writes, 2);
  assert.equal(save().props.disabled, true);
});

/** 成员弹窗：有欠款时默认是记收款，点底部「调整收费与退出」切到设置；已结清的本来就是设置 */
test('成员表单：改自定义收费从生效日起记调价', async () => {
  const member = {
    id: 'm',
    name: 'Member',
    share: 7,
    fee: 44,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2025-01-17',
    receipts: [{ id: 'o', date: '2025-01-17', amount: 0, currency: 'CNY', periods: ['2025-01-17', '2025-07-17', '2026-01-17'], opening: true }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-01-17',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-01-17', members: [member] },
  };
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      linkPerson: async () => ({}),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  const render = () => r.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  const save = async () =>
    all(render().find((n) => n.type === 'Sheet')!.props.foot)
      .find((n) => n.type === 'button' && n.children.includes('family.member.save'))!
      .props.onClick();
  expandMember(render());
  render()
    .find((n) => n.type === 'Picker' && n.props.value === 'follow')!
    .props.onChange('custom');
  render()
    .find((n) => n.type === 'NumInput' && n.props.value === 44)!
    .props.onValue(50);
  await save();
  const m = saved!.share!.members[0];
  assert.equal(m.custom, true);
  assert.equal(m.fee, 50);
  assert.deepEqual(m.feeHistory!.at(-1)!.from, today);
});

test('转让和扣款删除通过胶囊执行，保留同日其他记录且不再打开 ask', async () => {
  const phases = await import('./phases.ts');
  const sub: Subscription = {
    id: 'fictional-plan',
    name: 'Orbit',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    payments: [
      { date: today, amount: 10, currency: 'CNY' },
      { date: today, amount: 2, currency: 'CNY', kind: 'adjust' },
    ],
  };
  let saved: Subscription | undefined;
  let closed = 0;
  const deps = {
    ...phases,
    Sheet: 'Sheet',
    DatePicker: 'DatePicker',
    CurrencySelect: 'CurrencySelect',
    MethodPicker: 'MethodPicker',
    MoneyInput: 'MoneyInput',
    ConfirmButton: 'ConfirmButton',
    getState: () => ({ ...st, subscriptions: [sub] }),
    ask: () => {
      throw new Error('deletion must not open ask');
    },
    run: (fn: () => Promise<unknown>) => fn(),
    saveSub: async (s: Subscription) => {
      saved = s;
    },
  };
  const r = harness('../app/src/views/PaymentSheet.tsx', 'PaymentSheet', {}, deps);
  const foot = r.render('PaymentSheet', { sub, today, edit: { pay: sub.payments![0], index: 0 }, onClose: () => closed++ }).find((n) => n.type === 'Sheet')!
    .props.foot;
  assert.equal(saved, undefined);
  await all(foot)
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  assert.deepEqual(saved!.payments, [sub.payments![1]]);
  assert.equal(closed, 1);

  const list = [
    { kind: 'buy', date: today, amount: 20, currency: 'CNY' },
    { kind: 'sell', date: today, amount: 5, currency: 'CNY' },
  ];
  let transfers: unknown;
  const tr = harness('../app/src/components/TransferSheet.tsx', 'TransferSheet', {}, deps);
  const tf = tr
    .render('TransferSheet', {
      list,
      index: 0,
      currency: 'CNY',
      today,
      onSave: (next: unknown) => {
        transfers = next;
      },
      onClose() {},
    })
    .find((n) => n.type === 'Sheet')!.props.foot;
  assert.equal(transfers, undefined);
  await all(tf)
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  assert.deepEqual(transfers, [list[1]]);
});

test('成员、人员和渠道胶囊确认后删除，成员删除保留其他成员，人员引用仍阻止删除', async () => {
  const people = await import('./people.ts');
  const member = {
    id: 'm',
    name: 'Fictional member',
    share: 1,
    joined: '2026-01-01',
    receipts: [{ id: 'r', date: today, amount: 10, currency: 'CNY', periods: ['2026-10-01'] }],
  };
  const other = { ...member, id: 'other', name: 'Other member' };
  const sub: Subscription = {
    id: 's',
    name: 'Orbit',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 3, collectFrom: '2026-01-01', members: [member, other] },
  };
  let saved: Subscription | undefined;
  let deleted = '';
  let closed = 0;
  const deps = {
    ...people,
    ...carpool,
    statusOf: carpool.memberStatus,
    Sheet: 'Sheet',
    DatePicker: 'DatePicker',
    CurrencySelect: 'CurrencySelect',
    NumInput: 'NumInput',
    ConfirmButton: 'ConfirmButton',
    todayIn: () => today,
    getState: () => ({ ...st, subscriptions: [sub] }),
    ask: () => {
      throw new Error('deletion must not open ask');
    },
    run: (fn: () => Promise<unknown>) => fn(),
    saveSub: async (s: Subscription) => {
      saved = s;
    },
    deletePerson: async (id: string) => {
      deleted = id;
    },
  };
  const r = harness('../app/src/views/Members.tsx', 'MemberForm', {}, deps);
  const renderForm = () => r.render('MemberForm', { state: st, s: sub, member, onClose: () => closed++ });
  const remove = all(renderForm().find((n) => n.type === 'Sheet')!.props.foot).find((n) => n.type === 'ConfirmButton')!;
  assert.equal(remove.props.hint, 'family.member.confirmDelete');
  assert.equal(saved, undefined);
  await remove.props.onConfirm();
  assert.deepEqual(saved!.share!.members, [other]);
  assert.equal(closed, 1);

  const person = { id: 'person', name: 'Fictional person', color: 'blue' };
  const state = { ...st, people: [person] };
  const pr = harness('../app/src/views/People.tsx', 'PersonSheet', {}, { ...deps, PERSON_COLORS, ContactField: 'ContactField' });
  const personFoot = (state: AppState) =>
    all(
      pr.render('PersonSheet', { state, today, l: { person, items: [], owed: 0, received: 0 }, onClose() {}, onOpen() {} }).find((n) => n.type === 'Sheet')!
        .props.foot,
    );
  assert.equal(deleted, '');
  await personFoot(state)
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  assert.equal(deleted, person.id);
  assert.equal(
    personFoot({ ...state, subscriptions: [{ ...sub, share: { ...sub.share!, members: [{ ...member, personId: person.id }] } }] }).some(
      (n) => n.type === 'ConfirmButton',
    ),
    false,
  );

  let channelDeleted = 0;
  const cr = harness('../app/src/views/Channels.tsx', 'ChannelSheet', {}, { ...deps, base: (s: string) => s, Toggle: 'Toggle' });
  const channel = { id: 'channel', name: 'Fictional email', kind: 'email', enabled: true, config: { to: 'fictional@example.test' } };
  const channelFoot = (isNew: boolean) =>
    all(
      cr.render('ChannelSheet', { c: channel, isNew, onClose() {}, onSave() {}, onDelete: () => channelDeleted++ }).find((n) => n.type === 'Sheet')!.props.foot,
    );
  assert.equal(channelDeleted, 0);
  channelFoot(false)
    .find((n) => n.type === 'ConfirmButton')!
    .props.onConfirm();
  assert.equal(channelDeleted, 1);
  assert.equal(
    channelFoot(true).some((n) => n.type === 'ConfirmButton'),
    false,
  );
});

test('弹窗底部删除就地确认：第一次点转红底并改为「确认删除？」，失焦收回，再点才执行', () => {
  let done = 0;
  const r = harness('../app/src/components/ConfirmButton.tsx', 'ConfirmButton', {}, { useEffect() {} });
  const button = () => r.render('ConfirmButton', { children: 'common.delete', onConfirm: () => done++ }).find((n) => n.type === 'button')!;
  assert.doesNotMatch(button().props.className, /armed|danger-solid/);
  button().props.onClick();
  assert.equal(done, 0);
  assert.match(button().props.className, /armed/);
  assert.match(JSON.stringify(button().children), /common\.confirmDelete/);
  assert.doesNotMatch(JSON.stringify(button().children), /common\.delete"/);
  button().props.onBlur();
  assert.doesNotMatch(button().props.className, /armed/);
  button().props.onClick();
  button().props.onClick();
  assert.equal(done, 1);
});

test('行尾删除需二次确认：第一次点只展开「确认」，第二次才删除；未保存条目直接删除', async () => {
  const g = globalThis as { matchMedia?: unknown };
  const had = g.matchMedia;
  g.matchMedia = () => ({ matches: true });
  try {
    let removed = 0;
    const r = harness('../app/src/components/RowActions.tsx', 'RowActions', {}, { IconButton: 'IconButton', useEffect() {} });
    const props = { onEdit() {}, editLabel: 'edit', removeLabel: 'remove', confirmLabel: 'confirm', onRemove: () => removed++ };
    const button = () =>
      all(r.render('RowActions', props))
        .filter((n) => n.type === 'IconButton')
        .at(-1)!;
    assert.equal(button().props['aria-label'], 'remove');
    button().props.onClick();
    assert.equal(removed, 0);
    assert.equal(button().props['aria-label'], 'confirm');
    // 失焦收回
    button().props.onBlur();
    assert.equal(button().props['aria-label'], 'remove');
    button().props.onClick();
    button().props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(removed, 1);

    let direct = 0;
    const single = harness('../app/src/components/RowActions.tsx', 'RowActions', {}, { IconButton: 'IconButton', useEffect() {} });
    all(single.render('RowActions', { removeLabel: 'remove', confirmLabel: 'confirm', onRemove: () => direct++ }))
      .find((n) => n.type === 'IconButton')!
      .props.onClick();
    assert.equal(direct, 1);
  } finally {
    g.matchMedia = had;
  }
});

test('停用说明里的金额单独着色：未退款损失为红色，已退款为绿色，无金额时只有文字', () => {
  const render = (summary: unknown) => {
    const r = harness(
      '../app/src/components/StopPanel.tsx',
      'StopText',
      {},
      { stopSummary: () => summary, t: (key: string, p?: { money?: string }) => (p?.money ? `${key}[${p.money}]` : key) },
    );
    return r.render('StopText', { sub: { currency: 'USD' }, today });
  };
  const money = (nodes: Node[]) => all(nodes).find((n) => n.type === 'b');
  const loss = money(render({ date: '2026-10-01', refunded: 0, unusedValue: 0.67 }));
  assert.equal(loss!.props.className, 'stop-money loss');
  assert.deepEqual(loss!.children, ['−$0.67']);
  const gain = money(render({ date: '2026-10-01', refunded: 5, refundStatus: 'full', unusedValue: 0 }));
  assert.equal(gain!.props.className, 'stop-money gain');
  assert.equal(money(render({ date: '2026-10-01', refunded: 0, unusedValue: 0 })), undefined);
  assert.deepEqual(all(render({ date: '2099-01-01', refunded: 0, unusedValue: 1 })), []);
});

test('下车时间条：不退保留已付未用灰段，退款截在退出前一天，窗口边界不溢出', () => {
  const r = harness('../app/src/views/Members.tsx', 'memberSegments');
  // 提前收了 1、2 月两期，1 月 16 日退出
  const m = {
    id: 'm',
    name: 'M',
    share: 31,
    fee: 31,
    billEvery: 1,
    joined: '2026-01-01',
    left: '2026-01-16',
    receipts: [{ id: 'r', date: '2026-01-01', amount: 62, currency: 'USD', periods: ['2026-01-01', '2026-02-01'] }],
  };
  const s = {
    ...st.subscriptions[0],
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    currency: 'USD',
    share: { role: 'owner', seats: 2, collectFrom: '2026-01-01', members: [m] },
  };
  const segments = (member: unknown, end = '2026-02-28') => r.call('memberSegments', s, member, today, '2026-01-01', end);
  assert.deepEqual(segments(m), [
    { from: '2026-01-01', until: '2026-01-15', kind: 'paid' },
    { from: '2026-01-16', until: '2026-02-28', kind: 'unused' },
  ]);
  assert.deepEqual(segments({ ...m, leaveRefund: { date: m.left, amount: 47, currency: 'USD' } }), [{ from: '2026-01-01', until: '2026-01-15', kind: 'paid' }]);
  assert.deepEqual(segments(m, '2026-01-10'), [{ from: '2026-01-01', until: '2026-01-10', kind: 'paid' }]);
});

test('下车控件默认建议金额，可编辑实际退款，清退出清退款，新成员不显示', () => {
  const m = {
    id: 'm',
    name: 'M',
    share: 31,
    joined: '2026-01-01',
    left: '2026-01-16',
    receipts: [{ id: 'r', date: '2026-01-01', amount: 31, currency: 'USD', periods: ['2026-01-01'] }],
  };
  const s = { start: '2026-01-01', cycle: { unit: 'month', every: 1 }, currency: 'USD', share: { collectFrom: '2026-01-01', members: [m] } };
  let member: any = m;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberLeaveFields',
    {},
    { DatePicker: 'DatePicker', NumInput: 'NumInput', CurrencySelect: 'CurrencySelect' },
  );
  const render = () =>
    r.render('MemberLeaveFields', {
      state: st,
      s,
      member,
      onChange: (patch: object) => {
        member = carpool.updateMemberLeave(member, patch);
      },
    });
  render()
    .find((n) => n.type === 'Seg')!
    .props.onChange('refund');
  assert.deepEqual(member.leaveRefund, { amount: 16, currency: 'USD', date: m.left });
  render()
    .find((n) => n.type === 'NumInput')!
    .props.onValue(12.34);
  render()
    .find((n) => n.type === 'DatePicker' && n.props.value === m.left && !n.props.clearable)!
    .props.onChange('2026-01-20');
  assert.equal(member.leaveRefund.amount, 12.34);
  assert.equal(member.leaveRefund.date, '2026-01-20');
  render()
    .find((n) => n.type === 'DatePicker' && n.props.clearable)!
    .props.onChange(undefined);
  assert.equal(member.leaveRefund, undefined);
  assert.ok(!render().some((n) => n.type === 'Seg'));
});

test('成员表单设置下车退款保留原始已付至，金额无效不能保存，新成员隐藏下车退款', async () => {
  const member = {
    id: 'm',
    name: 'M',
    share: 31,
    fee: 31,
    feeCurrency: 'USD',
    billEvery: 1,
    joined: '2026-01-01',
    receipts: [{ id: 'r', date: '2026-01-01', amount: 31, currency: 'USD', periods: ['2026-01-01'] }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 40,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 4, collectFrom: '2026-01-01', members: [member] },
  };
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      linkPerson: async () => ({}),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  const render = () => r.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  expandMember(render());
  const leaveFields = () => render().find((n) => typeof n.type === 'function' && (n.type as Function).name === 'MemberLeaveFields')!;
  const save = () => all(render().find((n) => n.type === 'Sheet')!.props.foot).find((n) => n.type === 'button' && n.children.includes('family.member.save'))!;
  leaveFields().props.onChange({ left: '2026-01-16', leaveRefund: { date: '2026-01-20', amount: 12, currency: 'USD' } });
  assert.ok(
    all(render().find((n) => n.type === 'Cell' && n.props.label === 'family.member.paidUntil')).some((n) =>
      n.children.includes(format.cnDateFull('2026-01-31')),
    ),
  );
  await save().props.onClick();
  assert.deepEqual(saved!.share!.members[0].receipts, member.receipts);
  leaveFields().props.onChange({ leaveRefund: { date: '2026-01-20', amount: 0, currency: 'USD' } });
  assert.equal(save().props.disabled, true);
  assert.ok(
    !r.render('MemberForm', { state: st, s: sub, onClose() {} }).some((n) => typeof n.type === 'function' && (n.type as Function).name === 'MemberLeaveFields'),
  );
});

test('退款行显示负现金流和退款标签，全额退款后仍保留累计账本，助手展示预览实际日期币种', () => {
  const member = {
    id: 'm',
    name: 'M',
    share: 3,
    joined: '2026-01-01',
    left: '2026-10-01',
    receipts: [{ id: 'r', date: '2026-01-01', amount: 31, currency: 'USD', periods: ['2026-01-01'] }],
    leaveRefund: { date: '2026-10-02', amount: 31, currency: 'USD' },
  };
  const s: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 40,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    start: '2026-01-01',
    share: { role: 'owner', seats: 4, collectFrom: '2026-01-01', members: [member] },
  };
  const r = harness(
    '../app/src/views/Carpool.tsx',
    'CarSheet,CarFacts',
    {},
    { Sheet: 'Sheet', NameLink: 'NameLink', perBill: () => '', createPortal: () => null },
  );
  const render = () => r.render('CarSheet', { state: st, s, today, book: carpool.carLedger(st, s, today), onClose() {}, onMember() {}, onOpenSub() {} });
  // 同年多条先展开；退款行仍与订阅详情共用同一套。
  const receiptsHead = render().find((n) => String(n.props.className ?? '').includes('ld-toggle'))!;
  (receiptsHead.props.onClick as () => void)();
  const refund = render().find(
    (n) => String(n.props.className ?? '').startsWith('ld-row dt-row') && all(n.children).some((x) => x.children.includes('family.sheet.refund')),
  )!;
  assert.ok(refund);
  assert.ok(all(refund.children).some((n) => n.children.includes(format.flow(-31, 'USD'))));
  const facts = r.render('CarFacts', { book: carpool.carLedger(st, s, today), base: 'USD' });
  assert.ok(!facts.some((n) => n.children.includes('family.sheet.noReceiptsYet')));
  const assistant = harness('../app/src/views/Assistant.tsx', 'summaryRows', {}, { storageKey: (s: string) => s, ...assistantFields });
  const rows = assistant.call('summaryRows', 'save_share_member', { member: 'm', leave_refund: { amount: 12 } }, st, 'USD', {
    member: { leave_refund: { date: '2026-10-02', currency: 'CNY' } },
  });
  assert.ok(rows.some(([key, value]: string[]) => key === 'family.refund.title' && value === format.flow(-12, 'CNY')));
  assert.ok(rows.some(([key, value]: string[]) => key === 'family.refund.date' && value === format.cnDateFull('2026-10-02')));
  const cleared = assistant.call('summaryRows', 'save_share_member', { member: 'm', left: null }, st);
  assert.ok(cleared.some(([key, value]: string[]) => key === 'family.refund.title' && value === 'family.refund.none'));
  assert.ok(cleared.some(([key, value]: string[]) => key === 'assistant.f.left' && value === 'family.member.notSet'));
});

test('合租成员主表和手机卡片收起已下车成员；展开保留灰色成员与历史收款', () => {
  const s: Subscription = {
    id: 'car',
    name: 'Fictional plan',
    category: 'Tools',
    tags: [],
    start: '2025-01-01',
    status: 'active',
    price: 120,
    currency: 'CNY',
    cycle: { unit: 'year', every: 1 },
    share: {
      role: 'owner',
      seats: 4,
      members: [
        { id: 'active', name: 'Active', share: 30, fee: 30, billEvery: 3 },
        { id: 'exempt', name: 'Exempt', share: 0, exempt: true },
        {
          id: 'left',
          name: 'Departed',
          share: 30,
          fee: 30,
          billEvery: 3,
          left: today,
          receipts: [{ id: 'r', date: '2026-01-01', amount: 30, currency: 'CNY', periods: ['2026-01-01'] }],
        },
      ],
    },
  };
  const state = { ...st, subscriptions: [s] };
  const members = harness('../app/src/views/Members.tsx', 'memberStatus,memberSegments,perBill', {}, { ...carpool });
  const r = harness(
    '../app/src/views/Carpool.tsx',
    'CarSheet,MemberTable,MemberRows,Vacancy',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      NameLink: 'NameLink',
      StatusPill: 'StatusPill',
      memberStatus: (...args: unknown[]) => members.call('memberStatus', ...args),
      memberSegments: (...args: unknown[]) => members.call('memberSegments', ...args),
      perBill: (...args: unknown[]) => members.call('perBill', ...args),
    },
  );
  let opened = 0;
  const props = { state, s, today, onMember: () => opened++, win: carpoolTimeline.carpoolTimeline(s, today, 3), expanded: false, onToggle() {} };
  const names = (nodes: Node[]) => nodes.filter((n) => n.props.className === 'car-member-row').map((n) => n.props['aria-label']);
  let nodes = r.render('MemberTable', props);
  assert.deepEqual(names(nodes), ['Active', 'Exempt']);
  const vacancies = nodes.filter((n) => typeof n.type === 'function' && n.type.name === 'Vacancy');
  // 车主自己占一座
  assert.equal(vacancies.length, 1);
  vacancies[0].props.onAdd();
  assert.equal(opened, 1);
  nodes = r.render('MemberTable', { ...props, expanded: true });
  assert.deepEqual(names(nodes), ['Active', 'Exempt', 'Departed']);
  assert.ok(nodes.some((n) => n.props.className === 'car-member-chip left'));
  const collapsedCards = r.render('MemberRows', props).filter((n) => n.type === 'button' && n.props.className === 'member-info');
  assert.equal(collapsedCards.length, 2);
  assert.equal(r.render('MemberRows', { ...props, includeLeft: true }).filter((n) => n.props.className === 'member departed').length, 1);
  const cellNodes = r.render('Vacancy', { onAdd: () => opened++, table: true });
  assert.equal(cellNodes.filter((n) => n.type === 'td').length, 4);
  assert.equal(cellNodes.filter((n) => n.type === 'td' && !all(n.children).length).length, 2);
  cellNodes[0].props.onClick();
  assert.equal(opened, 2);
  nodes = r.render('CarSheet', { ...props, book: carpool.carLedger(state, s, today), onClose() {}, onOpenSub() {} });
  // 已下车成员的历史收款仍留在收款表里（与订阅详情同一套按年表格，每年最多一条时平铺）
  assert.ok(nodes.some((n) => String(n.props.className ?? '').startsWith('ld-row dt-row') && all(n.children).some((x) => x.children.includes('Departed'))));
  const empty = { ...s, share: { ...s.share!, members: [] } };
  const emptyNodes = r.render('MemberTable', { ...props, s: empty });
  // 四座车没有成员时，除车主自己外还有三个空位
  assert.equal(emptyNodes.filter((n) => typeof n.type === 'function' && n.type.name === 'Vacancy').length, 3);
  assert.equal(
    emptyNodes.some((n) => typeof n.type === 'function' && n.type.name === 'DepartedToggle'),
    false,
  );
  const full = { ...s, share: { ...s.share!, seats: 1, members: s.share!.members.slice(0, 2) } };
  assert.equal(
    r.render('MemberTable', { ...props, s: full }).some((n) => typeof n.type === 'function' && n.type.name === 'Vacancy'),
    false,
  );
  // 下车成员的那笔收款仍归入原有账本。
  // 收款 / 付款切换在收付记录卡片的标题右侧
  assert.ok(
    nodes
      .flatMap((n) => all(n.props.aside))
      .some(
        (n) =>
          n.type === 'Seg' && n.props.options[0][1].props.full === 'family.sheet.tabIn' && n.props.options[1][1].props.short === 'family.sheet.tabOutShort',
      ),
  );
});

test('收款表点某一笔直接进入这笔收款的编辑，而不是成员资料', () => {
  const receipt = { id: 'r1', date: '2026-01-01', periods: ['2026-01-01'], amount: 40, currency: 'USD', note: '实收待核对' };
  const member = { id: 'm', name: 'M', share: 44, joined: '2026-01-01', receipts: [receipt] };
  const s: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 40,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    start: '2026-01-01',
    share: { role: 'owner', seats: 4, collectFrom: '2026-01-01', members: [member] },
  };
  const r = harness(
    '../app/src/views/Carpool.tsx',
    'CarSheet,CarFacts',
    {},
    { Sheet: 'Sheet', NameLink: 'NameLink', perBill: () => '', createPortal: () => null },
  );
  const calls: unknown[][] = [];
  const props = {
    state: st,
    s,
    today,
    book: carpool.carLedger(st, s, today),
    onClose() {},
    onOpenSub() {},
    onMember: () => calls.push(['member']),
    onPayment: (m: unknown, p: unknown) => calls.push(['payment', m, p]),
  };
  // 聚合时先点表头全部展开；每年最多一条时直接平铺
  r.render('CarSheet', props)
    .find((n) => n.props.className === 'ld-row ld-th ld-toggle table-head')
    ?.props.onClick();
  const row = r.render('CarSheet', props).find((n) => n.type === 'button' && String(n.props.className ?? '').startsWith('ld-row dt-row'))!;
  row.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'payment');
  assert.equal(calls[0][2], 'r1');
});

test('代付结清后第三格显示盈亏而不是「已结清」，未结清时仍是待收', () => {
  const r = harness('../app/src/views/Proxy.tsx', 'OwedOrNet', {}, { proxyRows: () => [] });
  const text = (nodes: Node[]) => JSON.stringify(nodes.map((n) => n.children));
  // 虚构的三期代付：全部收回，比实扣多收 ¥15
  const settled = [
    { chargedBase: 100, receivedBase: 105 },
    { chargedBase: 100, receivedBase: 105 },
    { chargedBase: 100, receivedBase: 105 },
  ];
  const done = r.render('OwedOrNet', { list: settled, base: 'CNY' });
  assert.match(text(done), /family\.strip\.profit/);
  assert.doesNotMatch(text(done), /proxy\.settled/);
  assert.ok(done.some((n) => n.props.className?.includes('done')));
  // 少收：亏损用红色
  const loss = r.render('OwedOrNet', { list: settled.map((x) => ({ ...x, receivedBase: 90 })), base: 'CNY' });
  assert.ok(loss.some((n) => n.props.className?.includes('loss')));
  // 收回与实扣相差不到 0.5 视为持平，不着色
  const even = r.render('OwedOrNet', { list: [{ chargedBase: 100, receivedBase: 100.2 }], base: 'CNY' });
  assert.match(text(even), /proxy\.table\.even/);
  // 还有待收：照旧显示待收期数
  const owed = r.render('OwedOrNet', { list: [...settled, { chargedBase: 100 }], base: 'CNY' });
  assert.match(text(owed), /proxy\.owedPeriods/);
  assert.doesNotMatch(text(owed), /family\.strip\.profit/);
});

test('所有入口打开同一个成员弹窗：欠款也不自动叠收款表单，点某笔收款才直接改那一笔；记下这笔推进已付至', async () => {
  const opening = (...periods: string[]) => [{ id: 'o', date: '2025-01-17', amount: 0, currency: 'CNY', periods, opening: true }];
  // 收了第一期，之后都欠着
  const member = { id: 'm', name: 'Member', share: 7, fee: 44, feeCurrency: 'CNY', billEvery: 6, joined: '2025-01-17', receipts: opening('2025-01-17') };
  const settled = { ...member, receipts: opening('2025-01-17', '2025-07-17', '2026-01-17', '2026-07-17') };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-01-17',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-01-17', members: [member] },
  };
  let saved: Subscription | undefined;
  let closed = false;
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberSheet,ReceiptForm',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      linkPerson: async () => ({}),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  // 每次换一个新的渲染器：入口只在打开时决定一次
  const route = (props: { member?: typeof member; editId?: string }) => {
    const plan = props.member ? { ...sub, share: { ...sub.share!, members: [props.member] } } : sub;
    const [node] = harness('../app/src/views/Members.tsx', 'MemberSheet', {}, { ...carpool, todayIn: () => today }).render('MemberSheet', {
      state: st,
      s: plan,
      onClose() {},
      ...props,
    });
    return [(node.type as Function).name, JSON.stringify(node.props.initialReceipt ?? null)];
  };

  // 同一个弹窗；欠款也只开弹窗，收款由弹窗里的「记收款」发起；从某笔收款进来才直接改那一笔
  assert.deepEqual(route({ member }), ['MemberForm', 'null']);
  assert.deepEqual(route({ member: settled }), ['MemberForm', 'null']);
  assert.deepEqual(route({ member, editId: 'o' }), ['MemberForm', '{"edit":"o"}']);
  assert.deepEqual(route({}), ['MemberForm', 'null']);
  const nodes = r.render('ReceiptForm', { state: st, s: sub, member, onDone: () => (closed = true) });
  const record = all(nodes.find((n) => n.type === 'Sheet')!.props.foot).find((n) => n.type === 'button' && n.children.includes('receivable.record'))!;
  assert.ok(nodes.some((n) => n.type === 'NumInput' && n.props.value === 44));
  await record.props.onClick();
  const m = saved!.share!.members[0];
  assert.equal(m.receipts!.length, 2);
  assert.deepEqual(m.receipts!.at(-1)!.periods, ['2025-07-17']);
  assert.equal(closed, true);
  // 不再有收款 / 免收切换；底部「免收」直接把勾的期记成免收，不记金额
  saved = undefined;
  const fresh = harness(
    '../app/src/views/Members.tsx',
    'ReceiptForm',
    {},
    {
      ...carpool,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  ).render('ReceiptForm', { state: st, s: sub, member, onDone() {} });
  assert.equal(
    fresh.some((n) => n.type === 'Seg'),
    false,
  );
  const waive = all(fresh.find((n) => n.type === 'Sheet')!.props.foot).find((n) => n.type === 'button' && n.props.className === 'btn danger-soft')!;
  assert.deepEqual(waive.children, ['receivable.modeWaiver']);
  await waive.props.onClick();
  const w = saved!.share!.members[0];
  assert.deepEqual(w.waivers!.at(-1)!.periods, ['2025-07-17']);
  assert.equal(w.receipts!.length, 1, 'waiving records no money');
});

test('欠了好几期：默认勾最早一期，再勾两期就补前三期，其余照样待收；免收的期画成已放弃', async () => {
  const member = { id: 'm', name: 'Member', share: 7, fee: 44, feeCurrency: 'CNY', billEvery: 6, joined: '2025-01-17' };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-01-17',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-01-17', members: [member] },
  };
  let saved: Subscription | undefined;
  const r = harness(
    '../app/src/views/Members.tsx',
    'ReceiptForm,memberSegments',
    {},
    {
      ...carpool,
      statusOf: carpool.memberStatus,
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      todayIn: () => today,
      getState: () => ({ ...st, subscriptions: [sub] }),
      run: (fn: () => Promise<unknown>) => fn(),
      saveSub: async (next: Subscription) => {
        saved = next;
      },
    },
  );
  const render = () => r.render('ReceiptForm', { state: st, s: sub, member, onDone() {} });
  // 2025-01-17 起半年一期，今天 2026-10-22 在第 4 期：共欠 4 期，都列出来
  const boxes = () => render().filter((n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(boxes().filter((n) => n.props.checked).length, 1);
  boxes()[1].props.onChange();
  boxes()[2].props.onChange();
  await all(render().find((n) => n.type === 'Sheet')!.props.foot)
    .find((n) => n.type === 'button' && n.children.includes('receivable.record'))!
    .props.onClick();
  const m = saved!.share!.members[0];
  assert.deepEqual(m.receipts![0].periods, ['2025-01-17', '2025-07-17', '2026-01-17']);
  assert.equal(m.receipts![0].amount, 132);
  const segs = r.call('memberSegments', saved!, m, today, '2025-01-01', '2027-06-30') as { kind: string; from: string }[];
  assert.deepEqual(
    segs.filter((g) => g.from < '2026-07-17').map((g) => g.kind),
    ['paid', 'paid', 'paid'],
  );
  assert.equal(segs.find((g) => g.from === '2026-07-17')!.kind, 'due');
  // 免掉旧账、只收本期：免收的期画成已放弃，不冒充已付
  const waived = {
    ...member,
    waivers: [{ id: 'w', date: today, periods: ['2025-01-17', '2025-07-17', '2026-01-17'] }],
    receipts: [{ id: 'r', date: today, amount: 44, currency: 'CNY', periods: ['2026-07-17'] }],
  };
  const kinds = (r.call('memberSegments', sub, waived, today, '2025-01-01', '2027-06-30') as { kind: string; from: string }[]).map((g) => g.kind);
  assert.deepEqual(kinds.slice(0, 4), ['waived', 'waived', 'waived', 'paid']);
});

test('记收款时点某期右边的应收单独改：勾选不变，金额跟着改，随这笔一起存成单独定价；Esc 放弃，留空恢复', async () => {
  const member = { id: 'm', name: 'Member', share: 7, fee: 44, feeCurrency: 'CNY', billEvery: 6, joined: '2025-01-17' };
  const sub: Subscription = {
    id: 's',
    name: 'Plan',
    category: 'Tools',
    tags: [],
    price: 15,
    currency: 'USD',
    start: '2025-01-17',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, collectFrom: '2025-01-17', members: [member] },
  };
  let saved: Subscription | undefined;
  const make = (m: ShareMember) => {
    const s = { ...sub, share: { ...sub.share!, members: [m] } };
    const r = harness(
      '../app/src/views/Members.tsx',
      'ReceiptForm',
      {},
      {
        ...carpool,
        statusOf: carpool.memberStatus,
        Sheet: 'Sheet',
        DatePicker: 'DatePicker',
        CurrencySelect: 'CurrencySelect',
        NumInput: 'NumInput',
        todayIn: () => today,
        getState: () => ({ ...st, subscriptions: [s] }),
        run: (fn: () => Promise<unknown>) => fn(),
        saveSub: async (next: Subscription) => {
          saved = next;
        },
      },
    );
    return () => r.render('ReceiptForm', { state: st, s, member: m, onDone() {} });
  };
  const rowDue = (nodes: Node[], i: number) => nodes.filter((n) => typeof n.props.className === 'string' && n.props.className.includes('rv-period-r'))[i]!;
  const amount = (nodes: Node[]) => all(nodes.find((n) => n.type === 'Cell' && n.props.label === 'receivable.amount')!).find((n) => n.type === 'NumInput')!;
  const record = (nodes: Node[]) =>
    all(nodes.find((n) => n.type === 'Sheet')!.props.foot)
      .find((n) => n.type === 'button' && n.children.includes('receivable.record'))!
      .props.onClick();

  let render = make(member);
  assert.equal(rowDue(render(), 0).type, 'button');
  assert.equal(amount(render()).props.value, 44);
  // 点金额：不勾选，换成输入框；Esc 放弃
  rowDue(render(), 1).props.onClick({ preventDefault() {} });
  let input = rowDue(render(), 1);
  assert.equal(input.type, 'NumInput');
  input.props.onValue(10);
  input = rowDue(render(), 1);
  input.props.onKeyDown({ key: 'Escape', stopPropagation() {}, currentTarget: { blur: () => input.props.onBlur() } });
  assert.equal(rowDue(render(), 1).type, 'button');
  assert.equal(rowDue(render(), 1).children.join(''), format.money(44, 'CNY'));
  // 改第一期为 30：合计跟着变，保存后成为这一期的单独定价
  rowDue(render(), 0).props.onClick({ preventDefault() {} });
  rowDue(render(), 0).props.onValue(30);
  rowDue(render(), 0).props.onBlur();
  assert.equal(render().filter((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked).length, 1);
  assert.equal(amount(render()).props.value, 30);
  await record(render());
  let m = saved!.share!.members[0];
  assert.deepEqual(m.periodDues, [{ from: '2025-01-17', amount: 30 }]);
  assert.equal(m.receipts![0].amount, 30);

  // 已单独定价的期留空：恢复按收费标准算
  saved = undefined;
  render = make({ ...member, periodDues: [{ from: '2025-01-17', amount: 30 }] });
  assert.equal(amount(render()).props.value, 30);
  rowDue(render(), 0).props.onClick({ preventDefault() {} });
  rowDue(render(), 0).props.onValue(undefined);
  rowDue(render(), 0).props.onBlur();
  assert.equal(amount(render()).props.value, 44);
  await record(render());
  m = saved!.share!.members[0];
  assert.equal(m.periodDues, undefined);
});

test('phase2 rendered ledger sections and assistant summaries retain their frozen normal, zero and missing-FX output', () => {
  const baseSub: Subscription = {
    id: 'frozen',
    name: 'Fictional plan',
    category: 'Tools',
    tags: [],
    price: 20,
    currency: 'USD',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: {
      role: 'owner',
      seats: 4,
      collectFrom: '2026-01-01',
      members: [{ id: 'm', name: 'Fictional member', share: 5, fee: 5, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  };
  const output: Record<string, unknown> = {};
  const extra = {
    ...Object.fromEntries(Object.entries(phase2Icons).filter(([key]) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))),
    ...assistantFields,
    storageKey: (s: string) => s,
    Sheet: 'Sheet',
    DatePicker: 'DatePicker',
    Toggle: 'Toggle',
    CurrencySelect: 'CurrencySelect',
    NumInput: 'NumInput',
    MoneyInput: 'MoneyInput',
    NameLink: 'NameLink',
    PersonNameField: 'PersonNameField',
    PersonProfileSheet: 'PersonProfileSheet',
    ReceiptForm: 'ReceiptForm',
    MemberLeaveFields: 'MemberLeaveFields',
    createPortal: () => null,
    todayIn: () => today,
    detailForecast,
    detailHistoryEnd,
    toBase: (s: AppState, n: number, c: string) => fx.toBaseOrNaN(s, n, c),
    linkPerson: async () => ({}),
    getState: () => st,
  };
  for (const [kind, sub] of [
    ['normal', baseSub],
    ['zero', { ...baseSub, price: 0 }],
    ['missing-fx', { ...baseSub, currency: 'XCD' }],
  ] as const) {
    const state = { ...st, subscriptions: [sub] };
    const props = {
      sub,
      s: sub,
      state,
      today,
      history: billing.chargesBetween(sub, sub.start, today, today),
      book: carpool.carLedger(state, sub, today),
      base: 'USD',
      list: proxy.proxyRows(state, { ...sub, share: undefined, proxy: { forName: 'Fictional recipient' } }, today),
      onClose() {},
      onOpen() {},
      onMember() {},
      onOpenSub() {},
    };
    for (const [file, name] of [
      ['Detail', 'Kpis'],
      ['Carpool', 'CarFacts'],
      ['Members', 'MemberForm'],
      ['Proxy', 'OwedOrNet'],
    ]) {
      const h = harness(`../app/src/views/${file}.tsx`, name, {}, extra);
      output[`${kind}/${name}`] = h.render(name, props);
    }
  }
  const assistant = harness('../app/src/views/Assistant.tsx', 'summaryRows', {}, extra);
  output.proposal = assistant.call(
    'summaryRows',
    'update_subscription',
    { subscription: 'frozen', set: { category: 'Tools', status: 'active', price: 20 } },
    st,
    'USD',
  );
  const normalized = JSON.parse(JSON.stringify(output, (_k, v) => (_k === 'partial' ? undefined : typeof v === 'function' ? '[handler]' : v)));
  const path = new URL('./fixtures/phase2-views.json', import.meta.url);
  if (process.env.CALENDS_UPDATE_FROZEN_VIEWS === '1') writeFileSync(path, JSON.stringify(normalized, null, 2) + '\n');
  assert.deepEqual(normalized, JSON.parse(readFileSync(path, 'utf8')));
});

test('detail leaves the account to the editor; the bottom notes panel can be masked and then leaves the PNG', () => {
  const state = { ...st, subscriptions: [] };
  const sub: Subscription = {
    id: 'private',
    name: 'Fictional account',
    category: 'Tools',
    tags: [],
    account: 'fictional@example.invalid',
    notes: 'Fictional note',
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    status: 'active',
  };
  const h = harness('../app/src/views/Detail.tsx', 'Summary', {}, { detailHistoryEnd });
  const summary = h.render('Summary', { sub, state, today });
  assert.ok(!JSON.stringify(summary.map((n) => n.props.children ?? null)).includes(sub.account!));
  assert.ok(!JSON.stringify(summary.map((n) => n.props.text ?? null)).includes(sub.notes!));
  const nh = harness('../app/src/views/Detail.tsx', 'NoteBlock', {}, { Eye: 'Eye', EyeOff: 'EyeOff' });
  let note = nh.render('NoteBlock', { sub });
  // 默认显示，随图片导出；小眼睛自身不进图片
  assert.equal(note[0].props['data-snapshot-hide'], undefined);
  assert.ok(note.some((n) => n.props.text === sub.notes));
  const eye = () => note.find((n) => n.props.aside)!.props.aside;
  assert.equal(eye().props['data-snapshot-hide'], true);
  assert.equal(eye().props['aria-label'], 'family.sheet.hidePersonal');
  eye().props.onClick();
  note = nh.render('NoteBlock', { sub });
  // 打码后正文不在页面里，整块不进图片
  assert.equal(note[0].props['data-snapshot-hide'], true);
  assert.ok(!note.some((n) => n.props.text === sub.notes));
  assert.ok(!JSON.stringify(note.map((n) => n.props.children ?? null)).includes(sub.notes!));
  assert.equal(eye().props['aria-label'], 'family.sheet.showPersonal');
  assert.deepEqual(harness('../app/src/views/Detail.tsx', 'NoteBlock', {}, {}).render('NoteBlock', { sub: { ...sub, notes: undefined } }), []);
});

test('owner carpool detail shows the subscription and collection periods side by side', () => {
  const sub: Subscription = {
    id: 'car',
    name: 'Fictional family plan',
    category: 'Tools',
    tags: [],
    price: 120,
    currency: 'USD',
    cycle: { unit: 'year', every: 1 },
    start: '2026-03-01',
    status: 'active',
    share: { role: 'owner', seats: 4, collectFrom: '2026-03-01', rule: { billEvery: 1, fee: 10, currency: 'USD' }, members: [] },
  };
  const state = { ...st, subscriptions: [sub] };
  const h = harness('../app/src/views/Detail.tsx', 'Summary', {}, { detailHistoryEnd });
  const nodes = h.render('Summary', { sub, state, today });
  const pair = nodes.find((n) => n.props.className === 'dt-period-pair');
  assert.ok(pair);
  assert.ok(nodes.some((n) => n.props.split === true));
  const collect = nodes.find((n) => n.props.title === 'detail.period.collect')!;
  assert.deepEqual([collect.props.from, collect.props.end], ['2026-10-01', '2026-11-01']);
  assert.ok(!h.render('Summary', { sub: { ...sub, share: undefined }, state, today }).some((n) => n.props.className === 'dt-period-pair'));
});

test('collection period stays when a mid-period joiner shares the end date and hides when member periods differ', () => {
  const member = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    joined: '2026-03-01',
    fee: 10,
    feeCurrency: 'USD',
    billEvery: 1,
    ...extra,
  });
  const sub = (members: unknown[]): Subscription => ({
    id: 'car',
    name: 'Fictional family plan',
    category: 'Tools',
    tags: [],
    price: 120,
    currency: 'USD',
    cycle: { unit: 'year', every: 1 },
    start: '2026-03-01',
    status: 'active',
    share: { role: 'owner', seats: 4, collectFrom: '2026-03-01', rule: { billEvery: 1, fee: 10, currency: 'USD' }, members: members as never },
  });
  const h = harness('../app/src/views/Detail.tsx', 'Summary', {}, { detailHistoryEnd });
  const collectOf = (members: unknown[]) => {
    const s = sub(members);
    const nodes = h.render('Summary', { sub: s, state: { ...st, subscriptions: [s] }, today });
    return nodes.find((n) => n.props.title === 'detail.period.collect');
  };
  // 10 月 15 日上车的人首期折算到 10 月 31 日，与大家同一天到期：仍画收费周期，从本期开始日画起
  const joined = collectOf([member('a'), member('b', { joined: '2026-10-15' })])!;
  assert.deepEqual([joined.props.from, joined.props.end], ['2026-10-01', '2026-11-01']);
  // 有人按季收费，到期日不同：不画收费周期，订阅详情退回单条本期
  assert.equal(collectOf([member('a'), member('b', { billEvery: 3, custom: true })]), undefined);
});

test('detail PNG delegates privacy and cleanup to the shared renderer and excludes only actions', async () => {
  for (const failed of [false, true]) {
    const source = { closest: () => ({}) };
    const image = { fictional: true };
    const h = harness(
      '../app/src/views/Detail.tsx',
      'detailImage',
      {},
      {
        getComputedStyle: () => ({ borderRadius: '16px' }),
        snapshot: async (node: unknown, options: { radius: string; filter: (node: { matches: (selector: string) => boolean }) => boolean }) => {
          assert.equal(node, source);
          assert.equal(options.radius, '16px');
          assert.equal(options.filter({ matches: (selector) => selector.includes('.dt-actions') }), false);
          assert.equal(options.filter({ matches: () => false }), true, 'transfer history explanations stay visible');
          if (failed) throw Error('fictional PNG failure');
          return image;
        },
      },
    );
    if (failed) await assert.rejects(h.call('detailImage', source), /fictional PNG failure/);
    else assert.equal(await h.call('detailImage', source), image);
    assert.deepEqual(Object.keys(source), ['closest'], 'no mutation of the visible source');
  }
});

test('a complete original history with missing FX still uses actual monthly and daily averages', () => {
  const sub: Subscription = {
    id: 'native-average',
    name: 'Fictional native average',
    category: 'Tools',
    tags: [],
    price: 27,
    currency: 'XCD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-11-25',
    status: 'active',
  };
  const date = '2026-10-25';
  const state = { ...st, subscriptions: [sub] };
  const h = harness(
    '../app/src/views/Detail.tsx',
    'Kpis',
    {},
    {
      detailForecast,
      detailHistoryEnd,
      toBase: (s: AppState, v: number, c: string) => fx.toBaseOrNaN(s, v, c),
    },
  );
  const nodes = h.render('Kpis', { sub, state, today: date, history: billing.chargesBetween(sub, sub.start, date, date) });
  const text = JSON.stringify(nodes);
  assert.ok(text.includes('detail.stats.perMonth'));
  assert.ok(!text.includes('detail.kpi.expectedMonthly'));
  assert.ok(text.includes('XCD'));
});

test('incomplete proxy net keeps known receipt and native debit without assigning a profit or loss color', () => {
  const sub: Subscription = {
    id: 'native-proxy-net',
    name: 'Fictional incomplete net',
    category: 'Tools',
    tags: [],
    price: 27,
    currency: 'XCD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-01',
    status: 'active',
    proxy: { forName: 'Fictional', receipts: [{ id: 'r', date: '2026-10-01', amount: 8, currency: 'USD', periods: ['2026-10-01'] }] },
  };
  const state = { ...st, subscriptions: [sub] };
  const list = proxy.proxyRows(state, sub, today);
  const h = harness('../app/src/views/Proxy.tsx', 'OwedOrNet');
  const nodes = h.render('OwedOrNet', { list, base: 'USD' });
  assert.ok(!nodes.some((n) => n.props.className === 'metric-value loss' || n.props.className === 'metric-value done'));
  assert.ok(JSON.stringify(nodes).includes('core.fxUnconverted'));
  assert.equal(proxy.proxyTotals(list).partial.diff.unconverted.XCD, -27);
});

test('全缺汇率的代付待收显示原币且不加约等号，完整折算仍保留估算标记', () => {
  const h = harness('../app/src/views/Proxy.tsx', 'OwedOrNet');
  const sub: Subscription = {
    id: 'fx-owed',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 27,
    currency: 'XCD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-01',
    status: 'active',
    proxy: { forName: 'Fictional' },
  };
  const state = { ...st, settings: { ...st.settings, baseCurrency: 'USD' }, subscriptions: [sub] };
  const missing = JSON.stringify(h.render('OwedOrNet', { list: proxy.proxyRows(state, sub, today), base: 'USD' }).map((n) => n.children));
  assert.match(missing, /XCD/);
  assert.doesNotMatch(missing, /≈/);
  const complete = JSON.stringify(
    h.render('OwedOrNet', { list: proxy.proxyRows(state, { ...sub, currency: 'USD' }, today), base: 'USD' }).map((n) => n.children),
  );
  assert.match(complete, /≈/);
});

test('selection lifecycle renders four metrics without a stop card and retains timeline detail actions and six-event disclosure; copying includes all events', () => {
  const opened: Subscription[] = [];
  const s: Subscription = {
    id: 's',
    name: 'Fictional Selection',
    category: 'Tools',
    tags: [],
    price: 120,
    currency: 'USD',
    cycle: { unit: 'year', every: 1 },
    start: '2026-01-01',
    status: 'terminated',
    end: today,
    stop: { kind: 'terminate', date: today, paidThrough: today },
  };
  const state = { ...st, settings: { ...st.settings, baseCurrency: 'USD' }, subscriptions: [s] };
  const report = reports.scopeReport(state, [s], today);
  report.blocks.push({ type: 'events', rows: Array.from({ length: 9 }, (_, i) => ({ sub: s, date: `2026-10-${10 + i}`, delta: 0, kind: 'start' })) });
  report.blocks = report.blocks.filter((b) => b.type !== 'events').concat(report.blocks.at(-1)!);
  const visible: number[] = [];
  const r = harness('../app/src/components/ScopeLifecycleReport.tsx', 'ScopeLifecycleReport');
  const props = {
    report,
    state,
    today,
    id: 'report',
    onOpen: (s: Subscription) => opened.push(s),
    copying: false,
    actions: null,
    renderBlock: (b: reports.Block) => {
      if (b.type === 'events') visible.push(b.rows.length);
      return null;
    },
  };
  let nodes = r.render('ScopeLifecycleReport', props);
  assert.equal(nodes.find((n) => n.props.className?.startsWith('metric-cards'))!.props['data-count'], 4);
  assert.equal(nodes.filter((n) => n.props.className === 'stop-row').length, 0);
  assert.ok(!nodes.some((n) => n.children.includes('report.stops.title')));
  assert.ok(nodes.some((n) => n.type === 'h3' && String(n.props.hint).includes('scope.totalBasis')));
  assert.ok(!nodes.some((n) => n.props.className === 'metric-note' && n.children.includes('scope.totalBasis')));
  assert.ok(nodes.some((n) => n.props.className === 'card scope-block scope-cash scope-alone'));
  assert.ok(!nodes.some((n) => n.type === 'Composition'));
  assert.equal(visible.at(-1), 6);
  const gantt = nodes.find((n) => n.type === 'Gantt')!;
  assert.equal(gantt.props.compact, true);
  gantt.props.onOpen(s);
  assert.equal(opened[0], s);
  nodes.find((n) => n.props['aria-expanded'] === false)!.props.onClick();
  nodes = r.render('ScopeLifecycleReport', props);
  assert.equal(visible.at(-1), 9);
  nodes.find((n) => n.props['aria-expanded'] === true)!.props.onClick();
  r.render('ScopeLifecycleReport', { ...props, copying: true });
  assert.equal(visible.at(-1), 9);
  r.render('ScopeLifecycleReport', props);
  assert.equal(visible.at(-1), 6);
});

test('full report composition retains MRR dimensions, drill-down, subscription opening and snapshot selection', () => {
  let snapshot: (() => unknown) | undefined;
  const r = harness(
    '../app/src/components/Composition.tsx',
    'Composition',
    {},
    {
      squarify: (values: number[], x = 0, y = 0, w = 100, h = 100) => values.map((_, i) => ({ i, x, y, w: w / values.length, h })),
      useSnapshotRender: (_ref: unknown, render: () => unknown) => {
        snapshot = render;
      },
    },
  );
  const sub: Subscription = {
    id: 'active',
    name: 'Fictional Current',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: today,
    status: 'active',
  };
  const stopped: Subscription = { ...sub, id: 'stopped', name: 'Fictional Stopped', price: 100, start: '2025-01-01', status: 'ended', end: '2026-10-21' };
  const state = { ...st, subscriptions: [sub, stopped], settings: { ...st.settings, baseCurrency: 'USD' } };
  let opened: Subscription | undefined;
  const props = {
    state,
    today,
    onOpen: (s: Subscription) => {
      opened = s;
    },
  };
  let nodes = r.render('Composition', props);
  assert.deepEqual(
    nodes.find((n) => n.type === 'Seg')!.props.options.map((o: string[]) => o[0]),
    ['cat', 'pay', 'ccy', 'cycle'],
  );
  assert.equal(nodes.filter((n) => n.props.className?.startsWith('tm-cell')).length, 1);
  assert.ok(JSON.stringify(nodes).includes('−$10'));
  assert.ok(nodes.some((n) => n.type === 'CopyImageButton'));
  nodes.find((n) => n.props.className === 'tm-head')!.props.onClick();
  nodes = r.render('Composition', props);
  nodes.find((n) => n.props.className?.startsWith('tm-cell'))!.props.onClick();
  assert.equal(opened, sub);
  const copy = snapshot!() as Node;
  assert.deepEqual(copy.props.snapshotSelection, { dim: 'cat', focus: 'Tools' });
  nodes.find((n) => n.props.className === 'btn plain')!.props.onClick();
  nodes = r.render('Composition', props);
  nodes.find((n) => n.type === 'Seg')!.props.onChange('ccy');
  r.render('Composition', props);
  assert.deepEqual((snapshot!() as Node).props.snapshotSelection, { dim: 'ccy', focus: null });
});

test('selection cash keeps its chart without data disclosure; legacy cash retains the data table', () => {
  const r = harness('../app/src/components/ScopeReport.tsx', 'ScopeReport', {}, { useId: () => 'scope', intlLocale: () => 'en-US' });
  const sub: Subscription = {
    id: 'cash',
    name: 'Fictional Cash',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    status: 'active',
  };
  const state = { ...st, subscriptions: [sub] };
  const report = reports.scopeReport(state, [sub], today);
  const props = { report, state, today, onOpen() {}, title: 'Report', animate: false, open: true, onToggle() {} };
  let nodes = r.render('ScopeReport', props);
  assert.ok(nodes.some((n) => n.type === 'BarLine'));
  assert.ok(!nodes.some((n) => n.props.className === 'scope-chart-data'));
  nodes = r.render('ScopeReport', { ...props, report: { blocks: report.blocks } });
  assert.ok(nodes.some((n) => n.props.className === 'scope-chart-data'));
});

test('selection stop metric has no savings and uses a dash when nothing stopped', () => {
  const r = harness('../app/src/components/ScopeLifecycleReport.tsx', 'ScopeLifecycleReport');
  const sub: Subscription = {
    id: 'stop',
    name: 'Fictional Stop',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    status: 'active',
  };
  for (const stopped of [false, true]) {
    const s = stopped ? { ...sub, status: 'cancelled' as const, end: today, stop: { kind: 'cancel' as const, date: today, paidThrough: '2026-10-31' } } : sub;
    const state = { ...st, subscriptions: [s] };
    const nodes = r.render('ScopeLifecycleReport', {
      report: reports.scopeReport(state, [s], today),
      state,
      today,
      id: 'report',
      onOpen() {},
      copying: false,
      actions: null,
      renderBlock() {
        return null;
      },
    });
    const metric = nodes.filter((n) => n.props.className === 'metric')[2];
    const text = JSON.stringify(metric);
    assert.ok(!text.includes('report.stops.saved'));
    assert.ok(!all(metric).some((n) => n.props.className === 'metric-note'));
    assert.ok(text.includes(stopped ? 'scope.lifecycle.times' : '—'));
  }
});

test('stopped subscription cards and list rows keep the existing end-date fallback without estimated savings', () => {
  const sub: Subscription = {
    id: 'stopped',
    name: 'Fictional stopped',
    category: 'Tools',
    tags: [],
    price: 12,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    end: '2026-08-01',
    status: 'ended',
  };
  const state = { ...st, subscriptions: [sub] };
  assert.ok(metrics.cancelSavings(state, today).total > 0, 'fixture must previously display savings');
  for (const view of ['grid', 'list']) {
    let opened: unknown;
    const r = harness(
      '../app/src/views/List.tsx',
      'List',
      { 'list-view': view },
      {
        isMarked: () => false,
        stopLabel: () => '',
        stopDescription: () => '',
        CatChip: 'CatChip',
        CardGlow: 'CardGlow',
        StopBadge: 'StopBadge',
        StopText: 'StopText',
        SubBadges: 'SubBadges',
        useIconTint: () => undefined,
      },
    );
    const nodes = r.render('List', {
      state,
      today,
      onOpen(s: Subscription) {
        opened = s;
      },
      onAdd() {},
    });
    const visible = JSON.stringify(nodes);
    assert.ok(!visible.includes('list.saved'));
    assert.ok(visible.includes(sub.end!));
    nodes.find((n) => n.props.className === (view === 'grid' ? 'scard st-ended' : 'lt-row st-ended'))!.props.onClick();
    assert.equal(opened, sub);
  }
});

test('annual review new/ended metric keeps counts and its existing note without hypothetical savings', () => {
  const sub: Subscription = {
    id: 'stopped',
    name: 'Fictional stopped',
    category: 'Tools',
    tags: [],
    price: 12,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    end: '2026-08-01',
    status: 'ended',
  };
  for (const subscriptions of [[], [sub]]) {
    const r = metrics.yearReview({ ...st, subscriptions }, today, '2026');
    for (const hide of [false, true]) {
      const view = harness('../app/src/views/Review.tsx', 'Card', {}, { location: { host: 'fictional.invalid' } });
      const nodes = view.render('Card', { r, year: '2026', whose: 'Fictional', ongoing: true, m: String, mrr: 0, saved: '$999', hide, pct: () => '0%' });
      assert.ok(!JSON.stringify(nodes).includes('review.card.saved'));
      assert.ok(nodes.some((n) => n.children.includes(subscriptions.length ? 'review.card.ended' : 'review.card.noneEnded')));
      assert.ok(nodes.some((n) => n.children.includes('review.card.newEnded')));
    }
  }
});

test('public stopped card omits the avoided-renewal total while retaining each old monthly price and stop month', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const sub: Subscription = {
    id: 'public-stopped',
    name: 'Fictional stopped',
    category: 'Tools',
    tags: [],
    price: 12,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    end: '2026-08-01',
    status: 'ended',
    account: 'private-fictional-account',
  };
  const state = maskForPublic({ ...st, subscriptions: [sub] });
  const components = Object.fromEntries(
    [
      'Card',
      'CardContent',
      'CardHeader',
      'CardTitle',
      'CardDescription',
      'CardAction',
      'Separator',
      'Tabs',
      'TabsList',
      'TabsTrigger',
      'TabsContent',
      'Num',
      'AppIcon',
      'Badge',
      'IconPile',
    ].map((name) => [name, name]),
  );
  const r = harness(
    '../app/src/public/page.tsx',
    'Ledger, derive',
    {},
    {
      ...components,
      readStored: () => null,
      cn: (...v: string[]) => v.join(' '),
      syncCategories: () => [],
      periodRange: () => ['2026-10-01', '2026-10-31'],
      todayIn: () => today,
      appPath: (s: string) => s,
      PROJECT_NAME: 'Calends',
      PROJECT_URL: 'https://example.invalid',
      __APP_VERSION__: 'test',
    },
  );
  const d = r.call('derive', state, today);
  assert.equal(d.ended.length, 1);
  assert.equal(d.ended[0].monthly, metrics.cancelSavings(state, today).items[0].monthly);
  assert.equal(d.ended[0].since, sub.end);
  const nodes = r.render('Ledger', { state });
  assert.ok(!JSON.stringify(nodes).includes('public.ended.saved'));
  assert.ok(!JSON.stringify(nodes).includes(sub.account!));
  assert.ok(nodes.some((n) => String(n.props.className).includes('line-through') && n.children.includes('public.perMonth')));
  assert.ok(nodes.some((n) => n.children.includes(format.monthLabel(sub.end!.slice(0, 7)))));
  assert.ok(!('endedMonthly' in d));
});

test('点开已收的格子弹出这一笔的明细，可改可删；没收的格子弹出这一期，可改应收或记收款；不再有收款记录列表', () => {
  const member = {
    id: 'm',
    name: 'Fictional',
    share: 10,
    fee: 10,
    feeCurrency: 'USD',
    billEvery: 1,
    joined: '2026-08-01',
    receipts: [{ id: 'r', date: '2026-08-01', amount: 10, currency: 'USD', periods: ['2026-08-01'] }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Test',
    tags: [],
    price: 20,
    currency: 'USD',
    start: '2026-08-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 3, collectFrom: '2026-08-01', members: [member] },
  };
  const r = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
    },
  );
  const render = () => r.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  const cell = (key: string) => render().find((n) => n.type === 'button' && n.props['data-period'] === key)!;
  assert.equal(
    render().some((n) => n.props.className === 'cell member-pay'),
    false,
    'no receipt list rows',
  );
  // 已收：弹出明细，只有一个成员时不出现复制
  cell('2026-08-01').props.onClick({ currentTarget: 'cell' });
  const pop = render().find((n) => n.type === 'Pop')!;
  assert.equal(pop.props.triggerRef.current, 'cell');
  const buttons = all(pop).filter((n) => n.type === 'button' || n.type === 'ConfirmButton');
  assert.deepEqual(
    buttons.map((n) => n.children.join('')),
    ['common.delete', 'detail.action.edit'],
  );
  // 编辑：弹层不关，同一组字段原地变成输入框，按钮换成取消、保存
  buttons[1].props.onClick();
  let nodes = render();
  const editing = nodes.find((n) => n.type === 'Pop')!;
  assert.deepEqual(
    all(editing)
      .find((n) => n.type === 'TipTable')!
      .props.rows.map((row: { value: { type?: string } }) => row.value?.type)
      .filter(Boolean),
    ['DatePicker', 'NumInput', 'input'],
  );
  assert.deepEqual(
    all(editing)
      .filter((n) => n.type === 'button' || n.type === 'ConfirmButton')
      .map((n) => n.children.join('')),
    ['common.delete', 'common.cancel', 'common.save'],
  );
  assert.equal(
    nodes.some((n) => typeof n.type === 'function' && (n.type as Function).name === 'ReceiptForm'),
    false,
  );
  // 没收的一期：不弹明细，直接记这一期
  const r2 = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
    },
  );
  const again = () => r2.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  again()
    .find((n) => n.type === 'button' && n.props['data-period'] === '2026-09-01')!
    .props.onClick({ currentTarget: 'cell' });
  nodes = again();
  const unpaid = nodes.find((n) => n.type === 'Pop')!;
  assert.deepEqual(
    all(unpaid)
      .filter((n) => n.type === 'button' || n.type === 'ConfirmButton')
      .map((n) => n.children.join('')),
    ['family.quick.backCollect'],
  );
  // 点应收金额：这一期的应收原地变成输入框，只改这一期
  const dueRow = () =>
    all(again().find((n) => n.type === 'Pop')!)
      .find((n) => n.type === 'TipTable')!
      .props.rows.find((row: { key: string }) => row.key === 'due');
  dueRow().value.props.onClick();
  assert.equal(dueRow().value.type, 'NumInput');
  assert.deepEqual(
    all(again().find((n) => n.type === 'Pop')!)
      .filter((n) => n.type === 'button' || n.type === 'ConfirmButton')
      .map((n) => n.children.join('')),
    ['common.cancel', 'common.save'],
  );
  // 记收款：直接记这一期
  const r3 = harness(
    '../app/src/views/Members.tsx',
    'MemberForm',
    {},
    {
      Sheet: 'Sheet',
      DatePicker: 'DatePicker',
      Toggle: 'Toggle',
      CurrencySelect: 'CurrencySelect',
      NumInput: 'NumInput',
      Picker: 'Picker',
      todayIn: () => today,
    },
  );
  const third = () => r3.render('MemberForm', { state: st, s: sub, member, onClose() {} });
  third()
    .find((n) => n.type === 'button' && n.props['data-period'] === '2026-09-01')!
    .props.onClick({ currentTarget: 'cell' });
  all(third().find((n) => n.type === 'Pop')!)
    .find((n) => n.type === 'button' && n.children.join('') === 'family.quick.backCollect')!
    .props.onClick();
  nodes = third();
  assert.deepEqual(nodes.find((n) => typeof n.type === 'function' && (n.type as Function).name === 'ReceiptForm')!.props.preset, ['2026-09-01']);
});

test('成员弹窗分三段：人员账号在上、收款格子居中、收费日期，平时只读，底部编辑后可改，取消留在弹窗', () => {
  const months = ['2026-08-01', '2026-09-01', '2026-10-01'];
  const member = {
    id: 'm',
    name: 'Fictional',
    share: 10,
    fee: 10,
    feeCurrency: 'USD',
    billEvery: 1,
    joined: '2026-08-01',
    receipts: [{ id: 'r', date: '2026-08-01', amount: 30, currency: 'USD', periods: months }],
  };
  const sub: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Test',
    tags: [],
    price: 20,
    currency: 'USD',
    start: '2026-08-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 3, collectFrom: '2026-08-01', members: [member] },
  };
  const make = () =>
    harness(
      '../app/src/views/Members.tsx',
      'MemberForm',
      {},
      {
        Sheet: 'Sheet',
        DatePicker: 'DatePicker',
        Toggle: 'Toggle',
        CurrencySelect: 'CurrencySelect',
        NumInput: 'NumInput',
        Picker: 'Picker',
        todayIn: () => today,
      },
    );
  const r = make();
  let closed = 0;
  const render = () => r.render('MemberForm', { state: st, s: sub, member, onClose: () => closed++ });
  const nodes = render();
  const groups = nodes.filter((n) => n.type === 'Group');
  // 三段：人员与账号在最上面，收款格子居中，收费和日期一组只读
  assert.deepEqual(
    groups.map((n) => n.props.title),
    ['family.member.group', undefined, undefined],
  );
  const labels = (g: Node) =>
    all(g)
      .filter((n) => n.type === 'Cell')
      .map((n) => n.props.label);
  const group = (i: number) => render().filter((n) => n.type === 'Group')[i];
  assert.deepEqual(labels(groups[0]), ['family.member.name', 'family.member.accountHere']);
  // 收款格子：已结清，下面直接有「记一笔」，不再重复「下次应收」
  const collect = groups[1];
  const add = all(collect).find((n) => n.type === 'button' && n.children.includes('family.quick.backCollect'))!;
  assert.ok(add, 'settled members can record from the grid section');
  assert.equal(collect.props.foot, undefined);
  assert.deepEqual(labels(group(2)), [
    'family.member.feeGroup',
    'family.member.paidUntil',
    'family.member.joined',
    'family.member.tenure',
    'family.member.left',
  ]);
  const foot = () => all(render().find((n) => n.type === 'Sheet')!.props.foot);
  const texts = () =>
    foot()
      .filter((n) => n.type === 'button' || n.type === 'ConfirmButton')
      .map((n) => n.children.join(''));
  assert.ok(![0, 2].some((i) => all(group(i)).some((n) => n.type === 'input' || n.type === 'DatePicker' || n.type === 'Picker')));
  // 平时底部左边删除（移出这辆车），右边编辑、完成
  assert.deepEqual(texts(), ['family.member.delete', 'detail.action.edit', 'common.done']);
  // 「编辑」后：人员可重选、账号、收费方式、加入和退出日期可改；底部换成删除、取消、保存
  expandMember(nodes);
  assert.ok(all(group(0)).some((n) => typeof n.type === 'function' && (n.type as Function).name === 'PersonNameField'));
  assert.ok(all(group(0)).some((n) => n.type === 'input'));
  assert.ok(all(group(2)).some((n) => n.type === 'Picker' && n.props.value === 'follow'));
  // 跟随车：车的标准不再写在标签下，而是作为现行的一条接在调价记录后面
  const feeCells = all(group(2)).filter((n) => n.type === 'Cell');
  assert.equal(feeCells[0].props.sub, undefined);
  assert.deepEqual(
    feeCells.slice(1, 3).map((n) => n.props.label),
    ['Aug 1, 2026', 'family.member.paidUntil'],
  );
  assert.deepEqual(feeCells[1].children, ['family.pool.perFee.m1']);
  // 调过价：之前的标准灰字在上，现行的一条接在最后
  const r2 = make();
  const withHistory = () =>
    r2.render('MemberForm', {
      state: st,
      s: sub,
      member: {
        ...member,
        feeHistory: [
          { from: '2026-08-01', fee: 5, currency: 'USD', billEvery: 1 },
          { from: '2026-09-01', fee: 10, currency: 'USD', billEvery: 1 },
        ],
      },
      onClose() {},
    });
  expandMember(withHistory());
  const historyCells = all(withHistory().filter((n) => n.type === 'Group')[2]).filter((n) => n.type === 'Cell');
  assert.deepEqual(
    historyCells.slice(0, 3).map((n) => n.props.label),
    ['family.member.feeGroup', 'Aug 1, 2026', 'Sep 1, 2026'],
  );
  assert.equal(historyCells[1].children[0].props.className, 'muted');
  assert.deepEqual(historyCells[2].children, ['family.pool.perFee.m1']);
  assert.ok(all(group(2)).some((n) => n.type === 'DatePicker' && n.props.value === '2026-08-01'));
  assert.ok(all(group(2)).some((n) => typeof n.type === 'function' && (n.type as Function).name === 'MemberLeaveFields'));
  assert.deepEqual(texts(), ['family.member.delete', 'family.member.cancel', 'family.member.save']);
  // 取消：改动丢掉，退出编辑但弹窗不关
  const account = () => all(group(0)).find((n) => n.type === 'input')!;
  account().props.onChange({ target: { value: 'changed@example.com' } });
  assert.equal(account().props.value, 'changed@example.com');
  foot()
    .find((n) => n.type === 'button' && n.children.join('') === 'family.member.cancel')!
    .props.onClick();
  assert.equal(closed, 0);
  assert.deepEqual(texts(), ['family.member.delete', 'detail.action.edit', 'common.done']);
  assert.ok(!all(group(0)).some((n) => n.type === 'input'));
  assert.ok(!all(group(0)).some((n) => n.children.includes('changed@example.com')));
  // 记一笔：叠上收款表单，不预设期，收款表单默认勾最早没结清的一期，也就是下一期（预收）
  add.props.onClick();
  const receipt = render().find((n) => typeof n.type === 'function' && (n.type as Function).name === 'ReceiptForm')!;
  assert.ok(receipt);
  assert.equal(receipt.props.preset, undefined);
  // 不分摊的成员没有收款格子，只有资料
  const exempt = make()
    .render('MemberForm', { state: st, s: sub, member: { ...member, exempt: true }, onClose() {} })
    .filter((n) => n.type === 'Group');
  assert.deepEqual(
    exempt.map((n) => n.props.title),
    ['family.member.group', undefined],
  );
});

test('跨年各段悬停一起高亮，点击仍返回同一期；触屏按下和键盘聚焦能预览', () => {
  const p = { key: '2024-10-17', from: '2024-10-17', until: '2026-10-16', due: 120, currency: 'USD', status: 'paid' as const };
  const picked: unknown[] = [];
  const r = harness('../app/src/views/Receivable.tsx', 'PeriodStrip');
  const render = () =>
    r.render('PeriodStrip', { periods: [p], today: '2026-01-01', mode: 'months', onPick: (period: unknown, el: unknown) => picked.push(period, el) });
  let buttons = render().filter((n) => n.type === 'button');
  assert.equal(buttons.length, 3);
  buttons[0].props.onMouseEnter({});
  assert.equal(render().filter((n) => n.type === 'button' && n.props.className.endsWith(' active')).length, 3);
  buttons[1].props.onClick({ currentTarget: 'cell' });
  assert.deepEqual(picked, [p, 'cell']);
  buttons[0].props.onMouseLeave();
  assert.equal(render().filter((n) => n.type === 'button' && n.props.className.endsWith(' active')).length, 0);
  buttons[2].props.onPointerDown({ pointerType: 'touch' });
  assert.equal(render().filter((n) => n.type === 'button' && n.props.className.endsWith(' active')).length, 3);
  buttons[2].props.onBlur();
  buttons[1].props.onFocus({});
  assert.equal(render().filter((n) => n.type === 'button' && n.props.className.endsWith(' active')).length, 3);
});

test('report bars open the calendar: buttons only when pickable, URL params parsed strictly', () => {
  const r = harness('../app/src/components/charts.tsx', 'BarLine');
  const bars = [100, 200];
  const base = { bars, line: [], labels: ['1月', '2月'], tip: () => '', future: bars.map(() => false) };
  const cols = (nodes: Node[]) => nodes.filter((n) => String(n.props.className ?? '').startsWith('bl-col'));
  // 订阅页迷你报告没给 onPick：仍是普通 div，不可点
  assert.ok(cols(r.render('BarLine', base)).every((n) => n.type === 'div' && !n.props.onClick));
  const picked: number[] = [];
  const btns = cols(r.render('BarLine', { ...base, onPick: (i: number) => picked.push(i) }));
  assert.deepEqual(
    btns.map((n) => [n.type, n.props.type, n.props['aria-label']]),
    [
      ['button', 'button', '1月'],
      ['button', 'button', '2月'],
    ],
  );
  // 鼠标点一下就跳；键盘（click 的 detail 为 0）也直接跳
  btns[1].props.onPointerDown({ pointerType: 'mouse' });
  btns[1].props.onClick({ detail: 1 });
  btns[0].props.onClick({ detail: 0 });
  assert.deepEqual(picked, [1, 0]);
  // 触屏第一下只弹浮窗，同一根再按才跳；iOS 第一下不派发 click 时，按下记账照样成立
  btns[0].props.onPointerDown({ pointerType: 'touch' });
  btns[0].props.onClick({ detail: 1 });
  assert.deepEqual(picked, [1, 0]);
  btns[0].props.onPointerDown({ pointerType: 'touch' });
  btns[0].props.onClick({ detail: 1 });
  assert.deepEqual(picked, [1, 0, 0]);
  btns[1].props.onPointerDown({ pointerType: 'touch' });
  btns[1].props.onPointerDown({ pointerType: 'touch' });
  btns[1].props.onClick({ detail: 1 });
  assert.deepEqual(picked, [1, 0, 0, 1]);
  // 日历只认合法的 ?month / ?year；今年停在本月，别的年停在 1 月
  assert.deepEqual(calendarJump('?month=2025-03', '2026-10-30'), { month: '2025-03', mode: 'month' });
  assert.deepEqual(calendarJump('?year=2026', '2026-10-30'), { month: '2026-10', mode: 'year' });
  assert.deepEqual(calendarJump('?year=2024', '2026-10-30'), { month: '2024-01', mode: 'year' });
  for (const bad of ['', '?month=2025-13', '?month=2025-3', '?year=24', '?year=abcd']) assert.equal(calendarJump(bad, '2026-10-30'), null, bad);
});

test('report charts: bar tops carry amounts, money gridlines never repeat', () => {
  const r = harness('../app/src/components/charts.tsx', 'BarLine, AreaChart');
  const base = { line: [], labels: [], tip: () => '' };
  const vals = (nodes: Node[]) => nodes.filter((n) => n.props.className === 'bl-val').map((n) => n.children.join(''));
  // 缺汇率（fmt 返回空串）与取整后为 0 的柱子不标；没给 fmt 的图（订阅页迷你报告）不变
  const fmt = (v: number, i: number) => (i === 2 ? '' : format.moneyTick(v, 'USD'));
  const bars = [100, 600, 50, 0.2];
  assert.deepEqual(vals(r.render('BarLine', { ...base, bars, future: bars.map(() => false), fmt })), ['$100', '$600']);
  assert.deepEqual(vals(r.render('BarLine', { ...base, bars, future: bars.map(() => false) })), []);
  // 每格放不下时只标最高的一根
  const many = Array.from({ length: 30 }, (_, i) => (i === 7 ? 9000 : 6000));
  assert.deepEqual(vals(r.render('BarLine', { ...base, bars: many, future: many.map(() => false), fmt })), ['$9.0k']);
  // 走势图的金额刻度：全为 0、小额时也不出现重复标签
  const ticks = (values: number[]) =>
    r
      .render('AreaChart', { values, labels: values.map(String), tip: () => '', fmt: (v: number) => format.moneyTick(v, 'USD') })
      .filter((n) => n.props.className === 'area-y')
      .map((n) => n.children.join(''));
  for (const values of [
    [0, 0, 0],
    [1, 4, 7],
    [100, 2400, 51062],
  ]) {
    const xs = ticks(values);
    assert.ok(xs.length >= 2 && new Set(xs).size === xs.length, `${values}: ${xs}`);
  }
});

test('calendar day icons keep unique keys when one subscription charges and rebates on the same day', () => {
  const sub = {
    id: 'dup',
    name: 'Dup',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month' as const, every: 1 },
    start: '2026-01-22',
    status: 'active' as const,
    payments: [],
  };
  const charges = [
    { sub, date: today, amount: 10, currency: 'USD', projected: false },
    { sub, date: today, amount: -2, currency: 'USD', projected: false, kind: 'refund' },
  ];
  const r = harness('../app/src/views/Calendar.tsx', 'Calendar', {}, { allCharges: () => charges, stopLabel: () => '' });
  const nodes = r.render('Calendar', { state: st, today, onOpen() {}, onIcs() {} });
  const keys = nodes.filter((n) => n.children.some((c: { type?: string }) => c?.type === 'SubIcon') && 'key' in n.props).map((n) => n.props.key);
  assert.equal(new Set(keys).size, 2);
});

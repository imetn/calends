import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveStatus, FALLBACK_FX } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { contributionOn } from './metrics.ts';
import {
  type PublicGridItem,
  collapseEmpty,
  compactGrid,
  placeSnapped,
  restorablePublicPage,
  fillRows,
  fitHeights,
  flowSpans,
  gridConfig,
  gridSections,
  hideItem,
  isCustomLayout,
  isFlowGrid,
  metricsFor,
  metricWithTemplate,
  newMetricItem,
  placeItem,
  samePlacement,
  PUBLIC_GRID_SECTIONS,
  publicConfigForVisitors,
  publicGrid,
  publicParts,
  setMetric,
  showItem,
  tabletSpan,
  validPublicPage,
} from './public-layout.ts';
import { checkSettings } from './ledger-edit.ts';
import { metricValues, type MetricInputs } from './public-metrics.ts';
import { byAmountDesc } from './treemap.ts';
import { DEFAULT_SETTINGS, type AppState, type PublicPageConfig, type Subscription } from './types.ts';

const TODAY = new Date().toISOString().slice(0, 10);
const sub = (over: Partial<Subscription>): Subscription =>
  ({
    id: 'a',
    name: 'Fiction Music',
    category: '影音',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', n: 1 },
    start: '2023-01-15',
    status: 'active',
    ...over,
  }) as Subscription;
const ledger = (publicPage?: PublicPageConfig, more: Partial<AppState['settings']> = {}): AppState =>
  ({
    fx: FALLBACK_FX,
    fxHistory: {},
    methods: [],
    settings: { ...DEFAULT_SETTINGS, displayName: 'Fiction Owner', timezone: 'UTC', publicPage, ...more },
    subscriptions: [
      sub({
        priceHistory: [
          { from: '2023-01-15', amount: 6 },
          { from: '2024-06-01', amount: 12 },
        ],
        payments: [{ date: '2023-02-15', amount: 6 }],
      } as Partial<Subscription>),
      sub({ id: 'b', name: 'Fiction Ended', start: '2022-01-01', end: '2023-05-01', status: 'cancelled', price: 20 } as Partial<Subscription>),
      sub({ id: 'c', name: 'Fiction Forever', cycle: { unit: 'lifetime', n: 1 }, price: 99 } as Partial<Subscription>),
    ],
  }) as unknown as AppState;
const hide = (...ids: string[]) => ids.map((id) => ({ id, hidden: true }));

test('缺省配置：位置等于现有公开页，全部可见，不算摆放过', () => {
  assert.deepEqual(
    publicGrid().map((s) => [s.id, s.x, s.y, s.w, s.hidden]),
    PUBLIC_GRID_SECTIONS.map((s) => [s.id, s.x, s.y, s.w, !!s.off]),
  );
  assert.equal(publicParts().size, 8 + 2, '可选组件默认不放，也不下发它们要的数据');
  assert.equal(publicConfigForVisitors(undefined), undefined);
  assert.equal(
    isCustomLayout({
      sections: [
        { id: 'fx', hidden: true },
        { id: 'footer', hidden: true },
      ],
    }),
    false,
  );
});

test('存下的布局：不认识和重复的 id 忽略，新组件放到最下面，越界夹回范围，压住的往下推', () => {
  const rect = { x: 0, y: 0, w: 12, h: 4 };
  const grid = publicGrid({
    sections: [
      { id: 'list', ...rect, w: 99 },
      { id: 'nope', ...rect },
      { id: 'list', ...rect, w: 6 },
      { id: 'stats', ...rect, w: 1, x: 11 },
    ],
  });
  assert.equal(new Set(grid.map((s) => s.id)).size, PUBLIC_GRID_SECTIONS.length);
  const at = (id: string) => grid.find((s) => s.id === id)!;
  assert.deepEqual([at('list').x, at('list').y, at('list').w], [0, 0, 12], '第一条为准，宽度夹到 12');
  assert.deepEqual([at('stats').w, at('stats').x, at('stats').y], [5, 7, 4], '宽度夹到最小值并留在栏内，压住 list 就推到下面');
  assert.ok(at('composition').y >= at('stats').y + at('stats').h, '没存的组件排在已摆放的下面');
});

test('摆放：放到别的卡片上把它往下推，没压到的不动，拖到别处后恢复从原状算', () => {
  const base = publicGrid({ sections: gridSections(publicGrid()) });
  const moved = placeItem(base, 'fx', { x: 0, y: 0, w: 6, h: 6 });
  const at = (id: string) => moved.find((s) => s.id === id)!;
  assert.deepEqual([at('fx').x, at('fx').y], [0, 0]);
  assert.equal(at('stats').y, 6);
  assert.equal(at('composition').y, 22);
  assert.equal(at('ended').y, 34);
  assert.equal(base.find((s) => s.id === 'fx')!.y, 16, '原数组不变');
  const blank = placeItem(base, 'stats', { x: 0, y: 40, w: 12, h: 6 });
  assert.equal(blank.find((s) => s.id === 'timeline')!.y, 4, '上面腾出的空位不自动补，保留主人摆的位置');
  assert.equal(placeItem(base, 'fx', { x: 11, y: -3, w: 1, h: 0 }).find((s) => s.id === 'fx')!.x, 7, '越界夹回');
});

test('补高度：并排同高的卡片一起变，下面的卡片让开', () => {
  const grid = fitHeights(publicGrid(), { stats: 20, composition: 9, fx: 7 });
  const at = (id: string) => grid.find((s) => s.id === id)!;
  assert.equal(at('stats').h, 20);
  assert.deepEqual([at('composition').h, at('fx').h, at('composition').y, at('fx').y], [9, 9, 32, 32]);
  assert.equal(at('list').y, 41);
});

test('添加和隐藏：重新添加放到最下面，隐藏的卡片不占位', () => {
  const hidden = publicGrid({ sections: gridSections(publicGrid()).map((s) => (s.id === 'fx' ? { ...s, hidden: true } : s)) });
  assert.equal(hidden.find((s) => s.id === 'fx')!.hidden, true);
  const shown = showItem(hidden, 'fx');
  assert.deepEqual([shown.find((s) => s.id === 'fx')!.hidden, shown.find((s) => s.id === 'fx')!.x, shown.find((s) => s.id === 'fx')!.y], [false, 0, 34]);
});

test('没有内容的卡片：整行都空才收起，旁边还有卡片时那一行留着', () => {
  const grid = publicGrid();
  const noEnded = collapseEmpty(grid, (id) => id === 'ended');
  assert.deepEqual(noEnded.find((s) => s.id === 'lifetime')!.y, 28, '买断在同一排，位置不变');
  const noList = collapseEmpty(grid, (id) => id === 'list');
  assert.equal(noList.find((s) => s.id === 'ended')!.y, 22, '整排空了，下面的卡片上移');
  assert.ok(!noList.some((s) => s.id === 'list'));
});

test('写入校验：只放行白名单 id、字段和最小宽度以上的栏数', () => {
  assert.ok(
    validPublicPage({
      browserTitle: 't',
      bio: 'b',
      sections: [
        { id: 'fx', x: 7, y: 3, w: 5, h: 2 },
        { id: 'stats', hidden: true },
        { id: 'footer', hidden: true },
      ],
    }),
  );
  for (const bad of [
    null,
    [],
    { other: 1 },
    { bio: 'x'.repeat(201) },
    { browserTitle: 'x'.repeat(101) },
    { avatar: 'javascript:alert(1)' },
    { avatar: 'data:image/svg+xml;base64,AAAA' },
    { heroParts: { chart: false } },
    { sections: [{ id: 'hero' }] },
    { sections: [{ id: 'metric-1', x: 0, y: 0, w: 3, h: 3 }] },
    { sections: [{ id: 'metric-1', x: 0, y: 0, w: 3, h: 3, metric: { template: 'nope', items: ['active'] } }] },
    { sections: [{ id: 'metric-1', x: 0, y: 0, w: 3, h: 3, metric: { template: 'number', items: ['nope'] } }] },
    { sections: [{ id: 'metric-1', x: 0, y: 0, w: 3, h: 3, metric: { template: 'number', items: ['active', 'monthly'] } }] },
    { sections: [{ id: 'metric-1', x: 0, y: 0, w: 3, h: 3, hidden: true, metric: { template: 'number', items: ['active'] } }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6, h: 6, metric: { template: 'number', items: ['active'] } }] },
    { sections: [{ id: 'nope' }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 4, h: 2 }] },
    { sections: [{ id: 'fx', x: 7, y: 0, w: 6, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 5.5, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6 }] },
    { sections: [{ id: 'fx', x: -1, y: 0, w: 6, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6, h: 0 }] },
    { sections: [{ id: 'fx', x: 0, y: 100000, w: 6, h: 1 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6, h: 201 }] },
    { sections: [{ id: 'footer', x: 0, y: 0, w: 6, h: 2 }] },
    { sections: [{ id: 'fx', span: 6 }] },
    { sections: [{ id: 'fx' }, { id: 'fx' }] },
    { sections: [{ id: 'fx', extra: 1 }] },
  ])
    assert.equal(validPublicPage(bad), false, JSON.stringify(bad));
});

test('每行最后一张卡补满，放不下就换行', () => {
  assert.deepEqual(fillRows([12, 6, 6, 12, 6, 6]), [12, 6, 6, 12, 6, 6]);
  assert.deepEqual(fillRows([4, 4, 6]), [4, 8, 12]);
  assert.deepEqual(fillRows([6]), [12]);
  assert.deepEqual(fillRows([5, 5, 5, 8]), [5, 7, 12, 12]);
  assert.deepEqual([4, 6, 7, 12].map(tabletSpan), [6, 6, 12, 12]);
});

test('公开页页脚：不要分隔线和两个图标，只留一行文字', () => {
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  const footer = page.slice(page.indexOf('<footer'), page.indexOf('</footer>'));
  assert.ok(footer.includes('PROJECT_NAME'));
  for (const gone of ['border-t', '<img', 'GitHub']) assert.ok(!footer.includes(gone), gone);
});

test('缺省配置：脱敏结果不缺数据', () => {
  const m = maskForPublic(ledger());
  assert.equal(m.subscriptions.length, 3);
  assert.equal(m.subscriptions[0].name, 'Fiction Music');
  assert.ok(m.subscriptions[0].payments?.length);
  assert.ok(m.subscriptions[0].priceHistory?.length);
  assert.equal(m.settings.publicPage, undefined);
});

test('隐藏全部用到名字的部分：响应里没有订阅名、ID、已退订订阅', () => {
  const m = maskForPublic(ledger({ sections: hide('stats', 'timeline', 'chart', 'list', 'ended', 'lifetime', 'pile') }));
  const raw = JSON.stringify(m.subscriptions);
  assert.ok(!raw.includes('Fiction'), raw);
  assert.equal(m.subscriptions.length, 2, '已退订不下发；在用的买断计入构成，但匿名');
  assert.equal(m.subscriptions[0].payments, undefined);
  assert.equal(m.subscriptions[0].priceHistory, undefined);
  assert.equal(m.subscriptions[0].id, 's0');
});

test('只隐藏一张卡：别的部分还要用的数据继续下发', () => {
  const m = maskForPublic(ledger({ sections: hide('list') }));
  assert.equal(m.subscriptions[0].name, 'Fiction Music');
  assert.ok(m.subscriptions[0].payments?.length, '概览和时间线要用扣款');
  // 只隐藏概览：订阅列表的下次扣款仍要用历史
  assert.ok(maskForPublic(ledger(undefined)).subscriptions[0].payments?.length);
  assert.ok(maskForPublic(ledger({ sections: hide('stats', 'timeline', 'chart') })).subscriptions[0].payments?.length);
});

test('裁掉历史后，留下的组件算出的数字不变', () => {
  const full = maskForPublic(ledger());
  const cut = maskForPublic(ledger({ sections: hide('stats', 'timeline', 'chart', 'list') }));
  assert.equal(cut.subscriptions[0].priceHistory, undefined);
  assert.equal(full.subscriptions.length, cut.subscriptions.length);
  full.subscriptions.forEach((s, i) => {
    const c = cut.subscriptions[i];
    assert.equal(effectiveStatus(c, TODAY), effectiveStatus(s, TODAY), s.name);
    assert.equal(contributionOn(cut, c, TODAY), contributionOn(full, s, TODAY), s.name);
  });
  assert.equal(cut.subscriptions[0].price, 12, '按当天价格摊平，而不是最初的价格');
});

test('裁掉历史：买断卡价格不变，已退订按结束日取价', () => {
  const life = sub({
    id: 'l',
    cycle: { unit: 'lifetime', n: 1 },
    price: 99,
    priceHistory: [
      { from: '2023-01-15', amount: 50 },
      { from: '2999-01-01', amount: 99 },
    ],
  } as Partial<Subscription>);
  const stopped = sub({
    id: 's',
    price: 40,
    end: '2999-01-01',
    stop: { kind: 'terminate', date: '2023-02-01', paidThrough: '2999-01-01' },
    priceHistory: [
      { from: '2023-01-15', amount: 10 },
      { from: '2998-01-01', amount: 40 },
    ],
  } as unknown as Partial<Subscription>);
  const out = maskForPublic({ ...ledger({ sections: hide('stats', 'timeline', 'chart', 'list') }), subscriptions: [life, stopped] });
  assert.equal(out.subscriptions.find((x) => x.id === 'l')?.price, 99);
  assert.equal(out.subscriptions.find((x) => x.id === 's')?.price, 40);
});

test('所有用到金额的部分都隐藏：不下发订阅和付款来源', () => {
  const st = {
    ...ledger({ sections: hide('stats', 'timeline', 'chart', 'composition', 'fx', 'list', 'ended', 'lifetime', 'pile') }),
    methods: [{ id: 'm', name: 'Fiction Card', kind: 'card', currency: 'USD', region: 'TR' }],
  } as unknown as AppState;
  const out = maskForPublic(st);
  assert.deepEqual(out.subscriptions, []);
  assert.deepEqual(out.methods, []);
});

test('不展示名字时，付款来源不带地区和名称', () => {
  const st = {
    ...ledger({ sections: hide('stats', 'timeline', 'chart', 'list', 'ended', 'lifetime', 'pile') }),
    methods: [{ id: 'm', name: 'Fiction Card', kind: 'card', currency: 'USD', region: 'TR' }],
  } as unknown as AppState;
  const [m] = maskForPublic(st).methods;
  assert.equal(m.region, undefined);
  assert.equal(m.name, '');
  assert.equal(m.currency, 'USD');
});

test('设置校验：标题类型和长度、头像错误单独报', () => {
  const st = { fx: FALLBACK_FX, methods: [], subscriptions: [] };
  const check = (next: object) => () => checkSettings(st as never, DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, ...next });
  assert.throws(check({ publicTitle: 1 }), /invalidInput/);
  assert.throws(check({ publicTitle: 'x'.repeat(101) }), /invalidInput/);
  assert.doesNotThrow(check({ publicTitle: 'Fiction' }));
  assert.doesNotThrow(check({ publicTitle: null }));
  assert.throws(check({ publicPage: { avatar: 'abc' } }), /invalidAvatar/);
});

test('预览用 untrimmed：配置怎么隐藏都拿到全部组件的数据', () => {
  const m = maskForPublic(ledger({ sections: hide('stats', 'timeline', 'chart', 'list', 'ended', 'lifetime', 'pile') }), { untrimmed: true });
  assert.equal(m.subscriptions.length, 3);
  assert.equal(m.subscriptions[0].name, 'Fiction Music');
});

test('页头：设了标题不下发真实名字，公开页头像合并后不重复下发', () => {
  const m = maskForPublic(
    ledger({ avatar: 'https://example.test/a.png', bio: 'hello' }, { publicTitle: 'My stack', avatar: 'https://example.test/global.png' }),
  );
  assert.equal(m.settings.displayName, '');
  assert.equal(m.settings.avatar, 'https://example.test/a.png');
  assert.equal(m.settings.publicPage?.avatar, undefined);
  assert.equal(m.settings.publicPage?.bio, 'hello');
  assert.equal(maskForPublic(ledger(undefined, { avatar: 'https://example.test/global.png' })).settings.avatar, 'https://example.test/global.png');
});

test('页头：主题按钮只能存为隐藏，访客配置和恢复备份都带上，缺省不下发', () => {
  assert.equal(validPublicPage({ themeButton: false }), true);
  assert.equal(validPublicPage({ themeButton: true }), false);
  assert.equal(validPublicPage({ themeButton: 'no' }), false);
  assert.equal(maskForPublic(ledger({ themeButton: false })).settings.publicPage?.themeButton, false);
  assert.equal('themeButton' in maskForPublic(ledger({ bio: 'hello' })).settings.publicPage!, false);
  assert.equal(restorablePublicPage({ themeButton: false, bio: 'hello' })?.themeButton, false);
  assert.equal(restorablePublicPage({ themeButton: true, bio: 'hello' })?.themeButton, undefined);
});

test('页头：画布上直接改，只有没画布时才留在侧栏；隐藏后访客页不渲染主题按钮', () => {
  const editor = readFileSync(new URL('../app/src/views/PublicPageEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /\{!canvasOn && \(\s*<>\s*<Cell label=\{t\('settings\.open\.publicTitle'\)\}>/);
  assert.match(editor, /\{!canvasOn && \(\s*<Group title=\{t\('settings\.publicPage\.bio'\)\}>/);
  // 画布发回来的值也限长，存之前不靠 iframe 自觉
  assert.match(editor, /head\.publicTitle\.slice\(0, PUBLIC_TITLE_MAX\)/);
  assert.match(editor, /head\.bio\.slice\(0, PUBLIC_BIO_MAX\)/);
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /config\?\.themeButton !== false && <ThemeButton \/>/);
  // 编辑态的标题不能裁切，否则输入框外框看不到
  assert.match(page, /\$\{edit \? '' : 'truncate'\}/);
  assert.doesNotMatch(page, /aria-pressed=\{shown\}/);
});

test('自动吸附：区块向上靠拢不留空行，只在编辑时生效，不下发给访客', () => {
  const item = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h, min: 1, hidden: false }) as PublicGridItem;
  const yOf = (items: PublicGridItem[]) => Object.fromEntries(items.map((s) => [s.id, s.y]));
  // 两个全宽区块中间隔着空行：贴上去；半宽的靠到自己那一列，横向不变
  const gaps = [item('stats', 0, 2, 12, 4), item('chart', 0, 10, 12, 6), item('fx', 6, 30, 6, 4), { ...item('list', 0, 0, 12, 6), hidden: true }];
  const packed = compactGrid(gaps);
  assert.deepEqual(yOf(packed), { stats: 0, chart: 4, fx: 10, list: 0 });
  assert.equal(packed.find((s) => s.id === 'fx')!.x, 6);
  assert.equal(packed.find((s) => s.id === 'list')!.hidden, true, '隐藏的不参与');
  assert.deepEqual(compactGrid(packed), packed, '再吸附一次不变');
  // 左高右矮：全宽的排在高的下面，半宽的补到矮的下面
  const uneven = compactGrid([item('stats', 0, 0, 6, 6), item('fx', 6, 0, 6, 2), item('chart', 0, 9, 12, 4), item('years', 6, 3, 6, 2)]);
  assert.deepEqual(yOf(uneven), { stats: 0, fx: 0, years: 2, chart: 6 });
  // 拖动：领先的边越过中线才换位，松手的位置就是预览的位置
  const two = [item('stats', 0, 0, 12, 12), item('chart', 0, 12, 12, 2)];
  assert.deepEqual(yOf(placeSnapped(two, 'stats', { x: 0, y: 1, w: 12, h: 12 })), { stats: 0, chart: 12 }, '没过中线，弹回原位');
  assert.deepEqual(yOf(placeSnapped(two, 'stats', { x: 0, y: 2, w: 12, h: 12 })), { chart: 0, stats: 2 }, '下边过了中线');
  assert.deepEqual(yOf(placeSnapped(two, 'chart', { x: 0, y: 0, w: 12, h: 2 })), { chart: 0, stats: 2 }, '拖到最上面，高卡片也能越过');
  assert.deepEqual(yOf(placeSnapped(two, 'chart', { x: 0, y: 6, w: 12, h: 2 })), { chart: 0, stats: 2 }, '上边刚到中线');
  assert.deepEqual(yOf(placeSnapped(two, 'chart', { x: 0, y: 7, w: 12, h: 2 })), { stats: 0, chart: 12 }, '上边没到中线');
  assert.deepEqual(yOf(placeSnapped(two, 'stats', { x: 0, y: 0, w: 12, h: 6 })), { stats: 0, chart: 6 }, '改矮后下面跟上');
  // 同一行横着拖到别的卡片上：两个方向都占到这一行，对方往下让
  const row = [item('stats', 0, 0, 6, 4), item('fx', 6, 0, 6, 4)];
  assert.deepEqual(yOf(placeSnapped(row, 'fx', { x: 0, y: 0, w: 6, h: 4 })), { fx: 0, stats: 4 });
  assert.deepEqual(yOf(placeSnapped(row, 'stats', { x: 6, y: 0, w: 6, h: 4 })), { stats: 0, fx: 4 });
  // 只动了一下没换位：从吸附好的状态开始拖，位置不变（画布据此判断没有改动）
  const held = compactGrid([item('stats', 0, 0, 12, 4), item('chart', 0, 10, 12, 6)]);
  assert.equal(samePlacement(placeSnapped(held, 'chart', { x: 0.1, y: 4.1, w: 12, h: 6 }), held), true);
  // 没摆放过的页面不存几何，吸附不能把它变成摆放过
  const flow = publicGrid(undefined);
  assert.equal(compactGrid(flow), flow);
  // 配置：只存 false，访客拿不到，备份保留
  assert.equal(validPublicPage({ autoSnap: false }), true);
  assert.equal(validPublicPage({ autoSnap: true }), false);
  assert.equal('autoSnap' in publicConfigForVisitors({ autoSnap: false })!, false);
  assert.equal(restorablePublicPage({ autoSnap: false, bio: 'hello' })?.autoSnap, false);
  assert.equal(restorablePublicPage({ autoSnap: true, bio: 'hello' })?.autoSnap, undefined);
});

test('自动吸附：画布按开关选摆放方式，编辑页改区块都经过吸附', () => {
  const canvas = readFileSync(new URL('../app/src/public/canvas.tsx', import.meta.url), 'utf8');
  assert.match(canvas, /const place = text\.snap \? placeSnapped : placeItem;/);
  assert.doesNotMatch(canvas, /= placeItem\(d\.base/);
  // 只点一下不算改动；拖入的组件不受隐藏前旧位置影响
  assert.match(canvas, /text\.snap \? compactGrid\(fitHeights\(items, need\)\)/);
  assert.match(canvas, /hidden: false, y: publicGridBottom\(current\)/);
  const editor = readFileSync(new URL('../app/src/views/PublicPageEditor.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /setDraft\(\(d\) => (hideSection|addWidget)/);
  assert.match(editor, /editGrid\(\(d\) => \{\s*\/\/ 刚拖进来/);
  assert.match(editor, /\{canvasOn && \(\s*<span className="ppe-snap"/);
});

test('预览消息：只接受同源父窗口，发消息限定本站', () => {
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /e\.origin !== location\.origin \|\| e\.source !== window\.parent/);
  assert.match(page, /has\('preview'\) \|\| window\.parent === window\) return false/);
  const editor = readFileSync(new URL('../app/src/views/PublicPageEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /e\.origin !== location\.origin \|\| e\.source !== frame\.current\?\.contentWindow/);
  assert.match(editor, /postMessage\(message, location\.origin\)/);
  assert.match(editor, /maskForPublic\(state, \{ untrimmed: true \}\)/);
});

test('公开页柱状图：底边贴横轴的直角，顶部大圆角', () => {
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /<Bar dataKey="v" radius=\{\[radius, radius, 0, 0\]\} maxBarSize=\{24\}>/);
  assert.match(page, /barCategoryGap="25%"/);
});

test('移除和添加：没摆放过的页面继续流式、补满，不写入几何', () => {
  const flow = hideItem(publicGrid(undefined), 'fx');
  assert.equal(isFlowGrid(flow), true);
  assert.deepEqual(gridConfig(flow), [{ id: 'fx', hidden: true }]);
  assert.equal(flow.find((s) => s.id === 'composition')!.w, 12);
  assert.equal(isCustomLayout({ sections: gridConfig(flow) }), false);
  let noTop = publicGrid(undefined);
  for (const id of ['stats', 'timeline', 'chart']) noTop = hideItem(noTop, id);
  assert.equal(noTop.find((s) => s.id === 'composition')!.y, 0);
  assert.deepEqual(showItem(flow, 'fx'), publicGrid(undefined));
});

test('移除：摆放过的页面只收起独占的行，保存再读回和草稿一致', () => {
  const moved = placeItem(publicGrid(undefined), 'list', { x: 0, y: 12, w: 8, h: 6 });
  const noStats = hideItem(moved, 'stats');
  assert.equal(noStats.find((s) => s.id === 'timeline')!.y, 0);
  assert.deepEqual(publicGrid({ sections: gridConfig(noStats) }), noStats);
  const fx = hideItem(moved, 'fx');
  assert.equal(fx.find((s) => s.id === 'composition')!.w, 6);
  assert.deepEqual(publicGrid({ sections: gridConfig(fx) }), fx);
});

test('内容再高也不超过上限，被推到最下面的结果仍能通过校验', () => {
  const tall = fitHeights(publicGrid(undefined), { list: 5000 });
  assert.equal(tall.find((s) => s.id === 'list')!.h, 200);
  assert.equal(validPublicPage({ sections: gridSections(tall) }), true);
  let items = publicGrid(undefined);
  for (const s of items) items = placeItem(items, s.id, { x: 0, y: 1000, w: 12, h: 200 });
  assert.equal(validPublicPage({ sections: gridSections(items) }), true);
});

test('摆放过的页面在桌面以下是单列，不会挤成一栏宽', () => {
  const css = readFileSync(new URL('../app/src/public/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.public-grid\[data-free\] > \.public-cell \{\n  grid-column: 1 \/ -1;/);
});

test('流式页面：卡片没数据时，其余卡片按默认宽度重新排，能并排的仍并排', () => {
  const grid = publicGrid({
    sections: [
      { id: 'fx', hidden: true },
      { id: 'list', hidden: true },
    ],
  });
  assert.equal(grid.find((s) => s.id === 'lifetime')!.w, 12);
  assert.deepEqual(flowSpans(['stats', 'composition', 'lifetime']), [12, 6, 6]);
});

test('摆放结果恰好等于默认排列时，仍算摆放过，不丢几何', () => {
  const placed = publicGrid({ sections: gridSections(publicGrid(undefined)) });
  assert.equal(isCustomLayout({ sections: gridConfig(placed) }), true);
});

test('主卡拆成三张：可以只留其中一张，不再有 hero', () => {
  const ids = publicGrid().map((s) => s.id);
  assert.ok(!ids.includes('hero'));
  for (const id of ['stats', 'timeline', 'chart']) assert.ok(ids.includes(id), id);
  const parts = publicParts({ sections: hide('timeline', 'chart') });
  assert.ok(parts.has('stats') && !parts.has('timeline') && !parts.has('chart'));
});

test('可选组件默认不放：放上去才算摆放过，才下发它要的数据', () => {
  for (const id of ['calendar', 'years', 'tenure', 'treemap', 'changes', 'waterfall']) {
    assert.equal(publicGrid().find((s) => s.id === id)!.hidden, true, id);
    assert.ok(!publicParts().has(id as never), id);
    const shown = showItem(publicGrid(), id);
    assert.equal(shown.find((s) => s.id === id)!.hidden, false, id);
    assert.equal(isFlowGrid(shown), false, `${id} 没有默认位置，放上去就是自由摆放`);
    assert.ok(publicParts({ sections: gridConfig(shown) }).has(id as never), id);
  }
});

test('指标卡：可放多张，保存再读回一致，移除后不留痕迹', () => {
  const one = newMetricItem(publicGrid(), 'trend');
  const two = newMetricItem([...publicGrid(), one], 'rows');
  assert.notEqual(one.id, two.id);
  const items = publicGrid({ sections: gridSections([...publicGrid(), one, two]) });
  assert.equal(validPublicPage({ sections: gridSections(items) }), true);
  assert.deepEqual(items.find((s) => s.id === two.id)!.metric, two.metric);
  const gone = hideItem(items, one.id);
  assert.ok(!gone.some((s) => s.id === one.id));
  assert.ok(!JSON.stringify(gridConfig(gone)).includes(one.id));
});

test('指标卡：改模板只留下新模板能显示的数据，没有就用默认', () => {
  const rows = { template: 'rows' as const, items: ['monthly', 'active', 'next30'] };
  assert.deepEqual(metricWithTemplate(rows, 'number').items, ['monthly']);
  assert.deepEqual(metricWithTemplate(rows, 'trend').items, ['monthly']);
  const noSeries = metricWithTemplate({ template: 'number', items: ['active'] }, 'trend');
  assert.ok(metricsFor('trend').some((m) => m.id === noSeries.items[0]));
  assert.ok(metricsFor('share').every((m) => 'share' in m && m.share));
  const item = newMetricItem(publicGrid(), 'number');
  const grid = [...publicGrid(), item];
  assert.deepEqual(setMetric(grid, item.id, { template: 'number', items: ['active'] }).find((s) => s.id === item.id)!.metric, {
    template: 'number',
    items: ['active'],
  });
});

test('指标卡只下发选中的数据要用的部分', () => {
  const metric = newMetricItem(publicGrid(), 'number');
  const only = [...hide('stats', 'timeline', 'chart', 'composition', 'fx', 'list', 'ended', 'lifetime', 'pile', 'footer')];
  const cfg = { sections: [...only, ...gridSections([{ ...metric, metric: { template: 'share', items: ['topCategory'] } }])] } as PublicPageConfig;
  const parts = publicParts(cfg);
  assert.ok(parts.has('composition') && !parts.has('list'));
});

test('新指标卡默认选页面上没有的数据：同一个数不放两遍', () => {
  let items = publicGrid();
  const first = newMetricItem(items, 'number');
  assert.ok(!['monthly', 'yearly', 'active', 'paidTotal'].includes(first.metric!.items[0]), '概览已经显示的不选');
  items = [...items, first];
  const second = newMetricItem(items, 'number');
  assert.notEqual(second.metric!.items[0], first.metric!.items[0]);
  const trend = newMetricItem(items, 'trend');
  assert.equal(trend.metric!.items[0], 'paidMonth', '概览有每月支出，趋势换成本月已付');
  const rows = newMetricItem(items, 'rows');
  assert.equal(new Set(rows.metric!.items).size, 3);
});

test('日历和订阅年表：默认不上页面；放上去时下发名称、扣款历史和已退订，备注仍不下发', () => {
  for (const [id, min, h] of [
    ['calendar', 5, 12],
    ['years', 6, 10],
  ] as const) {
    const def = PUBLIC_GRID_SECTIONS.find((s) => s.id === id)!;
    assert.deepEqual([def.min, def.h, def.off], [min, h, true]);
    assert.ok(!publicParts().has(id));
    const state = ledger({
      sections: [...PUBLIC_GRID_SECTIONS.map((s) => ({ id: s.id, hidden: s.id !== id })), { id: 'footer', hidden: true }, { id: 'pile', hidden: true }],
    });
    state.subscriptions[0].notes = 'Fiction note';
    const masked = maskForPublic(state);
    assert.deepEqual(
      masked.subscriptions.map((s) => s.name),
      ['Fiction Music', 'Fiction Ended', 'Fiction Forever'],
    );
    assert.equal(masked.subscriptions[0].payments?.length, 1);
    assert.equal(masked.subscriptions[0].priceHistory?.length, 2);
    assert.ok(!JSON.stringify(masked).includes('Fiction note'));
  }
});

test('默认高度放得下内容：订阅时长和变动记录同排时一样高，缺省位置互不重叠', () => {
  const by = (id: string) => PUBLIC_GRID_SECTIONS.find((d) => d.id === id)!;
  assert.equal(by('tenure').h, by('changes').h);
  const off = PUBLIC_GRID_SECTIONS.filter((d) => d.off).sort((a, b) => a.y - b.y);
  for (let i = 1; i < off.length; i++) assert.ok(off[i - 1].y + off[i - 1].h <= off[i].y, `${off[i - 1].id} 压住 ${off[i].id}`);
});

test('空账本的指标卡：没有在用订阅时平均写占位，最贵的订阅没有名字', () => {
  const zero: MetricInputs = {
    mrr: 0,
    yearAgoMrr: 0,
    mrrSeries: [],
    active: 0,
    paidTotal: 0,
    paidYear: 0,
    paidYearPrev: 0,
    paidMonth: 0,
    paidMonthPrev: 0,
    paidSeries: [],
    next30: 0,
    ended: 0,
    lifetime: 0,
    fxEffect: 0,
  };
  const v = metricValues(zero);
  assert.ok(Number.isNaN(v.avgPerSub.value));
  assert.equal(v.topSub.name, undefined);
});

test('手机和平板上窄指标卡一排两张，日历星期和日期同一列对齐，变动日期不折行', () => {
  const css = readFileSync(new URL('../app/src/public/index.css', import.meta.url), 'utf8');
  assert.match(css, /max-width: 63\.99rem[^}]*data-half[^}]*span 6/s);
  assert.match(
    readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8'),
    /data-half=\{s\.metric && s\.metric\.template !== 'rows' && s\.w <= 4/,
  );
  assert.match(readFileSync(new URL('../app/src/public/widgets/calendar.tsx', import.meta.url), 'utf8'), /ml-1 w-\[18px\] pb-1/);
  assert.match(readFileSync(new URL('../app/src/public/widgets/changes.tsx', import.meta.url), 'utf8'), /whitespace-nowrap/);
});

test('排序：缺汇率的 NaN 排最后，不打乱其他项', () => {
  const sorted = [{ v: 2 }, { v: NaN }, { v: 9 }, { v: 5 }].sort(byAmountDesc).map((x) => x.v);
  assert.deepEqual(sorted, [9, 5, 2, NaN]);
});

test('排序：方块图的分类名次与构成卡同规则，含缺汇率的分类排最后', () => {
  const src = readFileSync(new URL('./treemap.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /b(\[1\])?\.v - a(\[1\])?\.v/);
});

test('恢复备份：旧字段和不认识的组件被去掉，简介与摆放保留', () => {
  const page = restorablePublicPage({
    hero: { title: 'x' },
    bio: 'hi',
    sections: [
      { id: 'gone', x: 0, y: 0, w: 1, h: 1 },
      { id: 'chart', x: 0, y: 0, w: 6, h: 8 },
    ],
  });
  assert.deepEqual(page, { bio: 'hi', sections: [{ id: 'chart', x: 0, y: 0, w: 6, h: 8 }] });
  assert.equal(restorablePublicPage('nope'), undefined);
  // 重复的 id 和超量的指标卡只丢多余的，简介不受牵连；隐藏的组件摆放非法也保持隐藏，不被默认值翻成公开
  const metric = (i: number) => ({ id: `metric-${i}`, x: 0, y: i * 4, w: 3, h: 4, metric: { template: 'number', items: ['monthly'] } });
  const many = restorablePublicPage({
    bio: 'hi',
    sections: [
      { id: 'chart', hidden: true, x: 0, y: 0, w: 1, h: 1 },
      { id: 'list', hidden: true },
      { id: 'list' },
      ...Array.from({ length: 30 }, (_, i) => metric(i)),
    ],
  });
  assert.equal(many?.bio, 'hi');
  assert.deepEqual(many?.sections?.slice(0, 2), [
    { id: 'chart', hidden: true },
    { id: 'list', hidden: true },
  ]);
  assert.equal(many?.sections?.filter((s) => s.id.startsWith('metric-')).length, 24);
  assert.equal(restorablePublicPage([]), undefined);
});

test('汇率影响的指标带正负号，其余不带', () => {
  const v = metricValues({
    mrr: 1,
    yearAgoMrr: 1,
    mrrSeries: [],
    active: 1,
    paidTotal: 1,
    paidYear: 1,
    paidYearPrev: 1,
    paidMonth: 1,
    paidMonthPrev: 1,
    paidSeries: [],
    next30: 1,
    ended: 0,
    lifetime: 0,
    fxEffect: -3,
  });
  assert.equal(v.fxEffect.signed, true);
  assert.equal(v.monthly.signed, undefined);
});

test('只放订阅时长：扣款历史照常下发，时长不按被裁掉的数据算', () => {
  const sub = {
    id: 'a',
    name: 'A',
    category: 'x',
    price: 10,
    currency: 'USD',
    cycle: { n: 1, unit: 'month' },
    start: '2024-01-01',
    status: 'cancelled',
    tags: [],
    payments: [{ date: '2024-01-01', amount: 10 }],
  } as unknown as Subscription;
  const state = {
    subscriptions: [sub],
    methods: [],
    fx: FALLBACK_FX,
    settings: {
      ...DEFAULT_SETTINGS,
      publicPage: {
        sections: [
          { id: 'tenure', x: 0, y: 0, w: 6, h: 8 },
          { id: 'stats', hidden: true },
          { id: 'timeline', hidden: true },
          { id: 'chart', hidden: true },
          { id: 'composition', hidden: true },
          { id: 'fx', hidden: true },
          { id: 'list', hidden: true },
          { id: 'ended', hidden: true },
          { id: 'lifetime', hidden: true },
          { id: 'footer', hidden: true },
          { id: 'pile', hidden: true },
        ],
      },
    },
  } as unknown as AppState;
  assert.ok(maskForPublic(state).subscriptions[0]?.payments?.length);
});

test('公开页金额：缺汇率显示占位；预览只认同源父窗口；重置清掉选中', () => {
  const num = readFileSync(new URL('../app/src/public/components/number.tsx', import.meta.url), 'utf8');
  assert.match(num, /!Number\.isFinite\(value\)\) return <span/);
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /window\.parent\.location\.origin === location\.origin/);
  assert.match(page, /paidBase: sumBaseOrNaN/);
  assert.match(page, /const rate = k > 0 \? k : Number\.NaN/);
  assert.match(page, /const fmt = \(v: number\) => \(Number\.isFinite\(v\)/);
  assert.doesNotMatch(page, /<Num value=\{d\.mrr[^}]* k\}/);
  const editor = readFileSync(new URL('../app/src/views/PublicPageEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /setDraft\(draftOf\(undefined, undefined\)\);\s*setSelected\(null\)/);
});

// 单列也写 grid-cols-1：不写时隐式 auto 列会被 truncate 的长名字撑破卡片
test('宽卡片的列表自动分两列，字段多的卡片晚一点分', () => {
  const read = (f: string) => readFileSync(new URL(`../app/src/public/${f}`, import.meta.url), 'utf8');
  const page = read('page.tsx');
  assert.match(page, /grid grid-cols-1 gap-x-10 gap-y-2\.5 @\[720px\]:grid-cols-2">\n\s*\{top\.map/);
  assert.match(page, /grid grid-cols-1 gap-x-10 gap-y-2\.5 @\[880px\]:grid-cols-2">\n\s*\{rows\.map/);
  assert.match(page, /grid grid-cols-1 gap-x-10 @\[720px\]:grid-cols-2">\n\s*\{d\.ended\.map/);
  assert.match(page, /grid grid-cols-1 gap-x-10 @\[720px\]:grid-cols-2">\n\s*\{d\.lifetime\.map/);
  assert.match(read('widgets/changes.tsx'), /grid-cols-1 gap-x-10 @\[880px\]:grid-cols-2/);
  assert.match(read('widgets/tenure.tsx'), /grid-cols-1 gap-x-10 gap-y-2\.5 @\[720px\]:grid-cols-2/);
});

test('订阅堆落地后页面高度变化，图标层跟着落地区移动，不压住内容', () => {
  const pile = readFileSync(new URL('../app/src/public/components/icon-pile.tsx', import.meta.url), 'utf8');
  assert.match(pile, /new ResizeObserver\(follow\)/);
  assert.match(pile, /now\.bottom \+ scrollY - floor/);
  assert.match(pile, /page\.disconnect\(\)/);
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /canvas \? <div style=\{\{ height: PILE_HEIGHT \}\} \/> : <IconPile/);
});

test('画布拖动：格子变量不继承，同一格不重画，宽度没变不重测高度', () => {
  const css = readFileSync(new URL('../app/src/public/index.css', import.meta.url), 'utf8');
  for (const name of ['x', 'y', 'w', 'h']) assert.match(css, new RegExp(`@property --${name} \\{\\s*syntax: '\\*';\\s*inherits: false;`));
  const canvas = readFileSync(new URL('../app/src/public/canvas.tsx', import.meta.url), 'utf8');
  assert.match(canvas, /if \(samePlacement\(next, d\.latest\)\) return;/);
  assert.match(canvas, /if \(d\.fit\?\.w !== item\.w\) d\.fit = /);
  assert.match(canvas, /if \(d\.fit\?\.w === Math\.max\(d\.from\.min, Math\.round\(rect\.w\)\)\) rect\.h = /);

  const items = publicGrid({
    sections: [
      { id: 'chart', x: 0, y: 0, w: 12, h: 6 },
      { id: 'list', x: 0, y: 6, w: 12, h: 6 },
    ],
  });
  assert.equal(
    samePlacement(
      items,
      items.map((s) => ({ ...s })),
    ),
    true,
  );
  // 指针在格内移动不到半格：摆放不变
  assert.equal(samePlacement(placeItem(items, 'chart', { x: 0.2, y: 0.3, w: 12, h: 6 }), items), true);
  assert.equal(samePlacement(placeItem(items, 'chart', { x: 0, y: 3, w: 12, h: 6 }), items), false);
  assert.equal(
    samePlacement(
      items,
      items.map((s) => (s.id === 'list' ? { ...s, hidden: true } : s)),
    ),
    false,
  );
});

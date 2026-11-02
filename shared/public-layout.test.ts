import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveStatus, FALLBACK_FX } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { contributionOn } from './metrics.ts';
import { collapseEmpty, fillRows, fitHeights, flowSpans, gridConfig, gridSections, hideItem, isCustomLayout, isFlowGrid, placeItem, PUBLIC_GRID_SECTIONS, publicConfigForVisitors, publicGrid, publicParts, showItem, tabletSpan, validPublicPage } from './public-layout.ts';
import { checkSettings } from './ledger-edit.ts';
import { DEFAULT_SETTINGS, type AppState, type PublicPageConfig, type Subscription } from './types.ts';

const TODAY = new Date().toISOString().slice(0, 10);
const sub = (over: Partial<Subscription>): Subscription =>
  ({ id: 'a', name: 'Fiction Music', category: '影音', tags: [], price: 10, currency: 'USD', cycle: { unit: 'month', n: 1 }, start: '2023-01-15', status: 'active', ...over }) as Subscription;
const ledger = (publicPage?: PublicPageConfig, more: Partial<AppState['settings']> = {}): AppState =>
  ({
    fx: FALLBACK_FX,
    fxHistory: {},
    methods: [],
    settings: { ...DEFAULT_SETTINGS, displayName: 'Fiction Owner', timezone: 'UTC', publicPage, ...more },
    subscriptions: [
      sub({ priceHistory: [{ from: '2023-01-15', amount: 6 }, { from: '2024-06-01', amount: 12 }], payments: [{ date: '2023-02-15', amount: 6 }] } as Partial<Subscription>),
      sub({ id: 'b', name: 'Fiction Ended', start: '2022-01-01', end: '2023-05-01', status: 'cancelled', price: 20 } as Partial<Subscription>),
      sub({ id: 'c', name: 'Fiction Forever', cycle: { unit: 'lifetime', n: 1 }, price: 99 } as Partial<Subscription>),
    ],
  }) as unknown as AppState;
const hide = (...ids: string[]) => ids.map((id) => ({ id, hidden: true }));

test('缺省配置：位置等于现有公开页，全部可见，不算摆放过', () => {
  assert.deepEqual(
    publicGrid().map((s) => [s.id, s.x, s.y, s.w, s.hidden]),
    PUBLIC_GRID_SECTIONS.map((s) => [s.id, s.x, s.y, s.w, false]),
  );
  assert.equal(publicParts().size, 3 + 5 + 2);
  assert.equal(publicConfigForVisitors(undefined), undefined);
  assert.equal(isCustomLayout({ sections: [{ id: 'fx', hidden: true }, { id: 'footer', hidden: true }] }), false);
});

test('存下的布局：不认识和重复的 id 忽略，新组件放到最下面，越界夹回范围，压住的往下推', () => {
  const rect = { x: 0, y: 0, w: 12, h: 4 };
  const grid = publicGrid({ sections: [{ id: 'list', ...rect, w: 99 }, { id: 'nope', ...rect }, { id: 'list', ...rect, w: 6 }, { id: 'hero', ...rect, w: 1, x: 11 }] });
  assert.equal(new Set(grid.map((s) => s.id)).size, PUBLIC_GRID_SECTIONS.length);
  const at = (id: string) => grid.find((s) => s.id === id)!;
  assert.deepEqual([at('list').x, at('list').y, at('list').w], [0, 0, 12], '第一条为准，宽度夹到 12');
  assert.deepEqual([at('hero').w, at('hero').x, at('hero').y], [8, 4, 4], '宽度夹到最小值并留在栏内，压住 list 就推到下面');
  assert.ok(at('composition').y >= at('hero').y + at('hero').h, '没存的组件排在已摆放的下面');
});

test('摆放：放到别的卡片上把它往下推，没压到的不动，拖到别处后恢复从原状算', () => {
  const base = publicGrid({ sections: gridSections(publicGrid()) });
  const moved = placeItem(base, 'fx', { x: 0, y: 0, w: 6, h: 6 });
  const at = (id: string) => moved.find((s) => s.id === id)!;
  assert.deepEqual([at('fx').x, at('fx').y], [0, 0]);
  assert.equal(at('hero').y, 6);
  assert.equal(at('composition').y, 12);
  assert.equal(at('ended').y, 24);
  assert.equal(new Set(base.map((s) => s.y)).size, 4, '原数组不变');
  const blank = placeItem(base, 'hero', { x: 0, y: 40, w: 12, h: 6 });
  assert.equal(blank.find((s) => s.id === 'composition')!.y, 6, '上面腾出的空位不自动补，保留主人摆的位置');
  assert.equal(placeItem(base, 'fx', { x: 11, y: -3, w: 1, h: 0 }).find((s) => s.id === 'fx')!.x, 7, '越界夹回');
});

test('补高度：并排同高的卡片一起变，下面的卡片让开', () => {
  const grid = fitHeights(publicGrid(), { hero: 20, composition: 9, fx: 7 });
  const at = (id: string) => grid.find((s) => s.id === id)!;
  assert.equal(at('hero').h, 20);
  assert.deepEqual([at('composition').h, at('fx').h, at('composition').y, at('fx').y], [9, 9, 20, 20]);
  assert.equal(at('list').y, 29);
});

test('添加和隐藏：重新添加放到最下面，隐藏的卡片不占位', () => {
  const hidden = publicGrid({ sections: gridSections(publicGrid()).map((s) => (s.id === 'fx' ? { ...s, hidden: true } : s)) });
  assert.equal(hidden.find((s) => s.id === 'fx')!.hidden, true);
  const shown = showItem(hidden, 'fx');
  assert.deepEqual([shown.find((s) => s.id === 'fx')!.hidden, shown.find((s) => s.id === 'fx')!.x, shown.find((s) => s.id === 'fx')!.y], [false, 0, 24]);
});

test('没有内容的卡片：整行都空才收起，旁边还有卡片时那一行留着', () => {
  const grid = publicGrid();
  const noEnded = collapseEmpty(grid, (id) => id === 'ended');
  assert.deepEqual(noEnded.find((s) => s.id === 'lifetime')!.y, 18, '买断在同一排，位置不变');
  const noList = collapseEmpty(grid, (id) => id === 'list');
  assert.equal(noList.find((s) => s.id === 'ended')!.y, 12, '整排空了，下面的卡片上移');
  assert.ok(!noList.some((s) => s.id === 'list'));
});

test('写入校验：只放行白名单 id、字段和最小宽度以上的栏数', () => {
  assert.ok(validPublicPage({ browserTitle: 't', bio: 'b', sections: [{ id: 'fx', x: 7, y: 3, w: 5, h: 2 }, { id: 'hero', hidden: true }, { id: 'footer', hidden: true }], heroParts: { chart: false } }));
  for (const bad of [
    null,
    [],
    { other: 1 },
    { bio: 'x'.repeat(201) },
    { browserTitle: 'x'.repeat(101) },
    { avatar: 'javascript:alert(1)' },
    { avatar: 'data:image/svg+xml;base64,AAAA' },
    { heroParts: { nope: true } },
    { heroParts: { chart: 'no' } },
    { sections: [{ id: 'nope' }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 4, h: 2 }] },
    { sections: [{ id: 'fx', x: 7, y: 0, w: 6, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 5.5, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6 }] },
    { sections: [{ id: 'fx', x: -1, y: 0, w: 6, h: 2 }] },
    { sections: [{ id: 'fx', x: 0, y: 0, w: 6, h: 0 }] },
    { sections: [{ id: 'fx', x: 0, y: 2201, w: 6, h: 1 }] },
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
  const m = maskForPublic(ledger({ sections: hide('hero', 'list', 'ended', 'lifetime', 'pile') }));
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
  assert.ok(maskForPublic(ledger({ heroParts: { stats: false, timeline: false, chart: false } })).subscriptions[0].payments?.length);
});

test('裁掉历史后，留下的组件算出的数字不变', () => {
  const full = maskForPublic(ledger());
  const cut = maskForPublic(ledger({ sections: hide('hero', 'list') }));
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
  const life = sub({ id: 'l', cycle: { unit: 'lifetime', n: 1 }, price: 99, priceHistory: [{ from: '2023-01-15', amount: 50 }, { from: '2999-01-01', amount: 99 }] } as Partial<Subscription>);
  const stopped = sub({ id: 's', price: 40, end: '2999-01-01', stop: { kind: 'terminate', date: '2023-02-01', paidThrough: '2999-01-01' }, priceHistory: [{ from: '2023-01-15', amount: 10 }, { from: '2998-01-01', amount: 40 }] } as unknown as Partial<Subscription>);
  const out = maskForPublic({ ...ledger({ sections: hide('hero', 'list') }), subscriptions: [life, stopped] });
  assert.equal(out.subscriptions.find((x) => x.id === 'l')?.price, 99);
  assert.equal(out.subscriptions.find((x) => x.id === 's')?.price, 40);
});

test('所有用到金额的部分都隐藏：不下发订阅和付款来源', () => {
  const st = { ...ledger({ sections: hide('hero', 'composition', 'fx', 'list', 'ended', 'lifetime', 'pile') }), methods: [{ id: 'm', name: 'Fiction Card', kind: 'card', currency: 'USD', region: 'TR' }] } as unknown as AppState;
  const out = maskForPublic(st);
  assert.deepEqual(out.subscriptions, []);
  assert.deepEqual(out.methods, []);
});

test('不展示名字时，付款来源不带地区和名称', () => {
  const st = { ...ledger({ sections: hide('hero', 'list', 'ended', 'lifetime', 'pile') }), methods: [{ id: 'm', name: 'Fiction Card', kind: 'card', currency: 'USD', region: 'TR' }] } as unknown as AppState;
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
  const m = maskForPublic(ledger({ sections: hide('hero', 'list', 'ended', 'lifetime', 'pile') }), { untrimmed: true });
  assert.equal(m.subscriptions.length, 3);
  assert.equal(m.subscriptions[0].name, 'Fiction Music');
});

test('页头：设了标题不下发真实名字，公开页头像合并后不重复下发', () => {
  const m = maskForPublic(ledger({ avatar: 'https://example.test/a.png', bio: 'hello' }, { publicTitle: 'My stack', avatar: 'https://example.test/global.png' }));
  assert.equal(m.settings.displayName, '');
  assert.equal(m.settings.avatar, 'https://example.test/a.png');
  assert.equal(m.settings.publicPage?.avatar, undefined);
  assert.equal(m.settings.publicPage?.bio, 'hello');
  assert.equal(maskForPublic(ledger(undefined, { avatar: 'https://example.test/global.png' })).settings.avatar, 'https://example.test/global.png');
});

test('预览消息：只接受同源父窗口，发消息限定本站', () => {
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /e\.origin !== location\.origin \|\| e\.source !== window\.parent/);
  assert.match(page, /new URLSearchParams\(location\.search\)\.has\('preview'\) && window\.parent !== window/);
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
  const noHero = hideItem(publicGrid(undefined), 'hero');
  assert.equal(noHero.find((s) => s.id === 'composition')!.y, 0);
  assert.deepEqual(showItem(flow, 'fx'), publicGrid(undefined));
});

test('移除：摆放过的页面只收起独占的行，保存再读回和草稿一致', () => {
  const moved = placeItem(publicGrid(undefined), 'list', { x: 0, y: 12, w: 8, h: 6 });
  const hero = hideItem(moved, 'hero');
  assert.equal(hero.find((s) => s.id === 'composition')!.y, 0);
  assert.deepEqual(publicGrid({ sections: gridConfig(hero) }), hero);
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
  const grid = publicGrid({ sections: [{ id: 'fx', hidden: true }, { id: 'list', hidden: true }] });
  assert.equal(grid.find((s) => s.id === 'lifetime')!.w, 12);
  assert.deepEqual(flowSpans(['hero', 'composition', 'lifetime']), [12, 6, 6]);
});

test('摆放结果恰好等于默认排列时，仍算摆放过，不丢几何', () => {
  const placed = publicGrid({ sections: gridSections(publicGrid(undefined)) });
  assert.equal(isCustomLayout({ sections: gridConfig(placed) }), true);
});

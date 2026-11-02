import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveStatus, FALLBACK_FX } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { contributionOn } from './metrics.ts';
import { fillRows, PUBLIC_GRID_SECTIONS, publicConfigForVisitors, publicGrid, publicParts, tabletSpan, validPublicPage } from './public-layout.ts';
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

test('缺省配置：顺序和宽度等于现有公开页，全部可见', () => {
  assert.deepEqual(
    publicGrid().map((s) => [s.id, s.span, s.hidden]),
    PUBLIC_GRID_SECTIONS.map((s) => [s.id, s.span, false]),
  );
  assert.equal(publicParts().size, 3 + 5 + 2);
  assert.equal(publicConfigForVisitors(undefined), undefined);
});

test('存下的布局：不认识和重复的 id 忽略，新组件回到默认位置，栏数夹到允许范围', () => {
  const grid = publicGrid({ sections: [{ id: 'list', span: 99 }, { id: 'nope' }, { id: 'list', span: 6 }, { id: 'hero', span: 1 }] });
  assert.equal(new Set(grid.map((s) => s.id)).size, PUBLIC_GRID_SECTIONS.length);
  assert.equal(grid.find((s) => s.id === 'hero')!.span, 8);
  assert.ok(grid.findIndex((s) => s.id === 'composition') === grid.findIndex((s) => s.id === 'hero') + 1, '新组件跟在默认顺序的前一个后面');
});

test('写入校验：只放行白名单 id、字段和最小宽度以上的栏数', () => {
  assert.ok(validPublicPage({ browserTitle: 't', bio: 'b', sections: [{ id: 'fx', span: 5 }, { id: 'footer', hidden: true }], heroParts: { chart: false } }));
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
    { sections: [{ id: 'fx', span: 4 }] },
    { sections: [{ id: 'fx', span: 13 }] },
    { sections: [{ id: 'fx', span: 5.5 }] },
    { sections: [{ id: 'footer', span: 6 }] },
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

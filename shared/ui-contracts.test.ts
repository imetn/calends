import * as fxTotals from './fx-total.ts';
import { metricComponents, fxAmountComponent } from '../scripts/ui-test-components.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import { DEFAULT_SETTINGS } from './types.ts';
import { FALLBACK_FX, todayIn, addDays } from './billing.ts';
import { LOCALES } from './i18n.ts';
import { buildIcs } from '../worker/ics.ts';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const copySource = read('../app/src/components/copy.tsx')
  .replace(/^import.*;\n/gm, '')
  .replace(/export function /g, 'function ');
const locale = (loc: string, ns: string) => JSON.parse(read(`./locales/${loc}/${ns}.json`));

type AiElement = { type: string | { name: string }; props: Record<string, any>; children: AiElement[] };
const aiNodes = (node: unknown): AiElement[] => {
  if (Array.isArray(node)) return node.flatMap(aiNodes);
  if (!node || typeof node !== 'object' || !('type' in node)) return [];
  const e = node as AiElement;
  return [e, ...aiNodes(e.children)];
};
const aiNamed = (e: AiElement, name: string) => (typeof e.type === 'object' || typeof e.type === 'function' ? e.type.name === name : e.type === name);
function aiHarness() {
  // 执行真实组件及事件，仅替换 React 宿主与外部 API；不访问本地账本。
  const source = read('../app/src/views/Ai.tsx').replace(/^import .*;\n/gm, '');
  const result = transformSync('Ai.tsx', source + '\n' + copySource, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const states = new Map<unknown, unknown[]>();
  let values: unknown[] = [];
  let cursor = 0;
  const useState = (initial: unknown) => {
    const i = cursor++;
    if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
    const owner = values;
    return [
      values[i],
      (next: any) => {
        owner[i] = typeof next === 'function' ? next(owner[i]) : next;
      },
    ];
  };
  const React = {
    Fragment: 'Fragment',
    createElement(type: AiElement['type'], props: AiElement['props'], ...children: AiElement[]) {
      return { type, props: props ?? {}, children };
    },
  };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const fresh = { token: 'fictional-once-only-token', item: { id: 'new', name: 'Claude Code', scope: 'write' } };
  const messages = locale('en', 'ai');
  const deps = {
    React,
    useState,
    useEffect() {},
    base: (s: string) => s,
    t: (key: string, args: Record<string, unknown> = {}) => {
      const value = key.startsWith('ai.')
        ? key
            .slice(3)
            .split('.')
            .reduce((o, k) => o?.[k], messages)
        : key;
      const template = typeof value === 'object' ? value.other : (value ?? key);
      return template.replace(/\{(\w+)\}/g, (_: string, k: string) => String(args[k] ?? `{${k}}`));
    },
    Icon: 'Icon',
    IconButton: 'IconButton',
    ChartPie: 'ChartPie',
    Eye: 'Eye',
    KeyRound: 'KeyRound',
    Layers: 'Layers',
    PencilLine: 'PencilLine',
    ReceiptText: 'ReceiptText',
    Settings2: 'Settings2',
    Shapes: 'Shapes',
    Tags: 'Tags',
    Trash2: 'Trash2',
    Users: 'Users',
    Wallet: 'Wallet',
    CardTitle: 'h3',
    CopyImageButton: 'CopyImageButton',
    Sheet: 'Sheet',
    Toggle: 'Toggle',
    Toolbar: 'Toolbar',
    api: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return init?.method === 'POST' ? fresh : [];
    },
    run: (fn: () => unknown) => fn(),
    saveSettings() {},
    toast() {},
    localTime() {},
    location: { origin: 'https://example.test' },
  };
  const components = new Function(...Object.keys(deps), `${result.code.replace('export function Ai', 'function Ai')}; return { Ai, Connect, NewToken };`)(
    ...Object.values(deps),
  );
  const render = (component = components.Ai, props = { state: { subscriptions: [], methods: [], fx: FALLBACK_FX, settings: DEFAULT_SETTINGS } }): AiElement => {
    if (!states.has(component)) states.set(component, []);
    values = states.get(component)!;
    cursor = 0;
    return component(props);
  };
  const renderElement = (element: AiElement) => render(element.type, element.props);
  return { render, renderElement, requests, fresh, states };
}

test('连接卡片默认收起、可切换和收起，重新挂载不记住选择', () => {
  const h = aiHarness();
  const connection = () => aiNodes(h.render()).find((e) => aiNamed(e, 'Connect'))!;
  const cards = () => aiNodes(h.renderElement(connection())).filter((e) => e.props.className?.startsWith('ai-client '));
  const steps = () => aiNodes(h.renderElement(connection())).find((e) => e.type === 'ol');
  assert.equal(steps(), undefined);
  assert.equal(cards().length, 8);
  for (const card of cards()) {
    assert.equal(card.type, 'button');
    assert.equal(card.props.type, 'button');
    assert.equal(card.props.role, undefined); // 原生按钮保留 Enter / Space 行为
    assert.equal(card.props['aria-expanded'], false);
    assert.equal(card.props['aria-controls'], undefined);
  }
  cards()[0].props.onClick();
  assert.equal(cards()[0].props['aria-expanded'], true);
  assert.equal(cards()[0].props['aria-controls'], steps()!.props.id);
  let block = aiNodes(h.renderElement(connection())).find((e) => aiNamed(e, 'CodeBlock'))!;
  assert.ok(block.props.code.includes('claude mcp add'));
  assert.ok(block.props.code.includes('<your-token>'));
  cards()[7].props.onClick();
  assert.equal(cards()[0].props['aria-expanded'], false);
  assert.equal(cards()[7].props['aria-expanded'], true);
  block = aiNodes(h.renderElement(connection())).find((e) => aiNamed(e, 'CodeBlock'))!;
  assert.ok(block.props.code.includes('POST https://example.test/mcp'));
  assert.equal(aiNodes(h.renderElement(connection())).filter((e) => e.type === 'ol').length, 1);
  cards()[7].props.onClick();
  assert.equal(steps(), undefined);
  cards()[0].props.onClick();
  h.states.clear(); // 等价于首次进入或刷新后的组件重新挂载
  assert.equal(steps(), undefined);
  assert.equal(
    h.requests.some((r) => r.init?.method),
    false,
  );
});

test('14. 真实生成流程将令牌带入弹层提示词，关闭和已保存都清空，主页面始终使用占位符', async () => {
  for (const close of ['onClose', 'saved']) {
    const h = aiHarness();
    let nodes = aiNodes(h.render());
    let main = nodes.find((e) => aiNamed(e, 'Connect'))!;
    aiNodes(h.renderElement(main))
      .find((e) => e.props.className === 'ai-client ')!
      .props.onClick();
    nodes = aiNodes(h.render());
    nodes.find((e) => e.type === 'button' && e.props.className === 'btn primary')!.props.onClick();
    const create = aiNodes(h.render()).find((e) => aiNamed(e, 'NewToken'))!;
    const form = h.renderElement(create);
    const generate = aiNodes(aiNodes(form).find((e) => e.type === 'Sheet')!.props.foot).find((e) => e.props.className === 'btn primary')!;
    await generate.props.onClick();
    assert.deepEqual(
      h.requests.find((r) => r.init?.method === 'POST'),
      {
        path: '/api/mcp/tokens',
        init: { method: 'POST', body: JSON.stringify({ name: 'Claude Code', scope: 'write' }) },
      },
    );
    nodes = aiNodes(h.render());
    const connections = nodes.filter((e) => aiNamed(e, 'Connect'));
    assert.equal(connections.length, 2);
    main = connections[0];
    assert.equal(main.props.token, undefined);
    const mainBlock = aiNodes(h.renderElement(main)).find((e) => aiNamed(e, 'CodeBlock'))!;
    assert.ok(mainBlock.props.code.includes('<your-token>'));
    assert.ok(!mainBlock.props.code.includes(h.fresh.token));
    const freshBlock = aiNodes(h.renderElement(connections[1])).find((e) => aiNamed(e, 'CodeBlock'))!;
    assert.ok(freshBlock.props.code.includes(h.fresh.token));
    assert.equal(connections[1].props.token, h.fresh);
    const sheet = nodes.find((e) => e.type === 'Sheet')!;
    if (close === 'onClose') sheet.props.onClose();
    else
      aiNodes(sheet.props.foot)
        .find((e) => e.type === 'button')!
        .props.onClick();
    nodes = aiNodes(h.render());
    assert.equal(
      nodes.some((e) => e.type === 'Sheet'),
      false,
    );
    assert.equal([...h.states.values()].flat().includes(h.fresh), false);
    assert.equal(nodes.filter((e) => aiNamed(e, 'Connect')).length, 1);
    assert.equal(nodes.find((e) => aiNamed(e, 'Connect'))!.props.token, undefined);
  }
});

test('15. 14 种语言的合租空状态指向编辑器真实分组及发起选项', () => {
  for (const { code } of LOCALES) {
    const editor = locale(code, 'editor');
    const copy = locale(code, 'family').pool.emptyBody;
    assert.ok(copy.includes(editor.group.who), code);
    assert.ok(copy.includes(editor.share.owner), code);
  }
  assert.ok(locale('en', 'family').pool.emptyBody.includes('I host'));
});

test('16. 14 种语言的代付空状态指向编辑器真实分组及代付选项', () => {
  for (const { code } of LOCALES) {
    const editor = locale(code, 'editor');
    const copy = locale(code, 'proxy').page.emptyBody;
    assert.ok(copy.includes(editor.group.who), code);
    assert.ok(copy.includes(editor.share.proxy), code);
  }
  assert.ok(locale('zh-CN', 'proxy').page.emptyBody.includes('谁在用'));
});

test('9/17. 所有语言区分报告全额实付与年度我的份额，并说明日历客户端边界；ICS 仍声明建议周期与相对闹钟', () => {
  const clientTerms: Record<string, string> = {
    en: 'client',
    'zh-CN': '客户端',
    'zh-TW': '用戶端',
    'zh-HK': '用戶端',
    ja: 'アプリ',
    ko: '앱',
    es: 'cliente',
    fr: 'client',
    de: 'Kalenderprogramm',
    'pt-BR': 'aplicativo',
    ru: 'клиента',
    tr: 'uygulamasına',
    id: 'aplikasi',
    vi: 'ứng dụng',
  };
  for (const { code } of LOCALES) {
    const report = locale(code, 'report').cash.fullPaidHint;
    const review = locale(code, 'review').spendBasis;
    assert.ok(report && review && report !== review, code);
    if (code === 'en') assert.ok(review.includes('my share'));
    if (code === 'zh-CN') assert.ok(review.includes('我的份额'));
    const intro = locale(code, 'app').ics.intro;
    assert.ok(intro.includes('6'), code);
    assert.ok(intro.includes(clientTerms[code]), code);
  }
  const today = todayIn('UTC');
  const ics = buildIcs(
    {
      subscriptions: [
        {
          id: 's',
          name: 'Plan',
          category: 'Tools',
          tags: [],
          price: 10,
          currency: 'USD',
          cycle: { unit: 'month', every: 1 },
          start: addDays(today, 3),
          status: 'active',
        },
      ],
      methods: [],
      settings: DEFAULT_SETTINGS,
      fx: FALLBACK_FX,
    },
    'https://example.test',
  );
  assert.ok(ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT6H'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:'));
  assert.ok(ics.includes('TRIGGER:-P2DT15H'));
  assert.ok(!ics.includes('TRIGGER;VALUE=DATE-TIME'));
});

test('报告损失明细可打开原订阅；四种年度分享在非零且未隐藏时展示损失', async () => {
  const { stopHistory, stopLosses, yearReview } = await import('./metrics.ts');
  const { stopSubscription } = await import('./phases.ts');
  const { cnDate, flow, money } = await import('./format.ts');
  const { flatten, setLocale, t } = await import('./i18n.ts');
  type Element = { type: string; props: Record<string, any>; children: unknown[] };
  const React = {
    createElement(type: string | ((p: any) => unknown), props: Record<string, any> | null, ...children: unknown[]) {
      return typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children };
    },
  };
  const load = (file: string, names: string[], deps: Record<string, unknown>) => {
    const source = read(file)
      .replace(/^import [\s\S]*?;\n/gm, '')
      .replace(/export function /g, 'function ');
    const result = transformSync(file, source + '\n' + copySource, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
    assert.equal(result.fatal, false);
    const components = { ...deps, ...fxTotals, FxAmount: fxAmountComponent(deps.React, 'Amount'), ...metricComponents(deps.React) };
    return new Function(...Object.keys(components), `${result.code}; return { ${names.join(', ')} };`)(...Object.values(components));
  };
  const all = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(all);
    if (!node || typeof node !== 'object' || !('type' in node)) return [];
    const e = node as Element;
    return [e, ...all(e.children)];
  };
  const text = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(text).join('');
    if (node == null || typeof node === 'boolean') return '';
    return typeof node === 'object' ? text((node as Element).children) : String(node);
  };
  const deps = {
    React,
    t,
    money,
    flow,
    cnDate,
    useMemo: (f: () => unknown) => f(),
    useState: (v: unknown) => [v, () => {}],
    stopHistory,
    stopLosses,
    tipProps: () => ({}),
    SubIcon: 'SubIcon',
    TailName: 'TailName',
    Amount: 'Amount',
    CardTitle: 'h3',
    CopyImageButton: 'CopyImageButton',
  };
  const { StopsCard } = load('../app/src/views/Report.tsx', ['StopsCard'], deps);
  const { Receipt, Poster, Card, Stars } = load('../app/src/views/Review.tsx', ['Receipt', 'Poster', 'Card', 'Stars'], {
    React,
    t,
    SubIcon: 'SubIcon',
    TailName: 'TailName',
    catColor: () => '#777',
    monthLabel: () => 'October',
    packCircles: () => [],
    location: { host: 'example.test' },
  });
  const today = '2026-10-19';
  const original = {
    id: 'fictional',
    name: 'Fictional Service',
    category: 'tools',
    tags: [],
    price: 31,
    currency: 'USD',
    cycle: { unit: 'month' as const, every: 1 },
    start: '2026-10-05',
    status: 'active' as const,
  };
  const stopped = stopSubscription(original, today, 'terminate', today, 'abuse', { amount: 6 });
  const cancelled = stopSubscription({ ...original, id: 'cancelled' }, today, 'cancel');
  const st = { subscriptions: [stopped, cancelled], methods: [], settings: DEFAULT_SETTINGS, fx: FALLBACK_FX };
  for (const lang of ['en', 'zh-CN']) {
    const messages = {};
    for (const ns of ['common', 'core', 'report', 'review']) flatten(ns, locale(lang, ns), messages);
    setLocale(lang as 'en' | 'zh-CN', [messages]);
    const opened: string[] = [];
    const onOpen = (sub: { id: string }) => opened.push(sub.id);
    const tree = StopsCard({ state: st, today, onOpen });
    // 汇总之外列损失明细，点一行打开原订阅
    const rows = all(tree).filter((e) => e.props.className === 'stop-row');
    assert.equal(rows.length, stopLosses(st, today).items.length);
    (rows[0].props.onClick as () => void)();
    assert.equal(opened.length, 1);
    // 明细最多先放 5 条，其余折叠成「再看 N 项」
    const many = { ...st, subscriptions: Array.from({ length: 7 }, (_, n) => stopSubscription({ ...original, id: `many-${n}` }, today, 'terminate')) };
    const manyTree = StopsCard({ state: many, today, onOpen });
    assert.equal(all(manyTree).filter((e) => e.props.className === 'stop-row').length, 5);
    assert.ok(text(manyTree).includes(t('report.checkup.more', { count: 2 })));
    assert.ok(text(tree).includes(t('report.stops.loss')));
    assert.ok(text(tree).includes(t('report.stops.cancel')));
    assert.ok(text(tree).includes(t('core.stop.terminate')));
    const empty = StopsCard({ state: { ...st, subscriptions: [] }, today, onOpen });
    assert.ok(text(empty).includes(t('report.stops.loss')));
    assert.ok(!text(empty).includes(t('report.stops.cancel')));
    // 次数算全部停用，不只是有未退款损失的：只有一次无损失的我取消也要显示
    // 9 月 5 日开始的月付在 10 月 4 日（当期最后一天）取消，没有损失
    const noLoss = { ...st, subscriptions: [stopSubscription({ ...original, id: 'no-loss', start: '2026-09-05' }, '2026-10-04', 'cancel')] };
    const onlyCancel = StopsCard({ state: noLoss, today, onOpen });
    assert.equal(stopLosses(noLoss, today).items.length, 0);
    assert.ok(text(onlyCancel).includes(t('report.stops.cancel')));
    const unknown = stopSubscription({ ...original, currency: 'XYZ' }, today, 'terminate');
    const unknownTree = StopsCard({ state: { ...st, subscriptions: [unknown] }, today, onOpen });
    assert.ok(text(unknownTree).includes(fxTotals.totalNote(stopLosses({ ...st, subscriptions: [unknown] }, today).partial)));
    const r = yearReview(st, today);
    const ctx = {
      r,
      year: '2026',
      name: 'Alex',
      whose: 'Alex',
      ongoing: true,
      m: (n: number, part?: fxTotals.FxTotal) => (part?.incomplete ? fxTotals.formatTotal(part, 'USD', { direction: 1 }) : flow(n, 'USD')),
      pct: () => '50%',
      byMethod: [],
      tip: 'Tip',
      today,
      mrr: 0,
      saved: '',
    };
    for (const style of [Receipt, Poster, Card, Stars]) {
      const line = t('review.stopLoss', { amount: flow(-26, 'USD') });
      assert.ok(text(style({ ...ctx, hide: false })).includes(line));
      assert.ok(!text(style({ ...ctx, hide: true })).includes(line));
      assert.ok(
        text(style({ ...ctx, r: { ...r, stopLoss: NaN, partial: { ...r.partial, stopLoss: fxTotals.amountTotal(10, 'XYZ', NaN) } }, hide: false })).includes(
          'XYZ',
        ),
      );
      assert.equal(all(style({ ...ctx, r: { ...r, stopLoss: 0 }, hide: false })).filter((e) => e.props.className === 'review-loss').length, 0);
    }
  }
  setLocale('en', []);
});

test('14 种语言统一未退款损失语义，金额标签取代未用天数，预付余值保持独立', () => {
  for (const { code } of LOCALES) {
    const core = locale(code, 'core').stop;
    const report = locale(code, 'report');
    const review = locale(code, 'review');
    const detail = locale(code, 'detail').stop;
    assert.equal(report.stops.loss, core.lossTitle, code);
    assert.ok(core.unused.includes(core.lossTitle), code);
    assert.ok(review.stopLoss.toLocaleLowerCase(code).includes(core.lossTitle.toLocaleLowerCase(code)), code);
    assert.ok(core.unrefunded.includes('{money}'), code);
    assert.ok(!core.unrefunded.includes('{days}'), code);
    assert.ok(detail.loss.includes('{money}') && detail.loss.includes('{days}'), code);
    assert.ok(core.fullyRefunded && detail.title, code);
    assert.notEqual(core.unusedTitle, core.lossTitle, code); // 图例只写“未退款”。
  }
  assert.equal(locale('zh-CN', 'report').cash.prepaidSub, '{count} 项已付未用完');
  assert.equal(locale('zh-CN', 'core').stop.lossTitle, '未退款损失');
  assert.equal(locale('en', 'core').stop.lossTitle, 'Unrefunded loss');
});

test('登录与首次设置表单为密码管理器提供同一账号和正确的 autocomplete、无障碍标签', () => {
  const source = read('../app/src/app.tsx');
  const login = source.slice(source.indexOf('function Login('), source.indexOf('function Sidebar('));
  const result = transformSync('Login.tsx', login, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  type Element = { type: string; props: Record<string, any>; children: unknown[] };
  const React = { createElement: (type: string, props: Record<string, any> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }) };
  const all = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(all);
    if (!node || typeof node !== 'object' || !('type' in node)) return [];
    const e = node as Element;
    return [e, ...all(e.children)];
  };
  for (const needsSetup of [false, true]) {
    let cursor = 0;
    const deps = {
      React,
      useState: (v: unknown) => [cursor++ === 0 ? { needsSetup, passkeys: 1 } : v, () => {}],
      useRef: () => ({ current: undefined }),
      useEffect() {},
      location: { hostname: 'ledger.example.test' },
      window: { PublicKeyCredential: function () {} },
      Icon: 'Icon',
      t: (key: string) => key,
      base: (path: string) => path,
    };
    const Login = new Function(...Object.keys(deps), `${result.code}; return Login;`)(...Object.values(deps));
    const nodes = all(Login({}));
    const username = nodes.find((e) => e.type === 'input' && e.props.name === 'username')!;
    assert.equal(username.props.value, 'owner@ledger.example.test');
    assert.equal(username.props.autoComplete, needsSetup ? 'username' : 'username webauthn');
    assert.equal(username.props.readOnly, true);
    const label = nodes.find((e) => e.type === 'label' && e.props.htmlFor === username.props.id)!;
    assert.ok(JSON.stringify(label.children).includes('app.login.username'));
    const password = nodes.find((e) => e.type === 'input' && e.props.name === 'password')!;
    assert.equal(password.props.type, 'password');
    assert.equal(password.props.autoComplete, needsSetup ? 'new-password' : 'current-password webauthn');
    assert.equal(password.props['aria-label'], needsSetup ? 'app.login.newPassword' : 'app.login.password');
    for (const { code } of LOCALES) assert.ok(locale(code, 'app').login.username, code);
  }
  assert.ok(login.includes('autofill.current?.();')); // 密码提交和 Passkey 按钮共用 go() 的同步取消
  assert.ok(login.includes('return stop;')); // 卸载时清理条件式请求
});

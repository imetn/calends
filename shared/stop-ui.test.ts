import * as fxTotals from './fx-total.ts';
import { editorMoreKeys, editorMoreOpen } from '../app/src/views/editor/more.ts';
import { readUiSource } from '../scripts/ui-test-source.ts';
import { metricComponents, fxAmountComponent } from '../scripts/ui-test-components.ts';
import * as transfers from './transfers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'oxc-transform-react';
import * as billing from './billing.ts';
import * as phases from './phases.ts';
import * as stopForm from './stop-form.ts';
import * as format from './format.ts';
import * as gantt from './gantt.ts';
import * as metrics from './metrics.ts';
import * as fx from './fx.ts';
import * as carpool from './carpool.ts';
import { yearOutlook } from './scope-report.ts';
import { flatten, intlLocale, setLocale, t } from './i18n.ts';
import { DEFAULT_SETTINGS, type Subscription } from './types.ts';

const messages = {};
for (const ns of ['core', 'common', 'editor', 'list', 'detail', 'overview', 'report'])
  flatten(ns, JSON.parse(readFileSync(new URL(`./locales/en/${ns}.json`, import.meta.url), 'utf8')), messages);
setLocale('en', [messages]);
const today = '2026-10-19';
const sub: Subscription = {
  id: 's',
  name: 'Service',
  category: 'tools',
  tags: [],
  price: 31,
  currency: 'USD',
  start: '2026-10-05',
  cycle: { unit: 'month', every: 1 },
  status: 'active',
};
type Element = { type: string; props: Record<string, any>; children: unknown[] };
const all = (node: unknown): Element[] =>
  Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' && 'type' in node ? [node as Element, ...all((node as Element).children)] : [];
const React = {
  Fragment: 'Fragment',
  createElement(type: string, props: Element['props'], ...children: unknown[]) {
    return { type, props: props ?? {}, children };
  },
};
function runtime(file: string, extra: Record<string, unknown>, names = file.includes('StopPanel') ? 'StopPanel, stopLabel, stopDescription' : 'Gantt') {
  const source = readUiSource(new URL(file, import.meta.url))
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export \{.*\};\n/gm, '');
  const copySource = readFileSync(new URL('../app/src/components/copy.tsx', import.meta.url), 'utf8').replace(/^import.*;\n/gm, '');
  // 详情类视图共用的头部、面板与事实项在 DetailKit，与被测文件一起编译
  const kitSource = /DetailKit\.tsx/.test(readUiSource(new URL(file, import.meta.url)))
    ? readFileSync(new URL('../app/src/components/DetailKit.tsx', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '')
    : '';
  const result = transformSync(file, source + '\n' + copySource + '\n' + kitSource, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const values: unknown[] = [];
  let cursor = 0;
  const deps = {
    React,
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
    useSnapshotRender() {},
    useRef(initial: unknown) {
      return { current: initial };
    },
    useMemo(fn: () => unknown) {
      return fn();
    },
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore: (_subscribe: unknown, _get: unknown, server: () => unknown) => server(),
    useMedia: () => false,
    useEffectEvent: (fn: unknown) => fn,
    ...billing,
    ...transfers,
    ...phases,
    ...stopForm,
    ...format,
    ...gantt,
    ...metrics,
    ...fx,
    ...fxTotals,
    FxAmount: fxAmountComponent(extra.React ?? React, 'Amount'),
    getState: () => ({ methods: [], settings: DEFAULT_SETTINGS }),
    ...carpool,
    perBill: (key: string) => key,
    toBase: fx.toBaseAt,
    // app/src/derive.ts 的显示合计与排序；ui.tsx 的防重复提交（测试里同步执行）
    sumBaseOrNaN: (st: AppState, rows: billing.Charge[]) => rows.reduce((n, c) => n + fx.chargeBaseOrNaN(st, c), 0),
    sortValue: (v: number) => (Number.isFinite(v) ? v : -Infinity),
    useSubmit: () => [false, (fn: () => unknown) => Promise.resolve(fn())],
    t,
    intlLocale,
    ConfirmButton: 'ConfirmButton',
    Cell: 'Cell',
    Picker: 'Picker',
    CurrencySelect: 'CurrencySelect',
    DatePicker: 'DatePicker',
    Fragment: 'Fragment',
    Seg: 'Seg',
    Stepper: 'Stepper',
    NumInput: 'NumInput',
    Icon: 'Icon',
    IconButton: 'button',
    CardTitle: 'h3',
    CopyImageButton: 'CopyImageButton',
    Hint: 'Hint',
    SubIcon: 'SubIcon',
    TailName: 'TailName',
    FlagImg: 'FlagImg',
    ...metricComponents(extra.React ?? React),
    ...extra,
  };
  const exports = new Function(...Object.keys(deps), `${result.code.replace(/export /g, '')}; return {${names}};`)(...Object.values(deps));
  return {
    exports,
    render(name: string, props: unknown) {
      cursor = 0;
      return exports[name](props);
    },
  };
}

test('真实停止表单：三种模式、日期默认值、币种锁定、按天预填、超额拒绝、实退和恢复权限', () => {
  const applied: Subscription[] = [];
  const errors: string[] = [];
  const r = runtime('../app/src/components/StopPanel.tsx', { React: renderedReact, toast: (message: string) => errors.push(message) });
  const render = (s = sub) => all(r.render('StopPanel', { sub: s, today, onApply: (value: Subscription) => applied.push(value) }));
  let nodes = render();
  const mode = nodes.find((e) => e.type === 'Picker' && e.props.ariaLabel === t('core.stop.method'))!;
  assert.equal(mode.props.options.length, 3);
  assert.equal(nodes.find((e) => e.type === 'DatePicker')!.props.value, '2026-11-04');
  mode.props.onChange('terminate');
  nodes = render();
  assert.equal(nodes.find((e) => e.type === 'DatePicker')!.props.value, today);
  const cell = (label: string) => nodes.find((e) => e.type === 'Cell' && e.props.label === label)!;
  all(cell(t('core.stop.reason')))[1].props.onChange({ target: { value: 'abuse' } });
  nodes = render();
  nodes.find((e) => e.type === 'Picker' && e.props.ariaLabel === t('editor.payment.kind.refund'))!.props.onChange('yes');
  nodes = render();
  const amount = all(cell(`${t('core.stop.refundAmount')}\nUSD`)).find((e) => e.type === 'input')!;
  assert.equal(amount.props.value, '16');
  // 唯一可选币种属于卡上实退，订阅退款币种没有选择器。
  assert.equal(nodes.filter((e) => e.type === 'CurrencySelect').length, 1);
  amount.props.onChange({ target: { value: '32' } });
  nodes = render();
  nodes.find((e) => e.type === 'button' && e.children.includes(t('core.stop.title')))!.props.onClick();
  assert.equal(applied.length, 0);
  assert.equal(errors.at(-1), t('mcp.error.refundExceedsPaid'));
  all(cell(`${t('core.stop.refundAmount')}\nUSD`))
    .find((e) => e.type === 'input')!
    .props.onChange({ target: { value: '6' } });
  nodes = render();
  all(cell(t('editor.payment.settledAmount')))
    .find((e) => e.type === 'input')!
    .props.onChange({ target: { value: '40' } });
  nodes = render();
  nodes.find((e) => e.type === 'CurrencySelect')!.props.onChange('CNY');
  nodes = render();
  nodes.find((e) => e.type === 'button' && e.children.includes(t('core.stop.title')))!.props.onClick();
  const saved = applied[0];
  assert.equal(saved.stop!.reason, 'abuse');
  assert.equal(saved.payments!.at(-1)!.amount, -6);
  assert.deepEqual(saved.payments!.at(-1)!.settled, { amount: -40, currency: 'CNY' });
  assert.ok(!render(saved).some((e) => e.type === 'button' && e.children.includes(t('core.stop.restore'))));
  const cancelled = phases.stopSubscription(sub, today, 'cancel');
  const restore = render(cancelled).find((e) => e.type === 'button' && e.children.includes(t('core.stop.restore')))!;
  restore.props.onClick();
  assert.equal(applied.at(-1)!.stop, undefined);
  assert.equal(applied.at(-1)!.end, undefined);
});

test('真实甘特结构：未退款段接在实线后、红色停用标记、退款点与公开视图', () => {
  const stop = runtime('../app/src/components/StopPanel.tsx', { toast() {} }).exports;
  const r = runtime('../app/src/views/Gantt.tsx', {
    usePref: (_key: string, initial: unknown) => [initial, () => {}],
    useWidth: () => [() => {}, 600],
    perLabel: () => 'mo',
    stopDescription: stop.stopDescription,
  });
  const render = (s: Subscription, readonly = false) =>
    all(
      r.render('Gantt', {
        rows: [s],
        state: { subscriptions: [s], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX, readonly },
        today,
        onOpen() {},
      }),
    );
  const withClass = (nodes: Element[], cls: string) =>
    nodes.filter((e) =>
      String(e.props.className ?? '')
        .split(' ')
        .includes(cls),
    );
  for (const amount of [undefined, 6, 31]) {
    const stopped = phases.stopSubscription(sub, today, 'terminate', today, 'abuse', amount == null ? undefined : { amount });
    const nodes = render(stopped);
    assert.equal(withClass(nodes, 'gt-unused').length, amount === 31 ? 0 : 1);
    assert.equal(withClass(nodes, 'gt-stop').length, 1);
    if (amount !== 31) {
      const unused = withClass(nodes, 'gt-unused')[0];
      assert.equal(unused.props.style.top, withClass(nodes, 'gt-seg')[0].props.style.top);
      // 被服务方停用：彩色段直角铺到停用日中线，灰段从中线开始，与条同高的停用标志以中线为圆心压在两者之上
      assert.equal(withClass(nodes, 'joined').length, 1);
      const stop = withClass(nodes, 'gt-stop')[0];
      const seg = withClass(nodes, 'gt-seg').at(-1);
      assert.equal(stop.props.style.top, unused.props.style.top);
      assert.equal(unused.props.style.left, stop.props.style.left + 11);
      assert.equal(seg.props.style.left + seg.props.style.width, unused.props.style.left);
      assert.ok(unused.props.style.width > 0);
      assert.ok(unused.props.title.includes('abuse'));
    }
    assert.equal(withClass(nodes, 'refund').length, amount == null ? 0 : 1);
    assert.equal(withClass(render(stopped, true), 'gt-unused').length, 0);
  }
  const cancelled = render(phases.stopSubscription(sub, today, 'cancel'));
  // 主动退订不加额外标记，只有服务方停用才有禁止标志
  assert.equal(withClass(cancelled, 'gt-stop').length, 0);
  assert.equal(withClass(cancelled, 'gt-unused').length, 1);
  // 主动退订：实线最后一截改直角，与未退款段拼成一根
  assert.equal(withClass(cancelled, 'joined').length, 1);
});

const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text((node as Element).children) : String(node);
};
const renderedReact = {
  ...React,
  createElement(type: string | ((props: any) => unknown), props: Element['props'], ...children: unknown[]) {
    return typeof type === 'function' ? type({ ...props, children }) : React.createElement(type, props, ...children);
  },
};
const withClass = (node: unknown, cls: string) =>
  all(node).filter((e) =>
    String(e.props.className ?? '')
      .split(' ')
      .includes(cls),
  );

// 使用真实 Outcome / Statement，执行组件树；仅替换宿主、Hooks 和不相关的可视化。
test('详情停止卡片：无 stop 完全不渲染；仅正损失显示红色金额；全额退款、零损失隐藏损失', () => {
  const r = runtime(
    '../app/src/views/Detail.tsx',
    {
      React: renderedReact,
      catColor: () => '#777',
      CatIcon: 'CatIcon',
      PayBadge: 'PayBadge',
      RegionTag: 'RegionTag',
      subRegion: (s: { region?: string }) => s.region,
    },
    'Outcome',
  );
  const render = (s: Subscription) =>
    r.render('Outcome', {
      sub: s,
      today,
      state: { subscriptions: [s], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX },
    });
  for (const s of [sub, { ...sub, status: 'cancelled' as const, end: today }]) {
    assert.equal(withClass(render(s), 'dt-outcome').length, 0);
  }
  for (const kind of ['cancel', 'terminate'] as const) {
    for (const amount of [undefined, 6, 16, 31]) {
      const s = phases.stopSubscription(
        sub,
        today,
        kind,
        today,
        kind === 'terminate' ? 'Provider closure' : undefined,
        amount == null ? undefined : { amount },
      );
      const tree = render(s);
      const section = withClass(tree, 'dt-outcome');
      assert.equal(section.length, 1);
      const summary = billing.stopSummary(s, today)!;
      assert.ok(text(section).includes(format.cnDateFull(today)));
      assert.ok(text(section).includes(format.cnDateFull(summary.paidThrough)));
      assert.ok(text(section).includes(t(kind === 'terminate' ? 'core.stop.terminate' : 'report.stops.cancel')));
      assert.equal(text(section).includes('Provider closure'), kind === 'terminate');
      assert.equal(withClass(section, 'dt-oc-loss').length, summary.unusedValue > 0 ? 1 : 0);
      if (summary.unusedValue > 0) {
        assert.ok(text(section).includes(t('core.stop.lossTitle')));
        assert.ok(text(section).includes(`−${format.money(summary.unusedValue, 'USD')}`));
        assert.ok(text(section).includes(t('core.stop.lossDays', { count: summary.wastedDays })));
      } else {
        assert.ok(text(section).includes(t('core.stop.fullyRefunded')));
        assert.ok(!text(section).includes(t('core.stop.lossTitle')));
      }
      if (amount == null) assert.ok(text(section).includes(t('core.stop.refundNo')));
      else {
        assert.ok(text(section).includes(t(summary.refundStatus === 'full' ? 'core.stop.fullyRefunded' : 'core.stop.partial', { money: '' }).trim()));
        assert.ok(!text(section).includes(format.flow(amount, 'USD')), 'a single refund amount is owned by the charge record');
      }
    }
  }
  const free = phases.stopSubscription({ ...sub, price: 0 }, today, 'cancel');
  assert.equal(withClass(render(free), 'dt-outcome').length, 1);
  assert.equal(withClass(render(free), 'dt-oc-loss').length, 0);
  assert.ok(!text(render(free)).includes(t('core.stop.fullyRefunded')));
});

test('详情历史阶段：各停止阶段使用自己的退款、币种、停止日期，当前未停止的阶段不混入', () => {
  const r = runtime('../app/src/views/Detail.tsx', { React: renderedReact }, 'Outcome');
  const first = phases.stopSubscription(sub, today, 'terminate', today, 'Provider closure', { amount: 6 });
  const second = phases.stopSubscription({ ...sub, start: '2026-11-05', currency: 'EUR', price: 60 }, '2026-11-19', 'cancel', '2026-11-19', undefined, {
    amount: 32,
  });
  const multi = { ...sub, phases: [first, second, { ...sub, start: '2026-12-05', currency: 'JPY', price: 3000 }] };
  const tree = r.render('Outcome', {
    sub: multi,
    today: '2026-12-10',
    state: { subscriptions: [multi], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX },
  });
  assert.equal(withClass(tree, 'dt-outcome').length, 2);
  assert.equal(withClass(tree, 'dt-oc-loss').length, 1);
  assert.ok(text(tree).includes(`−${format.money(10, 'USD')}`));
  assert.ok(!text(tree).includes(format.flow(32, 'EUR')), 'a single historical refund is not repeated in the outcome card');
  assert.ok(text(tree).includes(t('core.stop.fullyRefunded')));
  assert.ok(text(tree).includes(format.cnDateFull('2026-11-19')));
  assert.ok(!text(tree).includes(format.cnDateFull('2026-12-05')));
});

test('概览今年已付：只显示报告年卡的已付金额，不带附注、不再列损失', () => {
  const r = runtime('../app/src/views/Overview.tsx', { React: renderedReact, yearOutlook, packCircles: () => [], Amount: 'Amount' }, 'Statement');
  const current = phases.stopSubscription({ ...sub, id: 'current' }, today, 'terminate', today, 'Provider closure', { amount: 6 });
  const state = { subscriptions: [current], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX };
  const tree = r.render('Statement', { state, today, onOpen() {} });
  const cells = withClass(withClass(tree, 'metric-cards')[0], 'metric');
  assert.equal(cells.length, 4);
  const paid = cells[1];
  assert.ok(text(paid).includes(t('scope.yearPaid')));
  assert.ok(text(paid).includes(format.money(yearOutlook(state, today).current.partial.paid.value, DEFAULT_SETTINGS.baseCurrency, { compact: true })));
  assert.equal(withClass(paid, 'metric-note').length, 0);
  assert.ok(!text(tree).includes(t('overview.stmt.loss')));
});

test('时间轴金额：宽段显示紧凑负金额，窄段仅保留悬停说明，停用半圆避让且公开隐藏', () => {
  let width = 600;
  const stop = runtime('../app/src/components/StopPanel.tsx', { toast() {} }).exports;
  const r = runtime('../app/src/views/Gantt.tsx', {
    usePref: (_key: string, initial: unknown) => [initial, () => {}],
    useWidth: () => [() => {}, width],
    perLabel: () => 'mo',
    stopDescription: stop.stopDescription,
  });
  const render = (s: Subscription, readonly = false) =>
    r.render('Gantt', {
      rows: [s],
      state: { subscriptions: [s], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX, readonly },
      today,
      onOpen() {},
    });
  for (const kind of ['cancel', 'terminate'] as const) {
    const s = phases.stopSubscription(sub, today, kind, today, kind === 'terminate' ? 'Provider closure' : undefined);
    width = 390;
    let tree = render(s);
    assert.equal(withClass(tree, 'gt-unused-amount').length, 0);
    assert.ok(withClass(tree, 'gt-unused')[0].props.title.includes(t('core.stop.lossTitle')));
    width = 2000;
    tree = render(s);
    assert.equal(withClass(tree, 'gt-unused-amount').length, 1);
    assert.equal(text(withClass(tree, 'gt-unused-amount')), `−${format.money(16, 'USD', { compact: true })}`);
    assert.equal(withClass(tree, 'gt-unused')[0].props.style.paddingLeft, kind === 'terminate' ? 11 : 0);
    assert.equal(withClass(render(s, true), 'gt-unused-amount').length, 0);
    // 同样宽度下，超长金额仍应隐藏而不是压到标志或被裁掉。
    assert.equal(withClass(render(phases.stopSubscription({ ...sub, price: 1234567890123 }, today, kind)), 'gt-unused-amount').length, 0);
    const full = phases.stopSubscription(sub, today, kind, today, undefined, { amount: 16 });
    assert.equal(withClass(render(full), 'gt-unused-amount').length, 0);
  }
  assert.ok(text(render(phases.stopSubscription(sub, today, 'cancel'))).includes(t('core.stop.unusedTitle')));
});

test('详情与报告的停止损失采用同一份额和停止日汇率；缺失汇率不变成零', () => {
  const r = runtime('../app/src/views/Detail.tsx', { React: renderedReact }, 'Outcome');
  const stopped = phases.stopSubscription(sub, today, 'cancel', today, undefined, { amount: 6 });
  for (const [rates, history] of [
    [{ USD: 1, CNY: 7 }, { [today]: { USD: 1, CNY: 6.8 } }],
    [{ USD: 1 }, { [today]: { USD: 1, CNY: 6.8 } }],
    [{ USD: 1 }, {}],
  ]) {
    const state = {
      subscriptions: [stopped],
      methods: [],
      settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
      fx: { base: 'USD', fetchedAt: today, rates },
      fxHistory: history,
    };
    const expected = metrics.stopLosses(state, today).items[0];
    const tree = r.render('Outcome', { sub: stopped, state, today });
    assert.ok(text(tree).includes(`≈ ${format.flow(-expected.lossBase, 'CNY')}`));
    assert.ok(!text(tree).includes(format.flow(-expected.loss * 7, 'CNY')));
  }
});

// Execute the editor and its real form together; replace only unrelated widgets and persistence.
function editorRuntime(original: Subscription) {
  const saved: Subscription[] = [];
  const errors: string[] = [];
  const storage = new Map<string, string>();
  let closed = 0;
  const state = { subscriptions: [original], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX };
  const stops = runtime('../app/src/components/StopPanel.tsx', {}, 'StopFields').exports;
  const r = runtime(
    '../app/src/views/Editor.tsx',
    {
      React: renderedReact,
      StopFields: stops.StopFields,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      structuredClone,
      Sheet: 'Sheet',
      Group: 'Group',
      CategorySheet: 'CategorySheet',
      Toggle: 'Toggle',
      NumInput: 'NumInput',
      RegionSelect: 'RegionSelect',
      MethodPicker: 'MethodPicker',
      ContactField: 'ContactField',
      PersonPicker: 'PersonPicker',
      ChangePanel: 'ChangePanel',
      CatIcon: 'CatIcon',
      ReceiptText: 'ReceiptText',
      searchCatalog: () => [],
      base: (path: string) => path,
      RENEW_CYCLES: [['m1', { unit: 'month', every: 1 }]],
      cycleName: (cycle: any) => cycle.unit,
      categories: () => [],
      presetCat: (name: string) => name,
      isDomainCat: () => false,
      editorMoreKeys,
      editorMoreOpen,
      saveSub: async (value: Subscription) => saved.push(value),
      mergeEdits: (_old: Subscription, next: Subscription) => next,
      getState: () => state,
      run: async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          errors.push(String(e));
        }
      },
    },
    'Editor',
  );
  const render = () => {
    const tree = r.render('Editor', { sub: original, state, today, onClose: () => closed++ });
    return [...all(tree), ...all(tree.props.foot)];
  };
  return { render, saved, errors, storage, closed: () => closed };
}
const statusControl = (nodes: Element[]) => nodes.find((e) => e.type === 'Seg' && e.props.options.some(([value]: string[]) => value === 'stop'))!;
const button = (nodes: Element[], key: string) => nodes.find((e) => e.type === 'button' && e.children.includes(t(key)))!;

test('编辑状态：唯一控件，选择停止不写入，完成才保存到期不续；取消丢弃草稿', async () => {
  const r = editorRuntime(sub);
  let nodes = r.render();
  assert.ok(statusControl(nodes), 'Status must offer a single Stop option');
  assert.equal(statusControl(nodes).props.value, 'active');
  assert.equal(nodes.filter((n) => n.type === 'Picker' && n.props.ariaLabel === t('core.stop.method')).length, 0);
  statusControl(nodes).props.onChange('stop');
  nodes = r.render();
  assert.equal(statusControl(nodes).props.value, 'stop');
  assert.equal(r.saved.length, 0);
  assert.ok(!nodes.some((n) => n.type === 'button' && n.children.includes(t('common.apply'))));
  await button(nodes, 'common.done').props.onClick();
  assert.equal(r.saved[0].status, 'cancelled');
  assert.equal(r.saved[0].end, '2026-11-04');
  assert.equal(r.saved[0].stop, undefined);
  assert.equal(r.errors.length, 0);
  const cancelled = editorRuntime(sub);
  statusControl(cancelled.render()).props.onChange('stop');
  button(cancelled.render(), 'common.cancel').props.onClick();
  assert.equal(cancelled.saved.length, 0);
  assert.equal(cancelled.closed(), 1);
  assert.equal(cancelled.storage.size, 0);
});

test('编辑状态：立即停止及退款随完成保存，错误不关闭，改回计费中清除停止信息', async () => {
  const r = editorRuntime(sub);
  statusControl(r.render()).props.onChange('stop');
  let nodes = r.render();
  nodes.find((n) => n.type === 'Picker' && n.props.ariaLabel === t('core.stop.method'))!.props.onChange('cancel');
  nodes = r.render();
  nodes.find((n) => n.type === 'Picker' && n.props.ariaLabel === t('editor.payment.kind.refund'))!.props.onChange('yes');
  nodes = r.render();
  const refundAmount = () =>
    all(nodes.find((n) => n.type === 'Cell' && n.props.label === `${t('core.stop.refundAmount')}\nUSD`)).find((n) => n.type === 'input')!;
  refundAmount().props.onChange({ target: { value: '32' } });
  await button(r.render(), 'common.done').props.onClick();
  assert.equal(r.saved.length, 0);
  assert.equal(r.closed(), 0);
  nodes = r.render();
  refundAmount().props.onChange({ target: { value: '6' } });
  await button(r.render(), 'common.done').props.onClick();
  assert.equal(r.saved[0].stop!.kind, 'cancel');
  assert.equal(r.saved[0].payments!.filter((p) => p.kind === 'refund')[0].amount, -6);
  const restore = editorRuntime(r.saved[0]);
  assert.equal(statusControl(restore.render()).props.value, 'stop');
  assert.equal(restore.render().find((n) => n.type === 'Picker' && n.props.ariaLabel === t('core.stop.method'))!.props.value, 'cancel');
  statusControl(restore.render()).props.onChange('active');
  assert.equal(restore.saved.length, 0);
  await button(restore.render(), 'common.done').props.onClick();
  assert.equal(restore.saved[0].status, 'active');
  assert.equal(restore.saved[0].stop, undefined);
  assert.equal(restore.saved[0].end, undefined);
  assert.deepEqual(restore.saved[0].payments, r.saved[0].payments);
});

test('编辑状态：已有到期不续、试用、暂停、服务方停用及买断', async () => {
  for (const original of [phases.cancelAtEnd(sub, '2026-11-04', today), { ...sub, status: 'cancelled' as const, end: '2026-10-10' }]) {
    const r = editorRuntime(original);
    assert.equal(statusControl(r.render()).props.value, 'stop');
    assert.ok(r.render().some((n) => n.type === 'Picker' && n.props.value === 'nonrenew'));
  }
  const trial = editorRuntime(sub);
  statusControl(trial.render()).props.onChange('trial');
  let nodes = trial.render();
  all(nodes.find((n) => n.type === 'Cell' && n.props.label === t('editor.field.trialEnd')))
    .find((n) => n.type === 'DatePicker')!
    .props.onChange('2026-10-30');
  await button(trial.render(), 'common.done').props.onClick();
  assert.equal(trial.saved[0].trialEnd, '2026-10-30');
  assert.equal(trial.saved[0].status, 'trial');
  const paused = editorRuntime(sub);
  statusControl(paused.render()).props.onChange('paused');
  nodes = paused.render();
  all(nodes.find((n) => n.type === 'Cell' && n.props.label === t('editor.field.pausedAt')))
    .find((n) => n.type === 'DatePicker')!
    .props.onChange('2026-10-18');
  await button(paused.render(), 'common.done').props.onClick();
  assert.equal(paused.saved[0].pausedAt, '2026-10-18');
  assert.equal(paused.saved[0].status, 'paused');
  const terminated = editorRuntime(phases.stopSubscription(sub, today, 'terminate'));
  assert.deepEqual(statusControl(terminated.render()).props.disabledKeys, ['active', 'trial', 'paused']);
  assert.deepEqual(
    terminated
      .render()
      .find((n) => n.type === 'Picker' && n.props.ariaLabel === t('core.stop.method'))!
      .props.options.map((o: any) => o.value),
    ['terminate'],
  );
  const lifetime = editorRuntime({ ...sub, cycle: { unit: 'lifetime', every: 1 } });
  assert.equal(statusControl(lifetime.render()), undefined);
});

test('编辑停止字段：延期到续费日仍提示扣款；已有退款金额随日期修改保留', () => {
  const scheduled = editorRuntime(phases.cancelAtEnd(sub, '2026-11-04', today));
  let nodes = scheduled.render();
  nodes.find((n) => n.type === 'DatePicker' && n.props.value === '2026-11-04')!.props.onChange('2026-11-05');
  nodes = scheduled.render();
  const warning = nodes.find((n) => n.type === 'Cell' && n.props.label === t('core.stop.date'))!.props.sub;
  assert.equal(text(warning), t('core.stop.chargeOnEnd'));
  const refunded = editorRuntime(phases.stopSubscription(sub, today, 'cancel', today, undefined, { amount: 6 }));
  nodes = refunded.render();
  nodes.find((n) => n.type === 'DatePicker' && n.props.value === today)!.props.onChange('2026-10-18');
  nodes = refunded.render();
  const amount = all(nodes.find((n) => n.type === 'Cell' && n.props.label === `${t('core.stop.refundAmount')}\nUSD`)).find((n) => n.type === 'input')!;
  assert.equal(amount.props.value, '6');
});

test('编辑状态跟随既有历程操作：停用后新增阶段续订不会再次提交旧停止草稿', async () => {
  const original = phases.stopSubscription(sub, '2026-10-18', 'terminate', '2026-10-18', 'Closure', { amount: 6 });
  const r = editorRuntime(original);
  const resumed = phases.resume(original, today, { price: 40, currency: 'EUR', cycle: sub.cycle });
  r.render()
    .find((n) => n.type === 'ChangePanel')!
    .props.setF(resumed);
  const nodes = r.render();
  assert.equal(statusControl(nodes).props.value, 'active');
  assert.ok(!nodes.some((n) => n.type === 'Picker' && n.props.ariaLabel === t('core.stop.method')));
  await button(nodes, 'common.done').props.onClick();
  assert.equal(r.errors.length, 0);
  assert.equal(r.saved[0].stop, undefined);
  assert.equal(r.saved[0].phases!.length, 2);
  assert.equal(r.saved[0].phases![0].stop!.kind, 'terminate');
  assert.equal(r.saved[0].phases![0].payments!.filter((p) => p.kind === 'refund').length, 1);
});

test('all-history timeline omits today for stopped-only scopes even in the current month or with future unused service', () => {
  const stop = runtime('../app/src/components/StopPanel.tsx', { toast() {} }).exports;
  const r = runtime('../app/src/views/Gantt.tsx', {
    usePref: (key: string, initial: unknown) => [key === 'gantt-zoom' ? 'all' : initial, () => {}],
    useWidth: () => [() => {}, 600],
    perLabel: () => 'mo',
    stopDescription: stop.stopDescription,
  });
  const render = (subs: Subscription[]) =>
    all(
      r.render('Gantt', {
        rows: subs,
        state: { subscriptions: subs, methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX },
        today,
        onOpen() {},
      }),
    );
  const countToday = (nodes: Element[]) => nodes.filter((e) => e.props.className === 'gt-today').length;
  const stopped = phases.stopSubscription(sub, today, 'terminate', '2026-10-10');
  assert.equal(countToday(render([stopped])), 0);
  const fullyRefunded = phases.stopSubscription(sub, today, 'terminate', '2026-10-10', undefined, { amount: 31 });
  assert.equal(countToday(render([fullyRefunded])), 0);
  assert.equal(countToday(render([stopped, { ...sub, id: 'fictional-active' }])), 1);
});

test('narrow unused service keeps a full 22px display segment behind the termination mark', () => {
  const stop = runtime('../app/src/components/StopPanel.tsx', { toast() {} }).exports;
  const r = runtime('../app/src/views/Gantt.tsx', {
    usePref: (_key: string, initial: unknown) => [initial, () => {}],
    useWidth: () => [() => {}, 180],
    perLabel: () => 'week',
    stopDescription: stop.stopDescription,
  });
  const short = phases.stopSubscription({ ...sub, cycle: { unit: 'week', every: 1 }, price: 7 }, today, 'terminate', '2026-10-06');
  const nodes = all(
    r.render('Gantt', {
      rows: [short],
      state: { subscriptions: [short], methods: [], settings: DEFAULT_SETTINGS, fx: billing.FALLBACK_FX },
      today,
      onOpen() {},
    }),
  );
  const unused = nodes.find((e) => e.props.className === 'gt-unused')!;
  const mark = nodes.find((e) => e.props.className === 'gt-stop')!;
  assert.ok(unused);
  assert.ok(unused.props.style.width >= 22);
  assert.equal(unused.props.style.left, mark.props.style.left + 11);
  assert.equal(
    all(unused).some((e) => e.props.className === 'gt-unused-amount'),
    false,
  );
});

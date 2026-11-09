import assert from 'node:assert/strict';
import * as transfers from './transfers.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';
import * as billing from './billing.ts';
import * as format from './format.ts';
import * as gantt from './gantt.ts';
import { LOCALES, flatten, intlLocale, setLocale, t } from './i18n.ts';
import { DEFAULT_SETTINGS, type Subscription } from './types.ts';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('名称列上下限包含实际内边距、图标与间距，默认随短名称收窄并保留半幅轨道', () => {
  const style = { paddingLeft: 16, paddingRight: 12, iconWidth: 20, gap: 8 };
  assert.deepEqual(gantt.ganttLabelBounds(35, 1000, style), { min: 48, max: 91, default: 91 });
  assert.deepEqual(gantt.ganttLabelBounds(430.2, 1000, style), { min: 48, max: 487, default: 200 });
  assert.deepEqual(gantt.ganttLabelBounds(800, 601, style), { min: 48, max: 300, default: 200 });
  assert.deepEqual(gantt.ganttLabelBounds(800, 300, style), { min: 48, max: 150, default: 150 });
  assert.deepEqual(gantt.ganttLabelBounds(0, 1000, style), { min: 48, max: 48, default: 48 });
  assert.deepEqual(gantt.ganttLabelBounds(100, 60, style), { min: 48, max: 48, default: 48 });
  assert.deepEqual(gantt.ganttLabelBounds(35, 600, { ...style, paddingLeft: 12 }), { min: 44, max: 87, default: 87 });
});

test('时间窗口以过去为主、未来只留余量，兼容月末、闰年和跨年', () => {
  // 固定范围只给未来留一点余量，今天线靠右
  assert.deepEqual(gantt.ganttWindow('3m', '2026-10-21'), { start: '2026-07-28', end: '2026-10-28' });
  assert.deepEqual(gantt.ganttWindow('6m', '2026-10-21'), { start: '2026-04-30', end: '2026-10-31' });
  assert.deepEqual(gantt.ganttWindow('1y', '2026-10-21'), { start: '2025-11-05', end: '2026-11-05' });
  assert.deepEqual(gantt.ganttWindow('3y', '2026-10-21'), { start: '2023-12-05', end: '2026-12-05' });
  assert.deepEqual(gantt.ganttWindow('all', '2026-10-21', '2021-07-18'), { start: '2021-07-01', end: '2027-04-21' });
  assert.deepEqual(gantt.ganttWindow('all', '2026-10-21'), { start: '2026-10-01', end: '2027-04-21' });
  // 「全部」刚好装下这一批：都已结束时停在最后那个月，不拉到今天
  assert.deepEqual(gantt.ganttWindow('all', '2026-10-21', '2021-07-18', '2023-10-29'), { start: '2021-07-01', end: '2023-11-01' });
  // 有进行中的：只到今天（约 2% 余量，至少 7 天），不展开未来
  assert.deepEqual(gantt.ganttWindow('all', '2026-10-21', '2024-03-01', '2027-12-15'), { start: '2024-03-01', end: '2026-11-09' });
  assert.deepEqual(gantt.ganttWindow('3m', '2024-01-31'), { start: '2023-11-07', end: '2024-02-07' });
  for (const today of ['2024-02-29', '2025-01-31', '2026-08-31', '2026-12-31']) {
    for (const zoom of ['3m', '6m', '1y', '3y'] as const) {
      const { start, end } = gantt.ganttWindow(zoom, today);
      for (const d of [start, end]) assert.equal(billing.addDays(d, 0), d);
      const ratio = billing.diffDays(start, today) / billing.diffDays(start, end);
      assert.ok(ratio > 0.9 && ratio < 0.99, `${zoom} ${today}: ${ratio}`);
    }
    const half = gantt.ganttWindow('6m', today);
    assert.ok(billing.diffDays(half.start, half.end) >= 181 && billing.diffDays(half.start, half.end) <= 184);
  }
});

test('拖动吸附和翻页保留月份锚点，月末往返无漂移', () => {
  for (const base of ['2024-01-31', '2025-01-31', '2026-08-21', '2026-06-06']) {
    assert.equal(gantt.snapGanttPan(base, 0), 0);
    for (const raw of [-400, -48, -17, -5.2, 5.2, 17, 33, 390]) {
      const pan = gantt.snapGanttPan(base, raw);
      assert.ok(Math.abs(pan - raw) <= 16);
      assert.equal(gantt.snapGanttPan(base, pan), pan);
      assert.equal(billing.addDays(billing.addDays(base, pan), -pan), base);
    }
    for (const months of Object.values(gantt.GANTT_STEP)) {
      const next = gantt.stepGanttPan(base, 0, months);
      assert.equal(billing.addDays(base, next), billing.addMonths(base, months));
      assert.equal(gantt.stepGanttPan(base, next, -months), 0);
      const prev = gantt.stepGanttPan(base, 0, -months);
      assert.equal(gantt.stepGanttPan(base, prev, months), 0);
    }
  }
  assert.equal(billing.addDays('2024-01-31', gantt.snapGanttPan('2024-01-31', 28)), '2024-02-29');
  assert.equal(billing.addDays('2025-01-31', gantt.snapGanttPan('2025-01-31', 28)), '2025-02-28');
});

test('14 种语言的短窗口有周/半月网格及日期标签，窄轨道标签不重叠、不越界', () => {
  for (const { code } of LOCALES) {
    const list = JSON.parse(read(`./locales/${code}/list.json`));
    assert.equal(list.gantt.zoomYear, undefined, code);
    for (const key of ['zoom3m', 'zoom6m', 'zoom1y', 'zoom3y']) assert.ok(list.gantt[key], `${code} ${key}`);
    for (const zoom of ['3m', '6m'] as const) {
      for (const today of ['2026-10-21', '2024-01-31']) {
        const { start, end } = gantt.ganttWindow(zoom, today);
        // 390px 屏宽扣除页面留白、名称列和轨道右边距；另覆盖桌面宽轨道。
        for (const width of [180, 214, 900]) {
          const ticks = gantt.ganttTicks(zoom, start, end, width, code);
          assert.ok(ticks.length >= 11 && ticks.length <= 14, `${code} ${zoom}`);
          assert.equal(new Set(ticks.map((tick) => tick.d)).size, ticks.length);
          if (zoom === '3m') {
            for (let i = 1; i < ticks.length; i++) assert.equal(billing.diffDays(ticks[i - 1].d, ticks[i].d), 7);
          } else assert.ok(ticks.every((tick) => ['01', '15'].includes(tick.d.slice(8))));
          const labels = ticks.filter((tick) => tick.label);
          assert.ok(labels.length >= 2, `${code} ${zoom} ${width}`);
          const fmt = new Intl.DateTimeFormat(code, { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
          let right = -8;
          for (const tick of labels) {
            assert.equal(tick.label, fmt.format(new Date(billing.parseDay(tick.d))));
            // 独立用 11px 字体较保守的实际文字占宽验算。
            const size = Array.from(tick.label).reduce((n, c) => n + (c.codePointAt(0)! > 0x024f ? 11 : 7), 0);
            const left = tick.labelX - size / 2;
            assert.ok(left >= right + 8 && left >= 0, `${code} ${zoom} ${width}: ${tick.label}`);
            right = tick.labelX + size / 2;
            assert.ok(right <= width);
          }
        }
      }
    }
  }
  assert.deepEqual(gantt.ganttTicks('3m', '2026-01-01', '2026-04-01', 0, 'en'), []);
});

type Element = { type: string; props: Record<string, any>; children: unknown[] };
const all = (node: unknown): Element[] => {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== 'object' || !('type' in node)) return [];
  const el = node as Element;
  return [el, ...all(el.children)];
};

// 与现有 ui-contracts 相同：执行真实组件和事件，只替换 React 宿主，不启动浏览器。
function mount(rawZoom?: string, width = 214, today = '2026-10-21') {
  const values: any[] = [];
  let cursor = 0;
  const prefs: Record<string, string | null | undefined> = { 'gantt-zoom': rawZoom };
  const prefCalls: Array<{ key: string; fallback: string; valid: (v: string) => boolean }> = [];
  const pendingEffects: Array<() => void> = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const timers = new Map<number, () => void>();
  let timerId = 0;
  // 动画帧：随渲染循环一起冲刷，模拟浏览器在下一帧执行
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const shift: { value?: string; classes: Set<string> } = { classes: new Set() };
  let opened = 0;
  let changed = false;
  const env = { narrow: false, portrait: false, containerWidth: 1000, textScale: 7 };
  const fontListeners = new Map<string, () => void>();
  let fontReady = () => {};
  const fontsReady = new Promise<void>((resolve) => {
    fontReady = resolve;
  });
  let resized = () => {};
  const effect = (fn: () => (() => void) | void, deps?: unknown[]) => {
    const i = cursor++;
    const prev = values[i];
    if (!prev || !deps || deps.some((v, n) => !Object.is(v, prev.deps[n]))) {
      prev?.cleanup?.();
      values[i] = { deps };
      pendingEffects.push(() => (values[i].cleanup = fn()));
    }
  };
  const useState = (initial: unknown) => {
    const i = cursor++;
    if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
    return [
      values[i],
      (v: any) => {
        const next = typeof v === 'function' ? v(values[i]) : v;
        if (!Object.is(values[i], next)) changed = true;
        values[i] = next;
      },
    ];
  };
  const useRef = (current: unknown) => useState({ current })[0];
  const deps = {
    ...billing,
    ...transfers,
    ...format,
    ...gantt,
    t,
    intlLocale,
    React: { createElement: (type: string, props: object, ...children: unknown[]) => ({ type, props: props ?? {}, children }) },
    Fragment: 'Fragment',
    useState,
    useRef,
    useMemo: (fn: () => unknown) => fn(),
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    matchMedia: (query: string) => ({ matches: query.includes('portrait') ? env.narrow && env.portrait : query.includes('700px') && env.narrow }),
    // ui.tsx useMedia：与上面的 matchMedia 同一套断点
    useMedia: (query: string) => (query.includes('portrait') ? env.narrow && env.portrait : query.includes('700px') && env.narrow),
    getComputedStyle: () => ({ paddingLeft: env.narrow ? '12px' : '16px', paddingRight: '12px', columnGap: '8px' }),
    ResizeObserver: class {
      constructor(fn: () => void) {
        resized = fn;
      }
      observe() {}
      disconnect() {}
    },
    document: {
      createElement: () => {
        const probe = { style: {}, textContent: '', getBoundingClientRect: () => ({ width: [...probe.textContent].length * env.textScale }), remove() {} };
        return probe;
      },
      fonts: {
        ready: fontsReady,
        addEventListener: (event: string, fn: () => void) => fontListeners.set(event, fn),
        removeEventListener: (event: string) => fontListeners.delete(event),
      },
    },
    useEffectEvent: (fn: (...args: unknown[]) => unknown) => {
      const ref = useRef(fn);
      ref.current = fn;
      return (...args: unknown[]) => ref.current(...args);
    },
    usePref: (key: string, fallback: string, valid: (v: string) => boolean) => {
      prefCalls.push({ key, fallback, valid });
      const raw = prefs[key];
      return [raw != null && valid(raw) ? raw : fallback, (v: string | null) => (prefs[key] = v)];
    },
    FlagImg: 'FlagImg',
    Icon: 'Icon',
    IconButton: 'button',
    CardTitle: 'h3',
    Seg: 'Seg',
    SubIcon: 'SubIcon',
    TailName: 'TailName',
    useWidth: () => [null, width],
    useSnapshotRender: () => {},
    perLabel: () => 'mo',
    stopDescription: () => '',
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: () => void) => (frames.set(++frameId, fn), frameId),
    cancelAnimationFrame: (id: number) => frames.delete(id),
    window: { setTimeout: (fn: () => void) => (timers.set(++timerId, fn), timerId) },
  };
  const source = read('../app/src/views/Gantt.tsx').replace(/^import[\s\S]*?;\n/gm, '');
  const result = transformSync('Gantt.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const Gantt = new Function(...Object.keys(deps), `${result.code.replace('export function Gantt', 'function Gantt')}; return Gantt;`)(...Object.values(deps));
  const sub: Subscription = {
    id: 'monthly',
    name: 'Monthly',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-01',
    status: 'active',
  };
  const render = (rows: Subscription[] = [sub]) => {
    let nodes: Element[] = [];
    let passes = 0;
    do {
      assert.ok(++passes < 10, 'layout effects must settle');
      changed = false;
      cursor = 0;
      nodes = all(
        Gantt({ rows, today, state: { subscriptions: rows, methods: [], fx: billing.FALLBACK_FX, settings: DEFAULT_SETTINGS }, onOpen: () => opened++ }),
      );
      const track = nodes.find((el) => el.type === 'div' && el.props.className?.split(' ').includes('gt'))!;
      track.props.ref.current = {
        get clientWidth() {
          return env.containerWidth;
        },
        querySelector: () => ({ appendChild() {}, getBoundingClientRect: () => ({ width: parseFloat(track.props.style['--lw']) }) }),
        addEventListener: (name: string, fn: (event: unknown) => void) => (listeners[name] = fn),
        removeEventListener: (name: string) => delete listeners[name],
        style: { setProperty: (_name: string, value: string) => (shift.value = value) },
        classList: { add: (...c: string[]) => c.forEach((x) => shift.classes.add(x)), remove: (...c: string[]) => c.forEach((x) => shift.classes.delete(x)) },
      };
      pendingEffects.splice(0).forEach((fn) => fn());
      if (!changed && !pendingEffects.length) {
        const due = [...frames.values()];
        frames.clear();
        due.forEach((fn) => fn());
      }
    } while (changed || frames.size);
    return nodes;
  };
  return {
    render,
    prefs,
    prefCalls,
    listeners,
    timers,
    shift,
    sub,
    env,
    fontReady: () => fontReady(),
    fontDone: () => fontListeners.get('loadingdone')?.(),
    resize: () => resized(),
    opened: () => opened,
  };
}

test('真实时间轴的默认/旧偏好回退为 1 年，五档按顺序保存且翻页、拖动、滚轮可用', () => {
  setLocale('en', [flatten('list', JSON.parse(read('./locales/en/list.json')))]);
  for (const raw of [undefined, 'year', 'unknown', '3m', '6m', '1y', '3y', 'all']) {
    const host = mount(raw);
    const range = host.render().find((el) => el.type === 'Seg')!;
    assert.equal(host.prefCalls[0].fallback, '1y');
    assert.equal(host.prefCalls[0].valid('year'), false);
    assert.equal(host.prefCalls[0].valid('unknown'), false);
    assert.equal(range.props.value, raw && gantt.isGanttZoom(raw) ? raw : '1y');
    assert.deepEqual(range.props.options, [
      ['3m', '3M'],
      ['6m', '6M'],
      ['1y', '1Y'],
      ['3y', '3Y'],
      ['all', 'All'],
    ]);
  }
  for (const zoom of ['3m', '6m', '1y', '3y'] as const) {
    const host = mount(zoom);
    const find = (cls: string) => host.render().find((el) => el.props.className?.split(' ').includes(cls))!;
    let nodes = host.render();
    nodes.find((el) => el.props['aria-label'] === 'Later')!.props.onClick();
    assert.ok(find('gt-range').props.className.includes('moved'));
    const todayLine = host.render().find((el) => el.props.className === 'gt-today');
    assert.ok(!todayLine || todayLine.props.style.left <= 0 || todayLine.props.style.left >= 214, '翻到未来后今天线在可视区外');
    assert.ok(
      host.render().some((el) => el.props.className?.startsWith('gt-seg ')),
      '持续订阅翻到未来仍有条段',
    );
    nodes = host.render();
    nodes.find((el) => el.props['aria-label'] === 'Earlier')!.props.onClick();
    assert.ok(!find('gt-range').props.className.includes('moved'));
    const track = find('gt');
    track.props.onPointerDown({ button: 0, clientX: 100 });
    track.props.onPointerMove({ clientX: 10, pointerId: 1, currentTarget: { setPointerCapture() {} } });
    find('gt').props.onPointerUp();
    assert.ok(find('gt-range').props.className.includes('moved'));
    find('gt-row').props.onClick();
    assert.equal(host.opened(), 0, '拖动不会打开详情');
    find('gt-range').props.onClick();
    let prevented = false;
    host.listeners.wheel({ deltaX: 90, deltaY: 0, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    assert.equal(host.timers.size, 1);
    const range = host.render().find((el) => el.type === 'Seg')!;
    range.props.onChange('6m');
    assert.equal(host.prefs['gantt-zoom'], '6m');
    assert.equal(host.timers.size, 0, '切换范围取消旧的滚轮吸附');
    assert.ok(!find('gt-range').props.className.includes('moved'));
    host
      .render()
      .find((el) => el.type === 'Seg')!
      .props.onChange('all');
    assert.equal(
      host.render().some((el) => el.props.className === 'gt-nav'),
      false,
    );
    prevented = false;
    host.listeners.wheel({ deltaX: 90, deltaY: 0, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, '全部范围也要阻止浏览器横滑');
  }
});

test('短窗口在窄/宽轨道中绘出价格、扣款、试用、首期优惠和计划阶段', () => {
  for (const zoom of ['3m', '6m']) {
    for (const width of [214, 900]) {
      const host = mount(zoom, width);
      const trial = {
        ...host.sub,
        id: 'trial',
        start: '2026-10-01',
        trialEnd: '2026-11-01',
        status: 'trial' as const,
        priceHistory: [{ from: '2026-10-10', amount: 12 }],
      };
      const plan = { ...host.sub, id: 'planned', start: '2026-11-01', planned: true };
      const intro = { ...host.sub, id: 'intro', intro: { until: '2026-11-01', price: 5 } };
      const nodes = host.render([host.sub, trial, plan, intro]);
      const rows = nodes.filter((el) => el.props.className === 'gt-row');
      const monthly = all(rows[0]);
      assert.ok(
        monthly.some((el) => el.type === 'em'),
        `${zoom} ${width}: 价格`,
      );
      assert.ok(
        monthly.some((el) => el.props.className?.startsWith('gt-charge ')),
        `${zoom} ${width}: 扣款`,
      );
      const trialParts = all(rows[1]).filter((el) => el.props.className === 'gt-trial');
      // 宽轨道里调价切点单独成截，试用遮罩跨两截；窄轨道里不足一个正圆宽的那截并入相邻截，试用仍完整显示
      assert.ok(trialParts.length >= (width >= 900 ? 2 : 1), '试用跨过调价切点仍完整显示');
      assert.ok(trialParts.every((el) => el.props.style.width > 0 && el.props.style.width <= width));
      assert.ok(all(rows[2]).some((el) => el.props.className?.split(' ').includes('planned')));
      assert.ok(all(rows[3]).some((el) => el.props.className?.split(' ').includes('intro')));
      // 可平移时左右各多画一屏作缓冲：条段落在 [-width, 2·width] 内，且可视区里有条段
      const segs = nodes.filter((el) => el.props.className?.startsWith('gt-seg '));
      for (const el of segs) {
        assert.ok(Number.isFinite(el.props.style.left) && el.props.style.left >= -width && el.props.style.left <= 2 * width);
        assert.ok(el.props.style.width > 0 && el.props.style.left + el.props.style.width <= 2 * width + 0.001);
      }
      assert.ok(segs.some((el) => el.props.style.left < width && el.props.style.left + el.props.style.width > 0));
    }
  }
});

test('名称列测量：筛选与名称变化收敛旧偏好，字体加载、语言和容器变化重新测量', async () => {
  const host = mount();
  const long = { ...host.sub, name: 'W'.repeat(60) };
  const short = { ...host.sub, name: 'Wi' };
  const shortRows = [short];
  const width = (rows: Subscription[]) => host.render(rows).find((el) => el.props.className?.split(' ').includes('gt'))!.props.style['--lw'];
  const rows = [long, { ...short, id: 'short' }];
  assert.equal(width(rows), '200px');
  host.prefs['gantt-label-w'] = '999';
  assert.equal(width(rows), '476px', '上限可超过旧的固定 360px');
  assert.equal(width(shortRows), '70px', '筛掉最长行后按当前可见名称收敛');
  assert.equal(host.prefs['gantt-label-w'], '999', '显示收敛不覆盖原偏好');
  host.env.textScale = 10;
  await host.fontReady();
  assert.equal(width(shortRows), '76px');
  host.env.textScale = 12;
  host.fontDone();
  assert.equal(width(shortRows), '80px');
  host.env.textScale = 13;
  setLocale('zh-CN', [flatten('list', JSON.parse(read('./locales/zh-CN/list.json')))]);
  assert.equal(width(shortRows), '82px');
  setLocale('en', [flatten('list', JSON.parse(read('./locales/en/list.json')))]);
  assert.equal(width(rows), '500px');
  host.env.containerWidth = 300;
  host.resize();
  assert.equal(width(rows), '150px', '容器收窄时限制为一半');
});

test('名称列交互：拖到图标最小值隐藏名称、保留可访问名称，拖动保存并可双击恢复', () => {
  const host = mount();
  const find = (cls: string) => host.render().find((el) => el.props.className?.split(' ').includes(cls))!;
  const pointer = (clientX: number) => ({ clientX, pointerId: 1, stopPropagation() {}, currentTarget: { setPointerCapture() {} } });
  assert.equal(find('gt').props.style['--lw'], '105px');
  find('gt-resize').props.onPointerDown(pointer(100));
  find('gt-resize').props.onPointerMove(pointer(-1000));
  assert.equal(find('gt').props.style['--lw'], '48px');
  assert.ok(find('gt').props.className.includes('resizing'));
  assert.equal(host.render().filter((el) => el.props.className === 'gt-name').length, 0);
  const icon = find('gt-icon');
  assert.equal(icon.props.title, host.sub.name);
  assert.equal(icon.props['aria-label'], host.sub.name);
  assert.equal(icon.props.role, 'img');
  find('gt-resize').props.onPointerUp(pointer(-1000));
  assert.equal(host.prefs['gantt-label-w'], '48');
  assert.ok(!find('gt').props.className.includes('resizing'));
  find('gt-resize').props.onDoubleClick();
  assert.equal(host.prefs['gantt-label-w'], null);
  assert.equal(find('gt').props.style['--lw'], '105px');
  assert.equal(find('gt-name').props.name, host.sub.name);
  find('gt-resize').props.onPointerDown(pointer(100));
  find('gt-resize').props.onPointerMove(pointer(1000));
  assert.equal(find('gt').props.style['--lw'], '105px', '拖动不可超过最长名称');
  find('gt-resize').props.onPointerUp(pointer(1000));
  assert.equal(host.prefs['gantt-label-w'], '105');
});

test('手机竖屏不渲染名称和拖拽线，整行打开详情，横屏恢复单独保存的宽度', () => {
  const host = mount();
  host.env.narrow = true;
  host.env.portrait = true;
  host.prefs['gantt-label-w-m'] = '80';
  host.prefs['gantt-label-w'] = '150';
  const find = (cls: string) => host.render().find((el) => el.props.className?.split(' ').includes(cls));
  assert.equal(find('gt')!.props.style['--lw'], '44px');
  assert.equal(find('gt-name'), undefined);
  assert.equal(find('gt-resize'), undefined);
  assert.equal(host.render().find((el) => el.props.className === 'gt-label' && el.props.title)?.props.title, host.sub.name);
  assert.equal(find('gt-icon')!.props.title, host.sub.name);
  host
    .render()
    .find((el) => el.props.className === 'gt-row')!
    .props.onClick();
  assert.equal(host.opened(), 1);
  host.env.portrait = false;
  assert.equal(find('gt')!.props.style['--lw'], '80px');
  assert.ok(find('gt-resize'));
  assert.equal(find('gt-name')!.props.name, host.sub.name);
  host.prefs['gantt-label-w-m'] = '44';
  assert.equal(find('gt-name'), undefined, '横屏也可拖到只剩图标');
  find('gt-resize')!.props.onDoubleClick();
  assert.equal(find('gt')!.props.style['--lw'], '101px', '窄屏默认按名称计算');
  assert.equal(host.prefs['gantt-label-w'], '150');
  host.env.narrow = false;
  assert.equal(find('gt')!.props.style['--lw'], '105px', '桌面偏好按上限显示');
  assert.equal(host.prefs['gantt-label-w'], '150');
});

test('时间轴横滑在零宽度和全部范围仍被拦截，纵滑与等量斜滑始终放行', () => {
  for (const zoom of ['1y', 'all']) {
    for (const width of [0, 214]) {
      const host = mount(zoom, width);
      host.render();
      for (const [deltaX, deltaY, expected] of [
        [90, 0, true],
        [-90, 2, true],
        [2, 90, false],
        [0, -90, false],
        [40, 40, false],
      ] as const) {
        let prevented = false;
        host.listeners.wheel({ deltaX, deltaY, preventDefault: () => (prevented = true) });
        assert.equal(prevented, expected, `${zoom} ${width} ${deltaX}/${deltaY}`);
      }
      if (width === 0 || zoom === 'all') assert.equal(host.timers.size, 0);
    }
  }
});

test('横滑与拖动在手势中只写位移变量，停下后才提交窗口并恢复过渡', () => {
  setLocale('en', [flatten('list', JSON.parse(read('./locales/en/list.json')))]);
  const host = mount('1y', 600);
  const find = () => host.render().find((el) => el.props.className?.split(' ').includes('gt-range'))!;
  const before = find().children.join('');
  for (let i = 0; i < 5; i++) host.listeners.wheel({ deltaX: 20, deltaY: 0, preventDefault() {} });
  host.render();
  assert.equal(find().children.join(''), before, '手势中不重算窗口');
  assert.equal(host.shift.value, '-100px');
  assert.ok(host.shift.classes.has('panning'), '手势中关闭位置过渡');
  [...host.timers.values()].forEach((fn) => fn());
  const after = find();
  assert.notEqual(after.children.join(''), before);
  assert.ok(after.props.className.includes('moved'));
  assert.equal(host.shift.value, '0px', '对齐到月份后无残余位移');
  assert.ok(!host.shift.classes.has('panning'));
});

test('没有结束日的订阅在时间轴上只画到下一期末尾，不铺满视窗', () => {
  const base = {
    id: 's',
    name: 'Fictional',
    category: 'tools',
    tags: [],
    price: 10,
    currency: 'USD',
    status: 'active' as const,
  };
  // 月付，每月 15 日扣款：今天 10-26，下一次扣款 11-15，覆盖到 12-15
  assert.equal(gantt.ganttOpenEnd({ ...base, cycle: { unit: 'month', every: 1 }, start: '2026-01-15' }, '2026-10-26'), '2026-12-15');
  // 年付：下一次扣款 2027-03-01，画到 2028-03-01，而不是视窗尽头
  assert.equal(gantt.ganttOpenEnd({ ...base, cycle: { unit: 'year', every: 1 }, start: '2024-03-01' }, '2026-10-26'), '2028-03-01');
  // 尚未开始：首扣即开始日，只画第一期
  assert.equal(gantt.ganttOpenEnd({ ...base, cycle: { unit: 'month', every: 1 }, start: '2026-11-20' }, '2026-10-26'), '2026-12-20');
});

test('时间轴每一截至少一个正圆宽，过近的切点不画成细竖线', () => {
  for (const zoom of ['3m', '1y', '3y']) {
    for (const width of [214, 900]) {
      const host = mount(zoom, width);
      // 开始两天后就调价、再过一周又调价：窄轨道里这些切点都不足一个条高
      const sub = {
        ...host.sub,
        id: 'close-cuts',
        start: '2026-09-01',
        priceHistory: [
          { from: '2026-09-03', amount: 11 },
          { from: '2026-09-10', amount: 12 },
        ],
      };
      const short = { ...host.sub, id: 'short', start: '2026-10-20', end: '2026-10-22' };
      const segs = all(host.render([sub, short])).filter((el) => el.props.className?.split(' ').includes('gt-seg'));
      assert.ok(segs.length > 0);
      for (const el of segs) assert.ok(el.props.style.width >= 22, `${zoom} ${width}: ${el.props.style.width}`);
    }
  }
});

test('不规则季付逐次按实际付款切分，局部窄间隔不吞掉整段，年付仍每年一截', () => {
  const dates = ['2017-10-30'];
  for (let year = 2018; year <= 2026; year++) {
    for (const md of ['01-24', '04-07', '07-13', '10-30']) {
      const date = `${year}-${md}`;
      if (date <= '2026-10-26') dates.push(date);
    }
  }
  for (const zoom of ['all', '3y']) {
    for (const width of [214, 900]) {
      const host = mount(zoom, width, '2026-10-26');
      const quarterly: Subscription = {
        ...host.sub,
        id: 'quarterly',
        start: dates[0],
        cycle: { unit: 'month', every: 3 },
        payments: dates.map((date) => ({ date, amount: 30 })),
        nextDue: '2026-10-30',
      };
      const annual: Subscription = { ...host.sub, id: 'annual', start: dates[0], cycle: { unit: 'year', every: 1 } };
      const rows = host.render([quarterly, annual]).filter((el) => el.props.className === 'gt-row');
      const segments = (row: Element) => all(row).filter((el) => el.props.className?.split(' ').includes('gt-seg'));
      const parts = segments(rows[0]);
      assert.ok(parts.length > 2, `${zoom} ${width}: irregular payments must produce multiple capsules, got ${parts.length}`);
      for (const row of rows) for (const part of segments(row)) assert.ok(part.props.style.width >= 22);
      if (zoom === 'all' && width === 900) {
        assert.equal(segments(rows[1]).length, 9, 'annual history keeps one capsule per drawable year');
        const window = gantt.ganttWindow('all', '2026-10-26', dates[0], gantt.ganttOpenEnd(annual, '2026-10-26'));
        const scale = width / billing.diffDays(window.start, window.end);
        const early = parts.find((part) => Math.abs(part.props.style.left - billing.diffDays(window.start, '2018-01-24') * scale) < 0.001);
        assert.ok(early, 'a wide renewal cut survives even when the following 73-day interval is narrow');
      }
    }
  }
});

test('短窗口只合并价格所需切点，同价仍只标一次且保留其余周期胶囊', () => {
  for (const zoom of ['3m', '6m']) {
    const host = mount(zoom, 214, '2026-10-26');
    const nodes = host.render([{ ...host.sub, start: '2026-01-01' }]);
    const parts = nodes.filter((el) => el.props.className?.split(' ').includes('gt-seg'));
    assert.ok(parts.length > 2, `${zoom}: merging for a label must not remove all renewal cuts`);
    assert.equal(nodes.filter((el) => el.type === 'em').length, 1, `${zoom}: one price per unchanged run`);
    assert.ok(parts.every((part) => part.props.style.width >= 22));
  }
});

test('零元预算的月付导入记录在最后一次非零付款之后仍按月分段，付款与着色不变', () => {
  const today = '2026-11-09';
  const host = mount('1y', 900, today);
  const sub: Subscription = {
    ...host.sub,
    id: 'fictional-zero-utility',
    start: '2025-10-01',
    price: 0,
    billing: 'postpaid',
    estimateFrom: '2026-12-01',
    nextDue: '2026-12-01',
    payments: ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((date) => ({
      date,
      amount: 10,
    })),
  };
  const original = JSON.stringify(sub);
  const history = JSON.stringify(billing.chargesBetween(sub, sub.start, today, today));
  const parts = host.render([sub]).filter((el) => el.props.className?.split(' ').includes('gt-seg'));
  const range = gantt.ganttWindow('1y', today);
  const scale = 900 / billing.diffDays(range.start, range.end);
  for (const date of ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']) {
    const part = parts.find((el) => Math.abs(el.props.style.left - billing.diffDays(range.start, date) * scale) < 0.001);
    assert.ok(part, `zero-price cycle boundary ${date} must split the long capsule`);
    assert.equal(part.props.style['--now'], '0px', 'splitting does not claim payment coverage');
  }
  assert.equal(gantt.ganttPaidUntil(sub, sub.start, today), '2026-06-01');
  assert.equal(JSON.stringify(sub), original, 'rendering must not change subscription records');
  assert.equal(JSON.stringify(billing.chargesBetween(sub, sub.start, today, today)), history, 'no charges are created by display cuts');
});

test('明确记录的零元账期也分段，但失败扣款、退款和补差不增加零元分段', () => {
  const today = '2026-11-09';
  const host = mount('1y', 900, today);
  const sub: Subscription = {
    ...host.sub,
    start: '2026-01-01',
    estimateFrom: '2026-12-01',
    nextDue: '2026-12-01',
    payments: [
      { date: '2026-06-01', amount: 10 },
      { date: '2026-07-01', amount: 0 },
      { date: '2026-08-01', amount: 0, kind: 'failed' },
      { date: '2026-09-01', amount: 0, kind: 'refund' },
      { date: '2026-10-01', amount: 0, kind: 'adjust' },
    ],
  };
  const parts = host.render([sub]).filter((el) => el.props.className?.split(' ').includes('gt-seg'));
  const range = gantt.ganttWindow('1y', today);
  const scale = 900 / billing.diffDays(range.start, range.end);
  const hasCut = (date: string) => parts.some((el) => Math.abs(el.props.style.left - billing.diffDays(range.start, date) * scale) < 0.001);
  assert.equal(hasCut('2026-07-01'), true);
  for (const date of ['2026-08-01', '2026-09-01', '2026-10-01']) assert.equal(hasCut(date), false, date);
});

test('零元预算不在已有晚付账单的同一账期额外插入月初切点', () => {
  const today = '2026-11-09';
  const host = mount('1y', 900, today);
  const sub: Subscription = {
    ...host.sub,
    start: '2026-01-01',
    price: 0,
    billing: 'postpaid',
    estimateFrom: '2026-12-15',
    nextDue: '2026-12-15',
    payments: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'].map((date) => ({ date, amount: 10 })),
  };
  const parts = host.render([sub]).filter((el) => el.props.className?.split(' ').includes('gt-seg'));
  const range = gantt.ganttWindow('1y', today);
  const scale = 900 / billing.diffDays(range.start, range.end);
  const hasCut = (date: string) => parts.some((el) => Math.abs(el.props.style.left - billing.diffDays(range.start, date) * scale) < 0.001);
  for (const month of ['02', '03', '04', '05', '06']) {
    assert.equal(hasCut(`2026-${month}-15`), true, 'actual payment date is preserved');
    assert.equal(hasCut(`2026-${month}-01`), false, 'same service period must not get a synthetic second cut');
  }
  assert.equal(hasCut('2026-07-01'), true, 'later zero-price periods still split');
});

test('all-history scope distinguishes ended service from future unused paid coverage', () => {
  assert.deepEqual(Reflect.apply(gantt.ganttWindow, null, ['all', '2026-10-19', '2026-10-05', '2026-11-04', false]), {
    start: '2026-10-01',
    end: '2026-12-01',
  });
  assert.deepEqual(Reflect.apply(gantt.ganttWindow, null, ['all', '2026-10-19', '2026-01-01', '2026-10-10', true]), {
    start: '2026-01-01',
    end: '2026-10-26',
  });
});

test('订阅年表：画到结束或今天，未开始的不画，从最早一年的 1 月起', () => {
  const today = '2026-11-02';
  const sub = (over: Partial<Subscription>) =>
    ({
      id: 'a',
      name: 'Fiction',
      category: 'x',
      tags: [],
      price: 10,
      currency: 'USD',
      cycle: { unit: 'month', every: 1 },
      start: '2024-03-10',
      status: 'active',
      ...over,
    }) as Subscription;
  const { rows, start, end, ongoing } = gantt.yearsTimeline(
    [
      sub({ id: 'later', start: '2025-01-01' }),
      sub({ id: 'first' }),
      sub({ id: 'ended', start: '2024-05-01', end: '2024-09-01', status: 'cancelled' }),
      sub({ id: 'ending', start: '2024-06-01', end: '2027-01-01' }),
      sub({ id: 'terminated', start: '2024-07-01', stop: { kind: 'terminate', date: '2025-02-01', paidThrough: '2025-03-01' } }),
      sub({ id: 'paused', start: '2024-08-01', status: 'paused', pausedAt: '2025-04-01' }),
      sub({ id: 'future', start: '2027-01-01' }),
      sub({ id: 'once', start: '2024-10-01', cycle: { unit: 'lifetime', every: 1 } }),
    ],
    today,
  );
  const at = (id: string) => rows.find((r) => r.s.id === id)!.bars[0];
  assert.deepEqual(
    rows.map((r) => r.s.id),
    ['first', 'ended', 'ending', 'terminated', 'paused', 'once', 'later'],
    '按开始日排，未开始的不画',
  );
  assert.equal(start, '2024-01-01');
  assert.ok(end > today);
  assert.equal(ongoing, true);
  assert.deepEqual([at('first').to, at('first').ongoing], [today, true]);
  assert.deepEqual([at('ended').to, at('ended').ongoing], ['2024-09-01', false]);
  assert.deepEqual([at('ending').to, at('ending').ongoing], [today, true], '结束日在未来：只画到今天');
  assert.deepEqual([at('terminated').to, at('terminated').ongoing], ['2025-02-01', false]);
  assert.deepEqual([at('paused').to, at('paused').ongoing], ['2025-04-01', false]);
  assert.deepEqual([at('once').from, at('once').to, at('once').ongoing], ['2024-10-01', '2024-10-01', false], '买断是一个购买点');
  assert.deepEqual(gantt.yearsTimeline([sub({ start: '2027-01-01' })], today).rows, []);
});

test('订阅年表：同一订阅的断订和并行阶段', () => {
  const today = '2026-11-02';
  const phase = (start: string, end?: string) => ({ start, end, price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const row = (phases: unknown[]) =>
    gantt.yearsTimeline(
      [
        {
          id: 'a',
          name: 'Fiction',
          category: 'x',
          tags: [],
          price: 10,
          currency: 'USD',
          cycle: { unit: 'month', every: 1 },
          start: '2024-01-01',
          status: 'active',
          phases,
        } as unknown as Subscription,
      ],
      today,
    ).rows[0];
  const gap = row([phase('2024-01-01', '2024-06-01'), phase('2025-01-01')]);
  assert.deepEqual(gap.gaps, [{ from: '2024-06-01', to: '2025-01-01' }]);
  assert.equal(gap.lanes, 1);
  const parallel = row([phase('2024-01-01', '2025-06-01'), phase('2025-01-01')]);
  assert.deepEqual(parallel.gaps, []);
  assert.equal(parallel.lanes, 2);
  assert.deepEqual(
    parallel.bars.map((b) => b.lane),
    [0, 1],
  );
  assert.equal(row([phase('2024-01-01'), phase('2030-01-01')]).bars.length, 1, '还没开始的阶段不画');
});

test('订阅年表的时间轴至少有一个年份刻度', () => {
  const today = '2026-11-02';
  const { start, end } = gantt.yearsTimeline(
    [
      {
        id: 'a',
        name: 'Fiction',
        category: 'x',
        tags: [],
        price: 10,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        start: '2026-10-01',
        status: 'active',
      } as Subscription,
    ],
    today,
  );
  setLocale('en', []);
  const ticks = gantt.ganttTicks('all', start, end, 300, intlLocale());
  assert.deepEqual(
    ticks.filter((tk) => tk.label).map((tk) => tk.label),
    ['2026'],
  );
});

test('用户反馈回归：时间线按付款着色，当天付过款的首期整期深色', () => {
  const s: Subscription = {
    id: 'g',
    name: 'G',
    category: '工具',
    tags: [],
    price: 200,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-11-07',
    status: 'active',
  };
  const at = (v: Subscription, today: string, from = v.start) => gantt.ganttPaidUntil(v, from, today);
  // 今天开始并已扣款：深色画到下次扣款日；期中不变；续费当天已扣：延到再下一次
  assert.equal(at(s, '2026-11-07'), '2026-12-07');
  assert.equal(at(s, '2026-11-20'), '2026-12-07');
  assert.equal(at(s, '2026-12-07'), '2027-01-07');
  // 还没开始的阶段整段浅色
  assert.equal(at({ ...s, start: '2026-12-01' }, '2026-11-07'), '2026-12-01');
  // 审查回归：后付费的账单结清上一期，当期浅色；首期还没出账整段浅色
  const post: Subscription = { ...s, start: '2026-09-10', billing: 'postpaid' };
  assert.equal(at(post, '2026-11-07'), '2026-10-10');
  assert.equal(at({ ...post, start: '2026-11-01' }, '2026-11-07'), '2026-11-01');
  // 审查回归：暂停后不再扣款，深色停在最后一期付到的地方
  const paused: Subscription = { ...s, start: '2026-09-10', status: 'paused', pausedAt: '2026-10-20' };
  assert.equal(at(paused, '2026-11-20'), '2026-11-10');
  // 审查回归：免费订阅没有付款，照旧按今天分界
  assert.equal(at({ ...s, price: 0 }, '2026-11-20'), '2026-11-20');
});

test('图例只列可见窗口里实际画出的标记，颜色、公开页与缓冲区都按画面判断', () => {
  const v = (over: Partial<Subscription>): Subscription => ({
    id: 'x',
    name: 'X',
    category: 'Tools',
    tags: [],
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2025-01-01',
    status: 'active',
    ...over,
  });
  const today = '2026-06-15';
  const start = '2026-03-01';
  const end = '2026-07-01';
  const seg = (s: Subscription, to = s.end) => ({ v: s, from: s.start, to: to ?? '2026-12-15', open: !to });
  const marks = (rows: gantt.GanttLegendRow[], readonly = false, compact = false) =>
    gantt.ganttLegendMarks(rows, start, end, today, { readonly, compact, keyOf: (s) => s.methodId ?? 'none' });
  const summary = (m: ReturnType<typeof marks>) => [m.unused, m.terminate, m.planned, m.gap, [...m.colors]];

  const plain = { segs: [seg(v({ methodId: 'cmb' }))], gaps: [] };
  assert.deepEqual(summary(marks([plain])), [false, false, false, false, ['cmb']]);

  // 窗口外的段：图例不列它的颜色，紧贴窗口右缘开始的也算窗口外
  const old = { segs: [seg(v({ methodId: 'old', start: '2024-01-01', end: '2024-06-01' }))], gaps: [] };
  const later = { segs: [seg(v({ methodId: 'later', start: end }))], gaps: [] };
  assert.deepEqual(summary(marks([plain, old, later])), [false, false, false, false, ['cmb']]);

  // 断订：只有落在窗口内才列，窗口外（包括平移缓冲区）不列
  assert.equal(marks([{ ...plain, gaps: [{ from: '2026-04-01', to: '2026-05-01' }] }]).gap, true);
  assert.equal(marks([{ ...plain, gaps: [{ from: '2026-02-01', to: start }] }]).gap, false);

  // 计划中只看窗口内的段；买断画成圆点，不算斜纹
  assert.equal(marks([{ segs: [seg(v({ planned: true, start: '2026-05-01' }))], gaps: [] }]).planned, true);
  assert.equal(marks([{ segs: [seg(v({ planned: true, start: '2026-09-01' }))], gaps: [] }]).planned, false);
  assert.equal(marks([{ segs: [seg(v({ planned: true, start: '2026-05-01', cycle: { unit: 'lifetime', every: 1 } }))], gaps: [] }]).planned, false);

  // 服务方停用与未退款段：窗口内才列；公开页不画未退款，图例也不列
  const stop = v({ status: 'terminated', start: '2026-01-01', end: '2026-04-10', stop: { kind: 'terminate', date: '2026-04-10', paidThrough: '2026-05-01' } });
  const stopped = { segs: [seg(stop)], gaps: [] };
  assert.deepEqual(summary(marks([stopped])).slice(0, 2), [true, true]);
  assert.deepEqual(summary(marks([stopped], true)).slice(0, 2), [false, true]);
  const stopOld = v({
    status: 'terminated',
    start: '2025-01-01',
    end: '2025-04-10',
    stop: { kind: 'terminate', date: '2025-04-10', paidThrough: '2025-05-01' },
  });
  assert.deepEqual(summary(marks([{ segs: [seg(stopOld)], gaps: [] }])), [false, false, false, false, []]);
});

test('图例按 marks 渲染，颜色下标沿用完整列表，窗口内没有标记时不留空白', () => {
  const source = read('../app/src/views/Gantt.tsx');
  assert.match(source, /ganttLegendMarks\(rows, start, end, today,/);
  assert.match(source, /\{legendShown && \(\s*<div className="gt-legend">/);
  assert.match(source, /keys\.map\(\s*\(key, i\) =>\s*legend\.colors\.has\(key\) &&/);
  assert.doesNotMatch(source, /keys\.filter\([^)]*legend/);
});

test('柱上账单：后付费归服务月，退款并入上一笔净额，失败和预测不算实际', () => {
  const today = '2026-11-09';
  const base: Subscription = {
    id: 'fictional-bill',
    name: 'Fictional bill',
    category: 'Tools',
    tags: [],
    price: 100,
    currency: 'CNY',
    cycle: { unit: 'month', every: 1 },
    start: '2026-08-01',
    status: 'active',
  };
  const postpaid: Subscription = {
    ...base,
    billing: 'postpaid',
    payments: [
      { date: '2026-09-01', amount: 165.4 },
      { date: '2026-09-03', amount: -15.4, kind: 'refund' },
      { date: '2026-10-01', amount: 0 },
      { date: '2026-11-01', amount: 615.8 },
    ],
  };
  const cuts = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'];
  assert.deepEqual(
    gantt.ganttCutBills(postpaid, cuts, today).map((b) => b.actual),
    [150, 0, 615.8, undefined],
  );
  // 窗口末段之后才出的账单仍属于最后一截
  assert.deepEqual(
    gantt.ganttCutBills(postpaid, ['2026-08-01', '2026-09-01', '2026-10-01'], today).map((b) => b.actual),
    [150, 0],
  );

  const prepaid: Subscription = {
    ...base,
    payments: [
      { date: '2026-08-01', amount: 80 },
      { date: '2026-09-01', amount: 0, kind: 'failed' },
      { date: '2026-10-01', amount: 90 },
      { date: '2026-10-05', amount: 12, kind: 'adjust' },
    ],
  };
  assert.deepEqual(
    gantt.ganttCutBills(prepaid, cuts, today).map((b) => b.actual),
    [80, undefined, 102, 100],
  );

  const merged = gantt.ganttCutBills(prepaid, ['2026-08-01', '2026-11-01'], today);
  assert.deepEqual(merged, [{ multiCycle: true }]);
});

test('柱上文字：实际金额取整不带单位，同额只标一次，窄到放不下就不标，合并多周期才带单位', () => {
  const today = '2026-11-09';
  const labels = (nodes: Element[]) =>
    nodes
      .filter((el) => el.type === 'em')
      .flatMap(all)
      .filter((el) => el.type === 'span')
      .map((el) => (el.children as unknown[]).join(''));
  const seg = (nodes: Element[]) => nodes.filter((el) => el.props.className?.split(' ').includes('gt-seg'));
  const payments = [
    { date: '2026-09-01', amount: 165.4 },
    { date: '2026-10-01', amount: 197.35 },
    { date: '2026-11-01', amount: 0.4 },
  ];
  const host = mount('1y', 1200, today);
  const sub: Subscription = { ...host.sub, id: 'fictional-usage', currency: 'CNY', start: '2026-08-01', price: 67.75, billing: 'postpaid', payments };
  const nodes = host.render([sub]);
  assert.deepEqual(
    labels(nodes)
      .slice(0, 3)
      .map((s) => s.replace(/[^\d.]/g, '')),
    ['165', '197', '0.40'],
  );
  assert.ok(
    labels(nodes).every((s) => !s.includes('/mo')),
    'one cut is one cycle: no unit on the bar',
  );
  const exact = seg(nodes).find((el) => el.props.title.includes('197.35'));
  assert.ok(exact, 'tooltip keeps the exact amount');

  // 相同金额只标一次（取整后相同也算）
  const flat = host.render([
    {
      ...sub,
      payments: payments
        .slice(0, 2)
        .map((p) => ({ ...p, amount: 165.4 }))
        .concat({ date: '2026-11-01', amount: 165.2 }),
    },
  ]);
  assert.equal(labels(flat).filter((s) => s.replace(/[^\d.]/g, '') === '165').length, 1);

  // 每截窄到放不下：不标文字，悬停提示仍在
  const tiny = mount('1y', 150, today);
  const narrow = tiny.render([{ ...sub, price: 1234567 }]);
  assert.equal(labels(narrow).length, 0);
  assert.ok(seg(narrow).every((el) => el.props.title));

  // 周付在短窗口被合并的一截：不是一个周期，保留单位
  const short = mount('6m', 214, '2026-10-26');
  const weekly = short.render([{ ...short.sub, start: '2026-01-01', cycle: { unit: 'week', every: 1 }, price: 1234 }]);
  assert.ok(
    labels(weekly).some((s) => s.endsWith('/mo')),
    `merged cut keeps its unit: ${labels(weekly)}`,
  );
});

test('柱上账单边界：窗口后的退款计入净额，浮点残差归零，半周期外的两笔算多周期', () => {
  const today = '2026-11-09';
  const base: Subscription = {
    id: 'fictional-edge',
    name: 'Fictional edge',
    category: 'Tools',
    tags: [],
    price: 100,
    currency: 'CNY',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-01',
    status: 'active',
  };
  assert.deepEqual(
    gantt.ganttCutBills(
      {
        ...base,
        payments: [
          { date: '2026-10-01', amount: 100 },
          { date: '2026-10-20', amount: -100, kind: 'refund' },
        ],
      },
      ['2026-10-01', '2026-10-15'],
      today,
    ),
    [{ actual: 0, multiCycle: false }],
  );
  const [residual] = gantt.ganttCutBills(
    {
      ...base,
      payments: [
        { date: '2026-10-01', amount: 100.1 },
        { date: '2026-10-05', amount: -33.37, kind: 'refund' },
        { date: '2026-10-06', amount: -66.73, kind: 'refund' },
      ],
    },
    ['2026-10-01', '2026-10-28'],
    today,
  );
  assert.equal(Object.is(residual.actual, 0), true);
  const two = {
    ...base,
    start: '2026-09-01',
    payments: [
      { date: '2026-09-01', amount: 100 },
      { date: '2026-10-01', amount: 100 },
    ],
  };
  assert.deepEqual(gantt.ganttCutBills(two, ['2026-09-01', '2026-10-05'], today), [{ multiCycle: true }]);
  // 同一周期内重复扣款仍是一期的合计
  const dup = {
    ...base,
    payments: [
      { date: '2026-10-01', amount: 100 },
      { date: '2026-10-02', amount: 100 },
    ],
  };
  assert.deepEqual(gantt.ganttCutBills(dup, ['2026-10-01', '2026-10-28'], today), [{ actual: 200, multiCycle: false }]);
});

test('柱上文字边界：并入的账单不相加，补差不切周期，试用不标金额，周付短窗口仍有文字', () => {
  const today = '2026-11-09';
  const texts = (nodes: Element[]) =>
    nodes
      .filter((el) => el.type === 'em')
      .flatMap(all)
      .filter((el) => el.type === 'span')
      .map((el) => (el.children as unknown[]).join(''));
  const segs = (nodes: Element[]) => nodes.filter((el) => el.props.className?.split(' ').includes('gt-seg'));
  const host = mount('1y', 1200, today);
  const sub: Subscription = { ...host.sub, id: 'fictional-edge', currency: 'CNY', price: 100, start: '2026-09-01' };

  const merged = host.render([
    {
      ...sub,
      end: '2026-10-05',
      payments: [
        { date: '2026-09-01', amount: 100 },
        { date: '2026-10-01', amount: 100 },
      ],
    },
  ]);
  assert.ok(!texts(merged).some((s) => s.includes('200')), `two bills in a merged cut are not one amount: ${texts(merged)}`);

  const range = gantt.ganttWindow('1y', today);
  const scale = 1200 / billing.diffDays(range.start, range.end);
  const adjusted = segs(
    host.render([
      {
        ...sub,
        payments: [
          { date: '2026-09-01', amount: 100 },
          { date: '2026-10-01', amount: 90 },
          { date: '2026-10-15', amount: 12, kind: 'adjust' },
        ],
      },
    ]),
  );
  const october = adjusted.find((el) => el.props.title.includes('102'));
  assert.ok(october, 'adjustment joins its bill');
  assert.ok(october.props.style.width > 28 * scale, 'adjustment must not split the cycle');

  const trial = host.render([{ ...sub, start: '2026-08-01', trialEnd: '2026-09-01', payments: [{ date: '2026-09-01', amount: 77 }] }]);
  assert.equal(texts(trial)[0]?.replace(/[^\d.]/g, ''), '77', `past cut without a bill stays blank: ${texts(trial)}`);

  const short = mount('3m', 214, today);
  const weekly = texts(short.render([{ ...short.sub, start: '2026-09-01', cycle: { unit: 'week', every: 1 }, price: 10 }]));
  assert.ok(
    weekly.some((s) => s.endsWith('/mo')),
    `merged weekly bars keep a label: ${weekly}`,
  );
});

test('柱上账单：后付费待出账标记为 pending，提前付的首期归首截，暂停前的账单不串段', () => {
  const today = '2026-11-09';
  const base: Subscription = {
    id: 'fictional-pending',
    name: 'Fictional pending',
    category: 'Tools',
    tags: [],
    price: 100,
    currency: 'CNY',
    cycle: { unit: 'month', every: 1 },
    start: '2026-08-15',
    status: 'active',
  };
  const postpaid: Subscription = {
    ...base,
    billing: 'postpaid',
    end: '2026-11-05',
    payments: [
      { date: '2026-09-15', amount: 101 },
      { date: '2026-10-15', amount: 102 },
    ],
  };
  const bills = gantt.ganttCutBills(postpaid, ['2026-08-15', '2026-09-15', '2026-10-15', '2026-11-05'], today);
  assert.deepEqual(
    bills.map((b) => b.actual),
    [101, 102, undefined],
  );
  assert.equal(bills[2].pending, true);

  const early: Subscription = { ...base, start: '2026-09-01', payments: [{ date: '2026-08-29', amount: 300 }] };
  assert.equal(gantt.ganttCutBills(early, ['2026-09-01', '2026-09-29'], today)[0].actual, 300);

  const resumed: Subscription = { ...base, start: '2026-06-01', end: '2026-09-10', payments: [{ date: '2026-08-15', amount: 100 }] };
  assert.equal(gantt.ganttCutBills(resumed, ['2026-09-20', '2026-10-15'], today)[0].actual, undefined);
});

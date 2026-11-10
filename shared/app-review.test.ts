// 前端审查修复的回归测试：只测不依赖浏览器的纯函数与 store 行为
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cnDateFull } from './format.ts';
import { isDateField, proposalDay } from '../app/src/views/assistant-fields.ts';

test('助手草稿：只有日期字段按日期显示，category/status 等原样显示', () => {
  for (const k of ['date', 'end', 'at', 'until', 'from', 'expires', 'next_due', 'trial_end', 'paused_at', 'nextDue', 'trialEnd', 'collectFrom'])
    assert.equal(isDateField(k), true, k);
  for (const k of ['category', 'status', 'create_category', 'category_color', 'rate', 'name', 'start', 'amount']) assert.equal(isDateField(k), false, k);
  assert.equal(proposalDay('active'), 'active');
  assert.equal(proposalDay('Streaming'), 'Streaming');
  assert.equal(proposalDay('2026-03-04'), cnDateFull('2026-03-04'));
  assert.equal(proposalDay(undefined), undefined);
  assert.equal(proposalDay(''), undefined);
});

test('助手：读回本机会话时残留的 streaming 回复记为中断，可以重试', async () => {
  const { settleTurns } = await import('../app/src/views/assistant-fields.ts');
  const turns = settleTurns([
    { role: 'user', text: 'hi' },
    { role: 'assistant', status: 'done', parts: [] },
    { role: 'assistant', status: 'streaming', parts: [] },
  ] as Array<{ role: string; status?: string; error?: { kind: string; message: string } }>);
  assert.equal(turns[1].status, 'done');
  assert.equal(turns[2].status, 'error');
  assert.equal(turns[2].error?.kind, 'network');
});

test('子路径安装：本机键带安装前缀，旧的无前缀键只读兼容', async (t) => {
  const values = new Map<string, string>([['ledger:locale', 'de']]);
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) },
  });
  t.after(() => (prev ? Object.defineProperty(globalThis, 'localStorage', prev) : Reflect.deleteProperty(globalThis, 'localStorage')));
  // base.ts 读 import.meta.env.BASE_URL：用与 live-sync-store 相同的做法换成 /ledger
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.includes('/app/src/base.ts?subpath'))
        return {
          format: 'module-typescript',
          shortCircuit: true,
          source: readFileSync(new URL('../app/src/base.ts', import.meta.url), 'utf8').replace('import.meta.env.BASE_URL', "'/ledger/'"),
        };
      return next(url, ctx);
    },
  });
  t.after(() => hook.deregister());
  const { readStored, storageKey } = await import('../app/src/base.ts?subpath');
  assert.equal(storageKey('ledger:locale'), 'ledger:locale:/ledger');
  assert.equal(readStored('ledger:locale'), 'de');
  values.set('ledger:locale:/ledger', 'ja');
  assert.equal(readStored('ledger:locale'), 'ja');
});

test('备份导入的已知问题带类型，不靠比对翻译文案识别', async () => {
  const { ImportError, readImportBackup } = await import('./import-backup.ts');
  assert.throws(
    () => readImportBackup(new TextEncoder().encode('not a database'), () => ({ exec: () => [], close() {} })),
    (e) => e instanceof ImportError,
  );
});

test('视图合计：缺汇率不按 0 计，显示用合计为 NaN（金额显示「—」）', async (t) => {
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('/app/src/base.ts'))
        return {
          format: 'module-typescript',
          shortCircuit: true,
          source: readFileSync(new URL('../app/src/base.ts', import.meta.url), 'utf8').replace('import.meta.env.BASE_URL', "'/'"),
        };
      return next(url, ctx);
    },
  });
  t.after(() => hook.deregister());
  const { DEFAULT_SETTINGS } = await import('./types.ts');
  const { FALLBACK_FX, chargesBetween } = await import('./billing.ts');
  const { toBase, sumBase, sumBaseOrNaN, sortValue } = await import('../app/src/derive.ts');
  const sub = (id: string, currency: string) => ({
    id,
    name: id,
    category: 'Tools',
    tags: [],
    price: 10,
    currency,
    cycle: { unit: 'month' as const, every: 1 },
    start: '2026-01-01',
    status: 'active' as const,
    payments: [{ date: '2026-01-01', amount: 10 }],
  });
  const state = { subscriptions: [sub('a', 'USD'), sub('b', 'XCD')], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' }, fx: FALLBACK_FX };
  assert.equal(Number.isNaN(toBase(state, 10, 'XCD')), true);
  assert.equal(toBase(state, 10, 'USD'), 10);
  const charges = state.subscriptions.flatMap((s) => chargesBetween(s, '2026-01-01', '2026-01-01', '2026-01-02'));
  assert.equal(charges.length, 2);
  assert.equal(sumBase(state, charges), 10, '图表几何仍按 0 计');
  assert.equal(Number.isNaN(sumBaseOrNaN(state, charges)), true);
  assert.equal(sumBaseOrNaN(state, charges.slice(0, 1)), 10);
  assert.deepEqual([3, NaN, 5].sort((a, b) => sortValue(b) - sortValue(a)).map(String), ['5', '3', 'NaN']);
});

test('分类色板：色值与 CSS 一致，旧自定义色与渐变换到最近一格，浅深级都由同一色混出', async () => {
  const { swatch, tint } = await import('../app/src/derive.ts');
  const css = readFileSync(new URL('../app/src/design-tokens.css', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../app/src/derive.ts', import.meta.url), 'utf8');
  const palette = JSON.parse(/const PALETTE = (\[[^\]]+\])/.exec(src)![1].replaceAll("'", '"')) as string[];
  const families = JSON.parse(/const FAMILIES = (\[[^\]]+\])/.exec(src)![1].replaceAll("'", '"')) as string[];
  families.forEach((f, i) => assert.match(css, new RegExp(`--c${i + 1}: var\\(--${f}-9\\);`), `c${i + 1}`));
  // 色值取自 Radix 浅色 9 级，供旧自定义色换算
  const radix = readFileSync(new URL('../node_modules/@radix-ui/colors/indigo.css', import.meta.url), 'utf8');
  assert.match(radix, new RegExp(`--indigo-9: #${palette[0]};`, 'i'));
  assert.equal(palette.length, families.length);
  assert.equal(swatch('var(--c3)'), 'var(--c3)');
  assert.equal(swatch('#d9776f'), 'var(--c2)');
  assert.equal(swatch('#3e63dd'), 'var(--c1)');
  assert.equal(swatch('#e5484d'), 'var(--c2)');
  assert.equal(swatch('linear-gradient(135deg,#2fbf71,#0f7d55)'), 'var(--c4)');
  assert.equal(swatch('#888888'), 'var(--c9)');
  assert.equal(swatch(undefined), 'var(--c9)');
  assert.equal(tint('var(--c1)', 9), 'var(--c1)');
  assert.equal(tint('var(--c1)', 4), 'var(--indigo-4)');
  assert.equal(tint('var(--c10)', 11), 'var(--gold-11)');
  assert.equal(tint('var(--gray-9)', 7), 'var(--gray-7)');
  // 资金流向：未指定支付方式用灰色，不占色板
  const flow = readFileSync(new URL('../app/src/components/ReportCharts.tsx', import.meta.url), 'utf8');
  assert.match(flow, /key === OTHER \|\| !key\s*\? 'var\(--gray-9\)'/);
});

test('订阅地区卡：占比只标在图例里且每个地区都标，地球不再挂标签，缺汇率不标占比', () => {
  const src = readFileSync(new URL('../app/src/views/Report.tsx', import.meta.url), 'utf8');
  const card = src.slice(src.indexOf('function RegionCard('), src.indexOf('\n}\n', src.indexOf('function RegionCard(')));
  assert.match(card, /className="region-legend"/);
  assert.doesNotMatch(card, /stop-row/);
  assert.match(card, /rows\.every\(\(r\) => r\.total\.known && !r\.total\.incomplete\)/);
  assert.match(card, /if \(!known \|\| sum <= 0\) return '';/);
  assert.match(card, /pct < 1 \? '<1%'/);
  assert.doesNotMatch(card, /i < 5/);
  assert.match(card, /\{share\(r\) && <span className="num">\{share\(r\)\}<\/span>\}/);
  const globe = readFileSync(new URL('../app/src/components/Globe.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(globe, /globe-tag|tag\?: string/);
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.globe-tag/);
  assert.match(css, /\.tm-group > \.tm-cell:hover \{\n  background-color/);
});

test('河流图：层之间不留缝，指针下的层可命中并高亮，提示框标出该行', async () => {
  const src = readFileSync(new URL('../app/src/components/stream-geom.ts', import.meta.url), 'utf8');
  const charts = readFileSync(new URL('../app/src/components/charts.tsx', import.meta.url), 'utf8');
  // 每层铺到最底下一层的下沿、从上往下倒序画，相邻层之间不会漏出卡片底色
  assert.match(src, /line\(y1\[i\], false\)\}\$\{line\(y0\[0\], true\)\}Z/);
  assert.doesNotMatch(charts, /opacity=\{0\.85\}/);
  const { streamGeom } = await import('../app/src/components/stream-geom.ts');
  const cols = [
    new Map([
      ['A', 60],
      ['B', 40],
    ]),
    new Map([
      ['A', 60],
      ['B', 40],
    ]),
  ];
  const g = streamGeom(cols, 206, 200);
  const x = g.cx(0);
  // 中线在 100px；总高 100 映射到 184px：A 占下方 −50…10，B 占 10…50
  assert.equal(g.hit(x, 130).key, 'A');
  assert.equal(g.hit(x, 70).key, 'B');
  assert.equal(g.hit(x, 2).key, undefined);
  assert.equal(g.hit(g.cx(1), 130).col, 1);
  // 宽度取整造成指针越过右缘时仍按最后一段算，不跳回第一列
  const edge = streamGeom([new Map([['A', 100]]), new Map([['B', 100]])], 206, 200);
  assert.deepEqual(edge.hit(206.5, 150), { col: 1, key: 'B' });
  // 列间过渡带里插值出的细层：最近那列没有金额就不算命中
  const fade = streamGeom(
    [
      new Map([['A', 100]]),
      new Map([
        ['A', 100],
        ['B', 100],
      ]),
    ],
    206,
    200,
  );
  const keysAt = (x: number) => new Set(Array.from({ length: 200 }, (_, y) => fade.hit(x, y).key));
  assert.ok(!keysAt(fade.cx(0) + 40).has('B'));
  assert.ok(keysAt(fade.cx(1)).has('B'));
  const charts2 = readFileSync(new URL('../app/src/components/charts.tsx', import.meta.url), 'utf8');
  // 触摸点按仍弹提示框；切换视图清掉高亮；同列同层不重建提示框
  assert.match(charts2, /touchTap && p\.onMouseEnter\(e\)/);
  assert.match(charts2, /onPointerDown: streamMove/);
  assert.match(charts2, /matches\(':focus-visible'\) && p\.onFocus\(e\)/);
  assert.match(charts2, /if \(id === last\.current\) return;/);
  assert.match(charts2, /\[!!stream\],\n  \);/);
  const tip = readFileSync(new URL('../app/src/components/overlays.tsx', import.meta.url), 'utf8');
  assert.match(tip, /r\.hot \? 'tip-hot' : 'tip-dim'/);
  const ov = readFileSync(new URL('../app/src/views/Overview.tsx', import.meta.url), 'utf8');
  assert.match(ov, /onPointerEnter=\{\(e\) => e\.pointerType === 'mouse' && setHot\(k\)\}/);
});

test('变动瀑布图：上月末虚线参考线横贯到期末；报告卡标题不再挂口径说明 ⓘ', () => {
  const report = readFileSync(new URL('../app/src/views/Report.tsx', import.meta.url), 'utf8');
  assert.match(report, /'--wf-ref': String\(1 - y\(from\) \/ 100\)/);
  assert.match(report, /<em className="mv-wf-ref" aria-hidden \/>/);
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.mv-wf-ref \{[^}]*top: calc\(28px \+ 120px \* var\(--wf-ref\)\);[^}]*left: 0;\s*right: 0;[^}]*dashed/);
  assert.match(css, /\.mv-wf-ref \{[^}]*z-index: 0;/);
  assert.match(css, /\.mv-wf-plot \{[^}]*z-index: 1;/);
  const comp = readFileSync(new URL('../app/src/components/Composition.tsx', import.meta.url), 'utf8');
  for (const src of [report, comp]) {
    assert.doesNotMatch(src, /hint=\{t\(/);
    assert.doesNotMatch(src, /\bbasis(All|Year)?['"]/);
  }
});

test('柱线图：摊到每月的成本线与瀑布图参考线同为灰色虚线，不再描白边', () => {
  const charts = readFileSync(new URL('../app/src/components/charts.tsx', import.meta.url), 'utf8');
  const bl = charts.slice(charts.indexOf('export function BarLine('), charts.indexOf('export function niceTicks('));
  assert.match(bl, /stroke="var\(--label-3\)"\s+strokeWidth="1"\s+strokeDasharray="3 3"/);
  assert.doesNotMatch(bl, /stroke="var\(--card\)"/);
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  // 虚线画在柱子后面，暗色下浅色柱也不吞掉虚线
  assert.match(css, /\.bl-bars \{[^}]*z-index: 1;/);
  assert.match(css, /\.bl-line \{[^}]*z-index: 0;/);
  const report = readFileSync(new URL('../app/src/views/Report.tsx', import.meta.url), 'utf8');
  assert.match(report, /<i className="legend-dash" \/>/);
});

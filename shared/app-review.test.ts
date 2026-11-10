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
  palette.forEach((hex, i) => assert.match(css, new RegExp(`--c${i + 1}: #${hex};`), `c${i + 1}`));
  assert.equal(swatch('var(--c3)'), 'var(--c3)');
  assert.equal(swatch('#d9776f'), 'var(--c2)');
  assert.equal(swatch('#e5484d'), 'var(--c2)');
  assert.equal(swatch('linear-gradient(135deg,#2fbf71,#0f7d55)'), 'var(--c4)');
  assert.equal(swatch('#888888'), 'var(--c9)');
  assert.equal(swatch(undefined), 'var(--c9)');
  assert.equal(tint('var(--c1)', 9), 'var(--c1)');
  assert.match(tint('var(--c1)', 4), /color-mix\(in oklab, var\(--c1\) \d+%, var\(--card\)\)/);
  assert.match(tint('var(--c1)', 11), /color-mix\(in oklab, var\(--c1\) \d+%, var\(--gray-12\)\)/);
  // 资金流向：未指定支付方式用灰色，不占色板
  const flow = readFileSync(new URL('../app/src/components/ReportCharts.tsx', import.meta.url), 'utf8');
  assert.match(flow, /key === OTHER \|\| !key\s*\? 'var\(--gray-9\)'/);
});

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, type AppState } from './types.ts';
import { FALLBACK_FX } from './billing.ts';

// 应用模块读 Vite 的 import.meta.env；测试里只需要根目录安装的存储键
registerHooks({
  resolve(specifier, ctx, next) {
    if (specifier === './base.ts' && ctx.parentURL?.includes('/app/src/'))
      return { url: 'data:text/javascript,export const storageKey=(k)=>k;', shortCircuit: true };
    return next(specifier, ctx);
  },
});
const { configurePrefs } = await import('../app/src/prefs.ts');
const { createLedgerWrites } = await import('../app/src/ledger-writes.ts');

test('分类改名时订阅页保存的分类筛选跟着改名，无关改名不动', async () => {
  let state: AppState = { subscriptions: [], methods: [], settings: DEFAULT_SETTINGS, fx: FALLBACK_FX, prefs: { 'list-cat': 'Tools' } };
  const queued: Record<string, string | null>[] = [];
  configurePrefs({
    state: () => state,
    noteEdit() {},
    notify() {},
    replacePrefs: (prefs) => (state = { ...state, prefs }),
    queuePrefs: (patch) => queued.push(patch),
  });
  const write = async (_local: unknown, remote: () => Promise<unknown>) => remote();
  const w = createLedgerWrites({
    api: (async () => ({ settings: DEFAULT_SETTINGS, subscriptions: [] })) as never,
    getState: () => state,
    write: write as never,
  } as never);
  await w.saveCategories([], { Games: 'Fun' });
  assert.equal(state.prefs?.['list-cat'], 'Tools');
  assert.equal(queued.length, 0);
  await w.saveCategories([], { Tools: 'Software' });
  assert.equal(state.prefs?.['list-cat'], 'Software');
  assert.deepEqual(queued, [{ 'list-cat': 'Software' }]);
});

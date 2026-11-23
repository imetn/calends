import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const nav = [];
const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('/app/src/auth.ts')) return { format: 'module', source: `export const HANDOFF_KEY = 'calends.assistant.handoff';`, shortCircuit: true };
    if (url.endsWith('/app/src/router.ts')) return { format: 'module', source: `export function go(p) { globalThis.testNav.push(p); }`, shortCircuit: true };
    return next(url, ctx);
  },
});
globalThis.testNav = nav;
const { handoff, takeHandoff, cachedAssistantConfigured, loadAssistantConfigured, setAssistantConfigured } = await import('../app/src/handoff.ts');
hook.deregister();

function mockStorage({ quotaOnImages = false } = {}) {
  const store = new Map();
  nav.length = 0;
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (quotaOnImages && JSON.parse(v).images?.length) throw new Error('QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
  return store;
}

test('handoff preserves returnTo route and draft across navigation and quota fallback, and consumes once', () => {
  mockStorage();
  const draft = {
    id: 'draft-1',
    name: 'Spotify Family',
    category: 'Music',
    tags: [],
    price: 20,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-11-01',
    status: 'active',
    share: { role: 'owner', seats: 6, members: [] },
  };
  handoff('Spotify Family\n', ['data:image/jpeg;base64,AAA'], { route: 'family', draft });
  assert.deepEqual(nav, ['assistant']);

  const first = takeHandoff();
  assert.equal(first?.text, 'Spotify Family\n');
  assert.deepEqual(first?.images, ['data:image/jpeg;base64,AAA']);
  assert.deepEqual(first?.returnTo, { route: 'family', draft });
  assert.equal(takeHandoff(), null);

  // Quota overflow drops images but keeps text and returnTo so the back button still works
  mockStorage({ quotaOnImages: true });
  handoff('Big screenshot\n', ['data:image/jpeg;base64,HUGE'], { route: 'behalf', draft });
  assert.deepEqual(nav, ['assistant']);
  const fallback = takeHandoff();
  assert.equal(fallback?.text, 'Big screenshot\n');
  assert.deepEqual(fallback?.images, []);
  assert.deepEqual(fallback?.returnTo, { route: 'behalf', draft });
});

test('assistant configured status caches per session, updates on save/clear, and resets on sign-out', async () => {
  setAssistantConfigured(null);
  assert.equal(cachedAssistantConfigured(), null);

  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { configured: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', effort: 'low' };
  };
  const [a, b] = await Promise.all([loadAssistantConfigured(fetcher), loadAssistantConfigured(fetcher)]);
  assert.equal(a, false);
  assert.equal(b, false);
  assert.equal(calls, 1);

  // Cached hit does not refetch
  assert.equal(await loadAssistantConfigured(fetcher), false);
  assert.equal(calls, 1);

  // Saving key updates cache immediately; sign-out resets to null
  setAssistantConfigured(true);
  assert.equal(cachedAssistantConfigured(), true);
  setAssistantConfigured(null);
  assert.equal(cachedAssistantConfigured(), null);
});

test('editor and assistant UI contracts: back button lives in Toolbar.title (visible on mobile) and unconfigured state uses muted row', () => {
  const editor = readFileSync(new URL('../app/src/views/Editor.tsx', import.meta.url), 'utf8');
  const assistant = readFileSync(new URL('../app/src/views/Assistant.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');

  assert.match(editor, /className="ed-ai muted"/);
  assert.match(editor, /<ArrowUpRight/);
  assert.match(editor, /returnTo\s*=\s*\{\s*route:/);
  assert.match(assistant, /title=\{\s*returnTo\s*\?\s*\(\s*<span className="as-title-back">/s);
  assert.match(assistant, /<ArrowLeft size=\{16\} \/>/);
  assert.match(assistant, /ledger:add/);
  // Configured button no longer uses primary --ink fill (secondary navigation cue)
  assert.doesNotMatch(css.match(/\.ed-ai-go\s*\{[^}]*\}/)?.[0] ?? '', /var\(--ink\)/);
});

test('back from assistant keeps the local draft: returnTo carries the original form, not the edited one', () => {
  const editor = readFileSync(new URL('../app/src/views/Editor.tsx', import.meta.url), 'utf8');
  const assistant = readFileSync(new URL('../app/src/views/Assistant.tsx', import.meta.url), 'utf8');
  // 编辑后的 f 作为初始表单会让 dirty 为 false，关闭时删掉本地草稿；原始 sub 让草稿照常恢复
  assert.match(editor, /returnTo = \{ route: currentRoute\(\) \|\| 'overview', draft: sub \}/);
  // 是否已配置未知时不先显示「去配置」，避免已配置用户看到错误提示
  assert.match(editor, /isNew &&\s*aiReady !== null &&/);
  // 助手已新建或转去编辑后，不再提供回到旧草稿的返回
  assert.match(assistant, /if \(p\.tool === 'create_subscription'\) endHandoff\(\);/);
  assert.match(assistant, /endHandoff\(\);\s*window\.dispatchEvent\(new CustomEvent\('ledger:add', \{ detail: draft \}\)\);/);
  // 并清掉离开表单时留下的本地草稿，否则「编辑后添加」会被旧草稿盖掉
  assert.match(assistant, /if \(returnTo\) writeDraft\(draftKey\(true, ''\), undefined\);/);
  // 返回按钮改变顶栏高度：对齐历史分割线的测量随之重跑
  assert.match(assistant, /\[fill, past, chat\.id, atBottom, jump, !!returnTo\]/);
});

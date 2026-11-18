// 网页写入的版本绑定（审查 R3 P1-2 / P1-3）：If-Match 用草稿打开时冻结的版本，设置只发改动字段。只用虚构数据。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { FALLBACK_FX } from './billing.ts';

registerHooks({
  resolve(specifier, ctx, next) {
    if (specifier === './base.ts' && ctx.parentURL?.includes('/app/src/'))
      return { url: 'data:text/javascript,export const storageKey=(k)=>k;', shortCircuit: true };
    return next(specifier, ctx);
  },
});
const { createLedgerWrites } = await import('../app/src/ledger-writes.ts');

const SUB = (extra: Partial<Subscription> = {}): Subscription =>
  ({ id: 's1', name: 'Fictional Svc', price: 10, currency: 'USD', cycle: { unit: 'month' }, start: '2026-01-05', status: 'active', ...extra }) as Subscription;

/** 模拟 store：乐观写本地，请求成功后按 apply 换上服务器结果；api 记下每次请求 */
function harness(initial: Subscription[]) {
  let state: AppState = { subscriptions: initial, methods: [], settings: { ...DEFAULT_SETTINGS }, fx: FALLBACK_FX };
  const sent: Array<{ path: string; ifMatch?: string; body: Record<string, unknown> }> = [];
  let stamp = 0;
  const gates: Array<() => void> = [];
  let hold = false;
  const api = async (path: string, init: RequestInit) => {
    const body = (init.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const h = init.headers as Record<string, string> | undefined;
    sent.push({ path, ifMatch: h?.['if-match'] ? JSON.parse(h['if-match']) : undefined, body });
    if (hold) await new Promise<void>((r) => gates.push(r));
    if (path.startsWith('/api/subscriptions/')) return { ...body, updatedAt: `S${++stamp}` };
    return { ...state.settings, ...body };
  };
  const write = async (local: (s: AppState) => AppState, req: () => Promise<unknown>, apply?: (s: AppState, r: unknown) => AppState) => {
    state = local(state);
    const r = await req();
    if (apply) state = apply(state, r);
    return r;
  };
  const w = createLedgerWrites({
    api: api as never,
    getState: () => state,
    syncFx: async () => {},
    write: write as never,
    upsertById: <T extends { id: string }>(list: T[], x: T) => (list.some((y) => y.id === x.id) ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x]),
  } as never);
  return {
    w,
    sent,
    get state() {
      return state;
    },
    set state(s: AppState) {
      state = s;
    },
    hold(on: boolean) {
      hold = on;
      if (!on) gates.splice(0).forEach((g) => g());
    },
  };
}

test('R3 P1-2：后台同步刷新后，编辑开始时打开的旧草稿仍带打开时的版本（服务器据此 409），不取保存时的当前版本', async () => {
  const h = harness([SUB({ updatedAt: 'V1', notes: 'base' })]);
  const draft = { ...h.state.subscriptions[0], notes: 'old draft' }; // 编辑器打开时冻结 V1
  // 编辑期间同步拿到别处的新版本
  h.state = { ...h.state, subscriptions: [SUB({ updatedAt: 'V2', notes: 'from sync' })] };
  await h.w.saveSub(draft);
  assert.equal(h.sent[0].ifMatch, 'V1');
  assert.equal(h.sent[0].body.updatedAt, undefined);
});

test('R3 P1-2：记录已从本地消失（别处删除）时旧草稿仍带版本；新建与撤销本页删除不带', async () => {
  const h = harness([SUB({ updatedAt: 'V1' })]);
  const draft = { ...h.state.subscriptions[0], notes: 'x' };
  h.state = { ...h.state, subscriptions: [] };
  await h.w.saveSub(draft);
  assert.equal(h.sent[0].ifMatch, 'V1');
  await h.w.saveSub(SUB({ id: 's2' }));
  assert.equal(h.sent[1].ifMatch, undefined);
  // 撤销本页刚删的：删除后用原记录重建
  const h2 = harness([SUB({ updatedAt: 'V1' })]);
  const orig = h2.state.subscriptions[0];
  await h2.w.deleteSub('s1');
  await h2.w.saveSub(orig);
  assert.equal(h2.sent.at(-1)!.ifMatch, undefined);
});

test('R3 P1-2：基于自己保存中那条继续改的草稿换成服务器返回的版本；同时打开的其他旧草稿不被升级', async () => {
  const h = harness([SUB({ updatedAt: 'V1' })]);
  const other = { ...h.state.subscriptions[0], notes: 'other sheet' }; // 另一个面板同样基于 V1 打开
  h.hold(true);
  const first = h.w.saveSub({ ...h.state.subscriptions[0], notes: 'first' });
  // 保存未返回时，基于本地乐观那条继续改（例如连续点两次操作）
  const follow = h.w.saveSub({ ...h.state.subscriptions[0], tags: ['next'] });
  const stale = h.w.saveSub(other);
  h.hold(false);
  await Promise.all([first, follow, stale]);
  assert.deepEqual(
    h.sent.map((x) => x.ifMatch),
    ['V1', 'S1', 'V1'],
  );
  assert.equal(h.sent[1].body.notes, 'first');
});

test('R3 P1-3：网页设置只发送改动字段（清空为 null），不带本地其他设置的旧快照', async () => {
  const h = harness([]);
  h.state = { ...h.state, settings: { ...h.state.settings, timezone: 'UTC', notifyHour: 9 } };
  await h.w.saveSettings({ notifyHour: 7, defaultMethodId: undefined });
  assert.deepEqual(h.sent[0].body, { notifyHour: 7, defaultMethodId: null });
});

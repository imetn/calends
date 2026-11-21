import { createAuth, CACHE_KEY, ASSISTANT_KEY, HANDOFF_KEY } from './auth.ts';
import { setAssistantConfigured } from './handoff.ts';
import { createLedgerWrites } from './ledger-writes.ts';
import { configurePrefs, notifyPrefs, mirrorPrefs, migratePrefs } from './prefs.ts';

import { BASE_PATH, base } from './base.ts';
import { useSyncExternalStore } from 'react';
import { todayIn } from '../../shared/billing.ts';
import type { AppState } from '../../shared/types.ts';

import { locale, t } from '../../shared/i18n.ts';

import { advanceRevision, canApplySnapshot, CHECK_THROTTLE, shouldCheck, shouldPoll, syncedPrefs, SYNC_INTERVAL } from '../../shared/live-sync.ts';

type Phase = 'loading' | 'login' | 'ready' | 'offline';

interface Store {
  phase: Phase;
  state?: AppState;
  error?: string;
}

let store: Store = { phase: 'loading' };
const listeners = new Set<() => void>();

export function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
  notifyPrefs();
  updatePolling();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件里读整个 store：每次 set() 换新对象，订阅者随之重渲染 */
export function useStore(): Store {
  return useSyncExternalStore(subscribe, () => store);
}

export function getState(): AppState {
  return store.state!;
}

export function today(): string {
  return todayIn(store.state?.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function cache(state: AppState) {
  try {
    if (!state.readonly) localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式等 */
  }
}

/** 换上服务端返回的最新数据，并写入本地缓存 */
function replaceState(state: AppState) {
  cache(state);
  set({ state });
}

/**
 * 只换偏好，不换账本对象：视图、缩放这类界面偏好变化时，依赖 state 的账务派生（React Compiler 与 useMemo 以 state 为键）不必重算。
 * 偏好的订阅者经 usePref 按值更新；服务端同步时 replaceSyncedState 仍整体替换。
 */
function replacePrefs(prefs: NonNullable<AppState['prefs']>) {
  const st = store.state!;
  st.prefs = prefs;
  set({});
  // 整本账本序列化写缓存约十几毫秒：挪到空闲时，不和切换视图的渲染、动画抢主线程
  cacheSoon();
}
let cacheTimer: number | undefined;
function cacheSoon() {
  if (cacheTimer !== undefined) return;
  const flush = () => {
    cacheTimer = undefined;
    if (store.state) cache(store.state);
  };
  cacheTimer = typeof requestIdleCallback === 'function' ? requestIdleCallback(flush, { timeout: 2000 }) : (setTimeout(flush, 300) as unknown as number);
}

let knownRev: number | undefined;
let ownRevisions: Array<{ from: number; rev: number }> = [];
const prefEdits = new Map<string, number>();
let forceSnapshot = false;
let prefRetry: ReturnType<typeof setTimeout> | undefined;

export function replaceSyncedState(state: AppState) {
  const merged = syncedPrefs(state.prefs ?? {}, store.state?.prefs ?? {}, prefEdits, prefQueue, Date.now());
  forceSnapshot = merged.retryAt > 0;
  clearTimeout(prefRetry);
  if (forceSnapshot) prefRetry = setTimeout(() => void refresh(), Math.max(CHECK_THROTTLE, merged.retryAt - Date.now()));
  knownRev = state.rev;
  ownRevisions = ownRevisions.filter((r) => knownRev === undefined || r.rev > knownRev);
  replaceState({ ...state, prefs: merged.prefs });
  mirrorPrefs(store.state);
}

function acknowledgeWrite(res: Response) {
  const rawRev = res.headers.get('x-calends-rev');
  if (rawRev === null) return;
  const rev = Number(rawRev);
  if (!Number.isSafeInteger(rev) || rev < 0) return;
  const rawFrom = res.headers.get('x-calends-rev-from');
  if (rawFrom !== null) {
    const from = Number(rawFrom);
    if (Number.isSafeInteger(from) && from >= 0 && from <= rev) ownRevisions.push({ from, rev });
    knownRev = advanceRevision(knownRev, ownRevisions);
    ownRevisions = ownRevisions.filter((r) => knownRev === undefined || r.rev > knownRev);
    if (store.state) patchState((s) => ({ ...s, rev: knownRev }));
  }
  // A gap may be another device's write; a hint-only response (FX/assistant) needs reconciliation.
  if (rev !== knownRev) checkAgain = true;
  try {
    // BroadcastChannel is origin-scoped and has no targetOrigin parameter.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel?.postMessage({ rev });
  } catch {
    /* BroadcastChannel may be disabled by browser policy. */
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const writing = !!init.method && init.method !== 'GET';
  if (writing) {
    writes++;
    writeSeq++;
  }
  try {
    const res = await fetch(base(path), {
      ...init,
      credentials: 'same-origin',
      // 服务端按当前界面语言返回错误等文案
      headers: { 'content-type': 'application/json', 'x-locale': locale(), ...init.headers },
    });
    if (res.status === 401 && path !== '/api/login' && !path.startsWith('/api/auth/')) {
      await clearLocalSession();
      throw Object.assign(new Error(t('ui.error.loginRequired')), { status: res.status });
    }
    const body = (await readBody(res)) as T & { error?: string; code?: string };
    if (!res.ok) throw Object.assign(new Error(body.error ?? t('ui.error.requestFailed', { status: res.status })), { code: body.code, status: res.status });
    if (writing) acknowledgeWrite(res);
    return body;
  } finally {
    if (writing) {
      writes--;
      writeSeq++;
      resumeSync();
    }
  }
}

/**
 * 响应正文：空正文（含 204）当作 {}；成功响应却不是 JSON（被代理、登录页、静态页顶替）算请求失败，
 * 不能当作空结果交给调用方。失败响应的正文不是 JSON 时仍按状态码报错。
 */
async function readBody(res: Response): Promise<unknown> {
  const text = res.status === 204 ? '' : await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (res.ok) throw new Error(t('ui.error.requestFailed', { status: res.status }));
    return {};
  }
}

/** 至少是一本账：读缓存、读接口时都先确认，坏数据不能显示成空账本 */
export function isLedger(x: unknown): x is AppState {
  const s = x as Partial<AppState> | null;
  return !!s && typeof s === 'object' && Array.isArray(s.subscriptions) && Array.isArray(s.methods) && !!s.settings && typeof s.settings === 'object';
}

async function loadState(init?: RequestInit): Promise<AppState> {
  const state = await api<unknown>('/api/state', init);
  if (!isLedger(state)) throw new Error(t('ui.error.requestFailed', { status: 200 }));
  return state;
}

export async function boot(): Promise<void> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const state: unknown = raw ? JSON.parse(raw) : undefined;
    if (isLedger(state)) {
      knownRev = state.rev;
      set({ phase: 'ready', state });
    } else if (raw) localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
  try {
    const seq = writeSeq;
    const startWrites = writes;
    const state = await loadState();
    if (!state.readonly && !canApplySnapshot(startWrites, writes, seq, writeSeq, state.rev, knownRev)) {
      checkAgain = true;
      resumeSync();
      return;
    }
    knownRev = state.rev;
    ownRevisions = [];
    cache(state);
    set({ phase: 'ready', state });
    if (!state.readonly) {
      void syncFx();
      const migrated = migratePrefs(store.state);
      if (migrated) {
        replacePrefs({ ...store.state!.prefs, ...migrated });
        queuePrefs(migrated);
      }
      mirrorPrefs(store.state);
    }
  } catch (e) {
    // 401 时 api() 已清掉本机私有数据（含旧缓存），避免他人设备残留
    if (store.phase === 'login') return;
    if (store.state) set({ phase: 'offline' });
    else set({ phase: 'offline', error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 写操作计数：读取整份状态的请求如果发出时或返回前有写操作在进行，返回的就是旧数据，不能拿来覆盖本地。
 * 典型场景：点「暂停」的同一次点击让窗口获得焦点触发刷新，GET 先于 PUT 返回。
 */
let writes = 0;
let writeSeq = 0;
async function freshState(): Promise<AppState | undefined> {
  const seq = writeSeq;
  const startWrites = writes;
  const state = await loadState({ cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  return canApplySnapshot(startWrites, writes, seq, writeSeq, state.rev, knownRev) ? state : undefined;
}

let lastCheck = -Infinity;
let checking: Promise<void> | undefined;
let checkAgain = false;
let poll: ReturnType<typeof setInterval> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let channel: BroadcastChannel | undefined;

function visible() {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

function active() {
  return !!store.state && shouldPoll(store.phase, store.state.readonly, visible());
}

function updatePolling() {
  if (active()) poll ??= setInterval(() => void refresh(), SYNC_INTERVAL);
  else {
    clearInterval(poll);
    poll = undefined;
    clearTimeout(retry);
    retry = undefined;
  }
}

function resumeSync() {
  if (checkAgain && !writes && !checking && active() && !retry) {
    retry = setTimeout(
      () => {
        retry = undefined;
        void refresh();
      },
      Math.max(0, CHECK_THROTTLE - (Date.now() - lastCheck)),
    );
  }
}

/** Visible clients check a tiny revision first; only changed snapshots replace the store. */
export function refresh(): Promise<void> {
  if (!active() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve();
  if (checking) {
    checkAgain = true;
    return checking;
  }
  if (!shouldCheck(Date.now(), lastCheck, writes, true)) {
    checkAgain = true;
    resumeSync();
    return Promise.resolve();
  }
  checkAgain = false;
  lastCheck = Date.now();
  checking = (async () => {
    // Retry unsent preferences before comparing revisions after reconnecting.
    if (Object.keys(prefQueue).length && !prefTimer) {
      queuePrefs({});
      checkAgain = true;
      return;
    }
    const { rev } = await api<{ rev: number }>('/api/rev', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    // 版本号变小：服务端数据被重建或恢复过（新数据卷、备份恢复等），旧版本号不再可比，按新库重新拉取
    if (knownRev !== undefined && rev < knownRev && writes === 0) {
      knownRev = undefined;
      ownRevisions = [];
    }
    if (rev !== knownRev || forceSnapshot) {
      const state = await freshState();
      if (state) {
        replaceSyncedState(state);
        set({ phase: 'ready', error: undefined });
      } else checkAgain = true;
    } else if (store.phase === 'offline') set({ phase: 'ready', error: undefined });
  })()
    .catch(() => {
      /* Offline or expired login: retain data for offline use; api handles 401. */
    })
    .finally(() => {
      checking = undefined;
      resumeSync();
    });
  return checking;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    updatePolling();
    if (visible()) void refresh();
  });
  window.addEventListener('focus', () => void refresh());
  window.addEventListener('online', () => {
    if (store.phase === 'offline' && !store.state) void boot();
    else void refresh();
  });
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`calends:sync:${BASE_PATH || '/'}`);
      channel.onmessage = (event: MessageEvent<{ rev?: number }>) => {
        if (Number.isSafeInteger(event.data?.rev) && event.data.rev !== knownRev) void refresh();
      };
    }
  } catch {
    /* Polling also works without BroadcastChannel. */
  }
}

let syncing: Promise<void> | undefined;

/** 补齐扣款日的历史汇率：后台分批，补到新数据后刷新一次 */
export function syncFx(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    let filled = 0;
    for (let i = 0; i < 30; i++) {
      const r = await api<{ filled: number; remaining: number }>('/api/fx/backfill', { method: 'POST' }).catch(() => undefined);
      if (!r) break;
      filled += r.filled;
      if (r.remaining <= 0 || r.filled === 0) break;
    }
    if (filled > 0) {
      const state = await freshState().catch(() => undefined);
      if (state) replaceSyncedState(state);
    }
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}

export function patchState(fn: (s: AppState) => AppState) {
  replaceState(fn(store.state!));
}

/** 按 id 替换列表里的一项，没有就追加 */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

/**
 * 乐观更新：先改本地，失败回滚。回滚用的是发起时的快照，可能抹掉期间另一笔写入的本地结果，
 * 所以回滚后强制下一次同步拉取服务端的完整快照（等所有写入结束后），以服务端为准。
 */
async function optimistic<T>(fn: (s: AppState) => AppState, req: () => Promise<T>): Promise<T> {
  const prev = store.state!;
  patchState(fn);
  writes++;
  writeSeq++;
  try {
    return await req();
  } catch (e) {
    if (store.phase !== 'login') {
      patchState(() => ({ ...prev, rev: knownRev }));
      forceSnapshot = true;
      checkAgain = true;
    }
    throw e;
  } finally {
    writes--;
    writeSeq++;
    resumeSync();
  }
}

/**
 * 写入模板：先在本地改（local），请求成功后用服务端返回的权威结果再改一次（apply，可选），失败按 optimistic 回滚。
 * apply 在写入计数内执行，期间拉回的旧快照不会覆盖它。
 */
export function write<T>(local: (s: AppState) => AppState, req: () => Promise<T>, apply?: (s: AppState, r: T) => AppState): Promise<T> {
  return optimistic(local, async () => {
    const r = await req();
    if (apply && store.state) patchState((s) => apply(s, r));
    return r;
  });
}

/**
 * 恢复备份后换上服务端返回的新账本：不整页刷新，结果提示才看得到。
 * 恢复会重建数据，版本号可能比本地记的小，先忘掉旧版本号再按新库同步。
 */
export function adoptRestored(state: unknown) {
  if (!isLedger(state)) throw new Error(t('ui.error.requestFailed', { status: 200 }));
  knownRev = undefined;
  ownRevisions = [];
  replaceSyncedState(state);
  void syncFx();
}

let prefQueue: Record<string, string | null> = {};
let prefTimer: ReturnType<typeof setTimeout> | undefined;

function queuePrefs(patch: Record<string, string | null>) {
  Object.assign(prefQueue, patch);
  // 等待发送期间算作写操作，期间拉回来的旧数据不覆盖本地
  if (!prefTimer) {
    writes++;
    writeSeq++;
  }
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => void flushPrefs(), 400);
}

async function flushPrefs() {
  const body = prefQueue;
  prefQueue = {};
  prefTimer = undefined;
  try {
    await api('/api/prefs', { method: 'PATCH', body: JSON.stringify(body) });
  } catch {
    prefQueue = { ...body, ...prefQueue };
    checkAgain = false; // Retry on the next poll/online event, not in a tight offline loop.
  } finally {
    writes--;
    writeSeq++;
    resumeSync();
  }
}

export { ASSISTANT_KEY, HANDOFF_KEY };
export { toast, copyText, run, type ToastKind, type ToastOptions } from './toast.ts';
export { writePref, usePref } from './prefs.ts';
export const {
  saveSub,
  deleteSub,
  reorderMethods,
  saveMethod,
  deleteMethod,
  savePerson,
  deletePerson,
  mergePerson,
  saveSettings,
  saveCategories,
  rotateIcs,
  importData,
  refreshFx,
} = createLedgerWrites({ api, getState, syncFx, write, patchState, replaceSyncedState, isLedger, upsertById });
export const { login, authStatus, setupPassword, loginPasskey, startPasskeyAutofill, registerPasskey, logout, clearLocalSession } = createAuth({
  api,
  boot,
  set,
  snapshot: () => store,
  saveSettings,
  resetSessionRevision: () => {
    setAssistantConfigured(null);
    knownRev = undefined;
    ownRevisions = [];
  },
});
configurePrefs({ state: () => store.state, noteEdit: (key) => prefEdits.set(key, Date.now()), notify: () => set({}), replacePrefs, queuePrefs });

export { mergeEdits } from '../../shared/ledger-edit.ts';

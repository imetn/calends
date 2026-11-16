import { useSyncExternalStore } from 'react';
import {
  autoCheckDue,
  isNewer,
  LATEST_RELEASE_API,
  nextUpdateCache,
  parseRelease,
  parseUpdateCache,
  parseVersion,
  type UpdateCache,
} from '../../shared/version.ts';
import { readStored, storageKey } from './base.ts';

/**
 * 检查更新：浏览器直接读 GitHub 公开接口（不带凭证），结果和时间存在本机。
 * 只由登录后的应用调用；公开页不引入本模块。
 */
export const APP_VERSION = __APP_VERSION__;
const KEY = 'update-check';

export interface UpdateState {
  cache: UpdateCache | null;
  checking: boolean;
  /** 只记手动检查的失败；自动检查失败不显示 */
  failed: boolean;
}

let state: UpdateState = { cache: parseUpdateCache(readStored(KEY)), checking: false, failed: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

function save(cache: UpdateCache) {
  try {
    localStorage.setItem(storageKey(KEY), JSON.stringify(cache));
  } catch {
    // 隐私模式等存不了：本次会话内仍有结果
  }
}

async function fetchLatest() {
  const res = await fetch(LATEST_RELEASE_API, { headers: { accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  const latest = parseRelease(await res.json());
  if (!latest) throw new Error('bad release');
  return latest;
}

async function check(manual: boolean) {
  if (state.checking) return;
  set({ checking: true, failed: manual ? false : state.failed });
  let latest = null;
  try {
    latest = await fetchLatest();
  } catch {
    latest = null;
  }
  const cache = nextUpdateCache(state.cache, Date.now(), latest);
  save(cache);
  set({ cache, checking: false, failed: manual ? !latest : state.failed });
}

/** 手动「检查更新」：总是请求，失败时显示失败状态 */
export const checkUpdateNow = () => check(true);

/**
 * 应用加载后调用：每台设备每天最多一次，失败静默。
 * vite dev 和非正式版本号（不是 x.y.z）不自动检查，避免开发时反复请求、拿开发版本去比；手动检查不受影响。
 */
export function autoCheckUpdate(now = Date.now()) {
  if (import.meta.env.DEV) return;
  const v = parseVersion(APP_VERSION);
  if (!v || v.pre.length) return;
  if (!autoCheckDue(state.cache, now)) return;
  void check(false);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useUpdateState = () => useSyncExternalStore(subscribe, () => state);

/** 有比当前版本新的正式版时返回它 */
export function availableUpdate(s: UpdateState) {
  const latest = s.cache?.latest;
  return latest && isNewer(latest.version, APP_VERSION) ? latest : undefined;
}

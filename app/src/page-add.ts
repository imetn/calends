import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 页面自带的新建（合租、代付、人员）。手机端只有底栏「更多」里一个新建：
 * 当前页登记了就按页面执行，否则新建普通订阅。桌面端这些动作在页面内自有入口。
 */
export type PageAdd = { run: () => void; label: string };

let current: PageAdd | null = null;
const listeners = new Set<() => void>();
const set = (next: PageAdd | null) => {
  current = next;
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const usePageAdd = () => useSyncExternalStore(subscribe, () => current);

/** 页面挂载时登记、卸载时撤销；回调每次渲染都可能是新函数，执行时取最新的 */
export function useRegisterPageAdd(onAdd: (() => void) | undefined, label: string) {
  const latest = useRef(onAdd);
  useLayoutEffect(() => {
    latest.current = onAdd;
  });
  const on = !!onAdd;
  useEffect(() => {
    if (!on) return;
    const entry = { run: () => latest.current?.(), label };
    set(entry);
    return () => {
      if (current === entry) set(null);
    };
  }, [on, label]);
}

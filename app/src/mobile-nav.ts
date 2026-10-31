// 手机底栏的分配规则：纯函数，浏览器与测试共用

/** 底栏除「更多」外的入口数 */
export const BAR_SLOTS = 4;

/** 助手与连接在手机端合成一个 ai 入口 */
export const mobileKey = (path: string) => (path === 'assistant' || path === 'connect' ? 'ai' : path);

/**
 * paths：侧边栏里可见的模块（已按用户顺序排好）；picked：设置里选的底栏项。
 * 底栏先放选中且可见的项，不足 4 个按侧边栏顺序补齐；其余进「更多」。
 */
export function mobileNav(paths: string[], picked: string[] | undefined): { bar: string[]; more: string[] } {
  const keys = [...new Set(paths.map(mobileKey))];
  const bar = [...new Set(picked ?? [])].filter((k) => keys.includes(k)).slice(0, BAR_SLOTS);
  for (const k of keys) if (bar.length < BAR_SLOTS && !bar.includes(k)) bar.push(k);
  return { bar, more: keys.filter((k) => !bar.includes(k)) };
}

/** 把第 slot 个底栏位换成 key；key 已在别的位置时两者互换，始终保持不重复 */
export function pickSlot(bar: string[], slot: number, key: string): string[] {
  const next = [...bar];
  const from = next.indexOf(key);
  if (from >= 0) next[from] = next[slot];
  next[slot] = key;
  return next;
}

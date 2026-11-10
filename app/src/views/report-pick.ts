/** 报告的年份选择：全部，或某一年；记忆值失效时回到今年 */
export const isReportPick = (v: string): v is string => v === 'all' || /^\d{4}$/.test(v);

export function resolvePick(saved: string, options: Array<{ value: string }>, cur: number): string {
  return options.some((o) => o.value === saved) ? saved : String(cur);
}

/** 按时间顺序循环：下拉里最新的在上，循环从早到晚，最晚一年之后是全部，再回到第一年 */
export function stepPick(value: string, options: Array<{ value: string }>, d: number): string {
  const order = [
    ...options
      .filter((o) => o.value !== 'all')
      .map((o) => o.value)
      .reverse(),
    'all',
  ];
  // 当前值不在列表里（如最早的年份已被删掉）时，下一个从第一年起，上一个从全部起
  const i = order.indexOf(value);
  return order[i < 0 ? (d > 0 ? 0 : order.length - 1) : (i + d + order.length) % order.length];
}

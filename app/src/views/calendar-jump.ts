/** 日历的跳转参数：?month=YYYY-MM 打开该月，?year=YYYY 打开该年（今年停在本月，其他年停在 1 月）；格式不对就忽略 */
export function calendarJump(search: string, today: string): { month: string; mode: 'month' | 'year' } | null {
  const q = new URLSearchParams(search);
  const m = q.get('month');
  if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return { month: m, mode: 'month' };
  const y = q.get('year');
  if (y && /^\d{4}$/.test(y)) return { month: today.startsWith(y) ? today.slice(0, 7) : `${y}-01`, mode: 'year' };
  return null;
}

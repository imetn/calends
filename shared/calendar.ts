// 日历网格与热力分档：后台日历和公开页共用
import { addDays, addMonths, parseDay } from './billing.ts';

/** 一个月的日历格，含补齐首尾周的上下月日期；weekStart：周起始日，设置里选的 */
export function monthGrid(month: string, weekStart: 0 | 1): string[] {
  const first = month + '-01';
  const dow = (new Date(parseDay(first)).getUTCDay() + 7 - weekStart) % 7;
  const start = addDays(first, -dow);
  const last = addDays(addMonths(first, 1), -1);
  const cells = Math.ceil((dow + Number(last.slice(8))) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => addDays(start, i));
}

/** 热力分 1–4 档：有扣款至少 1 档（缺汇率或相抵为 0 也不能和没扣款一样）；开方，一笔年费不把其他日子都压成最浅 */
export function heatLevel(value: number, max: number): 1 | 2 | 3 | 4 {
  if (!(value > 0) || !(max > 0)) return 1;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(value / max) * 4))) as 1 | 2 | 3 | 4;
}

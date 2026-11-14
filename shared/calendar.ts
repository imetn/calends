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

/**
 * 日历格图标行：能放几个图标、是否平铺。gridW 为网格宽，narrow 须与 styles.css 的 @media (max-width: 680px) 同一判断
 * （窄屏图标 17px、格间距 2px、左右内边距各 2px；否则 24px、4px、6px）。放不下时给「+N」留位，至少留一个图标
 */
export function calendarIcons(gridW: number, narrow: boolean, count: number): { shown: number; tiled: boolean; step: number; icon: number } {
  const icon = narrow ? 17 : 24;
  const step = Math.round(icon * 0.6);
  if (!gridW) return { shown: Math.min(count, 4), tiled: false, step, icon };
  const inner = (gridW - 6 * (narrow ? 2 : 4)) / 7 - (narrow ? 4 : 12);
  // 「+N」占宽：左边距 4px，每个字符约 7.5px（--fs-1 半粗体）
  const moreW = (rest: number) => (rest > 0 ? 4 + 7.5 * (1 + String(rest).length) : 0);
  let shown = count;
  if (icon + step * (count - 1) > inner) {
    shown = count - 1;
    while (shown > 1 && icon + step * (shown - 1) + moreW(count - shown) > inner) shown--;
    shown = Math.max(1, shown);
  }
  const tiled = icon * shown + 3 * (shown - 1) + moreW(count - shown) <= inner;
  return { shown, tiled, step, icon };
}

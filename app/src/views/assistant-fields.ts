import { cnDateFull } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';

/**
 * 草稿卡片里按日期显示的参数：键名本身或以 _ 分隔的最后一段（camelCase 的最后一词）是日期词。
 * 只看词尾，category、status、create_category 这类中间含「at」的键不算日期。
 */
const DATE_WORD = /(?:^|_)(?:date|end|due|until|from|at|expires)$|(?:Date|End|Due|Until|From|At|Expires)$/;
export const isDateField = (key: string) => DATE_WORD.test(key);

/** 合法的 YYYY-MM-DD 按当前语言显示；其他值（模型给的自由文本）原样返回，空值为 undefined */
export function proposalDay(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? cnDateFull(s) : s;
}

type Turn = { role: string; status?: string; error?: { kind: string; message: string } };

/** 没收到 done 就结束的回复：记为中断（网络类错误），界面显示重试入口，而不是当作已完成 */
export const interrupted = <T extends Turn>(x: T): T => ({ ...x, status: 'error', error: { kind: 'network', message: t('assistant.interrupted') } });

/** 读回本机保存的会话时，仍是 streaming 的回复已不可能继续：一律记为中断 */
export const settleTurns = <T extends Turn>(turns: T[]): T[] => turns.map((x) => (x.role === 'assistant' && x.status === 'streaming' ? interrupted(x) : x));

/**
 * 有历史时把当前对话的分割线对齐到顶栏下方 12px 要滚的距离。
 * 只在当前对话还没撑满最小高度（内容不足一屏）时校正：这时分割线在顶就等于到底。
 * 当前对话超过一屏时返回 0，否则贴底时会被拉回分割线，永远滚不到最新消息（Issue #27）。
 */
export function headAlignDelta({
  headTop,
  barBottom,
  sessionHeight,
  fill,
}: {
  headTop: number;
  barBottom: number;
  sessionHeight: number;
  fill: number;
}): number {
  if (sessionHeight > fill + 1) return 0;
  const d = headTop - (barBottom + 12);
  return Math.abs(d) > 1 ? d : 0;
}

/**
 * 滚动后是否继续贴底跟随新内容。auto 是我们自己最近一次滚动到的位置：落在那里的滚动事件不算用户操作，返回 null 不改变状态。
 * 生成中用户往上滚（哪怕只滚一点，仍在底部 120px 内）就停止跟随，生成中也能停在回复开头往下读（Issue #28）；
 * 往下滚回底部附近才恢复跟随。
 */
export function followAfterScroll({
  y,
  last,
  auto,
  gap,
  streaming,
}: {
  y: number;
  last: number;
  auto: number | null;
  gap: number;
  streaming: boolean;
}): boolean | null {
  if (auto !== null && Math.abs(y - auto) < 1) return null;
  // 没在生成：仍按离底 120px 判断，回复结束后轻轻一滚不冒出「回到底部」
  if (!streaming) return gap < 120;
  // 越过底部的回弹（iOS 橡皮筋）也是往上，但不是用户想往回看
  const bounce = last > y + gap + 1;
  if (y < last - 1 && !bounce) return false;
  return gap < 120;
}

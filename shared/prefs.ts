// 界面配置（视图、排序、主题、展开状态等）：存在服务端，多台设备共用一份。
// 按项合并：两台设备同时改不同的项互不覆盖；同一项以后写的为准

export type Prefs = Record<string, string>;

/** 需要同步的配置项；值都是字符串（列表类的用 JSON） */
export const PREF_KEYS = [
  'list-view',
  'list-sort',
  'list-dir',
  'list-ccy',
  'gantt-zoom',
  'gantt-color',
  'gantt-label-w',
  'gantt-label-w-m',
  'theme',
  'sidebar-collapsed',
  'car-open',
  'share-style',
  'sub-share-style',
  'list-status',
  'list-report',
  'car-filter',
  'car-sort',
  'car-dir',
  'proxy-filter',
  'cal-mode',
  'cal-report-mode',
  'car-view',
  'proxy-view',
  'proxy-sort',
  'proxy-dir',
  'report-daily',
  'overview-period',
  'report-pick',
  'list-cat',
  'list-pay',
] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

const KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const MAX_KEYS = 100;
const MAX_LEN = 4000;

/** 把一次修改合并进现有配置：值为 null 表示删除；键名、长度、数量不合规的项丢弃 */
export function mergePrefs(cur: Prefs, patch: unknown): Prefs {
  const next: Prefs = { ...cur };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!KEY_RE.test(k)) continue;
    if (v === null) delete next[k];
    else if (typeof v === 'string' && v.length <= MAX_LEN && (k in next || Object.keys(next).length < MAX_KEYS)) next[k] = v;
  }
  return next;
}

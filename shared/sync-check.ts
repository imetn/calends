// App 同步协议（v1）的常量与纯函数：协议版本、设置白名单、补丁字段表、规范化。服务器与客户端共用，见 docs/sync-api.md。

/** 协议版本：只增可选字段不升；与备份格式版本无关 */
export const SYNC_PROTOCOL = 1;
export const MIN_CLIENT_PROTOCOL = 1;
/** 一个请求最多带的操作数 */
export const MAX_MUTATIONS = 300;
/** 一页对象的大致字节上限；单条超限时单独成页 */
export const PAGE_BYTES = 2 * 1024 * 1024;

/**
 * 同步的设置字段；其余字段（渠道凭据、公开页、导航、语言等）只留在各自一端。
 * 服务器下发前按它投影，写入时只覆盖这些字段、原地保留私有字段。
 */
export const SYNC_SETTINGS: readonly string[] = [
  'baseCurrency',
  'collectCurrency',
  'defaultMethodId',
  'categories',
  'signedAmounts',
  'gainColor',
  'weekStart',
  'timezone',
  'remindDays',
  'notifyHour',
  'monthlyDigest',
  'displayName',
  'avatar',
  'publicHidden',
];
const SYNC_SETTINGS_SET = new Set(SYNC_SETTINGS);
export const isSyncedSetting = (k: string) => SYNC_SETTINGS_SET.has(k);

/** 设置的同步视图：只留白名单字段；投影为空返回 undefined（视为不存在） */
export function projectSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  const out = Object.fromEntries(Object.entries(settings).filter(([k]) => SYNC_SETTINGS_SET.has(k)));
  return Object.keys(out).length ? out : undefined;
}

/**
 * patch@1 允许直接改的顶层字段 → 服务器上执行它的工具参数名。
 * 付款、阶段、价格、周期、状态、余额、充值等牵动派生值的字段必须走意图（工具重算）。
 */
export const PATCH_FIELDS = {
  sub: {
    name: 'name',
    icon: 'icon',
    url: 'url',
    manageUrl: 'manage_url',
    category: 'category',
    tags: 'tags',
    methodId: 'method',
    region: 'region',
    remindDays: 'remind_days',
    showOnPublic: 'show_on_public',
    account: 'account',
    notes: 'notes',
    expires: 'expires',
    trialEnd: 'trial_end',
    chargeLeadDays: 'chargeLeadDays',
    cancelLeadDays: 'cancelLeadDays',
  },
  method: {
    name: 'name',
    color: 'color',
    region: 'region',
    notes: 'notes',
    lowRunwayDays: 'lowRunwayDays',
    brand: 'brand',
    logo: 'logo',
    logoWide: 'logoWide',
    order: 'order',
    bank: 'bank',
    network: 'network',
    phone: 'phone',
    url: 'url',
    balanceExpires: 'balanceExpires',
  },
} as const satisfies Record<string, Record<string, string>>;

/** 键排序后的 JSON：两端比较内容、计算 replace 期望哈希都用它 */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(sort(v) ?? null);
}

/** replace@1 的期望哈希：规范化 JSON 的 SHA-256（十六进制） */
export async function contentHash(v: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(v)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 对象键：sub/<id>、method/<id>、kv/settings、kv/people、fx/<date> */
export type SyncKind = 'sub' | 'method' | 'kv' | 'fx';
export function splitKey(key: string): { kind: SyncKind; id: string } | undefined {
  const i = key.indexOf('/');
  if (i < 1) return undefined;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!id || !['sub', 'method', 'kv', 'fx'].includes(kind)) return undefined;
  if (kind === 'kv' && id !== 'settings' && id !== 'people') return undefined;
  return { kind: kind as SyncKind, id };
}

export type RejectCode = 'target_deleted' | 'field_changed' | 'expect_failed' | 'id_conflict' | 'invalid';

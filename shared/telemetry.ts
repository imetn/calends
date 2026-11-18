// 匿名使用统计的口径：浏览器和服务端共用。只有按天累计的次数，没有账本内容。
// 上报协议见 https://telemetry.calends.date（POST /v1/events）。

export const TELEMETRY_ENDPOINT = 'https://telemetry.calends.date/v1/events';
export const TELEMETRY_APP = 'calends';

/** 统计打开次数的页面；子路由归到所属页面（cat/* → list，family/people → family，settings/public → settings） */
export const TELEMETRY_PAGES = ['overview', 'calendar', 'list', 'wallet', 'family', 'behalf', 'connect', 'assistant', 'report', 'settings'] as const;
export type TelemetryPage = (typeof TELEMETRY_PAGES)[number];

export function telemetryPage(route: string): TelemetryPage | undefined {
  const top = route.startsWith('cat/') ? 'list' : route.split('/')[0];
  return (TELEMETRY_PAGES as readonly string[]).includes(top) ? (top as TelemetryPage) : undefined;
}

/** 浏览器可以上报的计数 */
export const BROWSER_COUNTS: ReadonlySet<string> = new Set(['opens', ...TELEMETRY_PAGES.map((p) => `page.${p}`)]);
/** 服务端自己累计的计数 */
export const SERVER_COUNTS: ReadonlySet<string> = new Set(['assistant.messages', 'mcp.calls']);

/** 单次上报里每项最多计多少次：页面在后台挂一整天也到不了，超出的算异常请求 */
const MAX_PER_FLUSH = 1000;

/** 只留白名单里的正整数计数；其余丢掉 */
export function cleanCounts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    if (BROWSER_COUNTS.has(k) && Number.isInteger(n) && (n as number) > 0) out[k] = Math.min(n as number, MAX_PER_FLUSH);
  }
  return out;
}

// wrangler vars 可以写成数字或布尔（"DO_NOT_TRACK": 1），先转成字符串再判断
const truthy = (v: unknown) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const falsy = (v: unknown) => /^(0|false|no|off)$/i.test(String(v ?? '').trim());

/** 部署时用环境变量关掉：CALENDS_TELEMETRY=0 或通用的 DO_NOT_TRACK=1。关掉后设置页的开关也打不开 */
export function telemetryForcedOff(env: { CALENDS_TELEMETRY?: unknown; DO_NOT_TRACK?: unknown }): boolean {
  return falsy(env.CALENDS_TELEMETRY) || truthy(env.DO_NOT_TRACK);
}

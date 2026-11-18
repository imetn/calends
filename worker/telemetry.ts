// 匿名使用统计：本机按天累计打开次数、各页面打开次数、助手消息数和 MCP 调用数，
// 定时任务每小时把已经过完的日子（UTC）发给 telemetry.calends.date，每天一条，发出后删掉本地计数。
// 存在 kv 的独立键里：不进完整备份、不推进 kv.rev，也不经 AI / MCP 工具。
// 设置页可关（关闭时清掉未发的计数）；CALENDS_TELEMETRY=0、DO_NOT_TRACK=1 强制关闭；本地开发（DEV_BYPASS_AUTH）从不发送。
import pkg from '../package.json' with { type: 'json' };
import { SERVER_COUNTS, TELEMETRY_APP, TELEMETRY_ENDPOINT, telemetryForcedOff } from '../shared/telemetry.ts';
import type { Env } from './env.ts';
import { getKv, getSettings, putKv } from './store.ts';

const STATE_KEY = 'telemetry';
const COUNTS_KEY = 'telemetryCounts';
const DAY = 86_400_000;
/** 发不出去的计数最多留几天；服务端也只接受最近两天的日期 */
const KEEP_DAYS = 2;

interface TelemetryState {
  enabled: boolean;
  installId?: string;
}

export interface TelemetryView {
  enabled: boolean;
  /** 被环境变量关掉，设置页不能打开 */
  forcedOff: boolean;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** 计数键：`2026-11-18|page.list`；JSON 路径里用双引号包住整个键 */
const path = (key: string) => `$."${key}"`;

async function readState(env: Env): Promise<TelemetryState> {
  return { enabled: true, ...(await getKv<TelemetryState>(env, STATE_KEY)) };
}

const forcedOff = (env: Env) => telemetryForcedOff(env);

export async function viewTelemetry(env: Env): Promise<TelemetryView> {
  const off = forcedOff(env);
  return { enabled: !off && (await readState(env)).enabled, forcedOff: off };
}

export async function saveTelemetry(env: Env, enabled: boolean): Promise<TelemetryView> {
  if (!forcedOff(env)) {
    // 关闭时连安装 id 一起丢掉：重新打开后是一个新安装，关闭前后的使用连不起来
    const { installId } = await readState(env);
    await putKv(env, STATE_KEY, enabled ? { enabled, installId } : { enabled });
    if (!enabled) await env.DB.prepare('DELETE FROM kv WHERE key = ?1').bind(COUNTS_KEY).run();
  }
  return viewTelemetry(env);
}

/** 当天（UTC）的计数加上去；关闭时什么都不记。单条语句原地累加，并发请求不会互相覆盖 */
export async function countUsage(env: Env, counts: Record<string, number>, now = Date.now()): Promise<void> {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length || env.DEV_BYPASS_AUTH === '1' || forcedOff(env) || !(await readState(env)).enabled) return;
  const day = utcDay(now);
  const keyed = entries.map(([k, n]) => [`${day}|${k}`, n] as const);
  const args: (string | number)[] = [JSON.stringify(Object.fromEntries(keyed))];
  const sets = keyed.map(([k, n]) => {
    args.push(path(k), n);
    const p = `?${args.length - 1}`;
    return `${p}, COALESCE(json_extract(value, ${p}), 0) + ?${args.length}`;
  });
  await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES ('${COUNTS_KEY}', ?1, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = json_set(value, ${sets.join(', ')}), updated_at = excluded.updated_at`,
  )
    .bind(...args)
    .run();
}

/** 服务端计数（助手、MCP）：统计失败不影响正常请求 */
export function countServer(env: Env, key: string): Promise<void> {
  if (!SERVER_COUNTS.has(key)) return Promise.resolve();
  return countUsage(env, { [key]: 1 }).catch((e) => console.error('[telemetry] count', e));
}

/** 把 `day|key` 计数拆成每天一组；只取今天之前、最近 KEEP_DAYS 天的，其余（过期的）列进 stale */
export function pendingDays(counts: Record<string, unknown>, now: number): { days: Map<string, Record<string, number>>; stale: string[] } {
  const today = utcDay(now);
  const oldest = utcDay(now - KEEP_DAYS * DAY);
  const days = new Map<string, Record<string, number>>();
  const stale: string[] = [];
  for (const [k, v] of Object.entries(counts)) {
    const [day, name] = k.split('|');
    if (!day || !name || day >= today) continue;
    if (day < oldest || typeof v !== 'number' || !(v > 0)) {
      stale.push(k);
      continue;
    }
    const props = days.get(day) ?? {};
    props[name] = Math.round(v);
    days.set(day, props);
  }
  return { days, stale };
}

async function removeKeys(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE kv SET value = json_remove(value, ${keys.map((_, i) => `?${i + 1}`).join(', ')}) WHERE key = '${COUNTS_KEY}'`)
    .bind(...keys.map(path))
    .run();
}

/**
 * 定时任务：发送已过完的日子。服务端收下（2xx）或明确拒收（400 / 413，重发也不会成功）都删掉这些计数；
 * 被限速、服务不可用、网络错误时留着，下个小时再发。事件 id 由安装 id 和日期组成，重发不会重复计。
 */
export async function reportTelemetry(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<void> {
  if (env.DEV_BYPASS_AUTH === '1') return;
  const state = await readState(env);
  // 关闭的瞬间并发写进来的计数也清掉，免得重新打开后被发出去
  if (forcedOff(env) || !state.enabled) {
    await env.DB.prepare('DELETE FROM kv WHERE key = ?1').bind(COUNTS_KEY).run();
    return;
  }
  const counts = (await getKv<Record<string, unknown>>(env, COUNTS_KEY)) ?? {};
  const { days, stale } = pendingDays(counts, now);
  await removeKeys(env, stale);
  if (!days.size) return;

  let installId = state.installId;
  if (!installId) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    installId = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // 只补安装 id，且只在仍开着时写：不能把这期间用户刚关掉的开关覆盖回开启
    const r = await env.DB.prepare(
      `UPDATE kv SET value = json_set(value, '$.installId', ?1), updated_at = datetime('now')
       WHERE key = '${STATE_KEY}' AND json_extract(value, '$.enabled') IS NOT 0 AND json_extract(value, '$.installId') IS NULL`,
    )
      .bind(installId)
      .run();
    if (!r.meta?.changes) {
      // 还没存过开关（默认开启）就新建；已有记录却没改到，说明刚被关掉或别的任务已生成 id，以库里为准
      const ins = await env.DB.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO NOTHING")
        .bind(STATE_KEY, JSON.stringify({ enabled: true, installId }))
        .run();
      if (!ins.meta?.changes) {
        const now2 = await readState(env);
        if (!now2.enabled || !now2.installId) return;
        installId = now2.installId;
      }
    }
  }
  const settings = await getSettings(env);
  const events = [...days].map(([day, props]) => ({
    name: 'active',
    id: `${installId}-${day.replace(/-/g, '')}`,
    ts: Date.parse(`${day}T12:00:00Z`),
    props,
  }));
  let status: number;
  try {
    const res = await fetcher(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `Calends/${pkg.version}` },
      body: JSON.stringify({
        app: TELEMETRY_APP,
        installId,
        context: { version: pkg.version, runtime: env.RUNTIME ?? 'cloudflare', locale: settings.language || settings.languageSeen || null },
        events,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    await res.body?.cancel();
  } catch (e) {
    console.error('[telemetry] send', e instanceof Error ? e.message : e);
    return;
  }
  if ((status >= 200 && status < 300) || status === 400 || status === 413) {
    await removeKeys(
      env,
      [...days].flatMap(([day, props]) => Object.keys(props).map((k) => `${day}|${k}`)),
    );
  }
}

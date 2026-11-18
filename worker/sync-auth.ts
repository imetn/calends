// App 同步的独立凭据（docs/sync-api.md「鉴权」）：与 MCP 令牌分开存、分开验。
// 同步令牌只能访问 /api/sync/v1/*，MCP 令牌（含写权限）访问不了同步；同步令牌也进不了 /mcp 和网页接口。
// 在网页「设置 › 安全 › 已连接的设备与应用」签发；库里只存 SHA-256，明文只在签发时返回一次。
// 官方托管不用这里：外层验过 aud=sync 的令牌后直接把 SyncIdentity 传给 syncHandler。
import { randomToken, sha256 } from './auth.ts';
import type { Env } from './env.ts';
import { getKv, putKv } from './store.ts';

/** 已验证的同步主体：自部署来自同步令牌，官方托管由外层注入 */
export interface SyncIdentity {
  aud: 'sync';
  /** 自部署的令牌 id，或托管侧的主体标识；只用于日志 */
  sub?: string;
}

export interface SyncToken {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

const KEY = 'syncTokens';
/** 最后使用时间单独一个键，鉴权时不读改写整张列表（同 MCP 令牌） */
const USE_KEY = 'syncTokenUse';
export const SYNC_TOKEN_PREFIX = 'cal_sync_';

const stored = async (env: Env) => (await getKv<SyncToken[]>(env, KEY)) ?? [];

export async function listSyncTokens(env: Env): Promise<SyncToken[]> {
  const used = (await getKv<Record<string, string>>(env, USE_KEY)) ?? {};
  return (await stored(env)).map((x) => (used[x.id] ? { ...x, lastUsedAt: used[x.id] } : x));
}

export async function createSyncToken(env: Env, name: string): Promise<{ token: string; item: SyncToken }> {
  const token = `${SYNC_TOKEN_PREFIX}${randomToken(24)}`;
  const item: SyncToken = {
    id: randomToken(6),
    name: name.trim().slice(0, 40) || 'Calends App',
    hash: await sha256(token),
    prefix: token.slice(0, SYNC_TOKEN_PREFIX.length + 4),
    createdAt: new Date().toISOString(),
  };
  await putKv(env, KEY, [...(await stored(env)), item]);
  return { token, item };
}

export async function revokeSyncToken(env: Env, id: string): Promise<void> {
  await putKv(
    env,
    KEY,
    (await stored(env)).filter((x) => x.id !== id),
  );
}

/** 校验 Bearer 同步令牌；只认同步令牌，MCP 令牌与网页 Cookie 一律不认 */
export async function authenticateSync(req: Request, env: Env): Promise<SyncIdentity | undefined> {
  const raw = req.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!raw?.startsWith(SYNC_TOKEN_PREFIX)) return undefined;
  const hash = await sha256(raw);
  const tk = (await listSyncTokens(env)).find((x) => x.hash === hash);
  if (!tk) return undefined;
  const now = new Date().toISOString();
  if (!tk.lastUsedAt || now.slice(0, 13) !== tk.lastUsedAt.slice(0, 13))
    await env.DB.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?1, json_object(?2, ?3), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = json_set(kv.value, '$.' || json_quote(?2), ?3), updated_at = excluded.updated_at",
    )
      .bind(USE_KEY, tk.id, now)
      .run();
  return { aud: 'sync', sub: tk.id };
}

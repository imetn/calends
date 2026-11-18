// App 同步的独立凭据（docs/sync-api.md「鉴权」）：与 MCP 令牌分开存、分开验。
// 同步令牌只能访问 /api/sync/v1/*，MCP 令牌（含写权限）访问不了同步；同步令牌也进不了 /mcp 和网页接口。
// 在网页「设置 › 安全 › 已连接的设备与应用」签发；库里只存 SHA-256，明文只在签发时返回一次。
// 官方托管不用这里：外层验过 aud=sync 的令牌后直接把 SyncIdentity 传给 syncHandler。
import { randomToken, sha256 } from './auth.ts';
import type { Env } from './env.ts';

/** 已验证的同步主体：自部署来自同步令牌，官方托管由外层注入 */
export interface SyncIdentity {
  aud: 'sync';
  /** 自部署的令牌 id，或托管侧的主体标识；只用于日志 */
  sub?: string;
  /** 托管侧：稳定的设备／令牌家族标识，安装归属按它核对（见 sync.ts SyncPrincipal）；自部署不传 */
  owner?: string;
  /** 托管侧：false = 只读令牌；自部署不传（同步令牌可写） */
  canWrite?: boolean;
}

export interface SyncToken {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export const SYNC_TOKEN_PREFIX = 'cal_sync_';

type Row = { id: string; name: string; hash: string; prefix: string; created_at: string; last_used_at: string | null };
const fromRow = (r: Row): SyncToken => ({
  id: r.id,
  name: r.name,
  hash: r.hash,
  prefix: r.prefix,
  createdAt: r.created_at,
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
});

/** 每个令牌一行（0010_sync_tokens.sql）：签发、吊销都是单行原子写，不读改写整张列表 */
export async function listSyncTokens(env: Env): Promise<SyncToken[]> {
  const { results } = await env.DB.prepare('SELECT * FROM sync_tokens ORDER BY created_at, id').all<Row>();
  return results.map(fromRow);
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
  await env.DB.prepare('INSERT INTO sync_tokens (id, name, hash, prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(item.id, item.name, item.hash, item.prefix, item.createdAt)
    .run();
  return { token, item };
}

export async function revokeSyncToken(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sync_tokens WHERE id = ?1').bind(id).run();
}

/** 校验 Bearer 同步令牌；只认同步令牌，MCP 令牌与网页 Cookie 一律不认 */
export async function authenticateSync(req: Request, env: Env): Promise<SyncIdentity | undefined> {
  const raw = req.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!raw?.startsWith(SYNC_TOKEN_PREFIX)) return undefined;
  const hash = await sha256(raw);
  const tk = await env.DB.prepare('SELECT id, last_used_at FROM sync_tokens WHERE hash = ?1').bind(hash).first<Pick<Row, 'id' | 'last_used_at'>>();
  if (!tk) return undefined;
  const now = new Date().toISOString();
  // 最后使用时间按小时更新；只改本行，已吊销（行已删除）时命中 0 行
  if (!tk.last_used_at || now.slice(0, 13) !== tk.last_used_at.slice(0, 13))
    await env.DB.prepare('UPDATE sync_tokens SET last_used_at = ?2 WHERE id = ?1').bind(tk.id, now).run();
  return { aud: 'sync', sub: tk.id };
}

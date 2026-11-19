// 扫码连接 App（docs/sync-api.md「扫码配对」）：网页登录后生成一次性配对码，App 扫码换取同步令牌。
// 码只存 SHA-256、5 分钟过期、用一次即删、错 5 次作废，同一时间至多一个有效码（新码覆盖旧码）。
// 兑换成功走 createSyncToken，与手动签发同一路径：第一个令牌在同一批次里启用同步。
import { sha256 } from './auth.ts';
import type { Env } from './env.ts';
import { createSyncToken } from './sync-auth.ts';

export const PAIR_TTL_MS = 5 * 60 * 1000;
export const PAIR_MAX_FAILURES = 5;
/** 去掉易混字符（0/O、1/I/L）；12 位约 59 bit 熵，配合 5 次上限与 5 分钟过期 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 12;

export class PairError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function randomCode(): string {
  let out = '';
  // 拒绝采样，保证每位均匀
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (b < limit && out.length < LENGTH) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** 输入归一：大写，去掉空格与连字符 */
export const normalizePairCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
const formatCode = (c: string) => c.match(/.{1,4}/g)!.join('-');

/** 生成新配对码（网页会话调用），覆盖旧码 */
export async function createPairCode(env: Env, now = Date.now()): Promise<{ code: string; expiresAt: string }> {
  const code = randomCode();
  const expires = now + PAIR_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sync_pair (id, hash, expires_at, failures) VALUES (1, ?1, ?2, 0) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at, failures = 0',
  )
    .bind(await sha256(code), expires)
    .run();
  return { code: formatCode(code), expiresAt: new Date(expires).toISOString() };
}

/** 兑换配对码（App 调用，无需登录）；成功返回新同步令牌，失败抛 PairError */
export async function redeemPairCode(env: Env, rawCode: string, name: string, now = Date.now()) {
  const code = normalizePairCode(rawCode);
  const hash = await sha256(code);
  // 单条 DELETE … RETURNING：并发兑换只有一个能拿到
  const hit = await env.DB.prepare('DELETE FROM sync_pair WHERE id = 1 AND hash = ?1 AND expires_at > ?2 RETURNING id').bind(hash, now).first();
  if (hit) {
    const { token, item } = await createSyncToken(env, name);
    return { token, id: item.id, name: item.name };
  }
  const row = await env.DB.prepare('SELECT hash, expires_at FROM sync_pair WHERE id = 1').first<{ hash: string; expires_at: number }>();
  if (row && row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM sync_pair WHERE id = 1 AND hash = ?1').bind(row.hash).run();
    throw row.hash === hash ? new PairError(410, 'code_expired') : new PairError(401, 'invalid_code');
  }
  if (!row) throw new PairError(401, 'invalid_code');
  // 有效码被猜错：累计失败，到上限即作废
  const r = await env.DB.prepare('UPDATE sync_pair SET failures = failures + 1 WHERE id = 1 AND hash = ?1 RETURNING failures')
    .bind(row.hash)
    .first<{ failures: number }>();
  if (r && r.failures >= PAIR_MAX_FAILURES) {
    await env.DB.prepare('DELETE FROM sync_pair WHERE id = 1 AND hash = ?1').bind(row.hash).run();
    throw new PairError(429, 'too_many_attempts');
  }
  throw new PairError(401, 'invalid_code');
}

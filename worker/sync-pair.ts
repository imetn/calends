// 扫码连接 App（docs/sync-api.md「扫码配对」）：网页登录后生成一次性配对码，App 扫码换取同步令牌。
// 码只存 SHA-256、5 分钟过期、只能兑换一次，同一时间至多一个码（新码覆盖旧码）。
// 不设错误次数上限：兑换无需登录，全局计数会让任何人用几次错码作废主人的码；12 位约 59 bit 熵配合 5 分钟过期已足够。
// 兑换走 createSyncToken，与手动签发同一路径：核销配对码、插入令牌、（第一个令牌时）启用同步在同一个批次里，要么都成，要么都不成。
// 兑换后这一行留着并记下令牌 id 与名称，网页凭配对码查询（pairStatus），不靠比对令牌列表猜。
import { sha256 } from './auth.ts';
import type { Env } from './env.ts';
import { createSyncToken } from './sync-auth.ts';

export const PAIR_TTL_MS = 5 * 60 * 1000;
/** 去掉易混字符（0/O、1/I/L）；12 位约 59 bit 熵 */
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

type PairRow = { hash: string; expires_at: number; token_id: string | null; token_name: string | null };
const readRow = (env: Env) => env.DB.prepare('SELECT hash, expires_at, token_id, token_name FROM sync_pair WHERE id = 1').first<PairRow>();

/** 生成新配对码（网页会话调用），覆盖旧码；ttlMs 供网页按本地单调时钟倒计时，不依赖两端时钟一致 */
export async function createPairCode(env: Env, now = Date.now()): Promise<{ code: string; expiresAt: string; ttlMs: number }> {
  const code = randomCode();
  const expires = now + PAIR_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sync_pair (id, hash, expires_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at, token_id = NULL, token_name = NULL',
  )
    .bind(await sha256(code), expires)
    .run();
  return { code: formatCode(code), expiresAt: new Date(expires).toISOString(), ttlMs: PAIR_TTL_MS };
}

/** 这个码现在不能兑换的原因：不是当前码或已兑换 → 401，过期 → 410 */
function unusable(row: PairRow | null, hash: string, now: number): PairError | undefined {
  if (!row || row.hash !== hash || row.token_id !== null) return new PairError(401, 'invalid_code');
  if (row.expires_at <= now) return new PairError(410, 'code_expired');
  return undefined;
}

/** 兑换配对码（App 调用，无需登录）；成功返回新同步令牌，失败抛 PairError */
export async function redeemPairCode(env: Env, rawCode: string, name: string, now = Date.now()) {
  const hash = await sha256(normalizePairCode(rawCode));
  const early = unusable(await readRow(env), hash, now);
  if (early) throw early;
  try {
    const { token, item } = await createSyncToken(env, name, {
      // 批次首条同时核对：码仍是这一个、未过期、未兑换；并发兑换只有一个能提交
      guard: 'EXISTS (SELECT 1 FROM sync_pair WHERE id = 1 AND hash = ?2 AND expires_at > ?3 AND token_id IS NULL)',
      binds: [hash, now],
      extra: (t) => [env.DB.prepare('UPDATE sync_pair SET token_id = ?1, token_name = ?2 WHERE id = 1 AND hash = ?3').bind(t.id, t.name, hash)],
      recheck: async () => {
        const e = unusable(await readRow(env), hash, now);
        if (e) throw e;
      },
    });
    return { token, id: item.id, name: item.name };
  } catch (e) {
    if (e instanceof PairError) throw e;
    // 批次没提交，码仍有效；App 可稍后用同一个码重试
    console.error('pair redeem failed', e);
    throw new PairError(503, 'pair_failed');
  }
}

export type PairStatus =
  | { status: 'pending'; expiresAt: string }
  | { status: 'expired' }
  | { status: 'connected'; device: { id: string; name: string } }
  | { status: 'invalid' };

/** 网页凭自己生成的配对码查结果（需网页登录）：只有被这个码换出的令牌才算连上，别的标签页手动签发不算 */
export async function pairStatus(env: Env, rawCode: string, now = Date.now()): Promise<PairStatus> {
  const hash = await sha256(normalizePairCode(rawCode));
  const row = await readRow(env);
  if (!row || row.hash !== hash) return { status: 'invalid' };
  if (row.token_id !== null) return { status: 'connected', device: { id: row.token_id, name: row.token_name ?? '' } };
  if (row.expires_at <= now) return { status: 'expired' };
  return { status: 'pending', expiresAt: new Date(row.expires_at).toISOString() };
}

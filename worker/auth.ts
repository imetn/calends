import { normalizeBasePath } from '../shared/base.ts';
// 登录与会话。
// - 密码：PBKDF2-SHA256 加盐哈希存在 kv 的 auth 键里，从不保存明文；首次设置需要部署时配置的 SETUP_TOKEN，防止陌生人抢先占用新部署。
// - 兼容旧部署：配置了 OWNER_PASSCODE 密钥的，第一次用它登录成功后自动转存为哈希。
// - Passkey：WebAuthn（SimpleWebAuthn），登录后在设置里绑定，之后可免密码登录。
// - 会话：随机令牌放 HttpOnly + SameSite=Lax Cookie（https 下再加 Secure），库里只存 SHA-256；登录失败按 IP 限速。
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Env } from './env.ts';
import { t } from '../shared/i18n.ts';
import { getKv, getSettings, putKv } from './store.ts';
import { readJson } from './http.ts';

const COOKIE = 'sid';
const SESSION_DAYS = 180;
const MAX_FAILS = 6;
const WINDOW_MS = 15 * 60_000;
/** Workers 的 WebCrypto 允许的 PBKDF2 迭代上限 */
const PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD = 8;
export const DEFAULT_MAX_SESSIONS = 10;
/** 活跃时间每隔这么久才回写一次，避免每个请求都写库 */
const TOUCH_MS = 10 * 60_000;

interface PasswordRecord {
  hash: string;
  salt: string;
  iterations: number;
  updatedAt: string;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return hex(new Uint8Array(buf));
}

export function randomToken(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return hex(new Uint8Array(bits));
}

/** 定长比较，避免按字节泄露 */
export function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomToken(16);
  return { hash: await pbkdf2(password, salt, PBKDF2_ITERATIONS), salt, iterations: PBKDF2_ITERATIONS, updatedAt: new Date().toISOString() };
}

async function checkPassword(env: Env, password: string): Promise<boolean> {
  const rec = await getKv<PasswordRecord>(env, 'auth');
  if (rec) return constantEqual(await pbkdf2(password, rec.salt, rec.iterations), rec.hash);
  // 旧部署：口令放在 OWNER_PASSCODE 密钥里；比对成功就转存成哈希，之后可以删掉这个密钥
  if (env.OWNER_PASSCODE && constantEqual(await sha256(password), await sha256(env.OWNER_PASSCODE))) {
    await putKv(env, 'auth', await hashPassword(password));
    return true;
  }
  return false;
}

/** 还没设过密码（也没有旧口令）时需要先走初始化 */
export async function needsSetup(env: Env): Promise<boolean> {
  return !env.OWNER_PASSCODE && !(await getKv<PasswordRecord>(env, 'auth'));
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

export async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT expires_at, last_seen_at FROM sessions WHERE token_hash = ?1')
    .bind(hash)
    .first<{ expires_at: number; last_seen_at: number | null }>();
  const now = Date.now();
  if (!row || row.expires_at <= now) return false;
  if (!row.last_seen_at || now - row.last_seen_at > TOUCH_MS)
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?1, ip = ?2 WHERE token_hash = ?3').bind(now, clientIp(req, env), hash).run();
  return true;
}

/** 当前请求所用会话令牌的哈希；没带 Cookie 时为空串 */
async function sessionHash(req: Request): Promise<string> {
  const token = readCookie(req, COOKIE);
  return token ? sha256(token) : '';
}

/** 访客 IP：Cloudflare 上取 cf-connecting-ip；自托管在反向代理后面时，设 TRUST_PROXY=1 才信任 X-Forwarded-For（否则可被伪造来绕过限速） */
const clientIp = (req: Request, env: Env) =>
  req.headers.get('cf-connecting-ip') ?? (env.TRUST_PROXY === '1' ? req.headers.get('x-forwarded-for')?.split(',')[0].trim() : undefined) ?? '';

/** 只有 https 访问时才给 Cookie 加 Secure，否则局域网里用 http 自托管时浏览器存不下登录状态 */
const secure = (req: Request) => (new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : '');

/** Cloudflare 按 IP 给出的大致位置，如「Tokyo, JP」；自托管时没有 */
function locationOf(req: Request): string {
  const cf = (req as Request & { cf?: { city?: string; region?: string; country?: string } }).cf;
  return [cf?.city, cf?.country].filter(Boolean).join(', ');
}

/** 新建会话并下发 Cookie；超出设备上限时把最久未活动的挤下线 */
async function startSession(req: Request, env: Env, method: 'password' | 'passkey'): Promise<Response> {
  const now = Date.now();
  const token = randomToken();
  const max = Math.max(1, (await getSettings(env)).maxSessions ?? DEFAULT_MAX_SESSIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, expires_at, user_agent, ip, location, method, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(
      await sha256(token),
      now + SESSION_DAYS * 86_400_000,
      (req.headers.get('user-agent') ?? '').slice(0, 300),
      clientIp(req, env),
      locationOf(req),
      method,
      now,
    ),
    env.DB.prepare('DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY COALESCE(last_seen_at, 0) DESC LIMIT ?1)').bind(max),
  ]);
  return Response.json(
    { ok: true },
    {
      headers: {
        'set-cookie': `${COOKIE}=${token}; Path=${normalizeBasePath(env.BASE_PATH) || '/'}; HttpOnly${secure(req)}; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
      },
    },
  );
}

/** 取不到访客 IP 时每次失败的等待：不锁定，只放慢尝试 */
const NO_IP_DELAY_MS = 750;

/**
 * 按 IP 限速：15 分钟内失败 6 次就先锁住。
 * Cloudflare 总带 cf-connecting-ip，Docker 由前置转发按真实连接写入；只有直接跑 wrangler dev 等情况取不到。
 * 取不到时所有人会落进同一个桶，锁定会让任何人都能把站长锁在门外，所以不锁，只在每次失败后等一会儿（PBKDF2 本身也有开销）。
 */
async function throttle(req: Request, env: Env) {
  const ip = clientIp(req, env);
  if (!ip)
    return {
      blocked: false,
      fail: () => new Promise((r) => setTimeout(r, NO_IP_DELAY_MS)),
      clear: async () => undefined,
    };
  const now = Date.now();
  const rec = await env.DB.prepare('SELECT fails, window_start FROM login_attempts WHERE ip = ?1').bind(ip).first<{ fails: number; window_start: number }>();
  const fresh = !rec || now - rec.window_start >= WINDOW_MS;
  return {
    blocked: !fresh && rec!.fails >= MAX_FAILS,
    fail: () =>
      env.DB.prepare('INSERT INTO login_attempts (ip, fails, window_start) VALUES (?1, 1, ?2) ON CONFLICT(ip) DO UPDATE SET fails = ?3, window_start = ?4')
        .bind(ip, now, fresh ? 1 : rec!.fails + 1, fresh ? now : rec!.window_start)
        .run(),
    clear: () => env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run(),
  };
}

const err = (error: string, status = 400) => Response.json({ error }, { status });

export async function authStatus(env: Env): Promise<Response> {
  const passkeys = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first<{ n: number }>();
  // 公开页开着时，未登录访客打开根路径看到公开页而不是登录页
  return Response.json({ needsSetup: await needsSetup(env), passkeys: passkeys?.n ?? 0, publicView: !!(await getSettings(env)).publicView });
}

/** 首次设置密码：必须带上部署时配置的 SETUP_TOKEN */
export async function setup(req: Request, env: Env): Promise<Response> {
  if (!(await needsSetup(env))) return err(t('server.auth.alreadySetup'), 409);
  const th = await throttle(req, env);
  if (th.blocked) return err(t('server.auth.tooMany'), 429);
  if (!env.SETUP_TOKEN) return err(t('server.auth.noSetupToken'), 403);
  const body = (await req.json().catch(() => ({}))) as { setupToken?: string; password?: string };
  if (!body.setupToken || !constantEqual(await sha256(body.setupToken), await sha256(env.SETUP_TOKEN))) {
    await th.fail();
    return err(t('server.auth.badSetupToken'), 401);
  }
  if (!body.password || body.password.length < MIN_PASSWORD) return err(t('server.auth.passwordTooShort', { min: MIN_PASSWORD, count: MIN_PASSWORD }));
  await putKv(env, 'auth', await hashPassword(body.password));
  await th.clear();
  return startSession(req, env, 'password');
}

export async function login(req: Request, env: Env): Promise<Response> {
  const th = await throttle(req, env);
  if (th.blocked) return err(t('server.auth.tooMany'), 429);
  const body = (await req.json().catch(() => ({}))) as { passcode?: string; password?: string };
  const pw = body.password ?? body.passcode ?? '';
  if (!pw || !(await checkPassword(env, pw))) {
    await th.fail();
    return err(t('server.auth.wrongPassword'), 401);
  }
  await th.clear();
  return startSession(req, env, 'password');
}

export async function changePassword(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { current?: string; next?: string };
  if (!body.current || !(await checkPassword(env, body.current))) return err(t('server.auth.wrongCurrentPassword'), 401);
  if (!body.next || body.next.length < MIN_PASSWORD) return err(t('server.auth.newPasswordTooShort', { min: MIN_PASSWORD, count: MIN_PASSWORD }));
  await putKv(env, 'auth', await hashPassword(body.next));
  // 改密码后其他设备全部下线，只留当前会话
  await removeOtherSessions(req, env);
  return Response.json({ ok: true });
}

async function removeOtherSessions(req: Request, env: Env): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM sessions WHERE token_hash != ?1')
    .bind(await sessionHash(req))
    .run();
  return r.meta.changes;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, COOKIE);
  if (token)
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1')
      .bind(await sha256(token))
      .run();
  return Response.json(
    { ok: true },
    { headers: { 'set-cookie': `${COOKIE}=; Path=${normalizeBasePath(env.BASE_PATH) || '/'}; HttpOnly${secure(req)}; SameSite=Lax; Max-Age=0` } },
  );
}

/** 退出其他所有设备 */
export async function logoutOthers(req: Request, env: Env): Promise<Response> {
  return Response.json({ ok: true, removed: await removeOtherSessions(req, env) });
}

/** 登录设备列表；id 取令牌哈希的前 16 位，不暴露完整哈希 */
export async function listSessions(req: Request, env: Env) {
  const mineHash = await sessionHash(req);
  const rows = await env.DB.prepare(
    'SELECT token_hash, created_at, user_agent, ip, location, method, last_seen_at FROM sessions WHERE expires_at > ?1 ORDER BY COALESCE(last_seen_at, 0) DESC',
  )
    .bind(Date.now())
    .all<{
      token_hash: string;
      created_at: string;
      user_agent: string | null;
      ip: string | null;
      location: string | null;
      method: string | null;
      last_seen_at: number | null;
    }>();
  return rows.results.map((r) => ({
    id: r.token_hash.slice(0, 16),
    current: r.token_hash === mineHash,
    userAgent: r.user_agent ?? '',
    ip: r.ip ?? '',
    location: r.location ?? '',
    method: r.method ?? 'password',
    createdAt: r.created_at.replace(' ', 'T') + 'Z',
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  }));
}

/** 调低设备上限后立即生效：保留当前设备和最近活跃的几台 */
export async function pruneSessions(req: Request, env: Env, max: number): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY token_hash = ?1 DESC, COALESCE(last_seen_at, 0) DESC LIMIT ?2)',
  )
    .bind(await sessionHash(req), Math.max(1, max))
    .run();
}

/** 移出某一台设备（不能移出当前这台，当前用「退出登录」） */
export async function revokeSession(req: Request, env: Env, id: string): Promise<Response> {
  if (!/^[0-9a-f]{16}$/.test(id)) return err(t('server.auth.invalidDevice'));
  const mine = await sessionHash(req);
  if (mine && mine.startsWith(id)) return err(t('server.auth.cannotRemoveCurrent'));
  await env.DB.prepare('DELETE FROM sessions WHERE substr(token_hash, 1, 16) = ?1').bind(id).run();
  return Response.json({ ok: true });
}

/** 写操作必须同源（SameSite=Lax 之外再加一道） */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  // 「Origin: null」等无法解析的来源一律视为跨站
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// ---------- Passkey ----------

const RP_NAME = 'Calends';
/**
 * RP 是站点自己的域名，优先取 SITE_URL：Docker 里 wrangler 只走 http，HTTPS 反代后 req.url 的协议对不上浏览器。
 * 本地开发时 wrangler 会把 URL 改写成线上域名，只好以浏览器的 Origin 为准。
 */
export const rp = (req: Request, env: Env) => {
  const o = env.DEV_BYPASS_AUTH === '1' ? req.headers.get('origin') : null;
  const u = new URL(o || env.SITE_URL || req.url);
  return { rpID: u.hostname, origin: u.origin };
};

/** 校验失败的具体原因只记服务端日志（如 origin、rpID 不符），返回给浏览器的仍是通用提示 */
const logPasskeyError = (step: string) => (e: unknown) => {
  console.warn(`[passkey] ${step} verification failed:`, e instanceof Error ? e.message : e);
  return undefined;
};

async function saveChallenge(env: Env, kind: string, challenge: string): Promise<string> {
  const id = randomToken(12);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(Date.now()),
    env.DB.prepare('INSERT INTO auth_challenges (id, challenge, kind, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(id, challenge, kind, Date.now() + 5 * 60_000),
  ]);
  return id;
}

/** 取出并作废一次性挑战：单条 DELETE … RETURNING，两个并发请求只有一个能拿到它 */
export async function takeChallenge(env: Env, id: string, kind: string): Promise<string | undefined> {
  const row = await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1 RETURNING challenge, kind, expires_at')
    .bind(id)
    .first<{ challenge: string; kind: string; expires_at: number }>();
  return row && row.kind === kind && row.expires_at > Date.now() ? row.challenge : undefined;
}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function listPasskeys(env: Env) {
  const rows = await env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at').all<
    Pick<PasskeyRow, 'id' | 'name' | 'created_at' | 'last_used_at'>
  >();
  return rows.results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function deletePasskey(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM passkeys WHERE id = ?1').bind(id).run();
}

/** 已登录时绑定新的 Passkey：第一步，生成注册选项 */
export async function passkeyRegisterOptions(req: Request, env: Env): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id, transports FROM passkeys').all<{ id: string; transports: string | null }>();
  const { rpID } = rp(req, env);
  const { displayName } = await getSettings(env);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: `owner@${rpID}`,
    userDisplayName: `${displayName.trim() || RP_NAME} · ${rpID}`,
    attestationType: 'none',
    excludeCredentials: existing.results.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return Response.json({ options, challengeId: await saveChallenge(env, 'register', options.challenge) });
}

/** 第二步：校验浏览器返回的凭据并保存 */
export async function passkeyRegisterVerify(req: Request, env: Env): Promise<Response> {
  const body = (await readJson(req)) as { challengeId: string; response: RegistrationResponseJSON; name?: string };
  const expected = await takeChallenge(env, body.challengeId, 'register');
  if (!expected) return err(t('server.auth.expired'));
  const { rpID, origin } = rp(req, env);
  const v = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: expected,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  }).catch(logPasskeyError('register'));
  if (!v?.verified || !v.registrationInfo) return err(t('server.auth.passkeyFailed'));
  const c = v.registrationInfo.credential;
  await env.DB.prepare('INSERT INTO passkeys (id, public_key, counter, transports, name) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(
      c.id,
      b64url(c.publicKey),
      c.counter,
      JSON.stringify(c.transports ?? body.response.response.transports ?? []),
      (body.name ?? '').trim().slice(0, 40) || 'Passkey',
    )
    .run();
  return Response.json({ ok: true });
}

/** 用 Passkey 登录：第一步，生成挑战（可发现凭据，不需要先输用户名） */
export async function passkeyLoginOptions(req: Request, env: Env): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: rp(req, env).rpID, userVerification: 'preferred' });
  return Response.json({ options, challengeId: await saveChallenge(env, 'login', options.challenge) });
}

/** 第二步：校验签名，成功后建会话 */
export async function passkeyLoginVerify(req: Request, env: Env): Promise<Response> {
  const th = await throttle(req, env);
  if (th.blocked) return err(t('server.auth.tooMany'), 429);
  const body = (await readJson(req)) as { challengeId: string; response: AuthenticationResponseJSON };
  const expected = await takeChallenge(env, body.challengeId, 'login');
  if (!expected) return Response.json({ error: t('server.auth.expired'), code: 'PASSKEY_CHALLENGE_EXPIRED' }, { status: 400 });
  const row = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?1').bind(body.response.id).first<PasskeyRow>();
  if (!row) {
    await th.fail();
    // 带 code，浏览器据此通知密码管理器这条凭据已作废（WebAuthn Signal API）
    return Response.json({ error: t('server.auth.passkeyNotBound'), code: 'PASSKEY_NOT_BOUND' }, { status: 401 });
  }
  const { rpID, origin } = rp(req, env);
  const v = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: expected,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: { id: row.id, publicKey: unb64url(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
  }).catch(logPasskeyError('login'));
  // 签名不对、计数器回退（疑似克隆）等都会在这里被拒绝
  if (!v?.verified) {
    await th.fail();
    return err(t('server.auth.passkeyFailed'), 401);
  }
  await env.DB.prepare("UPDATE passkeys SET counter = ?1, last_used_at = datetime('now') WHERE id = ?2").bind(v.authenticationInfo.newCounter, row.id).run();
  await th.clear();
  return startSession(req, env, 'passkey');
}

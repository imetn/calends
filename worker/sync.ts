// App 同步协议 v1（docs/sync-api.md）：GET hello、POST sync（推拉合一）。
// 执行分两段：prepareSync 读一份一致快照，在内存行上用 BatchStore + 现有写工具逐个执行（每个操作一个保存点）；
// commitSync 一个 D1 batch：首条守卫核对 head、代际与本安装的行未变，再写账本差异、行与拒绝，变了整批回滚，重算最多 3 次后 503。
// 网页、MCP 等现有路径不经过这里；不调用同步接口时对现有自部署零影响。
import pkg from '../package.json' with { type: 'json' };
import { MAX_MUTATIONS, MIN_CLIENT_PROTOCOL, PAGE_BYTES, SYNC_PROTOCOL, projectSettings, type RejectCode } from '../shared/sync-check.ts';
import type { Env } from './env.ts';
import { ensureMigrated } from './migrate.ts';
import { loadState, rotateGenerationStmt } from './store.ts';
import { OP_VERSIONS, parseOpName, SyncExec, type SyncOp } from './sync-ops.ts';
import { BatchStore, batchReadStmts } from './sync-store.ts';

export interface SyncRequest {
  protocol: number;
  reqId: string;
  installId: string;
  ledgerId: string | null;
  register: boolean;
  drEpoch: string | null;
  cookie: { gen: string; seq: number } | null;
  ackedMid: number;
  mutations: Array<{ mid: number; op: SyncOp & { tid?: unknown } }>;
}

export interface Rejection {
  mid: number;
  code: RejectCode;
  detail: string;
}

export interface SyncOptions {
  /** 单页对象字节上限（测试用小值验证分页）；默认 PAGE_BYTES */
  pageBytes?: number;
  /** 测试旁路：提交成功后回报每个执行过的操作（op.tid 原样带回）；不属于协议 */
  onCommitted?: (executed: Array<{ tid: unknown; ok: boolean; code?: RejectCode }>) => void;
  /** 测试钩子：第 3 步算完、第 4 步提交前（制造读算写交错） */
  beforeCommit?: () => Promise<void> | void;
  /** last_seen 的时间（毫秒） */
  now?: () => number;
}

type Prepared =
  | { kind: 'error'; status: number; code: string }
  | { kind: 'mismatch'; ledgerId: string }
  | { kind: 'gone'; ledgerId: string; drEpoch: string; row: ClientRow | null; insert: boolean; mark: boolean; last: number; rejections: Rejection[] }
  | {
      kind: 'run';
      ledgerId: string;
      drEpoch: string;
      gen: string;
      head: number;
      row: ClientRow | null;
      last: number;
      expected: number | null;
      rejections: Rejection[];
      fresh: Rejection[];
      executed: Array<{ tid: unknown; ok: boolean; code?: RejectCode }>;
      rotate: boolean;
      store: BatchStore | null;
    };

interface ClientRow {
  last: number;
  gone: number;
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** 整请求校验（sync-design 3.5）：格式错误 400，协议或操作版本不认识 426，超量 413 */
export function parseSyncRequest(body: unknown): SyncRequest {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SyncHttpError(400, 'invalid_request');
  if (!isInt(b.protocol, 1)) throw new SyncHttpError(400, 'invalid_request');
  if (b.protocol < MIN_CLIENT_PROTOCOL) throw new SyncHttpError(426, 'client_too_old');
  if (b.protocol > SYNC_PROTOCOL) throw new SyncHttpError(426, 'server_too_old');
  if (!isStr(b.installId)) throw new SyncHttpError(400, 'invalid_request');
  if (b.ledgerId != null && !isStr(b.ledgerId)) throw new SyncHttpError(400, 'invalid_request');
  if (b.drEpoch != null && !isStr(b.drEpoch)) throw new SyncHttpError(400, 'invalid_request');
  const c = b.cookie as Record<string, unknown> | null | undefined;
  if (c != null && (typeof c !== 'object' || !isStr(c.gen) || !isInt(c.seq))) throw new SyncHttpError(400, 'invalid_request');
  const ackedMid = b.ackedMid ?? 0;
  if (!isInt(ackedMid)) throw new SyncHttpError(400, 'invalid_request');
  const muts = b.mutations ?? [];
  if (!Array.isArray(muts)) throw new SyncHttpError(400, 'invalid_request');
  if (muts.length > MAX_MUTATIONS) throw new SyncHttpError(413, 'too_many_mutations');
  let prev = 0;
  for (const m of muts as Array<Record<string, unknown>>) {
    if (!m || typeof m !== 'object' || !isInt(m.mid, 1) || m.mid <= prev || !m.op || typeof m.op !== 'object') throw new SyncHttpError(400, 'invalid_request');
    prev = m.mid;
    if (!parseOpName((m.op as SyncOp).name)) throw new SyncHttpError(426, 'op_version');
  }
  return {
    protocol: b.protocol,
    reqId: typeof b.reqId === 'string' ? b.reqId : '',
    installId: b.installId,
    ledgerId: (b.ledgerId as string | null | undefined) ?? null,
    register: b.register === true,
    drEpoch: (b.drEpoch as string | null | undefined) ?? null,
    cookie: c ? { gen: c.gen as string, seq: c.seq as number } : null,
    ackedMid,
    mutations: muts as SyncRequest['mutations'],
  };
}

const rejectionsStmt = (env: Env, installId: string, after: number) =>
  env.DB.prepare('SELECT mutation_id AS mid, code, detail FROM sync_rejections WHERE install_id = ?1 AND mutation_id > ?2 ORDER BY mutation_id').bind(installId, after);

/** 第 2、3 步：读一致快照、判定资格、在内存行上执行。不写库 */
export async function prepareSync(env: Env, req: SyncRequest): Promise<Prepared> {
  const reads = [
    env.DB.prepare('SELECT key, value FROM sync_meta'),
    env.DB.prepare('SELECT seq FROM sync_head'),
    env.DB.prepare('SELECT last_mutation_id AS last, gone FROM sync_clients WHERE install_id = ?1').bind(req.installId),
    rejectionsStmt(env, req.installId, req.ackedMid),
    ...(req.mutations.length ? batchReadStmts(env) : []),
  ];
  const results = await env.DB.batch(reads);
  const meta = Object.fromEntries((results[0].results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const head = Number((results[1].results[0] as { seq: number } | undefined)?.seq ?? 0);
  const row = (results[2].results[0] as ClientRow | undefined) ?? null;
  const rejections = results[3].results as unknown as Rejection[];
  const { generation: gen, ledgerId, drEpoch } = meta;

  // 写入资格（sync-design 3.2）：注册是单独一步、不带操作；未绑定账本只许纯拉取
  if (req.register && req.mutations.length) return { kind: 'error', status: 400, code: 'register_with_mutations' };
  if (!req.ledgerId && req.mutations.length) return { kind: 'error', status: 400, code: 'ledger_required' };
  if (req.ledgerId && req.ledgerId !== ledgerId) return { kind: 'mismatch', ledgerId };
  const gone = (insert: boolean, mark: boolean): Prepared => ({ kind: 'gone', ledgerId, drEpoch, row, insert, mark, last: row?.last ?? 0, rejections });
  if (row?.gone) return gone(false, false);
  // 灾备纪元：只有从未见过纪元的首装注册可以为空
  if (req.drEpoch ? req.drEpoch !== drEpoch : !req.register) return gone(!row, !!row);
  // 只有显式注册过的安装有写入资格；物理回滚抹掉了注册或进度 → 作废
  if (!row && !req.register) return gone(true, false);
  if (row && req.ackedMid > row.last) return gone(false, true);

  let last = row?.last ?? 0;
  let expected: number | null = null;
  let rotate = false;
  const fresh: Rejection[] = [];
  const executed: Array<{ tid: unknown; ok: boolean; code?: RejectCode }> = [];
  const store = req.mutations.length ? new BatchStore(results.slice(4)) : null;
  if (store) {
    const exec = new SyncExec(env, store);
    for (const m of req.mutations) {
      if (m.mid <= last) continue;
      if (m.mid > last + 1) {
        expected = last + 1; // 编号缺口：本批其余不执行
        break;
      }
      const sp = store.savepoint();
      const r = await exec.run(m.op);
      if (!r.ok) {
        store.rollback(sp);
        fresh.push({ mid: m.mid, code: r.code, detail: r.detail });
      } else if (r.rotate) rotate = true;
      if (!m.op.name.startsWith('noop@')) executed.push({ tid: m.op.tid, ok: r.ok, ...(r.ok ? {} : { code: r.code }) });
      last = m.mid; // 语义失败也推进
    }
  }
  return { kind: 'run', ledgerId, drEpoch, gen, head, row, last, expected, rejections, fresh, executed, rotate, store };
}

const casFail = (e: unknown) => e instanceof Error && /CHECK constraint failed/i.test(e.message);
const casStmt = (env: Env) => env.DB.prepare('INSERT INTO sync_cas (ok) SELECT changes() = 1');

/** 第 4 步：一个 batch 提交。返回 false = 快照已变，需要重算 */
export async function commitSync(env: Env, req: SyncRequest, p: Prepared, opts: SyncOptions = {}): Promise<boolean> {
  const now = new Date(opts.now?.() ?? Date.now()).toISOString();
  const stmts: D1PreparedStatement[] = [];
  if (p.kind === 'gone') {
    if (p.insert)
      stmts.push(
        env.DB.prepare('INSERT INTO sync_clients (install_id, last_mutation_id, last_seen, gone) VALUES (?1, 0, ?2, 1) ON CONFLICT(install_id) DO NOTHING').bind(req.installId, now),
        casStmt(env),
      );
    if (p.mark)
      stmts.push(
        env.DB.prepare('UPDATE sync_clients SET gone = 1 WHERE install_id = ?1 AND last_mutation_id IS ?2 AND gone = 0').bind(req.installId, p.row!.last),
        casStmt(env),
      );
  } else if (p.kind === 'run') {
    const changed = p.executed.length > 0 || p.fresh.length > 0 || p.last !== (p.row?.last ?? 0) || !p.row;
    if (!changed) return true; // 纯拉取或全部重发：没有要写的
    stmts.push(
      env.DB.prepare("INSERT INTO sync_cas (ok) SELECT (SELECT seq FROM sync_head) IS ?1 AND (SELECT value FROM sync_meta WHERE key = 'generation') = ?2").bind(
        p.head,
        p.gen,
      ),
    );
    if (!p.row)
      stmts.push(
        env.DB.prepare('INSERT INTO sync_clients (install_id, last_mutation_id, last_seen, gone) VALUES (?1, ?2, ?3, 0) ON CONFLICT(install_id) DO NOTHING').bind(
          req.installId,
          p.last,
          now,
        ),
      );
    else
      stmts.push(
        env.DB.prepare('UPDATE sync_clients SET last_mutation_id = ?1, last_seen = ?2 WHERE install_id = ?3 AND last_mutation_id IS ?4 AND gone = 0').bind(
          p.last,
          now,
          req.installId,
          p.row.last,
        ),
      );
    stmts.push(casStmt(env), ...(p.store?.commitStmts(env) ?? []));
    for (const r of p.fresh)
      stmts.push(
        env.DB.prepare('INSERT OR REPLACE INTO sync_rejections (install_id, mutation_id, code, detail) VALUES (?1, ?2, ?3, ?4)').bind(req.installId, r.mid, r.code, r.detail),
      );
    if (p.rotate) stmts.push(rotateGenerationStmt(env));
  } else return true;
  if (!stmts.length) return true;
  stmts.push(env.DB.prepare('DELETE FROM sync_cas'));
  try {
    await env.DB.batch(stmts);
    return true;
  } catch (e) {
    if (casFail(e)) return false;
    throw e;
  }
}

/** 拉取一页：cookie.seq 只越过已交付的对象；代际不符或无 cookie = 从 0 全量（只发未删除） */
export async function changesSince(env: Env, cookie: SyncRequest['cookie'], pageBytes = PAGE_BYTES) {
  const LIMIT = 1000;
  const doc = `CASE o.kind
      WHEN 'sub' THEN (SELECT data FROM subscriptions WHERE id = o.id)
      WHEN 'method' THEN (SELECT data FROM methods WHERE id = o.id)
      WHEN 'kv' THEN (SELECT value FROM kv WHERE key = o.id)
      WHEN 'fx' THEN (SELECT json_object('rates', json(rates), 'source', source) FROM fx_daily WHERE date = o.id) END`;
  const [g, rows, fx] = await env.DB.batch([
    env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'generation'"),
    env.DB.prepare(
      `SELECT o.kind, o.id, o.seq, o.deleted, ${doc} AS doc FROM sync_objects o
       WHERE o.seq > CASE WHEN ?1 IS NULL OR ?1 <> (SELECT value FROM sync_meta WHERE key = 'generation') THEN 0 ELSE ?2 END
         AND (o.deleted = 0 OR (?1 IS NOT NULL AND ?1 = (SELECT value FROM sync_meta WHERE key = 'generation')))
       ORDER BY o.seq LIMIT ${LIMIT}`,
    ).bind(cookie?.gen ?? null, cookie?.seq ?? 0),
    env.DB.prepare("SELECT value FROM kv WHERE key = 'fx'"),
  ]);
  const gen = (g.results[0] as { value: string }).value;
  const full = !cookie || cookie.gen !== gen;
  const list = rows.results as Array<{ kind: string; id: string; seq: number; deleted: number; doc: string | null }>;
  const objects: Array<[string, unknown]> = [];
  let bytes = 0;
  let seq = full ? 0 : cookie!.seq;
  let more = list.length === LIMIT;
  for (const r of list) {
    const key = `${r.kind}/${r.id}`;
    let d: unknown = r.deleted || r.doc == null ? null : JSON.parse(r.doc);
    if (key === 'kv/settings' && d) d = projectSettings(d as Record<string, unknown>) ?? null;
    const text = d === null ? '' : JSON.stringify(d);
    const size = key.length + text.length;
    if (objects.length && bytes + size > pageBytes) {
      more = true;
      break;
    }
    if (!(full && d === null)) objects.push([key, d]);
    bytes += size;
    seq = r.seq;
  }
  const fxValue = (fx.results[0] as { value: string } | undefined)?.value;
  return { full, objects, cookie: { gen, seq }, more, fx: fxValue ? JSON.parse(fxValue) : null };
}

const RETRIES = 3;

/** POST /sync：prepare + commit，快照变了重算，最多 3 次，仍冲突 503 */
export async function runSync(env: Env, req: SyncRequest, opts: SyncOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  // 表结构迁移按库只做一次；一次性数据迁移（与 GET /api/state 同一路径）先落库，迁移写入正常涨序号（sync-design 5.4）
  await ensureMigrated(env);
  if (req.mutations.length) await loadState(env);
  for (let i = 0; i < RETRIES; i++) {
    const p = await prepareSync(env, req);
    if (p.kind === 'error') return { status: p.status, body: { error: p.code, code: p.code } };
    if (p.kind === 'mismatch') return { status: 200, body: { reqId: req.reqId, ledgerMismatch: true, ledgerId: p.ledgerId } };
    await opts.beforeCommit?.();
    if (!(await commitSync(env, req, p, opts))) continue;
    if (p.kind === 'gone')
      return { status: 200, body: { reqId: req.reqId, ledgerId: p.ledgerId, drEpoch: p.drEpoch, gone: { lastMutationId: p.last, rejections: p.rejections } } };
    opts.onCommitted?.(p.executed);
    const page = await changesSince(env, req.cookie, opts.pageBytes);
    return {
      status: 200,
      body: {
        reqId: req.reqId,
        ledgerId: p.ledgerId,
        drEpoch: p.drEpoch,
        lastMutationId: p.last,
        expected: p.expected,
        rejections: [...p.rejections, ...p.fresh].filter((r) => r.mid > req.ackedMid),
        ...page,
      },
    };
  }
  return { status: 503, body: { error: 'conflict', code: 'conflict' } };
}

/** GET hello：协议、操作版本、引擎版本；鉴权后附账本规模与 ledgerId（首次连接判断） */
export async function hello(env: Env, authed: boolean) {
  const base = { protocol: SYNC_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL, ops: OP_VERSIONS, engine: pkg.version };
  if (!authed) return base;
  const [subs, methods, people, meta] = await env.DB.batch([
    env.DB.prepare('SELECT count(*) AS n FROM subscriptions'),
    env.DB.prepare('SELECT count(*) AS n FROM methods'),
    env.DB.prepare("SELECT coalesce(json_array_length(value), 0) AS n FROM kv WHERE key = 'people'"),
    env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'ledgerId'"),
  ]);
  const n = (r: D1Result) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0);
  return { ...base, counts: { sub: n(subs), method: n(methods), people: n(people) }, ledgerId: (meta.results[0] as { value: string } | undefined)?.value ?? null };
}

/**
 * 同步接口的处理器，可单独挂载（官方托管注入已验证的身份）。path 为挂载点之后的部分：'hello' 或 'sync'。
 * authed：调用方已完成鉴权（自部署用写权限的 MCP 令牌，官方托管用 aud=sync 的 OAuth 令牌）。
 */
export async function syncHandler(req: Request, env: Env, path: string, identity: { authed: boolean }, opts: SyncOptions = {}): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
  if (path === 'hello' && req.method === 'GET') return (await ensureMigrated(env), json(await hello(env, identity.authed)));
  if (path !== 'sync') return json({ error: 'not_found' }, 404);
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (!identity.authed) return Response.json({ error: 'invalid_token', code: 'invalid_token' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_request', code: 'invalid_request' }, 400);
  }
  try {
    const r = await runSync(env, parseSyncRequest(body), opts);
    return json(r.body, r.status);
  } catch (e) {
    if (e instanceof SyncHttpError) return json({ error: e.code, code: e.code }, e.status);
    throw e;
  }
}

/**
 * 灾备规程（sync-design 第 7 节）：物理回滚之后、恢复服务之前执行一次。
 * 所有安装作废，代际与灾备纪元换新随机值；回滚点之后已确认的变化随回滚丢失，可由设备「用这台设备的账本恢复服务器」找回。
 */
export async function disasterRecovery(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE sync_clients SET gone = 1 WHERE gone = 0'),
    rotateGenerationStmt(env),
    env.DB.prepare("UPDATE sync_meta SET value = lower(hex(randomblob(8))) WHERE key = 'drEpoch'"),
  ]);
}

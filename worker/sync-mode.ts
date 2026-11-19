// App 同步的启用状态（docs/sync-api.md「休眠、启用与停用」）。同步表由迁移 0009 建好，但默认休眠：
// 不装触发器，业务写入不碰 sync_objects，自部署只多几张空表。sync_meta.mode 记录状态：
// - off：休眠（默认）。同步接口回 409 sync_disabled。
// - tokens：自部署签发了同步令牌。签发第一个令牌时启用，吊销最后一个时停用。
// - hosted：官方托管经 hosting.ts 的 enableSync 启用，永不随令牌停用（托管不用 sync_tokens）。
// 启用 = 一个原子批次里换代际、按当前账本重建 sync_objects 与 head、装 12 个触发器；
// 停用 = 卸触发器、清空 sync_objects、换代际。两者都换代际，所以停用前拿到的 cookie 之后只会得到 full 整份重拉，不会增量错位；
// sync_clients、sync_rejections、ledgerId、drEpoch 保留，重新启用后设备的执行编号仍去重，旧请求不会重复执行（与恢复备份同一语义）。
// 状态切换的批次首条核对 mode 仍是读时的值（sync_cas），并发的签发、吊销、启用不会交错出「mode 已启用却没装触发器」。
import type { Env } from './env.ts';

export type SyncMode = 'off' | 'tokens' | 'hosted';

export const SYNC_TRIGGERS = [
  'sync_subscriptions_insert',
  'sync_subscriptions_update',
  'sync_subscriptions_delete',
  'sync_methods_insert',
  'sync_methods_update',
  'sync_methods_delete',
  'sync_fx_daily_insert',
  'sync_fx_daily_update',
  'sync_fx_daily_delete',
  'sync_kv_insert',
  'sync_kv_update',
  'sync_kv_delete',
] as const;

// 每个写入方（网页 REST、MCP、同步、定时任务）都在自己的事务里推进序号；同值写入不涨
const TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS sync_subscriptions_insert AFTER INSERT ON subscriptions
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_subscriptions_update AFTER UPDATE ON subscriptions
WHEN OLD.data IS NOT NEW.data OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_subscriptions_delete AFTER DELETE ON subscriptions
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_methods_insert AFTER INSERT ON methods
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_methods_update AFTER UPDATE ON methods
WHEN OLD.data IS NOT NEW.data OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_methods_delete AFTER DELETE ON methods
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_fx_daily_insert AFTER INSERT ON fx_daily
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', NEW.date, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_fx_daily_update AFTER UPDATE ON fx_daily
WHEN OLD.rates IS NOT NEW.rates OR OLD.source IS NOT NEW.source OR OLD.date IS NOT NEW.date
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', OLD.date, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', NEW.date, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_fx_daily_delete AFTER DELETE ON fx_daily
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', OLD.date, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_kv_insert AFTER INSERT ON kv
WHEN NEW.key IN ('settings', 'people')
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('kv', NEW.key, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_kv_update AFTER UPDATE ON kv
WHEN (NEW.key IN ('settings', 'people') OR OLD.key IN ('settings', 'people')) AND (OLD.value IS NOT NEW.value OR OLD.key IS NOT NEW.key)
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) SELECT 'kv', OLD.key, (SELECT seq FROM sync_head), 1 WHERE OLD.key IS NOT NEW.key AND OLD.key IN ('settings', 'people')
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) SELECT 'kv', NEW.key, (SELECT seq FROM sync_head), 0 WHERE NEW.key IN ('settings', 'people')
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;`,
  `CREATE TRIGGER IF NOT EXISTS sync_kv_delete AFTER DELETE ON kv
WHEN OLD.key IN ('settings', 'people')
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('kv', OLD.key, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;`,
];

const ROTATE = "UPDATE sync_meta SET value = lower(hex(randomblob(8))) WHERE key = 'generation'";
const setMode = (mode: SyncMode) => `INSERT INTO sync_meta (key, value) VALUES ('mode', '${mode}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/** 启用的主体（不含核对）：换代际、按当前账本逐个编号补登、head = 对象数、装触发器、记下 mode */
export const enableSql = (mode: Exclude<SyncMode, 'off'>): string[] => [
  ROTATE,
  'DELETE FROM sync_objects',
  `INSERT INTO sync_objects (kind, id, seq, deleted)
SELECT kind, id, ROW_NUMBER() OVER (ORDER BY ord, id), 0 FROM (
  SELECT 'sub' AS kind, id, 1 AS ord FROM subscriptions
  UNION ALL SELECT 'method', id, 2 FROM methods
  UNION ALL SELECT 'kv', key, 3 FROM kv WHERE key IN ('settings', 'people')
  UNION ALL SELECT 'fx', date, 4 FROM fx_daily
)`,
  'UPDATE sync_head SET seq = (SELECT count(*) FROM sync_objects)',
  ...TRIGGER_SQL,
  setMode(mode),
];

/** 停用的主体：卸触发器、清空对象表、head 归零、换代际、mode = off */
export const disableSql = (): string[] => [
  ...SYNC_TRIGGERS.map((n) => `DROP TRIGGER IF EXISTS ${n}`),
  'DELETE FROM sync_objects',
  'UPDATE sync_head SET seq = 0',
  ROTATE,
  setMode('off'),
];

const MODE_SQL = "coalesce((SELECT value FROM sync_meta WHERE key = 'mode'), 'off')";
const stateSql = `SELECT ${MODE_SQL} AS mode, (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (${SYNC_TRIGGERS.map((n) => `'${n}'`).join(', ')})) AS n`;

/**
 * sync_cas 核对失败：只认 sync_cas 的 CHECK（ok = 1），别的约束失败照常抛出。实测文案：
 * D1（workerd）「D1_ERROR: CHECK constraint failed: ok = 1: SQLITE_CONSTRAINT …」；托管 d1-adapter 包一层「D1_ERROR: batch statement i failed: …」；
 * Docker（node:sqlite）与 App d1-shim（系统 sqlite3_errmsg）「CHECK constraint failed: ok = 1」。老版 SQLite 报表名，一并认。
 */
export const isCasError = (e: unknown) => e instanceof Error && /CHECK constraint failed: (?:ok = 1|sync_cas)\b/i.test(e.message);

/** 当前 mode 与已装的同步触发器个数 */
export async function syncState(env: Env): Promise<{ mode: SyncMode; triggers: number }> {
  const r = (await env.DB.prepare(stateSql).all<{ mode: string; n: number }>()).results[0];
  const mode = r?.mode === 'tokens' || r?.mode === 'hosted' ? r.mode : 'off';
  return { mode, triggers: Number(r?.n ?? 0) };
}

export const syncEnabled = (mode: string | undefined) => mode === 'tokens' || mode === 'hosted';

/** 批次首条：mode 仍是 expect，否则整批回滚（CHECK 失败）；extra 是附加条件 SQL，其参数从 ?2 起依次对应 binds */
export const modeCas = (env: Env, expect: SyncMode, extra = '1', ...binds: unknown[]): D1PreparedStatement =>
  env.DB.prepare(`INSERT INTO sync_cas (ok) SELECT ${MODE_SQL} = ?1 AND (${extra})`).bind(expect, ...binds);

export const stmts = (env: Env, sql: string[]): D1PreparedStatement[] => sql.map((s) => env.DB.prepare(s));
export const casTail = (env: Env): D1PreparedStatement => env.DB.prepare('DELETE FROM sync_cas');

/** 原子切换：首条核对 mode 未变，再执行 body；mode 已被别处改了返回 false */
async function switchMode(env: Env, from: SyncMode, body: D1PreparedStatement[]): Promise<boolean> {
  try {
    await env.DB.batch([modeCas(env, from), ...body, casTail(env)]);
    return true;
  } catch (e) {
    if (isCasError(e)) return false;
    throw e;
  }
}

/**
 * 迁移完成后对一次账：mode 与触发器不一致时修正。
 * - off 却装着触发器（0009 旧版装过、本库没有令牌也不是托管）：卸掉并清空对象表。
 * - 已启用却缺触发器（不应出现）：按启用流程重建，换代际。
 * 每个库每个进程只在 ensureMigrated 时跑一次，多一次只读查询。
 */
export async function reconcileSync(env: Env): Promise<void> {
  const { mode, triggers } = await syncState(env);
  if (mode === 'off' && triggers > 0) await switchMode(env, 'off', stmts(env, disableSql()));
  else if (mode !== 'off' && triggers < SYNC_TRIGGERS.length) await switchMode(env, mode, stmts(env, enableSql(mode)));
}

const hosted = new WeakMap<object, Promise<void>>();

/** 忘掉该库的托管启用记录（disasterRecovery 之后调用）：恢复的库 mode 可能回到 off，下一次 enableSync 重新核对 */
export function forgetHostedSync(env: Env): void {
  hosted.delete(env.DB);
}

/**
 * 托管启用（hosting.ts 的 enableSync 在迁移之后调用）：mode 置为 hosted，之后不随令牌停用。
 * 已经是 tokens 且触发器齐全（旧版 0009 一直开着的托管库）时只改 mode，不换代际，已连接的设备照常增量。
 * 按 env.DB 记一次，同一个库重复调用不再查库。
 */
export function enableHostedSync(env: Env): Promise<void> {
  let p = hosted.get(env.DB);
  if (!p) {
    p = (async () => {
      for (let i = 0; i < 5; i++) {
        const { mode, triggers } = await syncState(env);
        const complete = triggers === SYNC_TRIGGERS.length;
        if (mode === 'hosted' && complete) return;
        const body = mode !== 'off' && complete ? stmts(env, [setMode('hosted')]) : stmts(env, enableSql('hosted'));
        if (await switchMode(env, mode, body)) return;
      }
      throw new Error('sync mode kept changing');
    })().catch((e) => {
      hosted.delete(env.DB);
      throw e;
    });
    hosted.set(env.DB, p);
  }
  return p;
}

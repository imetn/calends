// 契约测试的宿主：服务器与每个虚构客户端各一个内存 SQLite，表结构由 Worker 的迁移（worker/migrations.gen.ts）建出，
// 读写全部经同一个 D1 适配层走 Worker 的同步代码（worker/sync.ts、worker/sync-ops.ts）。
// 时间由宿主固定：今天 = 操作的业务日期，updatedAt 等时间戳因此可复现。只用虚构数据。
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Worker 代码会 import JSON（版本号等）；测试进程里按 ES 模块加载
const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { MIGRATIONS } = await import('../../worker/migrations.gen.ts');
const { SYNC_SETTINGS: SETTINGS_LIST } = await import('../../shared/sync-check.ts');
export const worker = {
  ...(await import('../../worker/sync.ts')),
  ...(await import('../../worker/sync-ops.ts')),
  ...(await import('../../worker/sync-store.ts')),
  ...(await import('../../worker/store.ts')),
  ...(await import('../../worker/migrate.ts')),
  ...(await import('../../shared/sync-check.ts')),
};
hook.deregister();

/** 账本对象：只有这些参与同步与比较。kv 只取 settings、people。 */
export const LEDGER_KV = ['settings', 'people'];
export const SYNC_SETTINGS = new Set(SETTINGS_LIST);

// —— 固定时间：无参 new Date() 与 Date.now() 取宿主时间 ——
let nowMs = Date.parse('2026-01-01T12:00:00Z');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(nowMs);
  }
  static now() {
    return nowMs;
  }
}
globalThis.Date = FixedDate;
export function setToday(date) {
  nowMs = RealDate.parse(`${date}T12:00:00Z`);
}
/** 兼容模拟器接口：Worker 的随机数来自 SQLite randomblob 与 crypto，这里不需要种子 */
export function seedEngine() {}

// —— D1 适配层：与 docker/d1.mjs 同口径；外层已有事务时 batch 用保存点，便于客户端把多步放进一个本地事务 ——
function param(v) {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${v}'`);
}
class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args.map(param));
  }
  exec() {
    const s = prep(this.db, this.sql);
    if (s.columns().length) return { success: true, results: s.all(...this.args).map((r) => ({ ...r })), meta: { changes: 0 } };
    const r = s.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first(column) {
    const row = this.exec().results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }
}
let spSeq = 0;
const d1s = new WeakMap();
/** 一个库的 D1 接口（同一个库同一个对象：Worker 按 env.DB 记迁移） */
export function d1(db) {
  let x = d1s.get(db);
  if (x) return x;
  x = {
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      if (db.isTransaction) {
        const sp = `b${++spSeq}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const out = statements.map((s) => s.exec());
          db.exec(`RELEASE ${sp}`);
          return out;
        } catch (e) {
          db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  d1s.set(db, x);
  return x;
}
export const envOf = (db) => ({ DB: d1(db) });

const stmtCache = new WeakMap();
function prep(db, sql) {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
}

/** 模板库：跑一次全部迁移，之后每个副本复制结构与初始行（先灌数据再建触发器），并换新同步身份。 */
const template = (() => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  for (const m of MIGRATIONS) {
    for (const s of m.statements) db.exec(s);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const schema = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END")
    .all();
  const tables = schema.filter((s) => s.type === 'table').map((s) => s.name);
  const data = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
  return { schema, tables, data };
})();

function insertRows(db, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const st = prep(db, `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) st.run(...cols.map((c) => r[c]));
}

/** 新副本：内存库，已迁移；ledgerId、代际、灾备纪元为新随机值。 */
export function newDb() {
  const db = new DatabaseSync(':memory:');
  for (const s of template.schema) if (s.type === 'table') db.exec(s.sql);
  for (const t of template.tables) insertRows(db, t, template.data[t]);
  for (const s of template.schema) if (s.type !== 'table') db.exec(s.sql);
  db.exec("UPDATE sync_meta SET value = lower(hex(randomblob(CASE key WHEN 'ledgerId' THEN 16 ELSE 8 END)))");
  return db;
}

/** 读账本对象：sub/<id>、method/<id>、kv/<key> → data 文本。 */
export function readLedger(db) {
  const m = new Map();
  for (const r of prep(db, 'SELECT id, data FROM subscriptions').all()) m.set(`sub/${r.id}`, r.data);
  for (const r of prep(db, 'SELECT id, data FROM methods').all()) m.set(`method/${r.id}`, r.data);
  for (const r of prep(db, `SELECT key, value FROM kv WHERE key IN (${LEDGER_KV.map(() => '?').join(',')})`).all(...LEDGER_KV)) m.set(`kv/${r.key}`, r.value);
  return m;
}

/** 把账本表整体替换为给定对象集合（客户端 base 重建共用）。 */
export function writeLedger(db, objects) {
  prep(db, 'DELETE FROM subscriptions').run();
  prep(db, 'DELETE FROM methods').run();
  prep(db, `DELETE FROM kv WHERE key IN (${LEDGER_KV.map(() => '?').join(',')})`).run(...LEDGER_KV);
  for (const [key, data] of objects) putObject(db, key, data);
}

export function putObject(db, key, data) {
  const [kind, id] = splitKey(key);
  if (kind === 'sub') prep(db, 'INSERT OR REPLACE INTO subscriptions (id, data) VALUES (?, ?)').run(id, data);
  else if (kind === 'method') prep(db, 'INSERT OR REPLACE INTO methods (id, data) VALUES (?, ?)').run(id, data);
  else prep(db, 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(id, data);
}
export function delObject(db, key) {
  const [kind, id] = splitKey(key);
  if (kind === 'sub') prep(db, 'DELETE FROM subscriptions WHERE id = ?').run(id);
  else if (kind === 'method') prep(db, 'DELETE FROM methods WHERE id = ?').run(id);
  else prep(db, 'DELETE FROM kv WHERE key = ?').run(id);
}
const splitKey = (k) => {
  const i = k.indexOf('/');
  return [k.slice(0, i), k.slice(i + 1)];
};

/** 规范化：JSON 键排序后序列化，比较逐字节相等。 */
export function canonical(objects) {
  const sortDeep = (v) =>
    Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v;
  return [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, d]) => `${k}\t${JSON.stringify(sortDeep(JSON.parse(d)))}`)
    .join('\n');
}

/** 在本地事务里运行 fn；fn 抛错整体回滚。 */
export async function inTx(db, fn) {
  db.exec('BEGIN');
  try {
    const v = await fn();
    db.exec('COMMIT');
    return v;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep(k)));
/** 同步视图：kv/settings 只留白名单字段，投影后为空则视为不存在。比较、下发都用它。 */
export function syncView(objects) {
  const m = new Map(objects);
  const s = m.get('kv/settings');
  if (s !== undefined) {
    const p = pick(JSON.parse(s), (k) => SYNC_SETTINGS.has(k));
    if (Object.keys(p).length) m.set('kv/settings', JSON.stringify(p));
    else m.delete('kv/settings');
  }
  return m;
}
/** 本端私有设置字段（白名单之外）。 */
export function privateSettings(db) {
  const r = prep(db, "SELECT value FROM kv WHERE key = 'settings'").get();
  return r ? pick(JSON.parse(r.value), (k) => !SYNC_SETTINGS.has(k)) : {};
}
/** 用同步视图替换账本，再把本端私有设置字段并回去。 */
export function writeSynced(db, objects, priv = privateSettings(db)) {
  writeLedger(db, syncView(objects));
  if (!Object.keys(priv).length) return;
  const r = prep(db, "SELECT value FROM kv WHERE key = 'settings'").get();
  const cur = r ? JSON.parse(r.value) : {};
  putObject(db, 'kv/settings', JSON.stringify({ ...cur, ...priv }));
}

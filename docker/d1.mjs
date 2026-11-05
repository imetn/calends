// 容器内的 D1：用 node:sqlite 打开数据卷里的 SQLite 文件，只实现 Worker 用到的接口（prepare/bind/first/all/run、batch）。
import { DatabaseSync } from 'node:sqlite';

/** D1 同样拒绝 undefined 和对象参数，这里不能悄悄写成 NULL */
function param(v) {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${v}'`);
}

/** SQL 需要几个参数；字符串字面量和注释里的问号不算 */
function paramCount(sql) {
  let max = 0;
  for (const [, n] of sql.replace(/'[^']*'|--[^\n]*/g, '').matchAll(/\?(\d*)/g)) max = Math.max(max, n ? Number(n) : max + 1);
  return max;
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
  /** all 与 run 在 D1 上是同一件事：都执行语句，有结果列（SELECT、RETURNING）就带回行 */
  exec() {
    // node:sqlite 会把少传的参数当 NULL，D1 则报错；账本不能悄悄写进空值
    const need = paramCount(this.sql);
    if (this.args.length < need) throw new Error(`D1_ERROR: Wrong number of parameter bindings: expected ${need}, got ${this.args.length}`);
    const s = this.db.prepare(this.sql);
    if (s.columns().length) {
      // node:sqlite 的行没有原型，复制成普通对象才与 D1 相同
      const results = s.all(...this.args).map((r) => ({ ...r }));
      const { changes, last_row_id } = this.db.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
      return { success: true, results, meta: { changes, last_row_id } };
    }
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
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_ERROR: no such column: ${column}`);
    return row[column];
  }
}

export function openD1(file) {
  const db = new DatabaseSync(file);
  // 页缓存压到 4MB、不用 mmap，小内存机器上占用才可预期；WAL 与原运行时写出的文件格式一致
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -4096; PRAGMA mmap_size = 0; PRAGMA busy_timeout = 2000;');
  return {
    prepare: (sql) => new Statement(db, sql),
    /** 同步执行，事件循环不会插入别的请求；任何一条失败都整批回滚 */
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        // 磁盘满等错误 SQLite 已自动回滚，再回滚会盖掉原始错误
        if (db.isTransaction) db.exec('ROLLBACK');
        throw e;
      }
    },
    /** 查真实的表：SELECT 1 不碰文件，卷失效了也会成功 */
    ping: () => db.prepare('SELECT count(*) FROM d1_migrations').get(),
    close: () => db.close(),
  };
}

// 远端模式：同一组契约用例经 HTTP 驱动一个部署好的托管服务（本地 wrangler dev 或 staging），而不是进程内的 Worker 代码。
//   SYNC_CONTRACT_BASE_URL=https://…  SYNC_CONTRACT_HOOKS=/abs/path/hooks.ts  node --experimental-strip-types --test scripts/sync-contract.test.mjs
// 钩子模块导出 newLedger() → { headers }：每个被测服务器一个新账本（托管方按自己的方式发令牌，另带测试控制面口令）。
// 服务端须提供（只在测试环境开放）：
//   POST /sync/v1/sync  请求头 x-calends-test-page-bytes 指定分页上限、x-calends-test-dump 列出要回传的表；
//                       响应体 _test = { executed, dump }（提交后执行过的操作 = 进程内的 onCommitted；各表全部行）
//   POST /__test/ledger { action: exec | restoreLedger | disasterRecovery | prepare | commit, dump? }（白盒操作，见 calends-cloud src/ledger-test.ts）
// 用例里同步读取的 db / meta / client / ledgerText / physicalSnapshot 走本地镜像：每次会改库的调用之后按回传的整表刷新。
// 只用虚构数据。令牌与口令只放进请求头，不打印。
import { newDb, readLedger } from './engine.mjs';

const hooks = await import(process.env.SYNC_CONTRACT_HOOKS ?? '');
const BASE = process.env.SYNC_CONTRACT_BASE_URL.replace(/\/$/, '');
/** 同步响应里的测试旁路字段（托管方的测试控制面约定） */
const TEST_FIELD = '_test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const remote = { requests: 0, retries: 0 };

export function remoteServer(LocalServer, { SERVER_PRIVATE, TABLES }) {
  return class RemoteServer extends LocalServer {
    constructor(o) {
      super(o);
      // 镜像只存数据：去掉触发器，按服务器回传的行原样覆盖
      this.db = newDb();
      for (const { name } of this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) this.db.exec(`DROP TRIGGER "${name}"`);
      this.env = null;
      this.initialized = false;
      this.ready = this.init().then(() => {
        this.initialized = true;
      });
      this.ready.catch(() => {});
    }

    async init() {
      this.headers = (await hooks.newLedger()).headers;
      // 与进程内服务器相同的初始状态：服务器私有设置字段 + 一个白名单字段
      await this.control({
        action: 'exec',
        statements: [{ sql: "INSERT INTO kv (key, value) VALUES ('settings', ?)", params: [JSON.stringify({ ...SERVER_PRIVATE, weekStart: 1 })] }],
      });
    }

    async post(path, body, extra = {}) {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          remote.requests++;
          res = await fetch(BASE + path, {
            method: 'POST',
            headers: { ...this.headers, 'content-type': 'application/json', 'x-calends-test-dump': TABLES.join(','), ...extra },
            body: JSON.stringify(body),
          });
        } catch (e) {
          // 网络层失败：请求可能未到达，也可能已执行；只有幂等的白盒操作与同步请求会走到这里，重发即协议本身要处理的重复
          if (attempt >= 4) throw e;
          remote.retries++;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if ((res.status === 429 || res.status === 502 || res.status === 504) && attempt < 4) {
          remote.retries++;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`${path} HTTP ${res.status}：非 JSON 响应 ${text.slice(0, 200)}`);
        }
        return { status: res.status, body: json };
      }
    }

    async control(action) {
      const r = await this.post('/__test/ledger', { ...action, dump: TABLES });
      if (r.status !== 200) throw new Error(`测试控制面 ${action.action} 失败：HTTP ${r.status} ${JSON.stringify(r.body)}`);
      const { dump, ...rest } = r.body;
      this.mirror(dump);
      return rest;
    }

    /** 用服务器回传的整表覆盖镜像 */
    mirror(dump) {
      if (!dump) throw new Error('服务器没有回传表数据（测试口令未生效？）');
      this.db.exec('BEGIN');
      try {
        for (const [t, { columns, rows }] of Object.entries(dump)) {
          this.db.prepare(`DELETE FROM "${t}"`).run();
          if (!rows.length) continue;
          const st = this.db.prepare(`INSERT INTO "${t}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
          for (const r of rows) st.run(...r);
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }

    pageHeader() {
      return Number.isFinite(this.pageBytes) ? { 'x-calends-test-page-bytes': String(this.pageBytes) } : {};
    }

    async sync(req) {
      await this.ready;
      const w = await this.wireBody(req);
      const r = await this.post('/sync/v1/sync', w, this.pageHeader());
      const test = r.body[TEST_FIELD];
      delete r.body[TEST_FIELD];
      if (test) this.mirror(test.dump);
      else if (r.status === 200) throw new Error('同步响应缺少 _test（测试口令未生效？）');
      this.observe(test?.executed ?? [], w);
      return this.unwire(req, r.status, r.body);
    }

    async prepare(req) {
      await this.ready;
      const w = await this.wireBody(req);
      const p = await this.control({ action: 'prepare', body: w });
      return { req, w, p };
    }

    async commit({ req, w, p }) {
      if (p.kind === 'error') return { reqId: req.reqId, error: p.code };
      if (p.kind === 'mismatch') return { reqId: req.reqId, ledgerMismatch: true, ledgerId: p.ledgerId };
      const r = await this.control({ action: 'commit', handle: p.handle, ...(Number.isFinite(this.pageBytes) ? { pageBytes: this.pageBytes } : {}) });
      if (!r.committed) return null;
      if (r.body.gone) return { reqId: req.reqId, ...r.body };
      this.observe(r.executed, w);
      return this.unwire(req, 200, r.body);
    }

    // —— 同步读取：走镜像。账本在构造后异步建好，建好前读到的镜像不可信 ——
    // 建好前远端不会有任何写入（所有改库调用都先等 ready），所以构造后立即拍的快照、备份 = 建好时的状态，延后补齐。

    guard(what) {
      if (!this.initialized) throw new Error(`远端账本尚未建好就读取 ${what}`);
    }
    meta(k) {
      this.guard('meta');
      return super.meta(k);
    }
    client(id) {
      this.guard('client');
      return super.client(id);
    }
    ledgerText() {
      this.guard('ledgerText');
      return super.ledgerText();
    }
    settings() {
      this.guard('settings');
      return super.settings();
    }
    physicalSnapshot() {
      if (this.initialized) return super.physicalSnapshot();
      const snap = { tables: null, oracleMark: this.oracle.mark() };
      snap.done = this.ready.then(() => {
        snap.tables = super.physicalSnapshot().tables;
      });
      return snap;
    }
    takeBackup() {
      if (this.initialized) return super.takeBackup();
      const i = this.backups.push(null) - 1;
      this.ready.then(() => {
        this.backups[i] = readLedger(this.db);
      });
    }

    async restoreBackup(i) {
      await this.ready;
      await this.control({ action: 'restoreLedger', data: this.backupData(i) });
    }

    async physicalRestore(snap) {
      await this.ready;
      await snap.done;
      // 先账本（远端触发器会动同步表），再原样覆盖同步表；一个事务
      const statements = [];
      for (const [t, rows] of Object.entries(snap.tables)) {
        statements.push({ sql: `DELETE FROM "${t}"` });
        for (const r of rows) {
          const cols = Object.keys(r);
          statements.push({
            sql: `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
            params: cols.map((c) => r[c]),
          });
        }
      }
      await this.control({ action: 'exec', statements });
      await this.control({ action: 'disasterRecovery' });
      this.oracle.physicalRollback(snap.oracleMark);
    }
  };
}

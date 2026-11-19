// 被测服务器：calends Worker 的同步实现（worker/sync.ts），库为内存 SQLite 经 D1 适配层。
// 接口与模拟器参考服务器相同，用例可原样驱动：sync / prepare / commit、恢复备份、物理快照与回滚（灾备规程）。
// 线上格式转换只在这里做：模拟器的操作翻译成线上操作，响应里的文档序列化回文本，fx/ 对象与 fx 字段不参与比较。
// 设了 SYNC_CONTRACT_BASE_URL 时改为远端模式（remote-server.mjs）：同一组用例经 HTTP 驱动一个部署好的托管服务。
import { canonical, envOf, newDb, readLedger, syncView, worker } from './engine.mjs';
import { toWire } from './ops.mjs';

const { runSync, prepareSync, commitSync, changesSince, disasterRecovery, parseSyncRequest, ensureMigrated, loadState, restoreLedger, enableSql } = worker;

export const SERVER_PRIVATE = { channels: [{ id: 'mail', secret: 'srv-secret-fictional' }], notifyEmail: 'owner@example.test' };
const SYNC_TABLES = ['sync_meta', 'sync_head', 'sync_objects', 'sync_clients', 'sync_rejections'];
const LEDGER_TABLES = ['subscriptions', 'methods', 'kv', 'fx_daily'];

class LocalServer {
  /** flags 只为与模拟器同形；服务器侧的 naive 错误写法无法在真实实现上打开（见 cases.mjs 的 SERVER_NAIVE）。 */
  constructor({ oracle, flags = {}, pageBytes = Infinity }) {
    this.db = newDb();
    this.env = envOf(this.db);
    this.oracle = oracle;
    this.flags = flags;
    this.pageBytes = pageBytes;
    this.day = 0;
    // 同步默认休眠；被测服务器按托管方式启用（与 hosting.ts 的 enableSync 同一组语句），再写入的行经触发器推进序号
    for (const sql of enableSql('hosted')) this.db.exec(sql);
    // 服务器私有设置字段（渠道凭据等）与一个白名单字段；经触发器正常推进序号
    this.db.prepare("INSERT INTO kv (key, value) VALUES ('settings', ?)").run(JSON.stringify({ ...SERVER_PRIVATE, weekStart: 1 }));
    this.backups = [];
    this.hooks = {};
  }

  meta(k) {
    if (k === 'head') return String(this.db.prepare('SELECT seq FROM sync_head').get()?.seq ?? 0);
    return this.db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(k)?.value;
  }
  client(id) {
    return this.db.prepare('SELECT * FROM sync_clients WHERE install_id = ?').get(id);
  }

  /** 模拟器请求 → 线上请求体（经 Worker 的整请求校验） */
  async wire(req) {
    return parseSyncRequest(await this.wireBody(req));
  }
  /** 模拟器请求 → 未校验的线上 JSON（远端模式原样 POST） */
  async wireBody(req) {
    const mutations = [];
    for (const m of req.mutations) mutations.push({ mid: m.mid, op: { ...(await toWire(m.op)), tid: m.op.tid, kind: m.op.kind, imported: m.op.objects } });
    return {
      protocol: 1,
      reqId: String(req.reqId),
      installId: req.installId,
      ledgerId: req.ledgerId ?? null,
      drEpoch: req.drEpoch ?? null,
      cookie: req.cookie ?? null,
      ackedMid: req.ackedMid ?? 0,
      register: !!req.register,
      mutations,
    };
  }
  /** 线上响应 → 模拟器响应：文档序列化为文本，丢掉汇率对象 */
  unwire(req, status, body) {
    if (status === 503) throw new Error('503: 重算 3 次仍冲突');
    if (status !== 200) return { reqId: req.reqId, error: body.code ?? body.error };
    const res = { ...body, reqId: req.reqId };
    delete res.fx;
    if (res.objects) res.objects = res.objects.filter(([k]) => !k.startsWith('fx/')).map(([k, d]) => [k, d === null ? null : JSON.stringify(d)]);
    return res;
  }
  observe(executed, wire) {
    for (const e of executed) {
      const m = wire.mutations.find((x) => x.op.tid === e.tid);
      if (e.ok && m?.op.kind === 'import_ledger') this.checkImport(e.tid, m.op.imported);
      this.oracle.executed(e.tid, e.ok, e.code);
    }
  }
  /** 设备账本导入执行后，服务器同步视图必须逐字节等于导入内容 */
  checkImport(tid, objects) {
    this.oracle.imported?.(tid, this.ledgerText() === canonical(new Map(objects)));
  }

  /** POST /sync = prepare + commit；提交守卫失败重算，3 次仍冲突 503 */
  async sync(req) {
    const w = await this.wire(req);
    let executed = [];
    const r = await runSync(this.env, w, { pageBytes: this.pageBytes, onCommitted: (e) => (executed = e), beforeCommit: this.hooks.beforeCommit });
    this.observe(executed, w);
    return this.unwire(req, r.status, r.body);
  }

  /** 读快照 + 在内存行上执行，不写库（与别的请求、恢复备份、物理回滚可交错） */
  async prepare(req) {
    await ensureMigrated(this.env);
    const w = await this.wire(req);
    if (w.mutations.length) await loadState(this.env);
    return { req, w, p: await prepareSync(this.env, w) };
  }
  /** 一个 batch 提交；快照变了返回 null，由调用方重算 */
  async commit({ req, w, p }) {
    if (p.kind === 'error') return { reqId: req.reqId, error: p.code };
    if (p.kind === 'mismatch') return { reqId: req.reqId, ledgerMismatch: true, ledgerId: p.ledgerId };
    if (!(await commitSync(this.env, w, p))) return null;
    if (p.kind === 'gone') return { reqId: req.reqId, ledgerId: p.ledgerId, drEpoch: p.drEpoch, gone: { lastMutationId: p.last, rejections: p.rejections } };
    this.observe(p.executed, w);
    const page = await changesSince(this.env, w.cookie, this.pageBytes);
    const body = {
      ledgerId: p.ledgerId,
      drEpoch: p.drEpoch,
      lastMutationId: p.last,
      expected: p.expected,
      rejections: [...p.rejections, ...p.fresh].filter((r) => r.mid > w.ackedMid),
      ...page,
    };
    return this.unwire(req, 200, body);
  }

  // —— 故障与运维事件 ——

  takeBackup() {
    this.backups.push(readLedger(this.db));
  }
  /** 网页「恢复备份」：Worker 的 restoreLedger（整本替换 + 换代际）；sync_clients / sync_rejections 不动 */
  async restoreBackup(i) {
    await restoreLedger(this.env, this.backupData(i));
  }
  /** 备份 → 网页「恢复备份」的上传内容 */
  backupData(i) {
    const snap = this.backups[i];
    const docs = (p) => [...snap].filter(([k]) => k.startsWith(p)).map(([, d]) => JSON.parse(d));
    return {
      subscriptions: docs('sub/'),
      methods: docs('method/'),
      people: JSON.parse(snap.get('kv/people') ?? '[]'),
      settings: snap.has('kv/settings') ? JSON.parse(snap.get('kv/settings')) : undefined,
      fxDaily: [],
    };
  }

  /** 物理快照（D1 Time Travel / Docker 卷）：整库，包括同步表 */
  physicalSnapshot() {
    const tables = Object.fromEntries([...LEDGER_TABLES, ...SYNC_TABLES].map((t) => [t, this.db.prepare(`SELECT * FROM "${t}"`).all()]));
    return { tables, oracleMark: this.oracle.mark() };
  }
  /** 物理回滚后执行灾备规程（disasterRecovery）：所有安装作废，代际与灾备纪元换新 */
  async physicalRestore(snap) {
    this.db.exec('BEGIN');
    try {
      // 先账本（触发器会动同步表），再原样覆盖同步表
      for (const t of [...LEDGER_TABLES, ...SYNC_TABLES]) {
        this.db.prepare(`DELETE FROM "${t}"`).run();
        const rows = snap.tables[t];
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const st = this.db.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const r of rows) st.run(...cols.map((c) => r[c]));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    await disasterRecovery(this.env);
    this.oracle.physicalRollback(snap.oracleMark);
  }

  /** 比较用：同步视图（白名单投影） */
  ledgerText() {
    return canonical(syncView(readLedger(this.db)));
  }
  settings() {
    return JSON.parse(readLedger(this.db).get('kv/settings') ?? '{}');
  }
}

export const Server = process.env.SYNC_CONTRACT_BASE_URL
  ? (await import('./remote-server.mjs')).remoteServer(LocalServer, { SERVER_PRIVATE, TABLES: [...LEDGER_TABLES, ...SYNC_TABLES] })
  : LocalServer;

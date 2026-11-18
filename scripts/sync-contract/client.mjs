// v3.1 参考客户端：本地 base + 待推队列，乐观执行，响应到达后以 base 重放未确认操作。
// 持久状态存在本地库 client_state 表里，与 live 账本同一个本地事务提交；崩溃 = 重启后从该表读回。
// 写入资格（sync-design 3.3）：新安装身份先做一次无操作的注册拉取，绑定 ledgerId 后才发操作；每个请求带上次见过的灾备纪元。
// 问题列表只有「查看」与「丢弃」（三轮收口）：要保留本地改动，用户在界面上重新编辑一次，就是一个全新的操作。
import { newDb, readLedger, writeLedger, putObject, inTx, canonical, syncView, writeSynced, privateSettings } from './engine.mjs';
import { applyOp } from './ops.mjs';

let installSeq = 0;
let reSeq = 0;
let recSeq = 0;

const ser = (s) => JSON.stringify({ ...s, base: [...s.base], created: [...s.created] });
const de = (t) => {
  const s = JSON.parse(t);
  return { ...s, base: new Map(s.base), created: new Set(s.created) };
};
/** 操作指向的对象键：问题列表据此展示服务器当前内容。 */
export const keyOf = (op) =>
  ({ create_sub: `sub/${op.id}`, patch_sub: `sub/${op.id}`, delete_sub: `sub/${op.id}`, pay: `sub/${op.sub}`, delete_pay: `sub/${op.sub}`,
    create_method: `method/${op.id}`, delete_method: `method/${op.id}`, top_up: `method/${op.method}`, set_balance: `method/${op.method}`,
    create_person: 'kv/people', delete_person: 'kv/people', set_setting: 'kv/settings', put_object: op.key, replace: op.key })[op.kind] ?? null;

/** 首连合并上传的对象撞了 id：换新 id 重新上传（对象并存，不覆盖远端）。 */
const renamed = (op) => {
  const [kind, id] = op.key.split('/');
  const nid = `${id}-n${++reSeq}`;
  return { ...op, key: `${kind}/${nid}`, data: JSON.stringify({ ...JSON.parse(op.data), id: nid }), tid: `${op.tid}:n${reSeq}` };
};

export class Client {
  constructor({ name, rng, oracle, flags = {}, newId, lang }) {
    this.name = name;
    this.rng = rng;
    this.oracle = oracle;
    this.flags = flags;
    this.newId = newId;
    this.install = `${name}#${++installSeq}`;
    this.db = newDb(); // live：界面看到的账本
    this.db.exec('CREATE TABLE client_state(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    this.lang = lang ?? `zh-${name}`;
    putObject(this.db, 'kv/settings', JSON.stringify({ language: this.lang })); // 手机私有设置字段
    const id = newId();
    this.s = {
      installId: id,
      registered: false, // 本安装身份是否已在服务器注册（注册请求不带操作）
      drEpoch: null, // 上次见过的灾备纪元；注册请求也带上
      ledgerId: null, // 绑定的账本身份：(服务器来源, ledgerId)
      connected: true,
      firstConnect: false,
      connectSnap: null, // 首连发起时的本地账本：合并以它为准
      held: [], // 首连完成前的本地操作：合并之后才入队编号 {op, pre}
      localTids: [], // 断开期间归本地的操作：首连合并时报告由谁覆盖（观测用）
      nextMid: 1,
      queue: [], // {mid, op, sent, pre?}
      base: new Map(),
      cookie: null,
      ackedMid: 0,
      problems: [], // {tid, kind, code, detail, op, key, recoveryId?}
      created: new Set(), // 观测用：本安装创建过的操作 tid（随状态一起被克隆、备份）
      history: [], // 已确认、可撤销的操作 {op, pre}
      recoveries: [], // 作废或换账本时的本机账本 {id, objects}，只追加：再次作废不覆盖未处理的旧副本
    };
    this.save();
    this.marker = id; // 设备本地、不进备份的标记（isExcludedFromBackup 文件）
    this.outstanding = null; // 易失：在途请求 id
    this.staging = null; // 易失：分页拉取的暂存 {base, cookie}
    this.online = true;
    this.alive = true;
  }

  save(s = this.s) {
    this.db.prepare('INSERT OR REPLACE INTO client_state(id, v) VALUES (1, ?)').run(ser(s));
  }
  /** 进程重启：易失状态清空，持久状态从本地库读回。 */
  restart() {
    this.s = de(this.db.prepare('SELECT v FROM client_state WHERE id = 1').get().v);
    this.outstanding = null;
    this.staging = null;
  }
  /** 一个本地事务：live 重建（可选）+ 状态落盘。crash：'mid' 事务中途崩溃，'after' 提交后、内存赋值前崩溃。 */
  async commit(next, { rebuild = true, crash = false } = {}) {
    try {
      await inTx(this.db, async () => {
        if (rebuild) await this.rebuildInto(next);
        this.save(next);
        if (crash === 'mid') throw new Crash();
      });
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      this.restart();
      return false;
    }
    if (crash === 'after') {
      this.restart(); // 已落盘，但设备标记来不及写：下次启动按克隆处理
      return false;
    }
    if (next.installId !== this.s.installId) this.marker = next.installId; // 设备标记在本地事务提交后再写
    this.s = next;
    return true;
  }
  /** live = base + 重放全部待确认操作；本端私有设置字段原地保留。本地重放失败的操作仍留在队列：结果以服务器为准。 */
  async rebuildInto(s) {
    if (this.flags.naiveWhitelist) writeLedger(this.db, s.base);
    else writeSynced(this.db, s.base);
    for (const q of s.queue) await applyOp(this.db, q.op);
  }
  /** 首连合并完成前 live 是本地真相，不能用 base 重建。 */
  rebuilds(s) {
    return s.connected && !s.firstConnect;
  }

  // —— 克隆与整机备份 ——
  snapshotState() {
    return { ...structuredClone(this.s), live: readLedger(this.db) };
  }
  /** 从整机备份或克隆源得到一份新安装：持久状态照搬，设备本地标记丢失。 */
  static fromSnapshot(snap, opts) {
    const c = new Client(opts);
    const { live, ...s } = structuredClone(snap);
    c.s = s;
    writeLedger(c.db, live);
    c.lang = privateSettings(c.db).language;
    c.save();
    c.marker = opts.flags?.naiveClone ? s.installId : null;
    return c;
  }

  problem(next, q, code, detail, extra = {}) {
    const key = keyOf(q.op);
    next.problems.push({ tid: q.op.tid, kind: q.op.kind, code, detail, op: q.op, key, ...extra });
  }
  /** 未确认操作转入问题列表，不自动上传。cover：其效果已包含在恢复副本 recId 里的编号。 */
  toProblems(next, code, rej = new Map(), L = 0, cover = new Set(), recId = null) {
    for (const q of next.queue) {
      if (q.op.kind === 'noop') continue;
      const extra = cover.has(q.mid) && recId ? { recoveryId: recId } : {};
      if (rej.has(q.mid)) this.problem(next, q, rej.get(q.mid).code, rej.get(q.mid).detail, extra);
      else if (q.mid <= L) this.confirmed(next, q);
      else this.problem(next, q, code, null, extra);
    }
    for (const h of next.held) this.problem(next, h, code, null);
    next.queue = [];
    next.held = [];
  }
  confirmed(next, q) {
    this.oracle.confirmed(q.op.tid);
    if (q.op.kind === 'import_ledger') this.importConfirmed(next, q.op);
    next.history.push({ op: q.op, pre: q.pre });
    if (next.history.length > 20) next.history.shift();
  }
  /** 服务器确认导入后才清恢复副本，并只解决该副本确实覆盖的问题。 */
  importConfirmed(next, op) {
    const solved = next.problems.filter((p) => p.recoveryId && p.recoveryId === op.recoveryId);
    next.problems = next.problems.filter((p) => !solved.includes(p));
    for (const p of solved) this.oracle.resolved(p.tid, op.tid);
    next.recoveries = next.recoveries.filter((r) => r.id !== op.recoveryId);
  }
  /** 换新安装身份（克隆、作废、换账本、重连）：编号从 1 起，先注册再推。 */
  newIdentity(next) {
    next.installId = this.newId();
    next.registered = false;
    next.nextMid = 1;
    next.ackedMid = 0;
    next.cookie = null;
    this.staging = null;
    this.outstanding = null; // 旧身份的在途响应一律作废
  }

  /** 启动检查：本地 installId 与设备标记不符 → 克隆或整机恢复。换新 id，旧 id 下未确认的操作进问题列表。 */
  async checkIdentity() {
    if (this.marker === this.s.installId) return;
    const next = structuredClone(this.s);
    this.toProblems(next, 'unconfirmed');
    this.newIdentity(next);
    await this.commit(next, { rebuild: this.rebuilds(next) });
  }

  /** 用户在界面上做一个操作：乐观执行 + 入队，一个本地事务。also(next)：同事务里顺带改的状态。 */
  async localOp(op, { crash = false, also } = {}) {
    await this.checkIdentity();
    const next = structuredClone(this.s);
    try {
      await inTx(this.db, async () => {
        const pre = op.kind === 'patch_sub' ? this.db.prepare('SELECT data FROM subscriptions WHERE id = ?').get(op.id)?.data : undefined;
        const r = await applyOp(this.db, op);
        if (r.code === 'bug') throw new Error(`engine bug on client: ${r.detail}`);
        if (!r.ok) throw new LocalReject();
        if (!next.connected) next.localTids.push({ tid: op.tid, key: keyOf(op), kind: op.kind, id: op.id });
        else if (next.firstConnect) next.held.push({ op, pre });
        else next.queue.push({ mid: next.nextMid++, op, sent: false, pre });
        next.created.add(op.tid);
        also?.(next);
        this.save(next);
        if (crash) throw new Crash();
      });
    } catch (e) {
      if (e instanceof LocalReject) return false; // 界面直接报错，不入队
      if (e instanceof Crash) {
        this.restart();
        return false;
      }
      throw e;
    }
    this.s = next;
    this.oracle.created(op.tid, this.install);
    if (!next.connected && !this.flags.naiveReconnect) this.oracle.localized(op.tid); // 断开期间：本地即真相，重连时走首连合并
    return true;
  }

  /** 撤销一个还没发出过的操作：同一 mutationId 换成 noop，绝不删除或复用编号。 */
  async cancelPending() {
    const next = structuredClone(this.s);
    if (this.flags.naiveCancel) {
      const q = next.queue.pop();
      if (!q) return null;
      next.nextMid = q.mid;
      this.oracle.cancelled(q.op.tid);
      await this.commit(next, { rebuild: this.rebuilds(next) });
      return q.op.tid;
    }
    const cands = next.queue.filter((q) => !q.sent && q.op.kind !== 'noop');
    if (!cands.length) return null;
    const q = cands[Math.floor(this.rng() * cands.length)];
    this.oracle.cancelled(q.op.tid);
    q.op = { kind: 'noop', at: q.op.at, tid: q.op.tid + ':cancel' };
    await this.commit(next, { rebuild: this.rebuilds(next) });
    return true;
  }

  /** 问题列表展示的「服务器当前内容」：每次从当前 base 取，不用问题创建时的快照。 */
  problemView(i) {
    const p = this.s.problems[i];
    return p.key ? (this.s.base.get(p.key) ?? null) : null;
  }

  /** 处理问题：discard 丢弃。只有首连合并冲突另有 keep_local（受保护的 replace，期望 = 当前展示的服务器内容）。
   *  其他问题没有重新提交：用户要保留本地改动，就在界面上照常再编辑一次（新操作，期望取当时 base）。 */
  async resolve(i, action) {
    const p = this.s.problems[i];
    const drop = (next) => next.problems.splice(next.problems.findIndex((x) => x.tid === p.tid), 1);
    if (action === 'discard') {
      const next = structuredClone(this.s);
      drop(next);
      await this.commit(next, { rebuild: false });
      this.oracle.discarded(p.tid);
      return null;
    }
    if (action !== 'keep_local' || p.code !== 'merge_conflict') throw new Error(`no such action: ${action} on ${p.code}`);
    const op = { kind: 'replace', key: p.key, data: p.op.data, expect: this.s.base.get(p.key) ?? null, at: p.op.at, tid: `${p.tid}:keep${++reSeq}` };
    const ok = await this.localOp(op, { also: drop });
    if (!ok) return null; // 本地执行不了：问题保留
    this.oracle.resolved(p.tid, op.tid);
    return op;
  }

  /** 「用这台设备的账本恢复服务器」：作废时留下的本机账本作为一个显式整本替换操作上传。
   *  恢复副本与问题保留到服务器确认导入；撤销、被拒、再次作废都不清。 */
  async restoreServerFromDevice({ at, tid, recoveryId }) {
    const rec = recoveryId ? this.s.recoveries.find((r) => r.id === recoveryId) : this.s.recoveries.at(-1);
    if (!rec || this.s.queue.some((q) => q.op.kind === 'import_ledger' && q.op.recoveryId === rec.id)) return null;
    const op = { kind: 'import_ledger', objects: structuredClone(rec.objects), recoveryId: rec.id, at, tid };
    return (await this.localOp(op)) ? op : null;
  }

  /** 断开（服务器 → 本机）：本地账本即全部数据；清空 base、队列、cookie、绑定。 */
  async disconnect() {
    const next = structuredClone(this.s);
    next.connected = false;
    if (!this.flags.naiveReconnect) {
      for (const q of [...next.queue, ...next.held]) {
        if (q.op.kind === 'noop') continue;
        this.oracle.localized(q.op.tid);
        next.localTids.push({ tid: q.op.tid, key: keyOf(q.op), kind: q.op.kind, id: q.op.id });
      }
      Object.assign(next, { queue: [], held: [], base: new Map(), cookie: null, ackedMid: 0, ledgerId: null, firstConnect: false, connectSnap: null });
    }
    this.staging = null;
    this.outstanding = null;
    await this.commit(next, { rebuild: false });
  }
  /** 再连：一律走首次连接（新 installId、注册、全量拉取、以此刻的本地快照二路合并）。naiveReconnect 沿用旧 base / 队列 / cookie。 */
  async reconnect() {
    const next = structuredClone(this.s);
    next.connected = true;
    if (!this.flags.naiveReconnect) {
      next.firstConnect = true;
      next.connectSnap = [...syncView(readLedger(this.db))];
      this.newIdentity(next);
    }
    await this.commit(next, { rebuild: false });
  }

  /** 生成一次同步请求；断开时不同步。未注册：只发无操作的注册拉取。 */
  async buildRequest(reqId) {
    if (!this.s.connected) return null;
    await this.checkIdentity();
    const s = this.s;
    this.outstanding = reqId;
    const cookie = this.staging ? this.staging.cookie : s.cookie;
    const ledgerId = this.flags.naiveLedger ? null : s.ledgerId;
    if (!s.registered && !this.flags.naiveLedger)
      return { reqId, register: true, installId: s.installId, ledgerId, drEpoch: s.drEpoch, cookie, ackedMid: 0, mutations: [] };
    if (s.queue.some((q) => !q.sent)) {
      for (const q of s.queue) q.sent = true; // 发送前落盘
      this.save();
    }
    return { reqId, installId: s.installId, ledgerId, drEpoch: s.drEpoch, cookie, ackedMid: s.ackedMid, mutations: s.queue.map((q) => ({ mid: q.mid, op: q.op })) };
  }

  /** 独立重放 base + 队列，返回本地执行成功的编号：这些操作的效果包含在 live 里。 */
  async replayOk(s) {
    const fresh = newDb();
    const ok = new Set();
    await inTx(fresh, async () => {
      writeSynced(fresh, s.base, privateSettings(this.db));
      for (const q of s.queue) if ((await applyOp(fresh, q.op)).ok) ok.add(q.mid);
    });
    return ok;
  }

  /** 处理响应。crash：'before' 处理前崩溃；'mid' / 'after' 见 commit。返回 changed / ok / more / reset / stale / crash。 */
  async onResponse(res, { crash = false } = {}) {
    if (!this.flags.naiveStale && res.reqId !== this.outstanding) return 'stale';
    this.outstanding = null;
    if (res.error) throw new Error(`protocol error: ${res.error}`);
    if (crash === 'before') {
      this.staging = null;
      return 'crash';
    }
    const next = structuredClone(this.s);
    if (res.ledgerMismatch || res.gone) {
      // 换账本：旧队列一条不发。作废（灾备回滚）：≤ L 且未被拒的算已确认，其余进问题列表。都换新身份、全量拉取。
      if (next.firstConnect) {
        // 首连尚未完成（注册拉取遇到作废）：本地仍是真相，首连快照与 held 保留，换身份重新注册。
      } else {
        const recId = `rec${++recSeq}`;
        next.recoveries.push({ id: recId, objects: [...syncView(readLedger(this.db))] }); // 追加，不覆盖旧副本
        const cover = await this.replayOk(next); // 本地执行成功的编号：其效果在恢复副本里
        if (res.ledgerMismatch) {
          this.toProblems(next, 'ledger_changed', new Map(), 0, cover, recId);
          next.base = new Map();
          next.ledgerId = res.ledgerId;
        } else if (this.flags.naiveDrDrop) {
          next.queue = []; // 错误写法：作废后把未确认的也当已确认丢掉
        } else this.toProblems(next, 'unconfirmed', new Map(res.gone.rejections.map((r) => [r.mid, r])), res.gone.lastMutationId, cover, recId);
      }
      next.drEpoch = res.ledgerMismatch ? null : res.drEpoch; // 作废：采用服务器当前纪元重新注册；换账本：另一台服务器
      this.newIdentity(next);
      return (await this.commit(next, { crash, rebuild: this.rebuilds(next) })) ? 'reset' : 'crash';
    }
    // 分页：暂存到最后一页才提交；遇到全量（含换代）丢弃暂存从头来。
    const st = res.full ? new Map() : this.staging ? this.staging.base : new Map(next.base);
    for (const [k, d] of res.objects) {
      if (d === null) st.delete(k);
      else st.set(k, d);
    }
    if (res.more) {
      this.staging = crash ? null : { base: st, cookie: res.cookie };
      return crash ? 'crash' : 'more';
    }
    this.staging = null;
    if (!next.ledgerId) next.ledgerId = res.ledgerId;
    next.registered = true;
    if (res.drEpoch) next.drEpoch = res.drEpoch;
    const L = res.lastMutationId;
    const rej = new Map(res.rejections.map((r) => [r.mid, r]));
    const again = [];
    for (const q of next.queue) {
      if (q.mid > L || q.op.kind === 'noop') continue;
      if (rej.has(q.mid) && q.op.merge && rej.get(q.mid).code === 'id_conflict') again.push(q.op); // 首连上传撞 id：换新 id，不进问题列表
      else if (rej.has(q.mid)) this.problem(next, q, rej.get(q.mid).code, rej.get(q.mid).detail);
      else this.confirmed(next, q);
    }
    next.queue = next.queue.filter((q) => q.mid > L);
    for (const op of again) {
      const nop = renamed(op);
      next.queue.push({ mid: next.nextMid++, op: nop, sent: false });
      next.created.add(nop.tid);
      this.oracle.created(nop.tid, this.install);
      this.oracle.resolved(op.tid, nop.tid);
    }
    next.ackedMid = Math.max(next.ackedMid, L);
    const changed = canonical(st) !== canonical(next.base);
    next.base = st;
    next.cookie = res.cookie;
    if (next.firstConnect) this.mergeFirstConnect(next);
    return (await this.commit(next, { crash })) ? (changed ? 'changed' : 'ok') : 'crash';
  }

  /** 首连二路合并（sync-design 9.4 的简化），以发起首连时的本地快照为准：
   *  本地独有的对象整条上传；同 id 不同内容交给用户（保留本地 = 受保护的 replace）；人员按 id 并集；设置取服务器。
   *  首连期间的本地操作排在合并之后。 */
  mergeFirstConnect(next) {
    next.firstConnect = false;
    const local = new Map(next.connectSnap ?? []);
    const at = this.today ?? '2026-01-05';
    const cover = new Map(); // 对象键 / 人员 id → 覆盖它的操作 tid | 'equal'
    const push = (op) => {
      const full = { ...op, at, merge: true, tid: `${this.install}:merge${++reSeq}` };
      next.queue.push({ mid: next.nextMid++, op: full, sent: false });
      next.created.add(full.tid);
      this.oracle.created(full.tid, this.install);
      return full.tid;
    };
    // naiveMerge：二轮之前的写法，被首连期间的本地操作碰过的键不上传（审查二轮 #3 的反例）。
    const touched = new Set(this.flags.naiveMerge ? next.held.map((h) => keyOf(h.op)) : []);
    for (const [k, d] of local) {
      if (!k.startsWith('sub/') && !k.startsWith('method/')) continue;
      if (touched.has(k)) continue;
      if (!next.base.has(k)) cover.set(k, push({ kind: 'put_object', key: k, data: d }));
      else if (next.base.get(k) === d) cover.set(k, 'equal');
      else {
        const tid = `${this.install}:merge${++reSeq}`;
        const op = { kind: 'replace', key: k, data: d, expect: next.base.get(k), at, tid };
        next.problems.push({ tid, kind: 'merge', code: 'merge_conflict', detail: d, op, key: k });
        next.created.add(tid);
        this.oracle.created(tid, this.install);
        cover.set(k, tid);
      }
    }
    const srvPeople = JSON.parse(next.base.get('kv/people') ?? '[]');
    const localPeople = JSON.parse(local.get('kv/people') ?? '[]');
    for (const p of localPeople)
      cover.set(`person/${p.id}`, srvPeople.some((x) => x.id === p.id) ? 'equal' : push({ kind: 'create_person', id: p.id, name: p.name }));
    // 观测：断开期间归本地的每个操作由谁覆盖。删除与设置按设计不传播（二路合并没有共同祖先；设置取服务器）。
    for (const l of next.localTids) {
      const k = l.kind === 'create_person' ? `person/${l.id}` : l.key;
      const present = l.kind === 'create_person' ? localPeople.some((p) => p.id === l.id) : local.has(l.key);
      const design = l.kind.startsWith('delete_') || l.kind === 'set_setting' || !present; // 之后本地又删掉的对象：不传播
      const by = cover.get(k) ?? (design ? 'design' : null);
      if (by) this.oracle.cover(l.tid, by);
    }
    next.localTids = [];
    for (const h of next.held) next.queue.push({ mid: next.nextMid++, op: h.op, sent: false, pre: h.pre });
    next.held = [];
    next.connectSnap = null;
  }

  idle() {
    return this.s.queue.length === 0 && this.s.held.length === 0 && !this.s.firstConnect && this.s.registered && !this.staging;
  }
  /** 恢复副本里某个对象的文本（默认最新一份）。 */
  recoveryDoc(key, i = -1) {
    return new Map(this.s.recoveries.at(i)?.objects ?? []).get(key);
  }
  ledgerText() {
    return canonical(syncView(readLedger(this.db)));
  }
  baseText() {
    return canonical(this.s.base);
  }
  /** 独立核对：用一个新库把 base 写入再重放队列，结果必须与 live 逐字节相同（含私有字段）。 */
  async replayText() {
    const fresh = newDb();
    await inTx(fresh, async () => {
      if (this.flags.naiveWhitelist) writeLedger(fresh, this.s.base);
      else writeSynced(fresh, this.s.base, privateSettings(this.db));
      for (const q of this.s.queue) await applyOp(fresh, q.op);
    });
    return canonical(readLedger(fresh));
  }
  fullText() {
    return canonical(readLedger(this.db));
  }
}

class LocalReject extends Error {}
class Crash extends Error {}

// 移植自 iOS 仓库 spikes/sync-sim/sim.mjs，服务器换成 calends Worker（server.mjs）；commit 改为异步。
// 模拟世界：1 服务器 + 3 客户端（克隆、整机恢复会产生更多安装），网络层故障注入，静止后检查不变量。
import { seedEngine, SYNC_SETTINGS, privateSettings } from './engine.mjs';
import { view, inverseOf } from './ops.mjs';
import { Server } from './server.mjs';
import { Client } from './client.mjs';

const YEAR_DAYS = 365;
/** 这些问题码表示「客户端无法确认结果」，操作可能实际已执行，不算误报。 */
const UNKNOWN_CODES = new Set(['unconfirmed', 'ledger_changed', 'merge_conflict']);

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY0 = Date.parse('2026-01-05T00:00:00Z');
export const dateOf = (d) => new Date(DAY0 + d * 86400000).toISOString().slice(0, 10);

export class Violation extends Error {
  constructor(kind, message) {
    super(`${kind}: ${message}`);
    this.kind = kind;
  }
}

/** 观测：记录每个操作在服务器上的真实执行（旁路，不属于协议）。 */
export class Oracle {
  constructor() {
    this.ok = new Map(); // tid → 成功执行次数
    this.rejected = new Map(); // tid → code
    this.cancelledSet = new Set();
    this.drReverted = new Set();
    this.log = []; // [tid, ok]
    this.owner = new Map();
    this.forkedSet = new Set(); // 被克隆或整机恢复复制过的待推操作：撤销只作用于本安装那一份
    this.confirmedSet = new Set(); // 客户端按 ≤ L 认定已确认、移出队列的操作
    this.discardedSet = new Set(); // 用户在问题列表里丢弃
    this.resolvedTo = new Map(); // tid → [新 tid]：首连冲突保留本地、首连撞 id 换新 id，或服务器确认的设备账本导入覆盖了它
    this.localizedSet = new Set(); // 断开期间的操作或断开时队列里的操作：本地即真相，重连走首连合并
    this.coverOf = new Map(); // 归本地的 tid → [首连合并里覆盖它的 tid | 'equal' | 'design']
  }
  confirmed(tid) {
    this.confirmedSet.add(tid);
  }
  discarded(tid) {
    this.discardedSet.add(tid);
  }
  resolved(tid, to) {
    this.resolvedTo.set(tid, [...(this.resolvedTo.get(tid) ?? []), to]);
  }
  cover(tid, by) {
    this.coverOf.set(tid, [...(this.coverOf.get(tid) ?? []), by]);
  }
  /** 设备账本导入执行后，服务器同步视图必须逐字节等于导入内容。 */
  imported(tid, equal) {
    if (!equal) throw new Violation('import-mismatch', `${tid} 导入后服务器账本与恢复副本不同`);
  }
  localized(tid) {
    this.localizedSet.add(tid);
  }
  forked(tids) {
    for (const t of tids) this.forkedSet.add(t);
  }
  created(tid, install) {
    this.owner.set(tid, install);
  }
  cancelled(tid) {
    this.cancelledSet.add(tid);
  }
  executed(tid, ok, code) {
    this.log.push([tid, ok]);
    if (ok) {
      const n = (this.ok.get(tid) ?? 0) + 1;
      this.ok.set(tid, n);
      if (n > 1) throw new Violation('double-exec', `${tid} 在服务器上成功执行了 ${n} 次`);
      if (this.cancelledSet.has(tid) && !this.forkedSet.has(tid)) throw new Violation('cancel-ignored', `${tid} 已撤销却被执行`);
    } else {
      this.rejected.set(tid, code);
    }
  }
  mark() {
    return this.log.length;
  }
  /** 物理回滚抹掉了快照之后的执行：未确认的必须进问题列表；已被客户端确认的随回滚丢失（文档承诺：可从设备恢复）。 */
  physicalRollback(mark) {
    for (const [tid, ok] of this.log.slice(mark)) {
      if (ok) this.ok.set(tid, (this.ok.get(tid) ?? 1) - 1);
      else this.rejected.delete(tid);
      this.drReverted.add(tid);
    }
    this.log.length = mark;
  }
}

const W = (pairs, rng) => {
  const total = pairs.reduce((a, [w]) => a + w, 0);
  let x = rng() * total;
  for (const [w, v] of pairs) if ((x -= w) < 0) return v;
  return pairs[pairs.length - 1][1];
};

export class World {
  constructor(seed, { flags = {}, faults = {}, trace = false, pageBytes } = {}) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    seedEngine(seed ^ 0x9e3779b9);
    this.flags = flags;
    this.faults = { dropReq: 0.06, dropRes: 0.1, crash: 0.03, interleave: 0.15, ...faults };
    this.trace = trace ? [] : null;
    this.oracle = new Oracle();
    this.day = 0;
    this.ids = 0;
    this.newId = () => `i${++this.ids}`;
    // 分页：多数轮次不分页，部分轮次每页只放几条或一条（单条超限也单独成页）
    this.pageBytes = pageBytes ?? W([[2, Infinity], [1, 700], [1, 1]], this.rng);
    this.server = new Server({ rng: this.rng, oracle: this.oracle, flags, pageBytes: this.pageBytes });
    this.clients = ['A', 'B', 'C'].map((name) => this.mkClient(name));
    this.inflight = [];
    this.pending = []; // 已 prepare、尚未 commit 的服务器请求（模拟 D1 / Docker 的读算写交错）
    this.reqs = 0;
    this.tids = 0;
    this.deviceBackups = new Map();
    this.pitr = null;
    this.stats = {};
  }
  mkClient(name) {
    return new Client({ name, rng: this.rng, oracle: this.oracle, flags: this.flags, newId: this.newId });
  }
  clientOpts(name) {
    return { name, rng: this.rng, oracle: this.oracle, flags: this.flags, newId: this.newId };
  }
  log(...a) {
    if (this.trace) this.trace.push(`[d${this.day}] ` + a.join(' '));
  }
  count(k) {
    this.stats[k] = (this.stats[k] ?? 0) + 1;
  }
  pick(arr) {
    return arr[Math.floor(this.rng() * arr.length)];
  }
  alive() {
    return this.clients.filter((c) => c.alive);
  }
  nextTid(c, tag = '') {
    return `${c.install}:${tag}${++this.tids}`;
  }

  // —— 用户操作 ——
  genOp(c) {
    const v = view(c.db);
    const r = this.rng;
    const at = dateOf(this.day);
    const tid = this.nextTid(c);
    const u = `${this.seed}-${this.tids}`;
    const cand = [];
    if (v.methods.length < 3) cand.push([3, () => ({ kind: 'create_method', id: `m${u}`, name: `Wallet ${u}`, balance: this.pick([0, 50, 100]) })]);
    if (v.subs.length < 6) cand.push([4, () => ({ kind: 'create_sub', id: `s${u}`, name: `Svc ${u}`, price: this.pick([5, 9.99]), method: v.methods.length && r() < 0.7 ? this.pick(v.methods).id : null })]);
    if (v.subs.length) {
      cand.push([4, () => {
        const s = this.pick(v.subs);
        const f = this.pick(['notes', 'name', 'url']);
        const to = f === 'url' ? `https://x.test/${this.pick(['a', 'b'])}` : `${f}-${this.pick(['a', 'b', 'c'])}`;
        return { kind: 'patch_sub', id: s.id, fields: { [f]: { from: s[f] ?? null, to } } };
      }]);
      cand.push([1, () => ({ kind: 'delete_sub', id: this.pick(v.subs).id })]);
      cand.push([5, () => ({ kind: 'pay', sub: this.pick(v.subs).id, amount: this.pick([5, 9.99]) })]);
      const paid = v.subs.filter((s) => s.payments?.length);
      if (paid.length)
        cand.push([2, () => {
          const s = this.pick(paid);
          const p = this.pick(s.payments);
          return { kind: 'delete_pay', sub: s.id, date: p.date, amount: p.amount, expect: { count: s.payments.filter((x) => x.date === p.date && x.amount === p.amount).length } };
        }]);
    }
    if (v.methods.length) {
      cand.push([2, () => ({ kind: 'top_up', method: this.pick(v.methods).id, amount: this.pick([10, 20]) })]);
      cand.push([2, () => {
        const m = this.pick(v.methods);
        return { kind: 'set_balance', method: m.id, balance: this.pick([0, 50, 80, 100]), expect: { balance: m.balance ?? null, balanceAsOf: m.balanceAsOf ?? null } };
      }]);
      cand.push([0.5, () => ({ kind: 'delete_method', id: this.pick(v.methods).id })]);
    }
    if (v.people.length < 3) cand.push([1, () => ({ kind: 'create_person', id: `p${u}`, name: `Person ${u}` })]);
    if (v.people.length) cand.push([0.5, () => ({ kind: 'delete_person', id: this.pick(v.people).id })]);
    cand.push([1.5, () => {
      const f = this.pick(['weekStart', 'displayName']);
      const to = f === 'weekStart' ? this.pick([0, 1]) : this.pick(['Ann', 'Bo']);
      return { kind: 'set_setting', fields: { [f]: { from: v.settings[f] ?? null, to } } };
    }]);
    return { ...W(cand, r)(), at, tid };
  }

  async userOp(c, opts = {}) {
    const op = opts.op ?? this.genOp(c);
    const crash = opts.crash ?? this.rng() < this.faults.crash;
    const ok = await c.localOp(op, { crash });
    this.log(c.install, crash ? 'CRASH-in-local-tx' : ok ? 'op' : 'op-refused', op.kind, op.tid);
    this.count(crash ? 'crash_local' : ok ? 'ops' : 'ops_refused_locally');
    return ok ? op : null;
  }

  /** 撤销最近一个已确认的可逆操作。naiveUndo：整条替换，期望 = 当前 base（v3 写法）。 */
  async undo(c) {
    const h = [...c.s.history].reverse().find((x) => inverseOf(x.op));
    if (!h) return null;
    const base = { at: dateOf(this.day), tid: this.nextTid(c, 'undo') };
    const op =
      this.flags.naiveUndo && h.op.kind === 'patch_sub' && h.pre
        ? { kind: 'replace', key: `sub/${h.op.id}`, data: h.pre, expect: c.s.base.get(`sub/${h.op.id}`) ?? null, ...base }
        : { ...inverseOf(h.op), ...base };
    c.s.history = c.s.history.filter((x) => x !== h);
    return this.userOp(c, { op, crash: false });
  }

  // —— 网络 ——
  endpoint(c) {
    return c.endpoint ?? this.server;
  }
  async startSync(c) {
    c.today = dateOf(this.day);
    const req = await c.buildRequest(++this.reqs);
    if (!req) {
      this.count('send_disconnected');
      return null;
    }
    if (!c.online) {
      c.outstanding = null; // 断网：请求立即失败，客户端知道
      this.count('send_offline');
      return null;
    }
    this.inflight.push({ to: 'server', srv: this.endpoint(c), from: c, msg: req });
    this.log(c.install, 'send', `req${req.reqId}`, `${req.installId} ack=${req.ackedMid} muts=${req.mutations.map((m) => m.mid).join(',')}`);
    return req;
  }
  /** 服务器回包：检查线上载荷不含白名单外的设置字段。 */
  respond(from, res, faults) {
    if (res.error) throw new Violation('protocol-error', `服务器拒绝请求：${res.error}`);
    const s = res.objects?.find(([k]) => k === 'kv/settings')?.[1];
    if (s && Object.keys(JSON.parse(s)).some((k) => !SYNC_SETTINGS.has(k))) throw new Violation('private-leak', `响应里出现白名单外的设置字段：${s}`);
    if (faults && this.rng() < this.faults.dropRes) {
      this.count('drop_res');
      this.log('drop res (server executed)', res.reqId, `L=${res.lastMutationId}`);
      return;
    }
    this.inflight.push({ to: from, msg: res });
  }
  async deliver(i, { faults = true } = {}) {
    const m = this.inflight.splice(i, 1)[0];
    if (m.to === 'server') {
      if (faults && this.rng() < this.faults.dropReq) {
        this.count('drop_req');
        this.log('drop req', m.msg.reqId);
        return;
      }
      m.srv.day = this.day;
      if (faults && this.rng() < this.faults.interleave) {
        // 只做 prepare，提交留到之后的随机时刻（期间别的请求、恢复备份、物理回滚都可能先提交）
        this.pending.push({ p: await m.srv.prepare(m.msg), srv: m.srv, from: m.from });
        this.count('prepare_only');
        return;
      }
      return this.respond(m.from, await m.srv.sync(m.msg), faults);
    }
    const c = m.to;
    if (!c.alive || !c.online) {
      this.count('drop_res_offline');
      return;
    }
    c.today = dateOf(this.day);
    const crash = faults && this.rng() < this.faults.crash ? this.pick(['before', 'mid', 'after']) : false;
    const r = await c.onResponse(m.msg, { crash });
    this.count(`res_${r}`);
    this.log(c.install, 'recv', `res${m.msg.reqId}`, r, m.msg.gone ? 'GONE' : m.msg.ledgerMismatch ? 'LEDGER' : `L=${m.msg.lastMutationId} rej=${m.msg.rejections?.length} more=${m.msg.more}`);
    if (r !== 'stale' && this.rng() < 0.3) await this.checkReplay(c);
    return r;
  }
  /** 提交一个挂起的 prepare：快照变了就重算（commit 返回 null）。 */
  async commitPending(i, { faults = true } = {}) {
    const { p, srv, from } = this.pending.splice(i, 1)[0];
    srv.day = this.day;
    const res = (await srv.commit(p)) ?? (this.count('cas_retry'), await srv.sync(p.req));
    this.respond(from, res, faults);
  }
  /** 仍有待推操作时的独立核对：live 必须等于「base 写入新库 + 重放队列」。 */
  async checkReplay(c) {
    if (!c.s.connected || c.s.firstConnect) return; // 首连合并完成前 live 是本地真相
    if ((await c.replayText()) !== c.fullText()) throw new Violation('replay-mismatch', `${c.install} live 与 base+队列重放不同（队列 ${c.s.queue.length} 条）`);
  }

  // —— 一步随机事件 ——
  async step() {
    const r = this.rng;
    const act = W(
      [
        [30, 'op'], [18, 'sync'], [26, 'deliver'], [3, 'dup'], [3, 'drop'], [4, 'offline'], [4, 'day'], [5, 'commit'],
        [2, 'srvBackup'], [1.2, 'srvRestore'], [1, 'clone'], [1.2, 'devBackup'], [0.7, 'devRestore'],
        [0.5, 'longOffline'], [1.2, 'pitrSnap'], [0.8, 'pitrRestore'], [2, 'cancel'], [4, 'undo'], [4, 'resolve'],
        [0.5, 'disconnect'], [3, 'reconnect'], [3, 'importDevice'],
      ],
      r,
    );
    const live = this.alive();
    const c = this.pick(live);
    switch (act) {
      case 'op':
        return this.userOp(c);
      case 'sync':
        return this.startSync(c);
      case 'deliver':
        if (this.inflight.length) return this.deliver(Math.floor(r() * this.inflight.length));
        return;
      case 'commit':
        if (this.pending.length) return this.commitPending(Math.floor(r() * this.pending.length));
        return;
      case 'dup':
        if (this.inflight.length) {
          this.inflight.push({ ...this.pick(this.inflight) });
          this.count('dup');
        }
        return;
      case 'drop':
        if (this.inflight.length) {
          this.inflight.splice(Math.floor(r() * this.inflight.length), 1);
          this.count('drop_any');
        }
        return;
      case 'offline':
        c.online = !c.online;
        this.count(c.online ? 'online' : 'offline');
        return;
      case 'day':
        this.day += 1 + Math.floor(r() * 3);
        return;
      case 'srvBackup':
        this.server.takeBackup();
        this.count('srv_backup');
        return;
      case 'srvRestore':
        if (this.server.backups.length) {
          await this.server.restoreBackup(Math.floor(r() * this.server.backups.length));
          this.count('srv_restore');
          this.log('SERVER restore backup');
        }
        return;
      case 'clone':
        if (live.length < 6) {
          this.oracle.forked([...c.s.queue, ...c.s.held].map((q) => q.op.tid));
          const k = Client.fromSnapshot(c.snapshotState(), this.clientOpts(c.name + "'"));
          this.clients.push(k);
          this.count('clone');
          this.log('CLONE', c.install, '->', k.install);
        }
        return;
      case 'devBackup':
        this.deviceBackups.set(c, { snap: c.snapshotState(), day: this.day });
        this.count('dev_backup');
        return;
      case 'devRestore': {
        const b = this.deviceBackups.get(c);
        if (!b) return;
        // 原设备抹掉，用旧整机备份恢复（同一台或新机）：持久状态回退，设备标记不在备份里。
        c.alive = false;
        this.oracle.forked([...b.snap.queue, ...b.snap.held].map((q) => q.op.tid));
        const k = Client.fromSnapshot(b.snap, this.clientOpts(c.name + 'R'));
        this.clients.push(k);
        this.deviceBackups.delete(c);
        this.count('dev_restore');
        this.log('DEVICE RESTORE', c.install, '->', k.install);
        return;
      }
      case 'longOffline':
        // v3.1 不再按年龄回收：离线一年后回来照常同步，迟到的旧请求靠 mid ≤ last 跳过。
        c.online = false;
        this.day += YEAR_DAYS + 1 + Math.floor(r() * 30);
        this.count('long_offline');
        this.log('LONG OFFLINE', c.install);
        return;
      case 'pitrSnap':
        this.pitr = this.server.physicalSnapshot();
        return;
      case 'pitrRestore':
        if (this.pitr) {
          await this.server.physicalRestore(this.pitr);
          this.pitr = null;
          this.count('pitr_restore');
          this.log('SERVER physical rollback');
        }
        return;
      case 'cancel':
        if (await c.cancelPending()) this.count('cancel');
        return;
      case 'undo':
        if (await this.undo(c)) this.count('undo');
        return;
      case 'resolve':
        if (c.s.problems.length) {
          const i = Math.floor(r() * c.s.problems.length);
          // 问题只有丢弃；首连合并冲突另可保留本地。用户「重新编辑」就是普通的随机操作。
          await c.resolve(i, c.s.problems[i].code === 'merge_conflict' && r() < 0.5 ? 'keep_local' : 'discard');
          this.count('resolve');
        }
        return;
      case 'disconnect':
        if (c.s.connected) {
          await c.disconnect();
          this.count('disconnect');
          this.log('DISCONNECT', c.install);
        }
        return;
      case 'reconnect':
        if (!c.s.connected) {
          await c.reconnect();
          this.count('reconnect');
          this.log('RECONNECT', c.install);
        }
        return;
      case 'importDevice':
        if (c.s.recoveries.length && (await c.restoreServerFromDevice({ at: dateOf(this.day), tid: this.nextTid(c, 'import'), recoveryId: c.s.recoveries[Math.floor(r() * c.s.recoveries.length)].id }))) {
          this.count('import_device');
          this.log('RESTORE SERVER FROM DEVICE', c.install);
        }
        return;
    }
  }

  /** 网络恢复、迟到消息与挂起提交全部处理、断开的设备重连、全员同步到静止。 */
  async settle() {
    for (const c of this.clients) c.online = true;
    for (const c of this.alive()) if (!c.s.connected) await c.reconnect();
    for (let pass = 0; pass < 80; pass++) {
      while (this.pending.length) await this.commitPending(0, { faults: false });
      while (this.inflight.length) await this.deliver(Math.floor(this.rng() * this.inflight.length), { faults: false });
      let quiet = true;
      for (const c of this.alive()) {
        const req = await this.startSync(c);
        const i = this.inflight.findIndex((m) => m.msg === req);
        await this.deliver(i, { faults: false }); // 请求
        const j = this.inflight.findIndex((m) => m.msg.reqId === req.reqId && m.to === c);
        const r = await this.deliver(j, { faults: false }); // 响应
        if (r !== 'ok' || !c.idle()) quiet = false;
      }
      if (quiet) return pass;
    }
    throw new Violation('no-quiescence', '80 轮同步后仍未静止：' + this.alive().map((c) => `${c.install} q=${c.s.queue.map((q) => q.mid)}`).join('; '));
  }

  check() {
    const srv = this.server.ledgerText();
    const live = this.alive();
    for (const c of live) {
      const base = c.s.base.get('kv/settings');
      const priv = privateSettings(c.db);
      if ((base && Object.keys(JSON.parse(base)).some((k) => !SYNC_SETTINGS.has(k))) || 'channels' in priv)
        throw new Violation('private-leak', `${c.install} 拿到了服务器私有设置字段`);
      if (priv.language !== c.lang) throw new Violation('private-lost', `${c.install} 手机私有字段 language 被覆盖：${priv.language} ≠ ${c.lang}`);
      if (c.ledgerText() !== srv) throw new Violation('diverged', `${c.install} 本地账本与服务器不同\n--- server\n${srv}\n--- ${c.install}\n${c.ledgerText()}`);
      if (c.baseText() !== srv) throw new Violation('diverged', `${c.install} base 与服务器不同`);
      if (!c.idle()) throw new Violation('no-quiescence', `${c.install} 队列未清空`);
    }
    const srvPriv = this.server.settings();
    if (!srvPriv.channels) throw new Violation('private-lost', '服务器私有字段 channels 丢失');
    const visible = new Set(live.flatMap((c) => c.s.problems.map((p) => p.tid)));
    const o = this.oracle;
    // 去向核对：每个本安装创建的操作必须有交代。重新提交、首连覆盖不再无条件豁免，而是追到接手的那个操作。
    const accounted = (tid, seen = new Set()) => {
      if (seen.has(tid)) return false;
      seen.add(tid);
      const ok = o.ok.get(tid) ?? 0;
      if (o.cancelledSet.has(tid)) {
        if (ok && !o.forkedSet.has(tid)) throw new Violation('cancel-ignored', `${tid} 撤销后仍被执行`);
        return true;
      }
      if (ok === 1 || visible.has(tid) || o.discardedSet.has(tid)) return true;
      // 灾备：回滚抹掉的执行。客户端已确认过的 = 文档写明的丢失（可从设备恢复）。
      if (o.drReverted.has(tid) && o.confirmedSet.has(tid)) return true;
      if ((o.resolvedTo.get(tid) ?? []).some((t) => accounted(t, seen))) return true;
      if ((o.coverOf.get(tid) ?? []).some((t) => t === 'equal' || t === 'design' || accounted(t, seen))) return true;
      return false;
    };
    for (const c of live) {
      for (const tid of c.s.created) {
        if (accounted(tid)) continue;
        if (o.localizedSet.has(tid) && !o.coverOf.has(tid)) throw new Violation('merge-loss', `${tid}（${c.install}）断开期间的操作在首连合并里没有被任何操作覆盖`);
        if (o.rejected.has(tid)) throw new Violation('silent-loss', `${tid} 被服务器拒绝（${o.rejected.get(tid)}），但任何存活安装的问题列表里都没有`);
        throw new Violation('silent-loss', `${tid}（${c.install}）既未在服务器执行、也不在任何问题列表里${o.drReverted.has(tid) ? '（灾备回滚抹掉且客户端未确认）' : ''}${o.resolvedTo.has(tid) || o.coverOf.has(tid) ? '（接手的操作也丢了）' : ''}`);
      }
    }
    for (const c of live) for (const p of c.s.problems) if (!UNKNOWN_CODES.has(p.code) && (o.ok.get(p.tid) ?? 0) > 0) throw new Violation('false-problem', `${p.tid} 已成功执行却显示为 ${p.code}`);
  }

  async run(steps) {
    for (let i = 0; i < steps; i++) await this.step();
    await this.settle();
    this.check();
  }
}

/** 一轮：给定种子，可选截断步数（用于缩小复现）。 */
export async function round(seed, { flags, steps, trace } = {}) {
  const w = new World(seed, { flags, trace });
  const n = steps ?? 20 + Math.floor(mulberry32(seed ^ 0x51ed)() * 50);
  try {
    await w.run(n);
    return { ok: true, steps: n, stats: w.stats, oracle: { exec: w.oracle.ok.size, rejected: w.oracle.rejected.size } };
  } catch (e) {
    if (!(e instanceof Violation)) throw e;
    return { ok: false, steps: n, kind: e.kind, message: e.message, trace: w.trace };
  }
}

/** 缩小：同一种子取最短的失败前缀（随机序列相同，截断步数就是前缀）。 */
export async function shrink(seed, flags, steps) {
  let best = steps;
  for (let n = 1; n < steps; n++) {
    const r = await round(seed, { flags, steps: n });
    if (!r.ok) {
      best = n;
      break;
    }
  }
  return best;
}

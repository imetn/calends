// 移植自 iOS 仓库 spikes/sync-sim/cases.mjs（61 个固定用例），服务器换成 calends Worker 的同步实现，用例正文不变。
// 固定用例：时序问题、每种故障各一个、v3 审查的每个实测反例各一个，手工编排消息顺序。
// 每个用例结尾都做静止 + 全部不变量检查；naive 用例证明对应的错误写法会被抓到。
// 服务器侧的 naive 错误写法只存在于参考服务器，真实实现无法打开：这些半边记为 ServerNaive 跳过（正确写法的半边照常运行）。
// 客户端侧的 naive（naiveCancel、naiveClone 等）照常运行：客户端仍是参考实现，只是执行引擎换成 Worker 的同一段代码。
import { World, Violation, dateOf } from './sim.mjs';
import { Client } from './client.mjs';
import { Server, SERVER_PRIVATE } from './server.mjs';
import { view } from './ops.mjs';
import { readLedger, privateSettings, SYNC_SETTINGS } from './engine.mjs';

const NOFAULT = { dropReq: 0, dropRes: 0, crash: 0, interleave: 0 };
// 三轮反例的写法：绕过网络队列直接把请求交给服务器，便于重放旧包。
let rid = 900000;
const rawRound = async (w, c) => c.onResponse(await w.server.sync(await c.buildRequest(++rid)));
async function drain(w, c) {
  for (let i = 0; i < 30; i++) {
    await rawRound(w, c);
    if (c.idle()) return;
  }
  throw new Error('not idle');
}

/** 只有参考服务器才有的错误写法 */
export const SERVER_NAIVE = ['naiveRejections', 'naivePitr', 'naiveGen', 'naiveLedger', 'naivePage', 'naiveWhitelist', 'naiveCas', 'naiveImportGen'];
export class ServerNaive extends Error {}
/** 当前用例已建成的世界数：抛 ServerNaive 时大于 0 = 正确写法的半边已跑完 */
export const progress = { built: 0 };

class T {
  constructor(seed = 7, flags = {}, { pageBytes = Infinity } = {}) {
    const bad = SERVER_NAIVE.filter((f) => flags[f]);
    if (bad.length) throw new ServerNaive(bad.join(','));
    progress.built++;
    this.w = new World(seed, { flags, faults: NOFAULT, trace: true, pageBytes });
    [this.A, this.B, this.C] = this.w.clients;
    this.n = 0;
  }
  async op(c, op, opts = {}) {
    const full = { at: dateOf(this.w.day), tid: `${c.install}:${op.kind}:${++this.n}`, ...op };
    const ok = await this.w.userOp(c, { op: full, crash: opts.crash ?? false });
    return ok ? full : null;
  }
  /** 发一个同步请求。新安装身份先透明地做一轮注册（无操作的拉取）；raw：不代做注册。 */
  async send(c, { raw = false } = {}) {
    if (!raw && c.s.connected && !c.s.registered && !c.flags.naiveLedger) {
      await c.checkIdentity();
      if (!c.s.registered) {
        const reg = await this.w.startSync(c);
        if (!reg) return null; // 断网 / 断开
        await this.cli(await this.srv(reg));
      }
    }
    return this.w.startSync(c);
  }
  /** 请求到服务器；dropRes：服务器执行了但响应丢失；keep：网络里留一份副本（重复投递）。返回响应消息。 */
  async srv(req, { dropRes = false, keep = false } = {}) {
    const i = this.w.inflight.findIndex((m) => m.msg === req);
    const m = keep ? this.w.inflight[i] : this.w.inflight.splice(i, 1)[0];
    m.srv.day = this.w.day;
    const res = await m.srv.sync(m.msg);
    if (!dropRes) this.w.inflight.push({ to: m.from, msg: res });
    return res;
  }
  async cli(res, { crash = false } = {}) {
    const i = this.w.inflight.findIndex((m) => m.msg === res);
    const m = this.w.inflight.splice(i, 1)[0];
    return m.to.onResponse(res, { crash });
  }
  async round(c, opts) {
    const res = await this.srv(await this.send(c), opts);
    return opts?.dropRes ? res : this.cli(res);
  }
  /** 整机克隆 / 迁移：持久状态照搬，设备标记丢失。 */
  clone(src, name, snap = src.snapshotState()) {
    this.w.oracle.forked([...snap.queue, ...snap.held].map((q) => q.op.tid));
    const k = Client.fromSnapshot(snap, this.w.clientOpts(name));
    this.w.clients.push(k);
    return k;
  }
  async done() {
    await this.w.settle();
    this.w.check();
  }
  srvView(srv = this.w.server) {
    return view(srv.db);
  }
  subs(srv) {
    return this.srvView(srv).subs.map((s) => s.id).sort();
  }
  balance(id, srv) {
    return this.srvView(srv).methods.find((m) => m.id === id)?.balance;
  }
  pays(sub) {
    return JSON.parse(readLedger(this.w.server.db).get(`sub/${sub}`)).payments ?? [];
  }
  probs(c) {
    return c.s.problems.map((p) => [p.tid, p.code]);
  }
  execCount(tid) {
    return this.w.oracle.ok.get(tid) ?? 0;
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const S = (id, extra = {}) => ({ kind: 'create_sub', id, name: `Svc ${id}`, price: 9.99, method: null, ...extra });
const M = (id, balance = 100) => ({ kind: 'create_method', id, name: `Card ${id}`, balance });

export const cases = {
  async F01_丢响应后重发() {
    const t = new T();
    const o = await t.op(t.A, S('s1'));
    await t.round(t.A, { dropRes: true });
    await t.round(t.A);
    eq(t.execCount(o.tid), 1, '执行次数');
    await t.done();
  },
  async F02_重复投递() {
    const t = new T();
    const o = await t.op(t.A, S('s1'));
    const req = await t.send(t.A);
    await t.srv(req, { keep: true });
    await t.srv(req);
    eq(t.execCount(o.tid), 1, '执行次数');
    await t.done();
  },
  async F03_乱序与过期响应() {
    const t = new T();
    await t.op(t.A, S('s1'));
    const r1 = await t.send(t.A);
    const o2 = await t.op(t.A, { kind: 'pay', sub: 's1', amount: 9.99 });
    const r2 = await t.send(t.A);
    const res2 = await t.srv(r2);
    const res1 = await t.srv(r1); // 旧请求后到
    eq(await t.cli(res2), 'changed', '新响应');
    eq(await t.cli(res1), 'stale', '旧响应被忽略');
    eq(t.execCount(o2.tid), 1, '执行次数');
    await t.done();
  },
  async F04_确认前缀迟到() {
    const t = new T();
    const os = [await t.op(t.A, S('s1')), await t.op(t.A, S('s2')), await t.op(t.A, S('s3'))];
    await t.round(t.A, { dropRes: true });
    const o4 = await t.op(t.A, S('s4'));
    const res = await t.srv(await t.send(t.A));
    eq(res.lastMutationId, 4, 'L');
    await t.cli(res);
    for (const o of [...os, o4]) eq(t.execCount(o.tid), 1, o.tid);
    await t.done();
  },
  async F05_断网离线操作() {
    const t = new T();
    t.A.online = false;
    await t.op(t.A, S('s1'));
    eq(await t.send(t.A), null, '断网发送失败');
    await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { notes: { from: null, to: 'x' } } });
    await t.done();
    eq(t.srvView().subs[0].notes, 'x', '离线补丁生效');
  },
  async F06_恢复备份在旧批次之后() {
    // 旧批次已执行并确认，随后网页恢复了更早的备份 → 代际变化，全量重拉；已确认的操作随备份消失（恢复的语义，不重放）。
    const t = new T();
    await t.op(t.A, S('s0'));
    await t.round(t.A);
    t.w.server.takeBackup();
    await t.op(t.A, S('s1'));
    await t.round(t.A);
    await t.w.server.restoreBackup(0);
    await t.op(t.B, S('s2'));
    await t.done();
    eq(t.subs(), ['s0', 's2'], '恢复后账本');
  },
  async F07_跨代在途() {
    const t = new T();
    t.w.server.takeBackup();
    await t.op(t.A, S('s1'));
    const res = await t.srv(await t.send(t.A));
    await t.w.server.restoreBackup(0);
    await t.cli(res);
    await t.done();
    eq(t.srvView().subs.length, 0, '恢复抹掉 s1');
  },
  async F08_同id同内容新建() {
    // 同一新建 id、冻结内容相同 → 第二次视为已体现。
    const t = new T();
    await t.op(t.A, S('dup1'));
    await t.op(t.B, S('dup1'));
    await t.done();
    eq(t.srvView().subs.length, 1, '只有一份');
    eq(t.probs(t.A).length + t.probs(t.B).length, 0, '无问题');
  },
  async F09_跨对象副作用重放() {
    // A 本地充值（余额由 runway 重算，依赖支付），B 先推了一笔扣款；A 在充值仍待推时收到含扣款的响应，live 必须等于 base + 重放。
    const t = new T();
    await t.op(t.A, M('m1'));
    await t.op(t.A, S('s1', { method: 'm1' }));
    await t.round(t.A);
    await t.round(t.B);
    await t.op(t.B, { kind: 'pay', sub: 's1', amount: 9.99 });
    await t.round(t.B);
    const req = await t.send(t.A); // 空批次
    await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 }); // 请求在途时新增
    await t.cli(await t.srv(req));
    eq(t.A.s.queue.length, 1, '充值仍待推');
    eq(await t.A.replayText(), t.A.fullText(), '待推时 live = base + 重放');
    await t.done();
  },
  async F10_一批多次修改同一对象() {
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { notes: { from: null, to: 'a' } } });
    await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { notes: { from: 'a', to: 'b' } } });
    await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { name: { from: 'Svc s1', to: 'n2' } } });
    await t.round(t.A);
    eq([t.srvView().subs[0].notes, t.srvView().subs[0].name], ['b', 'n2'], '最终版本');
    await t.done();
  },
  async F11_同日同额两笔扣款() {
    // 审查 #11：不做业务去重。两台设备同日同额各记一笔 = 两笔。断言精确笔数、金额与归属。
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.done();
    const before = t.pays('s1').length;
    const oa = await t.op(t.A, { kind: 'pay', sub: 's1', amount: 9.99 });
    const ob = await t.op(t.B, { kind: 'pay', sub: 's1', amount: 9.99 });
    await t.done();
    const pays = t.pays('s1');
    eq(pays.length, before + 2, '恰好多两笔');
    eq(pays.filter((p) => p.date === oa.at && p.amount === 9.99).length >= 2, true, '两笔都是当日 9.99');
    eq([t.execCount(oa.tid), t.execCount(ob.tid)], [1, 1], '各执行一次');
    eq(t.probs(t.A).length + t.probs(t.B).length, 0, '不算冲突');
  },
  async F12_补丁原值冲突() {
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.done();
    const oa = await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { name: { from: 'Svc s1', to: 'A' } } });
    await t.op(t.B, { kind: 'patch_sub', id: 's1', fields: { name: { from: 'Svc s1', to: 'B' } } });
    await t.round(t.B);
    await t.round(t.A);
    eq(t.probs(t.A), [[oa.tid, 'field_changed']], 'A 的问题列表');
    await t.done();
    eq(t.srvView().subs[0].name, 'B', '服务器值');
  },
  async F13_绝对读数期望不符() {
    const t = new T();
    await t.op(t.A, M('m1'));
    await t.done();
    const m = view(t.A.db).methods[0];
    const ex = { balance: m.balance, balanceAsOf: m.balanceAsOf ?? null };
    const oa = await t.op(t.A, { kind: 'set_balance', method: 'm1', balance: 50, expect: ex });
    await t.op(t.B, { kind: 'set_balance', method: 'm1', balance: 80, expect: ex });
    await t.round(t.B);
    await t.round(t.A);
    eq(t.A.s.problems.map((p) => p.code), ['expect_failed'], 'A 被拒');
    eq(t.execCount(oa.tid), 0, 'A 未执行');
    await t.done();
  },
  async F14_目标已删() {
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.done();
    await t.op(t.B, { kind: 'delete_sub', id: 's1' });
    await t.op(t.A, { kind: 'pay', sub: 's1', amount: 5 });
    await t.round(t.B);
    await t.round(t.A);
    eq(t.A.s.problems.map((p) => p.code), ['target_deleted'], 'A 的问题');
    await t.done();
  },
  async F15_拒绝结果的响应丢失() {
    // 拒绝按客户端声明的 ackedMid 下发；响应丢了下次还要再给。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveRejections: true } : {});
      await t.op(t.A, S('s1'));
      await t.done();
      await t.op(t.B, { kind: 'delete_sub', id: 's1' });
      await t.round(t.B);
      const o = await t.op(t.A, { kind: 'pay', sub: 's1', amount: 5 });
      await t.round(t.A, { dropRes: true });
      await t.round(t.A);
      eq(t.A.s.problems.some((p) => p.tid === o.tid), !naive, naive ? 'naive 应丢失拒绝' : '拒绝应可见');
      if (!naive) await t.done();
      else await expectViolation(t, 'silent-loss');
    }
  },
  async F16_整机克隆不认领() {
    // v3.1 删除认领：克隆换新 installId 全量拉取，旧 id 下未确认的操作进问题列表（附服务器当前内容），不自动上传。
    const t = new T();
    const s1 = await t.op(t.A, S('s1'));
    const s2 = await t.op(t.A, S('s2'));
    await t.round(t.A, { dropRes: true }); // 1..2 已执行但 A 不知道
    const s3 = await t.op(t.A, S('s3'));
    const k = t.clone(t.A, "A'");
    await t.op(k, S('k1'));
    await t.op(t.A, S('a4'));
    await t.done();
    eq(t.subs(), ['a4', 'k1', 's1', 's2', 's3'], '源设备补推全部，克隆只推自己的新操作');
    eq(t.probs(k), [s1, s2, s3].map((o) => [o.tid, 'unconfirmed']), '克隆的问题列表');
    for (const o of [s1, s2, s3]) eq(t.execCount(o.tid), 1, o.tid);
  },
  async F17_链式克隆加物理回滚() {
    // 审查 #1：A 排队充值 20，A → A' → A'' 链式克隆，回滚到 A 注册前，A 的迟到请求重放。v3 实测 140，正确 120。
    const t = new T();
    const snap = t.w.server.physicalSnapshot();
    await t.op(t.A, M('m1'));
    const top = await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 });
    await t.round(t.A, { dropRes: true }); // 已执行，响应丢失
    const k1 = t.clone(t.A, "A'");
    await t.op(k1, S('x1'));
    const k2 = t.clone(k1, "A''");
    await t.op(k2, S('y1'));
    await t.w.server.physicalRestore(snap);
    // 二轮 #1：回滚丢了 A 的注册，A 的迟到批次不再被当新安装执行，而是作废、进问题列表并留恢复副本。
    eq(await t.round(t.A), 'reset', '未注册安装带操作 → 作废');
    eq(t.probs(t.A).map((p) => p[1]), ['unconfirmed', 'unconfirmed'], 'A 的两条未确认');
    eq(t.balance('m1'), undefined, '服务器不替用户决定');
    await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import' });
    await t.done();
    eq(t.balance('m1'), 120, '用设备账本恢复后余额 120（充值只体现一次）');
    eq(t.probs(t.A), [], '导入确认后 A 的问题由恢复副本解决');
    eq(t.A.s.recoveries, [], '导入确认后才清恢复副本');
    // 三轮：A'' 的注册带着继承来的旧灾备纪元 → 作废，连回滚后才建的 y1 也进问题列表（代价：用户丢弃或重新编辑）。
    eq(t.probs(k2).map((p) => p[1]), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'], "A'' 把继承的未确认操作与 y1 列为问题");
  },
  async F18_同机恢复旧整机备份() {
    const t = new T();
    const s1 = await t.op(t.A, S('s1'));
    const snap = t.A.snapshotState();
    await t.round(t.A);
    await t.op(t.A, S('s2'));
    await t.round(t.A);
    t.A.alive = false;
    const r = t.clone(t.A, 'AR', snap);
    await t.op(r, S('s3'));
    await t.done();
    eq(t.subs(), ['s1', 's2', 's3'], '旧备份里的 s1 不重复，s3 正常');
    eq(t.probs(r), [[s1.tid, 'unconfirmed']], '旧备份里的待推操作进问题列表');
  },
  async F19_本地事务中途崩溃() {
    const t = new T();
    eq(await t.op(t.A, S('s1'), { crash: true }), null, '崩溃不入队');
    eq(t.A.s.queue.length, 0, '队列为空');
    await t.op(t.A, S('s2'));
    const res = await t.srv(await t.send(t.A));
    eq(await t.cli(res, { crash: 'before' }), 'crash', '处理响应前崩溃');
    eq(t.A.s.queue.length, 1, '崩溃后队列仍在');
    await t.done();
  },
  async F20_长期离线后旧请求迟到() {
    // 审查 #16：v3.1 删除按年龄回收。一年后迟到的旧请求靠 mid ≤ last 跳过，不需要作废。
    const t = new T();
    const o = await t.op(t.A, S('s1'));
    const old = await t.send(t.A);
    await t.srv(old, { keep: true, dropRes: true }); // 执行了，副本还在网络里
    await t.round(t.A);
    await t.op(t.A, S('s2'));
    t.A.online = false;
    t.w.day += 400;
    const res = await t.srv(old, { dropRes: true });
    eq([!!res.gone, res.lastMutationId], [false, 1], '迟到请求被跳过，不作废');
    eq(t.execCount(o.tid), 1, '不重复执行');
    await t.done();
    eq(t.subs(), ['s1', 's2'], '回来照常同步');
  },
  async F21_灾备物理回滚() {
    // 回滚连同步表一起回退；全部安装标作废、换随机代际。回滚点后已确认的丢失（文档写明），未确认的进问题列表，可用设备账本恢复。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naivePitr: true } : {});
      await t.op(t.A, S('s1'));
      await t.round(t.A);
      const snap = t.w.server.physicalSnapshot();
      await t.op(t.A, S('s2'));
      await t.op(t.B, S('b1'));
      await t.round(t.A);
      await t.round(t.B); // B 在回滚点之后才注册
      const b2 = await t.op(t.B, S('b2'));
      await t.w.server.physicalRestore(snap);
      if (naive) {
        await expectViolation(t, null);
        continue;
      }
      eq(await t.round(t.A), 'reset', 'A 收到作废');
      eq(await t.round(t.B), 'reset', 'B 收到作废');
      eq(t.probs(t.B), [[b2.tid, 'unconfirmed']], 'B 未确认的 b2 进问题列表');
      eq(t.subs(), ['s1'], '回滚后服务器');
      eq(!!(await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: `${t.A.install}:import` })), true, 'A 用设备账本恢复');
      await t.done();
      eq(t.subs(), ['s1', 's2'], 'A 的设备账本恢复了 s2；b1 已确认且不在 A 的设备上，按文档丢失');
      eq(t.w.server.settings().channels, SERVER_PRIVATE.channels, '恢复不动服务器私有字段');
    }
  },
  async F22_代际必须随机() {
    // 自增代际在物理回滚后会回到客户端见过的旧值，增量拉取漏数据。（两边都关掉作废，单独验证代际）
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveGen: true, naivePitr: true } : { naivePitr: true });
      const snap = t.w.server.physicalSnapshot();
      await t.w.server.restoreBackup((t.w.server.takeBackup(), 0)); // 代际 +1
      await t.op(t.A, S('s1'));
      await t.round(t.A);
      await t.w.server.physicalRestore(snap);
      await t.op(t.B, S('b1'));
      await t.round(t.B);
      await t.round(t.A);
      eq(t.A.baseText() === t.w.server.ledgerText(), !naive, naive ? 'naive 增量漏数据' : '随机代际触发全量');
    }
  },
  async F23_撤销排队操作() {
    {
      const t = new T();
      await t.op(t.A, S('s1'));
      await t.round(t.A, { dropRes: true });
      await t.op(t.A, S('s2'));
      eq(await t.A.cancelPending(), true, '撤销未发出的 s2');
      await t.op(t.A, S('s3'));
      await t.done();
      eq(t.subs(), ['s1', 's3'], 's2 撤销、s3 不被吞');
    }
    {
      const t = new T(7, { naiveCancel: true });
      await t.op(t.A, S('s1'));
      await t.op(t.A, S('s2'));
      await t.round(t.A, { dropRes: true });
      await t.A.cancelPending(); // naive：删掉 s2 并把编号 2 让给下一个
      await t.op(t.A, S('s3'));
      await expectViolation(t, null);
    }
  },
  async F24_业务日期() {
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.done();
    t.A.online = false;
    const o = await t.op(t.A, { kind: 'pay', sub: 's1', amount: 5 });
    t.w.day += 5;
    await t.done();
    eq(t.pays('s1').some((p) => p.date === o.at && p.amount === 5), true, `支付日期 = ${o.at}`);
  },
  async F25_克隆检测标记进了备份() {
    // 设备标记若随备份/克隆复制，两台安装共用一个 installId，编号互相顶掉。
    const t = new T(7, { naiveClone: true });
    await t.op(t.A, S('s1'));
    await t.round(t.A);
    const k = t.clone(t.A, "A'");
    await t.op(t.A, S('a2'));
    await t.op(k, S('k2')); // 两边都用编号 2
    await t.round(t.A);
    await t.round(k);
    await expectViolation(t, null);
  },

  // —— v3 审查反例 ——
  async F26_克隆后源设备照常补推() {
    // 审查 #2：v3 里「有人认领」被当成「已有持久副本」，认领方丢失后充值消失。v3.1 克隆不上传、源设备不受影响。
    const t = new T();
    await t.op(t.A, M('m1'));
    await t.done();
    const top = await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 });
    const k = t.clone(t.A, "A'");
    await t.round(k); // 克隆换新 id、全量拉取；充值进问题列表
    eq(t.probs(k), [[top.tid, 'unconfirmed']], '克隆的问题列表');
    k.alive = false; // 克隆随后丢失
    await t.done();
    eq(t.balance('m1'), 120, '余额');
  },
  async F27_被拒的来源操作在克隆上不显示成功() {
    // 审查 #7：来源操作被拒、响应丢失；克隆上它是「未确认」，源设备重发时拿到原拒绝。
    const t = new T();
    await t.op(t.A, M('m1'));
    await t.done();
    const m = view(t.A.db).methods[0];
    const ex = { balance: m.balance, balanceAsOf: m.balanceAsOf ?? null };
    await t.op(t.B, { kind: 'set_balance', method: 'm1', balance: 80, expect: ex });
    await t.round(t.B);
    const oa = await t.op(t.A, { kind: 'set_balance', method: 'm1', balance: 50, expect: ex });
    await t.round(t.A, { dropRes: true }); // 被拒，响应丢失
    const k = t.clone(t.A, "A'");
    await t.round(k);
    await t.round(t.A);
    eq(t.probs(k), [[oa.tid, 'unconfirmed']], '克隆：未确认，不是成功');
    eq(t.probs(t.A), [[oa.tid, 'expect_failed']], '源设备：原拒绝');
    await t.done();
  },
  async F28_回滚前的迟到响应() {
    // 审查 #3：响应在途时物理回滚。迟到响应被接受（客户端已确认），之后作废：已确认的随回滚丢失但留在设备账本里，未确认的进问题列表。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveDrDrop: true } : {});
      await t.op(t.A, M('m1'));
      await t.done();
      const snap = t.w.server.physicalSnapshot();
      const top = await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 });
      const res = await t.srv(await t.send(t.A));
      await t.w.server.physicalRestore(snap);
      eq(await t.cli(res), 'changed', '迟到响应被接受');
      eq(t.w.oracle.confirmedSet.has(top.tid), true, '客户端已确认充值');
      const top5 = await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 5 });
      eq(await t.round(t.A), 'reset', '收到作废');
      if (naive) {
        await expectViolation(t, 'silent-loss');
        continue;
      }
      eq(t.probs(t.A), [[top5.tid, 'unconfirmed']], '未确认的进问题列表');
      eq(JSON.parse(t.A.recoveryDoc('method/m1')).balance, 125, '设备账本保留两笔充值');
      eq(t.balance('m1'), 100, '回滚后服务器');
      await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: `${t.A.install}:import` });
      await t.done();
      eq(t.balance('m1'), 125, '用设备账本恢复后');
    }
  },
  async F29_换账号不发旧队列() {
    // 审查 #4：同一地址换了账号（账本身份不同）。旧队列一条不发，进问题列表；naiveLedger 把它写进新账号。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveLedger: true } : {});
      await t.round(t.A); // 绑定账本 X
      const o = await t.op(t.A, S('s2'));
      const Y = new Server({ rng: t.w.rng, oracle: t.w.oracle, flags: t.w.flags });
      t.A.endpoint = Y;
      if (naive) {
        await t.round(t.A);
        eq(t.subs(Y), ['s2'], 'naive 写进了新账号');
        continue;
      }
      eq(await t.round(t.A), 'reset', '账本身份不符');
      eq(t.probs(t.A), [[o.tid, 'ledger_changed']], '旧队列进问题列表');
      await t.round(t.A);
      eq(t.subs(Y), [], '新账号没被写入');
      eq(t.A.ledgerText(), Y.ledgerText(), 'A 换成新账号的账本');
      eq(t.A.s.ledgerId, Y.meta('ledgerId'), '绑定新账本');
      t.A.alive = false; // 其余安装仍在 X 上，照常检查
      await t.done();
    }
  },
  async F30_断开后重连走首连合并() {
    // 审查 #9：断开期间新增的订阅，重连时不能被旧 base 抹掉。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveReconnect: true } : {});
      await t.op(t.A, S('s1'));
      await t.done();
      await t.A.disconnect();
      await t.op(t.A, S('s2'));
      await t.A.reconnect();
      if (naive) {
        await expectViolation(t, 'silent-loss');
        continue;
      }
      await t.done();
      eq(t.subs(), ['s1', 's2'], '断开期间的 s2 合并上去');
    }
  },
  async F31_撤销用逆操作() {
    // 审查 #10：撤销旧修改不得覆盖他人随后的付款。naiveUndo（整条替换 + 当前 base 作期望）会丢掉 B 的付款。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveUndo: true } : {});
      await t.op(t.A, S('s1'));
      await t.done();
      await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { notes: { from: null, to: 'a' } } });
      await t.round(t.A);
      const n0 = t.pays('s1').length;
      await t.op(t.B, { kind: 'pay', sub: 's1', amount: 9.99 });
      await t.round(t.B);
      await t.round(t.A); // A 已拉到 B 的付款
      eq(!!(await t.w.undo(t.A)), true, '撤销入队');
      await t.done();
      eq(t.srvView().subs[0].notes ?? null, null, '备注已撤销');
      eq(t.pays('s1').length, naive ? n0 : n0 + 1, naive ? 'naive 丢了 B 的付款' : 'B 的付款保留');
    }
  },
  async F32_同id不同内容() {
    // 审查 #11：两端新建同 id、不同名称和价格 → id_conflict，不能都算成功。
    const t = new T();
    await t.op(t.A, S('s1', { name: 'X', price: 5 }));
    const ob = await t.op(t.B, S('s1', { name: 'Y' }));
    await t.round(t.A);
    await t.round(t.B);
    eq(t.probs(t.B), [[ob.tid, 'id_conflict']], 'B 的问题');
    eq(t.execCount(ob.tid), 0, 'B 未执行');
    await t.done();
    eq(t.srvView().subs[0].name, 'X', '服务器保留先到的');
  },
  async F33_删除完全相同的付款() {
    // 审查 #11：已有两笔完全相同的付款，两端各删「其中一笔」→ 期望笔数不符的那端被拒，结果恰好少一笔。
    const t = new T();
    await t.op(t.A, S('s1'));
    await t.op(t.A, { kind: 'pay', sub: 's1', amount: 9.99 });
    await t.op(t.A, { kind: 'pay', sub: 's1', amount: 9.99 });
    await t.done();
    const at = dateOf(t.w.day);
    const n = t.pays('s1').filter((p) => p.date === at && p.amount === 9.99).length;
    eq(n >= 2, true, '至少两笔相同付款');
    const del = { kind: 'delete_pay', sub: 's1', date: at, amount: 9.99, expect: { count: n } };
    await t.op(t.A, del);
    const ob = await t.op(t.B, del);
    await t.round(t.A);
    await t.round(t.B);
    eq(t.probs(t.B), [[ob.tid, 'expect_failed']], 'B 被拒');
    await t.done();
    eq(t.pays('s1').filter((p) => p.date === at && p.amount === 9.99).length, n - 1, '恰好少一笔');
  },
  async F34_分页中途换代() {
    // 审查 #12：每页一条（单条超限也单独成页）；游标只越过已交付对象；续页遇到换代丢弃暂存从头来。naivePage 回全局 head 漏对象。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naivePage: true } : {}, { pageBytes: 1 });
      await t.op(t.B, S('s1'));
      await t.op(t.B, S('s2'));
      if (naive) {
        await expectViolation(t, 'diverged'); // 每页一条时，截断后回全局 head 直接漏掉 s2
        continue;
      }
      await t.done();
      t.w.server.takeBackup();
      for (const id of ['s3', 's4', 's5', 's6']) await t.op(t.B, S(id));
      await t.round(t.B);
      const res = await t.srv(await t.send(t.C));
      eq([res.objects.length, res.more], [1, true], '单条超限也单独成页，首页只有一条');
      await t.cli(res);
      eq(await t.round(t.C), 'more', '第二页');
      await t.w.server.restoreBackup(0); // 续页途中换代
      let r;
      for (let i = 0; i < 20 && (r = await t.round(t.C)) === 'more'; i++);
      eq(t.C.baseText(), t.w.server.ledgerText(), '换代后全量替换，无旧暂存残留');
      await t.done();
      eq(t.subs(), ['s1', 's2'], '恢复后账本');
    }
  },
  async F35_设置白名单() {
    // 审查 #13：线上只传白名单字段；服务器私有（渠道凭据）不下发，手机私有（language）不被覆盖。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveWhitelist: true } : {});
      if (naive) {
        await t.op(t.A, S('s1'));
        await expectViolation(t, 'private-leak');
        continue;
      }
      await t.round(t.A);
      const ws = JSON.parse(t.A.s.base.get('kv/settings')).weekStart;
      const so = await t.op(t.A, { kind: 'set_setting', fields: { weekStart: { from: ws, to: 1 - ws } } });
      eq(!!so, true, '本地设置成功');
      await t.done();
      eq(t.probs(t.A), [], 'A 无问题');
      const srv = t.w.server.settings();
      eq([srv.weekStart, srv.channels, srv.notifyEmail], [1 - ws, SERVER_PRIVATE.channels, SERVER_PRIVATE.notifyEmail], '服务器：白名单字段更新，私有字段保留');
      eq(Object.keys(JSON.parse(t.B.s.base.get('kv/settings'))).every((k) => SYNC_SETTINGS.has(k)), true, 'B 只收到白名单字段');
      eq([privateSettings(t.A.db).language, privateSettings(t.B.db).language], [t.A.lang, t.B.lang], '手机私有字段保留');
      eq('channels' in privateSettings(t.B.db), false, 'B 本地无服务器私有字段');
    }
  },
  async F36_待推操作仍在时的重放核对() {
    // 审查 #15：多种对象的操作都待推时，收到含他人修改的响应，live 必须逐字节等于「新库写 base + 重放队列」。
    const t = new T();
    await t.op(t.A, M('m1'));
    await t.op(t.A, S('s1', { method: 'm1' }));
    await t.done();
    await t.op(t.B, { kind: 'pay', sub: 's1', amount: 9.99 });
    await t.op(t.B, { kind: 'patch_sub', id: 's1', fields: { url: { from: null, to: 'https://x.test/b' } } });
    await t.round(t.B);
    const req = await t.send(t.A);
    const m = view(t.A.db).methods[0];
    await t.op(t.A, { kind: 'patch_sub', id: 's1', fields: { notes: { from: null, to: 'a' } } });
    await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 });
    await t.op(t.A, { kind: 'set_balance', method: 'm1', balance: 60, expect: { balance: m.balance + 20, balanceAsOf: m.balanceAsOf ?? null } });
    await t.op(t.A, { kind: 'create_person', id: 'p1', name: 'P' });
    await t.cli(await t.srv(req));
    eq(t.A.s.queue.length, 4, '四条仍待推');
    eq(await t.A.replayText(), t.A.fullText(), 'live = base + 重放（含私有字段）');
    await t.done();
  },
  async F37_跨提交点崩溃() {
    // 审查 #15：本地事务中途崩溃 = 全回滚；提交后、内存赋值前崩溃 = 已落盘。两种都不得丢失或重复。
    const t = new T();
    const s1 = await t.op(t.A, S('s1'));
    let res = await t.srv(await t.send(t.A));
    eq(await t.cli(res, { crash: 'mid' }), 'crash', '中途崩溃');
    eq([t.A.s.queue.length, t.A.s.base.has('sub/s1')], [1, false], '回滚：队列与 base 都没变');
    const s2 = await t.op(t.A, S('s2'));
    res = await t.srv(await t.send(t.A));
    eq(await t.cli(res, { crash: 'after' }), 'crash', '提交后崩溃');
    eq([t.A.s.queue.length, t.A.s.base.has('sub/s2')], [0, true], '已落盘：队列清空、base 已更新');
    // 作废响应的提交后崩溃：身份已换但设备标记来不及写 → 下次启动按克隆处理，此时队列为空，问题不重复。
    const snap = t.w.server.physicalSnapshot();
    await t.op(t.A, S('s3'));
    await t.round(t.A);
    const s4 = await t.op(t.A, S('s4'));
    await t.w.server.physicalRestore(snap);
    res = await t.srv(await t.send(t.A));
    eq(!!res.gone, true, '作废');
    eq(await t.cli(res, { crash: 'after' }), 'crash', '作废处理提交后崩溃');
    await t.done();
    eq(t.probs(t.A), [[s4.tid, 'unconfirmed']], 's4 恰好一条问题');
    for (const o of [s1, s2]) eq(t.execCount(o.tid), 1, o.tid);
  },
  async F38_读算写交错() {
    // 审查 #5/#6：prepare 在私有副本上算、可与别的请求交错；commit 核对代际、head、该安装的行，变了就重算。naiveCas 无守卫提交。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveCas: true } : {});
      await t.op(t.A, M('m1'));
      await t.done();
      const top = await t.op(t.A, { kind: 'top_up', method: 'm1', amount: 20 });
      const req = await t.send(t.A);
      const srv = t.w.server;
      const p = await srv.prepare(req); // 第一份请求算完，未提交
      await t.srv(req, { dropRes: true }); // 重复投递的第二份先提交
      let kind = null;
      try {
        const res = (await srv.commit(p)) ?? (await srv.sync(req));
        eq(res.lastMutationId, 2, 'L');
      } catch (e) {
        if (!(e instanceof Violation)) throw e;
        kind = e.kind;
      }
      if (naive) {
        eq(kind, 'double-exec', 'naive 重复执行');
        continue;
      }
      eq(t.execCount(top.tid), 1, '只执行一次');
      // 交错期间发生物理回滚：commit 发现代际变了，重算得到作废。
      await t.op(t.A, S('s9'));
      const snap = srv.physicalSnapshot();
      const req2 = await t.send(t.A);
      const p2 = await srv.prepare(req2);
      await srv.physicalRestore(snap);
      eq(await srv.commit(p2), null, '代际变了，需重算');
      const res2 = await srv.sync(req2);
      eq(!!res2.gone, true, '重算得到作废');
      t.w.inflight = t.w.inflight.filter((m) => m.msg !== req2);
      await t.done();
      eq(t.balance('m1'), 120, '余额');
    }
  },

  // —— 审查二轮（Codex v3.1 反例，/tmp/calends-loop2-counterexamples.mjs）逐条固定 ——
  async F39_克隆问题展示服务器当前内容() {
    // clone_stale_detail：克隆上的未确认充值，服务器其实已执行（120）。问题展示当前 base；三轮起问题没有重新提交入口，只能丢弃。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.round(t.A);
    await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    const k = t.clone(t.A, 'K');
    await t.round(t.A);
    await t.round(k);
    eq(t.probs(k).map((p) => p[1]), ['unconfirmed'], 'K 的未确认充值');
    eq(JSON.parse(k.problemView(0)).balance, 120, '问题展示服务器当前 120，不是旧的 100');
    eq(await k.resolve(0, 'resubmit').then(() => 'ran', () => 'no-entry'), 'no-entry', '没有重新提交');
    await k.resolve(0, 'discard');
    await t.done();
    eq(t.balance('m'), 120, '没有被再充一次');
  },
  async F40_首连冲突保留本地() {
    // merge_keep_local：首连同 id 不同内容，选「保留本地」= 受保护的整条替换，备注上传，问题消失。
    const t = new T();
    await t.op(t.A, S('s'));
    await t.round(t.A);
    await t.A.disconnect();
    await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'offline note' } } });
    await t.A.reconnect();
    await t.round(t.A);
    eq(t.probs(t.A).map((p) => p[1]), ['merge_conflict'], '冲突交给用户');
    eq(t.A.s.problems[0].op.kind, 'replace', '冲突带受保护替换操作');
    const op = await t.A.resolve(0, 'keep_local');
    eq(op.expect, t.A.s.base.get('sub/s'), '期望 = 用户看到的服务器内容');
    await t.done();
    eq(t.srvView().subs[0].notes, 'offline note', '本地备注上传');
    eq(t.A.s.problems.length, 0, '问题已解决');
  },
  async F41_首连期间的本地修改() {
    // first_connect_inflight_edit：首连拉取在途时改了本地独有的订阅。合并按首连发起时的快照，父对象先于补丁上传。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveMerge: true } : {});
      await t.round(t.A);
      await t.A.disconnect();
      await t.op(t.A, S('s'));
      await t.A.reconnect();
      const res = await t.srv(await t.send(t.A, { raw: true }));
      const patch = await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'during connect' } } });
      eq(t.A.s.queue.length, 0, '首连完成前不入队');
      await t.cli(res);
      if (naive) {
        await expectViolation(t, 'merge-loss');
        continue;
      }
      eq(t.A.s.queue.map((q) => q.op.kind), ['put_object', 'patch_sub'], '父对象在前，补丁在后');
      await t.done();
      eq(t.srvView().subs.map((x) => [x.id, x.notes]), [['s', 'during connect']], '订阅与补丁都在服务器');
      eq(t.execCount(patch.tid), 1, '补丁执行一次');
      eq(t.A.s.problems, [], '无问题');
    }
  },
  async F42_未绑定账本不发操作() {
    // unbound_mutations：首连完成前 ledgerId 未绑定，客户端只发无操作的注册拉取；服务器拒绝 null ledgerId 带操作的请求。
    const t = new T();
    await t.round(t.A);
    await t.A.disconnect();
    await t.op(t.A, M('m'));
    await t.A.reconnect();
    await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    const req = await t.send(t.A, { raw: true });
    eq([req.register, req.ledgerId, req.mutations.length], [true, null, 0], '注册请求不带操作');
    const Y = new Server({ rng: t.w.rng, oracle: t.w.oracle });
    const bad = await Y.sync({ reqId: 0, installId: 'x9', ledgerId: null, cookie: null, ackedMid: 0, mutations: [{ mid: 1, op: { kind: 'top_up', method: 'm', amount: 20, at: dateOf(0), tid: 'x9:1' } }] });
    eq(bad.error, 'ledger_required', '服务器拒绝未绑定账本的写入');
    const reg = await Y.sync({ reqId: 0, installId: 'x9', register: true, ledgerId: null, cookie: null, ackedMid: 0, mutations: [{ mid: 1, op: { kind: 'noop', at: dateOf(0), tid: 'x9:n' } }] });
    eq(reg.error, 'register_with_mutations', '注册请求不得带操作');
    await t.cli(await t.srv(req));
    await t.done();
    eq(t.balance('m'), 120, '绑定后按序上传');
  },
  async F43_导入同事务换代() {
    // import_generation：设备账本导入在同一事务换代际，其他设备下次全量。naiveImportGen 不换。
    for (const naive of [false, true]) {
      const t = new T(7, naive ? { naiveImportGen: true } : {});
      await t.op(t.A, M('m'));
      await t.round(t.A);
      const snap = t.w.server.physicalSnapshot();
      await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
      await t.round(t.A);
      await t.w.server.physicalRestore(snap);
      eq(await t.round(t.A), 'reset', '作废');
      await t.round(t.B); // B 在回滚后注册，cookie 是当前代际
      const gen = t.w.server.meta('generation');
      await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import' });
      await t.round(t.A);
      eq(t.w.server.meta('generation') !== gen, !naive, naive ? 'naive 代际不变' : '导入换代际');
      const res = await t.srv(await t.send(t.B));
      eq(res.full, !naive, naive ? 'naive B 增量' : 'B 全量');
      await t.cli(res);
      await t.done();
      eq(t.balance('m'), 120, '导入后 120');
    }
  },
  async F44_同id新建比较全部冻结内容() {
    // create_method_collision：同 id 支付方式余额不同（100 / 900），不能算已体现。
    const t = new T();
    await t.op(t.A, M('m', 100));
    const ob = await t.op(t.B, M('m', 900));
    await t.round(t.A);
    await t.round(t.B);
    eq(t.probs(t.B), [[ob.tid, 'id_conflict']], 'B 的 900 进问题列表');
    await t.done();
    eq(t.balance('m'), 100, '服务器保留先到的');
    // 订阅：名称、价格相同而支付方式不同，同样是冲突
    const t2 = new T(8);
    await t2.op(t2.A, M('m1'));
    await t2.op(t2.A, M('m2'));
    await t2.done();
    await t2.op(t2.A, S('s', { method: 'm1' }));
    const o2 = await t2.op(t2.B, S('s', { method: 'm2' }));
    await t2.round(t2.A);
    await t2.round(t2.B);
    eq(t2.probs(t2.B), [[o2.tid, 'id_conflict']], '订阅支付方式不同 → 冲突');
  },
  async F45_保留本地即重新编辑() {
    // 三轮收口：field_changed 没有重新提交；用户在界面上照常再编辑一次 = 新操作，原值取当时 base。目标已删只能丢弃。
    const t = new T();
    await t.op(t.A, S('s'));
    await t.op(t.A, S('s2'));
    await t.round(t.A);
    await t.round(t.B);
    await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'A' } } });
    await t.op(t.B, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'B' } } });
    await t.round(t.B);
    await t.round(t.A);
    eq(t.probs(t.A).map((p) => p[1]), ['field_changed'], 'A 冲突');
    eq(view(t.A.db).subs.find((x) => x.id === 's').notes, 'B', '界面显示服务器值');
    await t.A.resolve(0, 'discard');
    const again = await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: 'B', to: 'A' } } });
    await t.round(t.A);
    eq(t.execCount(again.tid), 1, '新操作执行一次');
    eq(t.srvView().subs.find((x) => x.id === 's').notes, 'A', '重新编辑的值生效');
    await t.op(t.A, { kind: 'patch_sub', id: 's2', fields: { notes: { from: null, to: 'x' } } });
    await t.op(t.B, { kind: 'delete_sub', id: 's2' });
    await t.round(t.B);
    await t.round(t.A);
    eq(t.probs(t.A).map((p) => p[1]), ['target_deleted'], '目标已删');
    await t.A.resolve(0, 'discard');
    await t.done();
  },
  async F46_导入只解决副本覆盖的问题() {
    // import_resolves_unrepresented：克隆时进问题列表的充值不在后来的恢复副本里，导入不能把它算解决。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.round(t.A);
    const top = await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    const k = t.clone(t.A, 'K');
    t.A.alive = false; // 源设备抹掉，只剩克隆
    await t.round(k);
    eq(t.probs(k), [[top.tid, 'unconfirmed']], 'K 的问题');
    const snap = t.w.server.physicalSnapshot();
    await t.w.server.physicalRestore(snap);
    eq(await t.round(k), 'reset', '作废');
    eq(JSON.parse(k.recoveryDoc('method/m')).balance, 100, '恢复副本不含该充值');
    await k.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'K:import' });
    await t.round(k);
    eq(t.balance('m'), 100, '导入后 100');
    eq(t.probs(k), [[top.tid, 'unconfirmed']], '旧问题仍在');
    eq(t.w.oracle.resolvedTo.has(top.tid), false, '没有被导入算作解决');
    await k.resolve(0, 'discard');
    await t.op(k, { kind: 'top_up', method: 'm', amount: 20 }); // 用户看过服务器内容后重新充值
    await t.done();
    eq(t.balance('m'), 120, '用户重新充值后 120');
  },
  async F47_未绑定请求被误投到别的账号() {
    // unbound_cross_account_write：重连后的首个请求被送到另一个账号的服务器，也只是一次无操作的拉取。
    const t = new T();
    await t.round(t.A);
    await t.A.disconnect();
    await t.A.reconnect();
    await t.op(t.A, S('s'));
    const req = await t.send(t.A, { raw: true });
    const Y = new Server({ rng: t.w.rng, oracle: t.w.oracle });
    await Y.sync(req);
    t.w.inflight = t.w.inflight.filter((m) => m.msg !== req);
    t.A.outstanding = null;
    eq(req.mutations.length, 0, '没有操作');
    eq(t.subs(Y), [], '另一个账号没被写入');
    await t.done();
    eq(t.subs(), ['s'], '原账号拿到 s');
  },
  async F48_回滚后才注册的只拉设备() {
    // unregistered_donor_recovery：快照后才注册的只拉设备，回滚后服务器不认识它 → 作废，留下恢复副本（含 120）。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.round(t.A);
    const snap = t.w.server.physicalSnapshot();
    await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    await t.round(t.A);
    await t.round(t.B);
    await t.w.server.physicalRestore(snap);
    t.A.alive = false; // 只剩 B 有这笔充值
    const res = await t.srv(await t.send(t.B));
    eq(!!res.gone, true, '未注册安装 → 作废');
    await t.cli(res);
    eq(JSON.parse(t.B.recoveryDoc('method/m')).balance, 120, '恢复副本保留 120');
    await t.B.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'B:import' });
    await t.done();
    eq(t.balance('m'), 120, '从 B 恢复');
  },
  async F49_导入后旧首批迟到() {
    // late_first_batch_after_import：回滚丢了 B 的注册；B 的旧首批在导入之后迟到，不再当新安装执行。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.round(t.A);
    const snap = t.w.server.physicalSnapshot();
    await t.round(t.B);
    await t.op(t.B, { kind: 'top_up', method: 'm', amount: 20 });
    const old = await t.send(t.B);
    await t.srv(old, { keep: true, dropRes: true }); // 执行了，响应丢失，副本还在网络里
    await t.round(t.A);
    await t.w.server.physicalRestore(snap);
    eq(await t.round(t.A), 'reset', 'A 作废');
    await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import' });
    await t.round(t.A);
    eq(t.balance('m'), 120, '导入后 120');
    const late = await t.srv(old, { dropRes: true });
    eq(!!late.gone, true, '旧首批 → 作废');
    eq(t.balance('m'), 120, '没有再加 20');
    await t.done();
    eq(t.balance('m'), 120, '静止后仍 120');
  },
  async F50_首连丢父对象被不变量抓到() {
    // lost_local_parent_oracle：断开期间的操作不再无条件豁免，必须追到首连合并里覆盖它的操作。naiveMerge 被抓到 merge-loss。
    for (const naive of [false, true]) {
      const t = new T(9, naive ? { naiveMerge: true } : {});
      await t.round(t.A);
      await t.A.disconnect();
      await t.op(t.A, S('s'));
      await t.A.reconnect();
      const res = await t.srv(await t.send(t.A, { raw: true }));
      await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'during connect' } } });
      await t.cli(res);
      if (naive) {
        await expectViolation(t, 'merge-loss');
        continue;
      }
      await t.done();
      eq(t.subs(), ['s'], 's 在服务器');
    }
  },
  async F51_撤销导入不丢问题() {
    // cancel_import_loses_problems：撤销尚未发出的导入，恢复副本与问题都保留；服务器确认导入后才清。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.round(t.A);
    const snap = t.w.server.physicalSnapshot();
    const top = await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    await t.w.server.physicalRestore(snap);
    eq(await t.round(t.A), 'reset', '作废');
    eq(t.probs(t.A), [[top.tid, 'unconfirmed']], '充值进问题列表');
    await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import1' });
    eq(t.A.s.problems.length, 1, '入队时不清问题');
    await t.A.cancelPending();
    await t.round(t.A);
    eq([t.A.s.recoveries.length, t.A.s.problems.length, t.balance('m')], [1, 1, 100], '撤销后副本与问题都在');
    await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import2' });
    await t.done();
    eq([t.A.s.recoveries.length, t.A.s.problems.length, t.balance('m')], [0, 0, 120], '确认导入后才清，结果 120');
    eq(t.w.oracle.resolvedTo.get(top.tid), ['A:import2'], '充值由第二次导入覆盖');
  },
  async F52_另一设备分页遇到导入() {
    // 其他设备分页拉取中途遇到导入：代际已换，暂存丢弃、从头全量，结果与服务器一致。
    const t = new T(7, {}, { pageBytes: 1 });
    await t.op(t.A, M('m'));
    await t.op(t.A, S('s1'));
    await t.op(t.A, S('s2'));
    await t.done();
    const snap = t.w.server.physicalSnapshot();
    await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    await t.round(t.A);
    await t.w.server.physicalRestore(snap);
    eq(await t.round(t.A), 'reset', 'A 作废');
    eq(await t.round(t.B), 'reset', 'B 作废');
    eq(await t.cli(await t.srv(await t.send(t.B, { raw: true }))), 'more', 'B 分页第一页');
    await t.A.restoreServerFromDevice({ at: dateOf(t.w.day), tid: 'A:import' });
    for (let i = 0; i < 20 && !t.A.idle(); i++) await t.round(t.A);
    const res = await t.srv(await t.send(t.B, { raw: true }));
    eq(res.full, true, 'B 的暂存 cookie 已过期 → 全量');
    await t.cli(res);
    await t.done();
    eq(t.B.ledgerText(), t.w.server.ledgerText(), 'B 与服务器一致');
    eq(t.balance('m'), 120, '导入后 120');
  },
  async F53_读算写交错对照() {
    // cas_recompute_control（对照，修前修后都应通过）：prepare 后别的设备先提交，旧 commit 返回 null 重算，两边写入都在。
    const t = new T();
    await t.op(t.A, M('m'));
    await t.done();
    await t.op(t.A, { kind: 'top_up', method: 'm', amount: 20 });
    const req = await t.send(t.A);
    const p = await t.w.server.prepare(req);
    await t.op(t.B, S('s'));
    await t.round(t.B);
    eq(await t.w.server.commit(p), null, '快照变了，重算');
    await t.srv(req);
    await t.done();
    eq([t.balance('m'), t.subs()], [120, ['s']], '两边写入都在');
  },
  async F54_逆操作冲突对照() {
    // inverse_conflict_control（对照）：撤销只动原字段，字段已被别人改过则本地即拒绝。
    const t = new T();
    await t.op(t.A, S('s'));
    await t.done();
    await t.op(t.A, { kind: 'patch_sub', id: 's', fields: { notes: { from: null, to: 'a' } } });
    await t.done();
    await t.op(t.B, { kind: 'patch_sub', id: 's', fields: { notes: { from: 'a', to: 'b' } } });
    await t.done();
    eq(await t.w.undo(t.A), null, '撤销被本地拒绝');
    await t.done();
    eq(t.srvView().subs[0].notes, 'b', 'B 的修改保留');
  },

  // —— 审查三轮（Codex，/tmp/calends-v31-r3-counterexamples.mjs）：R1、R1b、R2、R4、R5、R5b、R7 ——
  async F55_迟到注册包不复活回滚前的安装() {
    // R1：快照后 B 注册并充值 20（响应丢失）；回滚后 A 从设备恢复到 120；B 的旧注册包与旧充值包先后迟到。
    // 注册包授不出写入资格：B 之后的请求带旧灾备纪元，一律作废。余额必须仍是 120。
    const t = new T();
    const { w, A, B } = t;
    await t.op(A, M('m'));
    await drain(w, A); // B 还没注册过：它的注册包空纪元
    const snap = w.server.physicalSnapshot();
    const reg = await B.buildRequest(++rid);
    await B.onResponse(await w.server.sync(reg));
    await t.op(B, { kind: 'top_up', method: 'm', amount: 20 });
    const late = await B.buildRequest(++rid);
    await w.server.sync(late); // 执行了，响应丢失
    await drain(w, A);
    eq(t.balance('m'), 120, '回滚前 120');
    await w.server.physicalRestore(snap);
    eq(await rawRound(w, A), 'reset', 'A 作废');
    await A.restoreServerFromDevice({ at: dateOf(w.day), tid: 'A:import' });
    await drain(w, A);
    eq(t.balance('m'), 120, 'A 恢复到 120');
    const rr = await w.server.sync(reg);
    eq([!!rr.gone, rr.lastMutationId], [false, 0], '旧注册包（首装、空纪元）只拿到一次无操作的拉取');
    const rw = await w.server.sync(late);
    eq(!!rw.gone, true, '旧充值包带旧纪元 → 作废');
    eq(t.balance('m'), 120, '没有再加 20');
    await B.onResponse(rw);
    eq(t.probs(B).map((p) => p[1]), ['unconfirmed'], 'B 的充值进问题列表');
    eq(JSON.parse(B.recoveryDoc('method/m')).balance, 120, 'B 的恢复副本含 120');
    await t.done();
    eq(t.balance('m'), 120, '静止后 120');
  },
  async F56_迟到注册包不掩盖只拉设备() {
    // R1b：B 在快照后注册、只拉到 120；回滚后 B 的旧注册包先到。B 下一次请求仍须作废并留下 120 的恢复副本。
    const t = new T();
    const { w, A, B } = t;
    await t.op(A, M('m'));
    await drain(w, A); // B 还没注册过：它的注册包空纪元
    const snap = w.server.physicalSnapshot();
    const reg = await B.buildRequest(++rid);
    await B.onResponse(await w.server.sync(reg));
    await t.op(A, { kind: 'top_up', method: 'm', amount: 20 });
    await drain(w, A);
    await drain(w, B);
    eq(view(B.db).methods[0].balance, 120, 'B 拉到 120');
    await w.server.physicalRestore(snap);
    await w.server.sync(reg);
    eq(await rawRound(w, B), 'reset', 'B 作废');
    await drain(w, B);
    eq(view(B.db).methods[0].balance, 100, 'B 跟随回滚后的服务器');
    eq(JSON.parse(B.recoveryDoc('method/m')).balance, 120, '恢复副本保留 120');
    await t.done();
  },
  async F57_克隆注册前没有重提入口() {
    // R2：克隆继承充值队列与旧 base（100），源设备已充到 120。三轮起问题列表没有重新提交，只能看与丢弃；结果不会变成 140。
    const t = new T();
    const { w, A } = t;
    await t.op(A, M('m'));
    await drain(w, A);
    await t.op(A, { kind: 'top_up', method: 'm', amount: 20 });
    const k = t.clone(A, 'K');
    await drain(w, A);
    await k.checkIdentity();
    eq(k.s.registered, false, '尚未注册');
    eq(JSON.parse(k.problemView(0)).balance, 100, '注册前展示的是旧 base');
    eq(await k.resolve(0, 'resubmit').then(() => 'ran', () => 'no-entry'), 'no-entry', '没有重新提交入口');
    await drain(w, k);
    eq(JSON.parse(k.problemView(0)).balance, 120, '注册刷新后展示 120');
    await k.resolve(0, 'discard');
    await t.done();
    eq(t.balance('m'), 120, '余额 120');
  },
  async F58_新建比较初始余额日期() {
    // R4：同 id、同名、同余额，余额日期不同（1 月 5 日 / 6 日）→ id_conflict，不能当已体现。
    const t = new T();
    const { w, A, B } = t;
    await rawRound(w, A);
    await rawRound(w, B);
    await t.op(A, M('m'));
    w.day = 1;
    const ob = await t.op(B, M('m'));
    await drain(w, A);
    await drain(w, B);
    eq(t.probs(B), [[ob.tid, 'id_conflict']], 'B 的新建进问题列表');
    eq(t.srvView().methods[0].balanceAsOf, dateOf(0), '服务器保留先到的日期');
    await B.resolve(0, 'discard');
    await t.done();
  },
  async F59_再次作废追加恢复副本() {
    // R5：第一次回滚留下 120 的恢复副本（充值未确认）；再次回滚不覆盖它，问题仍关联第一份；用第一份恢复得到 120。
    const t = new T();
    const { w, A } = t;
    await t.op(A, M('m'));
    await drain(w, A);
    const snap = w.server.physicalSnapshot();
    const top = await t.op(A, { kind: 'top_up', method: 'm', amount: 20 });
    await w.server.physicalRestore(snap);
    await rawRound(w, A);
    await drain(w, A);
    const first = A.s.recoveries[0].id;
    eq([A.s.recoveries.length, JSON.parse(A.recoveryDoc('method/m')).balance, A.s.problems[0].recoveryId], [1, 120, first], '第一份副本');
    await w.server.physicalRestore(w.server.physicalSnapshot());
    await rawRound(w, A);
    eq(A.s.recoveries.length, 2, '再次作废追加一份');
    eq([JSON.parse(A.recoveryDoc('method/m', 0)).balance, JSON.parse(A.recoveryDoc('method/m', 1)).balance], [120, 100], '旧副本内容不变');
    eq(t.probs(A), [[top.tid, 'unconfirmed']], '问题仍在');
    eq(A.s.problems[0].recoveryId, first, '问题仍关联第一份');
    await A.restoreServerFromDevice({ at: dateOf(w.day), tid: 'A:import', recoveryId: first });
    await t.done();
    eq([t.balance('m'), A.s.problems.length, A.s.recoveries.map((r) => r.id).includes(first)], [120, 0, false], '用第一份恢复：120，问题解决，第一份清除');
  },
  async F60_再次作废保留已确认充值的副本() {
    // R5b：充值已确认后回滚，副本 120 是唯一记录（无问题）；再次回滚不得把它换成 100。
    const t = new T();
    const { w, A } = t;
    await t.op(A, M('m'));
    await drain(w, A);
    const snap = w.server.physicalSnapshot();
    await t.op(A, { kind: 'top_up', method: 'm', amount: 20 });
    await drain(w, A);
    await w.server.physicalRestore(snap);
    await rawRound(w, A);
    await drain(w, A);
    eq([A.s.problems.length, JSON.parse(A.recoveryDoc('method/m')).balance], [0, 120], '无问题，副本 120');
    await w.server.physicalRestore(w.server.physicalSnapshot());
    await rawRound(w, A);
    eq(A.s.recoveries.map((r) => JSON.parse(new Map(r.objects).get('method/m')).balance), [120, 100], '两份副本，120 仍在');
    await A.restoreServerFromDevice({ at: dateOf(w.day), tid: 'A:import', recoveryId: A.s.recoveries[0].id });
    await t.done();
    eq(t.balance('m'), 120, '用 120 的副本恢复');
  },
  async F61_首连上传撞id换新id() {
    // R7：首连拉取后另一设备新建同 id 订阅，本地独有对象上传得 id_conflict。换新 id 重新上传，两条并存，远端不被覆盖，不进问题列表。
    const t = new T();
    const { w, A, B } = t;
    await t.done();
    await A.disconnect();
    await t.op(A, S('s', { name: 'LOCAL', price: 10 }));
    await A.reconnect();
    const req = await A.buildRequest(++rid);
    const res = await w.server.sync(req);
    await t.op(B, S('s', { name: 'REMOTE', price: 99 }));
    await drain(w, B);
    await A.onResponse(res);
    await drain(w, A);
    const subs = t.srvView().subs.map((x) => [x.id === 's' ? 's' : 'new', x.name, x.price]).sort();
    eq(subs, [['new', 'LOCAL', 10], ['s', 'REMOTE', 99]], '两条并存，远端未被覆盖');
    eq(A.s.problems, [], '不进问题列表');
    await t.done();
    eq(A.ledgerText(), w.server.ledgerText(), 'A 与服务器一致');
  },
};

async function expectViolation(t, kind) {
  try {
    await t.w.settle();
    t.w.check();
  } catch (e) {
    if (!(e instanceof Violation)) throw e;
    if (kind && e.kind !== kind) throw new Error(`naive 违规类型 ${e.kind}，期望 ${kind}：${e.message.slice(0, 200)}`);
    return e.kind;
  }
  throw new Error('naive 写法没有被不变量抓到');
}

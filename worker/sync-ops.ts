// App 同步协议的操作集（docs/sync-api.md「操作」）：在 BatchStore 的内存快照上执行一个操作。
// 意图操作直接调现有 MCP 写工具（同一校验与账务口径）；同 id 新建、期望值、补丁原值、按内容定位这些同步专有的前置检查在本层做，
// 不改工具行为，MCP 与网页不受影响。返回 ok 或拒绝码；非业务异常（引擎缺陷）按 invalid / engine_error 拒绝并告警。
import { t } from '../shared/i18n.ts';
import { type Payment, type PaymentMethod, type Person, type Subscription } from '../shared/types.ts';
import { prepareSubWrite } from '../shared/sub-write.ts';
import { deleteMethodData, validateMethod } from '../shared/ledger-edit.ts';
import { canonicalJson, contentHash, isSyncedSetting, PATCH_FIELDS, projectSettings, splitKey, type RejectCode } from '../shared/sync-check.ts';
import { TOOLS } from './ai/mcp-tools.ts';
import type { Tool, ToolCtx } from './ai/tool-kit.ts';
import type { Env } from './env.ts';
import { ledgerEditWrites, type LedgerWrites } from './store.ts';
import type { BatchStore } from './sync-store.ts';

export interface SyncOp {
  name: string;
  target?: string;
  at?: { date?: string; ts?: string };
  args?: Record<string, unknown>;
  fields?: Record<string, { from: unknown; to: unknown }>;
  expect?: Record<string, unknown> | { hash: string } | null;
  locate?: { date: string; match: Record<string, unknown>; count: number };
  doc?: unknown;
  field?: string;
  add?: string;
  remove?: string;
  date?: string;
  rates?: Record<string, number>;
  source?: string;
  objects?: Array<[string, unknown]>;
  recoveryId?: string;
  into?: string;
  clear?: boolean;
}

export type OpResult = { ok: true; rotate?: boolean } | { ok: false; code: RejectCode; detail: string };

const WRITE_TOOLS = new Map<string, Tool>(TOOLS.filter((x) => x.write).map((x) => [x.name, x]));
const GENERIC = ['noop', 'patch', 'create', 'delete', 'replace', 'set_member', 'fx_fill', 'import_ledger'];

/** 服务器认识的操作与版本区间（hello.ops）：现在全部只有 @1 */
export const OP_VERSIONS: Record<string, [number, number]> = Object.fromEntries([...GENERIC, ...WRITE_TOOLS.keys()].map((n) => [n, [1, 1]]));

export function parseOpName(name: unknown): { base: string; version: number } | undefined {
  const m = typeof name === 'string' ? name.match(/^([a-z_]+)@(\d+)$/) : null;
  if (!m) return undefined;
  const range = OP_VERSIONS[m[1]];
  const version = Number(m[2]);
  return range && version >= range[0] && version <= range[1] ? { base: m[1], version } : undefined;
}

const reject = (code: RejectCode, detail = ''): OpResult => ({ ok: false, code, detail });
const OK: OpResult = { ok: true };
const norm = (v: unknown) => canonicalJson(v ?? null);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 同 id 新建：冻结内容逐字段相同 = 已体现（ok），否则两个不同意图撞了 id */
function sameOrConflict(cur: Record<string, unknown>, frozen: Record<string, unknown>): OpResult {
  for (const [k, v] of Object.entries(frozen))
    if (v !== undefined && norm(cur[k]) !== norm(v)) return reject('id_conflict', `${k}: server=${norm(cur[k])} op=${norm(v)}`);
  return OK;
}

/** 补丁：当前 = from 应用；当前 = to 已达成跳过；都不等 field_changed */
function patchCheck(cur: Record<string, unknown>, fields: Record<string, { from: unknown; to: unknown }>): { set: Record<string, unknown> } | { err: OpResult } {
  const set: Record<string, unknown> = {};
  for (const [f, change] of Object.entries(fields)) {
    if (!change || typeof change !== 'object' || !('from' in change) || !('to' in change)) return { err: reject('invalid', `fields.${f}`) };
    if (norm(cur[f]) === norm(change.from)) {
      if (norm(change.from) !== norm(change.to)) set[f] = change.to;
    } else if (norm(cur[f]) !== norm(change.to)) return { err: reject('field_changed', `${f}: server=${norm(cur[f])} from=${norm(change.from)}`) };
  }
  return { set };
}

/** 文档去掉服务器盖的时间戳后再比较（两端各自盖） */
const withoutStamp = (d: unknown) => (d && typeof d === 'object' && !Array.isArray(d) ? { ...(d as Record<string, unknown>), updatedAt: undefined } : d);

export class SyncExec {
  private readonly env: Env;
  private readonly store: BatchStore;
  constructor(env: Env, store: BatchStore) {
    this.env = env;
    this.store = store;
  }

  private ctx(today: string): ToolCtx {
    return { env: this.env, access: { client: 'mcp', scope: 'write' }, store: this.store, today };
  }

  private async tool(name: string, args: Record<string, unknown>, today: string): Promise<OpResult> {
    const { dry_run: _dry, ...rest } = args;
    await WRITE_TOOLS.get(name)!.run(rest, this.ctx(today));
    return OK;
  }

  private people(): Person[] {
    return (this.store.rawKv('people') as Person[] | undefined) ?? [];
  }
  private settings(): Record<string, unknown> {
    return (this.store.rawKv('settings') as Record<string, unknown> | undefined) ?? {};
  }

  /** 对象键 → 当前文档（未推导的原始 JSON）；kv/settings 为同步投影 */
  current(key: string): unknown {
    const k = splitKey(key);
    if (!k) return undefined;
    if (k.kind === 'sub') return this.store.raw('subscriptions', k.id);
    if (k.kind === 'method') return this.store.raw('methods', k.id);
    if (k.kind === 'kv') return k.id === 'settings' ? projectSettings(this.settings()) : this.store.rawKv('people');
    return undefined;
  }

  /** 执行一个操作；调用方负责保存点与回滚 */
  async run(op: SyncOp): Promise<OpResult> {
    const { base } = parseOpName(op.name)!;
    const today = isDate(op.at?.date) ? op.at.date : undefined;
    if (!today && base !== 'noop' && base !== 'fx_fill') return reject('invalid', 'at.date');
    try {
      const r = await this.dispatch(base, op, today!);
      return r;
    } catch (e) {
      if (e instanceof Error && e.constructor === Error) {
        // 工具的业务错误。「没有可改的字段」= 目标值已经达成
        if (e.message === t('mcp.error.noFields')) return OK;
        return reject('invalid', e.message);
      }
      console.error('sync: engine error', op.name, e);
      return reject('invalid', 'engine_error');
    }
  }

  private async dispatch(base: string, op: SyncOp, today: string): Promise<OpResult> {
    switch (base) {
      case 'noop':
        return OK;
      case 'patch':
        return this.patch(op, today);
      case 'create':
        return this.create(op, today);
      case 'delete':
        return this.remove(op, today);
      case 'replace':
        return this.replace(op);
      case 'set_member':
        return this.setMember(op);
      case 'fx_fill':
        return this.fxFill(op);
      case 'import_ledger':
        return this.importLedger(op);
      default:
        return this.intent(base, op, today);
    }
  }

  // —— 意图：现有 MCP 写工具 ——

  private async intent(name: string, op: SyncOp, today: string): Promise<OpResult> {
    const a = { ...op.args };
    if (name === 'update_settings') {
      if ('channel_enabled' in a || 'prefs' in a) return reject('invalid', 'update_settings: only synced settings');
      const bad = Object.keys((a.set as object) ?? {}).find((k) => !isSyncedSetting(k));
      if (bad) return reject('invalid', `update_settings: ${bad}`);
    }
    if (name === 'record_payment') a.allow_duplicate = true;

    // 同 id 新建（sync-design 1.3）
    if (name === 'create_subscription' && typeof a.id === 'string') {
      const cur = this.store.raw('subscriptions', a.id) as Subscription | undefined;
      if (cur) {
        const cyc = a.cycle as { unit?: string; every?: number } | undefined;
        return sameOrConflict(cur as unknown as Record<string, unknown>, {
          name: a.name,
          price: a.price,
          currency: a.currency,
          cycle: cyc ? { unit: cyc.unit, every: Math.max(1, Number(cyc.every ?? 1)) } : undefined,
          start: a.start ?? today,
          methodId: a.method === null ? undefined : a.method,
        });
      }
    }
    if (name === 'update_payment_method' && a.action === 'create' && typeof a.id === 'string') {
      const cur = this.store.raw('methods', a.id) as Record<string, unknown> | undefined;
      if (cur) {
        const set = (a.set ?? {}) as Record<string, unknown>;
        return sameOrConflict(cur, {
          name: set.name,
          kind: set.kind,
          currency: set.currency,
          balance: set.balance,
          balanceAsOf: set.balance == null ? undefined : (set.balanceAsOf ?? today),
        });
      }
    }
    if (name === 'save_person' && a.action === 'create' && typeof a.id === 'string') {
      const cur = this.people().find((p) => p.id === a.id);
      if (cur) return sameOrConflict(cur as unknown as Record<string, unknown>, { name: (a.set as Record<string, unknown> | undefined)?.name });
    }

    // 目标已删：删除类视为达成，其余 target_deleted
    const deleting = name === 'delete_subscription' || (name === 'update_payment_method' && a.action === 'delete') || (name === 'save_person' && a.action === 'delete');
    const creating = name === 'create_subscription' || a.action === 'create';
    const target = op.target ? splitKey(op.target) : undefined;
    let doc: Record<string, unknown> | undefined;
    if (!creating && target && (target.kind === 'sub' || target.kind === 'method')) {
      doc = this.current(op.target!) as Record<string, unknown> | undefined;
      if (!doc) return deleting ? OK : reject('target_deleted', op.target);
    }
    if (name === 'save_person' && !creating) {
      const id = String(a.person ?? '');
      const p = this.people().find((x) => x.id === id);
      if (!p) return deleting ? OK : reject('target_deleted', `person/${id}`);
      doc = p as unknown as Record<string, unknown>;
    }

    // 绝对值意图的期望（sync-design 4.4）：字段逐个比较目标当前值
    if (op.expect && typeof op.expect === 'object' && !('hash' in op.expect)) {
      const cur = doc ?? (target?.kind === 'kv' ? (this.current(op.target!) as Record<string, unknown> | undefined) : undefined);
      if (!cur) return reject('target_deleted', op.target ?? '');
      for (const [k, v] of Object.entries(op.expect)) if (norm(cur[k]) !== norm(v)) return reject('expect_failed', `${k}: server=${norm(cur[k])} expect=${norm(v)}`);
    }

    // 内层记录按内容定位（sync-design 4.3）：目前用于 delete_payment
    if (name === 'delete_payment' && op.locate) {
      const s = doc as unknown as Subscription;
      const date = op.locate.date;
      const sameDay = [...(s.payments ?? []), ...(s.phases ?? []).flatMap((p) => p.payments ?? [])].filter((p) => p.date === date);
      const hit = (p: Payment) => Object.entries(op.locate!.match ?? {}).every(([k, v]) => norm((p as unknown as Record<string, unknown>)[k]) === norm(v));
      const n = sameDay.filter(hit).length;
      if (!n) return reject('target_deleted', `payment ${date}`);
      if (n !== op.locate.count) return reject('expect_failed', `payments(${date}) server=${n} expect=${op.locate.count}`);
      a.date = date;
      a.index = sameDay.findIndex(hit);
    }
    return this.tool(name, a, today);
  }

  // —— patch@1 ——

  private async patch(op: SyncOp, today: string): Promise<OpResult> {
    const k = op.target ? splitKey(op.target) : undefined;
    if (!k || !op.fields || typeof op.fields !== 'object') return reject('invalid', 'patch target/fields');
    const table = k.kind === 'sub' ? PATCH_FIELDS.sub : k.kind === 'method' ? PATCH_FIELDS.method : k.kind === 'kv' && k.id === 'settings' ? null : undefined;
    if (table === undefined) return reject('invalid', `patch ${op.target}`);
    const bad = Object.keys(op.fields).find((f) => (table ? !(f in table) : !isSyncedSetting(f)));
    if (bad) return reject('invalid', `patch field ${bad}`);
    const cur = k.kind === 'kv' ? this.settings() : (this.current(op.target!) as Record<string, unknown> | undefined);
    if (!cur) return reject('target_deleted', op.target!);
    const checked = patchCheck(cur, op.fields);
    if ('err' in checked) return checked.err;
    const set = checked.set;
    if (!Object.keys(set).length) return OK;
    if (k.kind === 'sub') {
      // 引擎用空串表示清除
      const args = Object.fromEntries(Object.entries(set).map(([f, v]) => [(PATCH_FIELDS.sub as Record<string, string>)[f], v === null ? '' : v]));
      return this.tool('update_subscription', { subscription: k.id, set: args }, today);
    }
    if (k.kind === 'method') return this.tool('update_payment_method', { method: k.id, set }, today);
    return this.tool('update_settings', { set }, today);
  }

  // —— create@1：整条新建（编辑器新建、首连上传） ——

  private async create(op: SyncOp, today: string): Promise<OpResult> {
    const k = op.target ? splitKey(op.target) : undefined;
    if (!k || k.kind === 'fx' || !op.doc || typeof op.doc !== 'object') return reject('invalid', 'create target/doc');
    const doc = op.doc as Record<string, unknown>;
    if (k.kind !== 'kv' && doc.id !== k.id) return reject('invalid', 'create: doc.id');
    const cur = this.current(op.target!);
    if (k.kind === 'kv') {
      // kv 只能在不存在时整条新建（首连上传）；存在时等同 replace(expect = 自身)
      if (cur !== undefined) return norm(cur) === norm(k.id === 'settings' ? projectSettings(doc) : doc) ? OK : reject('id_conflict', op.target!);
      return this.writeDoc(k.kind, k.id, doc, today);
    }
    if (cur !== undefined) return norm(withoutStamp(cur)) === norm(withoutStamp(doc)) ? OK : reject('id_conflict', op.target!);
    return this.writeDoc(k.kind, k.id, doc, today);
  }

  /** 整条写入一个对象：订阅走 prepareSubWrite，支付方式走 validateMethod，人员走 save_person 同一校验，设置只覆盖白名单字段 */
  private async writeDoc(kind: 'sub' | 'method' | 'kv', id: string, doc: unknown, today: string): Promise<OpResult> {
    const st = await this.store.loadState();
    if (kind === 'sub') {
      const prev = st.subscriptions.find((s) => s.id === id);
      const p = prepareSubWrite(prev, { ...(doc as Subscription), id }, today, st);
      if (p.error !== undefined) return reject('invalid', p.error);
      await this.store.saveLedgerEdit({ subscriptions: [p.sub] });
      return OK;
    }
    if (kind === 'method') {
      const pm = { ...(doc as PaymentMethod), id };
      validateMethod(st, pm);
      await this.store.saveLedgerEdit({ methods: [pm] });
      return OK;
    }
    if (id === 'people') {
      if (!Array.isArray(doc)) return reject('invalid', 'kv/people');
      await this.store.saveLedgerEdit({ people: doc as Person[] });
      return OK;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return reject('invalid', 'kv/settings');
    const priv = Object.fromEntries(Object.entries(this.settings()).filter(([f]) => !isSyncedSetting(f)));
    const synced = projectSettings(doc as Record<string, unknown>) ?? {};
    this.store.apply({ upserts: [], deletes: [], kv: [{ key: 'settings', value: JSON.stringify({ ...priv, ...synced }) }] });
    return OK;
  }

  // —— delete@1 ——

  private async remove(op: SyncOp, today: string): Promise<OpResult> {
    const k = op.target ? splitKey(op.target) : undefined;
    if (!k || (k.kind !== 'sub' && k.kind !== 'method')) return reject('invalid', `delete ${op.target}`);
    if (this.current(op.target!) === undefined) return OK;
    if (k.kind === 'sub') return this.tool('delete_subscription', { subscription: k.id }, today);
    if (op.into && this.store.raw('methods', op.into) === undefined) return reject('target_deleted', `method/${op.into}`);
    if (op.clear && !op.into) {
      // 与网页 DELETE /api/methods/:id?clear 相同：引用清空为「未指定」
      const st = await this.store.loadState();
      const r = deleteMethodData(st, k.id, null);
      await this.store.saveLedgerEdit({ settings: r.settings, subscriptions: r.subscriptions, methods: [] }, [k.id]);
      return OK;
    }
    return this.tool('update_payment_method', { action: 'delete', method: k.id, ...(op.into ? { migrate_to: op.into } : {}) }, today);
  }

  // —— replace@1：受期望哈希保护的整条替换 ——

  private async replace(op: SyncOp): Promise<OpResult> {
    const k = op.target ? splitKey(op.target) : undefined;
    if (!k || k.kind === 'fx' || op.doc === undefined) return reject('invalid', 'replace target/doc');
    if (op.expect !== null && !(op.expect && typeof (op.expect as { hash?: unknown }).hash === 'string')) return reject('invalid', 'replace expect');
    const cur = this.current(op.target!);
    const want = op.expect === null ? null : (op.expect as { hash: string }).hash;
    const have = cur === undefined ? null : await contentHash(cur);
    if (have !== want) return reject('expect_failed', `replace ${op.target}`);
    if (op.doc === null) {
      // 期望相符的删除：等同 delete@1
      return cur === undefined ? OK : this.remove({ ...op, name: 'delete@1' }, op.at!.date!);
    }
    if (cur !== undefined && norm(cur) === norm(k.kind === 'kv' && k.id === 'settings' ? projectSettings(op.doc as Record<string, unknown>) : op.doc)) return OK;
    return this.writeDoc(k.kind, k.id, op.doc, op.at!.date!);
  }

  // —— set_member@1：集合字段加减成员（publicHidden） ——

  private async setMember(op: SyncOp): Promise<OpResult> {
    if (op.target !== 'kv/settings' || op.field !== 'publicHidden' || (typeof op.add !== 'string') === (typeof op.remove !== 'string')) return reject('invalid', 'set_member');
    const s = this.settings();
    const list = Array.isArray(s.publicHidden) ? (s.publicHidden as string[]) : [];
    const next = op.add ? (list.includes(op.add) ? list : [...list, op.add]) : list.filter((x) => x !== op.remove);
    if (next === list || next.length === list.length) return OK;
    this.store.apply({ upserts: [], deletes: [], kv: [{ key: 'settings', value: JSON.stringify({ ...s, publicHidden: next }) }] });
    return OK;
  }

  // —— fx_fill@1：补一天历史汇率，同日期服务器胜 ——

  private async fxFill(op: SyncOp): Promise<OpResult> {
    if (!isDate(op.date) || !op.rates || typeof op.rates !== 'object') return reject('invalid', 'fx_fill');
    if (Object.values(op.rates).some((v) => typeof v !== 'number' || !(v > 0))) return reject('invalid', 'fx_fill rates');
    this.store.fillFx(op.date, op.rates, typeof op.source === 'string' ? op.source : 'app');
    return OK;
  }

  // —— import_ledger@1：用设备账本整本替换同步数据；私有设置保留；同一提交换代际 ——

  private async importLedger(op: SyncOp): Promise<OpResult> {
    if (!Array.isArray(op.objects)) return reject('invalid', 'import_ledger objects');
    const subs: Subscription[] = [];
    const methods: PaymentMethod[] = [];
    let settings: Record<string, unknown> = {};
    let people: Person[] = [];
    const fx: Array<[string, Record<string, number>]> = [];
    for (const pair of op.objects) {
      const k = Array.isArray(pair) ? splitKey(String(pair[0])) : undefined;
      const doc = Array.isArray(pair) ? pair[1] : undefined;
      if (!k || !doc || typeof doc !== 'object') return reject('invalid', `import_ledger ${Array.isArray(pair) ? pair[0] : '?'}`);
      if (k.kind === 'sub') subs.push({ ...(doc as Subscription), id: k.id });
      else if (k.kind === 'method') methods.push({ ...(doc as PaymentMethod), id: k.id });
      else if (k.kind === 'kv' && k.id === 'settings') settings = projectSettings(doc as Record<string, unknown>) ?? {};
      else if (k.kind === 'kv') people = doc as Person[];
      else fx.push([k.id, ((doc as { rates?: Record<string, number> }).rates ?? doc) as Record<string, number>]);
    }
    const priv = Object.fromEntries(Object.entries(this.settings()).filter(([f]) => !isSyncedSetting(f)));
    // 原样写入设备账本的文档（不重盖 updatedAt）：导入后服务器同步视图应逐字节等于副本
    const w: LedgerWrites = {
      upserts: [
        ...subs.map((s) => ({ table: 'subscriptions' as const, id: s.id, data: JSON.stringify(s) })),
        ...methods.map((m) => ({ table: 'methods' as const, id: m.id, data: JSON.stringify(m) })),
      ],
      deletes: [
        ...this.store.ids('subscriptions').filter((id) => !subs.some((s) => s.id === id)).map((id) => ({ table: 'subscriptions' as const, id })),
        ...this.store.ids('methods').filter((id) => !methods.some((m) => m.id === id)).map((id) => ({ table: 'methods' as const, id })),
      ],
      kv: [
        { key: 'settings', value: JSON.stringify({ ...priv, ...settings }) },
        { key: 'people', value: ledgerEditWrites({ people }).kv[0].value },
      ],
    };
    this.store.apply(w);
    for (const [date, rates] of fx) this.store.fillFx(date, rates, 'import');
    return { ok: true, rotate: true };
  }
}


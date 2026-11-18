// App 同步协议的操作集（docs/sync-api.md「操作」）：在 BatchStore 的内存快照上执行一个操作。
// 意图操作直接调现有 MCP 写工具（同一校验与账务口径）；同 id 新建、期望值、补丁原值、按内容定位这些同步专有的前置检查在本层做，
// 不改工具行为，MCP 与网页不受影响。返回 ok 或拒绝码；非业务异常（引擎缺陷）按 invalid / engine_error 拒绝并告警。
import { t } from '../shared/i18n.ts';
import { type PaymentMethod, type Person, type Subscription } from '../shared/types.ts';
import { paymentsOn } from '../shared/phases.ts';
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

const GENERIC = ['noop', 'patch', 'create', 'delete', 'replace', 'set_member', 'fx_fill', 'import_ledger'];

/**
 * 可作为同步意图的写工具：sync-design 4.2 的显式清单。新增 MCP 写工具不会自动进入同步；
 * save_subscription（无期望保护的整条保存）不在内，整条恢复只走带期望哈希的 replace@1。
 */
export const SYNC_INTENTS = [
  'create_subscription',
  'update_subscription',
  'change_price',
  'change_plan',
  'set_status',
  'record_payment',
  'delete_payment',
  'record_transfer',
  'set_meters',
  'add_readings',
  'delete_subscription',
  'set_share',
  'save_share_member',
  'remove_share_member',
  'record_receivable',
  'update_payment_method',
  'save_category',
  'save_person',
  'update_settings',
  'set_proxy',
] as const;

/** update_subscription 的 set 键 → 订阅文档字段 */
const SUB_SET_KEYS: Record<string, string> = {
  show_on_public: 'showOnPublic',
  manage_url: 'manageUrl',
  method: 'methodId',
  remind_days: 'remindDays',
  next_due: 'nextDue',
  trial_end: 'trialEnd',
};
/** 阶段类意图（change_plan）可能改动的顶层字段 */
const PLAN_KEYS = ['price', 'currency', 'cycle', 'billing', 'start', 'end', 'stop', 'status', 'priceHistory', 'phases', 'methodId', 'region', 'planned'];
/** 不按顶层字段比较、由专门规则核对的期望键 */
const SPECIAL_EXPECT = new Set(['readings', 'member', 'record', 'charged']);

/**
 * 修改、删除已有内容的意图在同步路径上必须冻结的期望键（docs/sync-api.md「意图保护」表）。
 * 返回 undefined = 新建、追加或整条删除，不要求期望；按内容定位的内层改删（付款、转让、充值）另由 locate 保护。
 * 新增 SYNC_INTENTS 必须在这里归类（sync.test 遍历白名单核对）。
 */
export function requiredExpect(name: string, a: Record<string, unknown>): string[] | undefined {
  const set = a.set && typeof a.set === 'object' ? Object.keys(a.set as object) : [];
  const action = typeof a.action === 'string' ? a.action : undefined;
  switch (name) {
    case 'update_subscription':
      return set.map((k) => SUB_SET_KEYS[k] ?? k);
    case 'change_price':
      return ['price', 'priceHistory', 'phases'];
    case 'change_plan':
      return PLAN_KEYS;
    case 'set_status':
      return ['status'];
    case 'set_meters':
      return ['meters'];
    case 'add_readings':
      return ['readings'];
    case 'set_share':
      return ['share'];
    case 'set_proxy':
      return ['proxy'];
    case 'save_share_member':
      return a.member != null ? ['member'] : undefined;
    case 'remove_share_member':
      return ['member'];
    case 'record_receivable':
      return action === 'update' || action === 'delete' ? ['record'] : action === 'charged' ? ['charged'] : undefined;
    case 'update_payment_method': {
      if (action === 'create' || action === 'delete') return undefined;
      const keys = set.filter((k) => k !== 'balance' && k !== 'balanceAsOf');
      if (typeof a.name === 'string') keys.push('name');
      if (typeof a.region === 'string') keys.push('region');
      if (a.balance !== undefined || set.includes('balance') || set.includes('balanceAsOf')) keys.push('balance', 'balanceAsOf');
      return keys.length ? [...new Set(keys)] : undefined;
    }
    case 'save_category':
      return action === 'create' ? undefined : ['categories'];
    case 'save_person':
      if (action !== 'update' && action !== undefined) return undefined;
      return [...set, ...('avatar' in a || 'avatar_base64' in a ? ['avatar'] : [])];
    case 'update_settings':
      return set;
    default:
      // create_subscription、record_payment、delete_payment、record_transfer、delete_subscription
      return undefined;
  }
}

const INTENT_TOOLS = new Map<string, Tool>(
  SYNC_INTENTS.map((n) => {
    const tool = TOOLS.find((x) => x.name === n && x.write);
    if (!tool) throw new Error(`sync intent ${n} is not an MCP write tool`);
    return [n, tool];
  }),
);

/** 服务器认识的操作与版本区间（hello.ops）：现在全部只有 @1 */
export const OP_VERSIONS: Record<string, [number, number]> = Object.fromEntries([...GENERIC, ...SYNC_INTENTS].map((n) => [n, [1, 1]]));

/**
 * patch@1 允许 to:null 清空的字段，须与工具 schema（METHOD_FIELDS 等）可空的字段一致；
 * 其余（名称、分类、标签、公开页开关，以及支付方式的 logoWide、order）必须给具体值，null 先判 invalid
 */
const NULLABLE = {
  sub: ['icon', 'url', 'manageUrl', 'methodId', 'region', 'remindDays', 'account', 'notes', 'expires', 'trialEnd', 'chargeLeadDays', 'cancelLeadDays'],
  method: ['color', 'region', 'notes', 'lowRunwayDays', 'brand', 'logo', 'bank', 'network', 'phone', 'url', 'balanceExpires'],
} as const;

/** 没有存值时的等效值：续费提前天数缺省即 0（billing.ts 的 ?? 0），补丁比较与清空都按它 */
const SUB_DEFAULTS: Record<string, unknown> = { chargeLeadDays: 0, cancelLeadDays: 0 };

/** 订阅补丁清空时传给 update_subscription 的值：文本字段的 schema 只收字符串（空串 = 清除） */
const SUB_CLEAR: Record<string, unknown> = { ...SUB_DEFAULTS, url: '', manageUrl: '', notes: '', account: '', region: '' };

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
function patchCheck(
  cur: Record<string, unknown>,
  fields: Record<string, { from: unknown; to: unknown }>,
  defaults: Record<string, unknown> = {},
): { set: Record<string, unknown> } | { err: OpResult } {
  const set: Record<string, unknown> = {};
  for (const [f, change] of Object.entries(fields)) {
    if (!change || typeof change !== 'object' || !('from' in change) || !('to' in change)) return { err: reject('invalid', `fields.${f}`) };
    const n = (v: unknown) => norm(v ?? defaults[f]);
    if (n(cur[f]) === n(change.from)) {
      if (n(change.from) !== n(change.to)) set[f] = change.to;
    } else if (n(cur[f]) !== n(change.to)) return { err: reject('field_changed', `${f}: server=${norm(cur[f])} from=${norm(change.from)}`) };
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
    await INTENT_TOOLS.get(name)!.run(rest, this.ctx(today));
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

  // —— 意图：现有 MCP 写工具（只限 SYNC_INTENTS） ——

  private async intent(name: string, op: SyncOp, today: string): Promise<OpResult> {
    const a = { ...op.args };
    if (name === 'update_settings') {
      if ('channel_enabled' in a || 'prefs' in a) return reject('invalid', 'update_settings: only synced settings');
      const bad = Object.keys((a.set as object) ?? {}).find((k) => !isSyncedSetting(k));
      if (bad) return reject('invalid', `update_settings: ${bad}`);
    }
    if (name === 'record_payment') a.allow_duplicate = true;

    // 同 id 新建（sync-design 1.3）：未提供的键不比较；明确给 null 的按「没有」比较
    const given = (o: Record<string, unknown>, k: string) => (k in o ? (o[k] ?? null) : undefined);
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
          methodId: given(a, 'method'),
        });
      }
    }
    if (name === 'update_payment_method' && a.action === 'create' && typeof a.id === 'string') {
      const cur = this.store.raw('methods', a.id) as Record<string, unknown> | undefined;
      if (cur) {
        const set = (a.set ?? {}) as Record<string, unknown>;
        const balance = given(set, 'balance');
        return sameOrConflict(cur, {
          name: set.name,
          kind: set.kind,
          currency: set.currency,
          balance,
          balanceAsOf: balance === undefined ? undefined : balance === null ? null : (set.balanceAsOf ?? today),
        });
      }
    }
    if (name === 'save_person' && a.action === 'create' && typeof a.id === 'string') {
      const cur = this.people().find((p) => p.id === a.id);
      if (cur) return sameOrConflict(cur as unknown as Record<string, unknown>, { name: (a.set as Record<string, unknown> | undefined)?.name });
    }

    // 目标已删：删除类视为达成，其余 target_deleted
    const deleting =
      name === 'delete_subscription' || (name === 'update_payment_method' && a.action === 'delete') || (name === 'save_person' && a.action === 'delete');
    const creating = name === 'create_subscription' || a.action === 'create';
    const target = op.target ? splitKey(op.target) : undefined;
    // 修改类意图缺定位或期望 → invalid，不按无保护写入执行（先于目标查找：缺保护本身就是错误请求）
    const guard = this.requiredGuard(name, a, op, target?.kind);
    if (guard) return guard;
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

    // 期望字段逐个比较目标当前值（sync-design 4.4）；成员、收款记录、代付实扣、读数另有专门规则
    if (op.expect && typeof op.expect === 'object' && !('hash' in op.expect)) {
      const fields = Object.entries(op.expect as Record<string, unknown>).filter(([k]) => !SPECIAL_EXPECT.has(k));
      const cur = doc ?? (target?.kind === 'kv' ? ((this.current(op.target!) as Record<string, unknown> | undefined) ?? {}) : undefined);
      if (fields.length && !cur) return reject('target_deleted', op.target ?? '');
      for (const [k, v] of fields) if (norm(cur![k]) !== norm(v)) return reject('expect_failed', `${k}: server=${norm(cur![k])} expect=${norm(v)}`);
      const inner = this.checkInner(name, a, op.expect as Record<string, unknown>, doc);
      if (inner) return inner;
    }

    // 读数：逐条比较本次要改、要删的那几条（sync-design 4.4）
    if (name === 'add_readings') {
      const r = this.checkReadings(a, op, doc as unknown as Subscription);
      if (r) return r;
    }

    // 内层记录按内容定位（sync-design 4.3）：换算成工具认的序号；设备上的序号一律不用
    const located = await this.locateRecord(name, a, op, target?.id, today);
    if (located) return located;
    return this.tool(name, a, today);
  }

  /** 同步路径上必须有保护条件的意图：缺定位或期望 → invalid */
  private requiredGuard(name: string, a: Record<string, unknown>, op: SyncOp, kind: string | undefined): OpResult | undefined {
    const expect = op.expect && typeof op.expect === 'object' && !('hash' in op.expect) ? (op.expect as Record<string, unknown>) : undefined;
    const needLocate =
      (name === 'record_payment' && a.replace != null) ||
      name === 'delete_payment' ||
      (name === 'record_transfer' && (a.replace != null || a.delete != null)) ||
      (name === 'update_payment_method' && (a.top_up_action === 'update' || a.top_up_action === 'delete'));
    if (needLocate) {
      const l = op.locate;
      if (!l || !isDate(l.date) || !l.match || typeof l.match !== 'object' || !Number.isInteger(l.count) || l.count < 1)
        return reject('invalid', `${name}: locate`);
    }
    const need = requiredExpect(name, a);
    // 期望与定位都针对 target 那一条：必须有 target，且与参数按 id 指向同一条（不接受名称、人员推断）
    if (needLocate || need?.length) {
      const want =
        name === 'update_payment_method' ? 'method' : name === 'save_category' || name === 'update_settings' ? 'kv' : name === 'save_person' ? 'kv' : 'sub';
      const ref = want === 'method' ? a.method : want === 'kv' ? (name === 'save_person' ? 'people' : 'settings') : a.subscription;
      if (kind !== want || !op.target || ref !== splitKey(op.target)?.id) return reject('invalid', `${name}: target`);
      if (name === 'record_receivable' && a.person != null) return reject('invalid', `${name}: person`);
    }
    if (need?.length) {
      const missing = need.find((k) => !expect || !(k in expect));
      if (missing) return reject('invalid', `${name}: expect.${missing}`);
      if (name === 'add_readings' && !Array.isArray(expect!.readings)) return reject('invalid', 'add_readings: expect.readings');
      if ((need.includes('member') || need.includes('record')) && typeof a.member !== 'string' && name !== 'record_receivable')
        return reject('invalid', `${name}: member id`);
      if (need.includes('record') && typeof a.id !== 'string') return reject('invalid', `${name}: id`);
      if (need.includes('charged') && !isDate(a.charge)) return reject('invalid', `${name}: charge`);
    }
    return undefined;
  }

  /**
   * 成员、收款记录、代付实扣的期望（docs/sync-api.md「意图保护」）：按 id / 日期找到服务器上的那一项，与冻结内容逐字段相同。
   * 删除类目标已不在 = 已达成；修改类 target_deleted。
   */
  private checkInner(
    name: string,
    a: Record<string, unknown>,
    expect: Record<string, unknown>,
    doc: Record<string, unknown> | undefined,
  ): OpResult | undefined {
    const s = doc as unknown as Subscription | undefined;
    const removing = name === 'remove_share_member' || (name === 'record_receivable' && a.action === 'delete');
    const same = (what: string, cur: unknown, want: unknown) =>
      norm(cur) === norm(want) ? undefined : reject('expect_failed', `${what}: server=${norm(cur)} expect=${norm(want)}`);
    if ('member' in expect && (name === 'save_share_member' || name === 'remove_share_member')) {
      const m = s?.share?.members.find((x) => x.id === a.member);
      if (!m) return removing ? OK : reject('target_deleted', `member/${String(a.member)}`);
      return same('member', m, expect.member);
    }
    if ('record' in expect && name === 'record_receivable') {
      const kind = a.member != null ? 'share' : 'proxy';
      if (a.kind != null && a.kind !== kind) return reject('invalid', 'record_receivable: kind');
      const owner = kind === 'share' ? s?.share?.members.find((x) => x.id === a.member) : s?.proxy;
      const rec = owner ? [...(owner.receipts ?? []), ...(owner.waivers ?? [])].find((x) => x.id === a.id) : undefined;
      if (!rec) return removing ? OK : reject('target_deleted', `receivable/${String(a.id)}`);
      return same('record', rec, expect.record);
    }
    if ('charged' in expect && name === 'record_receivable') {
      if (!s?.proxy) return reject('target_deleted', 'proxy');
      return same(
        'charged',
        s.proxy.charged?.find((x) => x.charge === a.charge),
        expect.charged,
      );
    }
    return undefined;
  }

  /**
   * add_readings 的期望：expect.readings 列出本次每条输入（按 id，或无 id 时按日期）与每个要删的 id 在设备上看到的原样，
   * 设备上没有的写 { id 或 date, absent: true }。服务器上同一条（工具同一匹配规则）必须逐字段相同。
   */
  private checkReadings(a: Record<string, unknown>, op: SyncOp, s: Subscription): OpResult | undefined {
    const frozen = (op.expect as { readings: Array<Record<string, unknown>> }).readings;
    const list = s.readings ?? [];
    const keyOf = (x: Record<string, unknown>) => (typeof x.id === 'string' && x.id ? `id:${x.id}` : `date:${String(x.date)}`);
    // 冻结的一条可按 id 或日期认领（输入不带 id 时工具按日期合并）
    const want = new Map<string, Record<string, unknown>>();
    for (const f of frozen) {
      if (!f || typeof f !== 'object') return reject('invalid', 'expect.readings');
      if (typeof f.id === 'string' && f.id) want.set(`id:${f.id}`, f);
      if (typeof f.date === 'string') want.set(`date:${f.date}`, f);
    }
    const inputs = ((a.readings as Array<Record<string, unknown>> | undefined) ?? []).map((x) => ({
      key: keyOf(x),
      find: () => list.find((r) => (typeof x.id === 'string' && x.id ? r.id === x.id : r.date === x.date)),
    }));
    const deletes = ((a.delete as unknown[] | undefined) ?? []).map((id) => ({ key: `id:${String(id)}`, find: () => list.find((r) => r.id === id) }));
    for (const { key, find } of [...inputs, ...deletes]) {
      const f = want.get(key);
      if (!f) return reject('invalid', `expect.readings: ${key}`);
      const cur = find();
      if (f.absent === true ? cur !== undefined : norm(cur) !== norm({ ...f, absent: undefined }))
        return reject('expect_failed', `reading ${key}: server=${norm(cur)} expect=${norm(f)}`);
    }
    return undefined;
  }

  /** 按内容与冻结笔数定位内层记录（sync-design 4.3）。0 命中 target_deleted；命中数与冻结笔数不同 expect_failed；否则取第一条 */
  private async locateRecord(name: string, a: Record<string, unknown>, op: SyncOp, id: string | undefined, today: string): Promise<OpResult | undefined> {
    const l = op.locate;
    if (!l || !id) return undefined;
    const st = await this.store.loadState();
    const pick = <T>(list: T[], what: string): number | OpResult => {
      const hit = (x: T) => Object.entries(l.match).every(([k, v]) => norm((x as Record<string, unknown>)[k]) === norm(v));
      const n = list.filter(hit).length;
      if (!n) return reject('target_deleted', `${what} ${l.date}`);
      if (n !== l.count) return reject('expect_failed', `${what}(${l.date}) server=${n} expect=${l.count}`);
      return list.findIndex(hit);
    };
    if (name === 'record_payment' || name === 'delete_payment') {
      if (name === 'record_payment' && a.replace == null) return undefined;
      const s = st.subscriptions.find((x) => x.id === id);
      if (!s) return reject('target_deleted', `sub/${id}`);
      const phase = isDate(a.phase) ? a.phase : undefined;
      const i = pick(paymentsOn(s, today, l.date, phase), 'payment');
      if (typeof i !== 'number') return i;
      if (name === 'record_payment') a.replace = { date: l.date, index: i };
      else Object.assign(a, { date: l.date, index: i });
      return undefined;
    }
    if (name === 'record_transfer') {
      if (a.replace == null && a.delete == null) return undefined;
      const s = st.subscriptions.find((x) => x.id === id);
      if (!s) return reject('target_deleted', `sub/${id}`);
      const i = pick(
        (s.transfers ?? []).filter((x) => x.date === l.date),
        'transfer',
      );
      if (typeof i !== 'number') return i;
      a[a.delete != null ? 'delete' : 'replace'] = { date: l.date, index: i };
      return undefined;
    }
    if (name === 'update_payment_method' && (a.top_up_action === 'update' || a.top_up_action === 'delete')) {
      const m = st.methods.find((x) => x.id === id);
      if (!m) return reject('target_deleted', `method/${id}`);
      const tops = m.topUps ?? [];
      const sameDay = tops.map((x, k) => [x, k] as const).filter(([x]) => x.date === l.date);
      const i = pick(
        sameDay.map(([x]) => x),
        'top_up',
      );
      if (typeof i !== 'number') return i;
      a.top_up_index = sameDay[i][1];
      a.expected_top_up = sameDay[i][0];
    }
    return undefined;
  }

  // —— patch@1 ——

  private async patch(op: SyncOp, today: string): Promise<OpResult> {
    const k = op.target ? splitKey(op.target) : undefined;
    if (!k || !op.fields || typeof op.fields !== 'object') return reject('invalid', 'patch target/fields');
    const table = k.kind === 'sub' ? PATCH_FIELDS.sub : k.kind === 'method' ? PATCH_FIELDS.method : k.kind === 'kv' && k.id === 'settings' ? null : undefined;
    if (table === undefined) return reject('invalid', `patch ${op.target}`);
    const bad = Object.keys(op.fields).find((f) => (table ? !(f in table) : !isSyncedSetting(f)));
    if (bad) return reject('invalid', `patch field ${bad}`);
    if (table) {
      const noClear = Object.entries(op.fields).find(
        ([f, c]) => c && typeof c === 'object' && (c as { to?: unknown }).to === null && !(NULLABLE as Record<string, readonly string[]>)[k.kind].includes(f),
      );
      if (noClear) return reject('invalid', `patch ${noClear[0]}: not clearable`);
    }
    const cur = k.kind === 'kv' ? this.settings() : (this.current(op.target!) as Record<string, unknown> | undefined);
    if (!cur) return reject('target_deleted', op.target!);
    const checked = patchCheck(cur, op.fields, k.kind === 'sub' ? SUB_DEFAULTS : {});
    if ('err' in checked) return checked.err;
    const set = checked.set;
    if (!Object.keys(set).length) return OK;
    if (k.kind === 'sub') {
      // 清空值按 update_subscription 的字段约定：文本字段传空串，续费提前天数传 0，其余可空字段传 null
      const args = Object.fromEntries(
        Object.entries(set).map(([f, v]) => [(PATCH_FIELDS.sub as Record<string, string>)[f], v === null ? (f in SUB_CLEAR ? SUB_CLEAR[f] : null) : v]),
      );
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
    if (cur !== undefined && norm(cur) === norm(k.kind === 'kv' && k.id === 'settings' ? projectSettings(op.doc as Record<string, unknown>) : op.doc))
      return OK;
    return this.writeDoc(k.kind, k.id, op.doc, op.at!.date!);
  }

  // —— set_member@1：集合字段加减成员（publicHidden） ——

  private async setMember(op: SyncOp): Promise<OpResult> {
    if (op.target !== 'kv/settings' || op.field !== 'publicHidden' || (typeof op.add !== 'string') === (typeof op.remove !== 'string'))
      return reject('invalid', 'set_member');
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
    let people: Person[] | undefined;
    const fx: Array<[string, Record<string, number>, string]> = [];
    for (const pair of op.objects) {
      const k = Array.isArray(pair) ? splitKey(String(pair[0])) : undefined;
      const doc = Array.isArray(pair) ? pair[1] : undefined;
      if (!k || !doc || typeof doc !== 'object') return reject('invalid', `import_ledger ${Array.isArray(pair) ? pair[0] : '?'}`);
      if (k.kind === 'sub') subs.push({ ...(doc as Subscription), id: k.id });
      else if (k.kind === 'method') methods.push({ ...(doc as PaymentMethod), id: k.id });
      else if (k.kind === 'kv' && k.id === 'settings') settings = projectSettings(doc as Record<string, unknown>) ?? {};
      else if (k.kind === 'kv') people = doc as Person[];
      else {
        const d = doc as { rates?: Record<string, number>; source?: unknown };
        fx.push([k.id, (d.rates ?? doc) as Record<string, number>, typeof d.source === 'string' ? d.source : 'import']);
      }
    }
    const priv = Object.fromEntries(Object.entries(this.settings()).filter(([f]) => !isSyncedSetting(f)));
    // 原样写入设备账本的文档（不重盖 updatedAt）：导入后服务器同步视图应逐字节等于副本
    const w: LedgerWrites = {
      upserts: [
        ...subs.map((s) => ({ table: 'subscriptions' as const, id: s.id, data: JSON.stringify(s) })),
        ...methods.map((m) => ({ table: 'methods' as const, id: m.id, data: JSON.stringify(m) })),
      ],
      deletes: [
        ...this.store
          .ids('subscriptions')
          .filter((id) => !subs.some((s) => s.id === id))
          .map((id) => ({ table: 'subscriptions' as const, id })),
        ...this.store
          .ids('methods')
          .filter((id) => !methods.some((m) => m.id === id))
          .map((id) => ({ table: 'methods' as const, id })),
      ],
      kv: [{ key: 'settings', value: JSON.stringify({ ...priv, ...settings }) }],
    };
    // 设备账本没有名册：服务器原本也没有就保持没有（不凭空写出空名册），有则清空
    if (people || this.store.rawKv('people') !== undefined) w.kv.push({ key: 'people', value: ledgerEditWrites({ people: people ?? [] }).kv[0].value });
    this.store.apply(w);
    // 历史汇率按恢复备份同一语义：副本里有的日期以副本为准（含来源），副本没有的日期保留
    for (const [date, rates, source] of fx) this.store.putFx(date, rates, source);
    return { ok: true, rotate: true };
  }
}

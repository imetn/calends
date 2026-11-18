// 同步的批量执行接缝：整批只读一次库，所有操作在同一份内存行快照上执行，最后由同步处理器一次提交。
// 每次读账本都用 deriveState 从当前行重新推导，与逐个调用（每次 loadState(env, false) 读库）同一口径；
// 每次写入经 ledgerEditWrites 得到与 saveLedgerEdit 完全相同的 JSON 文本，再写进内存行。
import type { AppState } from '../shared/types.ts';
import type { LedgerStore } from './ai/tool-kit.ts';
import type { Env } from './env.ts';
import { deriveState, ledgerEditWrites, ledgerWriteStmts, type LedgerRows, type LedgerWrites } from './store.ts';

type FxRow = { rates: string; source: string };

interface Rows {
  subscriptions: Map<string, string>;
  methods: Map<string, string>;
  kv: Map<string, string>;
  fx: Map<string, FxRow>;
}

const copy = (r: Rows): Rows => ({ subscriptions: new Map(r.subscriptions), methods: new Map(r.methods), kv: new Map(r.kv), fx: new Map(r.fx) });

/** 批量快照要读的行；与 sync_meta 等放在同一个 D1 batch 里读，保证是一份一致快照 */
export const batchReadStmts = (env: Env): D1PreparedStatement[] => [
  env.DB.prepare('SELECT id, data FROM subscriptions'),
  env.DB.prepare('SELECT id, data FROM methods'),
  env.DB.prepare("SELECT key, value FROM kv WHERE key IN ('settings', 'fx', 'people', 'prefs', 'rev')"),
  env.DB.prepare('SELECT date, rates, source FROM fx_daily'),
];

export class BatchStore implements LedgerStore {
  private readonly initial: Rows;
  private rows: Rows;

  constructor(results: D1Result[]) {
    const pairs = <T>(i: number) => (results[i] as D1Result<T>).results;
    this.initial = {
      subscriptions: new Map(pairs<{ id: string; data: string }>(0).map((r) => [r.id, r.data])),
      methods: new Map(pairs<{ id: string; data: string }>(1).map((r) => [r.id, r.data])),
      kv: new Map(pairs<{ key: string; value: string }>(2).map((r) => [r.key, r.value])),
      fx: new Map(pairs<{ date: string; rates: string; source: string }>(3).map((r) => [r.date, { rates: r.rates, source: r.source }])),
    };
    this.rows = copy(this.initial);
  }

  private ledgerRows(): LedgerRows {
    return {
      subscriptions: [...this.rows.subscriptions.values()],
      methods: [...this.rows.methods.values()],
      kv: Object.fromEntries(this.rows.kv),
      fxDaily: [...this.rows.fx].map(([date, r]) => ({ date, rates: r.rates })),
    };
  }

  async loadState(): Promise<AppState> {
    return deriveState(this.ledgerRows());
  }

  async saveLedgerEdit(patch: Partial<AppState>, deletedMethods: string[] = [], deletedSubscriptions: string[] = []): Promise<void> {
    this.apply(ledgerEditWrites(patch, deletedMethods, deletedSubscriptions));
  }

  /** 应用一份与 saveLedgerEdit 同格式的写入（同步层的整条写入也走这里） */
  apply(w: LedgerWrites): void {
    for (const u of w.upserts) this.rows[u.table].set(u.id, u.data);
    for (const d of w.deletes) this.rows[d.table].delete(d.id);
    for (const k of w.kv) this.rows.kv.set(k.key, k.value);
  }

  /** 历史汇率：同日期服务器胜（ON CONFLICT DO NOTHING） */
  fillFx(date: string, rates: Record<string, number>, source: string): void {
    if (!this.rows.fx.has(date)) this.rows.fx.set(date, { rates: JSON.stringify(rates), source });
  }

  /** 原始文档（未推导）：sub/<id>、method/<id> 的 data，kv 的值 */
  raw(table: 'subscriptions' | 'methods', id: string): unknown {
    const d = this.rows[table].get(id);
    return d === undefined ? undefined : JSON.parse(d);
  }
  rawKv(key: string): unknown {
    const v = this.rows.kv.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }
  ids(table: 'subscriptions' | 'methods'): string[] {
    return [...this.rows[table].keys()];
  }

  /** 保存点：每个操作一个，只有 ok 才保留 */
  savepoint(): Rows {
    return copy(this.rows);
  }
  rollback(sp: Rows): void {
    this.rows = sp;
  }

  /** 与读入时相比的净变化，生成提交语句（触发器据此推进同步序号；同值写入不涨） */
  commitStmts(env: Env): D1PreparedStatement[] {
    const w: LedgerWrites = { upserts: [], deletes: [], kv: [] };
    for (const table of ['subscriptions', 'methods'] as const) {
      for (const id of this.initial[table].keys()) if (!this.rows[table].has(id)) w.deletes.push({ table, id });
      for (const [id, data] of this.rows[table]) if (this.initial[table].get(id) !== data) w.upserts.push({ table, id, data });
    }
    for (const key of ['settings', 'people', 'prefs'] as const) {
      const v = this.rows.kv.get(key);
      if (v !== undefined && v !== this.initial.kv.get(key)) w.kv.push({ key, value: v });
    }
    const fx = [...this.rows.fx]
      .filter(([date]) => !this.initial.fx.has(date))
      .map(([date, r]) =>
        env.DB.prepare('INSERT INTO fx_daily (date, rates, source) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO NOTHING').bind(date, r.rates, r.source),
      );
    return [...ledgerWriteStmts(env, w), ...fx];
  }

  changed(): boolean {
    const same = <V>(a: Map<string, V>, b: Map<string, V>, eq = (x: V, y: V) => x === y) =>
      a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k)!));
    return !(
      same(this.initial.subscriptions, this.rows.subscriptions) &&
      same(this.initial.methods, this.rows.methods) &&
      same(this.initial.kv, this.rows.kv) &&
      same(this.initial.fx, this.rows.fx, (x, y) => x.rates === y.rates && x.source === y.source)
    );
  }
}

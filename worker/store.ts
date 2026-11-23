import { validatePeopleAvatars } from '../shared/avatar.ts';
import { FALLBACK_FX, migrateStored } from '../shared/billing.ts';
import { DEFAULT_SETTINGS, type AppState, type FxTable, type PaymentMethod, type Person, type Settings, type Subscription } from '../shared/types.ts';
import { t } from '../shared/i18n.ts';
import { pruneSettingsRefs } from '../shared/ledger-edit.ts';
import { linkPeople } from '../shared/people.ts';
import { migrateReceivables } from '../shared/receivables-legacy.ts';
import type { Prefs } from '../shared/prefs.ts';
import type { Env } from './env.ts';
import { keepSet, putFxDayStmt, slimFxHistory } from './fx.ts';

const revSql = "SELECT CAST(value AS INTEGER) AS rev FROM kv WHERE key = 'rev'";

export async function getRev(env: Env): Promise<number> {
  const row = await env.DB.prepare(revSql).first<{ rev: number }>();
  if (!row) throw new Error('Missing ledger revision');
  return row.rev;
}

/** Return the revision in the same transaction as the writes (triggers increment it). */
export interface Revision {
  from: number;
  rev: number;
}

/** Raised when a guarded write loses a race against a concurrent ledger commit. */
export class RevConflictError extends Error {
  constructor() {
    super(t('server.conflict'));
  }
}

/**
 * 乐观锁语句：只在 kv.rev 与 expectedRev 不一致时尝试插入重复主键 'rev'，触发约束错误使整批 D1/SQLite 事务回滚；
 * 版本一致时 SELECT 为空，不插入任何行、不触发触发器。
 */
const revGuardStmt = (env: Env, expectedRev: number): D1PreparedStatement =>
  env.DB.prepare("INSERT INTO kv (key, value, updated_at) SELECT 'rev', value, updated_at FROM kv WHERE key = 'rev' AND CAST(value AS INTEGER) != ?1").bind(
    expectedRev,
  );

async function mutate(env: Env, stmts: D1PreparedStatement[], expectedRev?: number): Promise<Revision> {
  const guard = expectedRev == null ? [] : [revGuardStmt(env, expectedRev)];
  try {
    const results = await env.DB.batch<{ rev: number }>([env.DB.prepare(revSql), ...guard, ...stmts, env.DB.prepare(revSql)]);
    return { from: results[0].results[0].rev, rev: results[results.length - 1].results[0].rev };
  } catch (err) {
    if (expectedRev != null && /UNIQUE|PRIMARY KEY|constraint/i.test(String((err as { message?: unknown })?.message ?? err))) {
      const current = await getRev(env).catch(() => expectedRev);
      if (current !== expectedRev) throw new RevConflictError();
    }
    throw err;
  }
}

export async function getKv<T>(env: Env, key: string): Promise<T | undefined> {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?1').bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : undefined;
}

function putKvStmt(env: Env, key: string, value: unknown): D1PreparedStatement {
  if (key === 'people') validatePeopleAvatars(value as Person[]);
  return env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, JSON.stringify(value));
}

export async function putKv(env: Env, key: string, value: unknown): Promise<Revision | undefined> {
  if (['settings', 'people', 'prefs', 'fx'].includes(key)) return mutate(env, [putKvStmt(env, key, value)]);
  await putKvStmt(env, key, value).run();
}

export async function getSettings(env: Env): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getKv<Settings>(env, 'settings')) };
}

export async function getFx(env: Env): Promise<FxTable> {
  return (await getKv<FxTable>(env, 'fx')) ?? FALLBACK_FX;
}

/** 人的名册：存成 kv 里的一个数组（单用户、量小，不必单独建表，也省掉一次迁移） */
export async function getPeople(env: Env): Promise<Person[]> {
  return (await getKv<Person[]>(env, 'people')) ?? [];
}

const putPeopleStmt = (env: Env, people: Person[]): D1PreparedStatement =>
  env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES ('people', ?1, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(JSON.stringify(people));

/**
 * 把名册和改动过的订阅一起写入：一个 batch 即一个事务，不会只写进一半。
 * D1 不限制一次 batch 的语句数（整个 batch 只算一次查询），单条语句、单行各有 100 KB / 2 MB 的上限。
 */
export async function writePeople(env: Env, people: Person[] | undefined, subs: Subscription[], expectedRev?: number): Promise<Revision | undefined> {
  if (people) validatePeopleAvatars(people);
  const now = new Date().toISOString();
  const stmts = [...(people ? [putPeopleStmt(env, people)] : []), ...subs.map((s) => upsertStmt(env, 'subscriptions', s.id, stamp(s, now)))];
  return stmts.length ? mutate(env, stmts, expectedRev) : undefined;
}

/**
 * 自动建档（一次性迁移，可重复执行）：老数据里的合租成员、代付对象还没有 personId 时，按称呼 + 联系方式归并成人并写回。
 * 全部关联后这里不再写库；导入、恢复了旧备份时会再补一次。id 由数据算出，同时打开两个标签页也不会重复建档。
 */
async function ensurePeople(env: Env, state: AppState): Promise<boolean> {
  const r = linkPeople(state.people ?? [], state.subscriptions);
  if (!r.created.length && !r.subs.length) return false;
  await writePeople(env, r.created.length ? r.people : undefined, r.subs, state.rev);
  state.people = r.people;
  return true;
}

/**
 * 旧版应收（已付至、按覆盖期记的收款、代付逐期记录）一次性转成按期记账（可重复执行，转过的原样返回）。
 * 内存里总是转好再用；write 时写回库里，导入、恢复了旧备份后也会再转一次
 */
async function ensureReceivables(env: Env, state: AppState, write: boolean): Promise<boolean> {
  const changed: Subscription[] = [];
  state.subscriptions = state.subscriptions.map((s) => {
    const next = migrateReceivables(s, state.settings.baseCurrency);
    if (next !== s) changed.push(next);
    return next;
  });
  if (!changed.length || !write) return false;
  await writePeople(env, undefined, changed, state.rev);
  return true;
}

export async function loadState(env: Env, migratePeople = true, attempts = 0): Promise<AppState> {
  // D1 batch reads one transactional snapshot: never pair stale data with a newer rev.
  const rows = await env.DB.batch([
    env.DB.prepare('SELECT data FROM subscriptions'),
    env.DB.prepare('SELECT data FROM methods'),
    env.DB.prepare("SELECT key, value FROM kv WHERE key IN ('settings', 'fx', 'people', 'prefs', 'rev')"),
    env.DB.prepare('SELECT date, rates FROM fx_daily'),
  ]);
  const subs = rows[0] as D1Result<{ data: string }>;
  const methods = rows[1] as D1Result<{ data: string }>;
  const kv = Object.fromEntries((rows[2] as D1Result<{ key: string; value: string }>).results.map((r) => [r.key, JSON.parse(r.value)]));
  if (typeof kv.rev !== 'number') throw new Error('Missing ledger revision');
  const state: AppState = {
    rev: kv.rev,
    subscriptions: subs.results.map((r) => migrateStored(JSON.parse(r.data) as Subscription)),
    // 按用户在钱包里拖出来的顺序；没排过的保持原有先后
    methods: methods.results
      .map((r) => JSON.parse(r.data) as PaymentMethod)
      .map((m, i) => ({ m, i }))
      .sort((a, b) => (a.m.order ?? 1e9) - (b.m.order ?? 1e9) || a.i - b.i)
      .map((x) => x.m),
    people: kv.people ?? [],
    settings: { ...DEFAULT_SETTINGS, ...kv.settings },
    fx: kv.fx ?? FALLBACK_FX,
    prefs: (kv.prefs as Prefs | undefined) ?? {},
  };
  // 旧版删除留下的悬空引用（公开页隐藏、默认支付方式）只在内存里剔除，不改库
  state.settings = pruneSettingsRefs(state.settings, state.subscriptions, state.methods);
  if (migratePeople) {
    try {
      if ((await ensureReceivables(env, state, true)) || (await ensurePeople(env, state))) return loadState(env, true, attempts);
    } catch (e) {
      if (e instanceof RevConflictError && attempts < 5) return loadState(env, true, attempts + 1);
      throw e;
    }
  } else {
    await ensureReceivables(env, state, false);
  }
  state.fxHistory = slimFxHistory((rows[3] as D1Result<{ date: string; rates: string }>).results, keepSet(state));
  return state;
}

type Table = 'subscriptions' | 'methods';

/**
 * 订阅的 updatedAt 只在这里写：网页、MCP、助手、名册同步、分类改名等所有经存储层的写入都记下当时时间。
 * 导入与备份恢复（replaceAll / restoreLedger）原样保留记录里的值。原地写入，调用方返回的对象也带上它。
 */
function stamp(s: Subscription, now: string): Subscription {
  s.updatedAt = now;
  return s;
}

function upsertStmt(env: Env, table: Table, id: string, data: unknown): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO ${table} (id, data, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(id, JSON.stringify(data));
}

export async function upsert(env: Env, table: Table, id: string, data: unknown, expectedRev?: number): Promise<Revision> {
  if (table === 'subscriptions') stamp(data as Subscription, new Date().toISOString());
  return mutate(env, [upsertStmt(env, table, id, data)], expectedRev);
}

export async function remove(env: Env, table: Table, id: string): Promise<Revision> {
  return mutate(env, [env.DB.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id)]);
}

export async function replaceAll(env: Env, subs: Subscription[], methods: PaymentMethod[], mode: 'merge' | 'replace', expectedRev?: number): Promise<Revision> {
  const stmts: D1PreparedStatement[] = [];
  if (mode === 'replace') {
    stmts.push(env.DB.prepare('DELETE FROM subscriptions'), env.DB.prepare('DELETE FROM methods'));
  }
  for (const m of methods) stmts.push(upsertStmt(env, 'methods', m.id, m));
  for (const s of subs) stmts.push(upsertStmt(env, 'subscriptions', s.id, s));
  return mutate(env, stmts, expectedRev);
}

/** 支付方式原样读取（不排序）；网页、导入写入前的校验用 */
export async function loadMethods(env: Env): Promise<PaymentMethod[]> {
  return (await env.DB.prepare('SELECT data FROM methods').all<{ data: string }>()).results.map((r) => JSON.parse(r.data) as PaymentMethod);
}

/** 订阅（续费规则按旧数据兼容转换，与 loadState 同一口径） */
export async function loadSubs(env: Env): Promise<Subscription[]> {
  return (await env.DB.prepare('SELECT data FROM subscriptions').all<{ data: string }>()).results.map((r) => migrateStored(JSON.parse(r.data) as Subscription));
}

/** 在同一个 D1 batch 快照中读取 rev 与全部订阅，供校验 + 版本守卫写入使用 */
export async function loadSubsWithRev(env: Env): Promise<{ rev: number; subscriptions: Subscription[] }> {
  const rows = await env.DB.batch([env.DB.prepare(revSql), env.DB.prepare('SELECT data FROM subscriptions')]);
  const revRow = (rows[0] as D1Result<{ rev: number }>).results[0];
  if (!revRow) throw new Error('Missing ledger revision');
  const subscriptions = (rows[1] as D1Result<{ data: string }>).results.map((r) => migrateStored(JSON.parse(r.data) as Subscription));
  return { rev: revRow.rev, subscriptions };
}

/**
 * 备份恢复：订阅、支付方式整体替换，名册、设置、当前汇率替换，历史汇率按日期合并——全部在同一个事务里。
 * 任何一条失败（如备份里的历史汇率缺字段）都整体回滚，原账本保持不变。
 */
export async function restoreLedger(
  env: Env,
  b: {
    subscriptions: Subscription[];
    methods: PaymentMethod[];
    people: Person[];
    settings?: Settings;
    fx?: FxTable;
    fxDaily: Array<{ date: string; rates: Record<string, number>; source: string }>;
  },
): Promise<Revision> {
  validatePeopleAvatars(b.people);
  return mutate(env, [
    env.DB.prepare('DELETE FROM subscriptions'),
    env.DB.prepare('DELETE FROM methods'),
    ...b.methods.map((m) => upsertStmt(env, 'methods', m.id, m)),
    ...b.subscriptions.map((s) => upsertStmt(env, 'subscriptions', s.id, s)),
    putKvStmt(env, 'people', b.people),
    ...(b.settings ? [putKvStmt(env, 'settings', b.settings)] : []),
    ...(b.fx ? [putKvStmt(env, 'fx', b.fx)] : []),
    ...b.fxDaily.map((d) => putFxDayStmt(env, d.date, d.rates, d.source)),
  ]);
}

/** 设置和改动的订阅在同一个 batch 里写入（D1 batch 是一个事务）：分类改名时不会只改了一半 */
export async function saveSettingsWithSubs(env: Env, settings: Settings, subs: Subscription[], expectedRev?: number): Promise<Revision> {
  const now = new Date().toISOString();
  return mutate(env, [putKvStmt(env, 'settings', settings), ...subs.map((s) => upsertStmt(env, 'subscriptions', s.id, stamp(s, now)))], expectedRev);
}

/** Atomic multi-entity tool write: never leave a migration or settings/prefs edit half-applied. */
export async function saveLedgerEdit(
  env: Env,
  patch: Partial<AppState>,
  deletedMethods: string[] = [],
  deletedSubscriptions: string[] = [],
  expectedRev?: number,
): Promise<Revision> {
  const now = new Date().toISOString();
  const stmts = [
    ...(patch.subscriptions ?? []).map((s) => upsertStmt(env, 'subscriptions', s.id, stamp(s, now))),
    ...(patch.methods ?? []).map((m) => upsertStmt(env, 'methods', m.id, m)),
    ...deletedMethods.map((id) => env.DB.prepare('DELETE FROM methods WHERE id = ?1').bind(id)),
    ...deletedSubscriptions.map((id) => env.DB.prepare('DELETE FROM subscriptions WHERE id = ?1').bind(id)),
    ...(['settings', 'people', 'prefs'] as const).filter((k) => patch[k] !== undefined).map((k) => putKvStmt(env, k, patch[k])),
  ];
  return mutate(env, stmts, expectedRev);
}

// 操作集：模拟器的操作（kind）翻译成线上操作（docs/sync-api.md「操作」），服务器与客户端执行同一份代码——
// Worker 的 SyncExec 在 BatchStore 内存快照上执行，成功后把净变化写回本库。
// 返回 { ok: true } 或 { ok: false, code, detail }；引擎异常（engine_error）记为 bug，测试直接失败。
import { envOf, setToday, worker } from './engine.mjs';

const { SyncExec, BatchStore, batchReadStmts, contentHash } = worker;

const people = (db) => {
  const r = db.prepare("SELECT value FROM kv WHERE key = 'people'").get();
  return r ? JSON.parse(r.value) : [];
};
export const settingsOf = (db) => {
  const r = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get();
  return r ? JSON.parse(r.value) : {};
};

/** 模拟器操作 → 线上操作（不含 at.date 以外的时间） */
export async function toWire(op) {
  const at = { date: op.at };
  const w = (name, rest = {}) => ({ name, at, ...rest });
  switch (op.kind) {
    case 'noop':
      return w('noop@1');
    case 'create_sub':
      return w('create_subscription@1', {
        target: `sub/${op.id}`,
        args: { id: op.id, name: op.name, price: op.price, currency: 'USD', cycle: { unit: 'month' }, start: op.at, method: op.method ?? undefined, force: true },
      });
    case 'patch_sub':
      return w('patch@1', { target: `sub/${op.id}`, fields: op.fields });
    case 'delete_sub':
      return w('delete@1', { target: `sub/${op.id}` });
    case 'pay':
      return w('record_payment@1', { target: `sub/${op.sub}`, args: { subscription: op.sub, date: op.at, amount: op.amount } });
    case 'delete_pay':
      return w('delete_payment@1', {
        target: `sub/${op.sub}`,
        args: { subscription: op.sub },
        locate: { date: op.date, match: { amount: op.amount }, count: op.expect.count },
      });
    case 'create_method':
      return w('update_payment_method@1', {
        target: `method/${op.id}`,
        args: { action: 'create', id: op.id, set: { name: op.name, kind: 'prepaid', currency: 'USD', balance: op.balance } },
      });
    case 'top_up':
      return w('update_payment_method@1', { target: `method/${op.method}`, args: { method: op.method, top_up: { amount: op.amount, date: op.at } } });
    case 'set_balance':
      return w('update_payment_method@1', { target: `method/${op.method}`, args: { method: op.method, balance: op.balance }, expect: op.expect });
    case 'delete_method':
      return w('delete@1', { target: `method/${op.id}` });
    case 'create_person':
      return w('save_person@1', { target: 'kv/people', args: { action: 'create', id: op.id, set: { name: op.name } } });
    case 'delete_person':
      return w('save_person@1', { target: 'kv/people', args: { action: 'delete', person: op.id } });
    case 'set_setting':
      return w('patch@1', { target: 'kv/settings', fields: op.fields });
    case 'put_object':
      return w('create@1', { target: op.key, doc: JSON.parse(op.data) });
    case 'import_ledger':
      return w('import_ledger@1', { objects: op.objects.map(([k, d]) => [k, JSON.parse(d)]), recoveryId: op.recoveryId });
    case 'replace':
      return w('replace@1', { target: op.key, doc: JSON.parse(op.data), expect: op.expect == null ? null : { hash: await contentHash(JSON.parse(op.expect)) } });
    default:
      throw new Error('unknown op ' + op.kind);
  }
}

/** 在本地库上执行一个操作：与服务器同一段 SyncExec；成功才写回 */
export async function applyOp(db, op) {
  setToday(op.at);
  const env = envOf(db);
  const store = new BatchStore(await env.DB.batch(batchReadStmts(env)));
  const r = await new SyncExec(env, store).run(await toWire(op));
  if (!r.ok) return r.detail === 'engine_error' ? { ok: false, code: 'bug', detail: `${op.kind} engine_error` } : r;
  const stmts = store.commitStmts(env);
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true };
}

/** 撤销一个已确认的操作：只动原字段的逆操作，期望 = 该操作完成时冻结的后像。不支持的返回 null。 */
export function inverseOf(op) {
  if (op.kind === 'patch_sub' || op.kind === 'set_setting')
    return { kind: op.kind, id: op.id, fields: Object.fromEntries(Object.entries(op.fields).map(([f, { from, to }]) => [f, { from: to, to: from }])) };
  if (op.kind === 'set_balance' && op.expect.balance !== null)
    return { kind: 'set_balance', method: op.method, balance: op.expect.balance, expect: { balance: op.balance, balanceAsOf: op.at } };
  return null;
}

/** 读当前账本，供随机生成「用户在界面上能做的操作」与断言。 */
export function view(db) {
  const subs = db
    .prepare('SELECT id, data FROM subscriptions')
    .all()
    .map((r) => JSON.parse(r.data));
  const methods = db
    .prepare('SELECT id, data FROM methods')
    .all()
    .map((r) => JSON.parse(r.data));
  return { subs, methods, people: people(db), settings: settingsOf(db) };
}

export { syncView } from './engine.mjs';

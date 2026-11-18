// 现有写路径的并发守卫（sync-design 5.3）：网页 REST 写、MCP 工具写、助手确认写都是「读 → 计算 → 写」。
// 作用域开始时记下账本序号（kv.rev），作用域里每次 mutate 在同一个 batch 首条核对序号未变；
// 别处（同步、另一个标签页、MCP）抢先写入时整批回滚并抛 WriteConflict，调用方重读重算一次，仍冲突则 409 / 工具错误。
// 作用域外的 mutate 行为不变（定时任务、迁移、备份恢复等）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { t } from '../shared/i18n.ts';
import type { Env } from './env.ts';

interface Guard {
  expected: number;
}

const scope = new AsyncLocalStorage<Guard>();

export class WriteConflict extends Error {
  readonly code = 'write_conflict';
  constructor() {
    super(t('server.writeConflict'));
  }
}

export const isConflictError = (e: unknown) => e instanceof Error && /CHECK constraint failed/i.test(e.message);

/** mutate 用：当前作用域的守卫（没有 = 不守卫） */
export const currentGuard = (): Guard | undefined => scope.getStore();

const readRev = async (env: Env) => (await env.DB.prepare("SELECT CAST(value AS INTEGER) AS rev FROM kv WHERE key = 'rev'").first<{ rev: number }>())?.rev ?? 0;

/** 守卫首条：序号仍是读时的值，否则 CHECK(ok = 1) 失败、整批回滚 */
export const guardStmts = (env: Env, g: Guard): { head: D1PreparedStatement; tail: D1PreparedStatement } => ({
  head: env.DB.prepare("INSERT INTO sync_cas (ok) SELECT (SELECT CAST(value AS INTEGER) FROM kv WHERE key = 'rev') IS ?1").bind(g.expected),
  tail: env.DB.prepare('DELETE FROM sync_cas'),
});

/**
 * 在守卫作用域里执行 run；冲突时从头重读重算一次（attempt 递增），第二次仍冲突把 WriteConflict 抛给调用方。
 * run 必须能整段重跑：读库、计算、写库都在里面。
 */
export async function withWriteGuard<T>(env: Env, run: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const g: Guard = { expected: await readRev(env) };
    try {
      return await scope.run(g, () => run(attempt));
    } catch (e) {
      if (!(e instanceof WriteConflict) || attempt >= 1) throw e;
    }
  }
}

// 启动时自动迁移：每个数据库只检查一次，缺哪条补哪条（与 wrangler 的 d1_migrations 表兼容）。
// 按 env.DB 记录：一个进程里挂多个库（托管时每个账本一个库）时各自迁移，互不以为已完成。
import type { Env } from './env.ts';
import { MIGRATIONS } from './migrations.gen.ts';

const done = new WeakMap<object, Promise<void>>();

export function ensureMigrated(env: Env): Promise<void> {
  let p = done.get(env.DB);
  if (!p) {
    p = run(env).catch((e) => {
      done.delete(env.DB);
      throw e;
    });
    done.set(env.DB, p);
  }
  return p;
}

async function run(env: Env): Promise<void> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  ).run();
  const applied = new Set((await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    // 一条迁移里的语句放在同一个 batch 里，要么全成功要么全回滚
    await env.DB.batch([...m.statements.map((s) => env.DB.prepare(s)), env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(m.name)]);
    console.log('[migrate]', m.name);
  }
}

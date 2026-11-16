import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { Env } from '../worker/env.ts';
import { DEFAULT_SETTINGS, type AppState } from './types.ts';

test('实际匿名公开 API 在隔离数据库中仅公开收支符号设置，旧设置缺省开启且认证边界不变', async (t) => {
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
      return next(url, ctx);
    },
  });
  t.after(() => hook.deregister());
  const { default: worker } = await import('../worker/index.ts');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('External network disabled');
  });
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        const query = db.prepare(sql);
        return query.columns().length ? { results: query.all(...args) } : { results: [], meta: { changes: Number(query.run(...args).changes) } };
      },
    };
    return stmt;
  };
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        return Promise.all(stmts.map((stmt) => stmt.run()));
      },
    },
  } as unknown as Env;
  const get = (path: string) => worker.fetch(new Request(`http://local.test${path}`), env);
  assert.equal((await get('/api/public')).status, 404);
  const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  for (const signedAmounts of [undefined, false, true]) {
    put('settings', {
      ...DEFAULT_SETTINGS,
      publicView: true,
      signedAmounts,
      notifyEmail: 'private@example.test',
      icsToken: 'secret',
      channels: [{ config: { token: 'secret' } }],
    });
    const response = await get('/api/public');
    assert.equal(response.status, 200);
    const state = (await response.json()) as AppState;
    assert.equal(state.settings.signedAmounts, signedAmounts !== false);
    assert.equal(state.settings.notifyEmail, '');
    assert.equal(state.settings.icsToken, undefined);
    assert.equal(state.settings.channels, undefined);
    assert.equal(state.rev, undefined);
    assert.equal((await get('/api/state')).status, 401);
  }
  // Worker 没有 RUNTIME 标记即 Cloudflare：设置页只给文档；未登录读不到
  assert.equal((await get('/api/runtime')).status, 401);
  const dev = await worker.fetch(new Request('http://local.test/api/runtime'), { ...env, DEV_BYPASS_AUTH: '1' } as Env);
  assert.deepEqual(await dev.json(), { runtime: 'cloudflare' });
  put('settings', { ...DEFAULT_SETTINGS, publicView: false, signedAmounts: false });
  assert.equal((await get('/api/public')).status, 404);
});

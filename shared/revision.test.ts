import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import type { Env } from '../worker/env.ts';
import { getRev, loadState, putKv, remove, replaceAll, saveSettingsWithSubs, upsert, writePeople } from '../worker/store.ts';
import { exportAll, restoreAll } from '../worker/backup.ts';
import { backfill, putFxDayStmt, recordToday } from '../worker/fx.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import { apply, clearChats, saveChat, saveConfig } from '../worker/ai/assistant.ts';
import { createToken } from '../worker/ai/mcp.ts';
import { DEFAULT_SETTINGS, type Subscription } from './types.ts';
import { FALLBACK_FX, todayIn } from './billing.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
hook.deregister();

const sub = (id = 'sub'): Subscription => ({
  id,
  name: 'Fictional service',
  price: 10,
  currency: 'USD',
  category: 'tools',
  tags: [],
  cycle: { unit: 'month', every: 1 },
  start: todayIn('UTC'),
  status: 'active',
});
const settings = { ...DEFAULT_SETTINGS, timezone: 'UTC', publicView: true };

/** Real SQLite with transactional D1 batches, including SELECT results and rollback. */
function fixture(legacy = false) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  // legacy：停在 rev 迁移之前，之后的迁移由 Worker 启动时自动补上
  for (const m of legacy
    ? MIGRATIONS.slice(
        0,
        MIGRATIONS.findIndex((m) => m.name === '0007_state_rev.sql'),
      )
    : MIGRATIONS) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const queries: string[] = [];
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        queries.push(sql);
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        queries.push(sql);
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        queries.push(sql);
        const query = db.prepare(sql);
        if (query.columns().length) return { results: query.all(...args) };
        return { results: [], meta: { changes: Number(query.run(...args).changes) } };
      },
    };
    return stmt;
  };
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const stmt of stmts) results.push(await stmt.run());
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    DEV_BYPASS_AUTH: '1',
    BASE_PATH: '/ledger',
  } as unknown as Env;
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    worker.fetch(
      new Request(`https://example.test/ledger/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      auth ? env : { ...env, DEV_BYPASS_AUTH: undefined },
    );
  return { db, env, queries, request };
}

test('automatic migration preserves existing ledger; prefixed /api/rev reads one row, no-store, authenticated', async () => {
  const f = fixture(true);
  try {
    f.db.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)').run('sub', JSON.stringify(sub()));
    f.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('settings', JSON.stringify(settings));
    const response = await f.request('rev');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { rev: 0 });
    assert.equal((await loadState(f.env)).subscriptions[0].name, 'Fictional service');
    f.queries.length = 0;
    assert.deepEqual(await (await f.request('rev')).json(), { rev: 0 });
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0], /WHERE key = 'rev'/);
    assert.equal((await f.request('rev', 'GET', undefined, false)).status, 401);
    assert.equal((await f.request('state', 'GET', undefined, false)).status, 401);
    const state = await (await f.request('state')).json();
    assert.equal(state.rev, 0);
    assert.equal('rev' in (await (await f.request('public')).json()), false);
    assert.equal(await getRev(f.env), 0);
  } finally {
    f.db.close();
  }
});

test('store writes increment rev atomically, bulk people/settings writes and deletion/merge/replace are covered', async () => {
  const f = fixture();
  try {
    const changed = async (fn: () => Promise<unknown>) => {
      const before = await getRev(f.env);
      const result = await fn();
      assert.ok((await getRev(f.env)) > before);
      return result;
    };
    const first = await changed(() => upsert(f.env, 'subscriptions', 'sub', sub()));
    assert.deepEqual(first, { from: 0, rev: 1 });
    await changed(() => upsert(f.env, 'subscriptions', 'sub', { ...sub(), price: 20 }));
    await changed(() => upsert(f.env, 'methods', 'm', { id: 'm', name: 'Fictional card', kind: 'bank', currency: 'USD' }));
    for (const [key, value] of Object.entries({ settings, people: [], prefs: { 'list-view': 'table' }, fx: FALLBACK_FX })) {
      await changed(() => putKv(f.env, key, value));
    }
    await changed(() =>
      writePeople(
        f.env,
        [{ id: 'p', name: 'Fictional person' }],
        Array.from({ length: 55 }, (_, i) => sub(`s${i}`)),
      ),
    );
    await changed(() => saveSettingsWithSubs(f.env, settings, [{ ...sub(), category: 'software' }]));
    await changed(() => remove(f.env, 'subscriptions', 'sub'));
    await changed(() => remove(f.env, 'methods', 'm'));
    await changed(() => replaceAll(f.env, [sub()], [], 'merge'));
    await changed(() => replaceAll(f.env, [], [], 'replace'));
    const before = await getRev(f.env);
    await remove(f.env, 'subscriptions', 'missing');
    await writePeople(f.env, undefined, []);
    await loadState(f.env);
    assert.equal(await getRev(f.env), before);
    await assert.rejects(() =>
      f.env.DB.batch([
        f.env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('broken', '{}')"),
        f.env.DB.prepare('INSERT INTO missing_table VALUES (1)'),
      ]),
    );
    assert.equal(await getRev(f.env), before);
    assert.equal(f.db.prepare("SELECT id FROM subscriptions WHERE id = 'broken'").get(), undefined);
  } finally {
    f.db.close();
  }
});

test('backup restore, import, current FX, historical FX and cron writes advance rev; conflict no-op does not', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: 'success', rates: { USD: 1, CNY: 7, EUR: 0.9, GBP: 0.8 } }));
  try {
    await putKv(f.env, 'settings', settings);
    await upsert(f.env, 'subscriptions', 'sub', sub());
    const backup = await exportAll(f.env);
    backup.fxDaily = [{ date: '2026-01-01', rates: { USD: 1, CNY: 7 }, source: 'fixture' }];
    let before = await getRev(f.env);
    await restoreAll(f.env, backup);
    assert.ok((await getRev(f.env)) > before);
    before = await getRev(f.env);
    const imported = await f.request('import', 'POST', {
      subscriptions: [{ ...sub(), name: 'Imported fixture' }],
      settings: { displayName: 'Fictional owner' },
    });
    assert.equal(imported.status, 200);
    const importedState = await imported.json();
    assert.ok(importedState.rev > before);
    assert.equal(importedState.subscriptions[0].name, 'Imported fixture');
    before = await getRev(f.env);
    const response = await f.request('fx/refresh', 'POST');
    assert.equal(response.status, 200);
    assert.ok((await getRev(f.env)) > before);
    assert.equal(Number(response.headers.get('x-calends-rev')), await getRev(f.env));
    before = await getRev(f.env);
    await recordToday(f.env, FALLBACK_FX, 'UTC');
    assert.equal(await getRev(f.env), before); // today's record already exists
    await f.env.DB.batch([putFxDayStmt(f.env, '2026-01-01', { USD: 1, CNY: 8 }, 'updated')]);
    assert.equal(await getRev(f.env), before + 1);
    f.db.exec('DELETE FROM fx_daily');
    before = await getRev(f.env);
    await recordToday(f.env, FALLBACK_FX, 'UTC');
    assert.equal(await getRev(f.env), before + 1);
    f.db.exec('DELETE FROM fx_daily');
    before = await getRev(f.env);
    // fetchDay's ECB fallback is deterministic; no external FX service is contacted.
    t.mock.method(globalThis, 'fetch', async () => Response.json({ base: 'EUR', rates: { USD: 1.1, CNY: 7.5, GBP: 0.8, JPY: 160 } }));
    const result = await backfill(f.env, await loadState(f.env));
    assert.ok(result.filled > 0);
    assert.equal(await getRev(f.env), before + result.filled);
  } finally {
    f.db.close();
  }
});

test('API mutations expose exact revision ranges; MCP dry_run is read-only and assistant apply writes', async () => {
  const f = fixture();
  try {
    await putKv(f.env, 'settings', settings);
    const response = await f.request('subscriptions/sub', 'PUT', sub());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-calends-rev-from'), '1');
    assert.equal(response.headers.get('x-calends-rev'), '2');
    let before = await getRev(f.env);
    const tool = TOOLS.find((x) => x.name === 'update_subscription')!;
    const toolArgs = { subscription: 'sub', set: { name: 'Remote fixture' } };
    await tool.run({ ...toolArgs, dry_run: true }, { env: f.env });
    assert.equal(await getRev(f.env), before);
    await tool.run(toolArgs, { env: f.env });
    assert.equal(await getRev(f.env), before + 1);
    before = await getRev(f.env);
    await apply(f.env, { tool: 'update_subscription', args: { subscription: 'sub', set: { name: 'Assistant fixture' } } });
    assert.equal(await getRev(f.env), before + 1);
    assert.equal((await loadState(f.env)).subscriptions[0].name, 'Assistant fixture');
    const prefsResponse = await f.request('prefs', 'PATCH', { 'list-view': 'table' });
    assert.equal(prefsResponse.status, 200);
    assert.equal(Number(prefsResponse.headers.get('x-calends-rev')), await getRev(f.env));
    assert.equal((await loadState(f.env)).prefs?.['list-view'], 'table');
  } finally {
    f.db.close();
  }
});

test('read APIs, authentication/config/token bookkeeping, notifications and chat history do not invalidate ledger', async () => {
  const f = fixture();
  try {
    await putKv(f.env, 'settings', settings);
    const before = await getRev(f.env);
    await putKv(f.env, 'auth', { salt: 'fixture', hash: 'fictional' });
    await createToken(f.env, 'Fixture token', 'read');
    await saveConfig(f.env, { baseUrl: 'https://example.test', apiKey: 'fictional' });
    await saveChat(f.env, 'fixture', { createdAt: new Date().toISOString(), turns: [], history: [] });
    await clearChats(f.env);
    f.db.exec("INSERT INTO sessions (token_hash, expires_at) VALUES ('fixture', 1)");
    f.db.exec("INSERT INTO login_attempts (ip, fails, window_start) VALUES ('fixture', 1, 0)");
    f.db.exec("INSERT INTO notify_log (dedupe_key, kind, subject, status) VALUES ('fixture', 'test', 'Fixture', 'sent')");
    await f.request('state');
    await f.request('rev');
    await f.request('public');
    await exportAll(f.env);
    assert.equal(await getRev(f.env), before);
  } finally {
    f.db.close();
  }
});

test('kv revision allow-list prevents recursion with recursive_triggers both OFF and ON', async () => {
  const f = fixture();
  try {
    assert.equal(f.db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0);
    for (const recursive of [0, 1]) {
      f.db.exec(`PRAGMA recursive_triggers = ${recursive}`);
      for (const key of ['settings', 'people', 'prefs', 'fx']) {
        let before = await getRev(f.env);
        f.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, '{}');
        assert.equal(await getRev(f.env), before + 1);
        before++;
        f.db.prepare('UPDATE kv SET value = ? WHERE key = ?').run('[]', key);
        assert.equal(await getRev(f.env), before + 1);
        before++;
        f.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
        assert.equal(await getRev(f.env), before + 1);
      }
      const before = await getRev(f.env);
      f.db.exec("UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'");
      assert.equal(await getRev(f.env), before + 1); // no second bump from the kv UPDATE trigger
    }
  } finally {
    f.db.close();
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { splitSql } from '../scripts/migrations.mjs';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import type { Env } from '../worker/env.ts';

// BEGIN/END must stay together, regardless of newlines, comments or quoted semicolons.
test('migration splitter preserves multiline triggers, CASE expressions and quoted/comment semicolons', () => {
  const sql = `
    CREATE TABLE items (id TEXT, value TEXT);
    CREATE TABLE log (value TEXT);
    /* ; END; */ CREATE TRIGGER changed AFTER INSERT ON items
    BEGIN
      -- END; inside a comment is not a trigger terminator.
      INSERT INTO log VALUES (CASE WHEN NEW.value = 'a;''b' THEN 'END;' ELSE NEW.value END);
      INSERT INTO log VALUES ('second;statement');
    END;
    INSERT INTO items VALUES ('one', 'a;''b'); SELECT * FROM log;
  `;
  const statements = splitSql(sql);
  assert.equal(statements.length, 5);
  const db = new DatabaseSync(':memory:');
  try {
    for (const statement of statements.slice(0, -1)) db.prepare(statement).run();
    assert.deepEqual(
      db
        .prepare(statements.at(-1)!)
        .all()
        .map((r) => r.value),
      ['END;', 'second;statement'],
    );
    for (const m of MIGRATIONS) {
      assert.deepEqual(m.statements, splitSql(readFileSync(new URL(`../worker/migrations/${m.name}`, import.meta.url), 'utf8')));
    }
  } finally {
    db.close();
  }
});

test('ensureMigrated applies fresh/upgrade databases and shares Wrangler migration tracking', async () => {
  for (const mode of ['fresh', 'upgrade', 'wrangler']) {
    const db = new DatabaseSync(':memory:');
    const applied = mode === 'fresh' ? [] : mode === 'upgrade' ? MIGRATIONS.slice(0, -1) : MIGRATIONS;
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
    for (const m of applied) {
      // Simulate the raw SQL input consumed by wrangler migrations apply.
      db.exec(readFileSync(new URL(`../worker/migrations/${m.name}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
    }
    if (mode !== 'fresh') db.exec("INSERT INTO subscriptions (id, data) VALUES ('fixture', '{}')");
    let batches = 0;
    const prepare = (sql: string) => {
      let args: string[] = [];
      const query = {
        bind(...values: string[]) {
          args = values;
          return query;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          return db.prepare(sql).run(...args);
        },
      };
      return query;
    };
    const env = {
      DB: {
        prepare,
        async batch(statements: Array<ReturnType<typeof prepare>>) {
          batches++;
          db.exec('BEGIN');
          try {
            for (const statement of statements) await statement.run();
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      },
    } as unknown as Env;
    try {
      // Each module represents a new Worker isolate, whose migration check is memoized.
      const { ensureMigrated } = await import(`../worker/migrate.ts?migration-test=${mode}`);
      await ensureMigrated(env);
      assert.equal(batches, MIGRATIONS.length - applied.length, mode);
      assert.equal(db.prepare('SELECT count(*) AS n FROM d1_migrations').get()!.n, MIGRATIONS.length);
      // Only the 0007 revision triggers: app sync starts dormant (worker/sync-mode.ts) and installs its triggers when enabled.
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()!.n, 12);
      assert.equal(db.prepare("SELECT value FROM sync_meta WHERE key = 'mode'").get()!.value, 'off');
      const rev = () => Number(db.prepare("SELECT value FROM kv WHERE key = 'rev'").get()!.value);
      const head = () => Number(db.prepare('SELECT seq FROM sync_head').get()!.seq);
      const before = rev();
      db.exec("INSERT INTO methods (id, data) VALUES ('fictional', '{}')");
      assert.equal(rev(), before + 1);
      // Dormant sync: ledger writes leave the sync tables untouched.
      assert.equal(head(), 0, mode);
      assert.equal(db.prepare('SELECT count(*) AS n FROM sync_objects').get()!.n, 0);
      if (mode !== 'fresh') assert.equal(db.prepare('SELECT id FROM subscriptions').get()!.id, 'fixture');
      await ensureMigrated(env);
      assert.equal(batches, MIGRATIONS.length - applied.length, mode);
    } finally {
      db.close();
    }
  }
});

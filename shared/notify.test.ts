import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { buildDaily, runScheduled, sendDigest, type Digest } from '../worker/notify.ts';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import type { Env } from '../worker/env.ts';
import { DEFAULT_SETTINGS, type AppState } from './types.ts';
import { FALLBACK_FX } from './billing.ts';
import { flatten, setLocale } from './i18n.ts';

const messages = {};
for (const ns of ['core', 'common', 'notify']) flatten(ns, JSON.parse(readFileSync(new URL(`./locales/en/${ns}.json`, import.meta.url), 'utf8')), messages);
setLocale('en', [messages]);
const channel = (id = 'email') => ({ id, name: id, kind: 'email' as const, enabled: true, config: { to: `${id}@example.test` } });
const state = (): AppState => ({
  subscriptions: [],
  methods: [],
  settings: { ...DEFAULT_SETTINGS, channels: [channel()], monthlyDigest: false },
  fx: FALLBACK_FX,
});
const digest: Digest = { key: 'daily:2026-01-01', date: '2026-01-01', kind: 'daily', subject: 'Original reminder', intro: 'Saved snapshot', sections: [] };

/** 真 SQLite 执行迁移、去重和重试 SQL；邮件绑定只收集调用，不进行网络访问。 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) for (const sql of m.statements) db.exec(sql);
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  let fxReads = 0;
  const countFxRead = (sql: string, args: Array<string | number | null>) => {
    if ((sql.includes('SELECT value FROM kv') && args[0] === 'fx') || sql.includes("SELECT key, value FROM kv WHERE key IN ('settings', 'fx'")) fxReads++;
  };
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        countFxRead(sql, args);
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        countFxRead(sql, args);
        const query = db.prepare(sql);
        if (query.columns().length) return { results: query.all(...args) };
        return { results: [], meta: { changes: Number(query.run(...args).changes) } };
      },
    };
    return stmt;
  };
  const sent: Array<{ to: string; subject: string }> = [];
  let fails = true;
  let failTo = '';
  let hang = false;
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    MAIL_FROM: 'calends@example.test',
    SITE_URL: 'https://example.test',
    EMAIL: {
      async send(msg: { to: string; subject: string }) {
        sent.push(msg);
        // 模拟发送途中 Worker 被中止：这次调用永远不会返回
        if (hang) return new Promise(() => {});
        if (fails || msg.to === failTo) throw new Error('fixture failure');
      },
    },
  } as unknown as Env;
  return {
    db,
    env,
    sent,
    get fxReads() {
      return fxReads;
    },
    success() {
      fails = false;
      hang = false;
    },
    hang() {
      hang = true;
    },
    failOnly(to: string) {
      fails = false;
      failTo = to;
    },
  };
}

test('11. 全渠道失败后在后续整点补发最多三次，跨日使用原快照，重复任务不多发', async () => {
  const f = fixture();
  try {
    const st = state();
    const now = Date.parse('2026-01-01T23:45Z');
    await Promise.all([sendDigest(f.env, st, digest, { now }), sendDigest(f.env, st, digest, { now })]);
    assert.equal(f.sent.length, 1);
    await runScheduled(f.env, st, now + 1);
    assert.equal(f.sent.length, 1);
    for (let i = 0; i < 3; i++) {
      const tick = Date.parse('2026-01-02T00:00Z') + i * 3_600_000;
      await Promise.all([runScheduled(f.env, st, tick), runScheduled(f.env, st, tick)]);
      assert.equal(f.sent.length, i + 2);
      await runScheduled(f.env, st, tick + 900_000);
      assert.equal(f.sent.length, i + 2);
    }
    f.success();
    await runScheduled(f.env, st, Date.parse('2026-01-02T05:00Z'));
    assert.equal(f.sent.length, 4);
    const row = f.db.prepare('SELECT * FROM notify_log').get()!;
    assert.equal(row.attempts, 4);
    assert.equal(row.status, 'failed');
    assert.equal(JSON.parse(String(row.digest)).date, '2026-01-01');
    assert.ok(f.sent.every((s) => s.subject === digest.subject));
  } finally {
    f.db.close();
  }
});

test('11. 重试成功即停止，任一渠道成功也不重发给成功渠道', async () => {
  const f = fixture();
  try {
    const st = state();
    const now = Date.parse('2026-01-01T23:45Z');
    await sendDigest(f.env, st, digest, { now });
    f.success();
    await runScheduled(f.env, st, Date.parse('2026-01-02T00:00Z'));
    await runScheduled(f.env, st, Date.parse('2026-01-02T01:00Z'));
    assert.equal(f.sent.length, 2);
    assert.equal(f.db.prepare('SELECT status FROM notify_log').get()!.status, 'sent');
    st.settings.channels!.push(channel('broken'));
    f.failOnly('broken@example.test');
    await sendDigest(f.env, st, { ...digest, key: 'partial' }, { now });
    await runScheduled(f.env, st, Date.parse('2026-01-02T02:00Z'));
    assert.equal(f.sent.length, 4);
    assert.equal(f.db.prepare("SELECT status FROM notify_log WHERE dedupe_key='partial'").get()!.status, 'partial 1/2');
  } finally {
    f.db.close();
  }
});

test('发送途中崩溃留下的 sending 在租约过后会被重新发送，租约内不重复发送', async () => {
  const f = fixture();
  try {
    const st = state();
    const now = Date.parse('2026-01-01T09:00Z');
    f.hang();
    void sendDigest(f.env, st, digest, { now });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.db.prepare('SELECT status FROM notify_log').get()!.status, 'sending');
    f.success();
    await runScheduled(f.env, st, now + 5 * 60_000);
    assert.equal(f.sent.length, 1);
    await runScheduled(f.env, st, now + 11 * 60_000);
    assert.equal(f.sent.length, 2);
    const row = f.db.prepare('SELECT status, attempts FROM notify_log').get()!;
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
  } finally {
    f.db.close();
  }
});

test('12. 半小时/45 分钟/负偏移时区在本地 09:00 首轮发送，一天只发送一次', async () => {
  for (const [tz, first] of [
    ['Asia/Kolkata', '2026-01-02T03:30Z'],
    ['Asia/Kathmandu', '2026-01-02T03:15Z'],
    ['Australia/Adelaide', '2026-01-01T22:30Z'],
    ['America/St_Johns', '2026-01-02T12:30Z'],
  ]) {
    const f = fixture();
    try {
      f.success();
      const st = state();
      st.settings.timezone = tz;
      st.subscriptions = [
        {
          id: 's',
          name: 'Renewal',
          price: 10,
          currency: 'USD',
          cycle: { unit: 'day', every: 1 },
          start: '2026-01-01',
          status: 'active',
          category: 'Tools',
          tags: [],
          remindDays: 0,
        },
      ];
      const at = Date.parse(first);
      await runScheduled(f.env, st, at - 900_000);
      assert.equal(f.sent.length, 0, tz);
      await runScheduled(f.env, st, at);
      assert.equal(f.sent.length, 1, tz);
      for (let i = 1; i < 4; i++) await runScheduled(f.env, st, at + i * 900_000);
      assert.equal(f.sent.length, 1, tz);
      await runScheduled(f.env, st, at + 86_400_000);
      assert.equal(f.sent.length, 2, tz);
    } finally {
      f.db.close();
    }
  }
});

test('12. Cloudflare 与 Docker 都为每刻钟；维护任务每小时只执行一次', async () => {
  const config = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.ok(config('../wrangler.jsonc').includes('"*/15 * * * *"'));
  assert.ok(config('../docker/entrypoint.mjs').includes("const CRON = '*/15 * * * *'"));
  registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
      return next(url, ctx);
    },
  });
  const { default: worker } = await import('../worker/index.ts');
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run('fx', JSON.stringify({ ...FALLBACK_FX, fetchedAt: new Date().toISOString() }));
    const tasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        tasks.push(p);
      },
    } as ExecutionContext;
    const at = Date.parse('2026-01-02T04:00Z');
    for (let i = 0; i < 4; i++) await worker.scheduled({ scheduledTime: at + i * 900_000 } as ScheduledController, f.env, ctx);
    await Promise.all(tasks);
    // 每轮 loadState 读一次汇率，只有整点维护额外读一次。
    assert.equal(f.fxReads, 5);
    assert.equal(tasks.length, 0);
  } finally {
    f.db.close();
  }
});

test('13. 合租收款提醒仅包含已加入且未退出的成员', () => {
  const st = state();
  st.subscriptions = [
    {
      id: 's',
      name: 'Plan',
      category: 'Tools',
      tags: [],
      price: 30,
      currency: 'USD',
      cycle: { unit: 'month', every: 1 },
      start: '2026-01-01',
      status: 'active',
      remindDays: 0,
      share: {
        role: 'owner',
        seats: 5,
        since: '2026-01-02',
        members: [
          { id: 'live', name: 'Live', share: 10, joined: '2026-01-02', left: '2026-01-03' },
          { id: 'future', name: 'Future', share: 10, joined: '2026-01-03' },
          { id: 'left', name: 'Left', share: 10, left: '2026-01-02' },
          { id: 'free', name: 'Free', share: 10, exempt: true },
        ],
      },
    },
  ];
  const text = JSON.stringify(buildDaily(st, '2026-01-02'));
  assert.ok(text.includes('Live'));
  for (const name of ['Future', 'Left', 'Free']) assert.ok(!text.includes(name), text);
});

test('合租提醒与首期应收一致，免费首期跳至统一收款日', () => {
  const st = state();
  st.settings.collectCurrency = 'CNY';
  st.subscriptions = [
    {
      id: 'collection',
      name: 'Fictional sharing',
      category: 'Tools',
      tags: [],
      price: 200,
      currency: 'CNY',
      cycle: { unit: 'month', every: 1 },
      start: '2026-01-17',
      status: 'active',
      share: {
        role: 'owner',
        seats: 3,
        since: '2026-01-17',
        members: [{ id: 'jj', name: 'Test JJ', share: 10, fee: 40.67, feeCurrency: 'CNY', billEvery: 6, joined: '2026-10-20' }],
      },
    },
  ];
  const m = st.subscriptions[0].share!.members[0];
  const first = JSON.stringify(buildDaily(st, '2026-10-20'));
  assert.ok(first.includes('19.67'), first);
  m.firstPeriod = 'free';
  assert.ok(!JSON.stringify(buildDaily(st, '2026-10-20') ?? null).includes('Test JJ'));
  assert.ok(JSON.stringify(buildDaily(st, '2027-01-17')).includes('40.67'));
  m.firstPeriod = 'prorate';
  m.receipts = [{ id: 'r1', date: '2026-10-20', amount: 19.67, currency: 'CNY', periods: ['2026-10-20'] }];
  assert.ok(JSON.stringify(buildDaily(st, '2027-01-14')).includes('Test JJ'));
  assert.ok(!JSON.stringify(buildDaily(st, '2027-01-20') ?? null).includes('Test JJ'));
});

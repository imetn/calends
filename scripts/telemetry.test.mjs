// 匿名使用统计：计数口径、开关与环境变量、按天累计（并发不丢）、发送成功 / 拒收 / 失败后的本地计数。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import { cleanCounts, telemetryForcedOff, telemetryPage, TELEMETRY_ENDPOINT } from '../shared/telemetry.ts';
import { countServer, countUsage, pendingDays, reportTelemetry, saveTelemetry, viewTelemetry } from '../worker/telemetry.ts';
import { exportAll } from '../worker/backup.ts';
import { ensureMigrated } from '../worker/migrate.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T08:00:00Z');
let dir;
let env;
const counts = async () => JSON.parse((await env.DB.prepare("SELECT value FROM kv WHERE key = 'telemetryCounts'").first())?.value ?? '{}');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calends-telemetry-'));
  env = { DB: openD1(join(dir, 'test.sqlite')) };
  await ensureMigrated(env);
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  for (const k of ['CALENDS_TELEMETRY', 'DO_NOT_TRACK', 'DEV_BYPASS_AUTH']) delete env[k];
  await env.DB.prepare("DELETE FROM kv WHERE key IN ('telemetry', 'telemetryCounts')").run();
});

test('页面归类、浏览器计数白名单、环境变量关闭', () => {
  assert.equal(telemetryPage('cat/AI'), 'list');
  assert.equal(telemetryPage('family/people'), 'family');
  assert.equal(telemetryPage('settings/public'), 'settings');
  assert.equal(telemetryPage('login'), undefined);
  assert.equal(telemetryPage(''), undefined);
  assert.deepEqual(
    cleanCounts({ opens: 2, 'page.list': 1e9, 'page.nope': 1, 'mcp.calls': 5, 'assistant.messages': 1, x: 'y', 'page.report': -1, 'page.wallet': 1.5 }),
    {
      opens: 2,
      'page.list': 1000,
    },
  );
  assert.deepEqual(cleanCounts(null), {});
  assert.equal(telemetryForcedOff({}), false);
  assert.equal(telemetryForcedOff({ CALENDS_TELEMETRY: '0' }), true);
  assert.equal(telemetryForcedOff({ CALENDS_TELEMETRY: 'off' }), true);
  assert.equal(telemetryForcedOff({ CALENDS_TELEMETRY: '1' }), false);
  assert.equal(telemetryForcedOff({ DO_NOT_TRACK: '1' }), true);
  assert.equal(telemetryForcedOff({ DO_NOT_TRACK: '0' }), false);
});

test('默认开启；按 UTC 日累计，并发不丢；服务端计数只认白名单', async () => {
  assert.deepEqual(await viewTelemetry(env), { enabled: true, forcedOff: false });
  await Promise.all(Array.from({ length: 20 }, () => countUsage(env, { opens: 1, 'page.list': 2 }, NOW)));
  await countUsage(env, { opens: 1 }, NOW + DAY);
  const c = await counts();
  assert.equal(c['2026-11-18|opens'], 20);
  assert.equal(c['2026-11-18|page.list'], 40);
  assert.equal(c['2026-11-19|opens'], 1);
  const before = await counts();
  await countServer(env, 'opens');
  assert.deepEqual(await counts(), before, '浏览器计数不能从服务端加');
  await countServer(env, 'mcp.calls');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await counts())[`${today}|mcp.calls`], 1);
});

test('关闭后清掉未发计数、不再累计；环境变量强制关闭时设置打不开', async () => {
  await countUsage(env, { opens: 3 }, NOW);
  assert.deepEqual(await saveTelemetry(env, false), { enabled: false, forcedOff: false });
  assert.deepEqual(await counts(), {});
  await countUsage(env, { opens: 3 }, NOW);
  assert.deepEqual(await counts(), {});
  await saveTelemetry(env, true);
  env.CALENDS_TELEMETRY = '0';
  assert.deepEqual(await saveTelemetry(env, true), { enabled: false, forcedOff: true });
  await countUsage(env, { opens: 3 }, NOW);
  assert.deepEqual(await counts(), {});
});

test('统计状态不进完整备份', async () => {
  await countUsage(env, { opens: 1 }, NOW);
  const dump = JSON.stringify(await exportAll(env));
  assert.ok(!dump.includes('telemetry'));
  assert.ok(!dump.includes('2026-11-18|opens'));
});

test('只发今天之前、最近两天的计数；更早的丢掉', () => {
  const { days, stale } = pendingDays(
    {
      '2026-11-18|opens': 1,
      '2026-11-17|opens': 2,
      '2026-11-17|page.list': 1,
      '2026-11-16|opens': 4,
      '2026-11-15|opens': 9,
      bad: 1,
      '2026-11-17|mcp.calls': 0,
    },
    NOW,
  );
  assert.deepEqual(Object.fromEntries(days), { '2026-11-17': { opens: 2, 'page.list': 1 }, '2026-11-16': { opens: 4 } });
  assert.deepEqual(stale.sort(), ['2026-11-15|opens', '2026-11-17|mcp.calls']);
});

function fakeFetch(status) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status === 'throw') throw new Error('network');
    return new Response('{}', { status });
  };
  return { fn, calls };
}

test('发送：每天一条、id 稳定；收下后删本地计数，今天的保留', async () => {
  env.RUNTIME = 'node';
  await countUsage(env, { opens: 2, 'page.report': 1 }, NOW - DAY);
  await countUsage(env, { opens: 1 }, NOW - 5 * DAY);
  await countUsage(env, { opens: 7 }, NOW);
  const f = fakeFetch(202);
  await reportTelemetry(env, NOW, f.fn);
  assert.equal(f.calls.length, 1);
  const { url, body } = f.calls[0];
  assert.equal(url, TELEMETRY_ENDPOINT);
  assert.equal(body.app, 'calends');
  assert.match(body.installId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(body.context.runtime, 'node');
  assert.match(body.context.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(body.events, [
    { name: 'active', id: `${body.installId}-20261117`, ts: Date.parse('2026-11-17T12:00:00Z'), props: { opens: 2, 'page.report': 1 } },
  ]);
  assert.deepEqual(await counts(), { '2026-11-18|opens': 7 });
  // 没有过完的日子就不发
  const g = fakeFetch(202);
  await reportTelemetry(env, NOW, g.fn);
  assert.equal(g.calls.length, 0);
  // 安装 id 保持不变
  await countUsage(env, { opens: 1 }, NOW);
  const h = fakeFetch(202);
  await reportTelemetry(env, NOW + DAY, h.fn);
  assert.equal(h.calls[0].body.installId, body.installId);
  delete env.RUNTIME;
});

test('发送失败（限速、不可用、网络）留着下次再发；明确拒收的删掉', async () => {
  for (const status of [429, 503, 'throw']) {
    await env.DB.prepare("DELETE FROM kv WHERE key = 'telemetryCounts'").run();
    await countUsage(env, { opens: 1 }, NOW - DAY);
    await reportTelemetry(env, NOW, fakeFetch(status).fn);
    assert.deepEqual(await counts(), { '2026-11-17|opens': 1 }, String(status));
  }
  await reportTelemetry(env, NOW, fakeFetch(400).fn);
  assert.deepEqual(await counts(), {});
});

test('关闭、强制关闭、本地开发都不发送', async () => {
  await countUsage(env, { opens: 1 }, NOW - DAY);
  env.DEV_BYPASS_AUTH = '1';
  const a = fakeFetch(202);
  await reportTelemetry(env, NOW, a.fn);
  assert.equal(a.calls.length, 0);
  delete env.DEV_BYPASS_AUTH;
  env.DO_NOT_TRACK = '1';
  const b = fakeFetch(202);
  await reportTelemetry(env, NOW, b.fn);
  assert.equal(b.calls.length, 0);
  assert.deepEqual(await counts(), {});
  delete env.DO_NOT_TRACK;
  await countUsage(env, { opens: 1 }, NOW - DAY);
  await saveTelemetry(env, false);
  const c = fakeFetch(202);
  await reportTelemetry(env, NOW, c.fn);
  assert.equal(c.calls.length, 0);
});

test('关闭再打开换新安装 id；关闭期间残留的计数不会发出', async () => {
  await countUsage(env, { opens: 1 }, NOW - DAY);
  const a = fakeFetch(202);
  await reportTelemetry(env, NOW, a.fn);
  const first = a.calls[0].body.installId;
  await saveTelemetry(env, false);
  // 关闭瞬间并发写进来的计数（绕过开关直接写库）
  await env.DB.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('telemetryCounts', ?1, datetime('now'))")
    .bind(JSON.stringify({ '2026-11-18|opens': 3 }))
    .run();
  await reportTelemetry(env, NOW + DAY, fakeFetch(202).fn);
  assert.deepEqual(await counts(), {});
  await saveTelemetry(env, true);
  await countUsage(env, { opens: 1 }, NOW);
  const b = fakeFetch(202);
  await reportTelemetry(env, NOW + DAY, b.fn);
  assert.notEqual(b.calls[0].body.installId, first);
});

test('生成安装 id 时不会把刚关掉的开关改回开启', async () => {
  await countUsage(env, { opens: 1 }, NOW - DAY);
  let turnedOff = false;
  // 读状态之后、写 id 之前用户关掉：在补 id 的语句执行前把开关写成关闭
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (!turnedOff && sql.includes("json_set(value, '$.installId'")) {
      turnedOff = true;
      origPrepare("INSERT INTO kv (key, value, updated_at) VALUES ('telemetry', '{\"enabled\":false}', datetime('now'))").run();
    }
    return origPrepare(sql);
  };
  try {
    const f = fakeFetch(202);
    await reportTelemetry(env, NOW, f.fn);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await viewTelemetry(env), { enabled: false, forcedOff: false });
  } finally {
    env.DB.prepare = origPrepare;
  }
});

test('本地开发不累计', async () => {
  env.DEV_BYPASS_AUTH = '1';
  await countUsage(env, { opens: 1 }, NOW);
  assert.deepEqual(await counts(), {});
});

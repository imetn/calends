// Isolated real-Worker MCP check. Run: node --experimental-strip-types scripts/mcp-release-check.mjs
// Optional live model checks: DEEPSEEK_API_KEY in the environment and --deepseek.
// Never accepts a remote URL or an existing database. Tokens stay in memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMonths, memberCollection, memberDues, memberRate, memberUnpaidFrom, todayIn, diffDays } from '../shared/billing.ts';
import { DEEPSEEK_MODEL, DEEPSEEK_BASE_URL } from '../shared/deepseek.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const today = todayIn('Asia/Shanghai');
const nextMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
const future = nextMonth.toISOString().slice(0, 10);
const past = `${Number(today.slice(0, 4)) - 1}-01-01`;

function fixtures() {
  const member = (id, extra = {}) => ({ id, name: id, share: 10, fee: 10, feeCurrency: 'CNY', billEvery: 1, joined: past, ...extra });
  const car = (id, name, every, members, rule) => ({
    id,
    name,
    category: 'Test',
    tags: [],
    price: 60,
    currency: 'CNY',
    start: past,
    cycle: { unit: 'month', every },
    status: 'active',
    share: { role: 'owner', seats: 16, since: past, collectFrom: past, members, ...(rule ? { rule } : {}) },
  });
  return [
    car('spotify', 'Spotify', 1, [
      member('Alice'),
      member('Bob', { fee: 19, custom: true }),
      member('Custom', { fee: 17 }),
      member('Exempt', { exempt: true, share: 0 }),
      member('Departed', { left: `${today.slice(0, 7)}-01` }),
      member('Partial', { joined: `${today.slice(0, 7)}-15` }),
      // 一笔收到明年年底：从去年 1 月起 36 期
      member('Prepaid', {
        receipts: [{ id: 'prepaid', date: past, amount: 360, currency: 'CNY', periods: Array.from({ length: 36 }, (_, k) => addMonths(past, k)) }],
      }),
    ]),
    car('youtube', 'YouTube', 3, [member('Quarterly', { billEvery: 3, fee: 30 })], { fee: 30, currency: 'CNY', billEvery: 3 }),
    car('storage', 'Storage', 6, [member('HalfYear', { billEvery: 6, fee: 60 })], { fee: 60, currency: 'CNY', billEvery: 6 }),
  ];
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function run(base) {
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(`${base}/api/${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(r.status, 200, `API ${method} ${path}: HTTP ${r.status}`);
    return r.json();
  };
  const initial = await api('state');
  assert.equal(initial.subscriptions.length, 0, 'The instance must be new and empty');
  await api('settings', 'PUT', { baseCurrency: 'CNY', collectCurrency: 'CNY', timezone: 'Asia/Shanghai', aiEnabled: true, categories: [{ name: 'Test' }] });
  const seed = async () => {
    for (const s of fixtures()) await api(`subscriptions/${s.id}`, 'PUT', s);
  };
  await seed();
  const writer = (await api('mcp/tokens', 'POST', { name: 'Fictional writer', scope: 'write' })).token;
  const reader = (await api('mcp/tokens', 'POST', { name: 'Fictional reader', scope: 'read' })).token;
  let id = 0;
  const rpc = async (method, params, token = writer) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    assert.equal(r.status, 200, `MCP HTTP ${r.status}`);
    const b = await r.json();
    assert.equal(b.error, undefined, 'JSON-RPC error');
    return b.result;
  };
  const call = (name, args, token) => rpc('tools/call', { name, arguments: args }, token);
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent;
  };
  const subs = async () => (await api('state')).subscriptions;
  const spotify = async () => (await subs()).find((s) => s.id === 'spotify');
  const history = (s) => s.share.members.map((m) => ({ id: m.id, receipts: m.receipts, waivers: m.waivers }));
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  const catalogue = (await rpc('tools/list', {})).tools;
  const permissionBefore = await api('rev');
  for (const tool of catalogue.filter((t) => !t.annotations.readOnlyHint)) assert.equal((await call(tool.name, {}, reader)).isError, true);
  assert.deepEqual(await api('rev'), permissionBefore);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  const props = (name) => catalogue.find((t) => t.name === name).inputSchema.properties;
  assert.ok(props('get_carpool').subscription);
  assert.ok(props('set_share').rule && props('set_share').rule_from);
  assert.ok(props('save_share_member').follow_rule && props('save_share_member').fee_from);
  assert.ok(!(await rpc('tools/list', {}, reader)).tools.some((t) => t.name === 'set_share'));
  const p = (await ok('get_carpool', { subscription: 'spotify' })).plans[0];
  assert.deepEqual(p.rule, { fee: 10, currency: 'CNY', every_months: 1, stored: false });
  const original = await spotify();
  for (const m of original.share.members) {
    const row = p.members.find((x) => x.id === m.id);
    const next = memberCollection(original, m, memberUnpaidFrom(original, m), 'CNY');
    assert.deepEqual(row.next_collection, next);
    const due = memberDues(original, today, 'CNY').find((d) => d.member.id === m.id);
    assert.equal(row.overdue_days, due.periodsOwed > 0 ? Math.max(0, diffDays(next.from, today)) : 0);
    assert.equal(row.follows_rule, !m.exempt && m.fee === 10);
  }
  assert.equal(p.members.find((m) => m.id === 'Prepaid').overdue_days, 0);
  console.log('PASS protocol: initialize, schemas, inferred rule, UI collection/overdue parity, multi-period and prepaid members');
  const edit = { subscription: 'spotify', role: 'owner', rule: { fee: 30, fee_currency: 'CNY', bill_every: 3 }, rule_from: future };
  const before = await subs();
  const revision = await api('rev');
  await ok('set_share', { ...edit, dry_run: true });
  assert.deepEqual(await subs(), before);
  assert.deepEqual(await api('rev'), revision);
  assert.equal((await call('set_share', edit, reader)).isError, true);
  for (const invalid of [
    { ...edit, rule: { bill_every: 121 } },
    { ...edit, role: 'member' },
    { ...edit, rule_from: '2026-02-30' },
  ])
    assert.equal((await call('set_share', invalid)).isError, true);
  assert.deepEqual(await subs(), before);
  await ok('set_share', edit);
  let s = await spotify();
  assert.deepEqual(history(s), history(original));
  for (const name of ['Alice', 'Partial', 'Prepaid']) {
    const m = s.share.members.find((x) => x.id === name);
    assert.equal(memberRate(s, m, today, 'CNY').amount, 10);
    assert.equal(memberRate(s, m, future, 'CNY').amount, 30);
    assert.equal(memberRate(s, m, future, 'CNY').billEvery, 3);
  }
  assert.equal(s.share.members.find((m) => m.id === 'Custom').custom, true);
  for (const name of ['Exempt', 'Departed'])
    assert.deepEqual(
      s.share.members.find((m) => m.id === name),
      original.share.members.find((m) => m.id === name),
    );
  await ok('set_share', { subscription: 'spotify', role: 'owner', seats: 17 });
  assert.deepEqual((await spotify()).share.rule, s.share.rule);
  // Existing receipts and waivers survive past changes, cycle changes and currency changes.
  await ok('set_share', { ...edit, rule: { fee: 12, fee_currency: 'USD', bill_every: 6 }, rule_from: `${today.slice(0, 7)}-01` });
  s = await spotify();
  assert.deepEqual(history(s), history(original));
  const bob = s.share.members.find((m) => m.id === 'Alice');
  assert.equal(memberRate(s, bob, today, 'CNY').currency, 'USD');
  assert.equal(memberRate(s, bob, today, 'CNY').billEvery, 6);
  console.log(
    'PASS protocol: rule preview/read-only/validation, future/past/cycle/currency edits, legacy custom classification, excluded members and preserved history',
  );
  await seed();
  await ok('set_share', { subscription: 'spotify', role: 'owner', rule: { fee: 10, bill_every: 1 } });
  const stable = history(await spotify());
  const carol = await ok('save_share_member', { subscription: 'spotify', name: 'Carol' });
  assert.equal(carol.member.follows_rule, true);
  s = await spotify();
  assert.equal(s.share.members.find((m) => m.name === 'Carol').fee, 10);
  for (const args of [
    { member: 'Alice', follow_rule: false },
    { member: 'Bob', fee: 19 },
    { member: 'Custom', follow_rule: true },
    { member: 'Bob', fee: 10 },
  ]) {
    const b = await subs();
    await ok('save_share_member', { subscription: 'spotify', ...args, dry_run: true });
    assert.deepEqual(await subs(), b);
    assert.equal((await call('save_share_member', { subscription: 'spotify', ...args }, reader)).isError, true);
    const r = await ok('save_share_member', { subscription: 'spotify', ...args });
    assert.equal(r.member.follows_rule, args.member !== 'Alice' && args.fee !== 19);
  }
  assert.deepEqual(
    history(await spotify()).filter((m) => m.id !== carol.member.id),
    stable,
  );
  const receipt = await ok('record_receivable', { subscription: 'spotify', kind: 'share', member: 'Bob', amount: 10 });
  assert.equal(receipt.after.periods.length, 1);
  s = await spotify();
  assert.equal(s.share.members.find((m) => m.id === 'Bob').receipts.length, 1);
  const receiptBefore = await subs();
  await ok('record_receivable', { subscription: 'spotify', kind: 'share', member: 'Bob', action: 'delete', id: receipt.after.id, dry_run: true });
  assert.deepEqual(await subs(), receiptBefore);
  await ok('record_receivable', { subscription: 'spotify', kind: 'share', member: 'Bob', action: 'delete', id: receipt.after.id });
  assert.deepEqual((await spotify()).share.members.find((m) => m.id === 'Bob').receipts, []);
  const removal = { subscription: 'spotify', member: carol.member.id };
  const b = await subs();
  await ok('remove_share_member', { ...removal, dry_run: true });
  assert.deepEqual(await subs(), b);
  assert.equal((await call('remove_share_member', removal, reader)).isError, true);
  await ok('remove_share_member', removal);
  assert.ok(!(await spotify()).share.members.some((m) => m.name === 'Carol'));
  console.log('PASS protocol: default member, follow/custom both ways, fee equality, previews/permissions, receipt create/delete and member removal');
  // Exercise the boundary regressions through actual HTTP and storage, too.
  await seed();
  await ok('set_share', { subscription: 'spotify', role: 'owner', rule: { fee: 10, bill_every: 1 } });
  await ok('save_share_member', { subscription: 'spotify', member: 'Alice', fee: 100, bill_every: 12, fee_from: future });
  assert.equal((await spotify()).share.members.find((m) => m.id === 'Alice').custom, true);
  const alice = (await spotify()).share.members.find((m) => m.id === 'Alice');
  await ok('set_share', { subscription: 'spotify', role: 'owner', rule: { fee: 11 } });
  assert.deepEqual(
    (await spotify()).share.members.find((m) => m.id === 'Alice'),
    alice,
  );
  await ok('save_share_member', { subscription: 'spotify', member: 'Bob', follow_rule: true, fee: 11, bill_every: 1 });
  s = await spotify();
  assert.equal(
    memberRate(
      s,
      s.share.members.find((m) => m.id === 'Bob'),
      past,
    ).amount,
    19,
  );
  const departed = s.share.members.find((m) => m.id === 'Departed');
  await ok('set_share', { subscription: 'spotify', role: 'owner', rule: { fee: 40 }, rule_from: past });
  assert.deepEqual(
    (await spotify()).share.members.find((m) => m.id === 'Departed'),
    departed,
  );
  console.log('PASS regressions: future custom classification, follow-rule baseline and departed backdated changes via HTTP');
  if (process.argv.includes('--deepseek')) await liveModels({ base, api, seed, subs, spotify, rpc, catalogue });
}

async function liveModels({ base, api, seed, subs, spotify, rpc, catalogue }) {
  const key = process.env.DEEPSEEK_API_KEY;
  assert.ok(key, '--deepseek requires DEEPSEEK_API_KEY in memory/environment');
  const tasks = [
    'Spotify 这辆车现在怎么收的？谁逾期了，逾期多少天？',
    '把 Spotify 的收款规则改成每季收 30 元，从下个月 1 号起生效',
    'Alice 以后自定义每年收 100 元',
    'Bob 改回跟随车',
    '新加一个成员 Carol，按车的规则收',
    '先预览一下把 YouTube 的规则改成每月 15，不要真的改',
  ];
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  const tools = catalogue.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const failures = [];
  for (const path of ['external', 'assistant']) {
    await seed();
    let history = [];
    if (path === 'assistant') {
      // The only persisted credential is in this disposable local assistant configuration.
      await api('assistant/config', 'PUT', { apiKey: key, model: DEEPSEEK_MODEL, baseUrl: DEEPSEEK_BASE_URL, effort: 'low' });
    }
    try {
      for (let i = 0; i < tasks.length; i++) {
        const before = await subs();
        const calls = [];
        const proposals = [];
        let reply = '';
        console.log(`MODEL ${path} task ${i + 1}: ${tasks[i]}`);
        if (path === 'external') {
          history.push({ role: 'user', content: tasks[i] });
          let finished = false;
          for (let round = 0; round < 8; round++) {
            const r = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
              method: 'POST',
              signal: AbortSignal.timeout(180_000),
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: [
                  {
                    role: 'system',
                    content: `${init.instructions}\nToday is ${today} (Asia/Shanghai). Base currency: CNY. Reply in Chinese. Execute requested writes after preview; a preview-only request must never be applied.`,
                  },
                  ...history,
                ],
                tools,
                thinking: { type: 'enabled' },
                reasoning_effort: 'low',
              }),
            });
            if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}`);
            const b = await r.json();
            const message = b.choices?.[0]?.message;
            assert.ok(message, 'DeepSeek returned no message');
            history.push(message);
            if (!message.tool_calls?.length) {
              reply = message.content ?? '';
              finished = true;
              break;
            }
            for (const c of message.tool_calls) {
              const args = JSON.parse(c.function.arguments);
              calls.push({ name: c.function.name, args });
              console.log(`  tool ${c.function.name} ${JSON.stringify(args)}`);
              const result = await rpc('tools/call', { name: c.function.name, arguments: args });
              assert.ok(!result.isError, `Model tool ${c.function.name} failed: ${result.content?.[0]?.text}`);
              history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result.structuredContent) });
            }
          }
          assert.ok(finished, 'Model exhausted tool rounds');
        } else {
          const r = await fetch(`${base}/api/assistant/chat`, {
            method: 'POST',
            signal: AbortSignal.timeout(240_000),
            headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN' },
            body: JSON.stringify({ text: tasks[i], history }),
          });
          assert.equal(r.status, 200);
          const lines = (await r.text()).split('\n').filter((l) => l.startsWith('data: '));
          let done = false;
          for (const line of lines) {
            const e = JSON.parse(line.slice(6));
            if (e.type === 'error') throw new Error(`Assistant provider error (${e.kind}, HTTP ${e.status ?? 'unknown'})`);
            if (e.type === 'tool' && e.status === 'error') throw new Error(`Assistant tool ${e.name} failed`);
            if (e.type === 'text') reply += e.delta;
            if (e.type === 'tool' && e.status === 'done') {
              calls.push({ name: e.name, args: e.args });
              console.log(`  tool ${e.name} ${JSON.stringify(e.args)}`);
            }
            if (e.type === 'proposal') proposals.push(e);
            if (e.type === 'done') {
              history.push(...e.messages);
              done = true;
            }
          }
          assert.ok(done, 'Assistant stream ended without done');
        }
        console.log(`  reply ${reply.slice(0, 1200)}`);
        const writes = calls.filter((c) => catalogue.find((t) => t.name === c.name)?.annotations.readOnlyHint === false);
        if (i === 0) {
          assert.equal(writes.length, 0);
          assert.deepEqual(await subs(), before);
          assert.ok(calls.some((c) => c.name === 'get_carpool'));
          const days = diffDays(past, today);
          assert.ok(reply.replaceAll(',', '').includes(String(days)), `Reply must report ${days} overdue days`);
        } else if (i === 5) {
          assert.ok(writes.some((c) => c.name === 'set_share' && c.args.rule?.fee === 15 && c.args.rule?.bill_every === 1));
          if (path === 'external')
            assert.ok(
              writes.every((c) => c.args.dry_run === true),
              'Preview-only task attempted a write',
            );
          assert.deepEqual(await subs(), before);
        } else {
          if (path === 'external') {
            const real = writes.filter((c) => !c.args.dry_run);
            assert.ok(real.length > 0, 'No write applied');
            for (const c of real)
              assert.ok(
                writes.some((p) => p.name === c.name && p.args.dry_run === true),
                'A write was not previewed',
              );
          } else {
            assert.deepEqual(await subs(), before, 'Assistant mutated before confirmation');
            assert.ok(proposals.length > 0, 'Missing confirmation card');
            for (const p of proposals) await api('assistant/apply', 'POST', p);
          }
          const s = await spotify();
          if (i === 1) {
            assert.deepEqual(s.share.rule, { fee: 30, currency: 'CNY', billEvery: 3 });
            for (const name of ['Alice', 'Partial']) {
              const m = s.share.members.find((m) => m.id === name);
              assert.equal(memberRate(s, m, today, 'CNY').amount, 10);
              assert.deepEqual(memberRate(s, m, future, 'CNY'), { amount: 30, currency: 'CNY', billEvery: 3 });
            }
          }
          if (i === 2) {
            const m = s.share.members.find((m) => m.id === 'Alice');
            assert.equal(m.custom, true);
            assert.deepEqual(memberRate(s, m, today, 'CNY'), { amount: 100, currency: 'CNY', billEvery: 12 });
            assert.deepEqual(memberRate(s, m, future, 'CNY'), { amount: 100, currency: 'CNY', billEvery: 12 });
            assert.ok(writes.some((c) => c.name === 'save_share_member' && c.args.fee === 100 && c.args.bill_every === 12));
          }
          if (i === 3) {
            const m = s.share.members.find((m) => m.id === 'Bob');
            assert.equal(m.custom, undefined);
            assert.deepEqual(memberRate(s, m, today, 'CNY'), { amount: 30, currency: 'CNY', billEvery: 3 });
            assert.ok(writes.some((c) => c.name === 'save_share_member' && c.args.follow_rule === true));
          }
          if (i === 4) {
            const m = s.share.members.find((m) => m.name === 'Carol');
            assert.ok(m && !m.custom);
            assert.deepEqual(memberRate(s, m, today, 'CNY'), { amount: 30, currency: 'CNY', billEvery: 3 });
          }
          const oldMembers = before.find((s) => s.id === 'spotify').share.members;
          for (const old of oldMembers) {
            const m = s.share.members.find((m) => m.id === old.id);
            assert.deepEqual(m.receipts, old.receipts);
            assert.deepEqual(m.waivers, old.waivers);
          }
        }
        console.log(`PASS model ${path} task ${i + 1}: tool arguments, stored values and history`);
      }
    } catch (e) {
      failures.push(`${path}: ${e instanceof Error ? e.message : 'failed'}`);
      console.log(`FAIL model ${path}: ${failures.at(-1)}`);
    } finally {
      if (path === 'assistant') await api('assistant/config', 'PUT', { apiKey: null });
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}

const temp = await mkdtemp(join(tmpdir(), 'calends-mcp-release-'));
let worker;
try {
  const port = await freePort();
  await writeFile(
    join(temp, 'wrangler.json'),
    JSON.stringify({
      name: 'calends-mcp-release',
      main: resolve(root, 'worker/index.ts'),
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [{ binding: 'DB', database_name: 'fictional-mcp', database_id: '00000000-0000-0000-0000-000000000000' }],
      vars: { DEV_BYPASS_AUTH: '1' },
    }),
  );
  worker = spawn(
    resolve(root, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '--config',
      join(temp, 'wrangler.json'),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      join(temp, 'data'),
      '--show-interactive-dev-session=false',
      '--log-level',
      'error',
    ],
    { cwd: temp, stdio: 'ignore', env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' } },
  );
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (worker.exitCode !== null) throw new Error('Isolated Worker exited during startup');
    try {
      ready = (await fetch(`${base}/api/auth/status`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, 'Worker startup timed out');
  await run(base);
} catch (e) {
  // Assertions only contain fictional data. Never dump environment, request headers or provider errors.
  console.error(e instanceof Error ? e.message : 'Release check failed');
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise((r) => worker.once('exit', r));
  }
  await rm(temp, { recursive: true, force: true });
  console.log('CLEANUP: isolated Worker stopped and temporary database removed');
}

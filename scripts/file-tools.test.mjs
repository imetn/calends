// MCP 文件工具：在临时数据库与临时对象目录上走完上传（base64、上传链接）、改名、关联/改关联/取消关联、列表、读取与下载链接、dry_run。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import { openR2 } from '../docker/r2.mjs';
import { flatten, setLocale } from '../shared/i18n.ts';
import core from '../shared/locales/zh-CN/core.json' with { type: 'json' };
import mcpMsgs from '../shared/locales/zh-CN/mcp.json' with { type: 'json' };
import { downloadByTicket, sweepFiles, uploadByTicket } from '../worker/files.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import { ASSISTANT_TOOLS } from '../worker/ai/assistant.ts';
import { MCP_CONTENT } from '../worker/ai/tool-kit.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { upsert } from '../worker/store.ts';

let dir;
let env;
const ctx = () => ({ env, access: { client: 'mcp', scope: 'write' } });
const run = (name, args) => TOOLS.find((x) => x.name === name).run(args, ctx());
const pdf = (tag) => new TextEncoder().encode(`%PDF-1.7\n${tag}\n`);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const sub = (id, name) => ({
  id,
  name,
  category: 'Software',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-01',
  status: 'active',
});
const token = (url) => url.split('/').pop();

before(async () => {
  setLocale('zh-CN', [flatten('core', core), flatten('mcp', mcpMsgs)]);
  dir = mkdtempSync(join(tmpdir(), 'calends-file-tools-'));
  env = { DB: openD1(join(dir, 'test.sqlite')), FILES: openR2(join(dir, 'files')), SITE_URL: 'https://ledger.example' };
  await ensureMigrated(env);
  await upsert(env, 'subscriptions', 's1', sub('s1', 'Fictional Cloud'));
  await upsert(env, 'subscriptions', 's2', sub('s2', 'Fictional Music'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('上传：base64 带 data: 前缀也可；挂法按日期推断为扣款；dry_run 不写入；来源必须恰好一个', async () => {
  const dry = await run('upload_file', { content_base64: b64(pdf('a')), name: 'inv.pdf', subscription: 'Fictional Cloud', date: '2026-02-01', dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.kind, 'charge');
  assert.equal((await run('list_files', {})).total, 0, 'dry_run 不写入');
  const { created } = await run('upload_file', {
    content_base64: `data:application/pdf;base64,${b64(pdf('a'))}`,
    name: '../inv 2月.pdf',
    subscription: 's1',
    date: '2026-02-01',
  });
  assert.equal(created.name, 'inv 2月.pdf');
  assert.deepEqual(created.subscription, { id: 's1', name: 'Fictional Cloud' });
  assert.equal(created.kind, 'charge');
  assert.equal(created.type, 'pdf');
  await assert.rejects(run('upload_file', { name: 'x.pdf' }), /只给一种/);
  await assert.rejects(run('upload_file', { content_base64: b64(pdf('b')), upload_link: true }), /只给一种/);
  await assert.rejects(run('upload_file', { content_base64: b64(new TextEncoder().encode('<svg/>')) }), /只支持/);
  await assert.rejects(run('upload_file', { content_base64: b64(pdf('c')), subscription: 's1', kind: 'charge' }), /关联方式无效/);
});

test('上传链接：只用一次，按领链接时的挂法入库；过期与用过的都 404', async () => {
  const link = await run('upload_file', { upload_link: true, subscription: 's2' });
  assert.match(link.upload_url, /^https:\/\/ledger\.example\/api\/files\/in\/[a-f0-9]{64}$/);
  assert.equal(link.method, 'PUT');
  const put = () => new Request(link.upload_url, { method: 'PUT', body: PNG, headers: { 'x-file-name': 'shot.png' } });
  const meta = await uploadByTicket(put(), env, token(link.upload_url));
  assert.equal(meta.subId, 's2');
  assert.equal(meta.kind, 'sub');
  assert.equal(meta.name, 'shot.png');
  await assert.rejects(uploadByTicket(put(), env, token(link.upload_url)), (e) => e.status === 404, '链接只能用一次');
  await assert.rejects(uploadByTicket(put(), env, 'f'.repeat(64)), (e) => e.status === 404);
  // 过期：把有效期改到过去，整点维护删掉
  const stale = await run('upload_file', { upload_link: true });
  await env.DB.prepare("UPDATE kv SET value = json_set(value, '$.exp', 1) WHERE key LIKE 'file-ticket:%'").run();
  await assert.rejects(uploadByTicket(put(), env, token(stale.upload_url)), (e) => e.status === 404);
  await sweepFiles(env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'file-ticket:%'").first()).n, 0);
});

test('改名、改关联、取消关联：同订阅只改日期时保留 kind；dry_run 给出前后两行且不写入', async () => {
  const { files } = await run('list_files', { subscription: 'Fictional Cloud' });
  const id = files[0].id;
  const dry = await run('update_file', { file: id, set: { name: 'renamed.pdf', subscription: 's2', date: '2026-03-01' }, dry_run: true });
  assert.equal(dry.before.subscription.id, 's1');
  assert.equal(dry.after.subscription.id, 's2');
  assert.equal(dry.after.kind, 'charge');
  assert.equal(dry.after.name, 'renamed.pdf');
  assert.equal((await run('list_files', { subscription: 's1' })).total, 1, 'dry_run 不写入');

  await run('update_file', { file: id, set: { name: 'renamed.pdf' } });
  let row = (await run('list_files', { query: 'renamed' })).files[0];
  assert.equal(row.subscription.id, 's1', '只改名不动关联');
  assert.match(row.title, /Fictional Cloud/, '已关联的文件仍按订阅命名');

  await run('update_file', { file: id, set: { kind: 'contract' } });
  row = (await run('list_files', { query: 'renamed' })).files[0];
  assert.deepEqual([row.kind, row.date], ['contract', '2026-02-01'], '同订阅只改 kind 时保留日期');

  await run('update_file', { file: id, set: { subscription: 'Fictional Music' } });
  row = (await run('list_files', { query: 'renamed' })).files[0];
  assert.deepEqual([row.subscription.id, row.kind, row.date], ['s2', 'sub', null], '换订阅且没给日期时挂到资料');

  await run('update_file', { file: id, set: { subscription: null } });
  row = (await run('list_files', { query: 'renamed' })).files[0];
  assert.equal(row.subscription, null);
  assert.equal(row.title, 'renamed.pdf', '未关联的文件显示原始文件名');
  assert.equal(
    (await run('list_files', { status: 'unlinked' })).files.some((f) => f.id === id),
    true,
  );
  await assert.rejects(run('update_file', { file: 'nope', set: { name: 'x' } }), /不存在/);
  await assert.rejects(run('update_file', { file: id, set: { subscription: 's1', kind: 'contract' } }), /关联方式无效/);
});

test('读取：图片作为 image 块、PDF 作为 resource 块（不进 JSON）；下载链接免登录、有效期内可重复取', async () => {
  const png = (await run('list_files', { query: 'shot' })).files[0];
  const out = await run('get_file', { file: png.id });
  assert.deepEqual(out[MCP_CONTENT], [{ type: 'image', data: b64(PNG), mimeType: 'image/png' }]);
  assert.equal(JSON.stringify(out).includes(b64(PNG)), false, '内容不进结构化结果');
  const doc = (await run('list_files', { query: 'renamed' })).files[0];
  const pdfOut = await run('get_file', { file: doc.id });
  assert.equal(pdfOut[MCP_CONTENT][0].type, 'resource');
  assert.equal(pdfOut[MCP_CONTENT][0].resource.mimeType, 'application/pdf');

  const { download_url } = await run('get_file', { file: png.id, as: 'link' });
  assert.match(download_url, /^https:\/\/ledger\.example\/api\/files\/out\/[a-f0-9]{64}$/);
  for (let i = 0; i < 2; i++) {
    const res = await downloadByTicket(env, token(download_url));
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  }
  await assert.rejects(
    downloadByTicket(env, token((await run('upload_file', { upload_link: true })).upload_url)),
    (e) => e.status === 404,
    '上传链接不能拿来下载',
  );
});

test('权限与边界：未启用存储时报错、列表返回 storage=false；助手不带上传与读取内容', async () => {
  const off = { env: { ...env, FILES: undefined } };
  assert.deepEqual(await TOOLS.find((x) => x.name === 'list_files').run({}, off), { storage: false, total: 0, files: [] });
  await assert.rejects(TOOLS.find((x) => x.name === 'update_file').run({ file: 'x', set: {} }, off), /未启用/);
  const names = ASSISTANT_TOOLS.map((x) => x.name);
  assert.ok(names.includes('list_files') && names.includes('update_file'));
  assert.ok(!names.includes('upload_file') && !names.includes('get_file'));
  assert.equal(TOOLS.find((x) => x.name === 'upload_file').write, true);
  assert.equal(TOOLS.find((x) => x.name === 'get_file').write, undefined, '读令牌可读取文件');
});

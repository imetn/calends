// 文件中心：在临时数据库与临时对象目录上走完上传、拒收、配额、重复内容、读取头、改挂法、删订阅保留来源、恢复备份、清理无主对象。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import { openR2 } from '../docker/r2.mjs';
import { unzipSync } from 'fflate';
import { exportAll, parseBackup, restoreAll } from '../worker/backup.ts';
import { backupWithFiles, deleteFile, patchFile, putBlob, readFile, saveFilePages, sweepFiles, uploadFile, uploadThumb, zipFiles } from '../worker/files.ts';
import { sniffPdfPages } from '../shared/files.ts';
import { flatten, setLocale } from '../shared/i18n.ts';
import core from '../shared/locales/zh-CN/core.json' with { type: 'json' };
import { ensureMigrated } from '../worker/migrate.ts';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { loadState, restoreLedger, saveLedgerEdit, upsert } from '../worker/store.ts';

let dir;
let env;
const pdf = (tag) => new TextEncoder().encode(`%PDF-1.7\n${tag}\n`);
const up = (body, q = '', name = 'scan.pdf') =>
  uploadFile(new Request(`http://x/api/files${q}`, { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } }), env);
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

// ensureMigrated 每个进程只跑一次；第二个库手动建表
const ensureMigratedFresh = async (e) => {
  for (const m of MIGRATIONS) await e.DB.batch(m.statements.map((x) => e.DB.prepare(x)));
};

before(async () => {
  setLocale('zh-CN', [flatten('core', core)]);
  dir = mkdtempSync(join(tmpdir(), 'calends-files-'));
  env = { DB: openD1(join(dir, 'test.sqlite')), FILES: openR2(join(dir, 'files')), FILES_LIMIT_MB: '1' };
  await ensureMigrated(env);
  await upsert(env, 'subscriptions', 's1', sub('s1', 'Fictional Cloud'));
  await upsert(env, 'subscriptions', 's2', sub('s2', 'Fictional Music'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('上传：按文件头认类型，挂法要成立，文件名清理后保存', async () => {
  const f = await up(pdf('a'), '?sub=s1&date=2026-02-01', '../发票 2月.pdf');
  assert.equal(f.mime, 'application/pdf');
  assert.equal(f.kind, 'charge');
  assert.equal(f.name, '发票 2月.pdf');
  await assert.rejects(up(new TextEncoder().encode('<svg/>')), (e) => e.status === 415);
  await assert.rejects(up(pdf('b'), '?sub=nope'), (e) => e.status === 400);
  await assert.rejects(up(pdf('b'), '?sub=s1&kind=charge'), (e) => e.status === 400);
  await assert.rejects(up(new Uint8Array()), (e) => e.status === 400);
  const loose = await up(pdf('loose'));
  assert.equal(loose.subId, undefined);
});

test('配额：同一内容只算一次，超出总量拒收', async () => {
  const big = new Uint8Array(600 * 1024);
  big.set(pdf('big'));
  await up(big);
  const again = await up(big, '?sub=s2', 'copy.pdf');
  assert.equal(again.size, big.byteLength, '重复内容不占新空间');
  const other = new Uint8Array(600 * 1024);
  other.set(pdf('other'));
  await assert.rejects(up(other), (e) => e.status === 413);
});

test('读取：服务端判定的类型、禁止嗅探、下载名规范化', async () => {
  const f = await up(pdf('read'), '?sub=s1&date=2026-03-01');
  const res = await readFile(env, f.id, { download: true });
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''FictionalCloud_2026-03-01_%E6%89%A3%E6%AC%BE\.pdf$/);
  assert.equal(new TextDecoder().decode(await res.arrayBuffer()), '%PDF-1.7\nread\n');
  await assert.rejects(readFile(env, 'missing', {}), (e) => e.status === 404);
});

test('批量下载：一个 ZIP，内容原样、规范名、同名加序号', async () => {
  const a = await up(pdf('zip-a'), '?sub=s1&date=2026-05-01');
  const b = await up(pdf('zip-b'), '?sub=s1&date=2026-05-01');
  const loose = await up(pdf('zip-c'), '', 'same.pdf');
  const loose2 = await up(pdf('zip-d'), '', 'same.pdf');
  const res = await zipFiles(env, [a.id, b.id, loose.id, loose2.id]);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['FictionalCloud_2026-05-01_扣款.pdf', 'FictionalCloud_2026-05-01_扣款_2.pdf', 'same (2).pdf', 'same.pdf']);
  assert.equal(new TextDecoder().decode(files['same.pdf']), '%PDF-1.7\nzip-c\n');
  await assert.rejects(zipFiles(env, ['nope']), (e) => e.status === 404);
});

test('改挂法与删除元数据', async () => {
  const f = await up(pdf('patch'));
  const moved = await patchFile(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ subId: 's2', kind: 'sub', date: null }) }), env, f.id);
  assert.equal(moved.subId, 's2');
  await assert.rejects(
    patchFile(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ subId: 's2', kind: 'charge', date: null }) }), env, f.id),
    (e) => e.status === 400,
  );
  await deleteFile(env, f.id);
  assert.ok(!(await loadState(env)).files.some((x) => x.id === f.id));
});

test('删除订阅：文件保留，转为未关联并记下原订阅名与挂法', async () => {
  const f = await up(pdf('orphan'), '?sub=s2&date=2026-04-01');
  const before = (await loadState(env)).rev;
  await saveLedgerEdit(env, {}, [], ['s2']);
  const state = await loadState(env);
  assert.ok(state.rev > before);
  const g = state.files.find((x) => x.id === f.id);
  assert.equal(g.subId, undefined);
  assert.deepEqual(g.orphan, { name: 'Fictional Music', kind: 'charge', date: '2026-04-01' });
});

test('恢复备份：备份里没有的订阅，其文件同样保留来源', async () => {
  const f = await up(pdf('restore'), '?sub=s1&kind=sub');
  await restoreLedger(env, { subscriptions: [], methods: [], people: [], fxDaily: [] });
  const g = (await loadState(env)).files.find((x) => x.id === f.id);
  assert.equal(g.orphan.name, 'Fictional Cloud');
  assert.equal(g.orphan.kind, 'sub');
});

test('清理：只删无人引用且超过 30 天的对象', async () => {
  const f = await up(pdf('sweep'));
  const state = await loadState(env);
  const row = await env.DB.prepare('SELECT sha256 FROM files WHERE id = ?1').bind(f.id).first();
  const path = join(dir, 'files', 'files', row.sha256.slice(0, 2), row.sha256);
  await deleteFile(env, f.id);
  assert.equal(await sweepFiles(env), 0, '刚删的不清');
  const old = new Date(Date.now() - 31 * 86400_000);
  utimesSync(path, old, old);
  assert.equal(await sweepFiles(env), 1);
  assert.ok(!existsSync(path));
  // 仍被引用的旧对象不清
  const kept = state.files.find((x) => x.subId === undefined && x.orphan === undefined && x.id !== f.id);
  const keptRow = await env.DB.prepare('SELECT sha256 FROM files WHERE id = ?1').bind(kept.id).first();
  const keptPath = join(dir, 'files', 'files', keptRow.sha256.slice(0, 2), keptRow.sha256);
  utimesSync(keptPath, old, old);
  assert.equal(await sweepFiles(env), 0);
  assert.ok(existsSync(keptPath));
});

test('备份（含文件）：ZIP 里有备份 JSON 与内容；恢复整表替换元数据，内容由浏览器逐个补回', async () => {
  await upsert(env, 'subscriptions', 's3', sub('s3', 'Fictional Notes'));
  const f = await up(pdf('backup'), '?sub=s3&date=2026-06-01');
  const res = await backupWithFiles(env);
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const jsonName = Object.keys(zip).find((n) => n.endsWith('.json'));
  const backup = JSON.parse(new TextDecoder().decode(zip[jsonName]));
  assert.equal(backup.version, 4);
  const entry = backup.files.find((x) => x.id === f.id);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(new TextDecoder().decode(zip[`files/${entry.sha256}`]), '%PDF-1.7\nbackup\n');

  // 换到全新部署：元数据随备份恢复，内容缺失时读取报「文件缺失」，补回后可读
  const fresh = mkdtempSync(join(tmpdir(), 'calends-files-restore-'));
  const prev = env;
  env = { DB: openD1(join(fresh, 'test.sqlite')), FILES: openR2(join(fresh, 'files')) };
  try {
    await ensureMigratedFresh(env);
    const r = await restoreAll(env, parseBackup(backup));
    assert.equal(r.files, backup.files.length);
    const state = await loadState(env);
    assert.equal(state.files.find((x) => x.id === f.id).subId, 's3');
    await assert.rejects(readFile(env, f.id, {}), (e) => e.status === 404);
    const put = (sha, body) => putBlob(new Request('http://x', { method: 'PUT', body }), env, sha);
    await assert.rejects(put(entry.sha256, pdf('tampered')), (e) => e.status === 400, '哈希对不上不收');
    await assert.rejects(put('b'.repeat(64), pdf('x')), (e) => e.status === 404, '元数据没引用的不收');
    assert.deepEqual(await put(entry.sha256, zip[`files/${entry.sha256}`]), { stored: true });
    assert.deepEqual(await put(entry.sha256, zip[`files/${entry.sha256}`]), { stored: false });
    assert.equal(new TextDecoder().decode(await (await readFile(env, f.id, {})).arrayBuffer()), '%PDF-1.7\nbackup\n');
    // 旧版备份（没有 files）恢复时不动现有文件
    const old = { ...backup, version: 3 };
    delete old.files;
    await restoreAll(env, parseBackup(old));
    assert.ok((await loadState(env)).files.some((x) => x.id === f.id));
    // 关联到备份里没有的订阅：转为未关联
    const bad = {
      ...backup,
      files: [
        { ...entry, subId: 'ghost' },
        { id: 'x', sha256: 'zz' },
      ],
    };
    await restoreAll(env, parseBackup(bad));
    const files = (await loadState(env)).files;
    assert.equal(files.length, 1);
    assert.equal(files[0].subId, undefined);
  } finally {
    env = prev;
    rmSync(fresh, { recursive: true, force: true });
  }
  assert.ok((await exportAll(env)).files.length > 0);
});

test('PDF 页数：未压缩 PDF 上传时识别、/thumb 与 /pages 按 sha256 共享，并在备份恢复间保留', async () => {
  await upsert(env, 'subscriptions', 'sp1', sub('sp1', 'Multi Page Cloud'));
  await upsert(env, 'subscriptions', 'sp2', sub('sp2', 'Multi Page Mirror'));
  const makePdf = (pages, extra = '') =>
    new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${extra}`);
  assert.equal(sniffPdfPages(makePdf(1)), 1);
  assert.equal(sniffPdfPages(makePdf(3)), 3);
  // 带压缩对象流时保守返回 undefined，交由浏览器端 pdf.js 统计
  assert.equal(sniffPdfPages(makePdf(3, '3 0 obj\n<< /Type /ObjStm >>\nendobj\n')), undefined);

  const threePage = await up(makePdf(3, '% unique-3p'), '?sub=sp1&date=2026-07-01', 'three.pdf');
  assert.equal(threePage.pages, 3);

  // 压缩 PDF 上传时 pages 为 undefined，随后由 /thumb?pages=2 或 /pages 补写并按 sha256 共享
  const compressedBytes = makePdf(2, '3 0 obj\n<< /Type /ObjStm >>\nendobj\n% comp-a');
  const compA = await up(compressedBytes, '?sub=sp1&date=2026-08-01', 'comp-a.pdf');
  const compB = await up(compressedBytes, '?sub=sp2&date=2026-08-01', 'comp-b.pdf');
  assert.equal(compA.pages, undefined);
  assert.equal(compB.pages, undefined);

  // 合法 1x1 PNG 作为缩略图测试 /thumb?pages=2
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const withThumb = await uploadThumb(new Request(`http://x/api/files/${compA.id}/thumb?pages=2`, { method: 'POST', body: png1x1 }), env, compA.id);
  assert.equal(withThumb.thumb, true);
  assert.equal(withThumb.pages, 2);
  // 同内容另一条记录同步获得页数
  assert.equal((await loadState(env)).files.find((x) => x.id === compB.id)?.pages, 2);

  // /pages 接口可独立补写并拒绝非法值或非 PDF
  const updated = await saveFilePages(
    new Request(`http://x/api/files/${compA.id}/pages`, { method: 'POST', body: JSON.stringify({ pages: 4 }) }),
    env,
    compA.id,
  );
  assert.equal(updated.pages, 4);
  assert.equal((await loadState(env)).files.find((x) => x.id === compB.id)?.pages, 4);
  await assert.rejects(
    saveFilePages(new Request(`http://x/api/files/${compA.id}/pages`, { method: 'POST', body: JSON.stringify({ pages: 0 }) }), env, compA.id),
    (e) => e.status === 400,
  );
  const img = await up(png1x1, '', 'receipt.png');
  assert.equal(img.pages, undefined);
  await assert.rejects(
    saveFilePages(new Request(`http://x/api/files/${img.id}/pages`, { method: 'POST', body: JSON.stringify({ pages: 2 }) }), env, img.id),
    (e) => e.status === 400,
  );

  // 备份导出与恢复完整保留 pages
  const exported = await exportAll(env);
  assert.equal(exported.files.find((x) => x.id === threePage.id)?.pages, 3);
  assert.equal(exported.files.find((x) => x.id === compA.id)?.pages, 4);
  const fresh = mkdtempSync(join(tmpdir(), 'calends-files-pages-restore-'));
  const freshEnv = { DB: openD1(join(fresh, 'test.sqlite')), FILES: openR2(join(fresh, 'files')) };
  try {
    await ensureMigratedFresh(freshEnv);
    await restoreAll(freshEnv, parseBackup(exported));
    const st = await loadState(freshEnv);
    assert.equal(st.files.find((x) => x.id === threePage.id)?.pages, 3);
    assert.equal(st.files.find((x) => x.id === compA.id)?.pages, 4);
    assert.equal(st.files.find((x) => x.id === img.id)?.pages, undefined);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

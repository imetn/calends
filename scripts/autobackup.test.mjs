// 自动备份：加密格式、S3 签名、滚动保留、触发条件，以及对假 S3 / 假 WebDAV 服务的完整备份流程（含恢复前备份失败时不替换账本、切换存储后另一份设置保留）。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import { deriveBackupKey, isEncryptedBackup, openBackup, sealBackup, WrongPassphrase } from '../shared/backup-crypto.ts';
import { regionOf, signS3 } from '../worker/s3.ts';
import {
  backupBeforeReplace,
  backupDue,
  backupFileName,
  filesToPrune,
  removeAutoBackup,
  runAutoBackup,
  saveAutoBackup,
  viewAutoBackup,
} from '../worker/autobackup.ts';
import { ensureMigrated } from '../worker/migrate.ts';

test('加密备份：口令解开后与原文一致，口令错误报 WrongPassphrase', async () => {
  const key = await deriveBackupKey('correct horse', undefined, 100_000);
  const json = JSON.stringify({ format: 'calends-backup', subscriptions: [{ id: 'a', name: '中文'.repeat(500) }] });
  const sealed = await sealBackup(json, key);
  const file = JSON.parse(sealed);
  assert.ok(isEncryptedBackup(file));
  assert.ok(!sealed.includes('中文'));
  assert.ok(sealed.length < json.length, 'gzip 后再加密');
  assert.equal(await openBackup(file, 'correct horse'), json);
  await assert.rejects(openBackup(file, 'wrong'), WrongPassphrase);
  // 文件里的轮数有上限：改过的文件不能让浏览器卡死
  await assert.rejects(openBackup({ ...file, kdf: { ...file.kdf, iterations: 1e9 } }, 'correct horse'), /unsupported/);
});

test('S3 签名与 AWS 文档示例一致；地区按服务地址推断', async () => {
  const h = await signS3({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.equal(regionOf('https://abc.r2.cloudflarestorage.com'), 'auto');
  assert.equal(regionOf('https://s3.eu-west-2.amazonaws.com'), 'eu-west-2');
  assert.equal(regionOf('https://s3.us-west-004.backblazeb2.com'), 'us-west-004');
  assert.equal(regionOf('http://192.168.1.5:9000'), 'us-east-1');
});

test('滚动保留只删自动备份生成的旧文件，至少留一份', () => {
  const names = [1, 2, 3, 4].map((d) => backupFileName(Date.UTC(2026, 0, d)));
  const all = [...names, 'notes.txt', `x-${backupFileName(0)}`, backupFileName(Date.UTC(2026, 0, 5), 'before-restore')];
  assert.deepEqual(filesToPrune(all, 3), [names[1], names[0]]);
  assert.deepEqual(filesToPrune(all, 0).length, 4);
  assert.deepEqual(filesToPrune([backupFileName(0)], 5), []);
});

test('触发：有改动满 1 小时、无改动满 1 天；失败后退避', () => {
  const on = { enabled: true };
  const H = 3_600_000;
  assert.equal(backupDue(undefined, {}, 1, 0), false);
  assert.equal(backupDue({ enabled: false }, {}, 1, 0), false);
  assert.equal(backupDue(on, {}, 1, 10 * H), true);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 1 }, 2, 0.5 * H), false);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 1 }, 2, H), true);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 2 }, 2, 23 * H), false);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 2 }, 2, 24 * H), true);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 1, failures: 3, lastTryAt: 2 * H }, 2, 2.5 * H), false);
  assert.equal(backupDue(on, { lastAt: 0, lastRev: 1, failures: 3, lastTryAt: 2 * H }, 2, 3 * H), true);
});

// 假 S3：只认带签名的请求，按路径存取，列表返回 ListObjectsV2 的 XML
const objects = new Map();
let failPut = false;
let puts = 0;
let server;
let endpoint;
let dir;
let env;
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (
      !/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? '')
    ) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (bucket !== 'bk') return void res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
    if (req.method === 'PUT') {
      if (failPut) return void res.writeHead(500).end('<Error><Code>InternalError</Code><Message>disk full</Message></Error>');
      puts++;
      objects.set(key, Buffer.concat(chunks).toString());
      return void res.writeHead(200).end();
    }
    if (req.method === 'DELETE') return void (objects.delete(key), res.writeHead(204).end());
    if (req.method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${items.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
      return void res.writeHead(200).end(xml);
    }
    res.writeHead(objects.has(key) ? 200 : 404).end(objects.get(key) ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'calends-autobackup-'));
  env = { DB: openD1(join(dir, 'test.sqlite')) };
  await ensureMigrated(env);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('完整流程：上传加密文件、内容未变不重复上传、按份数滚动、不回传密钥、恢复前备份失败返回错误', async () => {
  const key = await deriveBackupKey('pass phrase', undefined, 100_000);
  assert.equal(
    typeof (await saveAutoBackup(env, {
      kind: 's3',
      s3: { endpoint, bucket: 'bk', prefix: '/calends/', accessKeyId: 'AK', secretAccessKey: '' },
      key,
      keep: 2,
    })),
    'string',
  );
  const saved = await saveAutoBackup(env, {
    kind: 's3',
    s3: { endpoint, bucket: 'bk', prefix: '/calends/', accessKeyId: 'AK', secretAccessKey: 'SK' },
    key,
    keep: 2,
  });
  assert.equal(saved.s3.prefix, 'calends');
  const nested = 'calends/sub/' + backupFileName(0);
  objects.set(nested, 'nested');
  objects.set('calends/notes.txt', 'keep me');

  const first = await runAutoBackup(env, { now: Date.UTC(2026, 0, 1) });
  assert.match(first.lastFile, /^calends\/calends-backup-20260101-000000-000-[a-f0-9]{32}\.json$/);
  const restored = JSON.parse(await openBackup(JSON.parse(objects.get(first.lastFile)), 'pass phrase'));
  assert.equal(restored.format, 'calends-backup');

  const same = await runAutoBackup(env, { now: Date.UTC(2026, 0, 2) });
  assert.equal(same.lastFile, first.lastFile, '内容未变不上传');
  assert.equal(objects.size, 3);

  const third = await runAutoBackup(env, { force: true, now: Date.UTC(2026, 0, 3) });
  const fourth = await runAutoBackup(env, { force: true, now: Date.UTC(2026, 0, 4) });
  assert.deepEqual([...objects.keys()].sort(), [third.lastFile, fourth.lastFile, 'calends/notes.txt', nested].sort());

  // 留空密钥沿用已存的；浏览器拿到的视图里没有密钥
  assert.equal(
    (await saveAutoBackup(env, { kind: 's3', s3: { endpoint, bucket: 'bk', prefix: 'calends', accessKeyId: 'AK' }, keep: 2 })).s3.secretAccessKey,
    'SK',
  );
  // 换了服务地址就要重新填密钥，不把旧凭据发给新主机
  assert.equal(
    typeof (await saveAutoBackup(env, {
      kind: 's3',
      s3: { endpoint: 'https://other.example.com', bucket: 'bk', prefix: 'calends', accessKeyId: 'AK' },
      keep: 2,
    })),
    'string',
  );
  const view = await viewAutoBackup(env);
  assert.equal(view.configured, true);
  assert.equal(view.s3.saved, true);
  assert.ok(!JSON.stringify(view).includes('SK') && !JSON.stringify(view).includes(key.key) && !('lastHash' in view.status));

  failPut = true;
  await env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('changed', '{}')").run();
  const error = await backupBeforeReplace(env);
  assert.ok(error, '备份失败时返回错误，调用方据此拒绝替换');
  const failed = (await viewAutoBackup(env)).status;
  assert.equal(failed.failures, 1);
  assert.match(failed.lastError ?? '', /disk full/);
  failPut = false;
  assert.equal(await backupBeforeReplace(env), undefined);
  assert.ok([...objects.keys()].some((k) => k.endsWith('-before-restore.json')));
  // 内容没变也照样上传一份恢复前备份
  const n = puts;
  assert.equal(await backupBeforeReplace(env), undefined);
  assert.equal(puts, n + 1);
});

// 假 WebDAV：只认 Basic 认证；父文件夹不存在时 PUT 回 403；PROPFIND 返回直接子项（含子文件夹）
const dav = new Map();
const davDirs = new Set(['/dav']);
let davServer;
let davUrl;
before(async () => {
  davServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== `Basic ${Buffer.from('me:pw').toString('base64')}`) return void res.writeHead(401).end();
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '');
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (req.method === 'MKCOL') {
      if (davDirs.has(path)) return void res.writeHead(405).end();
      if (!davDirs.has(parent)) return void res.writeHead(409).end();
      davDirs.add(path);
      return void res.writeHead(201).end();
    }
    if (req.method === 'PUT') {
      // 父文件夹不存在：像 Apache mod_dav 那样回 403（规范是 409，两者走同一处理）
      if (!davDirs.has(parent)) return void res.writeHead(403).end();
      dav.set(path, Buffer.concat(chunks).toString());
      return void res.writeHead(201).end();
    }
    if (req.method === 'DELETE') return void res.writeHead(dav.delete(path) ? 204 : 404).end();
    if (req.method === 'PROPFIND') {
      if (!davDirs.has(path)) return void res.writeHead(404).end();
      const kids = [...dav.keys()].filter((k) => k.slice(0, k.lastIndexOf('/')) === path);
      const dirs = [...davDirs].filter((d) => d.slice(0, d.lastIndexOf('/')) === path);
      // 文件夹用带前缀的相对路径，文件用默认命名空间的绝对地址，且路径前面多一段代理前缀——都要认得
      const r = (h, dir) =>
        `<D:response><D:href>${encodeURI(h)}${dir ? '/' : ''}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype></D:prop></D:propstat></D:response>`;
      const f = (h) =>
        `<response xmlns="DAV:"><href>http://proxy.example${encodeURI(`/p${h}`)}</href><propstat><prop><resourcetype/></prop></propstat></response>`;
      const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${r(path, true)}${dirs.map((d) => r(d, true)).join('')}${kids.map(f).join('')}</D:multistatus>`;
      return void res.writeHead(207).end(xml);
    }
    res.writeHead(405).end();
  });
  await new Promise((r) => davServer.listen(0, '127.0.0.1', r));
  davUrl = `http://127.0.0.1:${davServer.address().port}/dav/`;
});
after(() => davServer.close());

test('WebDAV：建文件夹后上传、按份数滚动、切换存储后 S3 设置保留', async () => {
  await env.DB.prepare("INSERT INTO subscriptions (id, data) VALUES ('dav', '{}')").run();
  assert.equal(
    typeof (await saveAutoBackup(env, { kind: 'webdav', webdav: { url: davUrl, folder: 'calends', username: 'me' }, keep: 2 })),
    'string',
    '没存过密码要填',
  );
  const saved = await saveAutoBackup(env, { kind: 'webdav', webdav: { url: davUrl, folder: '/备份/calends/', username: 'me', password: 'pw' }, keep: 2 });
  assert.equal(saved.webdav.url, davUrl.replace(/\/$/, ''));
  assert.equal(saved.s3.secretAccessKey, 'SK', 'S3 设置留着');
  dav.set('/dav/备份/calends/notes.txt', 'keep me');

  assert.deepEqual((await viewAutoBackup(env)).status, {}, '换了存储位置，旧位置的记录清掉');
  const first = await runAutoBackup(env, { now: Date.UTC(2026, 1, 1) });
  assert.match(first.lastFile, /^备份\/calends\/calends-backup-20260201-000000-000-[a-f0-9]{32}\.json$/);
  const restored = JSON.parse(await openBackup(JSON.parse(dav.get('/dav/' + first.lastFile)), 'pass phrase'));
  assert.equal(restored.format, 'calends-backup');
  davDirs.add('/dav/备份/calends/old');
  const second = await runAutoBackup(env, { force: true, now: Date.UTC(2026, 1, 2) });
  const third = await runAutoBackup(env, { force: true, now: Date.UTC(2026, 1, 3) });
  assert.deepEqual([...dav.keys()].sort(), ['/dav/' + second.lastFile, '/dav/' + third.lastFile, '/dav/备份/calends/notes.txt'].sort());

  // 没设置过时只切开关报错；只切开关不改设置；换用户名不沿用旧密码
  await removeAutoBackup(env);
  assert.equal(typeof (await saveAutoBackup(env, { enabled: true })), 'string');
  await saveAutoBackup(env, {
    kind: 's3',
    s3: { endpoint, bucket: 'bk', prefix: 'calends', accessKeyId: 'AK', secretAccessKey: 'SK' },
    key: await deriveBackupKey('pass phrase', undefined, 100_000),
    keep: 2,
  });
  await saveAutoBackup(env, { kind: 'webdav', webdav: { url: davUrl, folder: '备份/calends', username: 'me', password: 'pw' }, keep: 2 });
  assert.equal((await saveAutoBackup(env, { enabled: false })).webdav.password, 'pw');
  assert.equal((await viewAutoBackup(env)).enabled, false);
  assert.equal(typeof (await saveAutoBackup(env, { kind: 'webdav', webdav: { url: davUrl, folder: 'calends', username: 'other' }, keep: 2 })), 'string');
  const view = await viewAutoBackup(env);
  assert.equal(view.kind, 'webdav');
  assert.ok(view.webdav.saved && view.s3.saved && !JSON.stringify(view).includes('"pw"'));

  // 切回 S3：留空密钥沿用之前存的
  assert.equal((await saveAutoBackup(env, { kind: 's3', s3: { endpoint, bucket: 'bk', prefix: 'calends', accessKeyId: 'AK' }, keep: 2 })).kind, 's3');
});

test('同一毫秒的恢复前备份保留独立快照，旧文件按时间参与滚动', async () => {
  objects.clear();
  const key = await deriveBackupKey('snapshot pass', undefined, 100_000);
  await saveAutoBackup(env, {
    kind: 's3',
    s3: { endpoint, bucket: 'bk', prefix: 'unique', accessKeyId: 'AK', secretAccessKey: 'SK' },
    key,
    keep: 30,
  });
  const now = Date.UTC(2026, 0, 6, 0, 0, 0, 123);
  await env.DB.prepare("INSERT OR REPLACE INTO subscriptions (id, data) VALUES ('snapshot', ?)")
    .bind(JSON.stringify({ id: 'snapshot', name: 'Before first restore' }))
    .run();
  const first = await runAutoBackup(env, { force: true, reason: 'before-restore', now });
  await env.DB.prepare("UPDATE subscriptions SET data = ? WHERE id = 'snapshot'")
    .bind(JSON.stringify({ id: 'snapshot', name: 'Before second restore' }))
    .run();
  const second = await runAutoBackup(env, { force: true, reason: 'before-restore', now });
  assert.notEqual(first.lastFile, second.lastFile);
  assert.equal(objects.size, 2);
  for (const [file, name] of [
    [first.lastFile, 'Before first restore'],
    [second.lastFile, 'Before second restore'],
  ]) {
    const backup = JSON.parse(await openBackup(JSON.parse(objects.get(file)), 'snapshot pass'));
    assert.equal(backup.subscriptions.find((s) => s.id === 'snapshot').name, name);
  }
  const legacy = 'calends-backup-20260106-000000-before-restore.json';
  const newer = backupFileName(now + 1);
  assert.deepEqual(filesToPrune([legacy, first.lastFile.split('/').pop(), newer, 'notes.json'], 2), [legacy]);
});

test('只保留一份时优先保留本次快照，同毫秒随机 ID 较小也不删除当前文件', async () => {
  const previous = 'calends-backup-20260106-000000-123-ffffffffffffffffffffffffffffffff-before-restore.json';
  const current = 'calends-backup-20260106-000000-123-00000000000000000000000000000000-before-restore.json';
  assert.deepEqual(filesToPrune([previous, current], 1, current), []);
  const later = 'calends-backup-20260106-000000-124-00000000000000000000000000000000-before-restore.json';
  const names = [previous, current, later];
  const concurrentDeletes = new Set([...filesToPrune(names, 1, previous), ...filesToPrune(names, 1, later)]);
  assert.ok(!concurrentDeletes.has(later), '并发请求不能互相删除所有快照');
  const saved = await saveAutoBackup(env, {
    kind: 's3',
    s3: { endpoint, bucket: 'bk', prefix: 'unique', accessKeyId: 'AK', secretAccessKey: 'SK' },
    keep: 1,
  });
  assert.equal(saved.keep, 1);
  const latest = await runAutoBackup(env, { force: true, reason: 'before-restore', now: Date.UTC(2026, 0, 6, 0, 0, 0, 123) });
  assert.ok(objects.has(latest.lastFile));
  const laterBackup = await runAutoBackup(env, { force: true, reason: 'before-restore', now: Date.UTC(2026, 0, 6, 0, 0, 0, 124) });
  assert.deepEqual([...objects.keys()], [laterBackup.lastFile]);
});

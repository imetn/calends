// 自动备份：加密格式、S3 签名、滚动保留、触发条件，以及对一个假 S3 服务的完整备份流程（含恢复前备份失败时不替换账本）。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openD1 } from '../docker/d1.mjs';
import { deriveBackupKey, isEncryptedBackup, openBackup, sealBackup, WrongPassphrase } from '../shared/backup-crypto.ts';
import { regionOf, signS3 } from '../worker/s3.ts';
import { backupBeforeReplace, backupDue, backupFileName, filesToPrune, runAutoBackup, saveAutoBackup, viewAutoBackup } from '../worker/autobackup.ts';
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
  const names = [1, 2, 3, 4].map((d) => `b/${backupFileName(Date.UTC(2026, 0, d))}`);
  const keys = [...names, 'b/notes.txt', 'b/sub/' + backupFileName(0), backupFileName(0), `b/${backupFileName(Date.UTC(2026, 0, 5), 'before-restore')}`];
  assert.deepEqual(filesToPrune(keys, 'b', 3), [names[1], names[0]]);
  assert.deepEqual(filesToPrune(keys, 'b', 0).length, 4);
  assert.deepEqual(filesToPrune([backupFileName(0)], '', 5), []);
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
    typeof (await saveAutoBackup(env, { endpoint, bucket: 'bk', prefix: '/calends/', accessKeyId: 'AK', secretAccessKey: '', key, keep: 2 })),
    'string',
  );
  const saved = await saveAutoBackup(env, { endpoint, bucket: 'bk', prefix: '/calends/', accessKeyId: 'AK', secretAccessKey: 'SK', key, keep: 2 });
  assert.equal(saved.prefix, 'calends');
  objects.set('calends/notes.txt', 'keep me');

  const first = await runAutoBackup(env, { now: Date.UTC(2026, 0, 1) });
  assert.equal(first.lastFile, 'calends/calends-backup-20260101-000000.json');
  const restored = JSON.parse(await openBackup(JSON.parse(objects.get(first.lastFile)), 'pass phrase'));
  assert.equal(restored.format, 'calends-backup');

  const same = await runAutoBackup(env, { now: Date.UTC(2026, 0, 2) });
  assert.equal(same.lastFile, first.lastFile, '内容未变不上传');
  assert.equal(objects.size, 2);

  await runAutoBackup(env, { force: true, now: Date.UTC(2026, 0, 3) });
  await runAutoBackup(env, { force: true, now: Date.UTC(2026, 0, 4) });
  assert.deepEqual([...objects.keys()].sort(), [
    'calends/calends-backup-20260103-000000.json',
    'calends/calends-backup-20260104-000000.json',
    'calends/notes.txt',
  ]);

  // 留空密钥沿用已存的；浏览器拿到的视图里没有密钥
  await saveAutoBackup(env, { endpoint, bucket: 'bk', prefix: 'calends', accessKeyId: 'AK', keep: 2 });
  // 换了服务地址就要重新填密钥，不把旧凭据发给新主机
  assert.equal(
    typeof (await saveAutoBackup(env, { endpoint: 'https://other.example.com', bucket: 'bk', prefix: 'calends', accessKeyId: 'AK', keep: 2 })),
    'string',
  );
  const view = await viewAutoBackup(env);
  assert.equal(view.configured, true);
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

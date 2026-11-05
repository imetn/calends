// 自托管运行时：起打包后的真实入口，走 HTTP 验证 Worker 在 Node 上的行为（虚构数据、临时目录）。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { openD1 } from '../docker/d1.mjs';
import { clientIp, proxyTrust } from '../docker/client-ip.mjs';
import { createFront, maxBodyFor } from '../docker/front.mjs';

const DB_NAME = join('v3', 'd1', 'miniflare-D1DatabaseObject', '9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite');
const root = mkdtempSync(join(tmpdir(), 'calends-runtime-'));
const bundle = join(root, 'entrypoint.mjs');
const dist = join(root, 'dist');

const freePort = () =>
  new Promise((resolve) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** 原始请求：能带 Host、拿到重复的 Set-Cookie 和未解压的响应体 */
function send(port, { path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const children = new Set();

async function start(data, env = {}, entry = bundle) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: data, ASSETS_DIR: dist, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try {
      if ((await send(port, { path: '/healthz' })).status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, exited, log: () => log };
}

async function stop(run) {
  run.child.kill('SIGTERM');
  return run.exited;
}

const json = (port, path, data, headers = {}) =>
  send(port, {
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, ...headers },
    body: JSON.stringify(data),
  });

before(() => {
  const built = spawnSync(
    'npx',
    [
      'esbuild',
      'docker/entrypoint.mjs',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node24',
      `--outfile=${bundle}`,
      '--log-level=error',
      "--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<!doctype html><title>calends</title>${'<!-- x -->'.repeat(300)}`);
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), `console.log(1);${' '.repeat(3000)}`);
  writeFileSync(join(dist, 'assets', 'sql-abc123.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"calends"}');
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

test('D1 垫片：与 D1 相同的返回形状、参数校验和整批回滚', async () => {
  const db = openD1(join(root, 'shape.sqlite'));
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)').run();
  const inserted = await db.prepare('INSERT INTO t (v) VALUES (?1)').bind('a').run();
  assert.equal(inserted.meta.changes, 1);
  assert.equal(inserted.meta.last_row_id, 1);
  const returned = await db.prepare('INSERT INTO t (v) VALUES (?1) RETURNING id').bind('b').run();
  assert.deepEqual(returned.results, [{ id: 2 }]);
  assert.equal(returned.meta.changes, 1);
  const noop = await db.prepare('UPDATE t SET v = ?1 WHERE id = 99').bind('x').run();
  assert.equal(noop.meta.changes, 0);

  const row = await db.prepare('SELECT * FROM t WHERE id = ?1').bind(1).first();
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(await db.prepare('SELECT v FROM t WHERE id = ?1').bind(1).first('v'), 'a');
  assert.equal(await db.prepare('SELECT v FROM t WHERE id = 99').first(), null);
  await assert.rejects(db.prepare('SELECT v FROM t').first('missing'), /no such column/);
  assert.throws(() => db.prepare('SELECT ?1').bind(undefined), /D1_TYPE_ERROR/);
  await assert.rejects(db.prepare('INSERT INTO t (id, v) VALUES (?1, ?2)').bind(9).run(), /Wrong number of parameter bindings/, '少传参数不能写成 NULL');
  await assert.rejects(db.prepare('SELECT ?').all(), /Wrong number/);
  assert.deepEqual((await db.prepare("SELECT '?' AS q").all()).results, [{ q: '?' }], '字面量里的问号不是参数');
  assert.deepEqual((await db.prepare("-- writer's rev?\nSELECT 1 AS n").all()).results, [{ n: 1 }], '注释里的问号也不是参数');
  assert.deepEqual((await db.prepare('SELECT ?1 AS b').bind(true).all()).results, [{ b: 1 }]);

  const stmt = db.prepare('INSERT INTO t (v) VALUES (?1)');
  await assert.rejects(db.batch([stmt.bind('c'), stmt.bind('a')]), /UNIQUE/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM t').first()).n, 2, '失败的批次不能留下前面的写入');
  const [ins, sel] = await db.batch([stmt.bind('d'), db.prepare('SELECT count(*) AS n FROM t')]);
  assert.equal(ins.meta.changes, 1);
  assert.deepEqual(sel.results, [{ n: 3 }]);
  db.close();
});

test('HTTP 层：访客 IP 不能自报，超大请求被拒绝，重复 Set-Cookie 不合并', async (t) => {
  const seen = [];
  const front = createFront({
    handle: async (req) => {
      seen.push({ url: req.url, ip: req.headers.get('cf-connecting-ip'), body: await req.text() });
      const headers = new Headers({ 'content-type': 'text/plain' });
      headers.append('set-cookie', 'a=1');
      headers.append('set-cookie', 'b=2');
      return new Response('ok', { headers });
    },
    healthy: () => false,
    maxBody: () => 16,
  }).listen(0, '127.0.0.1');
  t.after(() => front.close());
  await new Promise((r) => front.once('listening', r));
  const { port } = front.address();

  const res = await send(port, {
    path: '//evil.example/x?y=1',
    method: 'POST',
    headers: { host: 'calends.example', 'cf-connecting-ip': '6.6.6.6' },
    body: 'hello',
  });
  assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(seen[0].url, 'http://calends.example//evil.example/x?y=1');
  assert.equal(seen[0].ip, '127.0.0.1');
  assert.equal(seen[0].body, 'hello');
  assert.equal((await send(port, { method: 'POST', body: 'x'.repeat(17), headers: { 'content-length': '17' } })).status, 413);
  for (const path of ['/api/login', '/calends/api/login', '/api/auth/setup', '/api/auth/passkey/login']) {
    assert.equal(maxBodyFor(path), 64 * 1024, `${path} 未鉴权就读请求体，上限必须小`);
  }
  assert.equal(maxBodyFor('/calends/api/backup'), 20 * 1024 * 1024);
  assert.equal(maxBodyFor('/api/assistant/chat'), 20 * 1024 * 1024, '带图的助手对话会超过默认上限');
  assert.equal((await send(port, { path: '/healthz' })).status, 503, '数据库不可用时健康检查要失败');
});

test('HTTP 层：不读请求体就响应，连接仍可复用；对方断开时通知 Worker', async (t) => {
  let aborted;
  const signalled = new Promise((resolve) => (aborted = resolve));
  const front = createFront({
    handle: async (req) => {
      if (new URL(req.url).pathname === '/slow') {
        req.signal.addEventListener('abort', () => aborted(true));
        return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('data: 1\n\n')) }), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('nope', { status: 401 });
    },
    healthy: () => true,
    maxBody: () => 8 * 1024 * 1024,
  }).listen(0, '127.0.0.1');
  t.after(() => {
    front.closeAllConnections();
    front.close();
  });
  await new Promise((r) => front.once('listening', r));
  const { port } = front.address();

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const viaAgent = (options, body) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, agent, ...options }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.setTimeout(3000, () => req.destroy(new Error('连接被未读完的请求体卡住')));
      req.on('error', reject);
      req.end(body);
    });
  assert.equal(await viaAgent({ method: 'POST', path: '/', headers: { 'content-length': 900_000 } }, Buffer.alloc(900_000)), 401);
  assert.equal(await viaAgent({ path: '/' }), 401, '同一连接的下一个请求要有响应');

  const slow = request({ host: '127.0.0.1', port, path: '/slow' }, () => slow.destroy());
  slow.on('error', () => {});
  slow.end();
  assert.equal(await signalled, true);
});

test('运行时：设置密码、登录、读写账本，重启后数据还在，停止时干净退出', async () => {
  const data = join(root, 'ledger');
  let run = await start(data, { SETUP_TOKEN: 'fictional-token', TZ: 'Asia/Shanghai' });
  assert.match(run.log(), /fictional-token/);
  const status = JSON.parse((await send(run.port, { path: '/api/auth/status' })).text());
  assert.equal(status.needsSetup, true);

  const setup = await json(run.port, '/api/auth/setup', { setupToken: 'fictional-token', password: 'fictional-password-1' });
  assert.equal(setup.status, 200, setup.text());
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  assert.match(cookie, /^sid=/);
  assert.equal((await send(run.port, { path: '/api/state' })).status, 401, '没有登录不能读账本');

  const state = await send(run.port, { path: '/api/state', headers: { cookie } });
  assert.equal(state.status, 200, state.text());
  const { rev } = JSON.parse(state.text());
  const backup = JSON.parse((await send(run.port, { path: '/api/backup', headers: { cookie } })).text());
  backup.subscriptions = [
    {
      id: 'fictional-sub',
      name: '虚构订阅',
      category: '虚构',
      tags: [],
      price: 10,
      currency: 'USD',
      cycle: { unit: 'month', every: 1 },
      start: '2026-01-31',
      status: 'active',
      icon: '📅',
      payments: [],
    },
  ];
  const restored = await json(run.port, '/api/backup', backup, { cookie });
  assert.equal(restored.status, 200, restored.text());
  assert.ok(JSON.parse(restored.text()).state.rev > rev);

  const code = await stop(run);
  assert.equal(code, 0, run.log());
  assert.ok(existsSync(join(data, DB_NAME)), '数据文件要留在与旧版相同的位置');
  run = await start(data, { SETUP_TOKEN: 'fictional-token' });
  const after = JSON.parse((await send(run.port, { path: '/api/state', headers: { cookie } })).text());
  assert.deepEqual(
    after.subscriptions.map((s) => s.name),
    ['虚构订阅'],
  );
  assert.equal(await stop(run), 0);
});

test('运行时：静态资源的缓存、压缩与单页回退', async () => {
  const run = await start(join(root, 'assets-data'), { SETUP_TOKEN: 'fictional-token' });
  const asset = await send(run.port, { path: '/assets/app-abc123.js', headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(asset.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(asset.raw).toString(), /^console\.log\(1\);/);
  assert.equal((await send(run.port, { path: '/assets/app-abc123.js' })).headers['content-encoding'], undefined);

  const page = await send(run.port, { path: '/overview' });
  assert.equal(page.status, 200);
  assert.match(page.text(), /<title>calends/);
  assert.equal(page.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal((await send(run.port, { path: '/overview', headers: { 'if-none-match': page.headers.etag } })).status, 304);
  assert.match((await send(run.port, { path: '/../../etc/passwd' })).text(), /<title>calends/, '路径穿越只能落到单页回退');
  const head = await send(run.port, { path: '/manifest.webmanifest', method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.raw.length, 0);
  const cdn = await send(run.port, { path: '/cdn-cgi/local/scheduled?cron=x', headers: { host: 'localhost' } });
  assert.match(cdn.text(), /<title>calends/, '没有 Miniflare 之后，外部不存在触发定时任务的入口');
  assert.equal(await stop(run), 0);
});

test('运行时：WASM 资源使用正确类型，可直接流式实例化', async () => {
  const run = await start(join(root, 'wasm-data'), { SETUP_TOKEN: 'fictional-token' });
  try {
    const response = await fetch(`http://127.0.0.1:${run.port}/assets/sql-abc123.wasm`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/wasm');
    const { instance } = await WebAssembly.instantiateStreaming(response);
    assert.ok(instance instanceof WebAssembly.Instance);
  } finally {
    await stop(run);
  }
});

test('运行时：BASE_PATH 的写法不规范也能启动', async () => {
  for (const base of ['calends', '/calends/']) {
    const run = await start(join(root, `base-${base.replaceAll('/', '')}`), { SETUP_TOKEN: 'fictional-token', BASE_PATH: base });
    assert.equal(run.child.exitCode, null, run.log());
    assert.equal((await send(run.port, { path: '/calends/api/auth/status' })).status, 200);
    assert.match(run.log(), /open \/calends\/ in/);
    await stop(run);
  }
});

test('运行时：令牌文件还在而数据库不见了，拒绝启动', async () => {
  const data = join(root, 'moved');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'setup-token'), 'fictional-token\n');
  const run = await start(data, { SETUP_TOKEN: 'fictional-token' });
  assert.equal(await run.exited, 1);
  assert.match(run.log(), /refusing to start/);
  assert.equal(existsSync(join(data, DB_NAME)), false);
});

test('运行时：目录里有别的账本时拒绝启动，不新建空账本', async () => {
  const data = join(root, 'stray');
  const dir = join(data, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  mkdirSync(dir, { recursive: true });
  new DatabaseSync(join(dir, 'other.sqlite')).close();
  const run = await start(data, { SETUP_TOKEN: 'fictional-token' });
  assert.equal(await run.exited, 1);
  assert.match(run.log(), /refusing to start/);
  assert.equal(existsSync(join(data, DB_NAME)), false);
});

test('镜像：不再依赖 wrangler，探活不新起 Node，堆有上限', () => {
  const file = readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(file, /wrangler|npm install/);
  assert.match(file, /--max-old-space-size=/);
  assert.match(file, /HEALTHCHECK .*CMD bash -c .*\/healthz/);
  assert.match(readFileSync(new URL('../docker/docker-compose.yml', import.meta.url), 'utf8'), /mem_limit:/);
});

test('压缩包：目录与镜像相同，解压后不靠环境变量就能找到前端', async () => {
  const repo = join(root, 'tarball-repo');
  mkdirSync(join(repo, 'build', 'docker'), { recursive: true });
  mkdirSync(join(repo, 'docker'));
  cpSync(dist, join(repo, 'dist'), { recursive: true });
  cpSync(bundle, join(repo, 'build', 'docker', 'entrypoint.mjs'));
  for (const f of ['docker/calends.service', 'LICENSE']) cpSync(new URL(`../${f}`, import.meta.url), join(repo, f));
  writeFileSync(join(repo, 'package.json'), '{"version":"9.8.0"}');

  const packer = fileURLToPath(new URL('./package-tarball.mjs', import.meta.url));
  const pack = (env = {}) => spawnSync(process.execPath, [packer, repo], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  mkdirSync(join(repo, 'local'));
  assert.notEqual(pack().status, 0, '有个人配置的目录不能打包');
  rmSync(join(repo, 'local'), { recursive: true });
  assert.notEqual(pack({ BASE_PATH: '/calends' }).status, 0, '子路径构建不能打包');
  assert.notEqual(pack({ CALENDS_LOCAL: '../personal' }).status, 0, '个人部署不能打包');
  const packed = pack();
  assert.equal(packed.status, 0, packed.stderr);

  const out = join(repo, 'build', 'release');
  assert.match(readFileSync(join(out, 'calends-9.8.0.tar.gz.sha256'), 'utf8'), /^[0-9a-f]{64} {2}calends-9\.8\.0\.tar\.gz\n$/);
  const extracted = join(root, 'tarball-out');
  mkdirSync(extracted);
  assert.equal(spawnSync('tar', ['-xzf', join(out, 'calends-9.8.0.tar.gz'), '-C', extracted, '--strip-components=1']).status, 0);
  assert.deepEqual(readdirSync(extracted).sort(), ['LICENSE', 'calends.service', 'dist', 'docker']);
  assert.deepEqual(readdirSync(join(extracted, 'docker')), ['entrypoint.mjs']);

  const data = join(root, 'tarball-data');
  const run = await start(data, { ASSETS_DIR: undefined, SETUP_TOKEN: 'fictional-token' }, join(extracted, 'docker', 'entrypoint.mjs'));
  assert.equal((await send(run.port, { path: '/manifest.webmanifest' })).text(), '{"name":"calends"}');
  assert.ok(existsSync(join(data, DB_NAME)));
  assert.equal(await stop(run), 0);
});

test('systemd 配置：数据目录、堆上限与内存上限和镜像一致', () => {
  const unit = readFileSync(new URL('../docker/calends.service', import.meta.url), 'utf8');
  const heap = /--max-old-space-size=\d+/.exec(readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8'))[0];
  assert.match(unit, new RegExp(`${heap} `));
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node \/opt\/calends\/docker\/entrypoint\.mjs$/m);
  assert.match(unit, /^DynamicUser=yes$/m);
  const limit = /mem_limit: (\d+)m/.exec(readFileSync(new URL('../docker/docker-compose.yml', import.meta.url), 'utf8'))[1];
  assert.match(unit, new RegExp(`^MemoryMax=${limit}M$`, 'm'));
  assert.match(unit, /^StateDirectory=calends$/m);
  assert.match(unit, /^Environment=DATA_DIR=\/var\/lib\/calends$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/calends\.env$/m);
});

test('HOST：反向代理后可以只监听本机', async (t) => {
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((n) => n.family === 'IPv4' && !n.internal)?.address;
  if (!outside) return t.skip('本机没有外部网卡');
  const data = join(root, 'host-data');
  const run = await start(data, { HOST: '127.0.0.1', SETUP_TOKEN: 'fictional-token' });
  assert.equal((await send(run.port, { path: '/healthz' })).status, 200);
  await assert.rejects(
    new Promise((resolve, reject) => request({ host: outside, port: run.port, path: '/healthz' }, resolve).on('error', reject).end()),
    /ECONNREFUSED/,
  );
  await stop(run);
});

test('访客 IP：不用配置，按连接方和 X-Forwarded-For 判断', () => {
  const auto = proxyTrust(undefined);
  const ip = (peer, forwarded, headers = {}, trust = auto) =>
    clientIp({ headers: { 'x-forwarded-for': forwarded, ...headers }, socket: { remoteAddress: peer } }, trust);
  // 公网直连：头不算数
  assert.equal(ip('198.51.100.7', '6.6.6.6'), '198.51.100.7');
  assert.equal(ip('::ffff:198.51.100.7', '6.6.6.6'), '198.51.100.7');
  // 本机或内网的代理（Nginx、Caddy、Traefik、cloudflared）：真实地址在最右边，左边是客户端写的
  assert.equal(ip('127.0.0.1', '203.0.113.9'), '203.0.113.9');
  assert.equal(ip('::ffff:172.18.0.1', '6.6.6.6, 203.0.113.9'), '203.0.113.9');
  assert.equal(ip('::1', '6.6.6.6, 2001:db8::1'), '2001:db8::1');
  // 两层本地代理：cloudflared → Nginx → Calends
  assert.equal(ip('127.0.0.1', '6.6.6.6, 203.0.113.9, 127.0.0.1'), '203.0.113.9');
  // Cloudflare CDN → Nginx，或 CDN 直连
  assert.equal(ip('127.0.0.1', '6.6.6.6, 203.0.113.9, 104.16.0.1'), '203.0.113.9');
  assert.equal(ip('162.158.0.1', '6.6.6.6, 203.0.113.9'), '203.0.113.9');
  assert.equal(ip('127.0.0.1', '2001:db8::1, 2606:4700::1'), '2001:db8::1');
  // Cloudflare Worker 发来的请求，头是写脚本的人定的，停在边缘地址
  assert.equal(ip('162.158.0.1', '6.6.6.6', { 'cf-worker': 'evil.example' }), '162.158.0.1');
  assert.equal(ip('127.0.0.1', '6.6.6.6, 162.158.0.1', { 'cf-worker': 'evil.example' }), '162.158.0.1');
  // 没有头、全是内网、夹着不是 IP 的项
  assert.equal(ip('127.0.0.1', undefined), '127.0.0.1');
  assert.equal(ip('127.0.0.1', '192.168.1.5'), '192.168.1.5');
  assert.equal(ip('127.0.0.1', '6.6.6.6, 192.168.1.5, 10.0.0.2'), '6.6.6.6', '跳过内网地址后的第一个公网地址');
  assert.equal(ip('127.0.0.1', '<b>not-ip</b>'), '127.0.0.1');
  assert.equal(ip('127.0.0.1', '6.6.6.6, 1.2.3.4:999'), '127.0.0.1');
  assert.equal(ip('127.0.0.1', '6.6.6.6,'), '127.0.0.1');
  assert.equal(ip('10.0.0.1', '6.6.6.6, <b>x</b>, 192.168.1.5'), '192.168.1.5');
  assert.equal(ip('fe80::1%eth0', '203.0.113.9'), '203.0.113.9');
});

test('TRUST_PROXY：留空和旧的层数都是自动，可以关闭或追加其他 CDN', () => {
  const ip = (trust, peer, forwarded) => clientIp({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } }, trust);
  for (const v of [undefined, '', '1', '2', 'auto', 'true']) {
    assert.equal(ip(proxyTrust(v), '127.0.0.1', '6.6.6.6, 203.0.113.9'), '203.0.113.9', String(v));
    assert.equal(ip(proxyTrust(v), '198.51.100.7', '6.6.6.6'), '198.51.100.7', String(v));
  }
  for (const v of ['off', 'false', 'OFF', '0']) assert.equal(proxyTrust(v), null, v);
  assert.equal(ip(null, '127.0.0.1', '203.0.113.9'), '127.0.0.1');
  const custom = proxyTrust('198.18.0.0/15, 2001:db8:aa::1');
  assert.equal(ip(custom, '127.0.0.1', '203.0.113.9, 198.18.0.1'), '203.0.113.9');
  assert.equal(ip(custom, '2001:db8:aa::1', '203.0.113.9'), '203.0.113.9');
  assert.equal(ip(custom, '127.0.0.1', '203.0.113.9, 198.20.0.1'), '198.20.0.1');
  const bad = [];
  const partial = proxyTrust('nonsense, 198.18.0.0/99, 198.18.0.1/x, 198.18.0.1/1/1, 192.0.2.0/24', (item) => bad.push(item));
  assert.deepEqual(bad, ['nonsense', '198.18.0.0/99', '198.18.0.1/x', '198.18.0.1/1/1']);
  assert.equal(ip(partial, '127.0.0.1', '203.0.113.9, 192.0.2.1'), '203.0.113.9');
});

test('运行时：换着伪造 X-Forwarded-For 绕不过登录限速，别的访客不受影响', async () => {
  const run = await start(join(root, 'spoof-data'), { SETUP_TOKEN: 'fictional-token' });
  assert.equal((await json(run.port, '/api/auth/setup', { setupToken: 'fictional-token', password: 'fictional-password-1' })).status, 200);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await json(run.port, '/api/login', { password: `wrong-${i}` }, { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9` });
    statuses.push(res.status);
  }
  assert.equal(statuses.at(-1), 429, statuses.join());
  assert.equal((await json(run.port, '/api/login', { password: 'fictional-password-1' }, { 'x-forwarded-for': '203.0.113.10' })).status, 200);
  await stop(run);
});

test('访客 IP：Caddy 把 XFF 换成 Cloudflare 边缘地址时，用边缘写的访客地址；非边缘的同名头不可信', () => {
  const trust = proxyTrust('', () => {});
  const peer = (ip, headers) => ({ socket: { remoteAddress: ip }, headers });
  const viaCaddy = { 'x-forwarded-for': '104.16.0.1', 'cf-connecting-ip': '203.0.113.9' };
  assert.equal(clientIp(peer('127.0.0.1', viaCaddy), trust), '203.0.113.9');
  assert.equal(clientIp(peer('127.0.0.1', { 'x-forwarded-for': '203.0.113.5', 'cf-connecting-ip': '198.51.100.1' }), trust), '203.0.113.5');
  assert.equal(clientIp(peer('203.0.113.5', { 'cf-connecting-ip': '198.51.100.1' }), trust), '203.0.113.5');
  assert.equal(clientIp(peer('127.0.0.1', { ...viaCaddy, 'cf-worker': 'evil.example' }), trust), '104.16.0.1');
});

// 容器入口：单个 Node 进程内打开数据库并迁移 → 准备初始化令牌 → 对外提供 Worker → 每 15 分钟触发一次定时任务（提醒；整点另做汇率维护）。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.ts';
import { normalizeBasePath } from '../shared/base.ts';
import { ensureMigrated } from '../worker/migrate.ts';
import { createAssets } from './assets.mjs';
import { openD1 } from './d1.mjs';
import { createFront, proxyHops } from './front.mjs';

// Cloudflare 上的 Worker 永远是 UTC；账务日期不能随容器的 TZ 变化
process.env.TZ = 'UTC';

const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.DATA_DIR || '/data';
const BASE = normalizeBasePath(process.env.BASE_PATH);
const log = (...a) => console.log('[calends]', ...a);

// 数据文件沿用早期版本（wrangler 本地模式）的位置和文件名：升级无需迁移数据，换回旧镜像也能读
const DB_DIR = join(DATA, 'v3', 'd1', 'miniflare-D1DatabaseObject');
const DB_FILE = join(DB_DIR, '9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite');
mkdirSync(DB_DIR, { recursive: true });
// 目录里有别的账本却找不到约定的文件时停下，绝不能悄悄新建一个空账本
const others = readdirSync(DB_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
if (!existsSync(DB_FILE) && others.length) {
  console.error(`[calends] expected database ${DB_FILE} but found ${others.join(', ')}; refusing to start with an empty ledger`);
  process.exit(1);
}
// 令牌文件是数据库建好之后才写的：它在而数据库不在，说明账本被移走或卷挂错了
const tokenFile = join(DATA, 'setup-token');
if (!existsSync(DB_FILE) && existsSync(tokenFile)) {
  console.error(
    `[calends] ${tokenFile} exists but database ${DB_FILE} is missing; refusing to start with an empty ledger. Check the volume, or delete the token file to start over`,
  );
  process.exit(1);
}

// 1. 数据库与迁移（幂等）；失败就退出，不带着旧结构继续服务
const db = openD1(DB_FILE);

// 2. 初始化令牌：环境变量优先；否则首次启动时生成并保存在数据目录，设好密码后就用不到了
let setupToken = process.env.SETUP_TOKEN;
if (!setupToken) {
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
  setupToken = readFileSync(tokenFile, 'utf8').trim();
}

// 3. 传给 Worker 的绑定和变量
const assetsDir = process.env.ASSETS_DIR || fileURLToPath(new URL('../dist', import.meta.url));
const env = { DB: db, ASSETS: createAssets(assetsDir), SETUP_TOKEN: setupToken };
for (const k of ['SITE_URL', 'OWNER_PASSCODE', 'BASE_PATH']) if (process.env[k]) env[k] = process.env[k];

const pending = new Set();
const ctx = {
  waitUntil(p) {
    const task = Promise.resolve(p)
      .catch((e) => console.error('[calends] background task failed:', e))
      .finally(() => pending.delete(task));
    pending.add(task);
  },
  passThroughOnException() {},
};
// 与 workerd 一样，后台任务的漏网错误只记录，不带垮整个账本服务
process.on('unhandledRejection', (e) => console.error('[calends] unhandled rejection:', e));

await ensureMigrated(env);

// 4. 对外提供服务；还没设密码时把初始化令牌打在日志里
const statusUrl = `http://127.0.0.1:${PORT}${BASE}/api/auth/status`;
const status = await (await worker.fetch(new Request(statusUrl), env, ctx)).json();
const server = createFront({
  handle: (req) => worker.fetch(req, env, ctx),
  healthy: () => Boolean(db.ping()),
  trustedHops: proxyHops(process.env.TRUST_PROXY),
}).listen(PORT, process.env.HOST || '0.0.0.0');
log(`listening on port ${PORT} — open ${BASE}/ in your browser`);
if (status.needsSetup) {
  log(`first run: create your password at ${BASE}/ with this setup token:`);
  log(`    ${setupToken}`);
  log(`(also saved in ${tokenFile}; you can set SETUP_TOKEN yourself instead)`);
}

// 5. 定时任务：每 15 分钟触发一次（与 Cloudflare 上的配置一致）
const CRON = '*/15 * * * *';
let timer;
let stopping = false;
function scheduleNext() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes((Math.floor(now.getUTCMinutes() / 15) + 1) * 15, 0, 0);
  timer = setTimeout(async () => {
    // 算进后台任务：停止时尽量等它发完，否则提醒已送达却记成发送中，下一轮会重复发
    const run = Promise.resolve()
      .then(() => worker.scheduled({ cron: CRON, scheduledTime: next.getTime(), noRetry() {} }, env, ctx))
      .catch((e) => log('scheduled run failed:', e));
    ctx.waitUntil(run);
    await run;
    if (!stopping) scheduleNext();
  }, next - now);
}
scheduleNext();

// 6. 停止时等手头的请求和后台任务收尾，再关库让 WAL 落盘
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections();
    setTimeout(resolve, 5000).unref();
  });
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 3000))]);
  db.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

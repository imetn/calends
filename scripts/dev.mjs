// 本地开发：同时启动 wrangler（Worker + 本地 D1，:8787）与 Vite（热更新，:5173）
// 用法：npm run dev，然后打开 http://127.0.0.1:5173；Vite 只监听本机；Tailscale 设备经 tailscale serve 转发访问 https://<机器名>.ts.net:5173（serve 自己占用 Tailscale 地址的 5173，监听所有网卡会端口冲突）
// wrangler 热重载后偶尔进程还在、8787 却不再监听，页面因接口 502 显示离线；或端口在听、请求挂住；这里定时发请求探测，连续失败就重启 Worker
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const WORKER_PORT = 8787;
const CHECK_MS = 5000;
const FAILS_TO_RESTART = 3;
const STARTUP_GRACE_MS = 60_000;

let stopping = false;
const procs = new Map();

function run(name, color, cmd, args, onExit) {
  // 独立进程组：停止时连同 npx/wrangler 拉起的 workerd 一起结束，不留孤儿进程占端口
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code, signal) => {
    if (procs.get(name) === p) procs.delete(name);
    console.log(`${tag}exited ${code ?? signal}`);
    if (!stopping) onExit(p);
  });
  procs.set(name, p);
  return p;
}

function killGroup(p, signal = 'SIGTERM') {
  try {
    process.kill(-p.pid, signal);
  } catch {}
}

function shutdown() {
  stopping = true;
  for (const p of procs.values()) killGroup(p);
  setTimeout(() => {
    for (const p of procs.values()) killGroup(p, 'SIGKILL');
    process.exit(0);
  }, 3000).unref();
  if (!procs.size) process.exit(0);
  for (const p of procs.values()) p.on('exit', () => procs.size || process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** 任意 HTTP 响应都算存活；只看端口不够，wrangler 重拉运行时后可能端口在听、请求却永远挂住 */
async function workerAlive() {
  try {
    await fetch(`http://127.0.0.1:${WORKER_PORT}/api/rev`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

let workerStarted = 0;
let fails = 0;
let restarting = false;

function startWorker() {
  workerStarted = Date.now();
  fails = 0;
  run('worker', '35', 'node', ['scripts/wrangler.mjs', 'dev', '--port', String(WORKER_PORT), '--local'], () => {
    // Worker 意外退出也重启，Vite 继续提供页面
    if (!restarting) setTimeout(startWorker, 3000);
  });
}

function restartWorker(reason) {
  if (restarting) return;
  restarting = true;
  console.log(`\x1b[33m[dev]\x1b[0m ${reason}，重启 Worker`);
  const old = procs.get('worker');
  const done = () => {
    restarting = false;
    if (!stopping) startWorker();
  };
  if (!old) return done();
  const force = setTimeout(() => killGroup(old, 'SIGKILL'), 5000);
  old.once('exit', () => (clearTimeout(force), done()));
  killGroup(old);
}

async function checkWorker() {
  if (stopping || restarting || !procs.has('worker')) return;
  if (await workerAlive()) {
    fails = 0;
    return;
  }
  if (Date.now() - workerStarted < STARTUP_GRACE_MS) return;
  if (++fails >= FAILS_TO_RESTART) restartWorker(`${WORKER_PORT} 端口连续 ${fails} 次请求无响应`);
}

// wrangler 需要 dist 目录存在（静态资源绑定），开发时页面由 Vite 提供
if (!existsSync('dist/index.html')) {
  const b = spawn('npx', ['vite', 'build', 'app'], { stdio: 'inherit' });
  await new Promise((r) => b.on('exit', r));
}
startWorker();
run('vite', '36', 'npx', ['vite', 'app', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], shutdown);
setInterval(checkWorker, CHECK_MS);

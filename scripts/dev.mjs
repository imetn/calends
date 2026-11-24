// 本地开发：同时启动 wrangler（Worker + 本地 D1，:8787）与 Vite（热更新，:5173）
// 用法：npm run dev，然后打开 http://127.0.0.1:5173；Vite 监听所有网卡，Tailscale 等内网设备可用本机 IP 或 *.ts.net 访问
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const procs = [];
function run(name, color, cmd, args) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    console.log(`${tag}exited ${code}`);
    shutdown();
  });
  procs.push(p);
}
function shutdown() {
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// wrangler 需要 dist 目录存在（静态资源绑定），开发时页面由 Vite 提供
if (!existsSync('dist/index.html')) {
  const b = spawn('npx', ['vite', 'build', 'app'], { stdio: 'inherit' });
  await new Promise((r) => b.on('exit', r));
}
run('worker', '35', 'node', ['scripts/wrangler.mjs', 'dev', '--port', '8787', '--local']);
run('vite', '36', 'npx', ['vite', 'app', '--host', '0.0.0.0', '--port', '5173', '--strictPort']);

import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { normalizeBasePath, stripBase, withBase } from '../shared/base.ts';
import { resolveLocalDir } from '../scripts/local-config.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BASE_PATH = normalizeBasePath(process.env.BASE_PATH);
const assetPath = (path: string) => withBase(path, BASE_PATH);

// 前端工程在 app/，构建产物在仓库根目录，个人配置可由 CALENDS_LOCAL 指向仓库外
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
const LOCAL_PUBLIC = join(resolveLocalDir(process.env, ROOT), 'public');
const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function manifest(source: string): string {
  const data = JSON.parse(source);
  data.start_url = assetPath(data.start_url);
  data.scope = assetPath(data.scope);
  for (const icon of data.icons ?? []) icon.src = assetPath(icon.src);
  for (const shortcut of data.shortcuts ?? []) shortcut.url = assetPath(shortcut.url);
  return JSON.stringify(data, null, 2) + '\n';
}

function baseManifest(): Plugin {
  return {
    name: 'base-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (stripBase((req.url ?? '').split('?')[0], BASE_PATH) !== '/manifest.webmanifest') return next();
        const local = join(LOCAL_PUBLIC, 'manifest.webmanifest');
        res.setHeader('content-type', 'application/manifest+json');
        res.end(manifest(readFileSync(existsSync(local) ? local : join(APP, 'public/manifest.webmanifest'), 'utf8')));
      });
    },
    closeBundle: {
      order: 'post',
      handler() {
        const file = join(DIST, 'manifest.webmanifest');
        writeFileSync(file, manifest(readFileSync(file, 'utf8')));
      },
    },
  };
}

/** 个人配置目录的 public/ 覆盖 app/public 里的同名文件：开发时优先提供，构建后复制进 dist */
function localPublic(): Plugin {
  return {
    name: 'local-public',
    configureServer(server) {
      if (!existsSync(LOCAL_PUBLIC)) return;
      server.middlewares.use((req, res, next) => {
        const path = stripBase(decodeURIComponent((req.url ?? '').split('?')[0]), BASE_PATH);
        const file = join(LOCAL_PUBLIC, path);
        if (!file.startsWith(LOCAL_PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (existsSync(LOCAL_PUBLIC)) cpSync(LOCAL_PUBLIC, DIST, { recursive: true });
    },
  };
}

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  root: APP,
  cacheDir: process.env.VITE_CACHE_DIR || join(ROOT, 'node_modules/.vite'),
  base: `${BASE_PATH}/`,
  // 页脚等处显示的版本号
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  // React 19 + React Compiler（Rust 版，自动做组件记忆化）
  plugins: [react({ compiler: true }), tailwindcss(), baseManifest(), localPublic()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // 公开页是动态加载的入口：它的依赖若在开发中途才被发现再预构建，会生成第二份 React，打开 /public 报 Invalid hook call。
  // 首轮就和 React 一起预构建，保证只有一份
  optimizeDeps: {
    include: ['radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge', 'motion/react', 'number-flow', 'recharts', 'matter-js'],
  },
  server: {
    // 允许 Tailscale MagicDNS 域名访问开发服务器（IP 访问 Vite 本身就放行）
    allowedHosts: ['.ts.net'],
    // 本地开发：wrangler dev 跑在 8787；按前缀匹配，/cal/ 要带斜杠，否则 /calendar 页面也会被转发
    proxy: Object.fromEntries(['/api/', '/cal/', '/mcp'].map((path) => [assetPath(path), process.env.VITE_WORKER_ORIGIN || 'http://127.0.0.1:8787'])),
  },
  build: { outDir: DIST, emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});

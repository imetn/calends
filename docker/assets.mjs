// 容器内的静态资源：启动时登记 dist 里的文件，只按登记表取文件（路径穿越无从发生），没有的路径回退到 index.html（与 wrangler 配置的单页应用模式一致）。
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

export function createAssets(dir) {
  const files = new Map();
  for (const name of readdirSync(dir, { recursive: true })) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    files.set(`/${relative(dir, file).split(sep).join('/')}`, { file, size: stat.size, etag: `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"` });
  }
  const index = files.get('/index.html');
  if (!index) throw new Error(`no index.html in ${dir}`);

  return {
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      if (pathname === '/index.html') return new Response(null, { status: 307, headers: { location: '/' } });
      const hit = files.get(pathname);
      const entry = hit ?? index;
      const headers = {
        'content-type': hit ? (TYPES[extname(pathname).toLowerCase()] ?? 'application/octet-stream') : TYPES['.html'],
        // /assets/ 下的文件名带内容哈希，内容变了地址就变；其余文件每次回源校验
        'cache-control': hit && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
        etag: entry.etag,
      };
      if (req.headers.get('if-none-match') === entry.etag) return new Response(null, { status: 304, headers });
      headers['content-length'] = String(entry.size);
      return new Response(req.method === 'HEAD' ? null : Readable.toWeb(createReadStream(entry.file)), { headers });
    },
  };
}

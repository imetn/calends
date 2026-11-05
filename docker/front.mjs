// 容器对外的 HTTP 层：把 Node 请求转成 Worker 的 Request，把 Response 写回去，并补上 Cloudflare 平台在 Worker 之外做的事。
// - 访客 IP 按真实连接（设了 TRUST_PROXY 时从 X-Forwarded-For 右边数）写进 CF-Connecting-IP，客户端自带的同名头作废，避免伪造 IP 绕过登录限速。
// - 文本响应按 Accept-Encoding 压缩；请求体设上限，超大请求不能把进程内存撑爆。
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** 备份、导入和助手对话是 Worker 先鉴权、后读请求体，才放得开；各档上限见下 */
export const maxBodyFor = (pathname) => {
  // 恢复要在堆里解析整份账本：实测 192MB 堆下 20MB 能完成、29MB 会崩，超限宁可 413
  // 助手对话可带 8 张压缩后的图片，单条就可能超过 4MB
  if (/\/api\/(backup|import|assistant\/chat)$/.test(pathname)) return 20 * 1024 * 1024;
  // 登录类接口未鉴权就读请求体，放小才挡得住并发大包
  if (/\/api\/(login$|auth\/)/.test(pathname)) return 64 * 1024;
  return 4 * 1024 * 1024;
};
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;

/** TRUST_PROXY 是可信代理的层数；其他写法都当作不信任 */
export const proxyHops = (value) => (/^[1-9]$/.test(value ?? '') ? Number(value) : 0);

/**
 * 写给 Worker 的访客 IP。只有最右边那几项是可信代理写的，左边的都可能是客户端自带的，
 * 所以 N 层代理取右数第 N 项；项数不够说明请求没走完这些代理，退回真实连接，不是 IP 的值同样不用。
 */
export function clientIp(req, trustedHops) {
  if (trustedHops) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',');
    const ip = forwarded.at(-trustedHops)?.trim();
    if (forwarded.length >= trustedHops && isIP(ip)) return ip;
  }
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

/** 请求目标（/path?q 或绝对形式 http://host/path）加 Host 头得到完整地址；以 // 开头的仍当作路径，而不是另一个主机 */
export function requestUrl(req) {
  const raw = String(req.url || '/');
  const { pathname, search } = new URL(raw.startsWith('/') ? `http://front.invalid${raw}` : raw);
  return new URL(`http://${req.headers.host || 'localhost'}${pathname}${search}`);
}

function limitBody(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      done(seen > limit ? new Error('request body too large') : null, chunk);
    },
  });
}

/** Worker 没读完请求体就响应时接着读掉，连接才能复用，对方也来得及收到响应；最多再读 limit，超过就断开 */
function drain(req, limiter, limit) {
  req.unpipe(limiter);
  limiter.destroy();
  let left = limit;
  req.on('data', (chunk) => {
    left -= chunk.length;
    if (left < 0) req.destroy();
  });
  req.resume();
}

function toRequest(req, res, url, trustedHops, limit) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'cf-connecting-ip') continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  const ip = clientIp(req, trustedHops);
  if (ip) headers.set('cf-connecting-ip', ip);
  // 对方断开时通知 Worker，助手才会停止继续调用模型
  const aborter = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) aborter.abort();
  });
  const init = { method: req.method, headers, signal: aborter.signal };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const limiter = limitBody(limit);
    // 上传中途断开要让读取方报错，否则 Worker 会一直等下去；截断的请求体也绝不能当成完整数据
    req.once('close', () => {
      if (!req.complete) limiter.destroy(new Error('request aborted'));
    });
    res.once('finish', () => {
      if (!req.readableEnded) drain(req, limiter, limit);
    });
    init.body = Readable.toWeb(req.pipe(limiter));
    init.duplex = 'half';
  }
  return new Request(url, init);
}

const plain = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);

async function writeResponse(req, res, response) {
  const headers = new Headers(response.headers);
  const compress =
    response.body &&
    req.method !== 'HEAD' &&
    /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? '')) &&
    COMPRESSIBLE.test(headers.get('content-type') ?? '') &&
    !headers.has('content-encoding') &&
    !/no-transform/i.test(headers.get('cache-control') ?? '');
  if (compress) {
    headers.delete('content-length');
    headers.set('content-encoding', 'gzip');
    headers.append('vary', 'accept-encoding');
  }
  const cookies = headers.getSetCookie();
  headers.delete('set-cookie');
  res.writeHead(response.status, [...headers.entries(), ...cookies.map((c) => ['set-cookie', c])]);
  if (!response.body) return res.end();
  const source = Readable.fromWeb(response.body);
  await (compress ? pipeline(source, createGzip({ level: 6 }), res) : pipeline(source, res));
}

/** handle 是 Worker 的 fetch；healthy 只在进程内查一次数据库，健康检查因此不经过 Worker */
export function createFront({ handle, healthy, trustedHops = 0, maxBody = maxBodyFor }) {
  return createServer(async (req, res) => {
    if (req.url === '/healthz') {
      let ok = false;
      try {
        ok = healthy();
      } catch (e) {
        console.error('[calends] health check failed:', e);
      }
      return plain(res, ok ? 200 : 503, ok ? 'ok' : 'unavailable');
    }
    let request;
    try {
      const url = requestUrl(req);
      const limit = maxBody(url.pathname);
      if (Number(req.headers['content-length']) > limit) return plain(res, 413, 'payload too large');
      request = toRequest(req, res, url, trustedHops, limit);
    } catch {
      return plain(res, 400, 'bad request');
    }
    try {
      await writeResponse(req, res, await handle(request));
    } catch (e) {
      // 客户端中途断开是常态，不算错误
      if (e?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.destroyed) return;
      console.error('[calends] request failed:', e);
      if (res.headersSent) res.destroy();
      else plain(res, 500, 'server error');
    }
  });
}

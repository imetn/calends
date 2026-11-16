// WebDAV（坚果云、Nextcloud、群晖、InfiniCLOUD 等）的最小客户端：上传、列出、删除，Basic 认证。
// 文件夹不存在时逐级 MKCOL 后重传一次。

export interface DavConfig {
  /** 服务地址，含 WebDAV 根路径，不带末尾斜杠 */
  url: string;
  username: string;
  password: string;
}

export class DavError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const seg = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join('/');
const href = (c: DavConfig, path: string) => `${c.url}/${seg(path)}`;

async function send(c: DavConfig, method: string, url: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const auth = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${c.username}:${c.password}`)))}`;
  try {
    return await fetch(url, { method, body: init.body, headers: { authorization: auth, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new DavError(0, e instanceof Error ? e.message : String(e));
  }
}
const fail = (method: string, res: Response) => new DavError(res.status, `${method} ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);

/** 逐级建文件夹 */
async function makeFolders(c: DavConfig, folder: string): Promise<void> {
  const parts = folder.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    // 已存在的文件夹各家回 405、403、409 或 301 都有：不在这里判错，成败交给之后重传的 PUT
    await send(c, 'MKCOL', `${href(c, parts.slice(0, i).join('/'))}/`);
  }
}

export async function davPut(c: DavConfig, folder: string, name: string, body: string): Promise<void> {
  const url = href(c, `${folder}/${name}`);
  const put = () => send(c, 'PUT', url, { body, headers: { 'content-type': 'application/json' } });
  let res = await put();
  // 父文件夹不存在：规范是 409，也有回 404 的；Apache mod_dav、群晖回 403
  if ((res.status === 409 || res.status === 404 || res.status === 403) && folder) {
    await makeFolders(c, folder);
    res = await put();
  }
  if (!res.ok) throw fail('PUT', res);
}

export async function davDelete(c: DavConfig, folder: string, name: string): Promise<void> {
  const res = await send(c, 'DELETE', href(c, `${folder}/${name}`));
  if (!res.ok && res.status !== 404) throw fail('DELETE', res);
}

/** 文件夹下直接子项的文件名；文件夹不存在返回空 */
export async function davList(c: DavConfig, folder: string): Promise<string[]> {
  const dir = `${href(c, folder).replace(/\/$/, '')}/`;
  const res = await send(c, 'PROPFIND', dir, {
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw fail('PROPFIND', res);
  const xml = await res.text();
  // Depth 1 只返回文件夹本身和直接子项；跳过文件夹条目后剩下的都是直接子文件。
  // 不拿 href 的路径和填写的地址比对：反向代理改写路径、服务端不分大小写时会对不上。
  const names: string[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const h = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(m[1])?.[1];
    if (!h || /<(?:[\w-]+:)?collection\b/i.test(m[1])) continue;
    let path: string;
    try {
      path = decodeURIComponent(new URL(h.trim().replace(/&amp;/g, '&'), dir).pathname);
    } catch {
      continue;
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name) names.push(name);
  }
  return names;
}

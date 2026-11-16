// S3 兼容存储（AWS S3、Cloudflare R2、Backblaze B2、MinIO、RustFS、大多数 NAS）的最小客户端：
// 只用上传、列出、下载、删除四个操作，AWS Signature V4 签名，桶名放在路径里（各家都支持）。
// 地区由服务地址推断：R2 用 auto，AWS / B2 取地址里的地区，其余用 us-east-1（MinIO 等的默认值）。

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: string | Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** RFC 3986 编码：encodeURIComponent 之外再编码 !'()* */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function regionOf(endpoint: string): string {
  let host = '';
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return 'us-east-1';
  }
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'auto';
  const m = /(?:^|\.)s3[.-]([a-z0-9-]+)\.(?:amazonaws\.com|backblazeb2\.com)$/.exec(host);
  return m && m[1] !== 'external-1' ? m[1] : 'us-east-1';
}

/**
 * 给请求签名，返回要带上的请求头（含 Authorization）。headers 里给的头全部参与签名；host 取自地址。
 * 单独导出以便用 AWS 文档里的示例核对。
 */
export async function signS3(o: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const amzDate = (o.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...o.headers, host: o.url.host, 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const query = [...o.url.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [o.method, o.url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let key = await hmac(enc.encode(`AWS4${o.secretAccessKey}`), day);
  for (const part of [o.region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  delete headers.host;
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]) : undefined;
};

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 规范化服务地址：去掉末尾斜杠；只接受 http(s) */
export function normalizeEndpoint(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

async function request(c: S3Config, method: string, key: string, query: Record<string, string> = {}, body?: string): Promise<Response> {
  const path = key
    .split('/')
    .map((p) => rfc3986(p))
    .join('/');
  const url = new URL(`${c.endpoint}/${rfc3986(c.bucket)}${key ? `/${path}` : ''}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const bytes = body === undefined ? undefined : enc.encode(body);
  const headers = await signS3({
    method,
    url,
    headers: bytes ? { 'content-type': 'application/json' } : undefined,
    payloadHash: await sha256(bytes ?? ''),
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    region: regionOf(c.endpoint),
  });
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bytes, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new S3Error(0, 'NetworkError', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const xml = await res.text().catch(() => '');
    const code = tag(xml, 'Code') ?? `HTTP${res.status}`;
    throw new S3Error(res.status, code, `${res.status} ${code}${tag(xml, 'Message') ? `: ${tag(xml, 'Message')}` : ''}`);
  }
  return res;
}

export async function putObject(c: S3Config, key: string, body: string): Promise<void> {
  await request(c, 'PUT', key, {}, body);
}

export async function getObject(c: S3Config, key: string): Promise<string> {
  return (await request(c, 'GET', key)).text();
}

export async function deleteObject(c: S3Config, key: string): Promise<void> {
  await request(c, 'DELETE', key);
}

/** 列出某前缀下的全部对象（自动翻页） */
export async function listObjects(c: S3Config, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const q: Record<string, string> = { 'list-type': '2', prefix };
    if (token) q['continuation-token'] = token;
    const xml = await (await request(c, 'GET', '', q)).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(m[1], 'Key');
      if (key) out.push({ key, size: Number(tag(m[1], 'Size') ?? 0), lastModified: tag(m[1], 'LastModified') ?? '' });
    }
    token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    if (!token) break;
  }
  return out;
}

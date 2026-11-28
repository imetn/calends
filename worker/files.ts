// 文件中心的存储与接口。内容按 sha256 存在对象存储（Cloudflare 为 R2 绑定 FILES，Docker 为数据目录里的同接口实现），
// 元数据在 files 表。写入顺序：先写对象、再写元数据，失败最多留下无人引用的对象，由整点维护在 30 天后清理。
import {
  anchorError,
  cleanFileName,
  downloadName,
  FILE_MAX_BYTES,
  FILE_MIMES,
  FILES_LIMIT_MB,
  sniffMime,
  sniffPdfPages,
  THUMB_MAX_BYTES,
  validPages,
  type FileAnchor,
  type FileKind,
  type FileMeta,
  type FileMime,
  type FileOrphan,
} from '../shared/files.ts';
import { uid } from '../shared/billing.ts';
import type { Subscription } from '../shared/types.ts';
import { t } from '../shared/i18n.ts';
import type { Env } from './env.ts';
import { zipStream } from './zip.ts';
import { HttpError, readJson } from './http.ts';
import { loadSubs } from './store.ts';
import { randomToken, sha256 } from './auth.ts';

/** 无人引用的对象保留多久再删：恢复较早的备份后，只要内容还在，关联照常可用 */
const ORPHAN_GRACE_MS = 30 * 86_400_000;

interface FileRow {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  sub_id: string | null;
  kind: string | null;
  date: string | null;
  receipt_id: string | null;
  orphan: string | null;
  thumb: number;
  pages: number | null;
  created_at: string;
}

const blobKey = (sha: string) => `files/${sha}`;
const thumbKey = (sha: string) => `thumbs/${sha}`;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

const SHA = /^[a-f0-9]{64}$/;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export const filesEnabled = (env: Env) => !!env.FILES;

function bucket(env: Env): R2Bucket {
  if (!env.FILES) throw new HttpError(503, t('core.file.noStorage'));
  return env.FILES;
}

const limitBytes = (env: Env) => {
  const mb = Number(env.FILES_LIMIT_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : FILES_LIMIT_MB) * 1024 * 1024;
};

function toMeta(r: FileRow, dupReceipt = false): FileMeta {
  let orphan: FileOrphan | undefined;
  try {
    // 快照由 SQL 写入：订阅没有图标时 icon 为 null，去掉空字段
    orphan = r.orphan ? (Object.fromEntries(Object.entries(JSON.parse(r.orphan) as object).filter(([, v]) => v != null)) as unknown as FileOrphan) : undefined;
  } catch {
    orphan = undefined;
  }
  return {
    id: r.id,
    name: r.name,
    mime: r.mime as FileMime,
    size: r.size,
    ...(r.sub_id ? { subId: r.sub_id } : {}),
    ...(r.kind ? { kind: r.kind as FileKind } : {}),
    ...(r.date ? { date: r.date } : {}),
    ...(r.receipt_id ? { receiptId: r.receipt_id } : {}),
    ...(dupReceipt && r.kind === 'receipt' ? { dupReceipt: true } : {}),
    ...(orphan ? { orphan } : {}),
    ...(r.thumb ? { thumb: true } : {}),
    ...(r.pages != null ? { pages: r.pages } : {}),
    createdAt: r.created_at,
  };
}

/** 同一份文件内容（sha256）挂到多笔不同的收款记录时标出重复凭证，提醒核对 */
function dupReceiptShas(rows: readonly FileRow[]): Set<string> {
  const bySha = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.kind !== 'receipt' || !r.sub_id || !r.receipt_id) continue;
    const set = bySha.get(r.sha256) ?? new Set<string>();
    set.add(`${r.sub_id}:${r.receipt_id}`);
    bySha.set(r.sha256, set);
  }
  const dups = new Set<string>();
  for (const [sha, keys] of bySha) if (keys.size > 1) dups.add(sha);
  return dups;
}

async function isDupReceipt(env: Env, r: Pick<FileRow, 'sha256' | 'kind' | 'sub_id' | 'receipt_id'>): Promise<boolean> {
  if (r.kind !== 'receipt' || !r.sub_id || !r.receipt_id) return false;
  const hit = await env.DB.prepare(
    "SELECT 1 AS x FROM files WHERE sha256 = ?1 AND kind = 'receipt' AND sub_id IS NOT NULL AND receipt_id IS NOT NULL AND (sub_id != ?2 OR receipt_id != ?3) LIMIT 1",
  )
    .bind(r.sha256, r.sub_id, r.receipt_id)
    .first();
  return !!hit;
}

const SELECT = 'SELECT id, sha256, name, mime, size, sub_id, kind, date, receipt_id, orphan, thumb, pages, created_at FROM files';
/** 与 loadState 同一个 batch 读取，元数据和账本来自同一个快照 */
export const listFilesStmt = (env: Env) => env.DB.prepare(`${SELECT} ORDER BY created_at, id`);
export const rowsToFiles = (rows: FileRow[]) => {
  const dups = dupReceiptShas(rows);
  return rows.map((r) => toMeta(r, dups.has(r.sha256)));
};

async function getRow(env: Env, id: string): Promise<FileRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE id = ?1`).bind(id).first<FileRow>();
  if (!row) throw new HttpError(404, t('core.file.notFound'));
  return row;
}

/** 已用空间：同内容只算一份 */
async function usedBytes(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM (SELECT MAX(size) AS size FROM files GROUP BY sha256)').first<{
    used: number;
  }>();
  return row?.used ?? 0;
}

/** 查询参数里的挂法：sub 缺省为未关联；kind 缺省时带 receipt 按收款、带 date 按扣款、其余按资料 */
function anchorOf(q: URLSearchParams): FileAnchor {
  const subId = q.get('sub') || null;
  const date = q.get('date') || null;
  const receiptId = q.get('receipt') || null;
  const kind = (q.get('kind') || (subId ? (receiptId ? 'receipt' : date ? 'charge' : 'sub') : null)) as FileKind | null;
  return { subId, kind, date, receiptId };
}

async function checkAnchor(env: Env, a: FileAnchor): Promise<void> {
  const err = anchorError(a, a.subId ? await loadSubs(env) : []);
  if (err) throw new HttpError(400, err);
}

/** 读请求体并限长：声明超限直接拒绝，实际读到超限也拒绝 */
async function readBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get('content-length'));
  if (declared > max) throw new HttpError(413, t('core.file.tooLarge'));
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > max) throw new HttpError(413, t('core.file.tooLarge'));
  if (!body.byteLength) throw new HttpError(400, t('core.file.empty'));
  return body;
}

/** POST /api/files?sub=&kind=&date=：原始请求体，文件名在 X-File-Name（URL 编码） */
export async function uploadFile(req: Request, env: Env): Promise<FileMeta> {
  bucket(env);
  const anchor = anchorOf(new URL(req.url).searchParams);
  await checkAnchor(env, anchor);
  const body = await readBody(req, FILE_MAX_BYTES);
  return storeFile(env, body, headerName(req), anchor);
}

/** X-File-Name 里的原始文件名（URL 编码；编码不对时按原样） */
function headerName(req: Request): string {
  const raw = req.headers.get('x-file-name') ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 存一份文件：网页上传、MCP 上传与上传链接共用。按文件头认类型、按内容哈希去重、检查总量，再写元数据。
 * 挂法在这里再校验一次（调用方可能先校验过，但写入前订阅可能已被删除）。
 */
export async function storeFile(env: Env, body: Uint8Array<ArrayBuffer>, rawName: string, anchor: FileAnchor): Promise<FileMeta> {
  const store = bucket(env);
  if (!body.byteLength) throw new HttpError(400, t('core.file.empty'));
  if (body.byteLength > FILE_MAX_BYTES) throw new HttpError(413, t('core.file.tooLarge'));
  await checkAnchor(env, anchor);
  const mime = sniffMime(body);
  if (!mime) throw new HttpError(415, t('core.file.badType'));
  const sha = hex(await crypto.subtle.digest('SHA-256', body));
  const known = await env.DB.prepare('SELECT 1 AS x FROM files WHERE sha256 = ?1 LIMIT 1').bind(sha).first();
  if (!known && (await usedBytes(env)) + body.byteLength > limitBytes(env)) {
    throw new HttpError(413, t('core.file.full', { mb: Math.round(limitBytes(env) / 1024 / 1024) }));
  }
  // 已有元数据引用的对象不必重写；无人引用的旧对象可能正等着被清理，重写一次刷新它的时间
  if (!known || !(await store.head(blobKey(sha)))) await store.put(blobKey(sha), body, { httpMetadata: { contentType: mime } });
  const knownMeta = known
    ? await env.DB.prepare('SELECT MAX(thumb) AS t, MAX(pages) AS p FROM files WHERE sha256 = ?1').bind(sha).first<{ t: number; p: number | null }>()
    : null;
  const thumb = knownMeta?.t ?? 0;
  const pages = mime === 'application/pdf' ? (knownMeta?.p ?? sniffPdfPages(body) ?? null) : null;
  const row: FileRow = {
    id: uid(),
    sha256: sha,
    name: cleanFileName(rawName),
    mime,
    size: body.byteLength,
    sub_id: anchor.subId,
    kind: anchor.kind,
    date: anchor.kind === 'sub' ? null : anchor.date,
    receipt_id: anchor.kind === 'receipt' ? (anchor.receiptId ?? null) : null,
    orphan: null,
    thumb,
    pages,
    created_at: new Date().toISOString(),
  };
  // 上传期间订阅可能被删掉：订阅仍在才写入，否则文件会挂在不存在的订阅上、也没有来源快照
  const r = await env.DB.prepare(
    `INSERT INTO files (id, sha256, name, mime, size, sub_id, kind, date, receipt_id, orphan, thumb, pages, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12 WHERE ?6 IS NULL OR EXISTS (SELECT 1 FROM subscriptions WHERE id = ?6)`,
  )
    .bind(row.id, row.sha256, row.name, row.mime, row.size, row.sub_id, row.kind, row.date, row.receipt_id, row.thumb, row.pages, row.created_at)
    .run();
  if (!r.meta.changes) throw new HttpError(400, t('core.file.noSub'));
  return toMeta(row, await isDupReceipt(env, row));
}

/** POST /api/files/:id/thumb[?pages=N]：浏览器生成的小图，按内容哈希共用；PDF 可顺带写入准确页数 */
export async function uploadThumb(req: Request, env: Env, id: string): Promise<FileMeta> {
  const store = bucket(env);
  const row = await getRow(env, id);
  const body = await readBody(req, THUMB_MAX_BYTES);
  const mime = sniffMime(body);
  if (!mime || mime === 'application/pdf') throw new HttpError(415, t('core.file.badType'));
  const rawPages = new URL(req.url).searchParams.get('pages');
  const pages = row.mime === 'application/pdf' && rawPages != null ? (validPages(Number(rawPages)) ?? null) : null;
  await store.put(thumbKey(row.sha256), body, { httpMetadata: { contentType: mime } });
  if (pages != null) {
    await env.DB.prepare('UPDATE files SET thumb = 1, pages = ?2 WHERE sha256 = ?1').bind(row.sha256, pages).run();
    return toMeta({ ...row, thumb: 1, pages });
  }
  await env.DB.prepare('UPDATE files SET thumb = 1 WHERE sha256 = ?1 AND thumb = 0').bind(row.sha256).run();
  return toMeta({ ...row, thumb: 1 });
}

/** POST /api/files/:id/pages {pages}：浏览器端 pdf.js 解析已有 PDF 后补写页数，按内容哈希共用 */
export async function saveFilePages(req: Request, env: Env, id: string): Promise<FileMeta> {
  const row = await getRow(env, id);
  if (row.mime !== 'application/pdf') throw new HttpError(400, t('core.file.badType'));
  const b = (await readJson(req)) as { pages?: unknown };
  const pages = validPages(b.pages);
  if (pages == null) throw new HttpError(400, t('core.file.badType'));
  await env.DB.prepare('UPDATE files SET pages = ?2 WHERE sha256 = ?1').bind(row.sha256, pages).run();
  return toMeta({ ...row, pages });
}

/** 文件响应头：服务端判定的类型、禁止嗅探；图片再加 sandbox，PDF 交给浏览器自带阅读器 */
function fileHeaders(mime: string, disposition: string, immutable = false): Headers {
  const h = new Headers({
    'content-type': mime,
    'content-disposition': disposition,
    'x-content-type-options': 'nosniff',
    // 缩略图按内容哈希寻址，永不变化；原文件的下载名随订阅名变化，只短暂缓存
    'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=300',
    'referrer-policy': 'no-referrer',
  });
  if (mime !== 'application/pdf') h.set('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  return h;
}

/** RFC 6266：ASCII 回退名 + UTF-8 原名 */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** GET /api/files/:id[?download=1] 与 /thumb */
export async function readFile(env: Env, id: string, opts: { download?: boolean; thumb?: boolean }): Promise<Response> {
  const store = bucket(env);
  const row = await getRow(env, id);
  if (opts.thumb && !row.thumb) throw new HttpError(404, t('core.file.notFound'));
  const obj = await store.get(opts.thumb ? thumbKey(row.sha256) : blobKey(row.sha256));
  if (!obj) throw new HttpError(404, t('core.file.missing'));
  if (opts.thumb) return new Response(obj.body, { headers: fileHeaders(obj.httpMetadata?.contentType ?? 'image/webp', 'inline', true) });
  const [subs, files] = await Promise.all([loadSubs(env), listFilesStmt(env).all<FileRow>()]);
  const name = downloadName(toMeta(row), rowsToFiles(files.results), subs);
  return new Response(obj.body, { headers: fileHeaders(row.mime, disposition(opts.download ? 'attachment' : 'inline', name)) });
}

/** GET /api/files/zip?ids=a,b：选中的文件打成一个 ZIP（不压缩、边读边发），文件名同单个下载；内容缺失的跳过 */
export async function zipFiles(env: Env, ids: string[]): Promise<Response> {
  const store = bucket(env);
  const [subs, all] = await Promise.all([loadSubs(env), listFilesStmt(env).all<FileRow>()]);
  const metas = rowsToFiles(all.results);
  const want = new Set(ids);
  const rows = all.results.filter((r) => want.has(r.id));
  if (!rows.length) throw new HttpError(404, t('core.file.notFound'));
  async function* entries() {
    for (const r of rows) {
      const obj = await store.get(blobKey(r.sha256));
      if (obj) yield { name: downloadName(toMeta(r), metas, subs), body: obj.body as ReadableStream<Uint8Array> };
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(zipStream(entries()), {
    headers: { 'content-type': 'application/zip', 'content-disposition': disposition('attachment', `Calends-files-${stamp}.zip`), 'cache-control': 'no-store' },
  });
}

/** PATCH /api/files/:id {subId, kind, date, receiptId}：改关联或移回未关联；重新关联后不再标记来自已删除的订阅 */
export async function patchFile(req: Request, env: Env, id: string): Promise<FileMeta> {
  const b = (await readJson(req)) as { subId?: unknown; kind?: unknown; date?: unknown; receiptId?: unknown };
  const subId = str(b.subId);
  const receiptId = subId ? str(b.receiptId) : null;
  const kind = subId ? ((str(b.kind) ?? (receiptId ? 'receipt' : str(b.date) ? 'charge' : 'sub')) as FileKind) : null;
  const anchor: FileAnchor = { subId, kind, date: subId ? str(b.date) : null, receiptId: kind === 'receipt' ? receiptId : null };
  return relinkFile(env, id, anchor);
}

/** 改挂法（网页改关联与 MCP 共用）；subId 为 null 时移回未关联 */
export async function relinkFile(env: Env, id: string, anchor: FileAnchor): Promise<FileMeta> {
  const row = await getRow(env, id);
  await checkAnchor(env, anchor);
  const date = anchor.kind === 'sub' ? null : anchor.date;
  const receiptId = anchor.kind === 'receipt' ? (anchor.receiptId ?? null) : null;
  const r = await env.DB.prepare(
    'UPDATE files SET sub_id = ?2, kind = ?3, date = ?4, receipt_id = ?5, orphan = NULL WHERE id = ?1 AND (?2 IS NULL OR EXISTS (SELECT 1 FROM subscriptions WHERE id = ?2))',
  )
    .bind(id, anchor.subId, anchor.kind, date, receiptId)
    .run();
  if (!r.meta.changes) throw new HttpError(400, t('core.file.noSub'));
  const next: FileRow = { ...row, sub_id: anchor.subId, kind: anchor.kind, date, receipt_id: receiptId, orphan: null };
  return toMeta(next, await isDupReceipt(env, next));
}

/** 改原始文件名（MCP 用）：未关联的文件以它为显示名；已关联的显示名仍按订阅与那一项生成 */
export async function renameFile(env: Env, id: string, name: string): Promise<FileMeta> {
  const row = await getRow(env, id);
  const clean = cleanFileName(name);
  await env.DB.prepare('UPDATE files SET name = ?2 WHERE id = ?1').bind(id, clean).run();
  return toMeta({ ...row, name: clean });
}

/** 文件内容（MCP 读取用）：元数据与字节；内容缺失时报「文件缺失」 */
export async function fileBytes(env: Env, id: string): Promise<{ meta: FileMeta; body: Uint8Array }> {
  const store = bucket(env);
  const row = await getRow(env, id);
  const obj = await store.get(blobKey(row.sha256));
  if (!obj) throw new HttpError(404, t('core.file.missing'));
  return { meta: toMeta(row), body: new Uint8Array(await obj.arrayBuffer()) };
}

/** DELETE /api/files/:id：只删元数据，内容等清理 */
export async function deleteFile(env: Env, id: string): Promise<void> {
  await getRow(env, id);
  await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(id).run();
}

/**
 * 订阅被删除（或被恢复、替换导入覆盖）前：把挂在 keep 之外订阅上的文件转为未关联，并写下来源快照。
 * 与删除放在同一个 batch，且必须排在删除语句之前（快照要从还在的订阅记录里取）。
 */
export const orphanFilesStmt = (env: Env, removed: { ids: string[] } | { keep: string[] }) =>
  env.DB.prepare(
    `UPDATE files SET orphan = json_object(
         'name', json_extract(s.data, '$.name'),
         'kind', files.kind,
         'date', files.date,
         'receiptId', files.receipt_id,
         'scope', CASE
           WHEN files.kind = 'receipt' AND json_extract(s.data, '$.proxy') IS NOT NULL THEN 'proxy'
           WHEN files.kind = 'receipt' AND json_extract(s.data, '$.share') IS NOT NULL THEN 'carpool'
           ELSE NULL
         END
       ),
       sub_id = NULL, kind = NULL, date = NULL, receipt_id = NULL
     FROM subscriptions s
     WHERE files.sub_id = s.id AND s.id ${'ids' in removed ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify('ids' in removed ? removed.ids : removed.keep));

/** 备份里的文件：元数据加内容哈希；内容另放在「备份（含文件）」的 ZIP 里 */
export interface BackupFile extends FileMeta {
  sha256: string;
}

export async function exportFiles(env: Env): Promise<BackupFile[]> {
  const rows = (await listFilesStmt(env).all<FileRow>()).results;
  return rows.map((r) => {
    const { thumb: _thumb, dupReceipt: _dup, ...meta } = toMeta(r);
    return { ...meta, sha256: r.sha256 };
  });
}

/**
 * 备份里的文件元数据整理成要写入的行；备份没有 files（v3 及更早）时返回 undefined，保留现有文件。
 * 坏条目丢弃；关联的订阅不在备份里、或挂法不成立时转为未关联（带来源快照的保留快照）。
 */
export function backupFileRows(raw: unknown, subs: readonly Pick<Subscription, 'id' | 'name' | 'icon' | 'share' | 'proxy'>[]): FileRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const rows: FileRow[] = [];
  for (const x of raw as Partial<BackupFile>[]) {
    if (!x || typeof x !== 'object') continue;
    const id = str(x.id);
    const sha = str(x.sha256);
    if (!id || !/^[\w-]{1,64}$/.test(id) || seen.has(id) || !sha || !SHA.test(sha)) continue;
    if (!FILE_MIMES.includes(x.mime as FileMime) || !Number.isSafeInteger(x.size) || x.size! <= 0 || x.size! > FILE_MAX_BYTES) continue;
    seen.add(id);
    const kind = (str(x.kind) as FileKind | null) ?? null;
    const anchor: FileAnchor = { subId: str(x.subId), kind, date: str(x.date), receiptId: kind === 'receipt' ? str(x.receiptId) : null };
    const linked = anchor.subId != null && !anchorError(anchor, subs, { requireReceipt: false });
    const orphan = linked ? null : (x.orphan ?? null);
    const created = str(x.createdAt);
    rows.push({
      id,
      sha256: sha,
      name: cleanFileName(x.name),
      mime: x.mime!,
      size: x.size!,
      sub_id: linked ? anchor.subId : null,
      kind: linked ? anchor.kind : null,
      date: linked && anchor.kind !== 'sub' ? anchor.date : null,
      receipt_id: linked && anchor.kind === 'receipt' ? (anchor.receiptId ?? null) : null,
      orphan: orphan && typeof orphan === 'object' && typeof orphan.name === 'string' ? JSON.stringify(orphan) : null,
      thumb: 0,
      pages: x.mime === 'application/pdf' ? (validPages(x.pages) ?? null) : null,
      created_at: created && !Number.isNaN(Date.parse(created)) ? created : new Date().toISOString(),
    });
  }
  return rows;
}

/** 恢复时整表替换（与账本同一个事务） */
export const restoreFilesStmts = (env: Env, rows: FileRow[]) => [
  env.DB.prepare('DELETE FROM files'),
  ...rows.map((r) =>
    env.DB.prepare(
      'INSERT INTO files (id, sha256, name, mime, size, sub_id, kind, date, receipt_id, orphan, thumb, pages, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12)',
    ).bind(r.id, r.sha256, r.name, r.mime, r.size, r.sub_id, r.kind, r.date, r.receipt_id, r.orphan, r.pages, r.created_at),
  ),
];

/** GET /api/backup?files=1：备份 JSON + 全部文件内容（同内容只放一份），边读边发 */
export async function backupWithFiles(env: Env): Promise<Response> {
  const store = bucket(env);
  const { exportAll } = await import('./backup.ts');
  const b = await exportAll(env);
  const shas = [...new Set((b.files ?? []).map((f) => f.sha256))];
  const day = b.exportedAt.slice(0, 10);
  async function* entries() {
    yield { name: `calends-backup-${day}.json`, body: new TextEncoder().encode(JSON.stringify(b, null, 1)) };
    for (const sha of shas) {
      const obj = await store.get(blobKey(sha));
      if (obj) yield { name: `files/${sha}`, body: obj.body as ReadableStream<Uint8Array> };
    }
  }
  return new Response(zipStream(entries()), {
    headers: { 'content-type': 'application/zip', 'content-disposition': disposition('attachment', `calends-backup-${day}.zip`), 'cache-control': 'no-store' },
  });
}

/** PUT /api/files/blob/:sha：恢复「备份（含文件）」时补回内容；只收元数据里引用到、且哈希与类型对得上的 */
export async function putBlob(req: Request, env: Env, sha: string): Promise<{ stored: boolean }> {
  const store = bucket(env);
  if (!SHA.test(sha)) throw new HttpError(404, t('core.file.notFound'));
  const row = await env.DB.prepare('SELECT mime FROM files WHERE sha256 = ?1 LIMIT 1').bind(sha).first<{ mime: string }>();
  if (!row) throw new HttpError(404, t('core.file.notFound'));
  const body = await readBody(req, FILE_MAX_BYTES);
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== sha || sniffMime(body) !== row.mime) throw new HttpError(400, t('core.file.badType'));
  if (await store.head(blobKey(sha))) return { stored: false };
  await store.put(blobKey(sha), body, { httpMetadata: { contentType: row.mime } });
  return { stored: true };
}

/** 整点维护：删除无人引用且超过宽限期的对象 */
export async function sweepFiles(env: Env, now = Date.now()): Promise<number> {
  if (!env.FILES) return 0;
  await sweepTicketsStmt(env, now).run();
  const used = new Set((await env.DB.prepare('SELECT DISTINCT sha256 FROM files').all<{ sha256: string }>()).results.map((r) => r.sha256));
  let removed = 0;
  for (const prefix of ['files/', 'thumbs/']) {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
      const stale = page.objects.filter((o) => !used.has(o.key.slice(prefix.length)) && now - o.uploaded.getTime() > ORPHAN_GRACE_MS).map((o) => o.key);
      if (stale.length) await env.FILES.delete(stale);
      removed += stale.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return removed;
}

/**
 * 文件链接：给 MCP 客户端用的一次性上传地址与限时下载地址。令牌随机 32 字节，只存哈希，15 分钟过期；
 * 上传地址用一次即作废，下载地址在有效期内可重复取（客户端可能重试）。整点维护清掉过期的。
 */
const TICKET_TTL_MS = 15 * 60_000;
const ticketKey = async (token: string) => `file-ticket:${await sha256(token)}`;
type Ticket = { op: 'upload'; name: string | null; anchor: FileAnchor; exp: number } | { op: 'download'; id: string; exp: number };
type TicketInput = { op: 'upload'; name: string | null; anchor: FileAnchor } | { op: 'download'; id: string };

export async function createTicket(env: Env, input: TicketInput): Promise<{ url: string; expires_at: string }> {
  bucket(env);
  const token = randomToken(32);
  const exp = Date.now() + TICKET_TTL_MS;
  await env.DB.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, datetime('now'))")
    .bind(await ticketKey(token), JSON.stringify({ ...input, exp } satisfies Ticket))
    .run();
  const site = (env.SITE_URL ?? '').replace(/\/$/, '');
  return { url: `${site}/api/files/${input.op === 'upload' ? 'in' : 'out'}/${token}`, expires_at: new Date(exp).toISOString() };
}

async function readTicket(env: Env, token: string, op: Ticket['op']): Promise<{ key: string; ticket: Ticket }> {
  const key = await ticketKey(token);
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?1').bind(key).first<{ value: string }>();
  const ticket = row ? (JSON.parse(row.value) as Ticket) : undefined;
  if (!ticket || ticket.op !== op || ticket.exp < Date.now()) throw new HttpError(404, t('core.file.linkExpired'));
  return { key, ticket };
}

/** PUT|POST /api/files/in/:token：原始请求体；先认令牌再读内容，令牌只能用一次（同时到达的两次只有一次删得掉） */
export async function uploadByTicket(req: Request, env: Env, token: string): Promise<FileMeta> {
  bucket(env);
  const { key, ticket } = await readTicket(env, token, 'upload');
  if (ticket.op !== 'upload') throw new HttpError(404, t('core.file.linkExpired'));
  const body = await readBody(req, FILE_MAX_BYTES);
  const used = await env.DB.prepare('DELETE FROM kv WHERE key = ?1').bind(key).run();
  if (!used.meta.changes) throw new HttpError(404, t('core.file.linkExpired'));
  return storeFile(env, body, ticket.name ?? headerName(req), ticket.anchor);
}

/** GET /api/files/out/:token：有效期内取原文件（下载名同网页下载） */
export async function downloadByTicket(env: Env, token: string): Promise<Response> {
  const { ticket } = await readTicket(env, token, 'download');
  if (ticket.op !== 'download') throw new HttpError(404, t('core.file.linkExpired'));
  const res = await readFile(env, ticket.id, { download: true });
  res.headers.set('cache-control', 'no-store');
  return res;
}

/** 整点维护：删掉过期的文件链接 */
export const sweepTicketsStmt = (env: Env, now = Date.now()) =>
  env.DB.prepare("DELETE FROM kv WHERE key LIKE 'file-ticket:%' AND CAST(json_extract(value, '$.exp') AS INTEGER) < ?1").bind(now);

// 文件中心的浏览器端：上传（先在本地认类型、去掉照片里的位置信息）、生成缩略图（图片缩小、PDF 渲染首页）、改关联、删除。
// 服务端写入会让账本版本号前进，下一次同步自然拉回；这里先把结果放进本地状态，界面立即可见。
import { base } from './base.ts';
import { api, getState, patchState, upsertById } from './store.ts';
import { FILE_MAX_BYTES, isImage, sniffMime, type FileAnchor, type FileMeta, type FileMime } from '../../shared/files.ts';
import { locale, t } from '../../shared/i18n.ts';

/** 缩略图：长边 480px 的 WebP，放不下 64 KB 时降质量再试 */
const THUMB_EDGE = 480;
const THUMB_BYTES = 64 * 1024;

export const fileUrl = (f: Pick<FileMeta, 'id'>, opts: { download?: boolean } = {}) => base(`/api/files/${f.id}${opts.download ? '?download=1' : ''}`);
export const downloadHref = (f: Pick<FileMeta, 'id'>) => fileUrl(f, { download: true });
export const thumbUrl = (f: Pick<FileMeta, 'id'>) => base(`/api/files/${f.id}/thumb`);
export const zipUrl = (ids: string[]) => base(`/api/files/zip?ids=${ids.map(encodeURIComponent).join(',')}`);

/** 浏览器里先挡掉明显不收的文件，免得白传 */
export async function checkFile(file: File): Promise<{ mime: FileMime } | { error: string }> {
  if (file.size === 0) return { error: t('core.file.empty') };
  if (file.size > FILE_MAX_BYTES) return { error: t('core.file.tooLarge') };
  const mime = sniffMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  return mime ? { mime } : { error: t('core.file.badType') };
}

/** 图片长边上限：更大的照片在浏览器里缩小后再传 */
const MAX_EDGE = 2560;

/**
 * 上传前处理图片：JPEG 带 EXIF（可能有拍摄地点）时按方向摆正后重新编码，不再保留元数据；长边超过 2560px 的缩小。
 * 其余原样上传；PDF 不动
 */
async function prepare(file: File, mime: FileMime): Promise<Blob> {
  if (mime === 'application/pdf') return file;
  const exif = mime === 'image/jpeg' && (await hasExif(file));
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const edge = Math.max(bmp.width, bmp.height);
    if (!exif && edge <= MAX_EDGE) {
      bmp.close();
      return file;
    }
    const scale = Math.min(1, MAX_EDGE / edge);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    // 编不出同一种格式（个别浏览器不支持 WebP 编码）或只缩小却反而更大时，用原文件
    if (out.type !== mime || out.size === 0 || out.size > FILE_MAX_BYTES || (!exif && out.size >= file.size)) return file;
    return out;
  } catch {
    return file;
  }
}

/** 扫描 JPEG 段头，找 APP1 的 Exif 段（只看开头 64 KB） */
async function hasExif(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // 图像数据开始
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === 'Exif') return true;
    i += 2 + len;
  }
  return false;
}

async function toWebp(source: CanvasImageSource & { width: number; height: number }): Promise<Blob | undefined> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(source.width, source.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
  const ctx = canvas.getContext('2d')!;
  // PDF 页面与透明图片垫白底，缩略图和纸面一致
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.6, 0.4]) {
    const out = await canvas.convertToBlob({ type: 'image/webp', quality });
    // 不支持 WebP 编码的浏览器会退回 PNG，这时不传缩略图
    if (out.type !== 'image/webp') return undefined;
    if (out.size <= THUMB_BYTES) return out;
  }
  return undefined;
}

/** PDF 首页：按需加载 pdf.js，只在上传或补缩略图时用到 */
async function pdfFirstPage(file: Blob): Promise<Blob | undefined> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const unit = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (THUMB_EDGE * 1.5) / Math.max(unit.width, unit.height) });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    return await toWebp(canvas);
  } finally {
    void task.destroy();
  }
}

export async function makeThumb(file: Blob, mime: FileMime): Promise<Blob | undefined> {
  try {
    if (mime === 'application/pdf') return await pdfFirstPage(file);
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      return await toWebp(bmp);
    } finally {
      bmp.close();
    }
  } catch {
    // 加密、损坏的 PDF 或解不开的图片：没有缩略图，卡片显示类型图标
    return undefined;
  }
}

function query(a: Partial<FileAnchor>): string {
  const q = new URLSearchParams();
  if (a.subId) q.set('sub', a.subId);
  if (a.kind) q.set('kind', a.kind);
  if (a.date) q.set('date', a.date);
  const s = q.toString();
  return s ? `?${s}` : '';
}

const putLocal = (f: FileMeta) => patchState((s) => ({ ...s, files: upsertById(s.files ?? [], f) }));

async function sendThumb(f: FileMeta, body: Blob): Promise<void> {
  const thumb = await makeThumb(body, f.mime);
  if (!thumb) return;
  const next = await api<FileMeta>(`/api/files/${f.id}/thumb`, { method: 'POST', body: thumb, headers: { 'content-type': 'image/webp' } });
  putLocal(next);
}

/** 上传一个文件：返回新文件；缩略图在后台补上，失败不影响上传结果 */
export async function uploadFile(file: File, anchor: Partial<FileAnchor> = {}): Promise<FileMeta> {
  const checked = await checkFile(file);
  if ('error' in checked) throw new Error(checked.error);
  const body = await prepare(file, checked.mime);
  const meta = await api<FileMeta>(`/api/files${query(anchor)}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
  });
  putLocal(meta);
  if (!meta.thumb) void sendThumb(meta, body).catch(() => {});
  return meta;
}

/** 多个文件依次上传；返回成功的与失败的（带原因），由调用方汇总提示 */
export async function uploadFiles(
  files: File[],
  anchor: Partial<FileAnchor> = {},
): Promise<{ done: FileMeta[]; failed: Array<{ name: string; error: string }> }> {
  const done: FileMeta[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const file of files) {
    try {
      done.push(await uploadFile(file, anchor));
    } catch (e) {
      failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { done, failed };
}

/** 旧文件、恢复来的文件没有缩略图：看到时补生成一次（同一会话里每个文件只试一次） */
const tried = new Set<string>();
export function ensureThumb(f: FileMeta): void {
  if (f.thumb || tried.has(f.id) || getState().readonly) return;
  tried.add(f.id);
  void (async () => {
    const res = await fetch(fileUrl(f), { credentials: 'same-origin' });
    if (!res.ok) return;
    await sendThumb(f, await res.blob());
  })().catch(() => {});
}

export async function relinkFile(f: FileMeta, anchor: FileAnchor): Promise<FileMeta> {
  const next = await api<FileMeta>(`/api/files/${f.id}`, { method: 'PATCH', body: JSON.stringify(anchor) });
  putLocal(next);
  return next;
}

export async function deleteFiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    await api(`/api/files/${id}`, { method: 'DELETE' });
    patchState((s) => ({ ...s, files: (s.files ?? []).filter((x) => x.id !== id) }));
  }
}

/** 文件大小：不到 1 MB 用 KB，其余用 MB */
export function sizeLabel(n: number): string {
  const fmt = (v: number, unit: string) => new Intl.NumberFormat(locale(), { style: 'unit', unit, maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
  return n < 1024 * 1024 ? fmt(Math.max(1, Math.round(n / 1024)), 'kilobyte') : fmt(n / 1024 / 1024, 'megabyte');
}

export { isImage };

export const backupFilesUrl = () => base('/api/backup?files=1');

/** 读「备份（含文件）」ZIP：取出备份 JSON 与 files/<sha256> 的内容；不是这种 ZIP 时抛错 */
export async function readBackupZip(file: File): Promise<{ json: string; blobs: Map<string, Uint8Array> }> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) => /^calends-backup-[^/]*\.json$/.test(f.name) || /^files\/[0-9a-f]{64}$/.test(f.name),
  });
  const name = Object.keys(entries).find((n) => n.endsWith('.json'));
  if (!name) throw new Error(t('settings.toast.badBackup'));
  const blobs = new Map<string, Uint8Array>();
  for (const [n, body] of Object.entries(entries)) if (n.startsWith('files/')) blobs.set(n.slice(6), body);
  return { json: strFromU8(entries[name]), blobs };
}

/** 恢复 JSON 之后把文件内容逐个补回；返回补回失败的个数 */
export async function putBlobs(blobs: Map<string, Uint8Array>): Promise<number> {
  let failed = 0;
  for (const [sha, body] of blobs) {
    try {
      await api(`/api/files/blob/${sha}`, { method: 'PUT', body: body as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      failed++;
    }
  }
  return failed;
}

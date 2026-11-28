// 文件中心的 MCP 工具：列出、读取、上传、改名与改关联。内容存 R2，元数据在 files 表；
// 网页上传与这里共用 worker/files.ts 的 storeFile / relinkFile / renameFile，校验与去重只有一份。
import {
  FILE_EXT,
  FILE_KINDS,
  FILE_MAX_BYTES,
  anchorError,
  cleanFileName,
  fileBadgeKind,
  fileReceiptPerson,
  fileTitle,
  findReceiptOwner,
  isImage,
  type FileAnchor,
  type FileKind,
  type FileMeta,
} from '../../shared/files.ts';
import { t } from '../../shared/i18n.ts';
import { drySchema, nullable, objectSchema as obj } from '../../shared/tool-schema.ts';
import type { AppState } from '../../shared/types.ts';
import { createTicket, fileBytes, filesEnabled, relinkFile, renameFile, storeFile } from '../files.ts';
import { fetchPublic } from '../url-guard.ts';
import { DATE, MCP_CONTENT, SUBREF, findSub, state, type Tool, type ToolCtx } from './tool-kit.ts';

/** 读取内容时直接放进工具结果的上限；更大的给下载链接 */
const INLINE_MAX = 5 * 1024 * 1024;

function needStorage(ctx: ToolCtx) {
  if (!filesEnabled(ctx.env)) throw new Error(t('core.file.noStorage'));
}

function findFile(st: AppState, id: unknown): FileMeta {
  const f = (st.files ?? []).find((x) => x.id === String(id ?? '').trim());
  if (!f) throw new Error(t('core.file.notFound'));
  return f;
}

/** 给 AI 看的一行：标题按网页的规则生成（已关联的文件按订阅与那一项命名，未关联的用原始文件名） */
function fileRow(st: AppState, f: FileMeta) {
  const sub = f.subId ? st.subscriptions.find((s) => s.id === f.subId) : undefined;
  const badge = fileBadgeKind(f, st.subscriptions);
  return {
    id: f.id,
    title: fileTitle(f, st.files ?? [], st.subscriptions),
    name: f.name,
    subscription: sub ? { id: sub.id, name: sub.name } : null,
    kind: f.kind ?? null,
    date: f.date ?? null,
    receipt_id: f.receiptId ?? null,
    receipt_scope: badge === 'carpool' || badge === 'proxy' ? badge : null,
    person: fileReceiptPerson(f, st.subscriptions) ?? null,
    duplicate_receipt: !!f.dupReceipt,
    deleted_source: f.orphan ? f.orphan.name : null,
    type: FILE_EXT[f.mime],
    mime: f.mime,
    size: f.size,
    uploaded_at: f.createdAt,
  };
}

/** 关联参数 → 挂法：kind 缺省时带 receipt 按收款、有日期按扣款、没日期按资料；不关联时全为空 */
function anchorFrom(st: AppState, subRef: unknown, kind: unknown, date: unknown, receipt: unknown): FileAnchor {
  if (subRef == null || subRef === '') return { subId: null, kind: null, date: null, receiptId: null };
  const sub = findSub(st, subRef);
  const r = receipt == null || receipt === '' ? null : String(receipt).trim();
  const k = (kind == null ? (r ? 'receipt' : date != null && date !== '' ? 'charge' : 'sub') : String(kind)) as FileKind;
  const d = date == null || date === '' ? (k === 'receipt' && r ? (findReceiptOwner(sub, r)?.receipt.date ?? null) : null) : String(date);
  return { subId: sub.id, kind: k, date: k === 'sub' ? null : d, receiptId: k === 'receipt' ? r : null };
}

function checkAnchor(st: AppState, a: FileAnchor) {
  const err = anchorError(a, st.subscriptions);
  if (err) throw new Error(err);
}

const b64encode = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

function b64decode(raw: string): Uint8Array<ArrayBuffer> {
  const clean = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new Error(t('mcp.error.invalidInput', { field: 'content_base64' }));
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 从公开 https 地址取文件（与图标代理同一个防 SSRF 的取法），限 10 MB */
async function fetchFile(url: string): Promise<{ body: Uint8Array<ArrayBuffer>; name: string }> {
  const res = await fetchPublic(url).catch(() => undefined);
  if (!res?.ok) throw new Error(t('mcp.error.fileFetch', { url }));
  if (Number(res.headers.get('content-length')) > FILE_MAX_BYTES) throw new Error(t('core.file.tooLarge'));
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > FILE_MAX_BYTES) throw new Error(t('core.file.tooLarge'));
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  let name = fromHeader ?? new URL(url).pathname.split('/').pop() ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 原样 */
  }
  return { body, name };
}

const LINK = {
  subscription: { ...SUBREF, description: 'Subscription id or name to link the file to. Omit to leave the file unlinked.' },
  kind: {
    type: 'string',
    enum: FILE_KINDS,
    description:
      'What the file documents: charge = a receipt or invoice for the charge on `date`; contract = a contract whose term starts on `date`; receipt = a collection screenshot/receipt for a shared-plan member receipt or proxy receipt (set `receipt` to its receipt_id from get_subscription; `date` defaults to that receipt date); sub = general documents of the subscription, not tied to one charge, contract or receipt (no date; the app labels it Documents / 资料), use it when the user asks for that even for an invoice. Default: receipt when receipt is given, charge when date is given, otherwise sub.',
  },
  date: {
    ...DATE,
    description: 'Charge date (kind=charge), contract start date (kind=contract), or receipt date (kind=receipt, optional when receipt is given), YYYY-MM-DD.',
  },
  receipt: {
    type: 'string',
    description: 'Receipt id from get_subscription (when kind=receipt, linking to a specific shared-plan member receipt or proxy receipt).',
  },
};

export const list_files: Tool = {
  name: 'list_files',
  description:
    'Files in the file center (receipts, invoices, contracts, shared-plan and proxy collection receipts; PDF/PNG/JPEG/WebP). Each row: id, title (display name: linked files are named after the subscription and the charge/contract/collection receipt they document; unlinked files use their original name), name (original file name), subscription, kind, date, receipt_id, receipt_scope (carpool or proxy when kind=receipt), person (member or proxy recipient name when kind=receipt), duplicate_receipt (true when the exact same file is attached to more than one collection receipt), deleted_source (name of a deleted subscription the file came from), type, size in bytes, uploaded_at. storage=false means file storage is not configured on this server.',
  inputSchema: obj({
    subscription: { ...SUBREF, description: 'Optional: only files linked to this subscription.' },
    status: { type: 'string', enum: ['all', 'linked', 'unlinked'], description: 'Default all.' },
    kind: { type: 'string', enum: FILE_KINDS, description: 'Optional: filter by file kind (charge, contract, receipt, sub).' },
    receipt_scope: { type: 'string', enum: ['carpool', 'proxy'], description: 'Optional: only shared-plan (carpool) or proxy collection receipts.' },
    receipt: { type: 'string', description: 'Optional: only files attached to this receipt_id (from get_subscription or record_receivable).' },
    duplicate_only: { type: 'boolean', description: 'Optional: true = only collection receipt files flagged with duplicate_receipt.' },
    query: { type: 'string', description: 'Optional: case-insensitive match on title, original name, or person.' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50, newest first.' },
  }),
  async run(a, ctx) {
    if (!filesEnabled(ctx.env)) return { storage: false, total: 0, files: [] };
    const { st } = await state(ctx);
    const subId = a.subscription ? findSub(st, a.subscription).id : undefined;
    const receiptId = a.receipt ? String(a.receipt).trim() : undefined;
    const q = String(a.query ?? '')
      .trim()
      .toLowerCase();
    const rows = [...(st.files ?? [])]
      .filter((f) => (subId ? f.subId === subId : true))
      .filter((f) => (a.status === 'linked' ? !!f.subId : a.status === 'unlinked' ? !f.subId : true))
      .filter((f) => (a.kind ? f.kind === a.kind : true))
      .filter((f) => (receiptId ? f.receiptId === receiptId : true))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .map((f) => fileRow(st, f))
      .filter((r) => (a.receipt_scope ? r.receipt_scope === a.receipt_scope : true))
      .filter((r) => (a.duplicate_only === true ? r.duplicate_receipt : true))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.person?.toLowerCase().includes(q) ?? false));
    return { storage: true, total: rows.length, files: rows.slice(0, Number(a.limit ?? 50)) };
  },
};

export const get_file: Tool = {
  name: 'get_file',
  description:
    'Read one file. as=content (default) returns the file itself in the result (image content for PNG/JPEG/WebP, an embedded PDF resource for PDF) when it is at most 5 MB; larger files, or as=link, return a download URL valid for 15 minutes that needs no login (hand it to the user or fetch it).',
  inputSchema: obj(
    {
      file: { type: 'string', description: 'File id from list_files or get_subscription.' },
      as: { type: 'string', enum: ['content', 'link'], description: 'Default content.' },
    },
    ['file'],
  ),
  async run(a, ctx) {
    needStorage(ctx);
    const { st } = await state(ctx);
    const f = findFile(st, a.file);
    const row = fileRow(st, f);
    if (a.as === 'link' || f.size > INLINE_MAX) {
      const link = await createTicket(ctx.env, { op: 'download', id: f.id });
      return { file: row, download_url: link.url, expires_at: link.expires_at };
    }
    const { body } = await fileBytes(ctx.env, f.id);
    const data = b64encode(body);
    const block = isImage(f)
      ? { type: 'image', data, mimeType: f.mime }
      : { type: 'resource', resource: { uri: `calends://files/${f.id}`, mimeType: f.mime, blob: data } };
    return { file: row, content: 'attached', [MCP_CONTENT]: [block] };
  },
};

export const upload_file: Tool = {
  name: 'upload_file',
  description:
    'Add a file (PDF, PNG, JPEG or WebP, up to 10 MB) to the file center, optionally linked to a subscription. Give exactly one source: content_base64 (the file bytes; a data: URL prefix is fine), url (a public https address to fetch, e.g. an attachment link), or upload_link=true to get a one-time URL the user or a script can PUT the raw bytes to within 15 minutes (use this when the file is too big to pass inline). The same content uploaded twice is stored once.',
  write: true,
  inputSchema: obj({
    content_base64: { type: 'string', description: 'File content, base64.' },
    url: { type: 'string', description: 'Public https URL of the file.' },
    upload_link: { type: 'boolean', description: 'Return a one-time upload URL instead of uploading now.' },
    name: { type: 'string', description: 'Original file name, e.g. "invoice-2026-11.pdf". Shown for unlinked files and searchable.' },
    ...LINK,
    dry_run: drySchema,
  }),
  async run(a, ctx) {
    needStorage(ctx);
    const sources = [a.content_base64 != null, a.url != null, a.upload_link === true].filter(Boolean).length;
    if (sources !== 1) throw new Error(t('mcp.error.fileSource'));
    const { st } = await state(ctx);
    const anchor = anchorFrom(st, a.subscription, a.kind, a.date, a.receipt);
    checkAnchor(st, anchor);
    const sub = anchor.subId ? st.subscriptions.find((s) => s.id === anchor.subId) : undefined;
    const link = {
      subscription: sub ? { id: sub.id, name: sub.name } : null,
      kind: anchor.kind,
      date: anchor.date,
      receipt_id: anchor.receiptId ?? null,
    };
    const name = a.name == null ? null : cleanFileName(a.name);
    if (a.upload_link === true) {
      if (a.dry_run) return { dry_run: true, upload_link: true, name, ...link };
      const ticket = await createTicket(ctx.env, { op: 'upload', name, anchor });
      return {
        upload_url: ticket.url,
        method: 'PUT',
        max_bytes: FILE_MAX_BYTES,
        expires_at: ticket.expires_at,
        example: `curl -T ./file.pdf -H "X-File-Name: file.pdf" "${ticket.url}"`,
        note: 'Send the raw file bytes as the request body. The URL works once; the file is linked as below.',
        ...link,
      };
    }
    const got = a.url != null ? await fetchFile(String(a.url)) : { body: b64decode(String(a.content_base64)), name: '' };
    if (!got.body.byteLength) throw new Error(t('core.file.empty'));
    if (got.body.byteLength > FILE_MAX_BYTES) throw new Error(t('core.file.tooLarge'));
    const fileName = name ?? cleanFileName(got.name);
    if (a.dry_run) return { dry_run: true, name: fileName, size: got.body.byteLength, ...link };
    const meta = await storeFile(ctx.env, got.body, fileName, anchor);
    const after = (await state(ctx)).st;
    return { created: fileRow({ ...after, files: [...(after.files ?? []).filter((f) => f.id !== meta.id), meta] }, meta) };
  },
};

export const update_file: Tool = {
  name: 'update_file',
  description:
    'Rename a file, link it to a subscription, change what it documents, or unlink it. set.subscription: id/name to link (or relink), null to unlink; omit to keep. When the subscription stays the same, omitted kind/date/receipt keep their current values; when it changes, kind defaults to receipt if receipt is given, charge if date is given, otherwise sub. For kind=receipt, pass set.receipt (receipt_id from get_subscription); date defaults to that receipt date. set.name changes the original file name (linked files keep their generated display title). Use dry_run to preview.',
  write: true,
  idempotent: true,
  inputSchema: obj(
    {
      file: { type: 'string', description: 'File id from list_files.' },
      set: obj({
        subscription: nullable({ ...SUBREF, description: 'Subscription to link to; null = unlink.' }),
        kind: LINK.kind,
        date: nullable(LINK.date),
        receipt: nullable(LINK.receipt),
        name: { type: 'string', description: 'New original file name.' },
      }),
      dry_run: drySchema,
    },
    ['file', 'set'],
  ),
  async run(a, ctx) {
    needStorage(ctx);
    const { st } = await state(ctx);
    const f = findFile(st, a.file);
    const set = (a.set ?? {}) as { subscription?: string | null; kind?: string; date?: string | null; receipt?: string | null; name?: string };
    const relink = 'subscription' in set || 'kind' in set || 'date' in set || 'receipt' in set;
    let anchor: FileAnchor = { subId: f.subId ?? null, kind: f.kind ?? null, date: f.date ?? null, receiptId: f.receiptId ?? null };
    if (relink) {
      const target = 'subscription' in set ? set.subscription : f.subId;
      const subId = target == null || target === '' ? null : findSub(st, target).id;
      if (!subId) anchor = { subId: null, kind: null, date: null, receiptId: null };
      else {
        const same = subId === f.subId;
        const subObj = st.subscriptions.find((x) => x.id === subId);
        const receiptId = 'receipt' in set ? set.receipt?.trim() || null : same ? (f.receiptId ?? null) : null;
        const rawDate = 'date' in set ? (set.date ?? null) : same ? (f.date ?? null) : null;
        const kind = (set.kind ??
          (same && !('date' in set) && !('receipt' in set) ? f.kind : undefined) ??
          (receiptId ? 'receipt' : rawDate ? 'charge' : 'sub')) as FileKind;
        const date =
          kind === 'sub' ? null : kind === 'receipt' ? (rawDate ?? (receiptId ? (findReceiptOwner(subObj, receiptId)?.receipt.date ?? null) : null)) : rawDate;
        anchor = { subId, kind, date, receiptId: kind === 'receipt' ? receiptId : null };
      }
      checkAnchor(st, anchor);
    }
    const name = set.name != null ? cleanFileName(set.name) : f.name;
    const next: FileMeta = {
      ...f,
      name,
      ...(relink
        ? {
            subId: anchor.subId ?? undefined,
            kind: anchor.kind ?? undefined,
            date: anchor.date ?? undefined,
            receiptId: anchor.receiptId ?? undefined,
            orphan: undefined,
          }
        : {}),
    };
    const sub = next.subId ? st.subscriptions.find((s) => s.id === next.subId) : undefined;
    const preview = (files: FileMeta[]) => ({ ...st, files });
    const others = (st.files ?? []).filter((x) => x.id !== f.id);
    const out = {
      file: f.id,
      before: fileRow(st, f),
      after: fileRow(preview([...others, next]), next),
      // 助手确认卡用订阅图标；没有关联时只显示工具名
      ...(sub ? { subscription: { id: sub.id, name: sub.name } } : {}),
      references: { file: f.id, ...(anchor.subId ? { subscription: anchor.subId } : {}) },
    };
    if (a.dry_run) return { dry_run: true, ...out };
    if (relink) await relinkFile(ctx.env, f.id, anchor);
    if (set.name != null) await renameFile(ctx.env, f.id, name);
    return out;
  },
};

export const fileTools: Tool[] = [list_files, get_file, upload_file, update_file];

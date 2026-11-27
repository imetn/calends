// 文件中心：订阅附件的元数据、挂法与显示名。浏览器与 Worker 共用，不依赖任何运行时接口。
// 文件软关联到订阅：kind + date 定位到合同期、某笔扣款或订阅本身；对不上时仍属于这个订阅，只是不显示在对应行上。
import { chargeMethodId, chargesBetween, currentPhase, historyStart, isSeparate, nthCharge, phaseSubs, validDay } from './billing.ts';
import { contractTerm } from './contract.ts';
import { t } from './i18n.ts';
import type { Subscription } from './types.ts';

/** contract：那一期合同的开始日；charge：那一笔的日期；sub：订阅资料，不带日期 */
export type FileKind = 'contract' | 'charge' | 'sub';
export const FILE_KINDS: readonly FileKind[] = ['contract', 'charge', 'sub'];

export const FILE_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type FileMime = (typeof FILE_MIMES)[number];

/** 单个文件上限 */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
/** 缩略图上限（浏览器生成的 WebP） */
export const THUMB_MAX_BYTES = 64 * 1024;
/** 总量默认上限（MB），FILES_LIMIT_MB 可改 */
export const FILES_LIMIT_MB = 300;
const NAME_MAX = 120;

/** 订阅删除时留下的来源快照：文件仍能看出原来属于谁、挂在哪 */
export interface FileOrphan {
  name: string;
  kind?: FileKind;
  date?: string;
}

/** 下发到浏览器的文件元数据（不含内容哈希与分享令牌） */
export interface FileMeta {
  id: string;
  /** 原始文件名：未关联时作为显示名，其余情况只在属性里显示、可被搜索 */
  name: string;
  mime: FileMime;
  size: number;
  /** 缺省为未关联 */
  subId?: string;
  kind?: FileKind;
  date?: string;
  orphan?: FileOrphan;
  /** 有缩略图 */
  thumb?: boolean;
  /** PDF 页数（图片无此字段，旧 PDF 尚未统计时缺省） */
  pages?: number;
  /** 上传时间（ISO） */
  createdAt: string;
}

export interface FileAnchor {
  subId: string | null;
  kind: FileKind | null;
  date: string | null;
}

/** 按文件头认类型；不认识的一律拒收（不信任浏览器给的 Content-Type 与扩展名） */
export function sniffMime(b: Uint8Array): FileMime | undefined {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'; // RIFF....WEBP
  return undefined;
}

export const FILE_EXT: Record<FileMime, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const isImage = (f: Pick<FileMeta, 'mime'>) => f.mime !== 'application/pdf';
export const FILE_PAGES_MAX = 9999;

/** 合法的 PDF 页数（1..9999 正整数） */
export const validPages = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= FILE_PAGES_MAX ? v : undefined;

/**
 * 轻量读取未压缩、未加密 PDF 的页数；遇到对象流（/ObjStm）或加密字典时返回 undefined，交由浏览器端 pdf.js 准确统计。
 * 仅当未压缩的 /Pages 树计数明确可信时才返回，避免误报。
 */
export function sniffPdfPages(b: Uint8Array): number | undefined {
  if (sniffMime(b) !== 'application/pdf') return undefined;
  let text = '';
  for (let i = 0; i < b.length; i += 32768) text += String.fromCharCode(...b.subarray(i, Math.min(b.length, i + 32768)));
  if (/\/(?:ObjStm|Encrypt)\b/.test(text)) return undefined;
  const counts: number[] = [];
  const dictRe = /<<(?:[^<>]|<(?!<)|>(?!>))*>>/g;
  for (const m of text.matchAll(dictRe)) {
    const dict = m[0];
    if (!/\/Type\s*\/Pages\b/.test(dict)) continue;
    const cm = /\/Count\s+(\d+)\b/.exec(dict);
    if (!cm) continue;
    const n = validPages(Number(cm[1]));
    if (n != null) counts.push(n);
  }
  if (!counts.length) return undefined;
  const maxCount = Math.max(...counts);
  const leafPages = (text.match(/\/Type\s*\/Page(?![A-Za-z0-9_])/g) ?? []).length;
  // 单一 /Pages 节点或与页面字典数量一致时直接采用；增量修订等歧义情况退回浏览器 pdf.js
  if (counts.length === 1 || leafPages === maxCount) return maxCount;
  return undefined;
}

/** 原始文件名：去掉路径与控制字符，最多 120 个字符；为空时用 file */
export function cleanFileName(raw: unknown): string {
  const base = typeof raw === 'string' ? (raw.split(/[\\/]/).pop() ?? '') : '';
  // eslint-disable-next-line no-control-regex
  const name = [...base.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, NAME_MAX).join('');
  return name || 'file';
}

/** 挂法是否成立；subs 用来确认订阅存在。返回错误文案，成立时返回 undefined */
export function anchorError(a: FileAnchor, subs: readonly Pick<Subscription, 'id'>[]): string | undefined {
  if (a.subId == null) return a.kind == null && a.date == null ? undefined : t('core.file.badAnchor');
  if (!subs.some((s) => s.id === a.subId)) return t('core.file.noSub');
  if (a.kind == null || !FILE_KINDS.includes(a.kind)) return t('core.file.badAnchor');
  if (a.kind === 'sub') return a.date == null ? undefined : t('core.file.badAnchor');
  return typeof a.date === 'string' && validDay(a.date) ? undefined : t('core.file.badAnchor');
}

const byUpload = (a: FileMeta, b: FileMeta) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** 订阅的全部文件：有日期的按日期倒序，资料排最后，同日按上传先后 */
export function filesOf(files: readonly FileMeta[], subId: string): FileMeta[] {
  return files.filter((f) => f.subId === subId).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || byUpload(a, b));
}

/** 删除订阅后它的文件：留下来源快照、不再挂在订阅上（与服务端 orphanFilesStmt 同一口径，浏览器先行更新用） */
export function orphanFiles(files: readonly FileMeta[], sub: Pick<Subscription, 'id' | 'name'>): FileMeta[] {
  return files.map((f) => {
    if (f.subId !== sub.id) return f;
    const { subId: _s, kind, date, ...rest } = f;
    const orphan: FileOrphan = { name: sub.name, ...(kind ? { kind } : {}), ...(date ? { date } : {}) };
    return { ...rest, orphan };
  });
}

/** 挂在某一项（合同期开始日 / 扣款日）上的文件 */
export function filesAt(files: readonly FileMeta[], subId: string, kind: FileKind, date?: string): FileMeta[] {
  return files.filter((f) => f.subId === subId && f.kind === kind && (kind === 'sub' || f.date === date)).sort(byUpload);
}

/** 同一项挂了多份时，这一份是第几份（从 1 起）；只有一份时为 undefined */
function seqOf(f: FileMeta, files: readonly FileMeta[]): number | undefined {
  if (!f.subId || !f.kind) return undefined;
  const same = filesAt(files, f.subId, f.kind, f.date ?? undefined);
  return same.length > 1 ? same.findIndex((x) => x.id === f.id) + 1 || undefined : undefined;
}

/** date 开始的那一期合同（起止）；date 不是任何一期的开始日时没有 */
export function contractTermAt(s: Subscription, date: string): { from: string; until: string } | undefined {
  for (const p of phaseSubs(s)) {
    const term = p.contract && contractTerm(p.contract, date);
    if (term && term.from === date) return { from: term.from, until: term.until };
  }
  return undefined;
}

/** 扣款那一项的名称：退款、补差、失败按那天记下的付款类型；分开记账时缴费日写「缴费」、其余写「账单」 */
function chargeLabel(s: Subscription | undefined, date: string): string {
  if (!s) return t('core.file.charge');
  const pays = phaseSubs(s).flatMap((p) => (p.payments ?? []).filter((x) => x.date === date));
  if (isSeparate(s)) return t(pays.some((x) => !x.kind) ? 'core.file.paid' : 'core.file.bill');
  const kinds = new Set(pays.map((x) => x.kind));
  const [only] = kinds;
  return kinds.size === 1 && only ? t(`core.paymentKind.${only}`) : t('core.file.charge');
}

/** 挂的那一项：扣款为 [日期, 类型]，合同期、资料各一段 */
function itemSegs(s: Subscription | undefined, kind: FileKind | undefined, date: string | undefined): string[] {
  if (kind === 'sub' || !date) return [t('core.file.sub')];
  if (kind === 'contract') {
    const term = s && contractTermAt(s, date);
    return [term ? t('core.file.contractTerm', { from: term.from, until: term.until }) : t('core.file.contractOn', { date })];
  }
  return [date, chargeLabel(s, date)];
}

/** 显示名的几段（每段内部再分词）：未关联时只有原始文件名 */
function titleSegs(f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]): string[][] {
  if (f.subId) {
    const s = subs.find((x) => x.id === f.subId);
    const seq = seqOf(f, files);
    const item = itemSegs(s, f.kind, f.date);
    return [[s?.name ?? '?'], seq && seq > 1 ? [...item, String(seq)] : item];
  }
  if (f.orphan) return [[t('core.file.deleted')], [f.orphan.name], itemSegs(undefined, f.orphan.kind, f.orphan.date)];
  return [[f.name]];
}

/** 显示名的几段：如 [订阅名, 2026-11-03 扣款] */
export const fileTitleParts = (f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]) => titleSegs(f, files, subs).map((x) => x.join(' '));

/** 平台里显示的文件名：按关联关系生成，不存库；改订阅名、改日期、重新关联都会跟着变 */
export const fileTitle = (f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]) => fileTitleParts(f, files, subs).join(' · ');

/** 下载时的文件名：订阅名_2026-11-03_扣款.pdf；未关联的用原始文件名 */
export function downloadName(f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]): string {
  if (!f.subId && !f.orphan) return f.name;
  const base = titleSegs(f, files, subs)
    .flat()
    // eslint-disable-next-line no-control-regex
    .map((x) => x.replace(/[\\/:*?"<>|\u0000-\u001f\s]/g, ''))
    .filter(Boolean)
    .join('_');
  return `${base || 'file'}.${FILE_EXT[f.mime]}`;
}

/** 文件属于哪一年（年份筛选）：有日期按日期，资料与未关联按上传时间 */
export const fileYear = (f: FileMeta) => (f.date ?? f.orphan?.date ?? f.createdAt).slice(0, 4);

/** 文件页的支付方式筛选：扣款文件看那一笔实际用的方式（合付取金额最大的来源），合同期看那一期的方式，资料看现在的方式；未指定为 none */
export function fileMethod(f: Pick<FileMeta, 'kind' | 'date'>, s: Subscription, today: string): string {
  const day = f.kind !== 'sub' && f.date ? f.date : today;
  if (f.kind === 'charge') {
    const c = chargesBetween(s, day, day, today).find((x) => x.date === day);
    const id = c && chargeMethodId(c);
    if (id) return id;
  }
  return currentPhase(s, day).methodId ?? 'none';
}

/** 改关联时可选的项：已发生的扣款日（分开记账另含缴费日）、已开始的合同期，都按日期倒序 */
export function anchorChoices(
  s: Subscription,
  today: string,
): { charges: Array<{ date: string; label: string }>; contracts: Array<{ from: string; until: string }> } {
  const charges = new Map<string, string>();
  for (const c of chargesBetween(s, historyStart(s), today, today)) if (!c.projected && !charges.has(c.date)) charges.set(c.date, chargeLabel(s, c.date));
  for (const p of phaseSubs(s)) for (const x of p.payments ?? []) if (x.date <= today && !charges.has(x.date)) charges.set(x.date, chargeLabel(s, x.date));
  const contracts = new Map<string, string>();
  for (const p of phaseSubs(s)) {
    const c = p.contract;
    if (!c) continue;
    for (let k = 0; k < 600; k++) {
      const term = contractTerm(c, nthCharge(c.start, c.term, k));
      if (!term || term.index !== k || term.from > today) break;
      contracts.set(term.from, term.until);
      if (!term.renews) break;
    }
  }
  return {
    charges: [...charges].map(([date, label]) => ({ date, label })).sort((a, b) => b.date.localeCompare(a.date)),
    contracts: [...contracts].map(([from, until]) => ({ from, until })).sort((a, b) => b.from.localeCompare(a.from)),
  };
}

/** 一期应有凭证的位置：一笔正常扣款（分开记账为一期账单），或一期合同 */
export interface FileSlot {
  kind: 'charge' | 'contract';
  /** 扣款日 / 账单日 / 合同开始日：上传到这一格的文件挂在这个日期 */
  date: string;
  /** 合同期的结束日 */
  until?: string;
  /** 分开记账：结清这期账单的缴费日，挂在缴费日的凭证也算这一期 */
  paidOn?: string;
  files: FileMeta[];
}

export interface FileCoverage {
  /** 按日期倒序 */
  slots: FileSlot[];
  /** 有凭证的期数 */
  covered: number;
  /** 不在任何一格里的文件：资料、退款补差等非正常扣款、对不上日期的，按日期倒序，资料最后 */
  rest: FileMeta[];
}

/**
 * 一个订阅的凭证覆盖：从这个订阅第一份扣款凭证那一期起，之后每一笔已发生的正常扣款都应有凭证；合同同理，从第一份合同文件那一期起。
 * 一份都没传过的那一类不追踪，免得没打算归档的订阅被成串的「缺凭证」淹没。退款、补差、失败、免费期不要求凭证。
 */
export function fileCoverage(s: Subscription, files: readonly FileMeta[], today: string): FileCoverage {
  const own = filesOf(files, s.id);
  const used = new Set<string>();
  const slots: FileSlot[] = [];
  const first = (kind: FileKind) =>
    own.filter((f) => f.kind === kind && f.date).reduce<string | undefined>((a, f) => (!a || f.date! < a ? f.date : a), undefined);
  const take = (kind: FileKind, ...dates: Array<string | undefined>) => {
    const hit = own.filter((f) => f.kind === kind && f.date && dates.includes(f.date) && !used.has(f.id));
    hit.forEach((f) => used.add(f.id));
    return hit.sort(byUpload);
  };
  const chargeFrom = first('charge');
  if (chargeFrom) {
    const seen = new Set<string>();
    for (const c of chargesBetween(s, chargeFrom, today, today)) {
      if (c.projected || c.kind || !(c.amount > 0) || c.unpaid || seen.has(c.date)) continue;
      seen.add(c.date);
      slots.push({ kind: 'charge', date: c.date, ...(c.paidOn && c.paidOn !== c.date ? { paidOn: c.paidOn } : {}), files: take('charge', c.date, c.paidOn) });
    }
  }
  const contractFrom = first('contract');
  if (contractFrom) {
    for (const { from, until } of anchorChoices(s, today).contracts) {
      if (until < contractFrom) continue;
      slots.push({ kind: 'contract', date: from, until, files: take('contract', from) });
    }
  }
  slots.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
  const rest = own.filter((f) => !used.has(f.id));
  rest.sort((a, b) => (a.kind === 'sub' ? 1 : 0) - (b.kind === 'sub' ? 1 : 0) || (b.date ?? '').localeCompare(a.date ?? '') || byUpload(a, b));
  return { slots, covered: slots.filter((x) => x.files.length).length, rest };
}

/** 一格的名称：扣款为「2026-11-03 扣款」（分开记账写「账单」），合同期为起止 */
export const slotLabel = (s: Subscription, slot: Pick<FileSlot, 'kind' | 'date'>) => itemSegs(s, slot.kind, slot.date).join(' ');

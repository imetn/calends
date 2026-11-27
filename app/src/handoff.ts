import { AVATAR_INPUT_MAX_BYTES, avatarCrop, prepareAvatarThumbnail } from '../../shared/avatar.ts';
import type { AssistantConfigView } from '../../shared/deepseek.ts';
import { t } from '../../shared/i18n.ts';
import { ICON_UPLOAD_SIZE, iconFit, iconInput, isDataIcon } from '../../shared/icon.ts';
import type { Subscription } from '../../shared/types.ts';
// 从别的页面（新建订阅表单）把文字、图片交给 AI 助手：先存进 sessionStorage，助手页打开时取走
import { HANDOFF_KEY } from './auth.ts';
import { go } from './router.ts';

const KEY = HANDOFF_KEY;

export interface HandoffReturn {
  /** 离开新建订阅弹窗前所在路由，返回时先切回原页面再重开表单 */
  route: string;
  /** 离开前的表单快照（保留合租/代付模板和刚填的字段） */
  draft: Subscription;
}

export interface HandoffPayload {
  text: string;
  images: string[];
  returnTo?: HandoffReturn;
}

let assistantConfigured: boolean | null = null;
let assistantConfiguredInflight: Promise<boolean | null> | null = null;

export function cachedAssistantConfigured(): boolean | null {
  return assistantConfigured;
}

export function setAssistantConfigured(v: boolean | null) {
  assistantConfigured = v;
}

export function loadAssistantConfigured(fetcher: () => Promise<AssistantConfigView>): Promise<boolean | null> {
  if (assistantConfigured !== null) return Promise.resolve(assistantConfigured);
  if (!assistantConfiguredInflight) {
    assistantConfiguredInflight = fetcher()
      .then((c) => {
        assistantConfigured = !!c?.configured;
        return assistantConfigured;
      })
      .catch(() => null)
      .finally(() => {
        assistantConfiguredInflight = null;
      });
  }
  return assistantConfiguredInflight;
}

/** 压缩成长边不超过 1600px 的 JPEG（data URL）：截图够清晰，请求体也不大 */
export async function compressImage(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}

/** 将 PDF 账单/收据的前几页按需渲染为清晰 JPEG data URL，供视觉模型直接识别 */
export async function renderPdfToImages(file: Blob, maxPages = 2): Promise<{ images: string[]; pages: number }> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const take = Math.min(doc.numPages, Math.max(1, maxPages));
    const images: string[] = [];
    for (let i = 1; i <= take; i++) {
      const page = await doc.getPage(i);
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(unit.width, unit.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.86));
    }
    return { images, pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}

export function handoff(text: string, images: string[] = [], returnTo?: HandoffReturn) {
  const payload: HandoffPayload = { text, images, ...(returnTo ? { returnTo } : {}) };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* 存不下（图片太大）就只带文字与返回信息 */
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...payload, images: [] }));
    } catch {
      /* 隐私模式：直接跳过去 */
    }
  }
  go('assistant');
}

export function takeHandoff(): HandoffPayload | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<HandoffPayload> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const ret = parsed.returnTo;
    const returnTo = ret && typeof ret.route === 'string' && ret.draft && typeof ret.draft === 'object' ? { route: ret.route, draft: ret.draft } : undefined;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      images: Array.isArray(parsed.images) ? parsed.images.filter((x): x is string => typeof x === 'string') : [],
      ...(returnTo ? { returnTo } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 本地图片 → 订阅图标：等比缩进 128 见方、保留透明，重新编码（丢掉原图元数据），
 * 优先 WebP，浏览器不支持时回落 PNG；结果再过一遍 iconInput，保证与导入、MCP 写入的约束一致。
 */
export async function compressIcon(file: Blob): Promise<string> {
  const invalid = () => new Error(t('editor.field.iconUploadInvalid'));
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > AVATAR_INPUT_MAX_BYTES) throw invalid();
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw invalid();
  }
  try {
    const fit = iconFit(bmp.width, bmp.height);
    if (!fit) throw invalid();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_UPLOAD_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw invalid();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, fit.x, fit.y, fit.w, fit.h);
    for (const q of [0.9, 0.8, 0.65, 0.5]) {
      const url = canvas.toDataURL('image/webp', q);
      const data = isDataIcon(url) ? url : canvas.toDataURL('image/png');
      try {
        const icon = iconInput(data);
        if (icon) return icon;
      } catch {
        /* 超出大小上限：降低质量再试；PNG 没有质量可调，直接失败 */
      }
      if (!url.startsWith('data:image/webp')) break;
    }
    // 图能解码、只是压不进 64 KB（多见于不支持 WebP 编码、回落 PNG 的浏览器）：别让人以为是格式或 8 MB 的问题
    throw new Error(t('editor.field.iconUploadTooLarge'));
  } finally {
    bmp.close();
  }
}

/** Private roster thumbnail: center-crop and re-encode to strip source metadata. */
export async function compressAvatar(file: Blob): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > AVATAR_INPUT_MAX_BYTES)
    throw new Error(t('server.avatarInvalid'));
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(t('server.avatarInvalid'));
  }
  try {
    const crop = avatarCrop(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = crop.size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t('server.avatarInvalid'));
    ctx.drawImage(bmp, crop.x, crop.y, crop.side, crop.side, 0, 0, crop.size, crop.size);
    // PNG fallback covers browsers without a WebP encoder.
    return prepareAvatarThumbnail(canvas.toDataURL('image/webp', 0.82));
  } finally {
    bmp.close();
  }
}

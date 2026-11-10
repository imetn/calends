// 订阅图标的几种形态：网址、站内路径（/ai/claude.svg）、内嵌图片（导入的 logo，data:image/…）与 emoji。
// 浏览器、公开页、日历订阅与提醒共用这一套判定，内嵌图片不会被当成文字输出。
import { t } from './i18n.ts';
import { BANKS } from './banks.ts';
import type { MethodKind, PaymentMethod } from './types.ts';

/** 导入时内嵌 logo 的大小上限：与人员头像一致，避免整串 base64 撑大账本 */
export const ICON_DATA_LIMIT = 64 * 1024;

/** 内嵌图片：只认 png、jpeg、webp 的 base64 */
export const isDataIcon = (icon?: string): boolean => !!icon && /^data:image\/(png|jpeg|webp);base64,/.test(icon.trim());

/** 是图片（网址、站内路径或内嵌图片），而不是 emoji 文字 */
export const isImageIcon = (icon?: string): boolean => !!icon && (/^(https?:|\/)/.test(icon.trim()) || isDataIcon(icon));

/** 文字图标最多几个字符（按字形计，组合 emoji 算一个）：够放 emoji 或简短符号，放不下一段说明 */
const ICON_TEXT_LIMIT = 4;
const graphemes = (s: string): number =>
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length : [...s].length;

/**
 * 写入订阅图标前的统一校验（MCP 新建与修改共用）：http(s) 网址、站内路径、png/jpeg/webp 内嵌图片（不超过 ICON_DATA_LIMIT），
 * 或一个 emoji / 简短符号。null、空串表示不设（清除）；其他值报错，不静默丢弃。返回去掉首尾空白后的值。
 */
export function iconInput(v: unknown): string | undefined {
  if (v == null) return undefined;
  const icon = String(v).trim();
  if (!icon) return undefined;
  const bad = () => new Error(t('mcp.error.invalidIcon', { value: icon.length > 40 ? `${icon.slice(0, 40)}…` : icon }));
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon) && !icon.startsWith('data:')) {
    let url: URL;
    try {
      url = new URL(icon);
    } catch {
      throw bad();
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) throw bad();
    return icon;
  }
  if (icon.startsWith('data:')) {
    const b64 = icon.slice(icon.indexOf(',') + 1);
    if (!isDataIcon(icon) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Math.floor((b64.length * 3) / 4) > ICON_DATA_LIMIT) throw bad();
    return icon;
  }
  if (icon.startsWith('/')) {
    if (icon.startsWith('//') || /\s/.test(icon)) throw bad();
    return icon;
  }
  if (/[\s\p{Cc}]/u.test(icon) || graphemes(icon) > ICON_TEXT_LIMIT) throw bad();
  return icon;
}

/** 平台类支付方式自带的 logo（选了类型就用它）：卡面标记与提醒共用 */
export const METHOD_BRAND_LOGO: Partial<Record<MethodKind, string>> = {
  appstore: '/brands/appstore.svg',
  googleplay: '/brands/googleplay.svg',
  paypal: '/brands/paypal.svg',
  alipay: '/brands/alipay.svg',
  wechat: '/brands/wechat.svg',
};

/** 银行卡对应的银行图标：手动指定优先，否则按名称里的银行名识别（招商银行 → cmbchina） */
export function bankOf(m: Pick<PaymentMethod, 'name' | 'kind' | 'bank'>): string | undefined {
  if (m.bank) return m.bank;
  if (m.kind !== 'debit' && m.kind !== 'credit') return undefined;
  return BANKS.find(([name]) => m.name.includes(name))?.[1];
}

/** 网址的域名：没写协议头按 https 解析，去掉 www. */
export function domainOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\.|^ww\./, '');
  } catch {
    return undefined;
  }
}

/** 官网图标（Google favicon 服务） */
export function faviconOf(url?: string): string | undefined {
  const d = domainOf(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : undefined;
}

/**
 * 提醒里支付方式的图标，与卡面标记同一顺序：认得出的银行用银行图标 > 自定义 logo > 平台 logo > 官网图标。
 * 内嵌图片发不出去（通知渠道只认网址），跳过它往下找。
 */
export function methodIcon(m: Pick<PaymentMethod, 'logo' | 'kind' | 'url' | 'bank' | 'name'>): string | undefined {
  const bank = bankOf(m);
  if (bank) return `/banks/${bank}-rect.svg`;
  const logo = m.logo?.trim();
  if (logo && !logo.startsWith('data:')) return logo;
  return METHOD_BRAND_LOGO[m.kind] ?? faviconOf(m.url);
}

// 提醒邮件模板：到期提醒、每月 1 日账单预告、测试邮件共用一套版式。
//
// 邮件客户端的硬约束（兼容性底线，不是风格选择）：
// - 纯 <table> 布局 + 全内联样式：Outlook 桌面版不认 flex / grid，Gmail 会删掉部分 <style>。
// - <style> 只做「锦上添花」：深色模式配色与窄屏内边距。不认 <style> 的客户端照样拿到完整的亮色版。
// - 深色模式：Apple Mail / iOS 认 prefers-color-scheme；Outlook.com 深色时会给元素加 data-ogsc / data-ogsb，
//   用属性选择器把我们自己的深色配色压上去，避免它自动反色出奇怪的对比色。
// - 图片一律绝对地址 + alt + 显式宽高：被拦截时不破版。SVG 与 data: 图片 Gmail 不显示，改用首字母方块。
// - 预览文本（preheader）：收件箱列表里标题后的那行，不给的话客户端会从正文开头乱抓。
// - 所有来自用户的数据（订阅名、支付方式、备注）都经 esc() 转义，防止 HTML 注入。
import { cnDateFull, esc, relDays } from '../shared/format.ts';
import { locale, t } from '../shared/i18n.ts';
import type { Digest, Row, Section } from './notify.ts';

/** 亮色配色：通体白底，靠留白与细线分隔，蓝色强调；灰底只留给小标签和首字母方块 */
const L = {
  page: '#ffffff',
  card: '#ffffff',
  border: '#e4e4e7',
  ink: '#09090b',
  body: '#3f3f46',
  mute: '#71717a',
  faint: '#a1a1aa',
  line: '#ededef',
  chip: '#f4f4f5',
  accent: '#3e63dd',
  accentSoft: '#edf1fe',
  warn: '#c2410c',
  warnSoft: '#fff3eb',
  ok: '#15803d',
} as const;

/** 深色配色：与亮色一一对应，供 <style> 覆盖 */
const D: Record<keyof typeof L, string> = {
  page: '#161618',
  card: '#161618',
  border: '#2a2a2e',
  ink: '#fafafa',
  body: '#d4d4d8',
  mute: '#a1a1aa',
  faint: '#71717a',
  line: '#26262a',
  chip: '#232326',
  accent: '#91a7ff',
  accentSoft: '#1d2547',
  warn: '#fb923c',
  warnSoft: '#2e1d12',
  ok: '#4ade80',
};

const FONT = "'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Roboto,Helvetica,Arial,sans-serif";
/** 按钮底色：深浅两种模式下都用品牌蓝，白字对比度足够 */
const BUTTON = '#3e63dd';

/** 深色模式覆盖：类名 → 要替换的属性与配色键 */
const DARK_RULES: Array<[string, string, keyof typeof L]> = [
  ['bg-page', 'background', 'page'],
  ['bg-card', 'background', 'card'],
  ['bg-chip', 'background', 'chip'],
  ['bg-accent-soft', 'background', 'accentSoft'],
  ['bg-warn-soft', 'background', 'warnSoft'],
  ['bd', 'border-color', 'border'],
  ['ln', 'border-color', 'line'],
  ['c-ink', 'color', 'ink'],
  ['c-body', 'color', 'body'],
  ['c-mute', 'color', 'mute'],
  ['c-faint', 'color', 'faint'],
  ['c-accent', 'color', 'accent'],
  ['c-warn', 'color', 'warn'],
  ['c-ok', 'color', 'ok'],
];

function darkCss(): string {
  const rules = (prefix: string) => DARK_RULES.map(([cls, prop, key]) => `${prefix}.${cls}{${prop}:${D[key]} !important}`).join('');
  return [
    `@media (prefers-color-scheme: dark){${rules('')}.logo-dark-bd{border-color:${D.border} !important}}`,
    // Outlook.com / Outlook App 深色模式
    rules('[data-ogsc] ').replace(/\[data-ogsc\] \.(bg-[\w-]+)/g, '[data-ogsb] .$1'),
  ].join('\n');
}

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%}
img{border:0;outline:none;text-decoration:none}
a{text-decoration:none}
@media (max-width:620px){
  .px{padding-left:20px !important;padding-right:20px !important}
  .outer{padding:20px 4px 32px !important}
  .h1{font-size:22px !important}
  .stat-v{font-size:17px !important}
  .stat{padding:12px 12px !important}
}
${darkCss()}`;

const tone = (r: Row) =>
  r.tone === 'warn' ? ['c-warn', L.warn] : r.tone === 'ok' ? ['c-ok', L.ok] : r.tone === 'muted' ? ['c-mute', L.mute] : ['c-ink', L.ink];

/** 图标地址：http(s) 直接用，站内路径拼上站点地址；data: 与图标库以外的 SVG 在 Gmail 等客户端不显示，返回空 */
function iconSrc(icon: string, site: string): string | undefined {
  if (/^data:/i.test(icon)) return undefined;
  // 多数邮件客户端不显示 SVG：站内图标库改用 scripts/email-icons.mjs 生成的 PNG，其余 SVG 退回首字母
  const mail = /^\/(ai|brands|banks)\/([a-z0-9-]+)\.svg$/.exec(icon);
  if (mail && (mail[1] !== 'banks' || mail[2].endsWith('-rect'))) icon = `/mail/${mail[1]}/${mail[2]}.png`;
  else if (/\.svg(\?|#|$)/i.test(icon)) return undefined;
  if (/^https?:\/\//i.test(icon)) return icon;
  if (icon.startsWith('/') && /^https?:\/\/|^file:/i.test(site)) return site + icon;
  return undefined;
}

/** 订阅图标：图片 > emoji > 首字母方块 */
function iconCell(r: Row, site: string): string {
  const icon = r.icon?.trim();
  const src = icon ? iconSrc(icon, site) : undefined;
  if (src)
    return `<img src="${esc(src)}" alt="" width="40" height="40" style="display:block;width:40px;height:40px;border-radius:10px;border:1px solid rgba(0,0,0,.06);background:#ffffff">`;
  // 不是链接也不是路径的短字符串当 emoji；其余用名称首字
  const isEmoji = !!icon && !/[/.:]/.test(icon) && [...icon].length <= 4;
  const glyph = isEmoji ? icon : ([...r.title.trim()][0] ?? '·').toUpperCase();
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="bg-chip c-mute" width="42" height="42" align="center" valign="middle" style="width:42px;height:42px;border-radius:10px;background:${L.chip};color:${L.mute};text-align:center;vertical-align:middle;font-family:${FONT};font-size:${isEmoji ? 20 : 16}px;font-weight:600;line-height:42px">${esc(glyph)}</td></tr></table>`;
}

/** 距今天数的小标签：一天内用蓝色，逾期用橙色 */
function daysChip(days: number): string {
  const [cls, bg, fg] =
    days < 0
      ? ['bg-warn-soft c-warn', L.warnSoft, L.warn]
      : days <= 1
        ? ['bg-accent-soft c-accent', L.accentSoft, L.accent]
        : ['bg-chip c-mute', L.chip, L.mute];
  return `<span class="${cls}" style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:11.5px;font-weight:600;line-height:1.5;vertical-align:1px;white-space:nowrap">${esc(relDays(days))}</span>`;
}

function rowHtml(r: Row, site: string): string {
  const [amountCls, amountColor] = tone(r);
  const detail = r.detail ?? r.sub;
  return `<tr><td class="ln" style="padding:14px 0;border-top:1px solid ${L.line}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="42" valign="top" style="width:42px;vertical-align:top;line-height:0">${iconCell(r, site)}</td>
<td valign="top" style="padding:0 12px 0 14px;vertical-align:top;font-family:${FONT}">
<div class="c-ink" style="font-size:15px;font-weight:600;line-height:1.45;color:${L.ink};word-break:break-word">${esc(r.title)}${r.days != null ? daysChip(r.days) : ''}</div>
${detail ? `<div class="c-mute" style="padding-top:2px;font-size:13px;line-height:1.55;color:${L.mute}">${esc(detail)}</div>` : ''}
${r.note ? `<div style="padding-top:6px"><span class="bg-warn-soft c-warn" style="display:inline-block;padding:2px 8px;border-radius:6px;background:${L.warnSoft};color:${L.warn};font-size:12px;font-weight:500;line-height:1.5">${esc(r.note)}</span></div>` : ''}
</td>
<td align="right" valign="top" style="vertical-align:top;text-align:right;white-space:nowrap;font-family:${FONT}">
${r.amount ? `<div class="${amountCls}" style="font-size:15px;font-weight:600;line-height:1.45;color:${amountColor};font-variant-numeric:tabular-nums">${esc(r.amount)}</div>` : ''}
${r.amountSub ? `<div class="c-faint" style="padding-top:2px;font-size:12.5px;line-height:1.55;color:${L.faint};font-variant-numeric:tabular-nums">${esc(r.amountSub)}</div>` : ''}
</td>
</tr></table>
</td></tr>`;
}

/** 空状态 / 说明框 */
function noteBox(text: string): string {
  return `<tr><td class="px" style="padding:24px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ln c-body" style="padding:16px 0 0;border-top:1px solid ${L.line};color:${L.body};font-family:${FONT};font-size:14px;line-height:1.65">${esc(text)}</td></tr></table></td></tr>`;
}

function sectionHtml(s: Section, site: string, kind: Digest['kind']): string {
  if (!s.rows.length) return noteBox(kind === 'monthly' ? t('notify.email.noCharges') : t('notify.email.testNote'));
  const total = s.total
    ? `<tr><td class="bd" style="padding:14px 0 0;border-top:1px solid ${L.border}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="c-ink" style="font-family:${FONT};font-size:14px;font-weight:600;color:${L.ink}">${esc(s.total.label)}</td>
<td class="c-ink" align="right" style="font-family:${FONT};font-size:17px;font-weight:700;color:${L.ink};text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(s.total.amount)}</td>
</tr></table></td></tr>`
    : '';
  return `<tr><td class="px" style="padding:28px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="c-mute" style="font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${L.mute}">${esc(s.heading)}</td>
<td class="c-faint" align="right" style="font-family:${FONT};font-size:12px;color:${L.faint};text-align:right;font-variant-numeric:tabular-nums">${s.rows.length}</td>
</tr></table></td></tr>
${s.rows.map((r) => rowHtml(r, site)).join('')}
${total}
</table></td></tr>`;
}

function statsHtml(stats: NonNullable<Digest['stats']>): string {
  const cells = stats
    .map(
      (x, i) =>
        `${i ? '<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>' : ''}<td class="stat bd" valign="top" style="padding:14px 16px;border:1px solid ${L.border};border-radius:12px;vertical-align:top;font-family:${FONT}">
<div class="c-mute" style="font-size:12px;line-height:1.4;color:${L.mute}">${esc(x.label)}</div>
<div class="stat-v c-ink" style="padding-top:4px;font-size:20px;font-weight:700;line-height:1.25;letter-spacing:-.01em;color:${L.ink};font-variant-numeric:tabular-nums;white-space:nowrap">${esc(x.value)}</div>
</td>`,
    )
    .join('');
  return `<tr><td class="px" style="padding:24px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>${cells}</tr></table></td></tr>`;
}

/** 纯文本备用正文：只渲染 text 的客户端、以及反垃圾评分都会看它 */
function renderText(d: Digest, site: string): string {
  const lines = [d.title ?? d.subject, '', d.intro, ''];
  if (d.stats?.length) lines.push(d.stats.map((x) => `${x.label} ${x.value}`).join(' · '), '');
  for (const s of d.sections) {
    lines.push(t('notify.text.heading', { heading: s.heading }));
    for (const r of s.rows) {
      const amount = [r.amount, r.amountSub ? `(${r.amountSub})` : ''].filter(Boolean).join(' ');
      lines.push(`· ${r.title}${amount ? `  ${amount}` : ''}`);
      const meta = [r.detail ?? r.sub, r.days != null && r.detail ? relDays(r.days) : '', r.note].filter(Boolean).join(' · ');
      if (meta) lines.push(`  ${meta}`);
    }
    if (s.total) lines.push(`${s.total.label}  ${s.total.amount}`);
    lines.push('');
  }
  if (!d.sections.some((s) => s.rows.length)) lines.push(d.kind === 'monthly' ? t('notify.email.noCharges') : t('notify.email.testNote'), '');
  lines.push(
    `${t('notify.email.open')}: ${site}/`,
    '',
    '—',
    t('notify.email.why', { app: t('notify.appName') }),
    `${t('notify.email.footer')} ${t('notify.email.off')}`,
  );
  return lines.join('\n');
}

export function renderEmail(d: Digest, siteUrl: string): { html: string; text: string } {
  const site = siteUrl.replace(/\/+$/, '');
  const app = t('notify.appName');
  const title = d.title ?? d.subject;
  const preheader = d.preheader ?? d.intro;
  const date = d.date ? cnDateFull(d.date) : '';
  const host = /^https?:\/\//.test(site) ? site.replace(/^https?:\/\//, '') : '';
  const hasRows = d.sections.some((s) => s.rows.length);

  const header = `<tr><td class="px" style="padding:32px 32px 0;font-family:${FONT}">
<span class="bg-accent-soft c-accent" style="display:inline-block;padding:4px 10px;border-radius:999px;background:${L.accentSoft};color:${L.accent};font-size:12px;font-weight:600;line-height:1.5;letter-spacing:.02em">${esc(t(`notify.email.kind.${d.kind}`))}</span>
<h1 class="h1 c-ink" style="margin:14px 0 0;font-family:${FONT};font-size:24px;font-weight:700;line-height:1.3;letter-spacing:-.02em;color:${L.ink}">${esc(title)}</h1>
<p class="c-body" style="margin:10px 0 0;font-family:${FONT};font-size:15px;line-height:1.65;color:${L.body}">${esc(d.intro)}</p>
</td></tr>`;

  const body = [
    header,
    d.stats?.length ? statsHtml(d.stats) : '',
    ...d.sections.map((s) => sectionHtml(s, site, d.kind)),
    !d.sections.length ? noteBox(t('notify.email.testNote')) : '',
  ].join('\n');

  const cta = `<tr><td class="px" style="padding:${hasRows ? 28 : 24}px 32px 32px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${BUTTON}" style="border-radius:10px;background:${BUTTON}">
<a href="${esc(site)}/" target="_blank" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px">${esc(t('notify.email.open'))}&nbsp;&nbsp;→</a>
</td></tr></table>
</td></tr>`;

  const footer = `<tr><td class="px" style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ln c-faint" style="padding:20px 0 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:12px;line-height:1.7;color:${L.faint}">
${esc(t('notify.email.why', { app }))}<br>
${esc(t('notify.email.footer'))} ${esc(t('notify.email.off'))}<br>
<a class="c-mute" href="${esc(site)}/settings" target="_blank" style="color:${L.mute};text-decoration:underline">${esc(t('notify.email.settings'))}</a>${host ? `<span class="c-faint" style="color:${L.faint}">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a class="c-mute" href="${esc(site)}" target="_blank" style="color:${L.mute};text-decoration:none">${esc(host)}</a>` : ''}
</td></tr></table></td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="${esc(locale())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(d.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body class="bg-page" style="margin:0;padding:0;background:${L.page};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(preheader)}</div>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${'&#8199;&#65279;&#847; '.repeat(40)}</div>
<table class="bg-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${L.page}">
<tr><td class="outer" align="center" style="padding:32px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
<tr><td class="px" style="padding:0 32px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:10px;line-height:0;vertical-align:middle"><img class="logo-dark-bd" referrerpolicy="no-referrer" src="${esc(site)}/icons/icon-192.png" alt="" width="28" height="28" style="display:block;width:28px;height:28px;border-radius:7px;border:1px solid transparent"></td>
<td class="c-ink" style="vertical-align:middle;font-family:${FONT};font-size:15px;font-weight:700;letter-spacing:-.01em;color:${L.ink}">${esc(app)}</td>
</tr></table>
</td>
<td class="c-faint" align="right" style="vertical-align:middle;text-align:right;font-family:${FONT};font-size:12.5px;color:${L.faint};white-space:nowrap">${esc(date)}</td>
</tr></table>
</td></tr>
<tr><td class="bg-card" style="background:${L.card}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${body}
${cta}
</table>
</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${footer}</table></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { html, text: renderText(d, site) };
}

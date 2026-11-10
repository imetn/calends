// 邮件用图标：多数邮件客户端不显示 SVG，把站内 SVG 图标转成 PNG 放到 app/public/mail/ 下，提醒邮件改引用这些 PNG。
// 用法：node scripts/email-icons.mjs（新增或替换 ai/、brands/、banks/ 下的 SVG 后重跑；email.test.ts 会检查是否齐全）
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SIZE = 80; // 邮件里按 40px 显示，2 倍图
const PUB = 'app/public';

// 白色字标：卡面上本来放在品牌色底上，邮件是白底，这里把底色一起画进去
const ON_COLOR = {
  'brands/appstore': '#1a8cff',
  'brands/paypal': '#003087',
  'brands/alipay': '#1677ff',
  'brands/wechat': '#07c160',
  'brands/bybit': '#17181e',
  'brands/plasma': '#1c1f24',
  'brands/cmb': '#c8152d',
  'ai/kimi': '#000000',
};

/** 需要转换的 SVG：AI 图标、平台 logo、银行方块图标（支付方式标记只用 -rect 版本） */
export function emailIconSources() {
  const pick = (dir, ok = () => true) =>
    readdirSync(join(PUB, dir))
      .filter((f) => f.endsWith('.svg') && ok(f))
      .map((f) => `${dir}/${f.slice(0, -4)}`);
  return [...pick('ai'), ...pick('brands'), ...pick('banks', (f) => f.endsWith('-rect.svg'))];
}

async function render(id) {
  const bg = ON_COLOR[id];
  // 银行方块图标自带底色和留白，铺满；其余字标留出边距
  const tile = id.startsWith('banks/');
  const inner = tile ? SIZE : Math.round(SIZE * 0.64);
  const logo = await sharp(join(PUB, `${id}.svg`), { density: 384 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const out = join(PUB, 'mail', `${id}.png`);
  mkdirSync(join(PUB, 'mail', id.split('/')[0]), { recursive: true });
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: bg ?? '#ffffff' } })
    .composite([{ input: logo, gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = emailIconSources();
  for (const id of ids) await render(id);
  console.log(`邮件图标 ${ids.length} 个 → ${PUB}/mail/`);
}

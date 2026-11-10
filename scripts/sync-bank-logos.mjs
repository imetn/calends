// 同步银行图标集：icongo/bank-logos（MIT）→ app/public/banks/*.svg + shared/banks.ts（中文名 → 文件名）
// 用法：node scripts/sync-bank-logos.mjs <bank-logos 仓库路径>
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2];
if (!repo) throw new Error('用法：node scripts/sync-bank-logos.mjs <bank-logos 仓库路径>');
mkdirSync('app/public/banks', { recursive: true });
for (const f of readdirSync(join(repo, 'logos'))) if (f.endsWith('.svg')) copyFileSync(join(repo, 'logos', f), join('app/public/banks', f));
copyFileSync(join(repo, 'LICENSE'), 'app/public/banks/LICENSE.txt');

// README 里每个图标都带 alt（中文名）与文件名
const readme = readFileSync(join(repo, 'README.md'), 'utf8');
const map = {};
for (const m of readme.matchAll(/<img src="\.\/logos\/([a-z0-9-]+)-rect\.svg"[^>]*alt="([^"]+)"/g)) map[m[2]] = m[1];
const body = Object.entries(map)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, slug]) => `  [${JSON.stringify(name)}, ${JSON.stringify(slug)}],`)
  .join('\n');
writeFileSync(
  'shared/banks.ts',
  `// 由 scripts/sync-bank-logos.mjs 生成，勿手改。图标来自 https://github.com/icongo/bank-logos（MIT）
// 银行中文名 → app/public/banks 下的文件名；按名称长度降序，先匹配更具体的名字
export const BANKS: ReadonlyArray<readonly [string, string]> = [
${body}
];
`,
);
console.log(`银行图标 ${readdirSync('app/public/banks').length - 1} 个，名称映射 ${Object.keys(map).length} 条`);

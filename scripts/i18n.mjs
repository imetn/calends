// 生成 Worker 用的文案入口（shared/locales/server.gen.ts）并检查各语言的键是否齐全。
// 用法：node scripts/i18n.mjs          生成
//       node scripts/i18n.mjs --check  另外列出缺失、多余的键（以 en 为准）
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../shared/locales/', import.meta.url).pathname;
// Worker 端会用到的命名空间：共享逻辑、服务端接口、提醒邮件、MCP、常用服务译名
const SERVER_NS = ['common', 'core', 'server', 'notify', 'mcp', 'catalog'];

const locales = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const lines = ['// 由 scripts/i18n.mjs 生成，请勿手改', "import type { MessageTree } from '../i18n.ts';"];
const table = [];
let i = 0;
for (const loc of locales) {
  const entries = [];
  for (const ns of SERVER_NS) {
    if (!existsSync(join(ROOT, loc, `${ns}.json`))) continue;
    const id = `m${i++}`;
    lines.push(`import ${id} from './${loc}/${ns}.json';`);
    entries.push(`${JSON.stringify(ns)}: ${id} as MessageTree`);
  }
  table.push(`  ${JSON.stringify(loc)}: { ${entries.join(', ')} },`);
}
lines.push('', 'export const SERVER_MESSAGES: Record<string, Record<string, MessageTree>> = {', ...table, '};', '');
writeFileSync(join(ROOT, 'server.gen.ts'), lines.join('\n'));

// 内置分类在各语言里的名字：不同语言下建的分类（如「游戏」「Games」「Spiele」）都能认回同一个预设
const aliases = {};
for (const loc of locales) {
  const file = join(ROOT, loc, 'core.json');
  if (!existsSync(file)) continue;
  for (const [code, name] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).category ?? {})) {
    if (typeof name !== 'string') continue;
    (aliases[code] ??= new Set()).add(name);
  }
}
const aliasObj = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, [...v].sort()]));
writeFileSync(
  join(ROOT, 'categories.gen.ts'),
  `// 由 scripts/i18n.mjs 生成，请勿手改\nexport const CATEGORY_ALIASES: Record<string, string[]> = ${JSON.stringify(aliasObj)};\n`,
);

// 常用服务在各语言里的译名：无论用户用英文还是繁简体搜索/新建都能认回同一条目
const catalogAliases = {};
for (const loc of locales) {
  const file = join(ROOT, loc, 'catalog.json');
  if (!existsSync(file)) continue;
  for (const [code, name] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).name ?? {})) {
    if (typeof name !== 'string') continue;
    (catalogAliases[code] ??= new Set()).add(name);
  }
}
const catalogAliasObj = Object.fromEntries(Object.entries(catalogAliases).map(([k, v]) => [k, [...v].sort()]));
writeFileSync(
  join(ROOT, 'catalog-aliases.gen.ts'),
  `// 由 scripts/i18n.mjs 生成，请勿手改\nexport const CATALOG_ALIASES: Record<string, string[]> = ${JSON.stringify(catalogAliasObj)};\n`,
);

if (process.argv.includes('--check')) {
  const keys = (tree, prefix = '', out = new Set()) => {
    for (const [k, v] of Object.entries(tree)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' || Object.keys(v).every((x) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(x))) out.add(p);
      else keys(v, p, out);
    }
    return out;
  };
  const load = (loc) => {
    const all = new Set();
    for (const f of readdirSync(join(ROOT, loc)).filter((f) => f.endsWith('.json')))
      for (const k of keys(JSON.parse(readFileSync(join(ROOT, loc, f), 'utf8')), f.slice(0, -5))) all.add(k);
    return all;
  };
  const en = load('en');
  let bad = 0;
  for (const loc of locales) {
    const have = load(loc);
    const missing = [...en].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !en.has(k));
    if (missing.length || extra.length) bad++;
    console.log(
      `${loc.padEnd(6)} ${have.size} keys · missing ${missing.length} · extra ${extra.length}${missing.length ? '\n  - ' + missing.slice(0, 10).join('\n  - ') : ''}${extra.length ? '\n  + ' + extra.slice(0, 10).join('\n  + ') : ''}`,
    );
  }
  // 代码里写死的文案键（t('a.b.c')）必须在语言文件里存在：各语言之间互相比对发现不了「大家都漏了」
  const used = new Map();
  const scan = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) {
        if (f.name !== 'node_modules' && f.name !== 'locales') scan(p);
      } else if (/\.(ts|tsx)$/.test(f.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) if (!used.has(m[1])) used.set(m[1], p);
      }
    }
  };
  for (const d of ['app/src', 'worker', 'shared']) scan(join(ROOT, '..', '..', d));
  const zh = load('zh-CN');
  const unknown = [...used].filter(([k]) => !zh.has(k) && k !== 'ns.key');
  if (unknown.length) {
    bad++;
    console.log(`code   ${unknown.length} keys used in code but missing in locales\n${unknown.map(([k, f]) => `  ! ${k}  (${f})`).join('\n')}`);
  }
  process.exitCode = bad ? 1 : 0;
}

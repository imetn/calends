import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOG_ALIASES } from './locales/catalog-aliases.gen.ts';
import { EXACT_ALIASES, exactServices, searchServices, serviceDisplayName, type ServiceEntry } from './service-catalog.ts';
import { SERVICE_PACKS } from '../worker/ai/service-packs.gen.ts';

const SERVICES: ServiceEntry[] = SERVICE_PACKS.flat();

test('service-packs.gen.ts stays in sync with app/src/catalog/*.ts and has no exact-match collisions', () => {
  const files = readdirSync(new URL('../app/src/catalog/', import.meta.url))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const gen = readFileSync(new URL('../worker/ai/service-packs.gen.ts', import.meta.url), 'utf8');
  const imported = [...gen.matchAll(/from '\.\.\/\.\.\/app\/src\/catalog\/([^']+\.ts)'/g)].map((m) => m[1]);
  assert.deepEqual(imported, files);
  assert.equal(SERVICE_PACKS.length, files.length);

  const byFile = new Map(SERVICES.map((e) => [e.file, e]));
  for (const file of Object.keys(EXACT_ALIASES)) {
    assert.ok(byFile.has(file), `EXACT_ALIASES key "${file}" does not match any catalog entry`);
  }

  for (const entry of SERVICES) {
    assert.deepEqual(
      exactServices(SERVICES, entry.name).map((x) => x.name),
      [entry.name],
      `exact match for ${entry.name} should be unique`,
    );
    const localized = entry.localized && entry.file ? (CATALOG_ALIASES[entry.file] ?? []) : [];
    const safe = entry.file ? (EXACT_ALIASES[entry.file] ?? []) : [];
    for (const alias of [...localized, ...safe]) {
      assert.deepEqual(
        exactServices(SERVICES, alias).map((x) => x.name),
        [entry.name],
        `safe/localized alias "${alias}" on ${entry.name} collides with another service`,
      );
      assert.ok(
        searchServices(SERVICES, alias).some((x) => x.name === entry.name),
        `safe/localized alias "${alias}" on ${entry.name} should remain searchable`,
      );
    }
  }
});

test('vendor names and generic aka terms stay in suggestions only and never trigger exact auto-fill', () => {
  const suggestionOnly: Array<[string, string]> = [
    ['Vercel', 'v0'],
    ['Domain', 'Cloudflare Registrar'],
    ['域名', 'Cloudflare Registrar'],
    ['Cloudflare', 'Cloudflare Registrar'],
    ['Apple', 'Apple App Store'],
    ['App Store', 'Apple App Store'],
    ['苹果订阅', 'Apple App Store'],
    ['Copilot', 'GitHub Copilot'],
    ['Copilot Pro', 'Microsoft Copilot'],
    ['OpenAI', 'ChatGPT'],
    ['Anthropic', 'Claude'],
    ['GPT', 'ChatGPT'],
    ['字节', '豆包'],
    ['海螺', 'MiniMax'],
    ['流程图', 'ProcessOn'],
    ['SSH 客户端', 'Termius'],
    ['开发者证书', 'Apple 开发者'],
    ['JD', '京东 Plus'],
    ['京东', '京东 Plus'],
    ['淘宝', '淘宝 88VIP'],
    ['天猫', '淘宝 88VIP'],
    ['银联', '云闪付会员'],
    ['YouTube', 'YouTube Premium'],
  ];
  for (const [query, suggested] of suggestionOnly) {
    assert.deepEqual(exactServices(SERVICES, query), [], `"${query}" must not trigger exact auto-fill`);
    assert.ok(
      searchServices(SERVICES, query).some((x) => x.name === suggested),
      `"${query}" should still suggest ${suggested}`,
    );
  }
});

test('searchServices and exactServices normalize width/punctuation, rank exact > prefix > contains, and handle CJK vs ASCII lengths', () => {
  assert.deepEqual(searchServices(SERVICES, '   '), []);
  assert.deepEqual(searchServices(SERVICES, '---'), []);
  assert.deepEqual(exactServices(SERVICES, '   '), []);

  // Full-width / punctuation normalization and safe aliases
  assert.equal(exactServices(SERVICES, 'Ｇｅｍｉｎｉ')[0]?.name, 'Gemini');
  assert.equal(exactServices(SERVICES, 'iCloud＋')[0]?.name, 'iCloud+');
  assert.equal(exactServices(SERVICES, 'Chat-GPT Plus')[0]?.name, 'ChatGPT');
  assert.equal(exactServices(SERVICES, 'Office 365')[0]?.name, 'Microsoft 365');
  assert.equal(exactServices(SERVICES, 'B站')[0]?.file, 'bilibili');

  // Localized aliases (en / zh-TW) resolve to the same entry
  assert.equal(exactServices(SERVICES, 'Kling AI')[0]?.file, 'kling');
  assert.equal(exactServices(SERVICES, 'Tencent Yuanbao')[0]?.file, 'yuanbao');
  assert.equal(exactServices(SERVICES, 'Hailuo AI')[0]?.file, 'hailuo');
  assert.equal(exactServices(SERVICES, '通義千問')[0]?.file, 'qwen');

  // 2-character CJK names match queries with plan suffixes; 2-character ASCII aliases do not reverse-contain
  assert.equal(searchServices(SERVICES, '优酷 VIP')[0]?.name, '优酷');
  assert.equal(searchServices(SERVICES, '豆包 Pro')[0]?.name, '豆包');
  assert.equal(searchServices(SERVICES, '可灵会员')[0]?.file, 'kling');
  assert.equal(searchServices(SERVICES, '得到会员')[0]?.name, '得到');
  assert.deepEqual(searchServices(SERVICES, 'jd plus'), []);
  assert.deepEqual(searchServices(SERVICES, 'nvidia'), []);
  assert.deepEqual(searchServices(SERVICES, 'majestic'), []);

  // Ranking: exact > prefix > contains
  const sample: ServiceEntry[] = [
    { name: 'SuperPro', aka: ['mypro'], cat: 'tools', url: 'https://a.test', icon: '/a.svg' },
    { name: 'ProMax', aka: [], cat: 'tools', url: 'https://b.test', icon: '/b.svg' },
    { name: 'Pro', aka: [], cat: 'tools', url: 'https://c.test', icon: '/c.svg' },
  ];
  assert.deepEqual(
    searchServices(sample, 'pro', 8, {}, {}).map((x) => x.name),
    ['Pro', 'ProMax', 'SuperPro'],
  );

  // Ambiguous exact matches return all candidates
  const dup: ServiceEntry[] = [
    { name: 'Alpha', file: 'alpha', aka: [], cat: 'tools', url: 'https://a.test', icon: '/a.svg' },
    { name: 'Beta', file: 'beta', aka: [], cat: 'tools', url: 'https://b.test', icon: '/b.svg' },
  ];
  assert.deepEqual(
    exactServices(dup, 'Shared', {}, { alpha: ['shared'], beta: ['shared'] }).map((x) => x.name),
    ['Alpha', 'Beta'],
  );

  // Localized display name helper falls back when key is missing or entry is not localized
  const qwen = SERVICES.find((s) => s.file === 'qwen')!;
  const gemini = SERVICES.find((s) => s.name === 'Gemini')!;
  assert.equal(
    serviceDisplayName(qwen, (k) => (k === 'catalog.name.qwen' ? 'Qwen' : k)),
    'Qwen',
  );
  assert.equal(
    serviceDisplayName(qwen, (k) => k),
    '通义千问',
  );
  assert.equal(
    serviceDisplayName(gemini, () => 'Wrong'),
    'Gemini',
  );
});

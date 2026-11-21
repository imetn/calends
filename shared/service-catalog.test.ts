import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exactServices, searchServices, serviceDisplayName, type ServiceEntry } from './service-catalog.ts';
import { SERVICE_PACKS } from '../worker/ai/service-packs.gen.ts';

const SERVICES: ServiceEntry[] = SERVICE_PACKS.flat();

test('service-packs.gen.ts stays in sync with app/src/catalog/*.ts and has no alias collisions', () => {
  const files = readdirSync(new URL('../app/src/catalog/', import.meta.url))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const gen = readFileSync(new URL('../worker/ai/service-packs.gen.ts', import.meta.url), 'utf8');
  const imported = [...gen.matchAll(/from '\.\.\/\.\.\/app\/src\/catalog\/([^']+\.ts)'/g)].map((m) => m[1]);
  assert.deepEqual(imported, files);
  assert.equal(SERVICE_PACKS.length, files.length);

  for (const entry of SERVICES) {
    assert.deepEqual(
      exactServices(SERVICES, entry.name).map((x) => x.name),
      [entry.name],
      `exact match for ${entry.name} should be unique`,
    );
    for (const alias of entry.aka) {
      assert.deepEqual(
        exactServices(SERVICES, alias).map((x) => x.name),
        [entry.name],
        `alias "${alias}" on ${entry.name} collides with another service`,
      );
    }
  }
});

test('searchServices and exactServices normalize width/punctuation, rank exact > prefix > contains, and handle CJK vs ASCII lengths', () => {
  assert.deepEqual(searchServices(SERVICES, '   '), []);
  assert.deepEqual(searchServices(SERVICES, '---'), []);
  assert.deepEqual(exactServices(SERVICES, '   '), []);

  // Full-width / punctuation normalization
  assert.equal(exactServices(SERVICES, 'Ｇｅｍｉｎｉ')[0]?.name, 'Gemini');
  assert.equal(exactServices(SERVICES, 'iCloud＋')[0]?.name, 'iCloud+');
  assert.equal(exactServices(SERVICES, 'Chat-GPT Plus')[0]?.name, 'ChatGPT');

  // Localized aliases (en / zh-TW) resolve to the same entry
  assert.equal(exactServices(SERVICES, 'Kling AI')[0]?.file, 'kling');
  assert.equal(exactServices(SERVICES, 'Tencent Yuanbao')[0]?.file, 'yuanbao');
  assert.equal(exactServices(SERVICES, 'Hailuo AI')[0]?.file, 'hailuo');
  assert.equal(exactServices(SERVICES, '通義千問')[0]?.file, 'qwen');

  // 2-character CJK names match queries with plan suffixes; 2-character ASCII aliases do not false-match
  assert.equal(searchServices(SERVICES, '优酷 VIP')[0]?.name, '优酷');
  assert.equal(searchServices(SERVICES, '豆包 Pro')[0]?.name, '豆包');
  assert.equal(searchServices(SERVICES, '可灵会员')[0]?.file, 'kling');
  assert.equal(searchServices(SERVICES, '得到会员')[0]?.name, '得到');
  assert.deepEqual(searchServices(SERVICES, 'nvidia'), []);
  assert.deepEqual(searchServices(SERVICES, 'majestic'), []);

  // Ranking: exact > prefix > contains
  const sample: ServiceEntry[] = [
    { name: 'SuperPro', aka: ['mypro'], cat: 'tools', url: 'https://a.test', icon: '/a.svg' },
    { name: 'ProMax', aka: [], cat: 'tools', url: 'https://b.test', icon: '/b.svg' },
    { name: 'Pro', aka: [], cat: 'tools', url: 'https://c.test', icon: '/c.svg' },
  ];
  assert.deepEqual(
    searchServices(sample, 'pro', 8, {}).map((x) => x.name),
    ['Pro', 'ProMax', 'SuperPro'],
  );

  // Ambiguous exact matches return all candidates
  const dup: ServiceEntry[] = [
    { name: 'Alpha', aka: ['shared'], cat: 'tools', url: 'https://a.test', icon: '/a.svg' },
    { name: 'Beta', aka: ['shared'], cat: 'tools', url: 'https://b.test', icon: '/b.svg' },
  ];
  assert.deepEqual(
    exactServices(dup, 'Shared', {}).map((x) => x.name),
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

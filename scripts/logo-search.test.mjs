import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'oxc-transform-react';

function harness(fail = false) {
  const source = readFileSync(new URL('../worker/ai/logo-search.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const compiled = transformSync('logo-search.ts', source, { lang: 'ts', reactCompiler: false });
  assert.equal(compiled.fatal, false);
  const cache = new Map();
  const requests = [];
  const image = new Uint8Array(24);
  image.set([0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(image.buffer);
  view.setUint32(16, 512);
  view.setUint32(20, 512);
  const network = async (raw) => {
    const url = String(raw);
    requests.push(url);
    if (fail) throw new Error('Fixture network unavailable');
    if (url.endsWith('index.json')) return Response.json([{ Name: 'Notion', Reference: 'notion', PNG: 'Yes' }]);
    if (url.endsWith('tree.json')) return Response.json({ png: ['notion.png'] });
    if (url.includes('bing.com/images')) {
      const meta = JSON.stringify({ murl: 'https://notion.test/result.png', turl: 'https://notion.test/thumb.png', t: 'Notion > logo' }).replaceAll(
        '"',
        '&quot;',
      );
      return new Response(`<a class="iusc" m="${meta}" href="?expw=512&amp;exph=512"></a>`);
    }
    if (url.includes('bing.com/search'))
      return new Response('<li class="b_algo"><h2><a href="https://notion.test/">Notion</a></h2></li>', { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/icon.png')) return new Response(image, { headers: { 'content-type': 'image/png' } });
    if (url === 'https://notion.test/') return new Response('<link rel="apple-touch-icon" href="/icon.png">', { headers: { 'content-type': 'text/html' } });
    throw Error(`Unexpected fixture request ${url}`);
  };
  const deps = {
    getKv: async (_, key) => cache.get(key),
    putKv: async (_, key, value) => cache.set(key, value),
    fetchPublic: network,
    isPublicHttpsUrl: (url) => url.startsWith('https://'),
    fetch: network,
  };
  const search = new Function(...Object.keys(deps), compiled.code.replace(/export /g, '') + '; return searchLogos;')(...Object.values(deps));
  return { search: (q) => search({}, q), requests };
}

test('logo search combines official, library and escaped image results without ledger writes', async () => {
  const h = harness();
  const result = await h.search('notion');
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual([...new Set(result.results.map((h) => h.source))], ['site', 'selfhst', 'dashboard', 'web']);
  assert.equal(result.results[0].url, 'https://notion.test/icon.png');
  assert.equal(result.results[0].width, 512);
  assert.equal(result.results.filter((h) => h.source === 'web').length, 1, 'deduplicate transparent/all image results');
  const before = h.requests.filter((u) => u.endsWith('.json')).length;
  await h.search('notion');
  assert.equal(h.requests.filter((u) => u.endsWith('.json')).length, before, 'cached indexes avoid network refetch');
});

test('source failures remain distinct from a successful empty logo search', async () => {
  const h = harness(true);
  assert.deepEqual(await h.search('notion'), { results: [], unavailable: ['site', 'selfhst', 'dashboard', 'web'] });
});

test('short logo queries do not make network requests', async () => {
  const h = harness();
  assert.deepEqual(await h.search('x'), { results: [], unavailable: [] });
  assert.deepEqual(h.requests, []);
});

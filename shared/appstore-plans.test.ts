import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guessCycle, parseAppStorePlans, parsePrice } from './appstore-plans.ts';

const page = (data: unknown) => `<html><script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script></html>`;
const pair = (leadingText: string, trailingText: string) => ({ $kind: 'textPair', leadingText, trailingText });

test('App Store plans come from the textPair annotation regardless of its localized title', () => {
  const html = page({
    data: [
      {
        shelves: [
          { $kind: 'Annotation', title: 'Languages', items: [{ $kind: 'linkableText', text: 'English' }] },
          {
            $kind: 'Annotation',
            title: 'App内购买',
            summary: '是',
            items: [pair('连续包月 ', '¥25.00'), pair('年度会员', '¥238.00'), pair('连续包月', '¥25.00')],
          },
        ],
      },
    ],
  });
  assert.deepEqual(parseAppStorePlans(html), [
    { name: '连续包月', priceText: '¥25.00', price: 25, cycle: { unit: 'month', every: 1 } },
    { name: '年度会员', priceText: '¥238.00', price: 238, cycle: { unit: 'year', every: 1 } },
  ]);
});

test('missing or broken page data yields no plans instead of zero prices', () => {
  assert.deepEqual(parseAppStorePlans('<html></html>'), []);
  assert.deepEqual(parseAppStorePlans('<script id="serialized-server-data">{broken</script>'), []);
  assert.deepEqual(parseAppStorePlans(page({ data: [pair('Pro', 'Free')] })), []);
  assert.equal(parsePrice('Free'), undefined);
  assert.equal(parsePrice('$0.00'), undefined);
});

test('store price strings parse across separators and locales', () => {
  assert.equal(parsePrice('$19.99'), 19.99);
  assert.equal(parsePrice('22,99 €'), 22.99);
  assert.equal(parsePrice('₺999,99'), 999.99);
  assert.equal(parsePrice('¥3,000'), 3000);
  assert.equal(parsePrice('Rp 299.000'), 299000);
  assert.equal(parsePrice('1.299,00 TL'), 1299);
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice('₩1,100,000'), 1100000);
});

test('plan names map to cycles only when the period is recognizable', () => {
  assert.deepEqual(guessCycle('ChatGPT Plus Monthly'), { unit: 'month', every: 1 });
  assert.deepEqual(guessCycle('Premium Annual'), { unit: 'year', every: 1 });
  assert.deepEqual(guessCycle('12 months'), { unit: 'year', every: 1 });
  assert.deepEqual(guessCycle('3个月会员'), { unit: 'month', every: 3 });
  assert.deepEqual(guessCycle('6 Monate'), { unit: 'month', every: 6 });
  assert.deepEqual(guessCycle('连续包季'), { unit: 'month', every: 3 });
  assert.deepEqual(guessCycle('Weekly Pro'), { unit: 'week', every: 1 });
  assert.deepEqual(guessCycle('Lifetime'), { unit: 'lifetime', every: 1 });
  assert.equal(guessCycle('ChatGPT Plus'), undefined);
  assert.equal(guessCycle('100 Credits'), undefined);
  assert.equal(guessCycle('7 days free'), undefined);
});

test('a long App Store link with a percent-encoded name still looks up by its id', async () => {
  const { searchAppStore } = await import('../worker/appstore.ts');
  const saved = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return Response.json({ results: [{ trackId: 1642682818, trackName: 'Panda', artworkUrl100: 'icon', trackViewUrl: 'url' }] });
  }) as typeof fetch;
  try {
    const link =
      'https://apps.apple.com/us/app/%E7%86%8A%E7%8C%AB%E5%90%83%E7%9F%AD%E4%BF%A12-%E5%9E%83%E5%9C%BE%E7%9F%AD%E4%BF%A1%E6%8B%A6%E6%88%AA/id1642682818';
    const hits = await searchAppStore(link, 'us');
    assert.equal(asked[0], 'https://itunes.apple.com/lookup?id=1642682818&country=us');
    assert.equal(hits[0]?.name, 'Panda');
  } finally {
    globalThis.fetch = saved;
  }
});

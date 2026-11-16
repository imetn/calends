import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { LOCALES, TRANSLATED_LOCALES, fallbackChain, isLocale, locale, matchLocale, t } from './i18n.ts';

const LOCALE_DIR = new URL('./locales/', import.meta.url);

test('English (Australia) follows English in the picker with the AU flag', () => {
  const codes = LOCALES.map((l) => l.code);
  assert.equal(codes.indexOf('en-AU'), codes.indexOf('en') + 1);
  assert.deepEqual(
    LOCALES.find((l) => l.code === 'en-AU'),
    { code: 'en-AU', name: 'English (Australia)', flag: 'au' },
  );
  assert.ok(isLocale('en-AU'));
  assert.ok(existsSync(new URL('../app/public/flags/au.png', import.meta.url)));
});

test('en-AU reuses English messages through the fallback chain instead of its own files', () => {
  assert.deepEqual(fallbackChain('en-AU'), ['en-AU', 'en']);
  assert.deepEqual(fallbackChain('zh-HK'), ['zh-HK', 'zh-TW', 'zh-CN', 'en']);
  assert.deepEqual(fallbackChain('en'), ['en']);
  assert.equal(existsSync(new URL('en-AU', LOCALE_DIR)), false);
  // 文案目录与「有自己文案」的语言一一对应；每种语言的回退链都能落到一份有文案的语言
  const dirs = readdirSync(LOCALE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(TRANSLATED_LOCALES.map((l) => l.code).sort(), dirs);
  for (const { code } of LOCALES)
    assert.ok(
      fallbackChain(code).some((l) => dirs.includes(l)),
      code,
    );
});

test('browser and Accept-Language preferences pick en-AU only for Australian English', () => {
  assert.equal(matchLocale(['en-AU']), 'en-AU');
  assert.equal(matchLocale(['en-au', 'en']), 'en-AU');
  assert.equal(matchLocale('en-AU,en;q=0.9'.split(',')), 'en-AU');
  assert.equal(matchLocale(['en-US']), 'en');
  assert.equal(matchLocale(['en-GB']), 'en');
  assert.equal(matchLocale(['en']), 'en');
  assert.equal(matchLocale(['zh-HK']), 'zh-HK');
});

test('Worker requests in en-AU get English messages and keep the en-AU locale for formatting', async () => {
  // Worker 打包时 JSON 直接导入；Node 测试里把 JSON 当模块加载
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
      return next(url, ctx);
    },
  });
  const { applyLocale, requestLocale, settingsLocale, withLocaleScope } = await import('../worker/i18n.ts');
  hook.deregister();
  const settings = { language: undefined, languageSeen: undefined };
  assert.equal(requestLocale(new Request('https://x.test', { headers: { 'x-locale': 'en-AU' } }), settings), 'en-AU');
  assert.equal(requestLocale(new Request('https://x.test', { headers: { 'accept-language': 'en-AU,en;q=0.8' } }), settings), 'en-AU');
  assert.equal(settingsLocale({ language: 'en-AU' }), 'en-AU');
  withLocaleScope(() => {
    applyLocale('en');
    const en = t('core.bill.m1');
    applyLocale('en-AU');
    assert.equal(locale(), 'en-AU');
    assert.notEqual(en, 'core.bill.m1');
    assert.equal(t('core.bill.m1'), en);
  });
});

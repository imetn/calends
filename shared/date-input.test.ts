import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseDateInput } from './date-input.ts';
import { dateOrder, datePattern, numericDate } from './format.ts';
import { LOCALES, setLocale } from './i18n.ts';

afterEach(() => setLocale('en', []));

test('manual dates accept leap day and year-first formats in every locale order', () => {
  for (const order of ['ymd', 'dmy', 'mdy'] as const) {
    assert.equal(parseDateInput('2024-02-29', order), '2024-02-29');
    assert.equal(parseDateInput('2026-10-24', order), '2026-10-24');
    assert.equal(parseDateInput('2026/10/24', order), '2026-10-24');
    assert.equal(parseDateInput('2026年10月24日', order), '2026-10-24');
    assert.equal(parseDateInput('2026. 10. 24.', order), '2026-10-24');
    assert.equal(parseDateInput('20261024', order), '2026-10-24');
    assert.equal(parseDateInput('2026/2/3', order), '2026-02-03');
  }
});

test('issue #20: a trailing year follows the locale order (19/11/2026 in en-AU, 11/19/2026 in en-US)', () => {
  assert.equal(parseDateInput('19/11/2026', 'dmy'), '2026-11-19');
  assert.equal(parseDateInput('19.11.2026', 'dmy'), '2026-11-19');
  assert.equal(parseDateInput('11/19/2026', 'mdy'), '2026-11-19');
  assert.equal(parseDateInput('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(parseDateInput('03/04/2026', 'mdy'), '2026-03-04');
  assert.equal(parseDateInput('19/11/2026', 'mdy'), undefined);
  assert.equal(parseDateInput('19/11/2026', 'ymd'), undefined);
});

test('manual dates reject impossible calendar dates and unsupported formats', () => {
  for (const input of [
    '',
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026102',
    '26/11/19',
    '2026-11',
    '2026-011-19',
    'Nov 19 2026',
    '0099-01-01',
  ]) {
    assert.equal(parseDateInput(input, 'dmy'), undefined, input);
  }
});

test('issue #20: the inline editor prefills the locale numeric date and reads it back in every locale', () => {
  const expected: Record<string, [string, string]> = {
    'en-AU': ['dmy', 'DD/MM/YYYY'],
    en: ['mdy', 'MM/DD/YYYY'],
    'zh-CN': ['ymd', 'YYYY/MM/DD'],
    de: ['dmy', 'DD.MM.YYYY'],
  };
  for (const { code } of LOCALES) {
    setLocale(code, []);
    for (const day of ['2026-11-19', '2026-03-04', '2024-02-29', '1999-12-31']) {
      assert.equal(parseDateInput(numericDate(day, { year: true }), dateOrder()), day, `${code} ${day}`);
    }
    if (expected[code]) assert.deepEqual([dateOrder(), datePattern()], expected[code], code);
  }
  setLocale('en-AU', []);
  assert.equal(numericDate('2026-11-19', { year: true }), '19/11/2026');
});

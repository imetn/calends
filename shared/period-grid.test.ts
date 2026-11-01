import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { LOCALES, flatten, setLocale, t } from './i18n.ts';
import assert from 'node:assert/strict';
import { addDays, addMonths } from './billing.ts';
import { periodGrid, periodGridMode, periodTipData, visibleStripPeriods } from './period-grid.ts';
import { settle, type LedgerPeriod } from './receivables.ts';
const schedule = (from: string, months: number, count: number): LedgerPeriod[] =>
  Array.from({ length: count }, (_, i) => {
    const start = addMonths(from, i * months);
    return { key: start, from: start, until: addDays(addMonths(from, (i + 1) * months), -1), due: 10, currency: 'CNY', status: 'due' };
  });
const segments = (list: LedgerPeriod[]) => periodGrid(list, '2099-01-01').rows.flatMap((r) => r.segments);
test('月付三年不截断，首末年留白；没有改动输入', () => {
  const periods = schedule('2024-07-17', 1, 36);
  const frozen = JSON.stringify(periods);
  const grid = periodGrid(periods, '2026-10-26');
  assert.equal(grid.mode, 'months');
  assert.deepEqual(
    grid.rows.map((r) => [r.year, r.segments.length]),
    [
      [2024, 6],
      [2025, 12],
      [2026, 11],
    ],
  );
  assert.equal(grid.rows[0].segments[0].column, 6);
  assert.ok(grid.rows.flatMap((r) => r.segments).every((s) => s.span === 1));
  assert.equal(JSON.stringify(periods), frozen);
});
test('季付、非月初半年付：连续区块不抢相邻月份', () => {
  for (const months of [3, 6]) {
    const grid = periodGrid(schedule('2020-07-17', months, 13), '2099-01-01');
    assert.equal(grid.mode, 'months');
    assert.equal(grid.rows[0].segments[0].column, 6);
    assert.equal(grid.rows[0].segments[0].span, months);
    for (const row of grid.rows) {
      const cells = row.segments.flatMap((s) => Array.from({ length: s.span }, (_, i) => s.column + i));
      assert.equal(new Set(cells).size, cells.length);
    }
  }
});
test('年付、两年付与跨年：只有真正两端圆角', () => {
  const annual = segments(schedule('2024-01-01', 12, 2));
  assert.deepEqual(
    annual.map((s) => [s.span, s.start, s.end]),
    [
      [12, true, true],
      [12, true, true],
    ],
  );
  const twoYear = segments(schedule('2024-07-17', 24, 2)).filter((s) => s.period.key === '2024-07-17');
  assert.deepEqual(
    twoYear.map((s) => [s.column, s.span, s.start, s.end]),
    [
      [6, 6, true, false],
      [0, 12, false, false],
      [0, 6, false, true],
    ],
  );
  assert.deepEqual(
    segments(schedule('2024-10-17', 6, 2))
      .slice(0, 2)
      .map((s) => [s.span, s.start, s.end]),
    [
      [3, true, false],
      [3, false, true],
    ],
  );
});
test('最后一期用结束月；无下一期信息时仍保留实际覆盖', () => {
  const p = schedule('2026-07-17', 6, 1);
  assert.deepEqual(
    segments(p).map((s) => [s.column, s.span]),
    [
      [6, 6],
      [0, 1],
    ],
  );
  p[0].until = '2026-10-26';
  assert.deepEqual(
    periodGrid(p, '2099-01-01', 'months')
      .rows.flatMap((r) => r.segments)
      .map((s) => [s.column, s.span]),
    [[6, 4]],
  );
});
test('提前预收的各期都展示、再多一期未收的；中间两期欠款、免收和免费保持各自状态', () => {
  const periods = schedule('2024-01-01', 1, 38);
  periods[0].due = 0;
  const keys = periods.filter((_, i) => ![0, 8, 9, 10].includes(i)).map((p) => p.key);
  const ledger = settle(
    periods,
    {
      receipts: [{ id: 'r', date: '2026-10-01', amount: 340, currency: 'CNY', periods: keys }],
      waivers: [{ id: 'w', date: '2024-11-01', periods: [periods[10].key], note: 'Fictional waiver' }],
    },
    '2026-10-26',
  ).periods;
  const shown = visibleStripPeriods(ledger, '2026-10-26');
  // 预收的未来各期都画出来；全部预收完就没有下一期未收的
  assert.equal(shown.at(-1)?.from, '2027-02-01');
  assert.equal(shown.at(-1)?.status, 'paid');
  // 后面还有没收的期时，只多画第一期
  const more = settle(
    schedule('2024-01-01', 1, 40),
    { receipts: [{ id: 'r', date: '2026-10-01', amount: 340, currency: 'CNY', periods: keys }] },
    '2026-10-26',
  ).periods;
  assert.deepEqual(
    visibleStripPeriods(more, '2026-10-26')
      .slice(-2)
      .map((p) => [p.from, p.status]),
    [
      ['2027-02-01', 'paid'],
      ['2027-03-01', 'upcoming'],
    ],
  );
  assert.deepEqual(
    shown.slice(8, 11).map((p) => p.status),
    ['due', 'due', 'waived'],
  );
  assert.equal(shown[0].status, 'free');
  assert.equal(periodTipData(shown.at(-1)!).receipt?.count, keys.length);
  assert.equal(periodTipData(shown[10]).note, 'Fictional waiver');
});
test('周付每行13格、跨年仍保留每一期；日付与非整数月按年分行逐期排列', () => {
  const weeks = Array.from({ length: 60 }, (_, i) => {
    const from = addDays('2025-12-01', i * 7);
    return { key: from, from, until: addDays(from, 6), due: 5, currency: 'USD', status: 'due' as const };
  });
  const grid = periodGrid(weeks, '2099-01-01');
  assert.equal(grid.mode, 'weeks');
  assert.equal(grid.columns, 13);
  assert.equal(grid.rows[0].quarter, 4);
  assert.equal(grid.rows[1].year, 2026);
  assert.equal(grid.rows.flatMap((r) => r.segments).length, 60);
  assert.ok(grid.rows.every((r) => r.segments.length <= 13 && r.segments.every((s) => s.column < 13)));
  for (const days of [1, 10, 45]) {
    const list = weeks.map((p, i) => ({
      ...p,
      key: addDays('2026-01-01', i * days),
      from: addDays('2026-01-01', i * days),
      until: addDays('2026-01-01', (i + 1) * days - 1),
    }));
    assert.equal(periodGridMode(list), 'periods');
    // 按年分行、标年份，每行至多 12 格，一期不丢；同一年的行不和下一年混排
    const rows = periodGrid(list, '2099-01-01').rows;
    assert.equal(rows.flatMap((r) => r.segments).length, 60);
    assert.ok(rows.every((r) => r.year != null && r.segments.length <= 12 && r.segments.every((seg) => Number(seg.period.from.slice(0, 4)) === r.year)));
  }
  assert.deepEqual(periodGrid([], '2026-01-01').rows, []);
});
test('提示保留原币应收、这一期分到的实收、整笔金额、日期、抵扣期数及期初标记', () => {
  const p = schedule('2026-01-01', 1, 1)[0];
  p.receipt = { id: 'r', date: '2025-12-15', amount: 25, currency: 'USD', periods: [p.key, '2026-02-01'], note: 'Advance' };
  p.share = 12.5;
  p.status = 'paid';
  assert.deepEqual(periodTipData(p), {
    from: p.from,
    until: p.until,
    due: 10,
    currency: 'CNY',
    status: 'paid',
    receipt: { date: '2025-12-15', amount: 25, share: 12.5, currency: 'USD', count: 2, opening: false },
    note: 'Advance',
  });
  p.receipt.opening = true;
  assert.equal(periodTipData(p).receipt?.opening, true);
});

test('14种语言的年、季度与应收提示文案齐全，汉字年份仅限中日文', () => {
  for (const { code } of LOCALES) {
    const messages = JSON.parse(readFileSync(new URL(`./locales/${code}/receivable.json`, import.meta.url), 'utf8'));
    setLocale(code, [flatten('receivable', messages)]);
    const cjk = code.startsWith('zh') || code === 'ja';
    assert.equal(t('receivable.grid.year', { year: 2026 }), cjk ? '2026年' : '2026');
    assert.equal(t('receivable.grid.quarter', { year: 2026, quarter: 1 }), cjk ? '2026年第1季' : '2026 Q1');
    assert.ok(t('receivable.grid.due').length > 0 && !t('receivable.grid.due').includes('receivable.'));
  }
});

test('月内重启的两段不能静默漏掉：同一个月里各占半格，后面的期不顺延', () => {
  const periods = schedule('2026-07-17', 1, 3);
  periods.splice(1, 0, { ...periods[0], key: '2026-07-20', from: '2026-07-20', until: '2026-08-16' });
  periods[0].until = '2026-07-19';
  const grid = periodGrid(periods, '2026-10-26', 'months');
  // 同在 7 月的两期各占半格，8、9 月照旧在自己的月份上，不顺延
  assert.equal(grid.mode, 'months');
  assert.deepEqual(
    grid.rows.flatMap((r) => r.segments).map((seg) => [seg.period.from, seg.track, seg.tracks]),
    [
      ['2026-07-17', 12, 1],
      ['2026-07-20', 13, 1],
      ['2026-08-17', 14, 2],
      ['2026-09-17', 16, 4],
    ],
  );
});

test('改过收费后同一个月切出两期：仍按月排、标年份，短的一期占前半格', () => {
  const list = [
    { from: '2021-10-14', until: '2022-01-09' },
    { from: '2022-01-10', until: '2022-01-16' },
    { from: '2022-01-17', until: '2022-07-16' },
    { from: '2022-07-17', until: '2023-01-16' },
  ].map((p) => ({ ...p, key: p.from, due: 10, currency: 'USD', status: 'paid' as const }));
  const grid = periodGrid(list, '2023-01-01');
  assert.equal(grid.mode, 'months');
  assert.deepEqual(
    grid.rows.map((r) => [r.year, r.segments.map((seg) => [seg.period.from, seg.track, seg.tracks])]),
    [
      [2021, [['2021-10-14', 18, 6]]],
      [
        2022,
        [
          ['2022-01-10', 0, 1],
          ['2022-01-17', 1, 11],
          ['2022-07-17', 12, 12],
        ],
      ],
      [2023, [['2022-07-17', 0, 2]]],
    ],
  );
});

test('30 天周期不等于自然月，不能因部分区间恰逢 30 天月份而误判', () => {
  const periods = Array.from({ length: 18 }, (_, i) => {
    const from = addDays('2024-01-15', i * 30);
    return { key: from, from, until: addDays(from, 29), due: 10, currency: 'CNY', status: 'due' as const };
  });
  const grid = periodGrid(periods, '2099-01-01');
  assert.equal(grid.mode, 'periods');
  assert.equal(grid.rows.length, 2);
  assert.equal(grid.rows.flatMap((r) => r.segments).length, 18);
});

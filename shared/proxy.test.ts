import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX } from './billing.ts';
import { proxyAhead, proxyLedger, proxyRows, proxyTotals, proxyYear } from './proxy.ts';
import { deleteRecord, openPeriods, receivableOf, recordProxyCharge, recordReceipt, recordWaiver } from './receivable-edit.ts';
import { migrateReceivables } from './receivables-legacy.ts';
import { DEFAULT_SETTINGS, type AppState, type Proxy, type Subscription } from './types.ts';

const sub = (proxy: Partial<Proxy> = {}, o: Partial<Subscription> = {}): Subscription => ({
  id: 'p1',
  name: 'Fictional Music',
  category: '娱乐',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-05',
  status: 'active',
  proxy: { forName: 'Alex', ...proxy },
  ...o,
});
const state = (s: Subscription): AppState => ({ subscriptions: [s], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' }, fx: FALLBACK_FX });
const today = '2026-03-20';
const proxy = { kind: 'proxy' } as const;
const receipt = (s: Subscription, periods: string[], amount: number) =>
  recordReceipt(state(s), s, proxy, { id: 'b1', date: '2026-03-18', amount, currency: 'USD', periods }, today).after;

test('提前一个月收下一期：到扣款日前是预收，不算待收', () => {
  const s = receipt(sub(), ['2026-04-05'], 10);
  assert.equal(proxyRows(state(s), s, today).length, 3);
  assert.equal(proxyTotals(proxyRows(state(s), s, today)).open.length, 3);
  assert.deepEqual(
    proxyAhead(state(s), s, today).map((r) => r.date),
    ['2026-04-05'],
  );
  // 到了扣款日，这期就是已收
  const later = proxyRows(state(s), s, '2026-04-06');
  assert.equal(later[0].date, '2026-04-05');
  assert.equal(later[0].receivedBase, 10);
  assert.deepEqual(proxyAhead(state(s), s, '2026-04-06'), []);
});

test('一笔收 12 期：从最早没收的那期起按期均摊，盈亏按各自一份算；删掉整笔各期恢复待收', () => {
  const s0 = sub({ receipts: [{ id: 'r0', date: '2026-01-05', amount: 10, currency: 'USD', periods: ['2026-01-05'] }] });
  const periods = openPeriods(receivableOf(state(s0), s0, proxy, today).periods, 12).map((p) => p.key);
  assert.equal(periods[0], '2026-02-05');
  assert.equal(periods[11], '2027-01-05');
  const s = receipt(s0, periods, 114);
  const totals = proxyTotals(proxyRows(state(s), s, today));
  assert.equal(totals.open.length, 0);
  assert.ok(Math.abs(totals.diff - 2 * -0.5) < 1e-9);
  const ahead = proxyAhead(state(s), s, today);
  assert.equal(ahead.length, 10);
  assert.ok(Math.abs(ahead.reduce((a, r) => a + r.receivedBase!, 0) - 95) < 1e-9);
  const undone = deleteRecord(state(s), s, proxy, 'b1', today).after;
  assert.equal(undone.proxy!.receipts!.length, 1);
  assert.equal(proxyTotals(proxyRows(state(undone), undone, today)).open.length, 2);
});

test('可以跳过前面没收的期、只收后面的期；同一期不能记两次；订阅结束后没有期可收', () => {
  const s0 = recordProxyCharge(sub(), { charge: '2026-02-05', amount: 11 }, today).after;
  // 只收 3 月这期，1、2 月仍欠
  const s = receipt(s0, ['2026-03-05'], 10);
  const rows = proxyRows(state(s), s, today);
  assert.deepEqual(
    rows.map((r) => [r.date, r.status]),
    [
      ['2026-03-05', 'paid'],
      ['2026-02-05', 'due'],
      ['2026-01-05', 'due'],
    ],
  );
  // 实扣修正决定应收：2 月欠 11
  assert.equal(rows[1].due, 11);
  assert.throws(() => recordReceipt(state(s), s, proxy, { id: 'b2', date: today, periods: ['2026-03-05'] }, today), /periodTaken/);
  // 写的日期落在哪一期里就算哪一期：03-06 在 03-05 那期里，同样已收
  assert.throws(() => recordReceipt(state(s), s, proxy, { id: 'b2', date: today, periods: ['2026-03-06'] }, today), /periodTaken/);
  assert.throws(() => recordReceipt(state(s), s, proxy, { id: 'b2', date: today, periods: ['2025-12-01'] }, today), /periodUnknown/);
  const ended = sub({}, { end: '2026-06-01' });
  assert.throws(() => openPeriods(receivableOf(state(ended), ended, proxy, today).periods, 7));
});

test('免收：这期不算欠款，也不算收回；收款金额缺省为各期应收合计', () => {
  const s = recordWaiver(state(sub()), sub(), proxy, { id: 'w1', date: today, periods: ['2026-01-05'] }, today).after;
  const rows = proxyRows(state(s), s, today);
  assert.equal(rows.at(-1)!.status, 'waived');
  const t = proxyTotals(rows);
  assert.equal(t.open.length, 2);
  assert.equal(t.received, 0);
  const paid = recordReceipt(state(s), s, proxy, { id: 'r1', date: today, periods: ['2026-02-05', '2026-03-05'] }, today);
  assert.equal(paid.record.amount, 20);
});

test('旧代付记录转成按期：相近日期对上、多期收款合成一笔、实扣修正保留，钱一笔不丢', () => {
  const raw = sub(
    {},
    {
      proxy: {
        forName: 'Alex',
        entries: [
          // 改过开始日期：记录在 01-03，对上 01-05 这期
          { charge: '2026-01-03', received: 10, receivedCurrency: 'USD', receivedOn: '2026-01-04' },
          { charge: '2026-02-05', charged: 11, chargedCurrency: 'USD' },
          { charge: '2026-03-05', received: 15, receivedCurrency: 'USD', receivedOn: '2026-03-01', batch: { id: 'b', amount: 30, periods: 2 } },
          { charge: '2026-04-05', received: 15, receivedCurrency: 'USD', receivedOn: '2026-03-01', batch: { id: 'b', amount: 30, periods: 2 } },
        ],
      } as never,
    },
  );
  const s = migrateReceivables(raw, 'USD');
  assert.equal(migrateReceivables(s, 'USD'), s);
  assert.equal('entries' in s.proxy!, false);
  assert.deepEqual(
    s.proxy!.receipts!.map((r) => [r.amount, r.periods]),
    [
      [10, ['2026-01-05']],
      [30, ['2026-03-05', '2026-04-05']],
    ],
  );
  assert.deepEqual(s.proxy!.charged, [{ charge: '2026-02-05', amount: 11, currency: 'USD' }]);
  const { periods } = proxyLedger(s, today);
  assert.deepEqual(
    periods.map((p) => p.status),
    ['paid', 'due', 'paid', 'paid'],
  );
});

test('今年代付合计：只算今年扣款的期，盈亏只看已收回的期，没收的计入待收', () => {
  const s = sub({ receipts: [{ id: 'r0', date: '2026-01-06', amount: 12, currency: 'USD', periods: ['2026-01-05'] }] }, { start: '2025-12-05' });
  const y = proxyYear(state(s), today);
  assert.deepEqual(
    y.subs.map((x) => x.id),
    ['p1'],
  );
  // 今年三期（1、2、3 月），去年 12 月那期不计
  assert.equal(y.done.length + y.open.length, 3);
  assert.equal(y.diff, 2);
  assert.equal(y.partial.owed.value, 20);
  assert.deepEqual(proxyYear({ ...state(s), subscriptions: [] }, today).subs, []);
  // 选去年：只剩 12 月那一期
  const last = proxyYear(state(s), today, '2025');
  assert.equal(last.done.length + last.open.length, 1);
});

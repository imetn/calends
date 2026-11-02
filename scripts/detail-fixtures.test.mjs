import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFixtures } from './detail-fixtures.ts';
import { paidThrough } from '../shared/receivables.ts';
import {
  activePhases,
  addDays,
  addMonths,
  chargesBetween,
  effectiveStatus,
  memberAboard,
  memberDues,
  memberLedger,
  nextCharge,
  phaseSubs,
  renewalDates,
  servedTime,
  stopSummary,
  subError,
} from '../shared/billing.ts';
import { convertOn } from '../shared/fx.ts';
import { parseBackup } from '../worker/backup.ts';

const categories = ['周付', '月付', '季付', '半年付', '年付', '两年付', '按天', '买断', '特殊'];
const counts = [
  105,
  36,
  70,
  20,
  12,
  12,
  0,
  12,
  1,
  16,
  12,
  12,
  12,
  8,
  8,
  8,
  2,
  6,
  1,
  6,
  1,
  8,
  2,
  1,
  1,
  undefined,
  1,
  3,
  1,
  13,
  1,
  2,
  0,
  10,
  4,
  12,
  12,
  4,
  13,
  40,
  undefined,
  0,
  1,
];

for (const today of ['2026-10-24', '2028-02-29', '2027-03-31', '2026-01-31', '2028-12-31']) {
  test(`detail fixtures cover every billing scenario on ${today}`, () => {
    const fixture = detailFixtures(today);
    const { backup, cases } = fixture;
    const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
    const again = detailFixtures(today);
    assert.equal(parsed.subscriptions.length, 43);
    assert.deepEqual(cases, again.cases, 'same date, seed and manifest');
    assert.deepEqual(backup.subscriptions, again.backup.subscriptions);
    assert.deepEqual(
      cases.map((c) => c.id),
      detailFixtures('2025-06-15').cases.map((c) => c.id),
      'ids survive date changes',
    );
    assert.equal(new Set(cases.map((c) => c.name)).size, 43);
    assert.deepEqual(
      cases.map((c) => c.case),
      [...Array.from({ length: 38 }, (_, i) => i + 1), 38, 39, 40, 41, 41],
    );
    assert.deepEqual(
      parsed.settings.categories.map((c) => c.name),
      categories,
    );
    assert.deepEqual(fixture.limitations, []);
    const allIds = [
      ...parsed.subscriptions.map((s) => s.id),
      ...parsed.methods.map((m) => m.id),
      ...parsed.subscriptions.flatMap((s) => s.share?.members.map((m) => m.id) ?? []),
    ];
    assert.equal(new Set(allIds).size, allIds.length);
    assert.ok(
      allIds.every((id) => /^[a-z0-9]{12}$/.test(id)),
      'opaque uid-shaped ids',
    );
    const sub = (n) => parsed.subscriptions.find((s) => s.id === cases.find((c) => c.case === n).id);
    const history = (n) => chargesBetween(sub(n), sub(n).start, today, today);
    for (const [i, s] of parsed.subscriptions.entries()) {
      assert.equal(subError(s), undefined, s.name);
      assert.equal(s.name, cases[i].name);
      assert.ok(s.name.includes(' · ') && !/D\d|压力测试/.test(s.name), s.name);
      assert.equal(s.category, cases[i].case === 36 ? '' : s.name.split(' · ')[0]);
      assert.ok(/^\p{Extended_Pictographic}/u.test(s.icon) && !s.icon.includes('http'), s.name);
      assert.ok(cases[i].description.length > 15);
      const rows = chargesBetween(s, s.start, today, today);
      assert.equal(cases[i].expected.records, rows.length, s.name);
      if (counts[i] !== undefined) assert.equal(rows.length, counts[i], s.name);
      assert.equal(cases[i].expected.phases, phaseSubs(s).length);
      assert.equal(cases[i].expected.members, s.share?.members.length ?? 0);
      for (const p of phaseSubs(s)) {
        for (const r of p.payments ?? []) {
          assert.ok(r.date >= p.start && r.date <= today && (!p.end || r.date <= p.end), `${s.name}: actual payment outside past service`);
        }
        if (p.planned) assert.equal(p.payments?.length ?? 0, 0, 'planned phase has no actual payment');
      }
      for (const m of s.share?.members ?? []) {
        for (const r of m.receipts ?? []) assert.ok(r.date <= today && r.date >= m.joined, 'member receipt date');
        if (m.leaveRefund) assert.ok(m.left <= today && m.leaveRefund.date <= today && m.leaveRefund.amount > 0);
      }
      for (const e of s.proxy?.receipts ?? []) {
        assert.ok(e.periods.every((k) => k <= today) && e.date <= today);
        assert.ok(
          e.periods.every((k) => rows.some((r) => r.date === k && !r.kind)),
          'proxy references an actual subscription payment',
        );
      }
    }

    assert.deepEqual([...new Set(history(2).map((c) => c.amount))], [36]);
    assert.equal(history(3).filter((c) => c.amount < 0).length, 35);
    for (const p of phaseSubs(sub(3)))
      for (const r of p.payments.filter((r) => !r.kind)) {
        assert.ok(p.payments.some((credit) => credit.date === r.date && credit.amount === -3 && credit.kind === 'adjust'));
      }
    assert.equal(sub(4).phases.length, 5);
    assert.deepEqual([...new Set(sub(4).phases.map((p) => `${p.region}/${p.currency}`))], ['US/USD', 'TR/TRY']);
    assert.ok(new Set(sub(4).phases.map((p) => p.price)).size > 1);
    const seats = (n) => sub(n).share.members.filter((m) => memberAboard(m, today)).length + 1;
    assert.equal(seats(5), 3);
    assert.equal(sub(5).share.seats, 4);
    assert.ok(memberDues(sub(5), today, sub(5).currency)[0].dueFor < today);
    assert.ok(paidThrough(memberLedger(sub(5), sub(5).share.members[1], today, sub(5).currency).periods) > today);
    assert.equal(sub(6).share.role, 'member');
    for (const [n, status] of [
      [7, 'trial'],
      [8, 'paused'],
      [17, 'ended'],
      [19, 'ending'],
      [24, 'terminated'],
      [25, 'ended'],
      [33, 'upcoming'],
    ]) {
      assert.equal(effectiveStatus(sub(n), today), status, sub(n).name);
    }
    assert.equal(sub(7).trialEnd, addDays(today, 5));
    assert.equal(nextCharge(sub(7), today), addDays(today, 5));
    assert.equal(sub(9).start, today);
    assert.equal(history(9)[0].date, today);
    assert.ok(sub(13).start < today && history(13).at(-1).date === today);
    assert.deepEqual(new Set(history(10).map((c) => c.kind)), new Set([undefined, 'failed', 'refund', 'adjust']));
    assert.equal(parsed.fx.rates.XCD, undefined);
    assert.ok(Number.isNaN(convertOn(27, 'XCD', 'CNY', today, {}, parsed.fx)));
    assert.ok(history(12).every((c) => c.currency === 'USD' && c.settled.currency === 'HKD'));
    for (const [n, cycle] of [
      [1, { unit: 'week', every: 1 }],
      [2, { unit: 'month', every: 1 }],
      [14, { unit: 'month', every: 3 }],
      [18, { unit: 'month', every: 6 }],
      [21, { unit: 'year', every: 1 }],
      [28, { unit: 'year', every: 2 }],
      [30, { unit: 'day', every: 30 }],
      [31, { unit: 'lifetime', every: 1 }],
    ]) {
      assert.deepEqual(sub(n).cycle, cycle);
    }
    assert.ok(sub(15).share.members.every((m) => m.billEvery === 3 && m.fee === 30 && m.share === 30));
    assert.equal(sub(16).phases.length, 2);
    assert.deepEqual([...new Set(history(16).map((c) => c.amount))], [90, 120]);
    assert.equal(sub(17).stop.kind, 'cancel');
    assert.equal(stopSummary(sub(17), today).refundStatus, 'partial');
    assert.equal(sub(19).end, addDays(today, 20));
    const gap = servedTime(sub(20), today).gaps;
    assert.equal(gap.length, 1);
    assert.equal(gap[0].to, addMonths(gap[0].from, 4));
    assert.equal(sub(20).phases.length, 2);
    assert.equal(sub(22).phases.length, 8);
    assert.deepEqual(
      history(22).map((c) => c.amount),
      [180, 215, 250, 285, 320, 355, 390, 425],
    );
    assert.equal(seats(23), 5);
    assert.equal(sub(23).share.seats, 5);
    assert.equal(sub(23).share.members.length, 5, 'four current members plus one historical exit');
    assert.ok(sub(23).share.members.find((m) => m.left).leaveRefund.amount > 0);
    assert.ok(sub(23).notes.length >= 300 && sub(23).notes.length < 450 && sub(23).notes.split('\n\n').length === 3);
    assert.equal(sub(24).stop.kind, 'terminate');
    assert.ok(sub(24).stop.reason && stopSummary(sub(24), today).unusedValue > 0);
    assert.equal(stopSummary(sub(24), today).refunded, 0);
    const dates = renewalDates(sub(26), addDays(today, 1));
    assert.equal(dates.nextCharge, addDays(dates.serviceExpires, -30));
    assert.equal(dates.cancelBy, addDays(dates.nextCharge, -7));
    assert.ok(sub(27).intro.until < today && sub(27).bonus.from <= today && sub(27).bonus.until > today);
    assert.equal(history(27)[0].amount, 99);
    assert.equal(nextCharge(sub(27), today), sub(27).bonus.until);
    assert.equal(nextCharge(sub(31), today), undefined);
    assert.ok(sub(32).phases.every((p) => p.cycle.unit === 'lifetime' && p.payments.length === 1));
    assert.deepEqual(
      history(32).map((c) => c.amount),
      [199, 288],
    );
    assert.equal(sub(33).start, addDays(today, 20));
    assert.equal(activePhases(sub(34), today).length, 2);
    assert.equal(sub(34).phases.at(-1).planned, true);
    assert.equal(sub(34).phases.at(-1).start, addDays(today, 12));
    assert.equal(new Set(sub(34).phases.map((p) => p.region)).size, 3);
    assert.ok(sub(35).name.length >= 55 && sub(35).name.length <= 75);
    assert.ok(sub(35).account.length > 100 && sub(35).url.length > 200 && sub(35).manageUrl.length > 200);
    assert.ok(!sub(36).methodId && !sub(36).category);
    assert.ok(sub(37).proxy);
    const extremes = cases.filter((c) => c.case === 38).map((c) => parsed.subscriptions.find((s) => s.id === c.id));
    assert.deepEqual(
      extremes.map((s) => [s.price, s.currency, s.cycle.unit]),
      [
        [123456.78, 'CNY', 'year'],
        [0.99, 'USD', 'week'],
      ],
    );
    assert.equal(sub(39).share.role, 'owner');
    assert.equal(seats(39), 5);
    assert.equal(sub(39).phases.length, 21);
    assert.ok(sub(39).phases[0].intro.until < today && sub(39).phases.at(-1).planned);
    assert.equal(history(39)[0].amount, 6);
    assert.equal(history(39).filter((c) => c.kind === 'adjust').length, 20);
    assert.ok(sub(39).notes.length >= 300);
    assert.equal(parsed.settings.language, 'zh-CN');
    assert.equal(parsed.settings.baseCurrency, 'CNY');
    // Complete fictional date coverage avoids triggering network backfill in screenshot imports.
    assert.ok(parsed.fxDaily.every((d) => d.source === 'fictional-detail-fixtures' && !d.rates.XCD && d.rates.TRY));
    const fxDates = new Set(parsed.fxDaily.map((d) => d.date));
    for (const s of parsed.subscriptions) for (const r of chargesBetween(s, s.start, today, today)) assert.ok(fxDates.has(r.date));
    const first = parsed.subscriptions.map((s) => s.start).sort()[0];
    for (let d = `${first.slice(0, 7)}-01`; d <= today; d = addMonths(d, 1)) {
      const end = addDays(addMonths(d, 1), -1);
      assert.ok(fxDates.has(end < today ? end : today));
    }
  });
}

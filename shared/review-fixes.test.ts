import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  memberUnpaidFrom,
  isGap,
  chargesBetween,
  effectiveStatus,
  monthlyGross,
  monthlyMine,
  myShareFactor,
  totals,
  memberDues,
  runwayFor,
  FALLBACK_FX,
} from './billing.ts';
import { contributionOn, cashVsAccrual, events, topUpPlan, yearReview } from './metrics.ts';
import { carLedger } from './carpool.ts';
import { maskForPublic } from './mask.ts';
import { peopleLedger } from './people.ts';
import { chargeValue } from './fx.ts';
import { switchPlan } from './phases.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const sub = (extra: Partial<Subscription> = {}): Subscription => ({
  id: 's',
  name: 'Subscription',
  category: 'Tools',
  tags: [],
  price: 60,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-01',
  status: 'active',
  ...extra,
});
const state = (subscriptions: Subscription[], extra: Partial<AppState> = {}): AppState => ({
  subscriptions,
  methods: [],
  settings: { ...DEFAULT_SETTINGS },
  fx: FALLBACK_FX,
  ...extra,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

test('1. trialEnd 当天是首个付费日：状态、扣款、报告、概览一致', () => {
  const offset = sub({ status: 'trial', trialEnd: '2026-01-15' });
  assert.deepEqual(
    chargesBetween(offset, '2026-01-01', '2026-02-28', '2026-01-14').map((c) => c.date),
    ['2026-01-15', '2026-02-15'],
  );
  const s = sub({ status: 'trial', trialEnd: '2026-02-01' });
  const st = state([s]);
  assert.equal(effectiveStatus(s, '2026-01-31'), 'trial');
  assert.equal(effectiveStatus(s, '2026-02-01'), 'active');
  assert.equal(chargesBetween(s, s.start, s.trialEnd!, '2026-02-01')[0].date, s.trialEnd);
  for (const day of ['2026-01-31', '2026-02-01']) {
    const expected = day < s.trialEnd! ? 0 : 60;
    assert.equal(contributionOn(st, s, day), expected);
    assert.equal(totals(st, day).mrr, expected);
    assert.equal(totals(st, day).activeCount, expected ? 1 : 0);
    assert.equal(monthlyMine(st, s, day), expected);
  }
});

test('2. endDate 为最后服务日，次日才结束，扣款、权责与结束事件一致', () => {
  const s = sub({ end: '2026-02-01' });
  const st = state([s]);
  assert.equal(effectiveStatus(s, s.end!), 'ending');
  assert.equal(contributionOn(st, s, s.end!), 60);
  assert.equal(totals(st, s.end!).mrr, 60);
  assert.equal(effectiveStatus(s, '2026-02-02'), 'ended');
  assert.equal(contributionOn(st, s, '2026-02-02'), 0);
  assert.equal(totals(st, '2026-02-02').mrr, 0);
  assert.deepEqual(
    chargesBetween(s, '2026-02-01', '2026-02-28', '2026-02-02').map((c) => c.date),
    ['2026-02-01'],
  );
  assert.equal(cashVsAccrual(st, '2026-02-02', 0, 0)[0].accrual, 60);
  assert.equal(
    events(st, '2026-02-01').some((e) => e.kind === 'end'),
    false,
  );
  assert.equal(events(st, '2026-02-02').find((e) => e.kind === 'end')!.date, '2026-02-02');
  const phases = switchPlan(sub(), '2026-02-01', { price: 30, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  assert.equal(phases.phases![0].end, '2026-01-31');
  assert.equal(isGap('2026-02-01', '2026-02-05'), false); // 中间空三天
  assert.equal(isGap('2026-02-01', '2026-02-06'), true);
  assert.equal(totals(state([phases]), '2026-02-01').mrr, 30);
});

test('3. 赠送期摊薄与恢复：报告、列表及概览复用相同月成本', () => {
  const s = sub({ bonus: { from: '2026-02-01', until: '2026-03-01' } });
  const st = state([s]);
  for (const day of ['2026-01-20', '2026-02-01', '2026-02-28', '2026-03-01']) {
    const expected = monthlyGross(s, day);
    near(contributionOn(st, s, day), expected);
    near(totals(st, day).mrr, expected);
    near(monthlyMine(st, s, day), expected);
  }
  assert.ok(contributionOn(st, s, '2026-02-28') < 60);
  assert.equal(contributionOn(st, s, '2026-03-01'), 60);
});

test('4. 加入日与退出日边界在按日成本及预计年收入一致', () => {
  const s = sub({
    share: {
      role: 'owner',
      seats: 4,
      members: [
        { id: 'a', name: 'a', share: 10, joined: '2026-02-01', left: '2026-03-01' },
        { id: 'b', name: 'b', share: 20, joined: '2027-01-01' },
      ],
    },
  });
  const st = state([s]);
  for (const day of ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01']) {
    const mine = day >= '2026-02-01' && day < '2026-03-01' ? 50 : 60;
    assert.equal(contributionOn(st, s, day), mine);
    assert.equal(totals(st, day).mrr, mine);
    assert.equal(monthlyMine(st, s, day), mine);
    near(myShareFactor(s, day), mine / 60);
    near(carLedger(st, s, day).yearIncome, (60 - mine) * 12);
  }
});

test('5. 合租待收按原币收费标准 × 期数，当前汇率换算不依赖保存份额', () => {
  const s = sub({
    share: {
      role: 'owner',
      seats: 3,
      since: '2026-01-01',
      members: [{ id: 'm', name: 'M', share: 999, fee: 70, feeCurrency: 'CNY', billEvery: 1, joined: '2026-01-01' }],
    },
  });
  const [d] = memberDues(s, '2026-03-01', 'CNY');
  assert.equal(d.periodsOwed, 3);
  assert.equal(d.owed, 210);
  assert.equal(d.currency, 'CNY');
  for (const rate of [7, 10]) {
    const st = state([s], { fx: { base: 'USD', fetchedAt: '', rates: { USD: 1, CNY: rate } } });
    near(peopleLedger(st, '2026-03-01')[0].owed, 210 / rate);
  }
  delete s.share!.members[0].feeCurrency;
  assert.equal(memberDues(s, '2026-03-01', 'CNY')[0].currency, 'CNY');
});

test('6. 订阅结束、暂停或成员退出后欠款保留且停止累计，收款后归零', () => {
  for (const stop of [
    { end: '2026-03-01', status: 'cancelled' as const },
    { pausedAt: '2026-03-02', status: 'paused' as const },
  ]) {
    const s = sub({ ...stop, share: { role: 'owner', seats: 2, since: '2026-01-01', members: [{ id: 'm', name: 'M', share: 10, joined: '2026-01-01' }] } });
    for (const day of ['2026-04-01', '2027-04-01']) {
      assert.equal(memberDues(s, day)[0].periodsOwed, 3);
      assert.equal(peopleLedger(state([s]), day)[0].owed, 30);
    }
    assert.equal(memberUnpaidFrom(s, s.share!.members[0]), '2026-01-01');
    s.share!.members[0].receipts = [{ id: 'r1', date: '2026-01-05', amount: 10, currency: 'USD', periods: ['2026-01-01'] }];
    assert.equal(memberUnpaidFrom(s, s.share!.members[0]), '2026-02-01');
    assert.equal(memberDues(s, '2027-04-01')[0].owed, 20);
    s.share!.members[0].receipts.push({ id: 'r2', date: '2026-04-05', amount: 20, currency: 'USD', periods: ['2026-02-01', '2026-03-01'] });
    assert.equal(memberDues(s, '2027-04-01')[0].owed, 0);
  }
  const s = sub({ share: { role: 'owner', seats: 2, members: [{ id: 'm', name: 'M', share: 10, joined: '2026-01-01', left: '2026-03-01' }] } });
  assert.equal(memberDues(s, '2027-01-01')[0].periodsOwed, 2);
  s.share!.members[0].joined = '2027-01-01';
  assert.equal(memberDues(s, '2026-02-01')[0].owed, 0);
});

test('7. 每日多订阅的全年充值与完整推演相等，明细仍可限制 60 条', () => {
  const today = '2026-01-01';
  const st = state(
    [sub({ cycle: { unit: 'day', every: 1 }, price: 2, methodId: 'card' }), sub({ id: 'b', cycle: { unit: 'day', every: 1 }, price: 3, methodId: 'card' })],
    { methods: [{ id: 'card', name: 'Card', kind: 'debit', currency: 'USD', balance: 100, balanceAsOf: today }] },
  );
  const r = runwayFor(st.methods[0], st, today)!;
  assert.equal(r.upcoming.length, 60);
  assert.equal(r.topUp12m, 365 * 5 - 100);
  const plan = topUpPlan(st, today, 12)[0];
  assert.equal(plan.need, r.topUp12m);
  assert.equal(plan.due, 365 * 5);
  assert.equal(plan.minNeed, 2);
  assert.equal(topUpPlan(st, today, 24)[0].due, 730 * 5);
});

test('8. 钱包按 settled、代付 chargedCurrency 实扣，失败不扣、退款回补', () => {
  const st = state(
    [
      sub({
        methodId: 'card',
        end: '2026-01-04',
        payments: [
          { date: '2026-01-02', amount: 60, settled: { amount: 7, currency: 'EUR' } },
          { date: '2026-01-03', amount: -5, kind: 'refund', settled: { amount: -2, currency: 'USD' } },
          { date: '2026-01-04', amount: 60, kind: 'failed', settled: { amount: 9, currency: 'USD' } },
        ],
      }),
      sub({
        id: 'proxy',
        methodId: 'card',
        end: '2026-01-05',
        start: '2026-01-05',
        currency: 'JPY',
        proxy: { forName: 'P', charged: [{ charge: '2026-01-05', amount: 3, currency: 'USD' }] },
      }),
    ],
    {
      fx: { base: 'USD', fetchedAt: '', rates: { USD: 1, EUR: 0.5, JPY: 100 } },
      methods: [{ id: 'card', name: 'Card', kind: 'debit', currency: 'USD', balance: 100, balanceAsOf: '2026-01-01' }],
    },
  );
  assert.equal(runwayFor(st.methods[0], st, '2026-01-06')!.current, 85);
  assert.equal(yearReview(st, '2026-01-06').total, 12); // 实付 14，退款 2；失败扣款不计入报告。
  const switched = state(
    [
      sub({
        end: '2026-01-10',
        proxy: { forName: 'P', charged: [{ charge: '2026-01-01', amount: 8, currency: 'USD' }] },
        phases: [
          { start: '2026-01-01', end: '2026-01-09', price: 60, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'old' },
          { start: '2026-01-10', price: 60, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'new' },
        ],
      }),
    ],
    { methods: [{ id: 'new', name: 'New card', kind: 'debit', currency: 'USD', balance: 100, balanceAsOf: '2026-01-01' }] },
  );
  // 换卡前那期记的实扣只属于那一期，不会算到新卡的下一期。
  assert.equal(runwayFor(switched.methods[0], switched, '2026-01-11')!.current, 40);
});

test('9. 年度回顾、个人 MRR 与现金按我的份额，未来 90 天保留全额实付', () => {
  const s = sub({ share: { role: 'owner', seats: 2, members: [{ id: 'm', name: 'M', share: 20, joined: '2026-01-01' }] } });
  const st = state([s]);
  assert.equal(yearReview(st, '2026-02-01').total, 80);
  const today = '2026-02-01';
  const cs = chargesBetween(s, addDays(today, 1), addDays(today, 90), today);
  assert.equal(
    cs.reduce((a, c) => a + chargeValue(st, c), 0),
    180,
  );
  assert.equal(totals(st, today).mrr, 40);
  assert.equal(cashVsAccrual(st, today, 0, 0)[0].cash, 40);
});

test('10. 公开数据保留计费字段，按订阅本身价格计成本，不带合租成员', () => {
  const s = sub({
    bonus: { from: '2026-02-01', until: '2026-03-01' },
    notes: 'private-notes',
    account: 'private-account',
    share: {
      role: 'owner',
      seats: 3,
      members: [
        {
          id: 'private-id',
          name: 'private-name',
          personId: 'private-person',
          contact: 'private-contact',
          contactVia: 'private-channel',
          tg: 'private-tg',
          account: 'private-account',
          source: 'private-source',
          note: 'private-note',
          share: 20,
          exempt: true,
          joined: '2026-01-01',
          payments: [{ date: '2026-01-01', amount: 4, currency: 'USD', until: '2026-02-01', note: 'private-receipt' }],
        },
        { id: 'other', name: 'private-other', share: 10, joined: '2026-02-01', left: '2026-02-15' },
      ],
    },
  });
  const st = state([s]);
  const out = maskForPublic(st);
  assert.ok(!JSON.stringify(out).includes('private-'));
  assert.equal(out.subscriptions[0].share, undefined);
  const gross = state([{ ...s, share: undefined }]);
  for (const day of ['2026-01-31', '2026-02-01', '2026-02-15', '2026-03-01']) {
    near(totals(out, day).mrr, totals(gross, day).mrr);
    near(contributionOn(out, out.subscriptions[0], day), contributionOn(gross, gross.subscriptions[0], day));
  }
  assert.deepEqual(out.subscriptions[0].bonus, s.bonus);
});

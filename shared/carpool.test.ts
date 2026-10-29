import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX } from './billing.ts';
import { toBaseAt } from './fx.ts';
import {
  applyCarRule,
  carRule,
  followCarRule,
  followsCar,
  resyncShares,
  suggestedLeaveRefund,
  carLedger,
  carYear,
  carpoolYear,
  periodsTotal,
  nextCollectionDay,
  collectionPeriod,
  memberCashFlows,
  updateMemberLeave,
  moveMemberJoin,
} from './carpool.ts';
import { memberDues, memberLedger, memberPeriods, memberRate } from './billing.ts';
import { migrateReceivables } from './receivables-legacy.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const sub = (o: Partial<Subscription> = {}): Subscription => ({
  id: 's',
  name: 'Surge Mac',
  category: '工具',
  tags: [],
  price: 329,
  currency: 'CNY',
  cycle: { unit: 'year', every: 1 },
  start: '2025-10-28',
  status: 'active',
  share: {
    role: 'owner',
    seats: 5,
    members: [
      { id: 'a', name: 'A', share: 60, fee: 60, feeCurrency: 'CNY', billEvery: 12 },
      { id: 'b', name: '自己 · 第 2 台', share: 0, exempt: true },
      { id: 'c', name: 'C', share: 30 },
    ],
  },
  ...o,
});
const state: AppState = { subscriptions: [], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' }, fx: FALLBACK_FX };

test('订阅改成美元后，成员份额按收费标准重新折算，不把 ¥60 当成 $60', () => {
  const prev = sub();
  const next = resyncShares(state, prev, { ...prev, price: 45.99, currency: 'USD' });
  const usd = Math.round(toBaseAt(state, 60, 'CNY', undefined, 'USD') * 100) / 100;
  assert.equal(next.share!.members[0].share, usd);
  assert.ok(usd < 15);
  // 不分摊的、没有收费标准的保持原样
  assert.equal(next.share!.members[1].share, 0);
  assert.equal(next.share!.members[2].share, 30);
});

test('币种和周期都没变时不动', () => {
  const prev = sub();
  const next = { ...prev, price: 300 };
  assert.equal(resyncShares(state, prev, next), next);
  assert.equal(resyncShares(state, undefined, next), next);
});

test('年付改成月付：每期份额变成一个月的', () => {
  const prev = sub();
  const next = resyncShares(state, prev, { ...prev, price: 30, cycle: { unit: 'month', every: 1 } });
  assert.equal(next.share!.members[0].share, 5);
});

const ruleCar = (): Subscription => ({
  ...sub({ price: 279, currency: 'CNY', cycle: { unit: 'month', every: 1 }, start: '2021-04-14' }),
  share: {
    role: 'owner',
    seats: 6,
    collectFrom: '2026-01-17',
    members: [
      {
        id: 'a',
        name: 'A',
        share: 7.33,
        fee: 44,
        feeCurrency: 'CNY',
        billEvery: 6,
        receipts: [{ id: 'r1', date: '2026-01-17', amount: 44, currency: 'CNY', periods: ['2026-01-17'] }],
      },
      { id: 'b', name: 'B', share: 7.33, fee: 44, feeCurrency: 'CNY', billEvery: 6 },
      { id: 'c', name: 'C', share: 10, fee: 120, feeCurrency: 'CNY', billEvery: 12, custom: true },
      { id: 'd', name: '自己', share: 0, exempt: true },
    ],
  },
});
const today = '2026-10-22';

test('车的收款规则缺省取在车成员里最常见的收费标准，自定义与不分摊的不跟随', () => {
  const s = ruleCar();
  assert.deepEqual(carRule(state, s, today), { billEvery: 6, fee: 44, currency: 'CNY' });
  assert.equal(followsCar(state, s, s.share!.members[0], today), true);
  assert.equal(followsCar(state, s, s.share!.members[2], today), false);
  assert.equal(followsCar(state, s, s.share!.members[3], today), false);
});

test('改车的规则：跟随车的成员从生效日起调价，历史收款与自定义成员不变', () => {
  const s = ruleCar();
  const next = applyCarRule(state, s, { billEvery: 12, fee: 80, currency: 'CNY' }, '2027-01-17', today);
  assert.deepEqual(next.share!.rule, { billEvery: 12, fee: 80, currency: 'CNY' });
  const [a, b, c, d] = next.share!.members;
  // 生效前仍按旧标准，生效后按新标准
  assert.equal(memberRate(next, a, '2026-12-01', 'CNY').amount, 44);
  assert.equal(memberRate(next, a, '2027-02-01', 'CNY').amount, 80);
  assert.equal(memberRate(next, b, '2027-02-01', 'CNY').billEvery, 12);
  assert.deepEqual(a.receipts, s.share!.members[0].receipts);
  assert.equal(c, s.share!.members[2]);
  assert.equal(d, s.share!.members[3]);
});

test('成员改回跟随车：去掉自定义标记，并从生效日起套用车的规则', () => {
  const s = ruleCar();
  const m = followCarRule(state, s, s.share!.members[2], '2026-11-01', today);
  assert.equal(m.custom, undefined);
  assert.equal(memberRate(s, m, '2026-12-01', 'CNY').amount, 44);
  assert.equal(memberRate(s, m, '2026-12-01', 'CNY').billEvery, 6);
});

test('成员自己另起了收款日：不算跟随车，改回跟随车后收款日回到车的节奏', () => {
  const s = ruleCar();
  const own = { id: 'e', name: 'E', share: 7.33, fee: 44, feeCurrency: 'CNY', billEvery: 6, joined: '2026-10-20', restarts: ['2027-04-21'] };
  s.share!.members.push(own);
  assert.equal(followsCar(state, s, own, today), false);
  const m = followCarRule(state, s, own, today, today);
  assert.equal(m.restarts, undefined);
  assert.equal(followsCar(state, s, m, today), true);
  assert.deepEqual(
    memberPeriods(s, m, '2027-08-01', 'CNY').map((p) => p.from),
    ['2026-10-20', '2027-01-17', '2027-07-17'],
  );
});

test('成员按月、每月 5 号收：改回跟随车后从车的下一个收款日重起，之前的期不动', () => {
  const s = ruleCar();
  const own = {
    id: 'e',
    name: 'E',
    share: 1.22,
    fee: 7,
    feeCurrency: 'CNY',
    billEvery: 1,
    joined: '2026-02-17',
    restarts: ['2026-03-05'],
    custom: true as const,
  };
  s.share!.members.push(own);
  const m = followCarRule(state, s, own, today, today);
  assert.deepEqual(m.restarts, ['2026-03-05', '2027-01-17']);
  const starts = memberPeriods(s, m, '2027-08-01', 'CNY').map((p) => p.from);
  assert.deepEqual(starts.slice(-5), ['2026-09-05', '2026-10-05', '2026-11-05', '2027-01-17', '2027-07-17']);
});

test('老车第一次存规则时，与规则不一致的成员标为自定义，之后不会被误当成跟随车', () => {
  const s = ruleCar();
  s.share!.members[2] = { ...s.share!.members[2], custom: undefined };
  const next = applyCarRule(state, s, { billEvery: 6, fee: 44, currency: 'CNY' }, '2026-11-01', today);
  assert.equal(next.share!.members[2].custom, true);
  assert.equal(followsCar(state, next, next.share!.members[2], today), false);
  assert.equal(followsCar(state, next, next.share!.members[0], today), true);
});

test('已退出成员在首次存规则和追溯调价时保持原样', () => {
  for (const fee of [44, 99]) {
    const s = ruleCar();
    s.share!.members[0] = { ...s.share!.members[0], fee, left: '2026-09-01' };
    for (const from of ['2026-08-01', '2026-11-01']) {
      const next = applyCarRule(state, s, { billEvery: 3, fee: 30, currency: 'CNY' }, from, today);
      assert.deepEqual(next.share!.members[0], s.share!.members[0]);
    }
  }
});

test('下车建议按收过钱的各期分到的钱按天折算，跨两笔、跨币种并保留原币明细', () => {
  const s = ruleCar();
  s.share!.collectFrom = '2026-01-01';
  const m = {
    ...s.share!.members[0],
    billEvery: 1,
    joined: '2026-01-01',
    left: '2026-01-16',
    receipts: [
      { id: 'r1', date: '2026-01-01', periods: ['2026-01-01'], amount: 31, currency: 'USD' },
      { id: 'r2', date: '2026-01-15', periods: ['2026-02-01'], amount: 56, currency: 'CNY' },
    ],
  };
  const fx = { ...state, fxHistory: { '2026-01-16': { USD: 1, CNY: 7 } } };
  const before = structuredClone(m);
  const r = suggestedLeaveRefund(fx, s, m);
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 24); // USD16 + CNY56 / 7
  assert.equal(r.unusedDays, 44);
  assert.deepEqual(
    r.parts.map((p) => [p.amount, p.currency]),
    [
      [16, 'USD'],
      [56, 'CNY'],
    ],
  );
  assert.deepEqual(m, before);
  assert.equal(suggestedLeaveRefund(fx, s, m, 'CNY').amount, 168);
  assert.equal(suggestedLeaveRefund(fx, s, { ...m, left: '2026-03-01' }).amount, 0);
  assert.equal(suggestedLeaveRefund(fx, s, { ...m, left: undefined }).amount, 0);
  assert.equal(suggestedLeaveRefund(fx, s, { ...m, receipts: [] }).amount, 0);
  const missing = { ...fx, fxHistory: undefined, fx: { ...fx.fx, rates: { USD: 1 } } };
  assert.ok(Number.isNaN(suggestedLeaveRefund(missing, s, m).amount));
});

test('旧收款无覆盖起点时转成它覆盖的那一期，退出当日也属未用，零位币种建议不带小数', () => {
  const raw = ruleCar();
  raw.share!.collectFrom = '2026-01-10';
  raw.share!.members = [
    {
      ...raw.share!.members[1],
      billEvery: 1,
      joined: '2026-01-10',
      left: '2026-01-31',
      payments: [{ date: '2026-01-10', until: '2026-01-31', amount: 1000, currency: 'JPY' }],
    } as never,
  ];
  const s = migrateReceivables(raw, 'CNY');
  const m = s.share!.members[0];
  assert.deepEqual(
    m.receipts!.map((r) => r.periods),
    [['2026-01-10']],
  );
  // 01-10 至 02-09 这一期，退出日 01-31 起 10 天没用：1000 × 10 / 31，日元不带小数（多收的部分足够退这么多）
  assert.equal(suggestedLeaveRefund(state, s, m).amount, 323);
  assert.equal(suggestedLeaveRefund(state, s, m).unusedDays, 10);
});

test('账本和现金流按退款日汇率扣实际退款，年度净额包含本年已退，历史完整保留', () => {
  const s = ruleCar();
  const m = { ...s.share!.members[0], left: '2026-10-01', leaveRefund: { amount: 2, currency: 'USD', date: '2026-10-02', note: 'Actual refund' } };
  s.share!.members = [m];
  const st = { ...state, fxHistory: { '2026-10-02': { USD: 1, CNY: 8 } } };
  const before = structuredClone(s);
  const book = carLedger(st, s, '2026-10-23');
  assert.equal(book.received, 28); // CNY44 - USD2 × 8
  assert.equal(book.yearRefunded, 16);
  assert.equal(book.yearIncome, -16);
  assert.equal(book.yearNet, book.yearCost + 16);
  assert.equal(book.net, book.paid - 28);
  assert.equal(memberCashFlows(m).at(-1)!.amount, -2);
  assert.deepEqual(s, before);
  assert.equal(carLedger(st, s, '2027-01-01').yearRefunded, 0);
  assert.equal(
    carLedger(st, { ...s, share: { ...s.share!, members: [{ ...m, leaveRefund: { ...m.leaveRefund, currency: 'ZZZ' } }] } }, '2026-10-23').received,
    NaN,
  );
  const cleared = updateMemberLeave(m, { left: undefined });
  assert.equal(cleared.leaveRefund, undefined);
  assert.deepEqual(cleared.receipts, m.receipts);
});

test('买断的合租：成员只收一次，算待收不抛错，也没有每年收入', () => {
  const s = sub({
    price: 99.99,
    currency: 'USD',
    cycle: { unit: 'lifetime', every: 1 },
    start: '2026-03-10',
    share: {
      role: 'owner',
      seats: 4,
      since: '2026-03-10',
      members: [
        {
          id: 'paid',
          name: '甲',
          share: 1,
          fee: 129,
          feeCurrency: 'CNY',
          joined: '2026-03-10',
          // 买断只收一期：这一期一直覆盖到 100 年后
          receipts: [{ id: 'r1', date: '2026-03-12', amount: 129, currency: 'CNY', periods: ['2026-03-10'] }],
        },
        { id: 'owe', name: '乙', share: 1, fee: 129, feeCurrency: 'CNY', joined: '2026-03-10' },
      ],
    },
  });
  const dues = memberDues(s, '2026-10-25', 'CNY', state);
  assert.equal(dues.find((d) => d.member.id === 'paid')!.periodsOwed, 0);
  const owe = dues.find((d) => d.member.id === 'owe')!;
  assert.equal(owe.periodsOwed, 1);
  assert.equal(owe.owed, 129);
  assert.equal(carLedger(state, s, '2026-10-25').yearIncome, 0);
});

test('当年盈亏：今年成本含预计扣款，收入含已收与今年还该收的各期（含逾期）', () => {
  const s = sub({
    price: 30,
    currency: 'CNY',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    share: {
      role: 'owner',
      seats: 2,
      since: '2026-01-01',
      members: [
        {
          id: 'a',
          name: 'A',
          share: 10,
          fee: 10,
          feeCurrency: 'CNY',
          billEvery: 1,
          joined: '2026-01-01',
          // 一笔收了前 6 期
          receipts: [
            {
              id: 'r1',
              date: '2026-01-05',
              amount: 60,
              currency: 'CNY',
              periods: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'],
            },
          ],
        },
      ],
    },
  });
  const y = carYear(state, s, '2026-10-25');
  assert.equal(y.cost, 360);
  assert.equal(y.income, 120);
  assert.equal(y.net, -240);
  // 合计：只算我发起的车；早已停止、今年没有账的车不计入
  const old = sub({ id: 'old', start: '2020-01-01', end: '2021-01-01', status: 'ended' });
  const joined = sub({ id: 'j', share: { role: 'member', seats: 3, members: [] } });
  const all = carpoolYear({ ...state, subscriptions: [s, old, joined] }, '2026-10-25');
  assert.deepEqual(
    all.subs.map((x) => x.id),
    [s.id],
  );
  assert.equal(all.net, -240);
  assert.equal(all.partial.net.value, -240);
  // 选去年：这辆车今年才开，去年没有账，不计入
  assert.deepEqual(carpoolYear({ ...state, subscriptions: [s, old, joined] }, '2026-10-25', '2025').subs, []);
});

test('几期应收的合计：一笔覆盖几期就加几期应收；退出日之后不再有期', () => {
  const plan = sub({
    price: 60,
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    share: {
      role: 'owner',
      seats: 6,
      since: '2026-01-01',
      collectFrom: '2026-01-01',
      members: [{ id: 'm', name: 'M', joined: '2026-01-01', share: 10, fee: 60, feeCurrency: 'CNY', billEvery: 6 }],
    },
  });
  const m = plan.share!.members[0];
  const periods = memberPeriods(plan, m, '2027-01-01', 'CNY');
  assert.deepEqual(periodsTotal(state, periods.slice(0, 1)), { amount: 60, currency: 'CNY' });
  assert.deepEqual(periodsTotal(state, periods.slice(0, 3)), { amount: 180, currency: 'CNY' });
  assert.equal(periods[2].until, '2027-06-30');
  // 2026-09-01 下车：第二期从 07-01 开始还在车上，第三期起不再有
  assert.equal(memberPeriods(plan, { ...m, left: '2026-09-01' }, '2030-01-01', 'CNY').length, 2);
});

test('下期收款日：按车的收款节奏取今天之后的下一次；当天正好是收款日时算下一期', () => {
  const plan = sub({ share: { role: 'owner', seats: 6, collectFrom: '2025-11-01', members: [] } });
  assert.equal(nextCollectionDay(plan, 6, '2026-10-25'), '2026-11-01');
  assert.equal(nextCollectionDay(plan, 6, '2026-11-01'), '2027-05-01');
  assert.equal(nextCollectionDay(plan, 1, '2026-10-25'), '2026-11-01');
  assert.equal(nextCollectionDay(plan, 12, '2025-10-01'), '2025-11-01');
});

test('本期收款期：从上一次收款日起到下一次收款日，收款日当天开始新一期', () => {
  const plan = sub({ share: { role: 'owner', seats: 6, collectFrom: '2025-11-01', members: [] } });
  assert.deepEqual(collectionPeriod(plan, 6, '2026-10-25'), { from: '2026-05-01', next: '2026-11-01' });
  assert.deepEqual(collectionPeriod(plan, 6, '2026-11-01'), { from: '2026-11-01', next: '2027-05-01' });
  assert.deepEqual(collectionPeriod(plan, 1, '2026-10-25'), { from: '2026-10-01', next: '2026-11-01' });
});

test('改车的收款日：已有成员的历史各期与已收的期不重切，从新收款日起按新节奏；新成员按新日子对齐', async () => {
  const { moveCollectFrom } = await import('./carpool.ts');
  const paid = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'];
  const s: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: {
      role: 'owner',
      seats: 3,
      collectFrom: '2026-01-01',
      members: [
        {
          id: 'm',
          name: 'M',
          fee: 10,
          feeCurrency: 'CNY',
          billEvery: 1,
          joined: '2026-01-01',
          receipts: paid.map((p, i) => ({ id: `r${i}`, date: p, amount: 10, currency: 'CNY', periods: [p] })),
        },
      ],
    },
  };
  const today = '2026-05-20';
  const before = memberDues(s, today, 'CNY')[0];
  assert.equal(before.owed, 0);
  const moved = moveCollectFrom(s, '2026-06-15');
  assert.equal(moved.share!.collectFrom, '2026-06-15');
  const m = moved.share!.members[0];
  assert.equal(m.anchor, '2026-01-01');
  // 原来的五期原样、仍然结清；5 月那期截到 6 月 14 日，6 月 15 日起是新节奏
  const periods = memberPeriods(moved, m, '2026-08-01', 'CNY');
  assert.deepEqual(
    periods.slice(0, 7).map((p) => p.from),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-06-15'],
  );
  assert.equal(periods.find((p) => p.from === '2026-07-15')?.until, '2026-08-14');
  assert.equal(memberDues(moved, today, 'CNY')[0].owed, 0);
  // 之后加入的人按新收款日对齐
  const newcomer = { id: 'n', name: 'N', fee: 10, feeCurrency: 'CNY', billEvery: 1, joined: '2026-07-01' };
  const withNew = { ...moved, share: { ...moved.share!, members: [...moved.share!.members, newcomer] } };
  assert.equal(memberPeriods(withNew, newcomer, '2026-07-01', 'CNY')[0].until, '2026-07-14');
  // 收款日没变：什么都不钉
  assert.equal(moveCollectFrom(s, '2026-01-01').share!.members[0].anchor, undefined);
});

test('订阅暂停后不再生成成员的应收期：格子、状态与待收同一口径', async () => {
  const { memberUnpaidFrom, memberLedger } = await import('./billing.ts');
  const paid = ['2026-01-01', '2026-02-01', '2026-03-01'];
  const s: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'paused',
    pausedAt: '2026-04-01',
    share: {
      role: 'owner',
      seats: 3,
      collectFrom: '2026-01-01',
      members: [
        {
          id: 'm',
          name: 'M',
          fee: 10,
          feeCurrency: 'CNY',
          billEvery: 1,
          joined: '2026-01-01',
          receipts: paid.map((p, i) => ({ id: `r${i}`, date: p, amount: 10, currency: 'CNY', periods: [p] })),
        },
      ],
    },
  };
  const m = s.share!.members[0];
  assert.deepEqual(
    memberPeriods(s, m, '2026-06-10', 'CNY').map((p) => p.from),
    paid,
  );
  assert.equal(
    memberLedger(s, m, '2026-06-10', 'CNY').periods.some((p) => p.status === 'due'),
    false,
  );
  assert.equal(memberUnpaidFrom(s, m), '2026-04-01');
  assert.equal(memberDues(s, '2026-06-10', 'CNY')[0].owed, 0);
});

test('首期内退出：按截短后的应收收过就不建议退款、也不画没用完；多收的部分照退', async () => {
  const { suggestedLeaveRefund, memberSegments } = await import('./carpool.ts');
  const base = (amount: number) => ({
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 31,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month' as const, every: 1 },
    status: 'active' as const,
    share: {
      role: 'owner' as const,
      seats: 3,
      collectFrom: '2026-01-01',
      members: [
        {
          id: 'm',
          name: 'M',
          fee: 31,
          feeCurrency: 'CNY',
          billEvery: 1,
          joined: '2026-01-01',
          left: '2026-01-11',
          receipts: [{ id: 'r', date: '2026-01-01', amount, currency: 'CNY', periods: ['2026-01-01'] }],
        },
      ],
    },
  });
  const state: AppState = { subscriptions: [], methods: [], settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' }, fx: FALLBACK_FX };
  const exact = base(10);
  assert.equal(suggestedLeaveRefund(state, exact, exact.share.members[0]).amount, 0);
  assert.equal(
    memberSegments(exact, exact.share.members[0], '2026-02-01', '2026-01-01', '2026-12-31').some((x) => x.kind === 'unused'),
    false,
  );
  const full = base(31);
  assert.equal(suggestedLeaveRefund(state, full, full.share.members[0]).amount, 21);
});

test('取消不分摊：生效日前没结清的期记成免收，不补收不分摊期间；之后照常应收', async () => {
  const { waiveExemptSpan } = await import('./carpool.ts');
  const months = ['2026-01-01', '2026-02-01'];
  const s: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 3, collectFrom: '2026-01-01', members: [] },
  };
  const m = {
    id: 'm',
    name: 'M',
    fee: 10,
    feeCurrency: 'CNY',
    billEvery: 1,
    joined: '2026-01-01',
    receipts: months.map((p, i) => ({ id: `r${i}`, date: p, amount: 10, currency: 'CNY', periods: [p] })),
  };
  s.share!.members = [m];
  const back = waiveExemptSpan(s, m, '2026-05-01', '2026-05-10', 'CNY');
  assert.deepEqual(
    back.waivers?.map((w) => w.periods),
    [['2026-03-01', '2026-04-01']],
  );
  const after = { ...s, share: { ...s.share!, members: [back] } };
  const due = memberDues(after, '2026-05-10', 'CNY')[0];
  assert.equal(due.owed, 10);
  assert.equal(due.periodsOwed, 1);
  // 没有要免的期时原样返回
  assert.equal(waiveExemptSpan(s, m, '2026-03-01', '2026-03-10', 'CNY'), m);
});

test('已退出且提前收了的成员：已付至按收的钱覆盖到哪天，人员页、MCP、成员弹窗同一个值', async () => {
  const { memberPaidThrough } = await import('./carpool.ts');
  const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];
  const s: Subscription = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 3, collectFrom: '2026-01-01', members: [] },
  };
  const m = {
    id: 'm',
    name: 'M',
    fee: 10,
    feeCurrency: 'CNY',
    billEvery: 1,
    joined: '2026-01-01',
    left: '2026-02-15',
    receipts: [{ id: 'r', date: '2026-01-01', amount: 60, currency: 'CNY', periods: months }],
  };
  assert.equal(memberPaidThrough(s, m, '2026-03-10', 'CNY'), '2026-06-30');
  assert.equal(memberPaidThrough(s, { ...m, receipts: [] }, '2026-03-10', 'CNY'), undefined);
});

test('单独定价的期：对齐车的节奏截短的那期可以收整期，其余期不受影响', () => {
  const s = ruleCar();
  const own = { id: 'e', name: 'E', share: 7.33, fee: 44, feeCurrency: 'CNY', billEvery: 6, joined: '2026-10-20' };
  s.share!.members.push(own);
  const prorated = memberPeriods(s, own, '2027-02-01', 'CNY');
  assert.ok(prorated[0].due < 44);
  const fixed = memberPeriods(s, { ...own, periodDues: [{ from: '2026-10-20', amount: 44 }] }, '2027-02-01', 'CNY');
  assert.deepEqual(
    fixed.map((p) => [p.from, p.due]),
    [
      ['2026-10-20', 44],
      ['2027-01-17', 44],
    ],
  );
  // 不分摊时单独定价也不收
  assert.equal(memberPeriods(s, { ...own, exempt: true, periodDues: [{ from: '2026-10-20', amount: 44 }] }, '2027-02-01', 'CNY')[0].due, 0);
});

test('改回跟随车：起止变了的期不再被期初结清、免收盖住，实收不动', () => {
  const s = ruleCar();
  const own = {
    id: 'e',
    name: 'E',
    share: 7.33,
    fee: 44,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2026-10-20',
    restarts: ['2027-04-21'],
    receipts: [{ id: 'o', date: '2026-10-20', amount: 0, currency: 'CNY', periods: ['2026-10-20', '2027-01-17'], opening: true }],
  };
  s.share!.members.push(own);
  const m = followCarRule(state, s, own, today, today);
  assert.deepEqual(m.receipts?.[0].periods, ['2026-10-20']);
  const paid = { ...own, receipts: [{ ...own.receipts[0], amount: 44, opening: undefined }] };
  assert.deepEqual(followCarRule(state, s, paid, today, today).receipts?.[0].periods, ['2026-10-20', '2027-01-17']);
});

test('合租表格与成员弹窗网格同一口径：预收的未开始期画成已收，再画下一期未收的', async () => {
  const { memberSegments } = await import('./carpool.ts');
  const { periodGrid, periodCellKind } = await import('./period-grid.ts');
  const { memberLedger } = await import('./billing.ts');
  const s = {
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month' as const, every: 1 },
    status: 'active' as const,
    share: {
      role: 'owner' as const,
      seats: 2,
      collectFrom: '2026-01-01',
      members: [
        {
          id: 'm',
          name: 'M',
          fee: 10,
          feeCurrency: 'CNY',
          joined: '2026-01-01',
          receipts: [
            { id: 'r', date: '2026-01-01', amount: 50, currency: 'CNY', periods: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'] },
          ],
        },
      ],
    },
  } as unknown as Subscription;
  const m = s.share!.members[0];
  const today = '2026-02-10';
  const segments = memberSegments(s, m, today, '2026-01-01', '2026-12-31').map((x) => `${x.from}:${x.kind}`);
  const cells = periodGrid(memberLedger(s, m, today, 'CNY', '2026-12-31').periods, today)
    .rows.flatMap((r) => r.segments)
    .map((x) => `${x.period.from}:${periodCellKind(x.period, today).replace('upcoming', 'future')}`);
  assert.deepEqual(segments, ['2026-01-01:paid', '2026-02-01:paid', '2026-03-01:paid', '2026-04-01:paid', '2026-05-01:paid', '2026-06-01:future']);
  assert.deepEqual([...new Set(cells)], segments);
});

test('一笔收款分到各期按最小单位取整，合计等于实收', async () => {
  const { receiptShares } = await import('./receivables.ts');
  const periods = new Map(['a', 'b', 'c'].map((k) => [k, { key: k, from: k, until: k, due: 100, currency: 'CNY' }]));
  const shares = receiptShares({ id: 'r', date: '2026-01-01', amount: 100, currency: 'CNY', periods: ['a', 'b', 'c'] }, periods);
  assert.deepEqual([...shares.values()], [33.34, 33.33, 33.33]);
  const yen = receiptShares({ id: 'r', date: '2026-01-01', amount: 7000, currency: 'JPY', periods: ['a', 'b', 'c'] }, periods);
  assert.deepEqual([...yen.values()], [2334, 2333, 2333]);
});

test('碎期：车的收款日只对生效日起的期起作用，重新起算前剩下几天的并进前一期，月付半个月仍单独按天折算', () => {
  // 2021 年 14 号起按季收，2022 年 10 号起改半年；车的收款日 2025-01-17 才定下来
  const member = (o = {}) => ({
    id: 'm',
    name: 'M',
    share: 0,
    joined: '2021-04-14',
    restarts: ['2021-07-18', '2021-10-10', '2025-01-17'],
    feeHistory: [
      { from: '2021-04-14', fee: 20, currency: 'CNY', billEvery: 3 },
      { from: '2022-01-10', fee: 40, currency: 'CNY', billEvery: 6 },
    ],
    ...o,
  });
  const s = (m = member()): Subscription => ({
    id: 's',
    name: 'Fictional',
    category: 'Tools',
    tags: [],
    price: 60,
    currency: 'CNY',
    start: '2021-04-14',
    cycle: { unit: 'month', every: 1 },
    status: 'active',
    share: { role: 'owner', seats: 6, since: '2021-04-14', collectFrom: '2025-01-17', members: [m] },
  });
  const plan = s();
  const periods = memberPeriods(plan, plan.share!.members[0], '2025-07-17', 'CNY').map((p) => `${p.from}..${p.until} ${p.due}`);
  // 加入时不按 2025 年才定的 17 号倒推出 3 天碎期；07-17 那 1 天、2025-01-10 起那 7 天都并进前一期，整期收全价
  assert.deepEqual(periods.slice(0, 2), ['2021-04-14..2021-07-17 20', '2021-07-18..2021-10-09 18.26']);
  assert.ok(periods.includes('2024-07-10..2025-01-16 40'));
  assert.ok(periods.includes('2025-01-17..2025-07-16 40'));
  assert.ok(periods.every((p) => !/ (0\.\d+|1\.55)$/.test(p)));

  // 月付改到月中：剩下的 14 天远超一期的十分之一，仍单独按天折算
  const monthly = s(member({ joined: '2026-01-01', restarts: ['2026-03-15'], feeHistory: [{ from: '2026-01-01', fee: 10, currency: 'CNY', billEvery: 1 }] }));
  const keys = memberPeriods(
    { ...monthly, share: { ...monthly.share!, since: '2026-01-01', collectFrom: '2026-01-01' } },
    monthly.share!.members[0],
    '2026-04-01',
    'CNY',
  ).map((p) => p.from);
  assert.deepEqual(keys, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-03-15']);
});

test('订阅调价：窗口内提示是否调整收费标准，改过收费、成员都免收或超出窗口后不再提示', async () => {
  const { costChange } = await import('./carpool.ts');
  const member = { id: 'm', name: 'Fictional', share: 1, fee: 10, feeCurrency: 'CNY', billEvery: 1, joined: '2026-01-01' };
  const s = {
    id: 's',
    name: 'Fictional video',
    category: 'Test',
    tags: [],
    price: 30,
    currency: 'CNY',
    start: '2026-01-01',
    cycle: { unit: 'month' as const, every: 1 },
    status: 'active' as const,
    priceHistory: [
      { from: '2026-01-01', amount: 25 },
      { from: '2026-10-01', amount: 30 },
    ],
    share: { role: 'owner' as const, seats: 3, members: [member] },
  };
  assert.deepEqual(costChange(s, '2026-10-27'), {
    from: '2026-10-01',
    before: { price: 25, currency: 'CNY', cycle: s.cycle },
    after: { price: 30, currency: 'CNY', cycle: s.cycle },
  });
  // 将要生效的调价也提前提示
  assert.equal(costChange(s, '2026-09-15')?.from, '2026-10-01');
  assert.equal(costChange(s, '2027-01-15'), undefined);
  assert.equal(
    costChange(
      { ...s, share: { ...s.share, members: [{ ...member, feeHistory: [{ from: '2026-11-01', fee: 12, currency: 'CNY', billEvery: 1 }] }] } },
      '2026-10-27',
    ),
    undefined,
  );
  assert.equal(costChange({ ...s, share: { ...s.share, members: [{ ...member, exempt: true }] } }, '2026-10-27'), undefined);
  assert.equal(costChange({ ...s, priceHistory: undefined }, '2026-10-27'), undefined);
});

test('加入日往后改：之前整期的收款删掉（一笔分几期只去掉那几期的钱），跨过新加入日的那期挪到新首期；往前改不动收款', () => {
  const s = sub({ price: 60, cycle: { unit: 'month', every: 1 }, start: '2021-01-05', share: { role: 'owner', seats: 6, since: '2021-01-05', members: [] } });
  const m = {
    id: 'm',
    name: 'M',
    share: 10,
    fee: 10,
    feeCurrency: 'CNY',
    billEvery: 1,
    joined: '2024-01-05',
    receipts: [
      { id: 'r1', date: '2024-01-05', amount: 10, currency: 'CNY', periods: ['2024-01-05'] },
      { id: 'r2', date: '2024-02-05', amount: 20, currency: 'CNY', periods: ['2024-02-05', '2024-03-05'] },
      { id: 'r3', date: '2024-04-05', amount: 10, currency: 'CNY', periods: ['2024-04-05'] },
    ],
  };
  const today = '2024-05-01';
  const later = moveMemberJoin(s, m, { ...m, joined: '2024-03-05' }, today, 'CNY');
  assert.deepEqual(
    later.dropped.map((p) => p.key),
    ['2024-01-05', '2024-02-05'],
  );
  assert.deepEqual(
    later.member.receipts?.map((r) => [r.id, r.amount, r.periods]),
    [
      ['r2', 10, ['2024-03-05']],
      ['r3', 10, ['2024-04-05']],
    ],
  );
  assert.ok(memberLedger(s, later.member, today, 'CNY').periods.every((p) => p.status === 'paid'));
  const mid = moveMemberJoin(s, m, { ...m, joined: '2024-04-20' }, today, 'CNY');
  assert.deepEqual(
    mid.member.receipts?.map((r) => r.periods),
    [['2024-04-20']],
  );
  const earlier = moveMemberJoin(s, m, { ...m, joined: '2023-11-05' }, today, 'CNY');
  assert.deepEqual(earlier.dropped, []);
  assert.deepEqual(earlier.member.receipts, m.receipts);
});

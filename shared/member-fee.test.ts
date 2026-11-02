import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberCollection, memberDues, memberUnpaidFrom, memberBillMonths, myShareFactor, subError } from './billing.ts';
import { changeMemberFee, memberFee, carLedger } from './carpool.ts';
import { DEFAULT_SETTINGS, type AppState, type ShareMember, type Subscription } from './types.ts';

const state: AppState = {
  subscriptions: [],
  methods: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY', collectCurrency: 'CNY' },
  fx: { base: 'USD', fetchedAt: '2026-10-22', rates: { USD: 1, CNY: 8, EUR: 0.8 } },
};
const original: ShareMember = {
  id: 'a',
  name: 'Fictional A',
  share: 40 / 6,
  fee: 40,
  feeCurrency: 'CNY',
  billEvery: 6,
  joined: '2025-10-14',
  // 已收前两期（2025-10-14、2026-04-14 起）
  receipts: [{ id: 'r1', date: '2026-01-17', amount: 80, currency: 'CNY', periods: ['2025-10-14', '2026-04-14'] }],
};
const sub: Subscription = {
  id: 's',
  name: 'Fictional Spotify',
  start: '2025-10-14',
  price: 100,
  currency: 'CNY',
  cycle: { every: 1, unit: 'month' },
  status: 'active',
  category: 'Tools',
  tags: [],
  share: { role: 'owner', seats: 6, collectFrom: '2025-10-14', members: [original] },
};
const adjust = (m = original, from = '2026-07-01') => changeMemberFee(state, sub, m, { from, fee: 44, currency: 'CNY', billEvery: 6 }, '2026-10-22');

test('40调44：日期前后各取整期标准，跨生效日不拆期，历史实收不变', () => {
  const m = adjust();
  assert.equal(memberCollection(sub, m, '2026-06-17').amount, 40);
  assert.equal(memberCollection(sub, m, '2026-07-01').amount, 44);
  assert.equal(memberCollection(sub, m, '2026-07-17').amount, 44);
  assert.equal(memberCollection(sub, m, '2026-06-17').until, '2026-12-16');
  assert.deepEqual(m.receipts, original.receipts);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
  assert.equal(original.feeHistory, undefined);
  assert.equal(memberFee(state, sub, m, '2026-06-30').amount, 40);
  assert.equal(memberDues({ ...sub, share: { ...sub.share!, members: [m] } }, '2026-10-22')[0].owed, 44);
});

test('未来调价不覆盖今天或先前标准；相同生效日替换，周期也按覆盖起点读取', () => {
  const m = adjust(original, '2027-01-01');
  assert.equal(m.fee, 40);
  assert.equal(memberCollection(sub, m, '2026-07-17').amount, 40);
  assert.equal(memberCollection(sub, m, '2027-01-17').amount, 44);
  const changed = changeMemberFee(state, sub, m, { from: '2027-01-01', fee: 25, currency: 'CNY', billEvery: 3 }, '2026-10-22');
  assert.equal(changed.feeHistory!.length, 2);
  assert.equal(memberBillMonths(sub, changed, '2026-12-31'), 6);
  assert.equal(memberBillMonths(sub, changed, '2027-01-01'), 3);
  assert.equal(memberCollection(sub, changed, '2027-01-17').until, '2027-04-16');
  const previousFactor = myShareFactor(sub, '2026-06-30');
  const nextSub = { ...sub, share: { ...sub.share!, members: [adjust()] } };
  assert.equal(myShareFactor(nextSub, '2026-06-30'), previousFactor);
  assert.ok(myShareFactor(nextSub, '2026-07-01') < previousFactor);
  assert.equal(carLedger(state, nextSub, '2026-10-22').yearIncome, 88);
});

test('调价与免费首期：加入期仍对齐且跳过免费期，下一期取新标准；退出不新增应收', () => {
  const m = adjust({ ...original, joined: '2026-10-20', receipts: [], firstPeriod: 'free' }, '2027-01-01');
  assert.equal(memberCollection(sub, m, '2026-10-20').amount, 0);
  assert.equal(memberUnpaidFrom(sub, m), '2027-04-14');
  assert.equal(memberCollection(sub, m, memberUnpaidFrom(sub, m)).amount, 44);
  const left = { ...m, left: '2026-10-31' };
  assert.equal(memberDues({ ...sub, share: { ...sub.share!, members: [left] } }, '2028-01-01')[0].owed, 0);
  assert.equal(memberCollection(sub, left, '2026-11-01').amount, 0);
});

test('收费币种变更的多期欠款按币种换算，外币实收仍原样，零收费可用', () => {
  const m = changeMemberFee(state, sub, original, { from: '2027-01-01', fee: 6, currency: 'USD', billEvery: 6 }, '2026-10-22');
  const s = { ...sub, share: { ...sub.share!, members: [m] } };
  assert.equal(memberCollection(s, m, '2027-01-17').currency, 'USD');
  assert.equal(memberDues(s, '2027-04-14', 'CNY', state)[0].owed, 88); // 2026-10-14 那期 40 CNY + 2027-04-14 那期 6 USD
  assert.equal(memberDues(s, '2026-10-22', 'CNY', state)[0].owed, 40);
  const missing = { ...state, fx: { ...state.fx, rates: { USD: 1 } } };
  assert.ok(Number.isNaN(memberDues(s, '2027-04-14', 'CNY', missing)[0].owed));
  const zero = changeMemberFee(state, sub, original, { from: '2026-07-01', fee: 0, currency: 'EUR', billEvery: 6 }, '2026-10-22');
  assert.equal(memberCollection(sub, zero, '2026-07-17').amount, 0);
  const futureFree = changeMemberFee(state, sub, original, { from: '2027-01-01', fee: 0, currency: 'EUR', billEvery: 6 }, '2026-10-22');
  assert.equal(
    memberDues({ ...sub, share: { ...sub.share!, members: [futureFree] } }, '2027-04-14', 'CNY', {
      ...state,
      fx: { ...state.fx, rates: { USD: 1, CNY: 8 } },
    })[0].owed,
    40,
  );
  assert.deepEqual(m.receipts, original.receipts);
  assert.equal(
    subError({ ...s, share: { ...s.share, members: [{ ...m, feeHistory: [{ from: '2026-02-30', fee: -1, currency: 'usd', billEvery: 0 }] }] } }),
    subError({ ...sub, price: -1 }),
  );
});

test('公开脱敏不带合租：成员身份、分摊、收费历史与结清情况都不外泄', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const m = adjust();
  Object.assign(m.feeHistory![0], { note: 'private extra', contact: 'private@example.test' });
  const masked = maskForPublic({ ...state, subscriptions: [{ ...sub, share: { ...sub.share!, members: [m] } }] }).subscriptions[0];
  assert.equal(masked.share, undefined);
  assert.ok(!JSON.stringify(masked).includes('private'));
});

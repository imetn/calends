import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargesBetween, phaseSubs, subError, FALLBACK_FX } from './billing.ts';
import { contractEvents, contractTerm, currentContract } from './contract.ts';
import { maskForPublic } from './mask.ts';
import { switchPlan, syncPhase, toEditForm } from './phases.ts';
import { DEFAULT_SETTINGS, type Contract, type Subscription } from './types.ts';

const yearly: Contract = { start: '2026-01-17', term: { unit: 'year', every: 1 }, noticeDays: 30 };
// issue #18：年险月付，1-17 起保，每年同日续约
const insurance = (o: Partial<Subscription> = {}): Subscription => ({
  id: 'ins',
  name: 'Fictional Insurance',
  category: 'Insurance',
  tags: [],
  price: 120,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-17',
  status: 'active',
  contract: yearly,
  ...o,
});

test('合同期：按起保日逐年推算，续约日为下一期开始日', () => {
  assert.deepEqual(contractTerm(yearly, '2026-11-19'), {
    index: 0,
    from: '2026-01-17',
    until: '2027-01-16',
    next: '2027-01-17',
    renews: true,
    noticeBy: '2026-12-18',
  });
  assert.equal(contractTerm(yearly, '2027-01-16')!.index, 0);
  assert.equal(contractTerm(yearly, '2027-01-17')!.index, 1);
  assert.equal(contractTerm(yearly, '2035-03-01')!.from, '2035-01-17');
  assert.equal(contractTerm(yearly, '2025-12-01')!.index, 0, '开始前算首期');
  // 月底起保按原日号对齐，不漂移
  const monthEnd: Contract = { start: '2024-01-31', term: { unit: 'month', every: 6 } };
  assert.equal(contractTerm(monthEnd, '2025-02-01')!.next, '2025-07-31');
  assert.equal(contractTerm(monthEnd, '2025-02-01')!.noticeBy, undefined);
});

test('合同期：不续约时期满即无', () => {
  const once: Contract = { ...yearly, renew: 'none' };
  assert.equal(contractTerm(once, '2026-06-01')!.renews, false);
  assert.equal(contractTerm(once, '2027-01-17'), undefined);
  const events = contractEvents(insurance({ contract: once }), '2026-01-01', '2030-01-01', '2026-11-19');
  assert.deepEqual(events, [{ kind: 'end', date: '2027-01-17', from: '2026-01-17', until: '2027-01-16', noticeDays: 30 }]);
  assert.deepEqual(contractEvents(insurance({ contract: once }), '2027-06-01', '2030-01-01', '2026-11-19'), []);
});

test('合同期：当前一期，订阅在续约日前结束时不算续约，已停用没有', () => {
  assert.equal(currentContract(insurance(), '2026-11-19')!.renews, true);
  assert.equal(currentContract(insurance({ end: '2026-12-31' }), '2026-11-19')!.renews, false);
  assert.equal(currentContract(insurance({ end: '2026-10-31' }), '2026-11-19'), undefined);
  assert.equal(currentContract(insurance({ status: 'cancelled' }), '2026-11-19'), undefined);
  assert.equal(currentContract(insurance({ contract: undefined }), '2026-11-19'), undefined);
  // 不续约的提醒日按最后一天倒数；服务在合同最后一天前结束时不提醒，与事件、邮件一致
  assert.equal(contractTerm({ ...yearly, renew: 'none' }, '2026-11-19')!.noticeBy, '2026-12-17');
  assert.equal(currentContract(insurance({ end: '2027-01-16' }), '2026-11-19')!.noticeBy, '2026-12-17');
  assert.equal(currentContract(insurance({ end: '2026-12-31' }), '2026-11-19')!.noticeBy, undefined);
});

test('换套餐当天签了另一份合同：旧合同记为到期，不误报续约', () => {
  const resigned = switchPlan(insurance(), '2027-01-17', {
    price: 150,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    contract: { start: '2027-01-17', term: { unit: 'year', every: 2 }, noticeDays: 30 },
  });
  assert.deepEqual(
    contractEvents(resigned, '2026-01-01', '2029-02-01', '2026-11-19').map((e) => [e.kind, e.date]),
    [
      ['end', '2027-01-17'],
      ['renew', '2029-01-17'],
    ],
  );
  assert.equal(currentContract(resigned, '2026-11-19')!.renews, false);
});

test('合同期事件：逐年续约，停用日在期满当天记为到期，早于期满不记', () => {
  assert.deepEqual(
    contractEvents(insurance(), '2026-01-01', '2028-12-31', '2026-11-19').map((e) => [e.kind, e.date]),
    [
      ['renew', '2027-01-17'],
      ['renew', '2028-01-17'],
    ],
  );
  assert.deepEqual(
    contractEvents(insurance({ end: '2028-01-16' }), '2026-01-01', '2030-01-01', '2026-11-19').map((e) => [e.kind, e.date]),
    [
      ['renew', '2027-01-17'],
      ['end', '2028-01-17'],
    ],
  );
  assert.deepEqual(
    contractEvents(insurance({ end: '2027-06-30' }), '2026-01-01', '2030-01-01', '2026-11-19').map((e) => e.date),
    ['2027-01-17'],
  );
  // 停用日期未知、暂停后都不预测未来
  assert.deepEqual(contractEvents(insurance({ status: 'cancelled' }), '2026-01-01', '2030-01-01', '2026-11-19'), []);
  assert.deepEqual(contractEvents(insurance({ status: 'paused', pausedAt: '2026-11-01' }), '2026-01-01', '2030-01-01', '2026-11-19'), []);
});

test('换套餐沿用合同期，续约日不重复；新周期长于合同期时合同期失效', () => {
  const after = switchPlan(insurance(), '2026-07-01', { price: 150, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  assert.deepEqual(after.phases![1].contract, yearly);
  assert.deepEqual(after.contract, yearly, '顶层镜像最后一段');
  assert.deepEqual(
    contractEvents(after, '2026-01-01', '2028-02-01', '2026-11-19').map((e) => e.date),
    ['2027-01-17', '2028-01-17'],
  );
  const twoYears = switchPlan(insurance(), '2026-07-01', { price: 3000, currency: 'USD', cycle: { unit: 'year', every: 2 } });
  assert.equal(twoYears.phases![1].contract, undefined);
  assert.deepEqual(twoYears.phases![0].contract, yearly);
  // 第一段在续约日前结束，第二段没有合同期：不续约，也不算到期
  assert.deepEqual(contractEvents(twoYears, '2026-01-01', '2030-01-01', '2026-11-19'), []);
  // 编辑表单读写当前段的合同期
  const form = toEditForm(after, '2026-11-19');
  assert.deepEqual(form.contract, yearly);
  const edited = syncPhase({ ...form, contract: { ...yearly, noticeDays: 7 } }, '2026-11-19');
  assert.equal(edited.phases![1].contract!.noticeDays, 7);
  assert.equal(edited.phases![0].contract!.noticeDays, 30);
  assert.equal(phaseSubs(edited)[1].contract!.noticeDays, 7);
});

test('合同期校验：格式、买断与短于付费周期', () => {
  assert.equal(subError(insurance()), undefined);
  assert.equal(subError(insurance({ contract: { ...yearly, term: { unit: 'month', every: 12 } } })), undefined, '12 个月与 1 年等长');
  assert.equal(subError(insurance({ contract: { ...yearly, noticeDays: 0, renew: 'none' } })), undefined);
  const bad: Array<Partial<Contract>> = [
    { start: '2026-02-30' },
    { term: { unit: 'month', every: 0 } },
    { term: { unit: 'lifetime', every: 1 } },
    { term: { unit: 'week', every: 60 } },
    { term: { unit: 'month', every: 1.5 } },
    { term: { unit: 'year', every: 101 } },
    { renew: 'yes' as 'none' },
    { noticeDays: -1 },
    { noticeDays: 2.5 },
  ];
  for (const b of bad) assert.equal(subError(insurance({ contract: { ...yearly, ...b } })), 'core.contract.invalid', JSON.stringify(b));
  assert.equal(subError(insurance({ cycle: { unit: 'year', every: 2 } })), 'core.contract.invalid', '合同期短于付费周期');
  assert.equal(subError(insurance({ cycle: { unit: 'lifetime', every: 1 } })), 'core.contract.invalid', '买断没有合同期');
});

test('合同期不影响扣款', () => {
  const strip = (s: Subscription) => chargesBetween(s, '2026-01-01', '2028-12-31', '2026-11-19').map(({ sub: _sub, ...c }) => c);
  const a = strip(insurance());
  const b = strip(insurance({ contract: undefined }));
  assert.deepEqual(a, b);
  assert.equal(a.length, 36);
});

test('公开页不下发合同期', () => {
  const after = switchPlan(insurance({ showOnPublic: true }), '2026-07-01', { price: 150, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const pub = maskForPublic({ subscriptions: [after], methods: [], settings: { ...DEFAULT_SETTINGS, publicPage: true }, fx: FALLBACK_FX });
  assert.ok(pub.subscriptions.length);
  assert.ok(!JSON.stringify(pub).includes('"contract"'));
});

test('CSV 导出导入保留合同期，认不出的合同期在预览里拦下', async () => {
  const { exportSubscriptionsCsv } = await import('./csv.ts');
  const { readImportCsv, prepareImport } = await import('./import-ledger.ts');
  const csv = exportSubscriptionsCsv({
    subscriptions: [
      insurance(),
      insurance({ id: 'b', name: 'Once', contract: { start: '2026-03-01', term: { unit: 'month', every: 6 }, renew: 'none' } }),
      insurance({ id: 'c', name: 'Plain', contract: undefined }),
    ],
    methods: [],
  });
  assert.match(csv.split('\n')[0], /Contract Start,Contract Term,Contract Renews,Contract Notice Days$/);
  const result = prepareImport(readImportCsv(csv, [], '2026-11-19'), [], '2026-11-19');
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.subscriptions.map((s) => s.contract),
    [yearly, { start: '2026-03-01', term: { unit: 'month', every: 6 }, renew: 'none' }, undefined],
  );
  const broken = csv.replace('2026-01-17,Yearly,Yes,30', '2026-01-17,Biweekly,Yes,30');
  assert.equal(prepareImport(readImportCsv(broken, [], '2026-11-19'), [], '2026-11-19').issues[0].message, 'core.contract.invalid');
});

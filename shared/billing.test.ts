import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, chargesBetween, effectiveStatus, monthlyGross, nextCharge, runwayFor, memberDues, totals, FALLBACK_FX } from './billing.ts';
import { migrateReceivables } from './receivables-legacy.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const base = (o: Partial<Subscription>): Subscription => ({
  id: 'x',
  name: 'X',
  category: '工具',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-31',
  status: 'active',
  ...o,
});

test('月末夹紧且不漂移', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
});

test('下次扣款与到期', () => {
  const s = base({});
  assert.equal(nextCharge(s, '2026-10-19'), '2026-10-31');
  const ended = base({ end: '2026-05-01' });
  assert.equal(nextCharge(ended, '2026-10-19'), undefined);
  assert.equal(chargesBetween(ended, '2026-01-01', '2026-12-31', '2026-10-19').length, 4);
});

test('试用期不计费', () => {
  const s = base({ status: 'trial', start: '2026-10-01', trialEnd: '2026-10-15' });
  assert.deepEqual(
    chargesBetween(s, '2026-10-01', '2026-10-31', '2026-10-19').map((c) => c.date),
    ['2026-10-15'],
  );
});

test('余额续航', () => {
  const state: AppState = {
    subscriptions: [base({ price: 100, currency: 'TRY', start: '2026-01-05', methodId: 'tr' })],
    methods: [{ id: 'tr', name: 'TR', kind: 'appstore', currency: 'TRY', balance: 350, balanceAsOf: '2026-10-01' }],
    settings: DEFAULT_SETTINGS,
    fx: FALLBACK_FX,
  };
  const r = runwayFor(state.methods[0], state, '2026-10-19')!;
  assert.equal(r.current, 250); // 10-05 已扣
  assert.equal(r.coveredCharges, 2); // 11-05、12-05
  assert.equal(r.runsOutOn, '2027-01-05');
});

test('合租', () => {
  // 旧数据只有已付至：转成期初结清后照常算
  const s = migrateReceivables(
    base({
      price: 60,
      start: '2026-01-10',
      share: {
        role: 'owner',
        seats: 6,
        members: [
          { id: 'a', name: 'A', share: 10, paidUntil: '2026-11-09' },
          { id: 'b', name: 'B', share: 10 },
        ],
      },
    }),
    'CNY',
  );
  const d = memberDues(s, '2026-10-19');
  // 已付至 11 月 9 日：还没到期，不欠
  assert.equal(d[0].periodsOwed, 0);
  assert.equal(d[1].owed, 100);
  // 按半年收、已付至 7 月 16 日：10 月 20 日欠一期（7 月 17 日那期），金额 = 每期份额 × 6
  const half = migrateReceivables(
    base({
      price: 60,
      start: '2021-04-14',
      share: { role: 'owner', seats: 6, members: [{ id: 'c', name: 'C', share: 10, billEvery: 6, paidUntil: '2026-07-16' }] },
    }),
    'CNY',
  );
  const h = memberDues(half, '2026-10-20');
  assert.equal(h[0].periodsOwed, 1);
  assert.equal(Math.round(h[0].owed), 60);
  const state: AppState = { subscriptions: [s], methods: [], settings: DEFAULT_SETTINGS, fx: FALLBACK_FX };
  const t = totals({ ...state, settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' } }, '2026-10-19');
  assert.equal(Math.round(t.mrr), 40);
});

test('实际扣款记录 + 下次扣款日', () => {
  // 一次付两年：2026-08-19 付 20.92，下一笔 2028-07-20
  const s = base({
    price: 10.46,
    cycle: { unit: 'year', every: 1 },
    start: '2026-08-19',
    payments: [{ date: '2026-08-19', amount: 20.92 }],
    nextDue: '2028-07-20',
  });
  const cs = chargesBetween(s, '2026-01-01', '2029-12-31', '2026-10-19');
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount]),
    [
      ['2026-08-19', 20.92],
      ['2028-07-20', 10.46],
      ['2029-07-20', 10.46],
    ],
  );
  // 提前续费：最后一笔之后才开始推算
  const f = base({
    price: 10.46,
    cycle: { unit: 'year', every: 1 },
    start: '2025-11-07',
    payments: [
      { date: '2025-11-07', amount: 10.46 },
      { date: '2026-10-08', amount: 10.46 },
    ],
    nextDue: '2027-10-08',
  });
  assert.equal(nextCharge(f, '2026-10-19'), '2027-10-08');
});

test('赠送时长：买一年送一年', () => {
  const s = base({ price: 120, cycle: { unit: 'year', every: 1 }, start: '2026-01-01', bonus: { from: '2027-01-01', until: '2028-01-01' } });
  const cs = chargesBetween(s, '2025-01-01', '2029-06-30', '2026-10-19');
  assert.deepEqual(
    cs.map((c) => c.date),
    ['2026-01-01', '2028-01-01', '2029-01-01'],
  );
  assert.equal(Math.round(monthlyGross(s, '2026-10-19') * 100) / 100, 5); // 120 摊到 24 个月
  assert.equal(Math.round(monthlyGross(s, '2028-03-01')), 10); // 赠送结束后恢复
  // 不整周期的赠送：送 45 天，下一笔顺延到赠送结束那天
  const m = base({ price: 10, start: '2026-01-10', bonus: { from: '2026-03-10', until: '2026-04-24' } });
  assert.deepEqual(
    chargesBetween(m, '2026-01-01', '2026-06-30', '2026-01-01').map((c) => c.date),
    ['2026-01-10', '2026-02-10', '2026-04-24', '2026-05-24', '2026-06-24'],
  );
});

test('手动记一笔：推算的历史先固化，未来照旧', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const s = base({ price: 10, start: '2026-01-10' });
  const r = savePayment(s, '2026-04-01', { date: '2026-03-15', amount: -4, kind: 'refund' });
  const cs = chargesBetween(r, '2026-01-01', '2026-06-30', '2026-04-01');
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount]),
    [
      ['2026-01-10', 10],
      ['2026-02-10', 10],
      ['2026-03-10', 10],
      ['2026-03-15', -4],
      ['2026-04-10', 10],
      ['2026-05-10', 10],
      ['2026-06-10', 10],
    ],
  );
  // 改成「扣款失败」：不计金额
  const f = savePayment(r, '2026-04-01', { date: '2026-03-10', amount: 10, kind: 'failed' }, { date: '2026-03-10', index: 0 });
  assert.equal(chargesBetween(f, '2026-03-10', '2026-03-10', '2026-04-01')[0].amount, 0);
  const d = deletePayment(f, '2026-04-01', '2026-03-15', 0);
  assert.equal(chargesBetween(d, '2026-03-11', '2026-03-31', '2026-04-01').length, 0);
});

test('有计划阶段时取消、暂停对当前阶段生效', () => {
  const phases = [
    { start: '2026-01-10', price: 10, currency: 'USD', cycle: { unit: 'month' as const, every: 1 } },
    { start: '2026-10-28', price: 100, currency: 'USD', cycle: { unit: 'year' as const, every: 1 } },
  ];
  const cancelled = base({ start: '2026-01-10', phases, status: 'cancelled', end: '2026-10-20' });
  assert.equal(nextCharge(cancelled, '2026-10-21'), undefined);
  assert.equal(effectiveStatus(cancelled, '2026-10-21'), effectiveStatus(base({ status: 'cancelled', end: '2026-10-20' }), '2026-10-21'));
  const paused = base({ start: '2026-01-10', phases, status: 'paused', pausedAt: '2026-10-20' });
  assert.equal(nextCharge(paused, '2026-10-21'), undefined);
  assert.equal(chargesBetween(paused, '2026-10-21', '2027-12-31', '2026-10-21').length, 0);
});

test('编辑表单对应当前阶段，保存后计划阶段不变', async () => {
  const { switchPlan, toEditForm, syncPhase } = await import('./phases.ts');
  const s = switchPlan(base({ start: '2026-01-10', price: 10, currency: 'TRY' }), '2026-10-28', {
    price: 100,
    currency: 'USD',
    cycle: { unit: 'year', every: 1 },
    planned: true,
  });
  const form = toEditForm(s, '2026-10-20');
  assert.equal(form.currency, 'TRY');
  const saved = syncPhase({ ...form, methodId: 'card' }, '2026-10-20');
  assert.equal(saved.phases![0].methodId, 'card');
  assert.equal(saved.phases![1].currency, 'USD');
  assert.equal(saved.phases![1].price, 100);
  assert.equal(saved.phases![0].end, '2026-10-27');
});

test('issue #11：提前续费归入当期，下次扣款日顺延一期，删除后恢复', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const { chargeServicePeriod } = await import('./billing.ts');
  const today = '2026-10-30';
  const vps = base({ price: 10, start: '2026-08-02' });
  const early = { date: '2026-10-28', amount: 10 };
  const planned = (s: Subscription) => chargesBetween(s, '2026-10-29', '2027-01-31', today).map((c) => c.date);
  const records = [
    { date: '2026-08-02', amount: 10 },
    { date: '2026-09-02', amount: 10 },
    { date: '2026-10-02', amount: 10 },
  ];
  for (const s of [vps, base({ ...vps, payments: records }), base({ ...vps, payments: records, nextDue: '2026-11-02' })]) {
    const r = savePayment(s, today, early);
    assert.equal(nextCharge(r, today), '2026-12-02');
    assert.deepEqual(planned(r), ['2026-12-02', '2027-01-02']);
    assert.deepEqual(chargeServicePeriod(r, '2026-10-28', '2026-11-02'), { from: '2026-11-02', until: '2026-12-02' });
    const c = chargesBetween(r, '2026-10-28', '2026-10-28', today)[0];
    assert.equal(c.serviceDate, '2026-11-02');
    assert.equal(nextCharge(deletePayment(r, today, '2026-10-28', 0), today), '2026-11-02');
    // 改回到期日当天：不再算提前
    const moved = savePayment(r, today, { date: '2026-11-02', amount: 10 }, { date: '2026-10-28', index: 0 });
    assert.equal(nextCharge(moved, '2026-11-03'), '2026-12-02');
    assert.equal(moved.payments?.find((p) => p.date === '2026-11-02')?.serviceDate, undefined);
  }
  // 连续提前两期，逐笔删除逐期恢复
  const twice = savePayment(savePayment(vps, today, early), '2026-11-20', { date: '2026-11-20', amount: 10 });
  assert.equal(nextCharge(twice, '2026-11-21'), '2027-01-02');
  assert.equal(nextCharge(deletePayment(twice, '2026-11-20', '2026-11-20', 0), '2026-11-21'), '2026-12-02');
});

test('issue #11：年付与月底日号沿原锚点顺延', async () => {
  const { savePayment } = await import('./phases.ts');
  const { chargeServicePeriod } = await import('./billing.ts');
  const yearly = base({ price: 100, start: '2025-11-02', cycle: { unit: 'year', every: 1 } });
  assert.equal(nextCharge(savePayment(yearly, '2026-09-02', { date: '2026-09-02', amount: 100 }), '2026-09-03'), '2027-11-02');
  const monthEnd = base({ price: 10, start: '2026-01-31' });
  const r = savePayment(monthEnd, '2026-04-28', { date: '2026-04-28', amount: 10 });
  assert.equal(nextCharge(r, '2026-04-29'), '2026-05-31');
  assert.equal(nextCharge(savePayment(r, '2026-05-20', { date: '2026-05-20', amount: 10 }), '2026-05-21'), '2026-06-30');
  assert.deepEqual(chargeServicePeriod(r, '2026-04-28', '2026-04-30'), { from: '2026-04-30', until: '2026-05-31' });
});

test('issue #11：准时、补录、逾期与非续费记录不顺延', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const today = '2026-10-30';
  const vps = base({ price: 10, start: '2026-08-02' });
  // 准时
  assert.equal(nextCharge(savePayment(vps, '2026-11-02', { date: '2026-11-02', amount: 10 }), '2026-11-03'), '2026-12-02');
  // 补录更早的一笔
  assert.equal(nextCharge(savePayment(vps, today, { date: '2026-09-15', amount: 10 }), today), '2026-11-02');
  // 删掉准时的一笔后再补回：不算提前
  const removed = deletePayment(vps, today, '2026-10-02', 0);
  assert.equal(nextCharge(savePayment(removed, today, { date: '2026-10-02', amount: 10 }), today), '2026-11-02');
  // 逾期：保持原计费日，不漂到付款日
  const records = [{ date: '2026-08-02', amount: 10 }];
  assert.equal(nextCharge(savePayment(base({ ...vps, payments: records }), '2026-09-15', { date: '2026-09-15', amount: 10 }), '2026-09-16'), '2026-10-02');
  // 退款、补差、失败
  for (const kind of ['refund', 'adjust', 'failed'] as const) {
    const r = savePayment(vps, today, { date: '2026-10-28', amount: kind === 'refund' ? -1 : 1, kind });
    assert.equal(nextCharge(r, today), '2026-11-02', kind);
  }
  // 后付费、试用、暂停不顺延
  assert.equal(
    nextCharge(savePayment(base({ ...vps, billing: 'postpaid' }), today, { date: '2026-10-28', amount: 10 }), today),
    nextCharge(base({ ...vps, billing: 'postpaid' }), today),
  );
  const paused = savePayment(base({ ...vps, pausedAt: '2026-10-20', status: 'paused' }), today, { date: '2026-10-28', amount: 10 });
  assert.equal(paused.payments?.find((p) => p.date === '2026-10-28')?.serviceDate, undefined);
  const trial = savePayment(base({ ...vps, status: 'trial', trialEnd: '2026-11-02' }), today, { date: '2026-10-28', amount: 10 });
  assert.equal(trial.payments?.find((p) => p.date === '2026-10-28')?.serviceDate, undefined);
});

test('提前记账后余额不再重复扣原到期日那一笔', async () => {
  const { savePayment } = await import('./phases.ts');
  const method = { id: 'w', name: 'Wallet', kind: 'wallet', currency: 'USD', balance: 500.01, balanceAsOf: '2026-11-02' } as AppState['methods'][number];
  const sub = base({ price: 499.99, start: '2026-07-03', methodId: 'w' });
  const state = (s: Subscription) => ({ subscriptions: [s], methods: [method], fx: FALLBACK_FX, settings: DEFAULT_SETTINGS }) as unknown as AppState;
  const r = runwayFor(method, state(savePayment(sub, '2026-11-02', { date: '2026-11-02', amount: 499.99 })), '2026-11-03')!;
  assert.equal(r.current, 500.01);
  assert.equal(r.shortfall?.date, '2027-01-03');
});

test('issue #11 审查：提前扣款规则、赠送期与导入边界', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const { billingPeriod, chargeServicePeriod } = await import('./billing.ts');
  // 提前 5 天扣款：账期仍按服务日，删除后回到现金日
  const lead = savePayment(base({ start: '2026-01-02', chargeLeadDays: 5 }), '2026-10-20', { date: '2026-10-20', amount: 10 });
  assert.equal(lead.payments?.at(-1)?.serviceDate, '2026-11-02');
  assert.deepEqual(chargeServicePeriod(lead, '2026-10-20', '2026-11-02'), { from: '2026-11-02', until: '2026-12-02' });
  assert.equal(billingPeriod(lead, '2026-11-15').paidThrough, '2026-12-01');
  assert.equal(nextCharge(lead, '2026-10-21'), '2026-11-27');
  assert.equal(nextCharge(deletePayment(lead, '2026-10-21', '2026-10-20', 0), '2026-10-21'), '2026-10-28');
  // 赠送期：不再重复算同一期
  const bonus = base({
    start: '2026-01-15',
    bonus: { from: '2026-05-15', until: '2026-08-15' },
    payments: ['01', '02', '03', '04', '08', '09', '10'].map((m) => ({ date: `2026-${m}-15`, amount: 10 })),
  });
  const paid = savePayment(bonus, '2026-11-10', { date: '2026-11-10', amount: 10 });
  assert.deepEqual(
    chargesBetween(paid, '2026-11-01', '2026-12-31', '2026-11-10').map((c) => c.date),
    ['2026-11-10', '2026-12-15'],
  );
  // 赠送期结束后恢复的第一笔也能提前
  const gap = base({ start: '2026-01-15', bonus: { from: '2026-05-15', until: '2026-08-15' }, payments: [{ date: '2026-04-15', amount: 10 }] });
  assert.equal(savePayment(gap, '2026-08-10', { date: '2026-08-10', amount: 10 }).payments?.at(-1)?.serviceDate, '2026-08-15');
  // 导入边界
  const imported = savePayment(base({ start: '2020-01-02', estimateFrom: '2026-10-15' }), '2026-10-30', { date: '2026-10-28', amount: 10 });
  assert.deepEqual(
    chargesBetween(imported, '2026-10-15', '2026-12-31', '2026-10-30').map((c) => c.date),
    ['2026-10-28', '2026-12-02'],
  );
});

test('issue #11 审查：改写、补记与删除顺序', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const { billingPeriod, stopBillingPeriod, chargeServicePeriod } = await import('./billing.ts');
  const today = '2026-10-30';
  const vps = base({ start: '2026-08-02' });
  const dates = (s: Subscription) => chargesBetween(s, '2026-10-01', '2026-12-31', today).map((c) => c.date);
  // 改准时一笔的日期、删后重记：归上一期，不吞下一期
  const moved = savePayment(vps, today, { date: '2026-10-05', amount: 10 }, { date: '2026-10-02', index: 0 });
  assert.deepEqual(dates(moved), ['2026-10-05', '2026-11-02', '2026-12-02']);
  const redo = savePayment(deletePayment(vps, today, '2026-10-02', 0), today, { date: '2026-10-20', amount: 10 });
  assert.deepEqual(dates(redo), ['2026-10-20', '2026-11-02', '2026-12-02']);
  // 只改金额：仍结清原来那一期
  const early = savePayment(vps, today, { date: '2026-10-28', amount: 10 });
  const both = savePayment(early, '2026-12-02', { date: '2026-12-02', amount: 10 });
  const edited = savePayment(both, '2026-12-02', { date: '2026-10-28', amount: 11 }, { date: '2026-10-28', index: 0 });
  assert.equal(edited.payments?.find((p) => p.date === '2026-10-28')?.serviceDate, '2026-11-02');
  assert.equal(edited.nextDue, both.nextDue);
  assert.deepEqual(chargeServicePeriod(edited, '2026-10-28', '2026-11-02'), { from: '2026-11-02', until: '2026-12-02' });
  // 账期与建议退款和准时付一致；付款之前的回溯仍属上一期
  assert.deepEqual(billingPeriod(early, '2026-11-15'), { from: '2026-11-02', paidThrough: '2026-12-01', paid: 10, days: 30 });
  assert.equal(billingPeriod(early, '2026-10-25').paidThrough, '2026-11-01');
  assert.equal(stopBillingPeriod(early, '2026-11-15', '2026-11-15').paid, 10);
  // 两种删除顺序结果一致
  const twice = savePayment(early, '2026-11-20', { date: '2026-11-20', amount: 10 });
  const a = deletePayment(deletePayment(twice, '2026-11-20', '2026-11-20', 0), '2026-11-20', '2026-10-28', 0);
  const b = deletePayment(deletePayment(twice, '2026-11-20', '2026-10-28', 0), '2026-11-20', '2026-11-20', 0);
  assert.equal(a.nextDue, '2026-11-02');
  assert.equal(b.nextDue, '2026-11-02');
  // 没有记录时事后补记：推算的那一期不再固化成实付
  const late = savePayment(vps, '2026-11-05', { date: '2026-10-28', amount: 10 });
  assert.deepEqual(
    late.payments?.map((p) => p.date),
    ['2026-08-02', '2026-09-02', '2026-10-02', '2026-10-28'],
  );
  assert.equal(nextCharge(late, '2026-11-05'), '2026-12-02');
  // 补记准时的一笔不动后面的
  const onTime = savePayment(vps, '2026-11-05', { date: '2026-10-02', amount: 10 });
  assert.equal(
    onTime.payments?.some((p) => p.date === '2026-11-02'),
    true,
  );
  // 非法 serviceDate 不能写入
  assert.throws(() =>
    savePayment(base({ ...vps, payments: [{ date: '2026-08-02', amount: 10, serviceDate: 'nope' }] }), today, {
      date: '2026-08-03',
      amount: 1,
      kind: 'adjust',
    }),
  );
});

test('issue #11 审查：提前付下一段与长周期', async () => {
  const { savePayment } = await import('./phases.ts');
  const phases = [
    { start: '2026-08-01', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    { start: '2026-11-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
  ] as Subscription['phases'];
  const two = base({ start: '2026-08-01', phases });
  for (const phase of [undefined, '2026-11-01']) {
    const r = savePayment(two, '2026-10-30', { date: '2026-10-28', amount: 20 }, undefined, phase);
    assert.ok(!r.phases?.[0].payments?.some((p) => p.date === '2026-10-28'));
    assert.equal(r.phases?.[1].payments?.[0].serviceDate, '2026-11-01');
    assert.deepEqual(
      chargesBetween(r, '2026-10-20', '2026-12-31', '2026-10-30').map((c) => c.date),
      ['2026-10-28', '2026-12-01'],
    );
  }
  // 13 个月一期：提前付后下一笔仍能找到
  const long = savePayment(base({ start: '2025-01-05', cycle: { unit: 'month', every: 13 }, payments: [{ date: '2025-01-05', amount: 10 }] }), '2025-01-20', {
    date: '2025-01-20',
    amount: 10,
  });
  assert.equal(nextCharge(long, '2025-01-21'), '2027-03-05');
});

test('issue #11 二审：补记不串段，改日期不重算，账期不依赖原锚点', async () => {
  const { savePayment, deletePayment } = await import('./phases.ts');
  const { billingPeriod, chargeServicePeriod } = await import('./billing.ts');
  const phases = [
    { start: '2026-08-01', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    { start: '2026-11-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
  ] as Subscription['phases'];
  const two = base({ start: '2026-08-01', phases });
  const dates = (s: Subscription, today: string) => chargesBetween(s, '2026-10-20', '2026-12-31', today).map((c) => c.date);
  // 历史补记留在原段，下一段首期还在
  const backfill = savePayment(two, '2026-10-30', { date: '2026-09-15', amount: 10 });
  assert.ok(!backfill.phases?.[1].payments?.length);
  assert.ok(dates(backfill, '2026-10-30').includes('2026-11-01'));
  // 已路由到下一段的付款：改日期、不带 phase 改金额和删除都留在那一段
  const routed = savePayment(two, '2026-10-30', { date: '2026-10-28', amount: 20 });
  const moved = savePayment(routed, '2026-10-30', { date: '2026-10-25', amount: 20 }, { date: '2026-10-28', index: 0 }, '2026-11-01');
  assert.deepEqual(dates(moved, '2026-10-30'), ['2026-10-25', '2026-12-01']);
  assert.equal(savePayment(routed, '2026-10-30', { date: '2026-10-28', amount: 21 }, { date: '2026-10-28', index: 0 }).phases?.[1].payments?.[0].amount, 21);
  assert.ok(dates(deletePayment(routed, '2026-10-30', '2026-10-28', 0), '2026-10-30').includes('2026-11-01'));
  // 连续提前时改第一笔的日期：结清关系不变
  const vps = base({ start: '2026-08-02' });
  const early = savePayment(vps, '2026-10-30', { date: '2026-10-28', amount: 10 });
  const twice = savePayment(early, '2026-11-20', { date: '2026-11-20', amount: 10 });
  const earlier = savePayment(twice, '2026-11-20', { date: '2026-10-25', amount: 10 }, { date: '2026-10-28', index: 0 });
  assert.equal(earlier.nextDue, twice.nextDue);
  assert.equal(earlier.payments?.find((p) => p.date === '2026-10-25')?.serviceDate, '2026-11-02');
  // 改到到期日之后才算不再提前
  assert.equal(savePayment(early, '2026-11-05', { date: '2026-11-03', amount: 10 }, { date: '2026-10-28', index: 0 }).nextDue, '2026-11-02');
  // 停止或暂停后改日期不多出一笔
  const stopped: Subscription = { ...early, end: '2026-11-10', stop: { kind: 'cancel', date: '2026-11-10', paidThrough: '2026-12-01' } };
  assert.deepEqual(
    chargesBetween(
      savePayment(stopped, '2026-11-15', { date: '2026-10-27', amount: 10 }, { date: '2026-10-28', index: 0 }),
      '2026-10-20',
      '2026-12-31',
      '2026-11-15',
    ).map((c) => c.date),
    ['2026-10-27'],
  );
  // 计费日已不在原锚点时，账期从结清的那一期起算
  const shifted = savePayment(
    base({ start: '2026-08-02', payments: ['08-02', '09-02', '10-05'].map((d) => ({ date: `2026-${d}`, amount: 10 })), nextDue: '2026-10-05' }),
    '2026-10-30',
    { date: '2026-10-30', amount: 10 },
  );
  assert.deepEqual(chargeServicePeriod(shifted, '2026-10-30', '2026-11-05'), { from: '2026-11-05', until: '2026-12-05' });
  const lead = savePayment(
    base({ start: '2026-08-20', chargeLeadDays: 5, nextDue: '2026-10-15', payments: [{ date: '2026-10-15', amount: 10 }] }),
    '2026-11-01',
    { date: '2026-11-01', amount: 10 },
  );
  assert.equal(billingPeriod(lead, '2026-11-25').paidThrough, '2026-12-19');
  // 无记录补记与录入日期无关
  for (const today of ['2026-11-05', '2026-12-10']) {
    const late = savePayment(vps, today, { date: '2026-10-28', amount: 10 });
    assert.equal(late.payments?.find((p) => p.date === '2026-10-28')?.serviceDate, '2026-11-02');
    assert.deepEqual(
      chargesBetween(late, '2026-10-20', '2026-12-31', today).map((c) => c.date),
      ['2026-10-28', '2026-12-02'],
    );
  }
  // 无记录且在到期日当天记账：替换推算，不写成两笔
  const onDue = savePayment(vps, '2026-11-02', { date: '2026-11-02', amount: 10 });
  assert.equal(onDue.payments?.filter((p) => p.date === '2026-11-02').length, 1);
  // 已结束阶段删掉提前付款：不再推算回来
  const ended = base({
    start: '2026-08-02',
    end: '2026-11-30',
    payments: [
      { date: '2026-08-02', amount: 10 },
      { date: '2026-09-02', amount: 10 },
      { date: '2026-10-02', amount: 10 },
    ],
  });
  const paid = savePayment(ended, '2026-10-30', { date: '2026-10-28', amount: 10 });
  assert.ok(!chargesBetween(deletePayment(paid, '2026-12-20', '2026-10-28', 0), '2026-10-20', '2026-12-31', '2026-12-20').some((c) => c.date === '2026-11-02'));
});

test('issue #11 三审：补记旧账后再记账不丢历史推算', async () => {
  const { savePayment } = await import('./phases.ts');
  const today = '2026-11-03';
  const sub = base({ start: '2023-01-01' });
  const total = (s: Subscription) =>
    chargesBetween(s, '2023-01-01', today, today)
      .filter((c) => !c.kind)
      .reduce((a, c) => a + c.amount, 0);
  assert.equal(total(sub), 470);
  const old = savePayment(sub, today, { date: '2023-06-15', amount: 10 });
  assert.equal(total(old), 470);
  assert.equal(old.payments?.find((p) => p.date === '2023-06-15')?.serviceDate, '2023-07-01');
  assert.equal(nextCharge(old, '2026-11-04'), '2026-12-01');
  assert.equal(total(savePayment(old, today, { date: '2026-11-01', amount: 10 }, { date: '2026-11-01', index: 0 })), 470);
  assert.equal(total(savePayment(old, today, { date: '2023-09-01', amount: 10 }, { date: '2023-09-01', index: 0 })), 470);
  // 分段：历史补记不影响后面的推算
  const phases = [
    { start: '2023-01-01', end: '2024-12-31', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    { start: '2025-01-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
  ] as Subscription['phases'];
  const two = base({ start: '2023-01-01', phases });
  const before = total(two);
  const once = savePayment(two, today, { date: '2023-06-15', amount: 10 });
  assert.equal(total(once), before);
  assert.equal(total(savePayment(once, today, { date: '2024-03-01', amount: 10 }, { date: '2024-03-01', index: 0 })), before);
  // 已结束的订阅改旧账不多出结束日一笔
  const ended = base({ start: '2023-01-01', end: '2024-12-31' });
  assert.equal(total(savePayment(ended, today, { date: '2023-06-01', amount: 10 }, { date: '2023-06-01', index: 0 })), total(ended));
  assert.equal(total(savePayment(ended, today, { date: '2023-06-15', amount: 10 })), total(ended));
});

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

test('钱包反馈：校准余额后的推演与提醒', async (t) => {
  const { editedBalance } = await import('./billing.ts');
  const { topUpPlan } = await import('./metrics.ts');
  const { buildDaily } = await import('../worker/notify.ts');
  const method = { id: 'w', name: 'Wallet', kind: 'prepaid', currency: 'USD', balance: 500.01, balanceAsOf: '2026-11-02' } as AppState['methods'][number];
  const sub = base({ name: 'Fictional', price: 499.99, start: '2026-07-03', nextDue: '2026-11-03', methodId: 'w' });
  const state = (m: AppState['methods'][number] = method, s: Subscription = sub) =>
    ({ subscriptions: [s], methods: [m], fx: FALLBACK_FX, settings: DEFAULT_SETTINGS }) as unknown as AppState;
  // 截图那组：当天这笔扣完剩 0.02，提醒要写清校准值和已扣金额
  const r = runwayFor(method, state(), '2026-11-03')!;
  assert.ok(Math.abs(r.current - 0.02) < 1e-6);
  assert.equal(r.shortfall?.date, '2026-12-03');
  assert.ok(Math.abs(r.spentSince - 499.99) < 1e-6);
  assert.ok(Math.abs(r.beforeShortfall! - 0.02) < 1e-6);
  assert.deepEqual(
    r.dueToday.map((c) => c.date),
    ['2026-11-03'],
  );
  const { flatten, setLocale } = await import('./i18n.ts');
  const { default: messages } = await import('./locales/en/notify.json', { with: { type: 'json' } });
  setLocale('en', [flatten('notify', messages)]);
  t.after(() => setLocale('en', []));
  const note = buildDaily(state(), '2026-11-03')!
    .sections.flatMap((x) => x.rows)
    .find((x) => x.title === 'Wallet')!.sub!;
  for (const part of ['500.01', '499.99', '0.02']) assert.ok(note.includes(part), note);
  // 当天的扣款不够：今天就报，不跳到下个月
  const low = { ...method, balance: 100 };
  const today = runwayFor(low, state(low), '2026-11-03')!;
  assert.equal(today.shortfall?.date, '2026-11-03');
  assert.equal(today.beforeShortfall, 100);
  assert.equal(today.spentSince, 0);
  assert.equal(today.coveredCharges, 0);
  // 余额照样扣到今天：当天充值不会把这笔抹掉，下个月的提醒也还在
  assert.ok(Math.abs(today.current + 399.99) < 1e-6);
  const toppedUp = { ...low, balance: Math.round((today.current + 400) * 100) / 100, balanceAsOf: '2026-11-03' };
  assert.equal(toppedUp.balance, 0.01);
  assert.equal(runwayFor(toppedUp, state(toppedUp), '2026-11-04')!.current, 0.01);
  assert.equal(runwayFor(toppedUp, state(toppedUp), '2026-11-04')!.shortfall?.date, '2026-12-03');
  const plan = topUpPlan(state(low), '2026-11-03')[0];
  assert.equal(plan.deadline, '2026-11-03');
  assert.ok(Math.abs(plan.minNeed - 399.99) < 1e-6);
  assert.ok(
    buildDaily(state(low), '2026-11-03')!
      .sections.flatMap((x) => x.rows)
      .some((x) => x.title === 'Wallet' && x.amount),
  );
  // 累计不够：写的是扣到那一笔之前的余额，不是今天的余额
  const two = base({ id: 'y', name: 'Second', price: 80, start: '2026-07-04', nextDue: '2026-11-04', methodId: 'w' });
  const hundred = { ...method, balance: 100, balanceAsOf: '2026-11-03' };
  const both = { ...state(hundred), subscriptions: [base({ ...two, id: 'z', name: 'First', start: '2026-07-04' }), two] } as AppState;
  const piled = runwayFor(hundred, both, '2026-11-03')!;
  assert.equal(piled.shortfall?.date, '2026-11-04');
  assert.equal(piled.beforeShortfall, 20);
  assert.equal(piled.current, 100);
  const pile = buildDaily(both, '2026-11-03')!
    .sections.flatMap((x) => x.rows)
    .find((x) => x.title === 'Wallet')!.sub!;
  assert.ok(pile.includes('$20.00'), pile);
  // 今天不够时，洞察和卡片都用扣到今天的余额
  const { insights } = await import('./metrics.ts');
  const { default: coreMessages } = await import('./locales/en/core.json', { with: { type: 'json' } });
  setLocale('en', [flatten('notify', messages), flatten('core', coreMessages)]);
  const insight = insights(state(low), '2026-11-03').find((x) => x.methods?.[0]?.id === 'w');
  assert.ok(insight!.body.startsWith("After today's Fictional"), insight!.body);
  assert.ok(insight!.body.includes('399.99'), insight!.body);
  // 退款和失败记录不算余额不够；已透支时不说「只剩」
  const over = { ...method, balance: 10, balanceAsOf: '2026-10-29' };
  const owed = base({ ...sub, price: 50, start: '2026-10-30', nextDue: '2026-11-30' });
  const failed = base({
    ...owed,
    payments: [
      { date: '2026-11-03', amount: 0, kind: 'failed' },
      { date: '2026-11-03', amount: -10, kind: 'refund' },
    ],
  });
  const overRun = runwayFor(over, state(over, failed), '2026-11-03')!;
  assert.equal(overRun.shortfall?.date, '2026-11-30');
  assert.deepEqual(overRun.dueToday, []);
  const overdrawn = { ...over, lowRunwayDays: 27 };
  const overNote = buildDaily(state(overdrawn, owed), '2026-11-03')!
    .sections.flatMap((x) => x.rows)
    .find((x) => x.title === 'Wallet')!.sub!;
  assert.ok(overNote.includes('already') && overNote.includes('40.00'), overNote);
  // 今天的多笔都算在内，0 元的不算；买断也报
  const free = base({ id: 'f', name: 'Free', price: 0, start: '2026-07-03', nextDue: '2026-11-03', methodId: 'w' });
  const many = { ...state(), subscriptions: [free, sub, base({ ...sub, id: 'n', name: 'Next', price: 20 })] } as AppState;
  assert.deepEqual(
    runwayFor(method, many, '2026-11-03')!
      .dueToday.map((c) => c.sub.name)
      .sort(),
    ['Fictional', 'Next'],
  );
  const once = base({ price: 499.99, start: '2026-11-03', nextDue: undefined, cycle: { unit: 'lifetime', every: 1 }, methodId: 'w' });
  const lump = runwayFor(low, state(low, once), '2026-11-03')!;
  assert.equal(lump.shortfall?.date, '2026-11-03');
  assert.equal(topUpPlan(state(low, once), '2026-11-03').length, 1);
  // 校准日当天的扣款算已包含；未来的校准日按今天算，不跳过中间的扣款
  assert.equal(runwayFor({ ...method, balanceAsOf: '2026-11-03' }, state(), '2026-11-03')!.current, 500.01);
  const future = runwayFor({ ...method, balanceAsOf: '2026-12-20' }, state(), '2026-11-03')!;
  assert.equal(future.current, 500.01);
  assert.equal(future.shortfall?.date, '2027-01-03');
  // 表单改余额：校准日到今天，否则旧日期之后的扣款被重复扣
  const old = { balance: 100, balanceAsOf: '2026-10-01' };
  assert.deepEqual(editedBalance(old, 120, '2026-11-02'), { balance: 120, balanceAsOf: '2026-11-02' });
  assert.deepEqual(editedBalance(old, 120, '2026-11-02', '2026-10-15'), { balance: 120, balanceAsOf: '2026-10-15' });
  assert.deepEqual(editedBalance(old, 100, '2026-11-02'), old);
  assert.deepEqual(editedBalance(old, undefined, '2026-11-02'), { balance: undefined, balanceAsOf: undefined });
  assert.deepEqual(editedBalance({}, 50, '2026-11-02'), { balance: 50, balanceAsOf: '2026-11-02' });
  const edited = { ...method, balance: 120, balanceAsOf: '2026-10-01' };
  const stale = base({ ...sub, price: 80, nextDue: '2026-10-03' });
  assert.equal(runwayFor(edited, state(edited, stale), '2026-11-02')!.current, 40);
  const fixed = { ...method, ...editedBalance(edited, 200, '2026-11-02') };
  assert.equal(runwayFor(fixed, state(fixed, stale), '2026-11-02')!.current, 200);
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

test('issue #11：旧版提前记账不改数据也按提前续费算', async () => {
  const { savePayment, deletePayment, earlyRenewalEffect, stopSubscription } = await import('./phases.ts');
  const { billingPeriod, settleLegacyEarly, subError } = await import('./billing.ts');
  const sub = base({
    start: '2026-08-02',
    nextDue: '2026-11-02',
    payments: [
      { date: '2026-09-02', amount: 10 },
      { date: '2026-10-02', amount: 10 },
      { date: '2026-10-28', amount: 10 },
    ],
  });
  assert.equal(nextCharge(sub, '2026-10-30'), '2026-12-02');
  assert.deepEqual(billingPeriod(sub, '2026-11-15').from, '2026-11-02');
  assert.equal(sub.nextDue, '2026-11-02');
  assert.equal(sub.payments?.[2].serviceDate, undefined);
  // 保存时才落成记录；删掉这一笔恢复原到期日
  const saved = savePayment(sub, '2026-10-30', { date: '2026-10-02', amount: 12 }, { date: '2026-10-02', index: 0 });
  assert.equal(saved.nextDue, '2026-12-02');
  assert.equal(saved.payments?.at(-1)?.serviceDate, '2026-11-02');
  assert.equal(nextCharge(deletePayment(sub, '2026-10-30', '2026-10-28', 0), '2026-10-30'), '2026-11-02');
  // 连续提前的旧记录
  const chain = base({
    start: '2026-08-02',
    nextDue: '2026-11-02',
    payments: [
      { date: '2026-10-02', amount: 10 },
      { date: '2026-10-28', amount: 10 },
      { date: '2026-11-28', amount: 10 },
    ],
  });
  assert.equal(nextCharge(chain, '2026-11-29'), '2027-01-02');

  // 不算提前：晚两天付、准时付、上一期没结清、付得太早
  const late = base({
    start: '2026-08-01',
    nextDue: '2026-11-01',
    payments: [
      { date: '2026-09-03', amount: 10 },
      { date: '2026-10-03', amount: 10 },
    ],
  });
  assert.equal(nextCharge(late, '2026-10-30'), '2026-11-01');
  const onTime = base({
    start: '2026-08-01',
    nextDue: '2026-11-01',
    payments: [
      { date: '2026-09-01', amount: 10 },
      { date: '2026-10-01', amount: 10 },
    ],
  });
  assert.equal(nextCharge(onTime, '2026-10-30'), '2026-11-01');
  const unsettled = base({
    start: '2026-08-02',
    nextDue: '2026-11-02',
    payments: [
      { date: '2026-08-02', amount: 10 },
      { date: '2026-10-28', amount: 10 },
    ],
  });
  assert.equal(nextCharge(unsettled, '2026-10-30'), '2026-11-02');
  const tooEarly = base({
    start: '2026-08-02',
    nextDue: '2026-11-02',
    payments: [
      { date: '2026-10-02', amount: 10 },
      { date: '2026-10-10', amount: 10 },
    ],
  });
  assert.equal(nextCharge(tooEarly, '2026-10-30'), '2026-11-02');

  // 表单提示：只在真的顺延时出现，额外费用不顺延
  const live = base({ start: '2026-08-02', nextDue: '2026-11-02', payments: [{ date: '2026-10-02', amount: 10 }] });
  assert.deepEqual(earlyRenewalEffect(live, '2026-10-28', { date: '2026-10-28', amount: 10 }), { settles: '2026-11-02', next: '2026-12-02' });
  assert.equal(earlyRenewalEffect(live, '2026-10-28', { date: '2026-10-28', amount: 10, kind: 'adjust' }), undefined);
  assert.equal(earlyRenewalEffect(live, '2026-11-02', { date: '2026-11-02', amount: 10 }), undefined);
  assert.equal(nextCharge(savePayment(live, '2026-10-28', { date: '2026-10-28', amount: 3, kind: 'adjust' }), '2026-10-29'), '2026-11-02');

  // 审查：迟付超过半周期不算提前，新代码写入的不会被重新解释
  const never = base({ start: '2026-08-01' });
  const paid = ['2026-08-01', '2026-09-20', '2026-10-20', '2026-11-20'].reduce((x, date) => savePayment(x, date, { date, amount: 10 }), never);
  assert.equal(nextCharge(paid, '2026-11-21'), '2026-12-01');
  assert.equal(
    paid.payments?.some((p) => p.serviceDate),
    false,
  );
  // 审查：账单日改到付款之后不吞掉那一期
  const moved = base({
    start: '2026-08-10',
    nextDue: '2026-11-20',
    payments: [
      { date: '2026-10-10', amount: 10 },
      { date: '2026-11-10', amount: 10 },
    ],
  });
  assert.equal(nextCharge(moved, '2026-11-11'), '2026-11-20');
  // 审查：连续提前删中间一笔只退一期
  assert.equal(nextCharge(deletePayment(chain, '2026-11-29', '2026-10-28', 0), '2026-11-29'), '2026-12-02');
  // 审查：停用、暂停后已结清的一期不再冒出来
  const days = (x: Subscription) => chargesBetween(x, '2026-10-01', '2026-11-30', '2026-11-30').map((c) => c.date);
  assert.deepEqual(days(sub), ['2026-10-02', '2026-10-28']);
  assert.deepEqual(days({ ...sub, status: 'cancelled', end: '2026-11-15' }), ['2026-10-02', '2026-10-28']);
  assert.deepEqual(days({ ...sub, status: 'paused', pausedAt: '2026-11-15' }), ['2026-10-02', '2026-10-28']);
  // 审查：提示只看写入的那一段；长周期也提示
  const a = {
    start: '2026-01-02',
    end: '2026-12-31',
    price: 10,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    nextDue: '2026-11-02',
    payments: [{ date: '2026-10-02', amount: 10 }],
  };
  const b = {
    start: '2026-01-20',
    price: 20,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    nextDue: '2026-11-20',
    payments: [{ date: '2026-10-20', amount: 20 }],
  };
  const both = base({ start: '2026-01-02', phases: [a, b] as Subscription['phases'] });
  assert.deepEqual(earlyRenewalEffect(both, '2026-10-28', { date: '2026-10-28', amount: 10 }, undefined, a.start), {
    settles: '2026-11-02',
    next: '2026-12-02',
  });
  assert.deepEqual(earlyRenewalEffect(both, '2026-10-28', { date: '2026-10-28', amount: 10 }), { settles: '2026-11-20', next: '2026-12-20' });
  const long = base({ start: '2024-01-10', cycle: { unit: 'year', every: 3 }, nextDue: '2027-01-10', payments: [{ date: '2024-01-10', amount: 10 }] });
  assert.deepEqual(earlyRenewalEffect(long, '2026-12-20', { date: '2026-12-20', amount: 10 }), { settles: '2027-01-10', next: '2030-01-10' });

  // 二审：存储的 nextDue 落后是旧数据的常态
  const stale = base({
    start: '2026-08-02',
    nextDue: '2026-10-02',
    payments: [
      { date: '2026-09-02', amount: 10 },
      { date: '2026-10-02', amount: 10 },
      { date: '2026-10-28', amount: 10 },
    ],
  });
  assert.equal(nextCharge(stale, '2026-10-29'), '2026-12-02');
  // 提前一笔之后又准时扣了：那一笔是额外费用，不顺延
  const extra = base({
    start: '2026-08-02',
    nextDue: '2026-10-02',
    payments: [
      { date: '2026-10-02', amount: 10 },
      { date: '2026-10-28', amount: 10 },
      { date: '2026-11-02', amount: 10 },
    ],
  });
  assert.equal(nextCharge(extra, '2026-11-03'), '2026-12-02');
  // 二审：那一期在结束日、停止日、暂停日之后就不用结清
  const legacy = { start: '2026-08-02', nextDue: '2026-11-02', payments: sub.payments };
  const ending = base({
    start: '2026-08-08',
    end: '2026-11-05',
    chargeLeadDays: 5,
    nextDue: '2026-11-03',
    payments: [
      { date: '2026-09-03', amount: 10 },
      { date: '2026-10-03', amount: 10 },
      { date: '2026-10-30', amount: 10 },
    ],
  });
  assert.equal(settleLegacyEarly(ending), ending);
  const beforeDue = { date: '2026-10-30', kind: 'terminate', paidThrough: '2026-11-01' } as Subscription['stop'];
  for (const x of [
    base({ ...legacy, stop: beforeDue }),
    base({ ...legacy, status: 'paused', pausedAt: '2026-10-30' }),
    base({ ...legacy, status: 'paused' }),
    base({ ...legacy, status: 'cancelled' }),
  ])
    assert.equal(settleLegacyEarly(x), x);
  // 二审：同一天再记一笔不提示
  const once = savePayment(live, '2026-10-28', { date: '2026-10-28', amount: 10 });
  assert.equal(earlyRenewalEffect(once, '2026-10-28', { date: '2026-10-28', amount: 5 }), undefined);

  // 三审：已停用的旧账不被账期计算绕过判断，写入不报错
  const record = { start: '2026-08-02', nextDue: '2026-10-02', payments: sub.payments };
  const stoppedOld = base({ ...record, status: 'terminated', end: '2026-10-30', stop: { kind: 'terminate', date: '2026-10-30', paidThrough: '2026-11-01' } });
  assert.equal(subError(stoppedOld), undefined);
  assert.equal(billingPeriod(base({ ...record, status: 'paused', pausedAt: '2026-10-30' }), '2026-11-20').paidThrough, '2026-11-20');
  assert.equal(billingPeriod(base({ ...record, status: 'cancelled' }), '2026-10-30').paidThrough, '2026-11-01');
  // 暂停在扣款当天：那一笔不会发生，不用结清
  const pausedOnDue = base({ ...record, status: 'paused', pausedAt: '2026-11-02' });
  assert.equal(settleLegacyEarly(pausedOnDue), pausedOnDue);
  // 三审：活跃的旧账当天停用，已付账期算到提前结清的那一期，写入记录
  const stoppedNow = stopSubscription(base(record), '2026-10-30', 'terminate', '2026-10-30');
  assert.equal(stoppedNow.stop?.paidThrough, '2026-12-01');
  assert.equal(stoppedNow.payments?.at(-1)?.serviceDate, '2026-11-02');
  assert.equal(subError(stoppedNow), undefined);
  // 停在最后一笔之前：这笔不算提前续费
  const stoppedBefore = stopSubscription(base(record), '2026-10-30', 'terminate', '2026-10-20');
  assert.equal(stoppedBefore.payments?.at(-1)?.serviceDate, undefined);
  assert.equal(subError(stoppedBefore), undefined);
  // 三审：未来才结束时提示照常；同一天另一段已有提前续费不影响这一段
  assert.deepEqual(
    earlyRenewalEffect(
      base({ start: '2026-08-02', nextDue: '2026-10-02', status: 'cancelled', end: '2026-12-20', payments: sub.payments?.slice(0, 2) }),
      '2026-10-28',
      { date: '2026-10-28', amount: 10 },
    ),
    { settles: '2026-11-02', next: '2026-12-02' },
  );
  const parallel = base({
    start: '2026-08-02',
    nextDue: '2026-11-02',
    phases: [
      {
        start: '2026-08-02',
        end: '2026-12-31',
        price: 10,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        nextDue: '2026-12-02',
        payments: [
          { date: '2026-10-02', amount: 10 },
          { date: '2026-10-28', amount: 10, serviceDate: '2026-11-02' },
        ],
      },
      {
        start: '2026-09-02',
        price: 10,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        nextDue: '2026-11-02',
        payments: [{ date: '2026-10-02', amount: 10 }],
      },
    ],
  } as Partial<Subscription>);
  assert.deepEqual(earlyRenewalEffect(parallel, '2026-10-28', { date: '2026-10-28', amount: 10 }, undefined, '2026-09-02'), {
    settles: '2026-11-02',
    next: '2026-12-02',
  });
  // 三审：记完又退款的是冲销
  const refundedOld = base({ ...record, payments: [...(sub.payments ?? []), { date: '2026-10-29', amount: -10, kind: 'refund' }] });
  assert.equal(nextCharge(refundedOld, '2026-10-30'), '2026-11-02');
  // 三审：月底日号不被夹短，连续提前也能接上
  const monthEnd = { start: '2026-01-15', nextDue: '2026-01-31' };
  assert.equal(
    nextCharge(base({ ...monthEnd, payments: ['01-15', '01-31', '02-28', '03-31', '04-20'].map((d) => ({ date: `2026-${d}`, amount: 10 })) }), '2026-04-21'),
    '2026-05-31',
  );
  assert.equal(
    nextCharge(
      base({ ...monthEnd, payments: ['01-15', '01-31', '02-28', '03-20', '04-20', '05-20'].map((d) => ({ date: `2026-${d}`, amount: 10 })) }),
      '2026-05-21',
    ),
    '2026-06-30',
  );
  // 三审：赠送期后按赠送结束日算，准时扣款不算提前
  const afterBonus = base({
    start: '2026-08-02',
    nextDue: '2026-09-02',
    bonus: { from: '2026-09-10', until: '2026-09-20' },
    payments: ['08-02', '09-02', '09-20', '10-20', '11-20'].map((d) => ({ date: `2026-${d}`, amount: 10 })),
  });
  assert.equal(settleLegacyEarly(afterBonus), afterBonus);
});

const topUpPlanOf = async (st: AppState, today: string, months?: number) => (await import('./metrics.ts')).topUpPlan(st, today, months)[0];

test('余额到期：到期日当天照扣，之后剩余作废，后续扣款从 0 起算不足', async () => {
  // 虚构话费卡：每月 5 日扣 100，余额 350 于 12-05 到期
  const method = { id: 'sim', name: 'SIM', kind: 'phone' as const, currency: 'PHP', balance: 350, balanceAsOf: '2026-10-01', balanceExpires: '2026-12-05' };
  const state: AppState = {
    subscriptions: [base({ price: 100, currency: 'PHP', start: '2026-01-05', methodId: 'sim' })],
    methods: [method],
    settings: DEFAULT_SETTINGS,
    fx: FALLBACK_FX,
  };
  const r = runwayFor(method, state, '2026-10-19')!;
  assert.equal(r.current, 250);
  // 11-05、12-05 照扣，剩 50 在 12-05 之后作废；01-05 从 0 起扣，不足
  assert.deepEqual(r.expiring, { date: '2026-12-05', amount: 50 });
  assert.equal(r.coveredCharges, 2);
  assert.equal(r.runsOutOn, '2027-01-05');
  assert.equal(r.forecast.find((c) => c.date === '2027-01-05')!.balanceAfter, -100);
  // 撑满一年要补 01-05 到 10-05 的 10 期，作废的 50 不算可用
  assert.equal(r.topUp12m, 1000);
  assert.equal(-r.partial.topUp12m.value, -1000);

  // 没设到期日的同一张卡：余额能多撑一期，补得少 50
  const plain = runwayFor({ ...method, balanceExpires: undefined }, state, '2026-10-19')!;
  assert.equal(plain.expiring, undefined);
  assert.equal(plain.topUp12m, 950);

  // 充值计划：作废的 50 不能付 01-05，最少要补 100、6 个月共补 400，和 12 个月口径一致
  const plan = await topUpPlanOf(state, '2026-10-19');
  assert.equal(plan.deadline, '2027-01-05');
  assert.equal(plan.minNeed, 100);
  assert.equal(plan.need, 400);
  assert.equal(plan.partial.need.value, 400);
  // 6 个月内到期后没有扣款时，作废不影响要补的钱
  const late = { ...method, balanceExpires: '2027-03-06' };
  const latePlan = await topUpPlanOf({ ...state, methods: [late] }, '2026-10-19', 5);
  assert.equal(latePlan.need, 250);
});

test('余额到期：已过期的余额今天为 0；早于校准日的到期日不再生效；用完了不报作废', () => {
  const method = { id: 'sim', name: 'SIM', kind: 'phone' as const, currency: 'PHP', balance: 350, balanceAsOf: '2026-10-01', balanceExpires: '2026-10-10' };
  const st = (m: typeof method): AppState => ({
    subscriptions: [base({ price: 100, currency: 'PHP', start: '2026-01-05', methodId: 'sim' })],
    methods: [m],
    settings: DEFAULT_SETTINGS,
    fx: FALLBACK_FX,
  });
  const expired = runwayFor(method, st(method), '2026-10-19')!;
  assert.equal(expired.current, 0);
  assert.deepEqual(expired.expiring, { date: '2026-10-10', amount: 250 });
  assert.equal(expired.runsOutOn, '2026-11-05');

  // 充值后校准日晚于旧到期日：旧日期失效，按无到期计
  const topped = { ...method, balance: 500, balanceAsOf: '2026-10-19' };
  const after = runwayFor(topped, st(topped), '2026-10-19')!;
  assert.equal(after.current, 500);
  assert.equal(after.expiring, undefined);

  // 到期前已经花光：没有可作废的钱
  const spent = { ...method, balance: 150, balanceExpires: '2027-03-01' };
  assert.equal(runwayFor(spent, st(spent), '2026-10-19')!.expiring, undefined);
});

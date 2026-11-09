import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX } from './billing.ts';
import {
  cancelSavings,
  cashVsAccrual,
  chartMonths,
  contributionOn,
  events,
  monthMovement,
  mrrChangeSinceLastMonth,
  movement,
  mrrOn,
  prepaidValue,
  spendingFocus,
  spendingMonths,
  isSpendingPeriod,
  topUpPlan,
} from './metrics.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const sub = (o: Partial<Subscription>): Subscription => ({
  id: Math.random().toString(36).slice(2),
  name: 'X',
  category: '工具',
  tags: [],
  price: 120,
  currency: 'USD',
  cycle: { unit: 'year', every: 1 },
  start: '2026-01-01',
  status: 'active',
  ...o,
});
const state = (subs: Subscription[], extra: Partial<AppState> = {}): AppState => ({
  subscriptions: subs,
  methods: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
  fx: FALLBACK_FX,
  ...extra,
});

test('年付的现金是尖峰，权责是平的', () => {
  const st = state([sub({})]);
  const rows = cashVsAccrual(st, '2026-06-15', 5, 0);
  const jan = rows.find((r) => r.month === '2026-01')!;
  const mar = rows.find((r) => r.month === '2026-03')!;
  assert.equal(jan.cash, 120);
  assert.equal(mar.cash, 0);
  assert.ok(Math.abs(mar.accrual - (120 * 31) / 365) < 0.01);
});

test('MRR 变动：新增与退订', () => {
  const a = sub({ price: 10, cycle: { unit: 'month', every: 1 }, start: '2026-03-10' });
  const b = sub({ price: 20, cycle: { unit: 'month', every: 1 }, start: '2025-01-01', end: '2026-03-20' });
  const st = state([a, b]);
  const mv = movement(st, '2026-02-28', '2026-03-31');
  assert.ok(Math.abs(mv.added - 10) < 1e-6);
  assert.ok(Math.abs(mv.churned - 20) < 1e-6);
  assert.ok(Math.abs(mrrOn(st, '2026-03-31') - 10) < 1e-6);
});

test('涨价进入变更日志', () => {
  const s = sub({
    price: 15,
    cycle: { unit: 'month', every: 1 },
    priceHistory: [
      { from: '2026-01-01', amount: 10 },
      { from: '2026-05-01', amount: 15 },
    ],
  });
  const ev = events(state([s]), '2026-06-01');
  const p = ev.find((e) => e.kind === 'price')!;
  assert.ok(Math.abs(p.delta - 5) < 1e-6);
});

test('预付余值与退订省钱', () => {
  const y = sub({});
  const c = sub({ price: 10, cycle: { unit: 'month', every: 1 }, start: '2025-01-01', end: '2026-01-01' });
  const st = state([y, c]);
  const pv = prepaidValue(st, '2026-07-02');
  assert.ok(Math.abs(pv.total - (120 * 182) / 365) < 0.5);
  const sv = cancelSavings(st, '2026-07-01');
  assert.ok(Math.abs(sv.total - (10 * 181) / 30.4375) < 0.01);
});

test('充值计划凑面额', () => {
  const s = sub({ price: 100, currency: 'TRY', cycle: { unit: 'month', every: 1 }, start: '2026-01-05', methodId: 'tr' });
  const st = state([s], { methods: [{ id: 'tr', name: 'TR', kind: 'appstore', currency: 'TRY', balance: 120, balanceAsOf: '2026-06-01' }] });
  const [p] = topUpPlan(st, '2026-06-01', 6);
  assert.equal(p.need, 480);
  assert.deepEqual(p.cards, [250, 100, 100, 100]);
});

test('历史扣款按当天汇率，预测按当前汇率，缺失币种取最近日期', async () => {
  const { chargeValue } = await import('./fx.ts');
  const st = state([], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
    fx: { base: 'USD', fetchedAt: '2026-10-19', rates: { USD: 1, CNY: 7, TRY: 40 } },
    fxHistory: { '2021-07-26': { USD: 1, CNY: 6.48, TRY: 8.57 }, '2024-03-06': { USD: 1, CNY: 7.2, TRY: 31.7 } },
  });
  const past = chargeValue(st, { amount: 85.7, currency: 'TRY', date: '2021-07-26', projected: false });
  assert.ok(Math.abs(past - 64.8) < 0.01); // 85.7 / 8.57 * 6.48
  const between = chargeValue(st, { amount: 31.7, currency: 'TRY', date: '2025-01-01', projected: false });
  assert.ok(Math.abs(between - 7.2) < 1e-9); // 取 2024-03-06
  const future = chargeValue(st, { amount: 40, currency: 'TRY', date: '2027-01-01', projected: true });
  assert.ok(Math.abs(future - 7) < 1e-9);
});

test('汇率影响单独成一项，各项加总等于期末', () => {
  const s = sub({ price: 400, currency: 'TRY', cycle: { unit: 'month', every: 1 }, start: '2025-01-01' });
  const st = state([s], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
    fx: { base: 'USD', fetchedAt: '', rates: { USD: 1, TRY: 40 } },
    fxHistory: { '2026-02-28': { USD: 1, TRY: 40 }, '2026-03-31': { USD: 1, TRY: 50 } },
  });
  const mv = movement(st, '2026-02-28', '2026-03-31', '2026-03-31');
  assert.ok(Math.abs(mv.from - 10) < 1e-9);
  assert.ok(Math.abs(mv.fx + 2) < 1e-9);
  assert.ok(Math.abs(mv.from + mv.fx + mv.added + mv.expansion - mv.contraction - mv.churned - mv.to) < 1e-9);
});

test('换区：两个阶段分别计费，变更日志合并为一次换区', async () => {
  const { chargesBetween, effectiveStatus } = await import('./billing.ts');
  const s = sub({
    name: 'iCloud+',
    price: 2.99,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2021-08-06',
    phases: [
      {
        start: '2021-08-06',
        price: 249,
        currency: 'TRY',
        cycle: { unit: 'month', every: 1 },
        region: 'TR',
        priceHistory: [
          { from: '2021-08-06', amount: 39.99 },
          { from: '2024-03-01', amount: 249 },
        ],
      },
      { start: '2026-10-25', price: 2.99, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'US' },
    ],
  });
  const st = state([s], { fx: { base: 'USD', fetchedAt: '', rates: { USD: 1, TRY: 40 } } });
  const cs = chargesBetween(s, '2026-09-01', '2026-12-31', '2026-10-19');
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount, c.currency]),
    [
      ['2026-09-06', 249, 'TRY'],
      ['2026-10-06', 249, 'TRY'],
      ['2026-10-25', 2.99, 'USD'],
      ['2026-11-25', 2.99, 'USD'],
      ['2026-12-25', 2.99, 'USD'],
    ],
  );
  const ev = events(st, '2026-11-01');
  const sw = ev.find((e) => e.kind === 'switch')!;
  assert.equal(sw.date, '2026-10-25');
  assert.ok(Math.abs(sw.delta - (2.99 - 249 / 40)) < 1e-6);
  assert.equal(ev.filter((e) => e.kind === 'price').length, 1);
  assert.equal(effectiveStatus(s, '2026-11-01'), 'active');
});

test('断更后续订', async () => {
  const { effectiveStatus } = await import('./billing.ts');
  const s = sub({
    price: 10,
    cycle: { unit: 'month', every: 1 },
    start: '2024-01-01',
    phases: [
      { start: '2024-01-01', end: '2024-06-01', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: '2025-03-01', price: 12, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    ],
  });
  const st = state([s]);
  assert.equal(effectiveStatus(s, '2024-10-01'), 'paused'); // 断更中，之后有续订
  assert.equal(mrrOn(st, '2024-10-01'), 0);
  assert.ok(Math.abs(mrrOn(st, '2025-04-01') - 12) < 1e-9);
  const kinds = events(st, '2026-01-01').map((e) => e.kind);
  assert.deepEqual(kinds.sort(), ['end', 'resume', 'start']);
});

test('历程操作：调价 → 换区 → 撤回', async () => {
  const { changePrice, switchPlan, removePhase } = await import('./phases.ts');
  const { chargesBetween } = await import('./billing.ts');
  let s = sub({ price: 39.99, currency: 'TRY', cycle: { unit: 'month', every: 1 }, start: '2021-08-06', region: 'TR' });
  s = changePrice(s, '2024-03-06', 249);
  assert.equal(s.price, 249);
  assert.equal(
    chargesBetween(s, '2024-02-01', '2024-03-31', '2026-10-19')
      .map((c) => c.amount)
      .join(),
    '39.99,249',
  );
  s = switchPlan(s, '2026-10-25', { price: 2.99, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'US' });
  assert.equal(s.currency, 'USD');
  assert.equal(s.phases!.length, 2);
  assert.equal(s.phases![0].priceHistory!.length, 2);
  const back = removePhase(s, 1);
  assert.equal(back.phases, undefined);
  assert.equal(back.currency, 'TRY');
  assert.equal(back.end, undefined);
});

test('公开数据不包含任何真实域名', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const s = sub({
    id: 'cf-example-org',
    name: 'example-domain.org',
    category: '域名',
    url: 'https://example-domain.org',
    icon: 'https://x/example-domain.org.png',
    notes: '到期 2027',
  });
  const out = JSON.stringify(maskForPublic(state([s])));
  assert.ok(!out.includes('example-domain'), out);
});

test('换区前的阶段不显示为到期不续', async () => {
  const { effectiveStatus } = await import('./billing.ts');
  const s = sub({
    price: 9.99,
    cycle: { unit: 'month', every: 1 },
    start: '2021-08-06',
    phases: [
      { start: '2021-08-06', price: 249, currency: 'TRY', cycle: { unit: 'month', every: 1 } },
      { start: '2026-10-26', price: 9.99, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    ],
  });
  assert.equal(effectiveStatus(s, '2026-10-19'), 'active');
});

test('已上线的域名可在公开页显示，未上线的打码', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const live = sub({ id: 'cf-doc2md-org', name: 'doc2md.org', category: '域名', url: 'https://doc2md.org', showOnPublic: true });
  const hidden = sub({ id: 'cf-larkcli-app', name: 'larkcli.app', category: '域名', url: 'https://larkcli.app' });
  const out = maskForPublic(state([live, hidden]));
  assert.equal(out.subscriptions[0].name, 'doc2md.org');
  assert.ok(!JSON.stringify(out.subscriptions[1]).includes('larkcli'));
});

test('代付不计入我的月成本，公开页也不出现', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const mine = sub({ price: 10, cycle: { unit: 'month', every: 1 } });
  const proxy = sub({ id: 'proxy-x', price: 200, cycle: { unit: 'month', every: 1 }, proxy: { forName: '朋友', entries: [] } });
  const st = state([mine, proxy]);
  assert.ok(Math.abs(mrrOn(st, '2026-06-15') - (10 * 365.25) / 12 / 30.4375) < 0.5);
  const out = maskForPublic(st);
  assert.equal(out.subscriptions.length, 1);
  assert.ok(!JSON.stringify(out).includes('朋友'));
});

test('公开页仅带出所有者收支符号设置，旧设置缺省开启', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const { flow, setSignedAmounts } = await import('./format.ts');
  try {
    for (const signedAmounts of [undefined, true, false]) {
      const st = state([sub({ payments: [{ date: '2026-10-16', amount: -3 }] })]);
      st.settings = { ...st.settings, signedAmounts, notifyEmail: 'private@example.test' };
      const pub = maskForPublic(st);
      assert.equal(pub.settings.signedAmounts, signedAmounts !== false);
      assert.equal(pub.settings.notifyEmail, '');
      setSignedAmounts(pub.settings.signedAmounts !== false);
      assert.equal(flow(-15, 'USD'), signedAmounts === false ? '$15.00' : '−$15.00');
      assert.equal(flow(-pub.subscriptions[0].payments![0].amount, 'USD'), signedAmounts === false ? '$3.00' : '+$3.00');
    }
  } finally {
    setSignedAmounts(true);
  }
});

test('#12 公开页带出主人的语言与涨跌配色；未选语言时用后台最近实际用的语言', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const st = state([sub({})]);
  st.settings = { ...st.settings, language: 'zh-CN', languageSeen: 'en', gainColor: 'red' };
  assert.equal(maskForPublic(st).settings.language, 'zh-CN');
  assert.equal(maskForPublic(st).settings.gainColor, 'red');
  st.settings = { ...st.settings, language: undefined, gainColor: undefined };
  assert.equal(maskForPublic(st).settings.language, 'en');
  assert.equal(maskForPublic(st).settings.gainColor, undefined);
  // 脏值不下发，回退到后台最近实际用的语言
  assert.equal(maskForPublic({ ...st, settings: { ...st.settings, language: '' as never } }).settings.language, st.settings.languageSeen);
});

test('#12 合租成员付满整价时，公开页仍显示订阅本身的价格而不是 0', async () => {
  const { maskForPublic } = await import('./mask.ts');
  const { contributionOn } = await import('./metrics.ts');
  const s = sub({
    price: 30,
    cycle: { unit: 'month', every: 1 },
    share: {
      role: 'owner',
      seats: 4,
      members: [
        { id: 'a', name: 'A', share: 20 },
        { id: 'b', name: 'B', share: 15 },
      ],
    },
  });
  const st = state([s]);
  assert.equal(contributionOn(st, s, '2026-06-15'), 0);
  const pub = maskForPublic(st);
  assert.equal(pub.subscriptions[0].share, undefined);
  assert.ok(contributionOn(pub, pub.subscriptions[0], '2026-06-15') > 29);
});

test('概览与月度变动报告比较上月末时包含相同的汇率影响', () => {
  const st = state([sub({ price: 10, cycle: { unit: 'month', every: 1 } })], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
    fx: { base: 'USD', fetchedAt: '2026-10-22', rates: { USD: 1, CNY: 6.7 } },
    fxHistory: { '2026-09-30': { USD: 1, CNY: 6.8 }, '2026-08-31': { USD: 1, CNY: 6.9 } },
  });
  const report = monthMovement(st, '2026-10-22');
  assert.equal(report.from, 68);
  assert.equal(report.to, 67);
  assert.equal(report.fx, -1);
  assert.equal(mrrChangeSinceLastMonth(st, '2026-10-22'), -1);
  assert.equal(mrrChangeSinceLastMonth(st, '2026-10-22'), report.to - report.from);
  const historical = monthMovement(st, '2026-09-30', true);
  assert.equal(historical.to, 68);
  assert.equal(historical.from, 69);
});

test('annual review and net service counts exclude proxy, refund and failed rows and use my share', async () => {
  const { yearReview } = await import('./metrics.ts');
  const { netCost } = await import('./transfers.ts');
  const s = sub({
    start: '2026-10-01',
    price: 100,
    cycle: { unit: 'month', every: 1 },
    share: { role: 'owner', seats: 4, since: '2026-10-01', members: [{ id: 'm', name: 'Fictional member', share: 25, joined: '2026-10-01' }] },
    payments: [
      { date: '2026-10-01', amount: 100 },
      { date: '2026-10-05', amount: -20, kind: 'refund' },
      { date: '2026-10-12', amount: 5, kind: 'failed' },
    ],
  });
  const proxy = sub({ start: '2026-10-01', end: '2026-10-10', status: 'cancelled', proxy: { forName: 'Fictional recipient' } });
  const st = state([s, proxy]);
  const r = yearReview(st, '2026-10-25');
  assert.equal(r.charges, 1);
  assert.equal(netCost(st, s, '2026-10-25').charges, 1);
  assert.equal(r.total, 60);
  assert.equal(r.items[0].sum, 60);
  assert.deepEqual(
    r.newSubs.map((x) => x.id),
    [s.id],
  );
  assert.equal(r.ended.length, 0);
});

test('图表区间不早于账本第一笔数据所在月，至少 2 个月', () => {
  // 账本从 2026-05 开始，选 3 年也只画 2026-05..2026-10
  assert.equal(chartMonths('2026-05-20', '2026-10-27', 36), 6);
  assert.equal(chartMonths('2026-05-20', '2026-10-27'), 6);
  // 数据比区间长时按区间
  assert.equal(chartMonths('2020-01-01', '2026-10-27', 36), 36);
  assert.equal(chartMonths('2020-01-01', '2026-10-27'), 82);
  // 跨年按自然月计：2025-10 到 2026-10 共 13 个月，含一年前的点，月中日期不多算一个月
  assert.equal(chartMonths('2025-10-31', '2026-10-27', 36), 13);
  assert.equal(chartMonths('2025-10-01', '2026-10-01', 36), 13);
  // 本月才开始的账本也保留 2 个月
  assert.equal(chartMonths('2026-10-27', '2026-10-27', 36), 2);
});

test('合租全额口径不受成员分担影响，代付仍不计入', () => {
  const st: AppState = {
    subscriptions: [],
    payments: [],
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
    fx: { base: 'USD', date: '2026-10-01', rates: { USD: 1 } },
  } as unknown as AppState;
  const base = { price: 30, currency: 'USD', cycle: { unit: 'month', every: 1 }, startDate: '2026-01-01' } as Partial<Subscription>;
  const carpool = sub({ ...base, share: { role: 'owner', seats: 2, members: [{ id: 'm', name: 'A', share: 30 }] } });
  const proxy = sub({ ...base, proxy: { forName: 'B' } } as Partial<Subscription>);
  assert.equal(contributionOn(st, carpool, '2026-10-15', undefined, true), 30);
  assert.equal(contributionOn(st, carpool, '2026-10-15'), 0);
  assert.equal(contributionOn(st, proxy, '2026-10-15', undefined, true), 0);
  const phased = sub({ ...carpool, phases: [{ ...carpool, phases: undefined, startDate: '2026-01-01' }] } as unknown as Partial<Subscription>);
  assert.equal(contributionOn(st, phased, '2026-10-15', undefined, true), 30);
  assert.equal(contributionOn(st, phased, '2026-10-15'), 0);
});

test('月度支出图窗口：六种范围的起止月（#15）', () => {
  const edges = (today: string, period: Parameters<typeof spendingMonths>[1]) => {
    const months = spendingMonths(today, period);
    return [months.length, months[0], months[months.length - 1]];
  };
  assert.deepEqual(edges('2026-11-09', 'extended'), [18, '2025-12-01', '2027-05-01']);
  assert.deepEqual(edges('2026-11-09', 'year'), [12, '2026-01-01', '2026-12-01']);
  assert.deepEqual(edges('2026-11-09', 'past12'), [12, '2025-12-01', '2026-11-01']);
  assert.deepEqual(edges('2026-11-09', 'next12'), [12, '2026-11-01', '2027-10-01']);
  assert.deepEqual(edges('2026-11-09', 'lastYear'), [12, '2025-01-01', '2025-12-01']);
  assert.deepEqual(edges('2026-11-09', 'nextYear'), [12, '2027-01-01', '2027-12-01']);
  // 记住的是相对含义：跨年后「今年」自动变成新的一年
  assert.deepEqual(edges('2027-01-01', 'year'), [12, '2027-01-01', '2027-12-01']);
  assert.deepEqual(edges('2027-01-01', 'lastYear'), [12, '2026-01-01', '2026-12-01']);
  // 月末不漂移，跨年不重复不跳月
  assert.deepEqual(edges('2027-01-31', 'past12'), [12, '2026-02-01', '2027-01-01']);
  assert.deepEqual(edges('2026-12-31', 'next12'), [12, '2026-12-01', '2027-11-01']);
  for (const period of ['extended', 'year', 'past12', 'next12'] as const) assert.ok(spendingMonths('2028-02-29', period).includes('2028-02-01'), period);
  for (const period of ['extended', 'past12', 'next12', 'lastYear', 'year', 'nextYear'] as const) {
    assert.ok(isSpendingPeriod(period), period);
    const months = spendingMonths('2028-02-29', period);
    assert.equal(new Set(months).size, months.length, period);
    assert.deepEqual([...months].sort(), months, period);
  }
});

test('月度支出图默认选中：含当月选当月，去年选 12 月，明年选 1 月，存值无效不当范围（#15）', () => {
  const keys = (today: string, period: Parameters<typeof spendingMonths>[1]) => spendingMonths(today, period).map((m) => m.slice(0, 7));
  assert.equal(spendingFocus(keys('2026-11-09', 'past12'), '2026-11'), '2026-11');
  assert.equal(spendingFocus(keys('2026-11-09', 'lastYear'), '2026-11'), '2025-12');
  assert.equal(spendingFocus(keys('2026-11-09', 'nextYear'), '2026-11'), '2027-01');
  assert.equal(isSpendingPeriod('2026'), false);
  assert.equal(isSpendingPeriod(''), false);
});

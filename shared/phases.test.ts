// 阶段并行：换区后旧区域预付到期前仍在跑，两边都在付钱
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePhases,
  chargesBetween,
  convert,
  currentPhase,
  effectiveStatus,
  FALLBACK_FX,
  monthlyGross,
  monthlyMine,
  newShapeError,
  nextCharge,
  phaseAt,
  phaseLanes,
  phaseSubs,
  servedTime,
  totals,
} from './billing.ts';
import { contributionOn, events, prepaidValue } from './metrics.ts';
import {
  affectedPriceCharges,
  changePrice,
  editPhase,
  editPricePoint,
  movePhaseStart,
  removePricePoint,
  pricePoints,
  deletePayment,
  dropPlan,
  prependPlan,
  removePhase,
  savePayment,
  setPhaseEnd,
  stopSubscription,
  switchPlan,
  syncPhase,
  toEditForm,
} from './phases.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';

const base = (o: Partial<Subscription> = {}): Subscription => ({
  id: 'x',
  name: 'X',
  category: '工具',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-15',
  status: 'active',
  region: 'US',
  methodId: 'us',
  ...o,
});
const TR = { price: 100, currency: 'TRY', cycle: { unit: 'month' as const, every: 1 }, region: 'TR', methodId: 'tr' };
/** 美区月付 $10，6/1 起换土区 ₺100，美区继续跑到 8/15 */
const overlap = () => switchPlan(base(), '2026-06-01', TR, '2026-08-15');
const stateOf = (subs: Subscription[]): AppState => ({
  subscriptions: subs,
  methods: [],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'CNY' },
  fx: FALLBACK_FX,
});
const dates = (s: Subscription, from: string, to: string) => chargesBetween(s, from, to, '2026-07-01').map((c) => `${c.date} ${c.currency}`);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test('换区时选择继续跑：旧阶段的结束日晚于新阶段开始日，订阅本身没有结束日', () => {
  const s = overlap();
  assert.equal(s.phases!.length, 2);
  assert.equal(s.phases![0].end, '2026-08-15');
  assert.equal(s.phases![1].end, undefined);
  assert.equal(s.end, undefined);
  assert.equal(s.currency, 'TRY');
  assert.throws(() => switchPlan(base(), '2026-06-01', TR, '2026-06-01'));
  // 默认（不选）仍是无缝切换
  assert.equal(switchPlan(base(), '2026-06-01', TR).phases![0].end, '2026-05-31');
});

test('并行期间两边的扣款都在，旧阶段最后服务日仍可扣款', () => {
  assert.deepEqual(dates(overlap(), '2026-05-01', '2026-09-30'), [
    '2026-05-15 USD',
    '2026-06-01 TRY',
    '2026-06-15 USD',
    '2026-07-01 TRY',
    '2026-07-15 USD',
    '2026-08-01 TRY',
    '2026-08-15 USD',
    '2026-09-01 TRY',
  ]);
  assert.equal(nextCharge(overlap(), '2026-07-02'), '2026-07-15');
});

test('并行期间：当前阶段取最晚开始的那段，activePhases 列出两段', () => {
  const s = overlap();
  assert.deepEqual(
    activePhases(s, '2026-07-01').map((v) => v.region),
    ['US', 'TR'],
  );
  assert.equal(phaseAt(s, '2026-07-01')!.region, 'TR');
  assert.equal(currentPhase(s, '2026-07-01').region, 'TR');
  assert.deepEqual(
    activePhases(s, '2026-08-16').map((v) => v.region),
    ['TR'],
  );
  assert.deepEqual(
    activePhases(s, '2026-05-01').map((v) => v.region),
    ['US'],
  );
  assert.equal(effectiveStatus(s, '2026-07-01'), 'active');
  assert.equal(effectiveStatus(s, '2026-09-01'), 'active');
  assert.deepEqual(phaseLanes(phaseSubs(s)), [0, 1]);
  assert.deepEqual(phaseLanes(phaseSubs(switchPlan(base(), '2026-06-01', TR))), [0, 0]);
  // 首尾同一天交接的连续升级仍是一行；真正并行（旧段结束晚于新段开始）才分行
  assert.deepEqual(phaseLanes([{ start: '2026-06-16', end: '2026-07-16' }, { start: '2026-07-16', end: '2026-08-16' }, { start: '2026-08-16' }]), [0, 0, 0]);
  assert.deepEqual(phaseLanes([{ start: '2026-06-16', end: '2026-07-20' }, { start: '2026-07-16' }]), [0, 1]);
  // 前两段并行占两行，第三段与第二段同一天交接：接在第二段那一行，不跳回第一行
  assert.deepEqual(phaseLanes([{ start: '2023-08-19', end: '2024-08-19' }, { start: '2024-08-16', end: '2026-07-17' }, { start: '2026-07-17' }]), [0, 1, 1]);
});

test('并行期间的月成本是两段之和', () => {
  const s = overlap();
  const st = stateOf([s]);
  near(monthlyGross(s, '2026-07-01'), 100 + convert(10, 'USD', 'TRY', FALLBACK_FX));
  near(monthlyGross(s, '2026-09-01'), 100);
  const cny = convert(10, 'USD', 'CNY', FALLBACK_FX) + convert(100, 'TRY', 'CNY', FALLBACK_FX);
  near(monthlyMine(st, s, '2026-07-01'), cny);
  near(monthlyMine(st, s, '2026-07-01', 'us'), convert(10, 'USD', 'CNY', FALLBACK_FX));
  near(totals(st, '2026-07-01').mrr, cny);
  near(totals(st, '2026-09-01').mrr, convert(100, 'TRY', 'CNY', FALLBACK_FX));
  near(contributionOn(st, s, '2026-07-01'), cny);
  near(contributionOn(st, s, '2026-09-01'), convert(100, 'TRY', 'CNY', FALLBACK_FX));
});

test('变更日志：新段整份计入，旧段到期另记一笔结束', () => {
  const st = stateOf([overlap()]);
  const evs = events(st, '2026-10-01');
  const sw = evs.find((e) => e.kind === 'switch')!;
  assert.equal(sw.date, '2026-06-01');
  near(sw.delta, convert(100, 'TRY', 'CNY', FALLBACK_FX));
  const end = evs.find((e) => e.kind === 'end')!;
  assert.equal(end.date, '2026-08-16');
  near(end.delta, -convert(10, 'USD', 'CNY', FALLBACK_FX));
});

test('退订对并行的两段都生效', () => {
  const s = overlap();
  const form = toEditForm(s, '2026-07-01');
  const cancelled = syncPhase({ ...form, status: 'cancelled', end: '2026-07-10' }, '2026-07-01');
  assert.equal(cancelled.end, '2026-07-10');
  assert.equal(cancelled.phases![0].end, '2026-08-15'); // 旧段自己的到期日保留，由订阅结束日封顶
  assert.deepEqual(dates(cancelled, '2026-07-02', '2026-12-31'), []);
  assert.deepEqual(
    phaseSubs(cancelled).map((v) => v.end),
    ['2026-07-10', '2026-07-10'],
  );
  assert.equal(effectiveStatus(cancelled, '2026-07-05'), 'ending');
  assert.equal(effectiveStatus(cancelled, '2026-07-20'), 'ended');
  assert.equal(totals(stateOf([cancelled]), '2026-07-20').mrr, 0);
  // 没写结束日的退订：并行的旧段也视为退订
  const noEnd = { ...s, status: 'cancelled' as const };
  assert.equal(phaseSubs(noEnd)[0].status, 'cancelled');
});

test('暂停对并行的两段都生效', () => {
  const paused = { ...overlap(), status: 'paused' as const, pausedAt: '2026-07-05' };
  assert.deepEqual(dates(paused, '2026-07-02', '2026-12-31'), []);
  assert.equal(phaseSubs(paused)[0].status, 'paused');
  assert.equal(contributionOn(stateOf([paused]), paused, '2026-07-10'), 0);
  // 暂停日在旧段到期之后：旧段照常到期，不受影响
  const later = { ...overlap(), status: 'paused' as const, pausedAt: '2026-09-10' };
  assert.equal(phaseSubs(later)[0].status, 'active');
  assert.deepEqual(dates(later, '2026-08-01', '2026-12-31'), ['2026-08-01 TRY', '2026-08-15 USD', '2026-09-01 TRY']);
});

test('撤回换区：去掉新阶段，旧阶段恢复为进行中', () => {
  const back = removePhase(overlap(), 1);
  assert.equal(back.phases, undefined);
  assert.equal(back.end, undefined);
  assert.equal(back.currency, 'USD');
  assert.deepEqual(dates(back, '2026-08-01', '2026-09-30'), ['2026-08-15 USD', '2026-09-15 USD']);
});

test('删掉并行中的旧阶段：只剩新阶段', () => {
  const only = removePhase(overlap(), 0);
  assert.equal(only.phases, undefined);
  assert.equal(only.start, '2026-06-01');
  assert.equal(only.currency, 'TRY');
});

test('取消计划中的换区：原本打算并行跑到的日期保留', () => {
  const planned = switchPlan(base(), '2026-11-01', { ...TR, planned: true }, '2026-12-15');
  const dropped = dropPlan(planned, '2026-11-01');
  assert.equal(dropped.phases, undefined);
  assert.equal(dropped.end, '2026-12-15');
});

test('编辑表单对应并行中最晚开始的那段，保存不动旧段', () => {
  const s = overlap();
  const form = toEditForm(s, '2026-07-01');
  assert.equal(form.currency, 'TRY');
  assert.equal(form.region, 'TR');
  const saved = syncPhase({ ...form, methodId: 'card', price: 120 }, '2026-07-01');
  assert.equal(saved.phases![1].methodId, 'card');
  assert.equal(saved.phases![1].price, 120);
  assert.equal(saved.phases![0].methodId, 'us');
  assert.equal(saved.phases![0].price, 10);
  assert.equal(saved.phases![0].end, '2026-08-15');
  assert.equal(saved.phases![1].end, undefined);
  // 新段尚未开始（计划）时，表单是旧段
  const pl = switchPlan(base(), '2026-11-01', { ...TR, planned: true }, '2026-12-15');
  assert.equal(toEditForm(pl, '2026-10-20').currency, 'USD');
});

test('改阶段结束日：晚于下一段开始即并行，留空回到缺省', () => {
  const seq = switchPlan(base(), '2026-06-01', TR);
  const par = setPhaseEnd(seq, '2026-01-15', '2026-07-15');
  assert.equal(activePhases(par, '2026-06-20').length, 2);
  assert.equal(par.end, undefined);
  const cleared = setPhaseEnd(par, '2026-01-15', undefined);
  assert.equal(phaseSubs(cleared)[0].end, '2026-05-31');
  assert.equal(activePhases(cleared, '2026-06-20').length, 1);
  // 最后一段的结束日就是订阅的结束日
  assert.equal(setPhaseEnd(par, '2026-06-01', '2026-10-01').end, '2026-10-01');
  assert.throws(() => setPhaseEnd(par, '2026-06-01', '2026-05-01'));
});

test('并行期间实际在订的天数不重复计，没有断档', () => {
  const r = servedTime(overlap(), '2026-07-15');
  assert.equal(r.days, 181); // 1/15 → 7/15
  assert.equal(r.gaps.length, 0);
  assert.equal(servedTime(switchPlan(base(), '2026-06-01', TR), '2026-07-15').gaps.length, 0);
  const gap = setPhaseEnd(switchPlan(base(), '2026-06-01', TR), '2026-01-15', '2026-04-15');
  assert.deepEqual(
    servedTime(gap, '2026-07-15').gaps.map((g) => g.days),
    [46],
  );
});

test('预付余值：并行中旧区域没用完的部分也算', () => {
  const yearly = switchPlan(base({ price: 120, cycle: { unit: 'year', every: 1 } }), '2026-06-01', TR, '2027-01-15');
  const st = stateOf([yearly]);
  const r = prepaidValue(st, '2026-07-15');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].until, '2027-01-15');
  // 美区 120 USD 剩一半多（184/365），土区 7/1 那笔剩一半（17/31）
  near(r.total, convert(120, 'USD', 'CNY', FALLBACK_FX) * (184 / 365) + convert(100, 'TRY', 'CNY', FALLBACK_FX) * (17 / 31));
});

test('并行期间记一笔扣款：可指定阶段，缺省记到最晚开始的那段；改删旧段的扣款能找到旧段', () => {
  const s = overlap();
  const toTr = savePayment(s, '2026-07-20', { date: '2026-07-20', amount: 5 });
  assert.ok(toTr.phases![1].payments!.some((p) => p.date === '2026-07-20'));
  const toUs = savePayment(s, '2026-07-20', { date: '2026-07-20', amount: 5 }, undefined, '2026-01-15');
  assert.ok(toUs.phases![0].payments!.some((p) => p.date === '2026-07-20'));
  assert.ok(!toUs.phases![1].payments?.length);
  // 删掉美区 7/15 那笔（推算出来的）：不指定阶段也能找到美区
  const del = deletePayment(s, '2026-07-20', '2026-07-15', 0);
  assert.deepEqual(dates(del, '2026-07-01', '2026-07-31'), ['2026-07-01 TRY']);
  // 修改美区那笔的金额：留在美区
  const edited = savePayment(s, '2026-07-20', { date: '2026-07-15', amount: 12 }, { date: '2026-07-15', index: 0 }, '2026-01-15');
  assert.deepEqual(
    chargesBetween(edited, '2026-07-15', '2026-07-15', '2026-07-20').map((c) => `${c.amount} ${c.currency}`),
    ['12 USD'],
  );
});

test('补一段更早的买断：插在最前面，开始日前移，之后的年付照旧', () => {
  const yearly = base({ price: 14.99, cycle: { unit: 'year', every: 1 }, start: '2024-07-05' });
  const s = prependPlan(yearly, '2022-01-01', { price: 39.99, currency: 'USD', cycle: { unit: 'lifetime', every: 1 }, region: 'US' });
  assert.equal(s.start, '2022-01-01');
  assert.deepEqual(
    s.phases!.map((p) => [p.start, p.end, p.cycle.unit]),
    [
      ['2022-01-01', '2024-07-04', 'lifetime'],
      ['2024-07-05', undefined, 'year'],
    ],
  );
  // 顶层仍镜像最后一段（年付）
  assert.equal(s.price, 14.99);
  const cs = chargesBetween(s, '2021-01-01', '2025-12-31', '2025-12-31').map((c) => [c.date, c.amount]);
  assert.deepEqual(cs, [
    ['2022-01-01', 39.99],
    ['2024-07-05', 14.99],
    ['2025-07-05', 14.99],
  ]);
  // 有断档：买断那段早早结束
  assert.equal(
    prependPlan(yearly, '2022-01-01', { price: 39.99, currency: 'USD', cycle: { unit: 'lifetime', every: 1 } }, '2023-01-01').phases![0].end,
    '2023-01-01',
  );
  assert.throws(() => prependPlan(yearly, '2024-07-05', TR));
  assert.throws(() => prependPlan(yearly, '2022-01-01', TR, '2025-01-01'));
});

// Regression: the sole inferred/recorded payment must not be regenerated during replacement.
test('替换唯一推算扣款时只保存实扣金额，不重新生成原标价', () => {
  const s: Subscription = {
    id: 'replacement',
    name: 'Fictional',
    category: 'tools',
    tags: [],
    price: 12,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-10-22',
    status: 'active',
  };
  const after = savePayment(s, '2026-10-22', { date: '2026-10-22', amount: 11 }, { date: '2026-10-22', index: 0 });
  assert.deepEqual(
    after.payments?.map((p) => p.amount),
    [11],
  );
  const corrected = savePayment(after, '2026-10-22', { date: '2026-10-22', amount: 9 }, { date: '2026-10-22', index: 0 });
  assert.deepEqual(
    corrected.payments?.map((p) => p.amount),
    [9],
  );
});

const priceStory = () =>
  switchPlan(
    base({
      start: '2022-01-15',
      currency: 'TRY',
      region: 'TR',
      price: 200,
      priceHistory: [
        { from: '2022-01-15', amount: 40 },
        { from: '2023-01-15', amount: 60 },
        { from: '2024-01-15', amount: 120 },
        { from: '2025-01-15', amount: 200 },
      ],
      payments: [{ date: '2022-01-15', amount: 39, settled: { amount: 2, currency: 'USD' }, note: 'Actual' }],
    }),
    '2026-01-15',
    { price: 15, currency: 'USD', cycle: { unit: 'month', every: 1 }, region: 'US' },
  );

test('修正历史日期与金额：按日期重排、镜像最新价、保持其他阶段和实付', () => {
  const s = priceStory();
  const original = JSON.stringify(s);
  const next = editPricePoint(s, s.start, '2024-01-15', { from: '2025-05-15', amount: 240 });
  assert.deepEqual(
    next.phases![0].priceHistory?.map((p) => p.from),
    ['2022-01-15', '2023-01-15', '2025-01-15', '2025-05-15'],
  );
  assert.equal(next.phases![0].price, 240);
  assert.equal(next.price, 15); // 顶层仍镜像美区，不能被土区历史改写
  assert.deepEqual(next.phases![1], s.phases![1]);
  assert.deepEqual(next.phases![0].payments, s.phases![0].payments);
  assert.equal(JSON.stringify(s), original);
  assert.equal(chargesBetween(next, '2025-02-15', '2025-02-15', '2026-10-22')[0].amount, 200);
  assert.equal(chargesBetween(next, '2025-05-15', '2025-05-15', '2026-10-22')[0].amount, 240);
  const current = editPricePoint(next, '2026-01-15', '2026-01-15', { from: '2026-01-15', amount: 0 });
  assert.equal(current.price, 0);
});

test('价格点：拒绝无效日期、阶段外日期、重复日期和无效金额，不改变原始对象', () => {
  const s = priceStory();
  for (const from of ['2021-12-31', '2026-01-15', '2024-02-30', '2025-01-15']) {
    assert.throws(() => editPricePoint(s, s.start, '2024-01-15', { from, amount: 50 }));
  }
  for (const amount of [-1, NaN, Infinity]) assert.throws(() => editPricePoint(s, s.start, '2024-01-15', { from: '2024-01-15', amount }));
  assert.throws(() => editPricePoint(s, '1999-01-01', '2024-01-15', { from: '2024-01-15', amount: 50 }));
  assert.throws(() => editPricePoint(s, s.start, '1999-01-01', { from: '2024-01-15', amount: 50 }));
  const end = editPricePoint(s, s.start, '2025-01-15', { from: '2026-01-14', amount: 220 });
  assert.equal(end.phases![0].price, 220); // 最后服务日可生效
  assert.throws(() => changePrice(s, '2021-01-01', 20));
  const gap = setPhaseEnd(s, s.start, '2025-06-01');
  assert.throws(() => changePrice(gap, '2025-07-01', 20));
});

test('并行阶段：按阶段定位旧区域价格，日期允许落在并行服务期内', () => {
  const s = setPhaseEnd(priceStory(), '2022-01-15', '2026-03-01');
  const next = editPricePoint(s, s.start, '2025-01-15', { from: '2026-02-01', amount: 260 });
  assert.equal(next.phases![0].price, 260);
  assert.deepEqual(next.phases![1], s.phases![1]);
  assert.equal(next.price, 15);
});

test('删除中间和最新调价：前价衔接，起始价不可删，实付不变', () => {
  const s = priceStory();
  const next = removePricePoint(s, s.start, '2024-01-15');
  assert.equal(chargesBetween(next, '2024-06-15', '2024-06-15', '2026-10-22')[0].amount, 60);
  assert.equal(chargesBetween(next, '2025-06-15', '2025-06-15', '2026-10-22')[0].amount, 200);
  const last = removePricePoint(next, s.start, '2025-01-15');
  assert.equal(last.phases![0].price, 60);
  assert.deepEqual(last.phases![0].payments, s.phases![0].payments);
  assert.deepEqual(last.phases![1], s.phases![1]);
  assert.throws(() => removePricePoint(s, s.start, s.start));
  assert.throws(() => removePricePoint(s, s.start, '1999-01-01'));
});

test('无显式历史也可修改起始价及生效日，不引入阶段，首期优惠保留', () => {
  const s = base({ intro: { until: '2026-02-15', price: 2 } });
  const next = editPricePoint(s, s.start, s.start, { from: '2026-01-16', amount: 0 });
  assert.equal(next.phases, undefined);
  assert.deepEqual(next.priceHistory, [{ from: '2026-01-16', amount: 0 }]);
  assert.equal(next.price, 0);
  assert.deepEqual(next.intro, s.intro);
  assert.equal(chargesBetween(next, '2026-01-15', '2026-01-15', '2026-10-22')[0].amount, 2);
  assert.throws(() => removePricePoint(next, s.start, '2026-01-16'));
  assert.equal(pricePoints(changePrice(s, '2026-03-15', 20))[0].amount, 10);
});

test('价格修正只重算已发生的预计扣款，计数排除实付、未来和无变化', () => {
  const s = base({
    price: 20,
    priceHistory: [
      { from: '2026-01-15', amount: 10 },
      { from: '2026-03-15', amount: 20 },
    ],
  });
  const next = editPricePoint(s, s.start, '2026-03-15', { from: '2026-04-15', amount: 25 });
  assert.equal(affectedPriceCharges(s, next, '2026-05-15'), 3); // 三月改回10，四月五月改25
  assert.equal(affectedPriceCharges(s, next, '2026-02-15'), 0);
  assert.equal(affectedPriceCharges(s, s, '2026-05-15'), 0);
  const actual = { ...s, payments: [{ date: '2026-03-15', amount: 18, note: 'Actual' }], nextDue: '2026-04-15' };
  const revised = editPricePoint(actual, s.start, '2026-03-15', { from: '2026-04-15', amount: 25 });
  assert.equal(affectedPriceCharges(actual, revised, '2026-05-15'), 2);
  assert.deepEqual(
    chargesBetween(revised, '2026-03-15', '2026-05-15', '2026-05-15').map((c) => c.amount),
    [18, 25, 25],
  );
  assert.deepEqual(revised.payments, actual.payments);
});

test('change_plan 编辑整个价格历史：排序、最新价保持一致，并验证重复与越界', () => {
  const s = priceStory();
  const next = editPhase(s, s.start, {
    priceHistory: [
      { from: '2025-01-15', amount: 180 },
      { from: s.start, amount: 30 },
    ],
  });
  assert.equal(next.phases![0].price, 180);
  assert.deepEqual(
    next.phases![0].priceHistory?.map((p) => p.amount),
    [30, 180],
  );
  assert.deepEqual(next.phases![0].payments, s.phases![0].payments);
  assert.deepEqual(next.phases![1], s.phases![1]);
  assert.throws(() => editPhase(s, s.start, { priceHistory: [] }));
  assert.throws(() => editPhase(s, s.start, { priceHistory: [{ from: '2025-01-15', amount: 10 }] }));
  assert.throws(() =>
    editPhase(s, s.start, {
      priceHistory: [
        { from: s.start, amount: 10 },
        { from: s.start, amount: 20 },
      ],
    }),
  );
  assert.throws(() => editPhase(s, s.start, { priceHistory: [{ from: '2026-01-15', amount: 10 }] }));
});

test('上一段结束日等于下一段开始日：新写入拒绝，已存的旧记录仍可保存，真并行和无缝切换照常', () => {
  // 线上 X：月付 10/13 起、结束日误写成 11/13，年付 11/13 起，结果 11/13 月付与年付各扣一次
  const seamless = switchPlan(base({ start: '2026-10-13' }), '2026-11-13', { price: 300, currency: 'USD', cycle: { unit: 'year', every: 1 } });
  const bad: Subscription = { ...seamless, phases: [{ ...seamless.phases![0], end: '2026-11-13' }, seamless.phases![1]] };
  assert.deepEqual(dates(bad, '2026-11-13', '2026-11-13'), ['2026-11-13 USD', '2026-11-13 USD']);
  assert.ok(newShapeError(seamless, bad));
  assert.equal(newShapeError(bad, bad), undefined);
  assert.equal(newShapeError(undefined, seamless), undefined);
  assert.equal(newShapeError(undefined, overlap()), undefined);
  assert.deepEqual(dates(seamless, '2026-11-13', '2026-11-13'), ['2026-11-13 USD']);
  assert.throws(() => setPhaseEnd(seamless, '2026-10-13', '2026-11-13'));
  assert.equal(setPhaseEnd(seamless, '2026-10-13', '2026-11-12').phases![0].end, '2026-11-12');
});

test('结束日不撞下一段开始日：并行时在切换日停用、开始日提前一天、补前段、隔段相撞', () => {
  // 并行期间恰在新一段开始那天停用：较早那段截到前一天，存得进去
  const ov = overlap();
  const st = stopSubscription(ov, '2026-06-01', 'cancel', '2026-06-01');
  assert.deepEqual(
    st.phases!.map((p) => [p.start, p.end]),
    [
      ['2026-01-15', '2026-05-31'],
      ['2026-06-01', '2026-06-01'],
    ],
  );
  assert.equal(newShapeError(ov, st), undefined);
  // 无缝切换后把新段开始日提前一天：上一段结束日跟着挪
  const seamless = switchPlan(base(), '2026-03-01', TR);
  const moved = movePhaseStart(seamless, '2026-03-01', '2026-02-28');
  assert.equal(moved.phases![0].end, '2026-02-27');
  assert.equal(newShapeError(seamless, moved), undefined);
  // 补前段的 until 不能等于原第一段开始日
  assert.throws(() => prependPlan(base(), '2025-06-01', TR, '2026-01-15'));
  // 并行跨过中间一段、结束日恰好等于再下一段的开始日，同样拦下
  const three: Subscription = {
    ...seamless,
    phases: [{ ...seamless.phases![0], end: '2026-05-01' }, seamless.phases![1], { ...seamless.phases![1], start: '2026-05-01' }],
  };
  assert.ok(newShapeError(seamless, three));
});

test('结束日不撞新开始日：更早的并行段同样往前收一天，暂停中排好的计划在停用日撤掉', () => {
  const JP = { price: 1000, currency: 'JPY', cycle: { unit: 'month' as const, every: 1 }, region: 'JP' };
  const ov = overlap();
  const again = switchPlan(ov, '2026-08-15', JP);
  assert.deepEqual(
    again.phases!.map((p) => p.end),
    ['2026-08-14', '2026-08-14', undefined],
  );
  assert.equal(newShapeError(ov, again), undefined);
  const later = switchPlan(ov, '2026-09-01', JP);
  const moved = movePhaseStart(later, '2026-09-01', '2026-08-15');
  assert.equal(moved.phases![0].end, '2026-08-14');
  assert.equal(newShapeError(later, moved), undefined);
  const paused: Subscription = { ...switchPlan(base(), '2026-06-15', TR), status: 'paused', pausedAt: '2026-06-01' };
  const st = stopSubscription(paused, '2026-06-20', 'cancel', '2026-06-15');
  assert.deepEqual(
    st.phases!.map((p) => [p.start, p.end]),
    [['2026-01-15', '2026-06-15']],
  );
  assert.equal(newShapeError(paused, st), undefined);
  // 那段已有付款时不悄悄删，留给校验拦下
  const paid: Subscription = { ...paused, phases: [paused.phases![0], { ...paused.phases![1], payments: [{ date: '2026-06-15', amount: 100 }] }] };
  const kept = stopSubscription(paid, '2026-06-20', 'cancel', '2026-06-15');
  assert.deepEqual(kept.phases![1].payments, [{ date: '2026-06-15', amount: 100 }]);
  assert.ok(newShapeError(paid, kept));
  // 无缝衔接的新段提前多天，上一段一样收到前一天
  const seamless = switchPlan(base(), '2026-03-20', TR);
  assert.equal(movePhaseStart(seamless, '2026-03-20', '2026-03-10').phases![0].end, '2026-03-09');
  // 存量坏数据（结束日已等于下一段开始日）在那天停用，较早那段同样截到前一天
  const bad: Subscription = { ...seamless, phases: [{ ...seamless.phases![0], end: '2026-03-20' }, seamless.phases![1]] };
  assert.equal(stopSubscription(bad, '2026-03-20', 'cancel', '2026-03-20').phases![0].end, '2026-03-19');
});

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  billingPeriod,
  chargesBetween,
  currentPhase,
  effectiveStatus,
  FALLBACK_FX,
  memberDues,
  nextCharge,
  phaseSubs,
  stopSummary,
  subError,
  todayIn,
  totals,
} from './billing.ts';
import { cancelAtEnd, reactivate, resume, savePayment, statusChangeError, stopSubscription, switchPlan } from './phases.ts';
import { cancelSavings, events, insights, prepaidValue, stopLosses, yearReview } from './metrics.ts';
import { maskForPublic } from './mask.ts';
import { chargeValue } from './fx.ts';
import { flatten, LOCALES, setLocale, t } from './i18n.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import type { ToolCtx } from '../worker/ai/tool-kit.ts';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { exportAll, parseBackup } from '../worker/backup.ts';
import { buildDaily } from '../worker/notify.ts';
import type { Env } from '../worker/env.ts';

const messages = {};
for (const ns of ['core', 'common', 'mcp', 'notify'])
  flatten(ns, JSON.parse(readFileSync(new URL(`./locales/en/${ns}.json`, import.meta.url), 'utf8')), messages);
setLocale('en', [messages]);
const base = (extra: Partial<Subscription> = {}): Subscription => ({
  id: 's',
  name: 'Service',
  category: 'tools',
  tags: [],
  price: 31,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-10-05',
  status: 'active',
  ...extra,
});
const state = (s: Subscription): AppState => ({ subscriptions: [s], methods: [], settings: { ...DEFAULT_SETTINGS }, fx: FALLBACK_FX });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.005, `${actual} ≈ ${expected}`);
const today = '2026-10-19';

for (const [name, s, at, from, through, days] of [
  ['monthly', base(), today, '2026-10-05', '2026-11-04', 31],
  ['annual leap', base({ start: '2024-02-29', cycle: { unit: 'year', every: 1 } }), '2025-03-01', '2025-02-28', '2026-02-27', 365],
  ['custom days', base({ cycle: { unit: 'day', every: 17 } }), '2026-10-24', '2026-10-22', '2026-11-07', 17],
  ['custom weeks', base({ cycle: { unit: 'week', every: 3 } }), today, '2026-10-05', '2026-10-25', 21],
  ['month end Feb', base({ start: '2026-01-31' }), '2026-03-01', '2026-02-28', '2026-03-30', 31],
  ['month end no drift', base({ start: '2026-01-31' }), '2026-04-01', '2026-03-31', '2026-04-29', 30],
  ['nextDue', base({ nextDue: '2026-11-10' }), today, '2026-10-05', '2026-11-09', 36],
] as const)
  test(`paidThrough: ${name}`, () => {
    const p = billingPeriod(s, at);
    assert.deepEqual([p.from, p.paidThrough, p.days], [from, through, days]);
  });

test('实付、补差与首期优惠用于折算，settled 不改变订阅币种基数', () => {
  const s = base({
    payments: [
      { date: '2026-10-05', amount: 20, settled: { amount: 140, currency: 'CNY' } },
      { date: '2026-10-10', amount: 2, kind: 'adjust' },
    ],
    nextDue: '2026-11-05',
  });
  assert.equal(billingPeriod(s, today).paid, 22);
  near(stopSummary(stopSubscription(s, today, 'cancel'))!.suggestedRefund, 11.35);
  assert.equal(billingPeriod(base({ intro: { until: '2026-11-05', price: 10 } }), today).paid, 10);
});

for (const [name, amount, value, status, wasted] of [
  ['none', undefined, 16, 'none', 16],
  ['partial', 6, 10, 'partial', 10],
  ['prorated full', 16, 0, 'full', 0],
  ['whole period full', 31, 0, 'full', 0],
] as const)
  test(`停止后已付未用: ${name}`, () => {
    const stopped = stopSubscription(base(), today, 'terminate', today, 'abuse', amount == null ? undefined : { amount });
    const summary = stopSummary(stopped)!;
    assert.equal(summary.paidThrough, '2026-11-04');
    assert.equal(summary.unusedDays, 16);
    assert.equal(summary.suggestedRefund, 16);
    assert.equal(summary.refunded, amount ?? 0);
    assert.equal(summary.unusedValue, value);
    // 按天退回剩余部分即全额退款；时间轴虚线只画没退回的天数
    assert.equal(summary.refundStatus, status);
    assert.equal(summary.wastedDays, wasted);
    const prepaid = prepaidValue(state(stopped), today);
    assert.equal(prepaid.total, 0);
    assert.equal(prepaid.unusedTotal, value);
    const losses = stopLosses(state(stopped), today);
    assert.equal(losses.total, value);
    assert.equal(losses.byKind.terminate, value);
    assert.equal(losses.byKind.cancel, 0);
    assert.equal(losses.items.length, value > 0 ? 1 : 0);
    if (value > 0) {
      const item = losses.items[0];
      assert.equal(item.sub, stopped);
      assert.equal(item.phaseIndex, 0);
      assert.equal(item.kind, 'terminate');
      assert.equal(item.reason, 'abuse');
      assert.equal(item.date, today);
      assert.equal(item.paid, 31);
      assert.equal(item.paidBase, 31);
      assert.equal(item.refunded, amount ?? 0);
      assert.equal(item.refundedBase, amount ?? 0);
      assert.equal(item.loss, value);
      assert.equal(item.lossBase, value);
      assert.equal(item.refundStatus, status);
      assert.equal(item.wastedDays, wasted);
    }
    assert.equal(cancelSavings(state(stopped), '2026-10-30').total, 0);
    assert.ok(cancelSavings(state(stopped), '2026-12-01').total > 0);
    assert.equal(
      insights(state(stopped), today).some((i) => i.id === 'unused'),
      value > 0,
    );
  });

test('停用损失按停止日合租份额与历史汇率计算，代付不计', () => {
  const shared = base({
    share: {
      role: 'owner',
      seats: 3,
      members: [
        { id: 'm1', name: 'M1', share: 15.5, joined: '2026-10-05', left: '2026-10-20' },
        { id: 'm2', name: 'M2', share: 15.5, joined: '2026-10-20' },
      ],
    },
  });
  const stopped = stopSubscription(shared, today, 'cancel', today, undefined, { amount: 6 });
  const st = state(stopped);
  st.settings = { ...st.settings, baseCurrency: 'CNY' };
  st.fx = { base: 'USD', fetchedAt: '2026-12-01', rates: { USD: 1, CNY: 9 } };
  st.fxHistory = { '2026-10-05': { CNY: 6 }, '2026-10-19': { CNY: 7 }, '2026-12-01': { CNY: 8 } };
  st.subscriptions.push({ ...stopped, id: 'proxy', proxy: { forName: 'Friend', entries: [] } });
  const losses = stopLosses(st, '2026-12-01');
  assert.equal(losses.items.length, 1);
  const item = losses.items[0];
  assert.equal(item.paid, 15.5);
  assert.equal(item.paidBase, 108.5);
  assert.equal(item.refunded, 3);
  assert.equal(item.refundedBase, 21);
  assert.equal(item.loss, 5);
  assert.equal(item.lossBase, 35);
  assert.equal(item.reason, undefined);
  assert.equal(item.wastedDays, 10);
  assert.deepEqual(losses.byKind, { cancel: 35, terminate: 0 });
  assert.equal(prepaidValue(st, '2026-12-01').unusedTotal, losses.total);
  assert.equal(insights(st, '2026-12-01').find((i) => i.id === 'unused')!.subs![0].id, stopped.id);
});

test('跨币种损失使用历史阶段币种与停止日汇率，不使用当前套餐或实退卡币种', () => {
  const original = stopSubscription(base({ currency: 'EUR' }), today, 'terminate', today, 'closed', {
    amount: 6,
    settled: { amount: 60, currency: 'CNY' },
  });
  const next = resume(original, '2026-11-01', { price: 100, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const st = state(next);
  st.settings = { ...st.settings, baseCurrency: 'CNY' };
  st.fx = { base: 'USD', fetchedAt: '2026-12-01', rates: { USD: 1, EUR: 4, CNY: 12 } };
  st.fxHistory = { '2026-10-19': { EUR: 2, CNY: 8 } };
  const losses = stopLosses(st, '2026-12-01');
  assert.equal(losses.items[0].phase.currency, 'EUR');
  assert.equal(losses.items[0].currency, 'EUR');
  assert.equal(losses.items[0].loss, 10);
  assert.equal(losses.items[0].lossBase, 40);
  assert.equal(losses.items[0].refunded, 6);
  assert.equal(losses.items[0].refundedBase, 24);
  assert.equal(prepaidValue(st, '2026-12-01').unusedTotal, 40);
});

test('同一订阅多个停止阶段逐条统计，体检只引用一次订阅', () => {
  const first = stopSubscription(base(), today, 'terminate', today, 'abuse');
  const next = resume(first, '2026-11-05', { price: 30, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const stopped = stopSubscription(next, '2026-11-19', 'cancel');
  const st = state(stopped);
  const losses = stopLosses(st, '2026-12-01');
  assert.equal(losses.items.length, 2);
  assert.deepEqual(
    losses.items.map((i) => [i.phaseIndex, i.kind, i.loss]),
    [
      [1, 'cancel', 15],
      [0, 'terminate', 16],
    ],
  );
  assert.equal(losses.total, 31);
  assert.deepEqual(losses.byKind, { cancel: 15, terminate: 16 });
  assert.equal(prepaidValue(st, '2026-12-01').unusedTotal, 31);
  assert.equal(insights(st, '2026-12-01').find((i) => i.id === 'unused')!.subs!.length, 1);
});

test('退款按查询日截断，未来停止不计；后续全额退款移除损失', () => {
  const stopped = stopSubscription(base(), today, 'cancel', today, undefined, { amount: 16, date: '2026-10-21' });
  const st = state(stopped);
  assert.equal(stopLosses(st, '2026-10-18').total, 0);
  assert.equal(stopLosses(st, today).total, 16);
  assert.equal(stopLosses(st, '2026-10-20').items[0].refunded, 0);
  assert.equal(stopLosses(st, '2026-10-21').total, 0);
  assert.equal(stopLosses(st, '2026-10-21').items.length, 0);
});

test('年度回顾和范围按停止日含两端筛选，排除前年停止与未来停止', () => {
  const make = (start: string, date: string, kind: 'cancel' | 'terminate') => stopSubscription(base({ id: date, start }), date, kind);
  const st = state(make('2025-12-05', '2025-12-31', 'terminate'));
  st.subscriptions.push(make('2025-12-05', '2026-01-01', 'cancel'), make('2026-12-05', '2026-12-31', 'terminate'), make('2026-12-05', '2027-01-01', 'cancel'));
  const at = '2026-12-31';
  assert.equal(yearReview(st, at, '2025').stopLoss, 4);
  assert.equal(yearReview(st, at, '2026').stopLoss, 7);
  assert.equal(yearReview(st, at, '2027').stopLoss, 0);
  assert.equal(stopLosses(st, at, { from: '2026-01-01', to: '2026-01-01' }).total, 3);
  assert.equal(stopLosses(st, at, { from: '2026-12-31', to: '2026-12-31' }).total, 4);
  assert.equal(stopLosses(st, at, { from: '2027-01-01' }).total, 0);
  assert.equal(stopLosses(st, at).total, prepaidValue(st, at).unusedTotal);
  assert.deepEqual(stopLosses({ ...st, subscriptions: [] }, at), {
    partial: { value: 0, incomplete: false, unconverted: {}, known: false },
    total: 0,
    byKind: { cancel: 0, terminate: 0 },
    items: [],
    incomplete: false,
  });
});

test('缺少汇率保留原币损失并标记汇总不可用，不变成零损失或空明细', () => {
  const stopped = stopSubscription(base({ currency: 'XYZ' }), today, 'terminate');
  const st = state(stopped);
  const losses = stopLosses(st, today);
  assert.equal(losses.items.length, 1);
  assert.equal(losses.items[0].loss, 16);
  assert.equal(losses.items[0].fxMissing, true);
  assert.equal(losses.incomplete, true);
  assert.ok(Number.isNaN(losses.total));
  assert.ok(Number.isNaN(prepaidValue(st, today).unusedTotal));
  assert.equal(prepaidValue(st, today).unusedIncomplete, true);
  assert.ok(Number.isNaN(yearReview(st, today).stopLoss));
  assert.ok(insights(st, today).some((i) => i.id === 'unused'));
});

test('三种停止状态与恢复边界', () => {
  const cancel = stopSubscription(base(), today, 'cancel');
  const terminate = stopSubscription(base(), today, 'terminate');
  assert.equal(effectiveStatus(cancel, today), 'ended');
  assert.equal(effectiveStatus(terminate, today), 'terminated');
  assert.equal(effectiveStatus(terminate, addDays(today, -1)), 'ending');
  const normal = cancelAtEnd(base(), '2026-11-04', today);
  assert.equal(normal.stop, undefined);
  assert.equal(effectiveStatus(normal, today), 'ending');
  assert.equal(effectiveStatus(normal, '2026-11-05'), 'ended');
  const restored = reactivate(cancel);
  assert.equal(restored.end, undefined);
  assert.equal(restored.stop, undefined);
  assert.equal(effectiveStatus(restored, today), 'active');
  // 用户反馈回归：误记的被服务方停用可以撤销，停用连同损失一起消失；但不能改成别的停用方式
  const undone = reactivate(terminate);
  assert.equal(undone.stop, undefined);
  assert.equal(undone.end, undefined);
  assert.equal(effectiveStatus(undone, today), 'active');
  assert.equal(statusChangeError(terminate, undone, today), undefined);
  assert.equal(
    statusChangeError(terminate, { ...terminate, end: undefined, stop: undefined, status: 'cancelled' }, today),
    t('mcp.error.terminatedReactivate'),
  );
  assert.equal(
    statusChangeError(terminate, { ...terminate, stop: { ...terminate.stop!, kind: 'cancel' }, status: 'cancelled' }, today),
    t('mcp.error.terminatedReactivate'),
  );
  assert.equal(events(state(terminate), today).find((event) => event.kind === 'terminate')!.date, today);
  assert.ok(events(state(terminate), today).find((event) => event.kind === 'terminate')!.delta < 0);
});

test('停止后不预测扣款，退款冲减支出但不成为续费锚点', () => {
  const original = base({
    payments: [
      { date: '2026-10-05', amount: 31 },
      { date: '2026-11-05', amount: 31 },
    ],
    nextDue: '2026-12-05',
  });
  const s = stopSubscription(original, today, 'cancel', today, undefined, { amount: 6, date: '2026-10-20', settled: { amount: 40, currency: 'CNY' } });
  const cs = chargesBetween(s, s.start, '2027-12-31', '2026-10-21');
  assert.deepEqual(
    cs.map((c) => [c.date, c.amount]),
    [
      ['2026-10-05', 31],
      ['2026-10-20', -6],
    ],
  );
  assert.equal(nextCharge(s, today), undefined);
  assert.equal(totals(state(s), today).mrr, 0);
  near(
    cs.reduce((sum, c) => sum + chargeValue(state(s), c), 0),
    31 - 40 / FALLBACK_FX.rates.CNY,
  );
  const live = savePayment(base(), today, { date: today, kind: 'refund', amount: -1 });
  assert.equal(nextCharge(live, '2026-10-20'), '2026-11-05');
});

test('合租欠款截止停止日并保留；停止后没有续费及合租提醒', () => {
  const owned = base({ share: { role: 'owner', seats: 2, members: [{ id: 'm', name: 'M', share: 10, joined: '2026-10-05' }] } });
  const stopped = stopSubscription(owned, today, 'terminate');
  assert.equal(memberDues(stopped, today)[0].owed, 10);
  assert.equal(memberDues(stopped, '2028-10-05')[0].owed, 10);
  assert.equal(buildDaily(state(stopped), '2026-11-02'), undefined);
});

test('停用后新阶段保留原始停止、退款和并行阶段的截止日', () => {
  const planned = switchPlan(base(), '2026-11-05', { price: 50, currency: 'EUR', cycle: { unit: 'year', every: 1 } });
  const stopped = stopSubscription(planned, today, 'terminate', today, 'abuse', { amount: 6 });
  assert.equal(stopped.phases!.length, 1);
  const next = resume(stopped, '2026-10-23', { price: 20, currency: 'EUR', cycle: { unit: 'month', every: 1 } });
  assert.equal(next.stop, undefined);
  assert.equal(phaseSubs(next)[0].stop?.reason, 'abuse');
  assert.equal(phaseSubs(next)[0].end, today);
  assert.equal(statusChangeError(stopped, next, today), undefined);
  assert.equal(effectiveStatus(next, '2026-10-23'), 'active');
  const refund = savePayment(next, '2026-11-12', { date: '2026-11-12', kind: 'refund', amount: -2, currency: 'USD' }, undefined, '2026-10-05');
  assert.equal(phaseSubs(refund)[0].payments!.at(-1)!.amount, -2);
  assert.equal(stopSummary(phaseSubs(refund)[0])!.refunded, 8);
  assert.equal(currentPhase(refund, '2026-11-12').currency, 'EUR');
});

test('公开页保留已停用状态，顶层与历史阶段均不下发原因或退款', () => {
  const stopped = stopSubscription(base(), today, 'terminate', today, 'PRIVATE ABUSE', { amount: 6, settled: { amount: 40, currency: 'CNY' } });
  for (const original of [stopped, resume(stopped, '2026-11-01', { price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } })]) {
    const exposed = maskForPublic(state(original));
    assert.ok(!JSON.stringify(exposed).includes('PRIVATE ABUSE'));
    assert.ok(!JSON.stringify(exposed).includes('refund'));
    for (const p of phaseSubs(exposed.subscriptions[0])) {
      assert.equal(p.stop?.reason, undefined);
      assert.ok(!p.payments?.some((pay) => pay.kind === 'refund'));
    }
  }
  assert.equal(effectiveStatus(maskForPublic(state(stopped)).subscriptions[0], today), 'terminated');
});

test('subError 覆盖非法 stop、账期与退款，退款累计包含已有记录', () => {
  const s = stopSubscription(base(), today, 'cancel');
  const error = (patch: Partial<Subscription>, key: string) => assert.equal(subError({ ...s, ...patch }), t(`mcp.error.${key}`));
  error({ stop: { ...s.stop!, date: '2026-10-01' } }, 'stopBeforeStart');
  error({ stop: { ...s.stop!, date: '2026-11-05' } }, 'stopAfterPaidThrough');
  error({ stop: { ...s.stop!, paidThrough: '2026-11-03' } }, 'invalidPaidThrough');
  error({ end: '2026-10-20' }, 'invalidStop');
  error({ stop: { ...s.stop!, reason: 'only terminate' } }, 'invalidStop');
  error({ stop: undefined, status: 'terminated' }, 'needStop');
  const refunded = savePayment(s, today, { date: today, kind: 'refund', amount: -20 });
  assert.throws(() => savePayment(refunded, today, { date: '2026-10-20', kind: 'refund', amount: -12 }), { message: t('mcp.error.refundExceedsPaid') });
  assert.throws(() => savePayment(s, today, { date: today, kind: 'refund', amount: -1, currency: 'EUR' }), { message: t('mcp.error.refundCurrency') });
  assert.throws(() => savePayment(s, today, { date: today, kind: 'refund', amount: 1 }), { message: t('mcp.error.invalidRefund') });
});

/** MCP 用真 SQLite 执行持久化，禁止外部请求。 */
function fixture(sub = base({ start: addDays(todayIn('UTC'), -14) })) {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) for (const sql of m.statements) db.exec(sql);
  db.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)').run(sub.id, JSON.stringify(sub));
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('settings', JSON.stringify(DEFAULT_SETTINGS));
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        const query = db.prepare(sql);
        if (query.columns().length) return { results: query.all(...args) };
        return { results: [], meta: { changes: Number(query.run(...args).changes) } };
      },
    };
    return stmt;
  };
  const ctx: ToolCtx = {
    env: {
      DB: {
        prepare,
        async batch(stmts: Array<ReturnType<typeof prepare>>) {
          return Promise.all(stmts.map((s) => s.run()));
        },
      },
    } as unknown as Env,
  };
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = TOOLS.find((tool) => tool.name === name)!;
    const hasSubscription = Object.hasOwn(tool.inputSchema.properties as object, 'subscription');
    // 停用不再默认今天：这些用例检验的是「今天停用」时的账期规则，显式传今天
    if (name === 'set_status' && ['cancel', 'terminate'].includes(String(args.action)) && !('at' in args)) args = { ...args, at: todayIn('UTC') };
    return tool.run({ ...(hasSubscription ? { subscription: sub.id } : {}), ...args }, ctx) as Promise<Record<string, any>>;
  };
  const saved = () => JSON.parse((db.prepare('SELECT data FROM subscriptions WHERE id = ?').get(sub.id) as { data: string }).data) as Subscription;
  return { db, ctx, run, saved, sub };
}

for (const action of ['cancel', 'terminate'] as const)
  test(`MCP ${action}: 预览账期与按天建议金额、无写入、保存与查询`, async () => {
    const f = fixture();
    try {
      const args = { action, immediate: action === 'cancel', reason: action === 'terminate' ? 'abuse' : undefined };
      const preview = await f.run('set_status', { ...args, dry_run: true });
      assert.equal(f.saved().stop, undefined);
      assert.equal(preview.dry_run, true);
      assert.equal(preview.subscription.stop.unusedDays > 0, true);
      assert.equal(typeof preview.subscription.stop.suggestedRefund, 'number');
      const saved = await f.run('set_status', { ...args, refund: { amount: 3, settled: { amount: 21, currency: 'CNY' } } });
      assert.equal(saved.ok, true);
      assert.equal(f.saved().payments!.at(-1)!.amount, -3);
      const detail = await f.run('get_subscription');
      assert.equal(detail.stop.reason, action === 'terminate' ? 'abuse' : undefined);
      assert.equal(detail.stop.refunded, 3);
      const list = await f.run('list_subscriptions', { status: action === 'terminate' ? 'terminated' : 'ended' });
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].stop.refunded, 3);
    } finally {
      f.db.close();
    }
  });

test('MCP get_insights 返回独立损失明细、分类合计与年度损失，保留省钱 section', async () => {
  const now = todayIn('UTC');
  const stopped = stopSubscription(base({ start: addDays(now, -14) }), now, 'terminate', now, 'abuse', { amount: 3 });
  const f = fixture(stopped);
  try {
    const result = await f.run('get_insights', { section: 'stop_losses' });
    const expected = stopLosses(state(stopped), now);
    near(result.total, expected.total);
    assert.equal(result.as_of, now);
    assert.equal(result.currency, 'USD');
    near(result.by_type.terminate, expected.total);
    assert.equal(result.by_type.cancel, 0);
    assert.equal(result.items[0].subscription_id, stopped.id);
    assert.equal(result.items[0].phase_index, 0);
    assert.equal(result.items[0].phase_start, stopped.start);
    assert.equal(result.items[0].kind, 'terminate');
    assert.equal(result.items[0].reason, 'abuse');
    assert.equal(result.items[0].refunded, 3);
    assert.equal(result.items[0].paid, 31);
    assert.equal(result.items[0].refund_status, 'partial');
    near(result.items[0].loss_base, expected.total);
    const prepaid = await f.run('get_insights', { section: 'prepaid' });
    assert.equal(prepaid.unused_total, result.total);
    const review = await f.run('get_insights', { section: 'year_review', year: now.slice(0, 4) });
    assert.equal(review.stop_loss, result.total);
    const previous = await f.run('get_insights', { section: 'year_review', year: String(Number(now.slice(0, 4)) - 1) });
    assert.equal(previous.stop_loss, 0);
    const saved = await f.run('get_insights', { section: 'cancel_savings' });
    assert.equal(saved.total, 0);
    assert.deepEqual(f.saved(), JSON.parse(JSON.stringify(stopped)));
  } finally {
    f.db.close();
  }
});

test('MCP 缺少汇率时返回 null 与 incomplete 标记，原币损失仍可读取', async () => {
  const now = todayIn('UTC');
  const stopped = stopSubscription(base({ start: addDays(now, -14), currency: 'XYZ' }), now, 'cancel');
  const f = fixture(stopped);
  try {
    const result = await f.run('get_insights', { section: 'stop_losses' });
    assert.equal(result.incomplete, true);
    assert.equal(result.total, null);
    assert.equal(result.by_type.cancel, null);
    assert.equal(result.items[0].fx_missing, true);
    assert.equal(result.items[0].loss_base, null);
    assert.ok(result.items[0].loss > 0);
    assert.equal(result.items[0].currency, 'XYZ');
    assert.ok(!('reason' in result.items[0]));
    const prepaid = await f.run('get_insights', { section: 'prepaid' });
    assert.equal(prepaid.unused_total, null);
    assert.equal(prepaid.unused_incomplete, true);
    const review = await f.run('get_insights', { section: 'year_review' });
    assert.equal(review.stop_loss, null);
    assert.equal(review.stop_loss_incomplete, true);
  } finally {
    f.db.close();
  }
});

test('MCP pause / reactivate / 默认到期不续，不生成 stop', async () => {
  const f = fixture();
  try {
    await f.run('set_status', { action: 'pause' });
    assert.equal(f.saved().status, 'paused');
    await f.run('set_status', { action: 'reactivate' });
    assert.equal(f.saved().status, 'active');
    await f.run('set_status', { action: 'cancel', at: addDays(todayIn('UTC'), 1) });
    assert.equal(f.saved().stop, undefined);
    assert.equal(f.saved().end, addDays(todayIn('UTC'), 1));
    await f.run('set_status', { action: 'reactivate' });
    assert.equal(f.saved().end, undefined);
  } finally {
    f.db.close();
  }
});

test('MCP dry_run 叠加层可查询并恢复提前退订与误记的停用', async () => {
  for (const action of ['cancel', 'terminate']) {
    const f = fixture();
    f.ctx.overlay = new Map();
    try {
      await f.run('set_status', { action, immediate: true, dry_run: true });
      assert.equal((await f.run('get_subscription')).status, action === 'cancel' ? 'ended' : 'terminated');
      assert.equal((await f.run('set_status', { action: 'reactivate', dry_run: true })).subscription.stop, null);
      assert.equal(f.saved().stop, undefined);
    } finally {
      f.db.close();
    }
  }
});

test('用户反馈回归：MCP 可撤销误记的被服务方停用，原记录恢复且不再算停用损失', async () => {
  const f = fixture();
  try {
    await f.run('set_status', { action: 'terminate', reason: 'mistake' });
    assert.equal(f.saved().stop?.kind, 'terminate');
    await f.run('set_status', { action: 'reactivate' });
    const s = f.saved();
    assert.equal(s.stop, undefined);
    assert.equal(s.end, undefined);
    assert.equal(s.status, 'active');
    assert.equal(s.phases?.length ?? 0, f.sub.phases?.length ?? 0);
    assert.equal(stopLosses(state(s), todayIn('UTC')).items.length, 0);
  } finally {
    f.db.close();
  }
});

test('审查回归：撤销服务方停用不能在同一次保存里另加阶段或停用，变相改成别的停用方式', () => {
  const base: Subscription = {
    id: 'u',
    name: 'U',
    category: '工具',
    tags: [],
    price: 20,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-08-01',
    status: 'active',
  };
  const phased = switchPlan(base, '2026-10-01', { price: 30, currency: 'USD', cycle: { unit: 'month', every: 1 } });
  const stopped = stopSubscription(phased, '2026-11-07', 'terminate', '2026-11-07', 'mistake');
  assert.equal(statusChangeError(stopped, reactivate(stopped), '2026-11-07'), undefined);
  const open = reactivate(stopped);
  const sneaky: Subscription = {
    ...open,
    phases: [
      ...open.phases!,
      {
        start: '2026-11-08',
        end: '2026-11-08',
        price: 30,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        stop: { kind: 'cancel', date: '2026-11-08', paidThrough: '2026-12-07' },
      },
    ],
  };
  assert.equal(statusChangeError(stopped, sneaky, '2026-11-07'), t('mcp.error.terminatedReactivate'));
  const restop = {
    ...open,
    phases: open.phases!.map((p, i, all) =>
      i === all.length - 1 ? { ...p, stop: { kind: 'cancel' as const, date: '2026-11-07', paidThrough: '2026-11-30' } } : p,
    ),
  };
  assert.equal(statusChangeError(stopped, restop, '2026-11-07'), t('mcp.error.terminatedReactivate'));
  // 审查回归：较早阶段合法的停用保留时，仍能撤销最后一次误记
  const history = resume(stopSubscription(base, '2026-09-15', 'terminate', '2026-09-10'), '2026-10-01', {
    price: 30,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
  });
  const again = stopSubscription(history, '2026-11-07', 'terminate', '2026-11-07', 'mistake');
  assert.equal(statusChangeError(again, reactivate(again), '2026-11-07'), undefined);
  assert.equal(reactivate(again).phases![0].stop?.kind, 'terminate');
});

test('MCP 全部新增业务错误不写库', async () => {
  const f = fixture();
  const now = todayIn('UTC');
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'cancel', immediate: true, at: addDays(f.sub.start, -1) }, 'stopBeforeStart'],
      [{ action: 'terminate', at: addDays(billingPeriod(f.sub, now).paidThrough, 1) }, 'stopAfterPaidThrough'],
      [{ action: 'terminate', refund: { amount: 32 } }, 'refundExceedsPaid'],
      [{ action: 'cancel', immediate: true, refund: { amount: 1, currency: 'EUR' } }, 'refundCurrency'],
      [{ action: 'terminate', refund: { amount: 1, date: addDays(now, -1) } }, 'refundBeforeStop'],
      [{ action: 'terminate', refund: { amount: -1 } }, 'invalidRefund'],
    ];
    for (const [args, key] of cases) {
      await assert.rejects(() => f.run('set_status', args), {
        message: key === 'invalidRefund' ? t('mcp.error.invalidInput', { field: 'arguments.refund.amount' }) : t(`mcp.error.${key}`),
      });
      assert.equal(f.saved().stop, undefined);
    }
    await f.run('set_status', { action: 'terminate' });
    await assert.rejects(() => f.run('set_status', { action: 'terminate' }), { message: t('mcp.error.subscriptionEnded') });
    await assert.rejects(() => f.run('set_status', { action: 'cancel' }), { message: t('mcp.error.subscriptionEnded') });
    await assert.rejects(() => f.run('record_payment', { kind: 'refund', amount: 32 }), { message: t('mcp.error.refundExceedsPaid') });
    await assert.rejects(() => f.run('record_payment', { kind: 'refund', amount: 1, currency: 'EUR' }), { message: t('mcp.error.refundCurrency') });
    await f.run('record_payment', { kind: 'refund', amount: 10 });
    await assert.rejects(() => f.run('record_payment', { kind: 'refund', amount: 22 }), { message: t('mcp.error.refundExceedsPaid') });
  } finally {
    f.db.close();
  }
});

test('14 种语言都有停止状态、表单文案及全部新增错误，且占位符一致', () => {
  const load = (loc: string, ns: string) => JSON.parse(readFileSync(new URL(`./locales/${loc}/${ns}.json`, import.meta.url), 'utf8'));
  const enStop = load('en', 'core').stop;
  const enError = load('en', 'mcp').error;
  for (const { code } of LOCALES) {
    assert.ok(load(code, 'list').status.terminated);
    for (const [key, text] of Object.entries(enStop)) {
      const translated = load(code, 'core').stop[key];
      assert.equal(typeof translated, typeof text, `${code}: ${key}`);
      // 天数有 CLDR 复数形式：各语言类别可以不同，但每个形式都要保留占位符。
      const original = typeof text === 'string' ? text : (text as Record<string, string>).other;
      if (typeof translated !== 'string') assert.ok(translated.other, `${code}: ${key}.other`);
      for (const value of typeof translated === 'string' ? [translated] : Object.values(translated)) {
        assert.equal(typeof value, 'string', `${code}: ${key}`);
        assert.deepEqual((value as string).match(/\{\w+\}/g)?.sort(), original.match(/\{\w+\}/g)?.sort(), `${code}: ${key}`);
      }
    }
    for (const key of [
      'stopBeforeStart',
      'stopAfterPaidThrough',
      'refundExceedsPaid',
      'refundCurrency',
      'subscriptionEnded',
      'terminatedReactivate',
      'needStop',
      'invalidPaidThrough',
      'invalidStop',
      'invalidRefund',
      'refundBeforeStop',
    ])
      assert.ok(load(code, 'mcp').error[key] && enError[key]);
  }
});

test('月末实付与退款固化后仍保留 31 日锚点，年付与自定义周期折算正确', () => {
  const monthEnd = base({
    start: '2026-01-31',
    payments: [
      { date: '2026-01-31', amount: 31 },
      { date: '2026-02-28', amount: 31 },
    ],
  });
  assert.equal(billingPeriod(monthEnd, '2026-03-01').paidThrough, '2026-03-30');
  const stopped = stopSubscription(base({ start: '2026-01-31' }), '2026-02-15', 'cancel', '2026-02-15', undefined, { amount: 1 });
  const restored = reactivate(stopped);
  assert.deepEqual(
    chargesBetween(restored, '2026-02-16', '2026-04-30', '2026-02-15').map((c) => c.date),
    ['2026-02-28', '2026-03-31', '2026-04-30'],
  );
  const annual = stopSubscription(base({ price: 365, start: '2026-01-01', cycle: { unit: 'year', every: 1 } }), '2026-07-01', 'cancel');
  assert.equal(stopSummary(annual)!.suggestedRefund, 183);
  const custom = stopSubscription(base({ price: 20, cycle: { unit: 'day', every: 20 } }), today, 'terminate');
  assert.equal(stopSummary(custom)!.suggestedRefund, 5);
});

test('同一账期在停止前和停止后的退款合并校验', () => {
  const partial = savePayment(base(), today, { date: '2026-10-12', kind: 'refund', amount: -20 });
  assert.throws(() => stopSubscription(partial, today, 'cancel', today, undefined, { amount: 12 }), { message: t('mcp.error.refundExceedsPaid') });
});

test('试用期停止没有已付未用，停止后过期提醒也不发送', () => {
  const original = base({ status: 'trial', trialEnd: '2026-11-01', expires: '2026-10-20' });
  const s = stopSubscription(original, today, 'terminate');
  assert.equal(stopSummary(s)!.paid, 0);
  assert.equal(stopSummary(s)!.unusedValue, 0);
  assert.equal(nextCharge(s, today), undefined);
  assert.equal(buildDaily(state(s), '2026-10-19'), undefined);
});

test('MCP 新阶段重新订阅保留终止原因，退款可显式记入旧阶段', async () => {
  const f = fixture();
  try {
    const now = todayIn('UTC');
    await f.run('set_status', { action: 'terminate', reason: 'abuse' });
    await f.run('change_plan', { action: 'resume', at: addDays(now, 1), plan: { price: 10, currency: 'EUR', cycle: { unit: 'month', every: 1 } } });
    await f.run('record_payment', { kind: 'refund', amount: 5, date: addDays(now, 2), phase: f.sub.start, currency: 'USD' });
    assert.equal(f.saved().stop, undefined);
    assert.equal(f.saved().phases![0].stop!.reason, 'abuse');
    assert.equal(f.saved().phases![0].payments!.at(-1)!.amount, -5);
    assert.equal(f.saved().currency, 'EUR');
  } finally {
    f.db.close();
  }
});

test('API 编辑器保存复用停止与退款校验、禁止恢复停用订阅，公开 API 脱敏', async () => {
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
      return next(url, ctx);
    },
  });
  const { default: worker } = await import('../worker/index.ts');
  const f = fixture();
  f.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) f.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  const request = async (sub: Subscription, loc = 'en') =>
    worker.fetch(
      new Request('http://localhost/api/subscriptions/s', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-locale': loc },
        body: JSON.stringify(sub),
      }),
      { ...f.ctx.env, DEV_BYPASS_AUTH: '1' },
    );
  try {
    const now = todayIn('UTC');
    const s = stopSubscription(f.sub, now, 'terminate', now, 'PRIVATE', { amount: 3 });
    let response = await request(s);
    assert.equal(response.status, 200);
    response = await request({ ...s, status: 'cancelled', stop: { ...s.stop!, kind: 'cancel', reason: undefined } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, t('mcp.error.terminatedReactivate'));
    response = await request({ ...s, payments: [...s.payments!, { date: now, amount: -100, kind: 'refund' }] }, 'zh-CN');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '退款合计不能超过当期实付。');
    response = await request({ ...s, payments: [...s.payments!, { date: now, amount: -1, kind: 'refund', currency: 'EUR' }] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, t('mcp.error.refundCurrency'));
    response = await request({ ...s, stop: { ...s.stop!, date: addDays(f.sub.start, -1) } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, t('mcp.error.stopBeforeStart'));
    const resubscribed = resume(s, addDays(now, 1), { price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } });
    assert.equal((await request(resubscribed)).status, 200);
    const publicResponse = await worker.fetch(new Request('http://localhost/api/public'), { ...f.ctx.env, DEV_BYPASS_AUTH: '1' });
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    assert.ok(!publicText.includes('PRIVATE'));
    assert.ok(!publicText.includes('refund'));
    assert.ok(publicText.includes('terminate'));
  } finally {
    f.db.close();
    hook.deregister();
    setLocale('en', [messages]);
  }
});

test('MCP 新建订阅可带完整历史扣款：逐期金额即历史，之后按标价推算；越界日期拒绝，名称实体还原', async () => {
  const f = fixture();
  try {
    const today = todayIn('UTC');
    const start = addDays(today, -70);
    const payments = [
      { date: addDays(today, -10), amount: 21.5 },
      { date: start, amount: 29 },
      { date: addDays(today, -40), amount: 19 },
    ];
    const args = { name: 'AT&amp;T', price: 19, currency: 'USD', cycle: { unit: 'month', every: 1 }, start, payments };
    const preview = await f.run('create_subscription', { ...args, dry_run: true });
    assert.equal(preview.dry_run, true);
    const res = await f.run('create_subscription', args);
    const created = JSON.parse((f.db.prepare('SELECT data FROM subscriptions WHERE id = ?').get(res.subscription.id) as { data: string }).data) as Subscription;
    assert.equal(created.name, 'AT&T');
    assert.deepEqual(
      created.payments?.map((p) => [p.date, p.amount]),
      [...payments].sort((a, b) => a.date.localeCompare(b.date)).map((p) => [p.date, p.amount]),
    );
    // 历史只取记录的金额，不按标价补出没记录的期
    assert.deepEqual(
      chargesBetween(created, start, today, today).map((c) => c.amount),
      [29, 19, 21.5],
    );
    await assert.rejects(() => f.run('create_subscription', { ...args, name: 'Late', payments: [{ date: addDays(today, 1), amount: 5 }], dry_run: true }), {
      message: t('mcp.error.paymentOutOfRange', { date: addDays(today, 1) }),
    });
  } finally {
    f.db.close();
  }
});

test('MCP 合租：首期字段预览不写入、保存/备份保留、收款默认对齐且不回退已付至', async () => {
  const s = base({ id: 'collection', start: '2026-01-17', share: { role: 'owner', seats: 5, since: '2026-01-17', members: [] } });
  const f = fixture(s);
  try {
    f.ctx.overlay = new Map();
    const args = { id: 'jj', name: 'Test JJ', fee: 60, fee_currency: 'CNY', bill_every: 6, joined: '2026-10-20', first_period: 'prorate', first_amount: 21.5 };
    await f.run('save_share_member', { ...args, dry_run: true });
    assert.equal(f.saved().share!.members.length, 0);
    assert.equal(f.ctx.overlay.get(s.id)!.share!.members[0].firstAmount, 21.5);
    f.ctx.overlay.clear();
    await f.run('save_share_member', args);
    f.ctx.overlay.clear();
    assert.equal(f.saved().share!.collectFrom, '2026-01-17');
    assert.equal(f.saved().share!.members[0].firstPeriod, 'prorate');
    assert.equal(f.saved().share!.members[0].firstAmount, 21.5);
    await f.run('save_share_member', { member: 'jj', first_period: 'prorate' });
    assert.equal(f.saved().share!.members[0].firstAmount, 21.5);
    await assert.rejects(f.run('save_share_member', { member: 'jj', first_amount: -1 }));
    await assert.rejects(f.run('save_share_member', { member: 'jj', first_period: 'invalid' }));
    await f.run('record_receivable', { kind: 'share', member: 'jj', currency: 'CNY', amount: 21.5, date: '2026-10-22', dry_run: true });
    assert.equal(f.saved().share!.members[0].receipts, undefined);
    assert.deepEqual(f.ctx.overlay.get(s.id)!.share!.members[0].receipts![0].periods, ['2026-10-20']);
    f.ctx.overlay.clear();
    await f.run('record_receivable', { kind: 'share', member: 'jj', currency: 'CNY', amount: 21.5, date: '2026-10-22' });
    const { id: _id, ...first } = f.saved().share!.members[0].receipts![0];
    assert.deepEqual(first, { date: '2026-10-22', amount: 21.5, currency: 'CNY', periods: ['2026-10-20'] });
    const second = await f.run('record_receivable', { kind: 'share', member: 'jj', currency: 'CNY', amount: 60, date: '2027-01-17' });
    assert.deepEqual(second.after.periods, ['2027-01-17']);
    assert.equal(second.member.paid_until, '2027-07-16');
    // 同一期不能再记一次
    await assert.rejects(f.run('record_receivable', { kind: 'share', member: 'jj', currency: 'CNY', amount: 0, periods: ['2026-10-20'] }));
    assert.equal(f.saved().share!.members[0].receipts!.length, 2);
    await f.run('set_share', { role: 'owner', collect_from: '2026-01-31', dry_run: true });
    assert.equal(f.saved().share!.collectFrom, '2026-01-17');
    assert.equal(f.ctx.overlay.get(s.id)!.share!.collectFrom, '2026-01-31');
    f.ctx.overlay.clear();
    await f.run('set_share', { role: 'owner' });
    assert.equal(f.saved().share!.collectFrom, '2026-01-17');
    const backup = await exportAll(f.ctx.env);
    assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(backup))).subscriptions[0].share, f.saved().share);
  } finally {
    f.db.close();
  }
});

test('合租新字段经 Worker API 保存、重读；拒绝非法首期金额与起点', async () => {
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
      return next(url, ctx);
    },
  });
  const { default: worker } = await import('../worker/index.ts');
  const f = fixture();
  f.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) f.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  const env = { ...f.ctx.env, DEV_BYPASS_AUTH: '1' };
  const s = {
    ...f.sub,
    share: {
      role: 'owner' as const,
      seats: 3,
      collectFrom: '2026-01-17',
      members: [{ id: 'jj', name: 'Fictional member', share: 10, fee: 60, billEvery: 6, joined: '2026-10-20', firstPeriod: 'full' as const, firstAmount: 20 }],
    },
  };
  const put = (sub: Subscription) =>
    worker.fetch(
      new Request('http://localhost/api/subscriptions/s', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) }),
      env,
    );
  try {
    assert.equal((await put(s)).status, 200);
    const response = await worker.fetch(new Request('http://localhost/api/state'), env);
    const st = (await response.json()) as AppState;
    assert.deepEqual(st.subscriptions[0].share, f.saved().share);
    assert.equal(st.subscriptions[0].share!.members[0].firstAmount, 20);
    assert.equal((await put({ ...s, share: { ...s.share, collectFrom: '2026-02-30' } })).status, 400);
    assert.equal((await put({ ...s, share: { ...s.share, members: [{ ...s.share.members[0], firstAmount: -1 }] } })).status, 400);
    assert.equal(f.saved().share!.members[0].firstAmount, 20);
  } finally {
    f.db.close();
    hook.deregister();
  }
});

describe('MCP 合租统一收款与首期', () => {
  beforeEach((t) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00Z') }));
  const owned = (members: NonNullable<Subscription['share']>['members'] = []) =>
    base({ start: '2026-01-17', share: { role: 'owner', seats: 5, since: '2026-01-17', members } });
  const args = { id: 'jj', name: 'Fictional JJ', fee: 60, fee_currency: 'CNY', bill_every: 6, joined: '2026-10-20' };

  test('中途加入预览：默认按天、整期、免费和覆盖金额；草稿可查但不写库', async () => {
    for (const [extra, amount, next] of [
      [{}, 29.02, '2026-10-20'],
      [{ first_period: 'full' }, 60, '2026-10-20'],
      [{ first_period: 'free', first_amount: 20 }, 0, '2027-01-17'],
      [{ first_amount: 21.5 }, 21.5, '2026-10-20'],
    ] as const) {
      const f = fixture(owned());
      f.ctx.overlay = new Map();
      try {
        const preview = await f.run('save_share_member', { ...args, ...extra, dry_run: true });
        assert.equal(preview.dry_run, true);
        assert.equal(preview.member.collect_from, '2026-01-17');
        assert.deepEqual(preview.member.first_collection, {
          from: '2026-10-20',
          until: '2027-01-16',
          next: '2027-01-17',
          amount,
          currency: 'CNY',
          partial: true,
        });
        assert.equal(preview.member.next_collection_date, next);
        assert.equal(preview.member.is_first_period, extra.first_period !== 'free');
        assert.equal(preview.member.pending_amount.amount, amount);
        const plan = (await f.run('get_carpool')).plans[0];
        assert.equal(plan.collect_from, '2026-01-17');
        assert.equal(plan.members[0].next_collection_date, next);
        assert.equal(plan.members[0].fee.every_months, 6);
        assert.deepEqual(plan.members[0].first_collection, preview.member.first_collection);
        assert.deepEqual(f.saved().share!.members, []);
      } finally {
        f.db.close();
      }
    }
  });

  test('收款默认首期区间和金额：预览不落库，保存后返回已付至与下一次收款', async () => {
    const f = fixture(owned());
    try {
      await f.run('save_share_member', args);
      await f.run('get_carpool');
      const before = f.saved();
      const preview = await f.run('record_receivable', { member: 'jj', dry_run: true });
      const { id: _id, ...receipt } = preview.after;
      assert.deepEqual(receipt, { date: '2026-10-22', periods: ['2026-10-20'], amount: 29.02, currency: 'CNY' });
      assert.equal(preview.member.paid_until, '2027-01-16');
      assert.equal(preview.member.next_collection_date, '2027-01-17');
      assert.equal(preview.member.is_first_period, false);
      assert.deepEqual(f.saved(), before);
      const saved = await f.run('record_receivable', { member: 'jj' });
      assert.deepEqual({ ...saved.after, id: undefined }, { ...preview.after, id: undefined });
      assert.equal(f.saved().share!.members[0].receipts![0].amount, 29.02);
      const member = (await f.run('get_carpool')).plans[0].members[0];
      assert.equal(member.paid_until, '2027-01-16');
      assert.equal(member.next_collection_date, '2027-01-17');
      assert.equal(member.next_collection.amount, 60);
      assert.equal(member.pending_amount.amount, 0);
      assert.equal(member.pending_amount.currency, 'CNY');
      assert.equal(member.owed, null); // 兼容旧返回字段。
      const second = await f.run('record_receivable', { member: 'jj', date: '2027-01-18' });
      assert.deepEqual(second.after.periods, ['2027-01-17']);
      assert.equal(second.after.amount, 60);
      assert.equal(second.member.next_collection_date, '2027-07-17');
    } finally {
      f.db.close();
    }
  });

  test('待收包含逾期首期和当期；迟收仍从最早未付区间开始', async (t) => {
    t.mock.timers.setTime(Date.parse('2027-01-17T12:00:00Z'));
    const f = fixture(owned());
    try {
      await f.run('save_share_member', args);
      let member = (await f.run('get_carpool')).plans[0].members[0];
      assert.equal(member.pending_amount.amount, 89.02);
      assert.equal(member.next_collection_date, '2026-10-20');
      assert.equal(member.is_first_period, true);
      const receipt = await f.run('record_receivable', { member: 'jj' });
      assert.equal(receipt.after.amount, 29.02);
      assert.deepEqual(receipt.after.periods, ['2026-10-20']);
      member = (await f.run('get_carpool')).plans[0].members[0];
      assert.equal(member.pending_amount.amount, 60);
      assert.equal(member.next_collection_date, '2027-01-17');
    } finally {
      f.db.close();
    }
  });

  test('实际金额可不同或为零，币种缺省同应收；可以跳过中间的期先收后面的期，已付至只算连续结清的部分', async () => {
    const f = fixture(owned());
    try {
      await f.run('save_share_member', args);
      const first = await f.run('record_receivable', { member: 'jj', amount: 12.34 });
      assert.equal(first.after.amount, 12.34);
      assert.equal(first.after.currency, 'CNY');
      assert.deepEqual(first.after.periods, ['2026-10-20']);
      const second = await f.run('record_receivable', { member: 'jj', amount: 0, currency: 'CNY' });
      assert.equal(second.after.amount, 0);
      assert.equal(second.member.paid_until, '2027-07-16');
      // 跳过 2027-07-17 那期，先收 2028-01-17 那期：已付至不变，下一次收款仍是没收的那期
      const skip = await f.run('record_receivable', { member: 'jj', amount: 60, periods: ['2028-01-17'] });
      assert.equal(skip.member.paid_until, '2027-07-16');
      assert.equal(skip.member.next_collection_date, '2027-07-17');
      // 免收那期之后，已付至接上
      const waived = await f.run('record_receivable', { member: 'jj', action: 'waive', periods: ['2027-07-17'] });
      assert.equal(waived.member.paid_until, '2028-07-16');
      // 删掉免收，那期恢复为没收
      const undone = await f.run('record_receivable', { member: 'jj', action: 'delete', id: waived.after.id });
      assert.equal(undone.member.paid_until, '2027-07-16');
      // 改一笔收款：金额改了，抵扣的期不变
      const edited = await f.run('record_receivable', { member: 'jj', action: 'update', id: skip.after.id, amount: 55 });
      assert.deepEqual([edited.after.amount, edited.after.periods], [55, ['2028-01-17']]);
      assert.equal(f.saved().share!.members[0].receipts!.length, 3);
    } finally {
      f.db.close();
    }
  });

  test('免费首期跳过；省略金额可按指定币种换算，缺失汇率不记零元', async () => {
    const f = fixture(owned());
    try {
      await f.run('save_share_member', { ...args, first_period: 'free' });
      const preview = await f.run('record_receivable', { member: 'jj', dry_run: true, currency: 'USD' });
      assert.deepEqual(preview.after.periods, ['2027-01-17']);
      assert.equal(preview.after.amount, 8.43);
      assert.equal(preview.after.currency, 'USD');
      await assert.rejects(f.run('record_receivable', { member: 'jj', currency: 'XYZ' }));
      assert.equal(f.saved().share!.members[0].receipts, undefined);
      assert.equal((await f.run('record_receivable', { member: 'jj' })).after.amount, 60);
    } finally {
      f.db.close();
    }
  });

  test('旧数据（已付至 + 按覆盖期的收款）读出时转成按期：基准日按旧规则写死、收款对上那一期，查询不补写', async () => {
    const s = owned([
      {
        id: 'old',
        name: 'Legacy',
        share: 10,
        paidUntil: '2026-10-16',
        payments: [{ date: '2026-09-17', from: '2026-09-17', until: '2026-10-16', amount: 10, currency: 'USD' }],
      },
    ]);
    delete s.share!.since;
    const f = fixture(s);
    try {
      await f.run('get_carpool'); // 首次读取可能关联旧成员到联系人；以关联后的存储作基线。
      const before = f.saved();
      const plan = (await f.run('get_carpool')).plans[0];
      assert.equal(plan.collect_from, '2026-09-17');
      assert.equal(plan.members[0].fee.every_months, 1);
      assert.equal(plan.members[0].paid_until, '2026-10-16');
      assert.equal(plan.members[0].next_collection_date, '2026-10-17');
      assert.equal(plan.members[0].pending_amount.amount, 10);
      assert.equal(plan.members[0].is_first_period, false);
      assert.deepEqual(f.saved(), before);
      const preview = await f.run('set_share', { role: 'owner', dry_run: true });
      assert.equal(preview.collect_from, '2026-09-17');
      assert.equal(f.saved().share!.collectFrom, undefined);
      // 读出来已经是按期记账：期初结清 1 至 8 月、9 月那期对上旧收款
      const legacy = plan.members[0];
      assert.equal(legacy.receipts, 2);
      const set = await f.run('set_share', { role: 'owner', collect_from: '2026-01-31', dry_run: true });
      assert.equal(set.collect_from, '2026-01-31');
      assert.deepEqual(f.saved(), before);
      await f.run('set_share', { role: 'owner', collect_from: '2026-01-31' });
      assert.equal((await f.run('get_carpool')).plans[0].collect_from, '2026-01-31');
      // 改了基准日，期重新切过；旧收款按落在哪一期对上，不会变成欠款
      const received = await f.run('record_receivable', { kind: 'share', member: 'old', amount: 9, currency: 'USD' });
      assert.equal(received.member.paid_until, '2026-10-30');
      const history = f.saved().share!.members[0].receipts!;
      assert.deepEqual(
        history.map((r) => [r.amount, r.opening ?? false]),
        [
          [0, true],
          [10, false],
          [9, false],
        ],
      );
      await f.run('remove_share_member', { member: 'old', dry_run: true });
      assert.equal(f.saved().share!.members.length, 1);
      await f.run('remove_share_member', { member: 'old' });
      assert.equal(f.saved().share!.members.length, 0);
      assert.equal(f.saved().share!.collectFrom, '2026-01-31');
    } finally {
      f.db.close();
    }
  });

  test('旧数据只有已付至、没有覆盖记录或周期，也能推断统一日与默认下一笔', async () => {
    const s = owned([{ id: 'old', name: 'Legacy', share: 10, paidUntil: '2026-10-16' }]);
    delete s.share!.since;
    const f = fixture(s);
    try {
      const plan = (await f.run('get_carpool')).plans[0];
      assert.equal(plan.collect_from, '2026-09-17');
      assert.equal(plan.members[0].pending_amount.amount, 10);
      const saved = await f.run('record_receivable', { member: 'old' });
      assert.deepEqual(saved.after.periods, ['2026-10-17']);
      assert.equal(saved.after.amount, 10);
      assert.equal(saved.after.currency, 'USD');
      assert.equal(saved.member.next_collection_date, '2026-11-17');
      assert.equal(f.saved().share!.collectFrom, '2026-09-17');
    } finally {
      f.db.close();
    }
  });

  test('Worker /mcp：无令牌拒绝，只读隐藏且拒绝全部写工具，读写预览和默认收款可执行', async () => {
    const { registerHooks } = await import('node:module');
    const hook = registerHooks({
      load(url, ctx, next) {
        if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
        return next(url, ctx);
      },
    });
    const { default: worker } = await import('../worker/index.ts');
    const { createToken } = await import('../worker/ai/mcp.ts');
    const f = fixture(owned());
    f.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    for (const m of MIGRATIONS) f.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
    const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
      const response = await worker.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        f.ctx.env,
      );
      return { status: response.status, body: await response.json() };
    };
    try {
      const read = (await createToken(f.ctx.env, 'Fictional read', 'read')).token;
      const write = (await createToken(f.ctx.env, 'Fictional write', 'write')).token;
      assert.equal((await rpc('', 'tools/list')).status, 401);
      const list = await rpc(read, 'tools/list');
      assert.equal(list.status, 200);
      assert.ok(list.body.result.tools.some((x: { name: string }) => x.name === 'get_carpool'));
      for (const name of ['set_share', 'save_share_member', 'remove_share_member', 'record_receivable']) {
        assert.ok(!list.body.result.tools.some((x: { name: string }) => x.name === name));
        for (const dry_run of [false, true]) {
          const denied = await rpc(read, 'tools/call', { name, arguments: { subscription: f.sub.id, ...args, dry_run } });
          assert.equal(denied.body.result.isError, true);
        }
      }
      assert.equal(f.saved().share!.members.length, 0);
      const preview = await rpc(write, 'tools/call', { name: 'save_share_member', arguments: { subscription: f.sub.id, ...args, dry_run: true } });
      assert.equal(preview.body.result.structuredContent.member.first_collection.amount, 29.02);
      assert.equal(f.saved().share!.members.length, 0);
      await rpc(write, 'tools/call', { name: 'save_share_member', arguments: { subscription: f.sub.id, ...args } });
      const readback = await rpc(read, 'tools/call', { name: 'get_carpool', arguments: { subscription: f.sub.id } });
      assert.equal(readback.body.result.structuredContent.plans[0].members[0].pending_amount.amount, 29.02);
      const paymentArgs = { subscription: f.sub.id, member: 'jj' };
      const receiptPreview = await rpc(write, 'tools/call', { name: 'record_receivable', arguments: { ...paymentArgs, dry_run: true } });
      assert.equal(receiptPreview.body.result.structuredContent.after.amount, 29.02);
      assert.equal(f.saved().share!.members[0].receipts, undefined);
      const receipt = await rpc(write, 'tools/call', { name: 'record_receivable', arguments: paymentArgs });
      assert.equal(receipt.body.result.structuredContent.member.next_collection_date, '2027-01-17');
      assert.equal(f.saved().share!.members[0].receipts![0].amount, 29.02);
      const tools = (await rpc(write, 'tools/list')).body.result.tools;
      const schema = tools.find((x: { name: string }) => x.name === 'record_receivable').inputSchema;
      assert.ok(!schema.required.includes('amount'));
    } finally {
      f.db.close();
      hook.deregister();
      setLocale('en', [messages]);
    }
  });

  test('助手多步草稿共享首期状态，确认参数固定默认收款；确认前不写入', async (t) => {
    const { chat, apply } = await import('../worker/ai/assistant.ts');
    const f = fixture(owned());
    f.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
      .run('assistant', JSON.stringify({ apiKey: 'fictional', baseUrl: 'https://fictional.invalid/v1' }));
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      assert.ok(request.messages[0].content.includes('first_period defaults to prorate'));
      assert.ok(request.messages[0].content.includes('get_carpool results, never mental arithmetic'));
      if (calls++ === 0) {
        const tool_calls = [
          { index: 0, id: 'add', type: 'function', function: { name: 'save_share_member', arguments: JSON.stringify({ subscription: f.sub.id, ...args }) } },
          {
            index: 1,
            id: 'receive',
            type: 'function',
            function: { name: 'record_receivable', arguments: JSON.stringify({ subscription: f.sub.id, member: 'jj' }) },
          },
          { index: 2, id: 'read', type: 'function', function: { name: 'get_carpool', arguments: JSON.stringify({ subscription: f.sub.id }) } },
        ];
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\ndata: [DONE]\n\n`);
      }
      const results = request.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => JSON.parse(m.content));
      assert.equal(results[1].preview.after.amount, 29.02);
      assert.equal(results[2].plans[0].members[0].next_collection_date, '2027-01-17');
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Drafts ready.' } }] })}\n\ndata: [DONE]\n\n`);
    });
    try {
      const response = chat(f.ctx.env, { text: 'Add Fictional JJ and record their first payment.' }, new AbortController().signal);
      const events = (await response.text())
        .split('\n')
        .filter((s) => s.startsWith('data: '))
        .map((s) => JSON.parse(s.slice(6)));
      assert.equal(calls, 2);
      assert.ok(!events.some((e) => e.type === 'error' || e.status === 'error'));
      const proposals = events.filter((e) => e.type === 'proposal');
      assert.equal(proposals.length, 2);
      assert.equal(proposals[1].args.amount, 29.02);
      assert.equal(proposals[1].args.currency, 'CNY');
      assert.deepEqual(proposals[1].args.periods, ['2026-10-20']);
      assert.equal(f.saved().share!.members.length, 0);
      for (const proposal of proposals) await apply(f.ctx.env, { tool: proposal.tool, args: proposal.args });
      assert.deepEqual(f.saved().share!.members[0].receipts![0].periods, ['2026-10-20']);
      assert.equal(f.saved().share!.members[0].receipts![0].amount, 29.02);
    } finally {
      f.db.close();
    }
  });
});

test('MCP set_status keeps rejecting new stops on an expired nonrenewal after full-editor corrections are allowed', async () => {
  const now = todayIn('UTC');
  const original = base({ start: addDays(now, -14), status: 'cancelled', end: addDays(now, -1) });
  const f = fixture(original);
  try {
    for (const action of ['cancel', 'terminate'] as const) {
      for (const dry_run of [false, true]) {
        await assert.rejects(() => f.run('set_status', { action, immediate: true, dry_run }), { message: t('mcp.error.subscriptionEnded') });
        assert.deepEqual(f.saved(), original);
      }
    }
  } finally {
    f.db.close();
  }
});

test('MCP 成员生效日调价：预览、保存、备份、默认收款和独立到期日共用标准', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00Z') });
  const old = {
    id: 'm',
    name: 'Fictional Price',
    share: 6.67,
    fee: 40,
    feeCurrency: 'CNY',
    billEvery: 6,
    joined: '2025-10-14',
    // 已收前两期（2025-10-14、2026-04-14 起）
    receipts: [{ id: 'r1', date: '2026-01-17', amount: 80, currency: 'CNY', periods: ['2025-10-14', '2026-04-14'] }],
  };
  const f = fixture(base({ start: '2025-10-14', share: { role: 'owner', seats: 6, collectFrom: '2025-10-14', members: [old] } }));
  f.ctx.overlay = new Map();
  try {
    const patch = { member: 'm', fee: 44, fee_from: '2026-07-01' };
    const preview = await f.run('save_share_member', { ...patch, dry_run: true });
    assert.equal(preview.member.next_collection.amount, 44);
    assert.equal(preview.member.next_collection.until, '2027-04-13');
    assert.equal(f.saved().share!.members[0].fee, 40);
    f.ctx.overlay.clear();
    await f.run('save_share_member', patch);
    const member = f.saved().share!.members[0];
    assert.equal(member.feeHistory!.length, 2);
    assert.deepEqual(member.receipts, old.receipts);
    const draft = await f.run('record_receivable', { member: 'm', dry_run: true });
    assert.deepEqual([draft.after.amount, draft.after.currency, draft.after.periods], [44, 'CNY', ['2026-10-14']]);
    assert.equal(f.saved().share!.members[0].receipts!.length, 1);
    f.ctx.overlay.clear();
    const saved = await f.run('record_receivable', { member: 'm' });
    assert.equal(saved.member.next_collection_date, '2027-04-14');
    const backup = parseBackup(JSON.parse(JSON.stringify(await exportAll(f.ctx.env))));
    assert.deepEqual(backup.subscriptions[0].share, f.saved().share);
    await f.run('save_share_member', { member: 'm', fee: 48 }); // no effective date means today
    assert.equal(f.saved().share!.members[0].feeHistory!.at(-1)!.from, '2026-10-22');
    const next = await f.run('record_receivable', { member: 'm', currency: 'USD', dry_run: true });
    near(next.after.amount, 48 / FALLBACK_FX.rates.CNY);
    assert.deepEqual(next.after.periods, ['2027-04-14']);
    await assert.rejects(f.run('save_share_member', { member: 'm', fee: 20, fee_from: '2026-02-30' }));
  } finally {
    f.db.close();
  }
});

test('duplicate check skips deliberate multi-account subscriptions and names the group once', () => {
  const sub = (id: string, account?: string) => base({ id, name: `Claude Pro · ${id}`, account, start: '2026-09-01' });
  const st = (subs: Subscription[]): AppState => ({ subscriptions: subs, methods: [], settings: { ...DEFAULT_SETTINGS }, fx: FALLBACK_FX });
  const dups = (subs: Subscription[]) => insights(st(subs), today).filter((i) => i.id.startsWith('dup-'));
  assert.equal(dups([sub('01', 'a@example.com'), sub('02', 'b@example.com'), sub('03', 'c@example.com')]).length, 0);
  const same = dups([sub('01', 'A@example.com'), sub('02', 'a@example.com '), sub('03', 'b@example.com')]);
  assert.equal(same.length, 1);
  assert.equal(same[0].subs!.length, 2);
  assert.ok(same[0].title.startsWith('Claude Pro '), same[0].title);
  assert.ok(!same[0].title.includes('· 01'), same[0].title);
  assert.equal(dups([sub('01'), sub('02')]).length, 1);
});

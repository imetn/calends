import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  addDays,
  addMonths,
  billingPeriod,
  chargesBetween,
  effectiveStatus,
  memberDues,
  monthlyGross,
  nextCharge,
  overdueBills,
  servedTime,
  stopSummary,
  subError,
  todayIn,
  totals,
} from './billing.ts';
import { PUBLIC_BOTTOM_SECTIONS, PUBLIC_GRID_SECTIONS, type PublicGridId } from './public-layout.ts';
import {
  allChildrenOf,
  availActiveDays,
  availCoversDay,
  bundleError,
  bundleLinkError,
  bundleSource,
  bundleView,
  childrenOf,
  displayCycle,
  hasFinancialHistory,
  isFreeBundlePhase,
  linkableParents,
  parentAvailability,
  publicBundleAvail,
  resolveState,
} from './bundle.ts';
import { carLedger, carYear, carpoolYear, memberStatus } from './carpool.ts';
import { contractEvents } from './contract.ts';
import { yearsTimeline } from './gantt.ts';
import { inListScope, listHaystack } from './list-scope.ts';
import { maskForPublic } from './mask.ts';
import { meterRows, meterView } from './meters.ts';
import { cancelSavings, cashVsAccrual, contributionOn, events, insights, mrrOn, prepaidValue, stopHistory, stopLosses } from './metrics.ts';
import { netCost } from './transfers.ts';
import { peopleLedger } from './people.ts';
import { editPhase, movePhaseStart, savePayment, stopSubscription, switchPlan, syncPhase, toEditForm, upgradePlan, upgradeQuote } from './phases.ts';
import { receivableOf } from './receivable-edit.ts';
import { scopeReport, subscriptionTenure } from './scope-report.ts';
import { applyStopForm, editStop, stopForm, stopPreview } from './stop-form.ts';
import { prepareSubWrite } from './sub-write.ts';
import { DEFAULT_SETTINGS, type AppState, type Payment, type Subscription } from './types.ts';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import type { Env } from '../worker/env.ts';
import { TOOLS } from '../worker/ai/mcp-tools.ts';
import type { ToolCtx } from '../worker/ai/tool-kit.ts';
import { confirmationArgs } from '../worker/ai/assistant.ts';
import { buildIcs } from '../worker/ics.ts';
import { buildDaily, buildMonthly } from '../worker/notify.ts';

const hook = registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');
const { applyLocale } = await import('../worker/i18n.ts');
applyLocale('en');
hook.deregister();

const FX = { base: 'USD', updatedAt: '2026-01-01', rates: { USD: 1, CNY: 7 } };

const mkSub = (extra: Partial<Subscription> & { id: string; name: string }): Subscription => ({
  category: 'ai',
  tags: [],
  price: 20,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-01',
  status: 'active',
  ...extra,
});

const mkState = (subs: Subscription[], extra: Partial<AppState> = {}): AppState => ({
  subscriptions: subs,
  methods: [{ id: 'card', name: 'Visa', currency: 'USD', kind: 'credit' }],
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', defaultMethodId: 'card', publicView: true },
  fx: FX,
  fxHistory: {},
  ...extra,
});

function dbFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  }
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const execSync = () => {
      const query = db.prepare(sql);
      if (query.columns().length) return { results: query.all(...args) };
      return { results: [], meta: { changes: Number(query.run(...args).changes) } };
    };
    const stmt = {
      sql,
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
        return execSync();
      },
      execSync,
    };
    return stmt;
  };
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        // Real D1 and docker/d1.mjs execute one batch synchronously inside a single SQLite transaction lock
        db.exec('BEGIN');
        try {
          const results = stmts.map((stmt) => stmt.execSync());
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    DEV_BYPASS_AUTH: '1',
    BASE_PATH: '/ledger',
  } as unknown as Env;
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    worker.fetch(
      new Request(`https://example.test/ledger/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      auth ? env : { ...env, DEV_BYPASS_AUTH: undefined },
    );
  const runTool = async (name: string, args: Record<string, unknown>, ctx: Partial<ToolCtx> = {}) => {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} exists`);
    return tool.run(args, { env, scope: 'write', ...ctx });
  };
  return { db, env, request, runTool };
}

// ---------- 1. Core Google AI Ultra + YouTube Premium + Paid & Independent Add-ons ----------

test('free bundled perk follows parent with zero inferred charges and tracks parent cycle', () => {
  const ultra = mkSub({
    id: 'ultra',
    name: 'Google AI Ultra 30TB',
    price: 249.99,
    start: '2026-01-15',
    methodId: 'card',
  });
  const yt = mkSub({
    id: 'yt',
    name: 'YouTube Premium',
    category: 'media',
    price: 0,
    start: '2026-01-15',
    bundle: { parentId: 'ultra' },
  });
  const subs = [ultra, yt];
  const view = bundleView(yt, subs);

  assert.equal(isFreeBundlePhase(view), true);
  assert.equal(effectiveStatus(view, '2026-03-20'), 'active');
  assert.deepEqual(chargesBetween(view, '2026-01-01', '2026-12-31', '2026-03-20'), []);
  assert.equal(nextCharge(view, '2026-03-20'), undefined);
  assert.equal(monthlyGross(view, '2026-03-20'), 0);
  assert.deepEqual(displayCycle(view, '2026-03-20'), { unit: 'month', every: 1 });
  assert.equal(hasFinancialHistory(yt, []), false);

  const st = mkState(subs);
  assert.equal(contributionOn(st, yt, '2026-03-20'), 0);
  assert.equal(Math.round(mrrOn(st, '2026-03-20') * 100) / 100, 249.99);
});

test('discounted follow-parent add-on bills during parent availability and pauses/ends with parent', () => {
  const parent = mkSub({
    id: 'parent',
    name: 'Cloud Bundle',
    price: 30,
    start: '2026-01-01',
    pauses: [{ from: '2026-03-01', to: '2026-04-01' }],
    status: 'paused',
    pausedAt: '2026-06-01',
  });
  const addon = mkSub({
    id: 'addon',
    name: 'Discounted Music',
    price: 4.99,
    start: '2026-01-01',
    bundle: { parentId: 'parent', follow: true },
  });
  const indep = mkSub({
    id: 'indep',
    name: 'Independent Add-on',
    price: 2.99,
    cycle: { unit: 'year', every: 1 },
    start: '2026-01-01',
    bundle: { parentId: 'parent', follow: false },
  });

  const subs = [parent, addon, indep];
  const addonView = bundleView(addon, subs);
  const indepView = bundleView(indep, subs);

  assert.equal(effectiveStatus(addonView, '2026-02-15'), 'active');
  assert.equal(effectiveStatus(addonView, '2026-03-15'), 'paused');
  assert.equal(effectiveStatus(addonView, '2026-05-15'), 'active');
  assert.equal(effectiveStatus(addonView, '2026-06-15'), 'paused');
  assert.deepEqual(
    chargesBetween(addonView, '2026-01-01', '2026-07-31', '2026-06-15').map((c) => c.date),
    ['2026-01-01', '2026-02-01', '2026-04-01', '2026-05-01'],
  );
  assert.equal(nextCharge(addonView, '2026-06-15'), undefined);

  // Independent child keeps running regardless of parent pause
  assert.equal(indepView.bundleAvail, undefined);
  assert.equal(effectiveStatus(indepView, '2026-06-15'), 'active');
  assert.equal(nextCharge(indepView, '2026-06-15'), '2027-01-01');
});

// ---------- 2. Financial History Preservation ----------

test('preserves month-end/leap-day anchors, early payments, delayed refunds, duplicates, split funding, and explicit $0 payments', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 100,
    start: '2024-01-31',
    pauses: [{ from: '2024-03-15', to: '2024-04-15' }],
  });
  // Month-end + leap-day anchor stays intact across parent pause (Jan 31 -> Feb 29 -> Mar 31 skipped -> Apr 30 -> May 31)
  const monthEndAddon = mkSub({
    id: 'me',
    name: 'Month-end Anchor Add-on',
    price: 10,
    start: '2024-01-31',
    bundle: { parentId: 'p', follow: true },
  });
  assert.deepEqual(
    chargesBetween(bundleView(monthEndAddon, [parent, monthEndAddon]), '2024-01-01', '2024-06-15', '2024-06-15').map((c) => c.date),
    ['2024-01-31', '2024-02-29', '2024-04-30', '2024-05-31'],
  );

  // Explicit payments: duplicate same-day, split funding, early payment, delayed refund during parent pause are ALL preserved
  const payments: Payment[] = [
    {
      date: '2024-01-31',
      amount: 10,
      currency: 'USD',
      funding: [
        { methodId: 'card', amount: 6 },
        { methodId: 'cash', amount: 4 },
      ],
    },
    { date: '2024-01-31', amount: 2, currency: 'USD', note: 'same-day duplicate' },
    { date: '2024-02-28', amount: 10, currency: 'USD', note: 'early payment for Feb 29' },
    { date: '2024-04-05', amount: -5, currency: 'USD', kind: 'refund', note: 'delayed refund during parent pause' },
  ];
  const addon = mkSub({
    id: 'a',
    name: 'Recorded History Add-on',
    price: 10,
    start: '2024-01-31',
    payments,
    bundle: { parentId: 'p', follow: true },
  });
  const view = bundleView(addon, [parent, addon]);
  const charges = chargesBetween(view, '2024-01-01', '2024-06-15', '2024-06-15');
  assert.deepEqual(
    charges.map((c) => [c.date, c.amount, c.kind ?? 'charge']),
    [
      ['2024-01-31', 10, 'charge'],
      ['2024-01-31', 2, 'charge'],
      ['2024-02-28', 10, 'charge'],
      ['2024-04-05', -5, 'refund'],
      ['2024-04-28', 10, 'charge'],
      ['2024-05-28', 10, 'charge'],
    ],
  );
  assert.deepEqual(charges[0].funding, [
    { methodId: 'card', amount: 6 },
    { methodId: 'cash', amount: 4 },
  ]);

  // Explicit recorded payment on a $0 bundled phase still counts in charges, billingPeriod().paid, and hasFinancialHistory
  const freeWithExplicit = mkSub({
    id: 'f',
    name: 'Free with Explicit Fee',
    price: 0,
    start: '2026-01-01',
    payments: [{ date: '2026-01-01', amount: 5, currency: 'USD' }],
    bundle: { parentId: 'p' },
  });
  const fView = bundleView(freeWithExplicit, [parent, freeWithExplicit]);
  const fCharges = chargesBetween(fView, '2026-01-01', '2026-03-31', '2026-02-10');
  assert.equal(fCharges.length, 1);
  assert.equal(fCharges[0].amount, 5);
  assert.equal(hasFinancialHistory(freeWithExplicit, fCharges), true);
  assert.equal(billingPeriod(fView, '2026-01-15').paid, 5);
});

// ---------- 3. Parent Availability Edge Cases ----------

test('parentAvailability merges overlapping phases, subtracts Stop.pausedAt only when uncovered, tracks cycle switches, undated stop, and lifetime', () => {
  // Overlapping parent phases: Jan-Dec + Jul-Sep (where phase 1 had Stop.pausedAt Aug 10..Aug 20, covered by phase 2!)
  const parent = mkSub({
    id: 'p1',
    name: 'Overlapping Parent',
    price: 20,
    start: '2026-01-01',
    phases: [
      {
        start: '2026-01-01',
        end: '2026-08-20',
        price: 20,
        currency: 'USD',
        cycle: { unit: 'month', every: 1 },
        stop: { kind: 'cancel', date: '2026-08-20', pausedAt: '2026-08-10' },
      },
      {
        start: '2026-07-01',
        end: '2026-12-31',
        price: 200,
        currency: 'USD',
        cycle: { unit: 'year', every: 1 },
      },
    ],
  });
  const avail = parentAvailability(parent);
  assert.deepEqual(avail.spans, [{ from: '2026-01-01', to: '2026-12-31' }]);
  assert.equal(avail.pauses.length, 0, 'phase 2 covers Aug 10-20 so pause is subtracted');
  assert.equal(availCoversDay(avail, '2026-08-15'), true);

  // Stop.pausedAt NOT covered by any other phase IS preserved in pauses
  const pausedStopParent = mkSub({
    id: 'p2',
    name: 'Paused Stop Parent',
    price: 20,
    start: '2026-01-01',
    end: '2026-04-01',
    stop: { kind: 'cancel', date: '2026-04-01', pausedAt: '2026-03-10' },
  });
  const avail2 = parentAvailability(pausedStopParent);
  assert.equal(availCoversDay(avail2, '2026-03-09'), true);
  assert.equal(availCoversDay(avail2, '2026-03-10'), false);
  assert.equal(availCoversDay(avail2, '2026-03-31'), false);
  assert.equal(availActiveDays(avail2, '2026-03-01', '2026-03-31'), 9);

  // Continuous cycle switch + planned future phase: displayCycle respects query day
  const switchedParent = mkSub({
    id: 'p3',
    name: 'Switched Parent',
    price: 20,
    start: '2026-01-01',
    phases: [
      { start: '2026-01-01', end: '2026-05-31', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: '2026-06-01', price: 200, currency: 'USD', cycle: { unit: 'year', every: 1 } },
    ],
  });
  const perk = mkSub({ id: 'perk', name: 'Perk', price: 0, start: '2026-01-01', bundle: { parentId: 'p3' } });
  const perkView = bundleView(perk, [switchedParent, perk]);
  assert.deepEqual(displayCycle(perkView, '2026-03-15'), { unit: 'month', every: 1 });
  assert.deepEqual(displayCycle(perkView, '2026-06-15'), { unit: 'year', every: 1 });

  // Undated stop on parent: child resolves to 'ended' and keeps charges through the parent's last known paid period (same basis as the parent's own charges)
  const undatedParent = mkSub({ id: 'p4', name: 'Undated', price: 20, start: '2025-01-01', status: 'terminated' });
  const childOfUndated = mkSub({ id: 'c4', name: 'Child', price: 5, start: '2025-01-01', bundle: { parentId: 'p4' } });
  const v4 = bundleView(childOfUndated, [undatedParent, childOfUndated]);
  assert.equal(effectiveStatus(v4, '2026-01-01'), 'ended');
  assert.deepEqual(
    chargesBetween(v4, '2025-01-01', '2026-01-01', '2026-01-01').map((c) => c.date),
    chargesBetween(undatedParent, '2025-01-01', '2026-01-01', '2026-01-01').map((c) => c.date),
  );
  // Regression: recorded parent payments before an undated stop must not erase the add-on's history
  const paidUndated = mkSub({
    id: 'p4b',
    name: 'Undated Paid',
    start: '2026-01-01',
    status: 'cancelled',
    payments: ['2026-01-01', '2026-02-01', '2026-03-01'].map((date, i) => ({ id: `u${i}`, date, amount: 20 })),
  });
  const addonOfPaid = mkSub({ id: 'c4b', name: 'Addon', price: 3, start: '2026-01-01', bundle: { parentId: 'p4b' } });
  const v4b = bundleView(addonOfPaid, [paidUndated, addonOfPaid]);
  assert.equal(effectiveStatus(v4b, '2026-11-23'), 'ended');
  assert.deepEqual(
    chargesBetween(v4b, '2026-01-01', '2026-11-23', '2026-11-23').map((c) => c.date),
    ['2026-01-01', '2026-02-01', '2026-03-01'],
  );
  assert.equal(servedTime(v4b, '2026-11-23').days, 90);

  // Lifetime parent with free lifetime perk & paid lifetime add-on
  const lifeParent = mkSub({ id: 'p5', name: 'Lifetime Parent', price: 999, cycle: { unit: 'lifetime', every: 1 }, start: '2026-01-01' });
  const freeLife = mkSub({ id: 'c5a', name: 'Free Life', price: 0, cycle: { unit: 'lifetime', every: 1 }, start: '2026-01-01', bundle: { parentId: 'p5' } });
  const paidLife = mkSub({ id: 'c5b', name: 'Paid Life', price: 49, cycle: { unit: 'lifetime', every: 1 }, start: '2026-01-01', bundle: { parentId: 'p5' } });
  assert.equal(nextCharge(bundleView(freeLife, [lifeParent, freeLife]), '2026-02-01'), undefined);
  assert.deepEqual(
    chargesBetween(bundleView(paidLife, [lifeParent, paidLife]), '2026-01-01', '2026-12-31', '2026-02-01').map((c) => c.amount),
    [49],
  );
  // Paid lifetime add-on purchased after parent already ended generates no inferred charge
  const endedParent = mkSub({ id: 'p6', name: 'Ended', price: 20, start: '2025-01-01', end: '2025-12-31', status: 'cancelled' });
  const lateLife = mkSub({ id: 'c6', name: 'Late Life', price: 49, cycle: { unit: 'lifetime', every: 1 }, start: '2026-02-01', bundle: { parentId: 'p6' } });
  assert.deepEqual(chargesBetween(bundleView(lateLife, [endedParent, lateLife]), '2025-01-01', '2026-12-31', '2026-03-01'), []);
});

// ---------- 4. Child Lifecycle & Standalone <-> Bundled Multi-Phase ----------

test('child ending before parent starts resolves to ended (never upcoming) and preserves earlier explicit payments', () => {
  const parent = mkSub({ id: 'p', name: 'Parent', price: 50, start: '2026-03-01' });
  const child = mkSub({
    id: 'c',
    name: 'Early Child',
    price: 5,
    start: '2026-01-01',
    end: '2026-01-31',
    payments: [{ date: '2026-01-01', amount: 5, currency: 'USD' }],
    bundle: { parentId: 'p' },
  });
  const view = bundleView(child, [parent, child]);
  assert.equal(effectiveStatus(view, '2026-01-15'), 'ended');
  assert.equal(effectiveStatus(view, '2026-02-15'), 'ended');
  assert.deepEqual(
    chargesBetween(view, '2026-01-01', '2026-04-01', '2026-03-15').map((c) => [c.date, c.amount]),
    [['2026-01-01', 5]],
  );
});

test('multi-phase standalone <-> bundled transition preserves historical charges via phases helpers', () => {
  const ultra = mkSub({ id: 'ultra', name: 'Google AI Ultra', price: 249.99, start: '2026-03-01' });
  const ytStandalone = mkSub({
    id: 'yt',
    name: 'YouTube Premium',
    price: 13.99,
    start: '2026-01-01',
    methodId: 'card',
  });
  // Switch standalone YT -> bundled free perk on 2026-03-01
  const ytBundled = switchPlan(ytStandalone, '2026-03-01', {
    price: 0,
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    methodId: undefined,
    bundle: { parentId: 'ultra', follow: true },
  });
  assert.equal(ytBundled.phases?.length, 2);
  assert.equal(ytBundled.phases![0].bundle, undefined);
  assert.deepEqual(ytBundled.phases![1].bundle, { parentId: 'ultra', follow: true });

  const view = bundleView(ytBundled, [ultra, ytBundled]);
  const charges = chargesBetween(view, '2026-01-01', '2026-06-30', '2026-05-15');
  assert.deepEqual(
    charges.map((c) => [c.date, c.amount]),
    [
      ['2026-01-01', 13.99],
      ['2026-02-01', 13.99],
    ],
  );
  assert.equal(hasFinancialHistory(ytBundled, charges), true);
  assert.equal(effectiveStatus(view, '2026-05-15'), 'active');

  // Round-trip through toEditForm / syncPhase / editPhase keeps bundle cleanly
  const form = toEditForm(ytBundled, '2026-05-15');
  assert.deepEqual(form.bundle, { parentId: 'ultra', follow: true });
  const synced = syncPhase(form, '2026-05-15');
  assert.deepEqual(synced.phases![1].bundle, { parentId: 'ultra', follow: true });
  const edited = editPhase(ytBundled, '2026-03-01', { bundle: { parentId: 'ultra', follow: false } });
  assert.deepEqual(edited.phases![1].bundle, { parentId: 'ultra', follow: false });
});

// ---------- 5. Postpaid Proration, Intro, Bonus, PriceHistory, Separate Settlement ----------

test('postpaid follow-parent add-on prorates mid-period pause and stop cleanly', () => {
  // Parent active Jan 1..Jan 16 (16 days of 31-day Jan), paused from Jan 17
  const parent = mkSub({
    id: 'p',
    name: 'Postpaid Parent',
    price: 50,
    start: '2026-01-01',
    status: 'paused',
    pausedAt: '2026-01-17',
  });
  const addon = mkSub({
    id: 'a',
    name: 'Postpaid Add-on',
    price: 10,
    billing: 'postpaid',
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
  });
  const view = bundleView(addon, [parent, addon]);
  const charges = chargesBetween(view, '2026-01-01', '2026-04-30', '2026-03-01');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].date, '2026-02-01');
  // 16 / 31 * 10 = 5.16129... -> 5.16
  assert.equal(charges[0].amount, 5.16);

  // Parent ends mid-period on Jan 10 -> 10/31 * 10 = 3.23
  const endedParent = mkSub({ id: 'p2', name: 'Ended Parent', price: 50, start: '2026-01-01', end: '2026-01-10', status: 'cancelled' });
  const addon2 = mkSub({ id: 'a2', name: 'Postpaid Add-on 2', price: 10, billing: 'postpaid', start: '2026-01-01', bundle: { parentId: 'p2' } });
  const charges2 = chargesBetween(bundleView(addon2, [endedParent, addon2]), '2026-01-01', '2026-04-30', '2026-03-01');
  assert.deepEqual(
    charges2.map((c) => [c.date, c.amount]),
    [['2026-02-01', 3.23]],
  );
});

test('paid follow-parent add-on supports intro, bonus, priceHistory, and separate settlement', () => {
  const parent = mkSub({ id: 'p', name: 'Parent', price: 50, start: '2026-01-01', end: '2026-03-31', status: 'cancelled' });
  const addon = mkSub({
    id: 'a',
    name: 'Intro + PriceHistory Add-on',
    price: 10,
    start: '2026-01-01',
    intro: { price: 3, until: '2026-02-01' },
    priceHistory: [
      { from: '2026-01-01', amount: 10 },
      { from: '2026-03-01', amount: 12 },
    ],
    bundle: { parentId: 'p' },
  });
  const charges = chargesBetween(bundleView(addon, [parent, addon]), '2026-01-01', '2026-06-30', '2026-05-01');
  assert.deepEqual(
    charges.map((c) => [c.date, c.amount]),
    [
      ['2026-01-01', 3],
      ['2026-02-01', 10],
      ['2026-03-01', 12],
    ],
  );

  // Separate settlement respects parent end
  const sep = mkSub({
    id: 'sep',
    name: 'Separate Add-on',
    price: 8,
    start: '2026-01-01',
    settlement: 'separate',
    settledBefore: '2026-01-01',
    bundle: { parentId: 'p' },
  });
  const sepView = bundleView(sep, [parent, sep]);
  assert.deepEqual(
    overdueBills(sepView, '2026-05-01').map((b) => b.date),
    ['2026-01-01', '2026-02-01', '2026-03-01'],
  );
});

// ---------- 6. Metrics, Reports, Insights, Carpool, People, Gantt & ListScope ----------

test('metrics, coverage, stopLosses, events, servedTime, scopeReport, insights, listScope, and gantt respect bundled state', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Google AI Ultra',
    price: 200,
    start: '2026-01-01',
    end: '2026-03-31',
    status: 'cancelled',
    methodId: 'card',
  });
  const freePerk = mkSub({
    id: 'perk',
    name: 'YouTube Premium',
    price: 0,
    start: '2026-01-01',
    bundle: { parentId: 'p' },
  });
  const annualAddon = mkSub({
    id: 'addon',
    name: 'Annual Add-on',
    price: 120,
    cycle: { unit: 'year', every: 1 },
    start: '2026-01-01',
    bundle: { parentId: 'p' },
  });
  // Active parent + free perk without payment method vs paid add-on without payment method
  const activeParent = mkSub({ id: 'ap', name: 'Active Bundle', price: 100, start: '2026-01-01', methodId: 'card' });
  const activePerk = mkSub({ id: 'aperk', name: 'Active Perk', price: 0, start: '2026-01-01', bundle: { parentId: 'ap' } });
  const activePaidNoMethod = mkSub({ id: 'apaid', name: 'Paid No Method', price: 5, start: '2026-01-01', bundle: { parentId: 'ap' } });

  const today = '2026-05-15';
  const st = mkState([parent, freePerk, annualAddon, activeParent, activePerk, activePaidNoMethod]);

  // Totals & MRR: only activeParent ($100) + activePaidNoMethod ($5)
  const tot = totals(st, today);
  assert.equal(Math.round(tot.mrr * 100) / 100, 105);
  assert.equal(tot.activeCount, 3); // activeParent, activePerk, activePaidNoMethod

  // Accrual: annualAddon paid $120 for 2026-01-01..2026-12-31 — amortization NOT truncated by parent stopping Mar 31
  const addonOnlyState = mkState([parent, annualAddon]);
  const cva = cashVsAccrual(addonOnlyState, today, 5, 2);
  const apr = cva.find((m) => m.month === '2026-04');
  assert.ok(apr && apr.accrual > 8 && apr.accrual < 12, `expected April accrual ~$10 from annual add-on, got ${apr?.accrual}`);

  // No fake stop/loss or fake end/resume events on children
  assert.equal(stopLosses(st, today).items.length, 0);
  assert.equal(stopHistory(st, today).length, 0);
  assert.equal(
    events(st, '2026-01-01', '2026-12-31', today).some((e) => e.sub.id === 'perk' && e.kind === 'end'),
    false,
  );

  // servedTime excludes days after parent end (Jan 1..Mar 31 = 90 days in 2026)
  assert.equal(servedTime(bundleView(freePerk, st.subscriptions), today).days, 90);
  assert.ok(subscriptionTenure(st, today).longest.every((x) => x.sub.id !== 'perk' || x.days === 90));

  // netCost & prepaidValue & cancelSavings run cleanly on resolved state
  assert.equal(netCost(st, freePerk, today).net, 0);
  assert.ok(prepaidValue(st, today).total >= 0);
  assert.equal(
    cancelSavings(st, today).items.some((i) => i.sub.id === 'perk'),
    false,
  );

  // scopeReport on child-only subset STILL resolves against full state.subscriptions
  const childOnlyReport = scopeReport(st, [freePerk, annualAddon], today);
  assert.equal(childOnlyReport.lifecycle?.activeCount, 0);
  assert.equal(childOnlyReport.lifecycle?.stoppedCount, 2);

  // insights: nomethod skips free perk, keeps paid add-on
  const ins = insights(st, today);
  const noMethod = ins.find((i) => i.id === 'nomethod');
  assert.ok(noMethod);
  assert.deepEqual(
    noMethod.subs?.map((s) => s.id),
    ['apaid'],
  );

  // listScope & listHaystack include parent name and resolved status
  assert.ok(listHaystack(st, freePerk, today).includes('google ai ultra'));
  assert.equal(inListScope(st, freePerk, today, { status: 'ended', words: ['ultra'] }), true);
  assert.equal(inListScope(st, freePerk, today, { status: 'live', words: ['ultra'] }), false);

  // Gantt yearsTimeline
  const tl = yearsTimeline(st.subscriptions, today);
  const perkRow = tl.rows.find((r) => r.s.id === 'perk');
  assert.ok(perkRow);
  assert.equal(perkRow.bars.length, 1);
  assert.equal(perkRow.bars[0].to, '2026-03-31');

  // childrenOf / allChildrenOf / linkableParents / bundleSource
  assert.deepEqual(
    childrenOf('ap', st.subscriptions, today).map((c) => c.sub.id),
    ['aperk', 'apaid'],
  );
  assert.equal(allChildrenOf('p', st.subscriptions).length, 2);
  assert.equal(bundleSource(activePerk, st.subscriptions, today)?.parent?.id, 'ap');
  assert.equal(
    linkableParents(st.subscriptions, { id: 'new' }).some((s) => s.id === 'aperk'),
    false,
  );
  assert.equal(
    linkableParents(st.subscriptions, { id: 'new' }).some((s) => s.id === 'ap'),
    true,
  );
});

test('shared bundled paid add-on stops accruing member dues when parent pauses or ends', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 50,
    start: '2026-01-01',
    status: 'paused',
    pausedAt: '2026-03-01',
  });
  const sharedAddon = mkSub({
    id: 'sa',
    name: 'Shared Add-on',
    price: 20,
    start: '2026-01-01',
    bundle: { parentId: 'p' },
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [{ id: 'm1', name: 'Alice', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  });
  const st = mkState([parent, sharedAddon]);
  const today = '2026-05-15';
  // Only Jan and Feb should be owed (2 periods, $20), NOT Mar/Apr/May while parent is paused!
  const dues = memberDues(bundleView(sharedAddon, st.subscriptions), today, 'USD', st);
  assert.equal(dues[0].periodsOwed, 2);
  assert.equal(dues[0].owed, 20);
  const book = carLedger(st, sharedAddon, today);
  assert.equal(book.paid, 40); // Jan + Feb
  assert.equal(carYear(st, sharedAddon, today).cost, 40);
  assert.equal(carpoolYear(st, today).subs.length, 1);
  const pl = peopleLedger(st, today);
  assert.equal(pl[0].periodsOwed, 2);
});

// ---------- 7. Public Masking Privacy & Consistency ----------

test('maskForPublic preserves visible parent links and protects hidden/anonymized parents with included + publicBundleAvail', () => {
  const today = todayIn('UTC');
  const start = addMonths(today, -2);
  const pauseFrom = addDays(today, -30);
  const pauseTo = addDays(today, -15);
  const publicPageOnly = (visible: PublicGridId[]) => ({
    sections: [
      ...PUBLIC_GRID_SECTIONS.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, hidden: !visible.includes(s.id) })),
      ...PUBLIC_BOTTOM_SECTIONS.map((id) => ({ id, x: 0, y: 100, w: 12, h: 4, hidden: true })),
    ],
  });

  const ultra = mkSub({
    id: 'ultra',
    name: 'Google AI Ultra 30TB',
    price: 249.99,
    start,
    cycle: { unit: 'year', every: 1 },
    pauses: [{ from: pauseFrom, to: pauseTo }],
  });
  const yt = mkSub({
    id: 'yt',
    name: 'YouTube Premium',
    price: 0,
    start,
    cycle: { unit: 'month', every: 1 },
    bundle: { parentId: 'ultra', follow: true },
  });
  const endedParent = mkSub({
    id: 'ep',
    name: 'Ended Secret',
    price: 30,
    start: addMonths(today, -12),
    end: addMonths(today, -2),
    status: 'cancelled',
  });
  const indepFree = mkSub({
    id: 'ifree',
    name: 'Independent Perk',
    price: 0,
    start: addMonths(today, -12),
    bundle: { parentId: 'ep', follow: false },
  });

  // Case A: visible parent -> keeps mapped bundle (default follow omitted), no included/bundleAvail
  const pubVisible = maskForPublic(mkState([ultra, yt]));
  const pubYtA = pubVisible.subscriptions.find((s) => s.name === 'YouTube Premium')!;
  const pubUltraA = pubVisible.subscriptions.find((s) => s.name === 'Google AI Ultra 30TB')!;
  assert.deepEqual(pubYtA.bundle, { parentId: pubUltraA.id });
  assert.equal(pubYtA.included, undefined);
  assert.equal(pubYtA.bundleAvail, undefined);

  // Case B: parent hidden in publicHidden -> strips bundle, attaches included + sanitized bundleAvail, ZERO $0 charges, parent cycle preserved
  const stHidden = mkState([ultra, yt], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', timezone: 'UTC', publicView: true, publicHidden: ['ultra'] },
  });
  const pubHidden = maskForPublic(stHidden);
  assert.equal(pubHidden.subscriptions.length, 1);
  const pubYtB = pubHidden.subscriptions[0];
  assert.equal(pubYtB.bundle, undefined);
  assert.equal(pubYtB.included, true);
  assert.ok(pubYtB.bundleAvail);
  assert.equal(JSON.stringify(pubHidden).includes('ultra'), false, 'hidden parent id must not leak');
  assert.equal(JSON.stringify(pubHidden).includes('Google AI Ultra'), false, 'hidden parent name must not leak');
  const resolvedPubB = resolveState(pubHidden);
  assert.deepEqual(chargesBetween(resolvedPubB.subscriptions[0], start, addMonths(today, 6), today), []);
  assert.deepEqual(displayCycle(resolvedPubB.subscriptions[0], today), { unit: 'year', every: 1 });

  // Case C: keepNames = false (only stats + composition visible) -> strips bundle, keeps included + bundleAvail
  const stAnon = mkState([ultra, yt], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', timezone: 'UTC', publicView: true, publicPage: publicPageOnly(['stats', 'composition']) },
  });
  const pubAnon = maskForPublic(stAnon);
  const pubYtC = pubAnon.subscriptions.find((s) => s.included);
  assert.ok(pubYtC);
  assert.equal(pubYtC.bundle, undefined);
  assert.ok(pubYtC.bundleAvail);

  // Case D: keepEnded = false (only composition visible) -> ended parent filtered out while independent free child survives with included: true
  const stNoEnded = mkState([endedParent, indepFree], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', timezone: 'UTC', publicView: true, publicPage: publicPageOnly(['composition']) },
  });
  const pubNoEnded = maskForPublic(stNoEnded);
  assert.equal(pubNoEnded.subscriptions.length, 1);
  assert.equal(pubNoEnded.subscriptions[0].bundle, undefined);
  assert.equal(pubNoEnded.subscriptions[0].included, true);
  assert.deepEqual(chargesBetween(resolveState(pubNoEnded).subscriptions[0], addMonths(today, -12), addMonths(today, 6), today), []);

  // Case E: keepHistory = false (only composition visible) while parent is in multi-phase gap -> gap state preserved!
  const gappedParent = mkSub({
    id: 'gp',
    name: 'Gapped Parent',
    price: 20,
    start: addMonths(today, -6),
    phases: [
      { start: addMonths(today, -6), end: addDays(today, -10), price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: addDays(today, 30), price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    ],
  });
  const gapChild = mkSub({ id: 'gc', name: 'Gap Child', price: 5, start: addMonths(today, -6), bundle: { parentId: 'gp' } });
  const stNoHist = mkState([gappedParent, gapChild], {
    settings: {
      ...DEFAULT_SETTINGS,
      baseCurrency: 'USD',
      timezone: 'UTC',
      publicView: true,
      publicHidden: ['gp'],
      publicPage: publicPageOnly(['composition']),
    },
  });
  const pubGap = resolveState(maskForPublic(stNoHist));
  assert.equal(effectiveStatus(pubGap.subscriptions[0], today), 'paused');
});

// ---------- 8. Validation, Referential Integrity & Worker HTTP API ----------

test('bundleError and bundleLinkError enforce invariants and allow unrelated edits on pre-existing dangling links', () => {
  const p = mkSub({ id: 'p', name: 'Parent', price: 50 });
  const c = mkSub({ id: 'c', name: 'Child', price: 0, bundle: { parentId: 'p' } });
  const proxy = mkSub({ id: 'px', name: 'Proxy', price: 10, proxy: { forName: 'Bob' } });

  // Private writes reject derived fields & proxy+bundle
  assert.ok(bundleError({ ...c, included: true }));
  assert.ok(bundleError({ ...c, bundleAvail: parentAvailability(p) }));
  assert.ok(bundleError({ ...c, proxy: { forName: 'Bob' } }));
  assert.ok(subError({ ...c, bundle: { parentId: '' } }));

  // Self-link, missing parent, proxy parent, 2-level chain
  assert.ok(bundleLinkError([p], [{ ...p, bundle: { parentId: 'p' } }]));
  assert.ok(bundleLinkError([p], [p, { ...c, bundle: { parentId: 'missing' } }]));
  assert.ok(bundleLinkError([proxy], [proxy, { ...c, bundle: { parentId: 'px' } }]));
  assert.ok(bundleLinkError([p, c], [p, c, mkSub({ id: 'g', name: 'Grandchild', price: 0, bundle: { parentId: 'c' } })]));
  assert.ok(bundleLinkError([p, c], [{ ...p, bundle: { parentId: 'other' } }, c, mkSub({ id: 'other', name: 'Other', price: 10 })]));

  // Deleting parent refused even when child links only in a planned future phase!
  const futureChild = mkSub({
    id: 'fc',
    name: 'Future Bundled',
    price: 10,
    start: '2026-01-01',
    phases: [
      { start: '2026-01-01', end: '2026-05-31', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: '2026-06-01', price: 0, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'p' } },
    ],
  });
  const delErr = bundleLinkError([p, futureChild], [futureChild]);
  assert.ok(delErr && delErr.includes('Future Bundled'));

  // Unrelated edit (including movePhaseStart) on pre-existing dangling link is allowed
  const dangling = mkSub({ id: 'd', name: 'Dangling', price: 0, start: '2026-02-01', bundle: { parentId: 'gone' } });
  assert.equal(bundleLinkError([dangling], [{ ...dangling, notes: 'edited' }]), undefined);
  const shifted = movePhaseStart(dangling, '2026-02-01', '2026-01-15', { shiftBilling: false });
  assert.equal(bundleLinkError([dangling], [shifted]), undefined);

  // prepareSubWrite validates cleanly
  const prep = prepareSubWrite(undefined, c, '2026-03-15', mkState([p]));
  assert.equal(prep.error, undefined);
});

test('Worker HTTP API enforces bundle referential integrity on PUT, DELETE, import, and masks GET /api/public', async () => {
  const { request } = dbFixture();
  const parent = mkSub({ id: 'ultra', name: 'Google AI Ultra', price: 249.99, start: '2026-01-01' });
  const child = mkSub({ id: 'yt', name: 'YouTube Premium', price: 0, start: '2026-01-01', bundle: { parentId: 'ultra' } });

  assert.equal((await request('subscriptions/ultra', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/yt', 'PUT', child)).status, 200);

  // Rejects deleting parent while child links to it
  const badDel = await request('subscriptions/ultra', 'DELETE');
  assert.equal(badDel.status, 400);
  assert.ok(((await badDel.json()) as { error: string }).error.includes('YouTube Premium'));

  // Rejects 2-level chain via PUT
  const grand = mkSub({ id: 'g', name: 'Grandchild', price: 0, start: '2026-01-01', bundle: { parentId: 'yt' } });
  assert.equal((await request('subscriptions/g', 'PUT', grand)).status, 400);

  // Rejects private PUT with derived included/bundleAvail
  assert.equal((await request('subscriptions/yt', 'PUT', { ...child, included: true })).status, 400);

  // Public API with hidden parent hides parent identity and keeps included perk
  assert.equal((await request('settings', 'PUT', { ...DEFAULT_SETTINGS, baseCurrency: 'USD', publicView: true, publicHidden: ['ultra'] })).status, 200);
  const pubRes = await request('public', 'GET', undefined, false);
  assert.equal(pubRes.status, 200);
  const pubBody = (await pubRes.json()) as { subscriptions: Subscription[] };
  assert.equal(pubBody.subscriptions.length, 1);
  assert.equal(pubBody.subscriptions[0].name, 'YouTube Premium');
  assert.equal(pubBody.subscriptions[0].included, true);
  assert.equal(pubBody.subscriptions[0].bundle, undefined);

  // Unlink child -> deleting parent now succeeds
  assert.equal((await request('subscriptions/yt', 'PUT', { ...child, bundle: undefined })).status, 200);
  assert.equal((await request('subscriptions/ultra', 'DELETE')).status, 200);

  // POST /api/import validates bundle links
  const badImport = await request('import', 'POST', {
    mode: 'merge',
    subscriptions: [mkSub({ id: 'orphan', name: 'Orphan', price: 0, bundle: { parentId: 'nope' } })],
    methods: [],
  });
  assert.equal(badImport.status, 400);
});

// ---------- 9. Reminders & ICS ----------

test('buildDaily, buildMonthly, and buildIcs skip free perks and inherited parent alerts while keeping paid add-ons and own endings', () => {
  const today = '2026-03-01';
  const trialParent = mkSub({
    id: 'p',
    name: 'Google AI Ultra',
    price: 249.99,
    start: '2026-02-01',
    status: 'trial',
    trialEnd: '2026-03-04',
    end: '2026-03-04',
  });
  const freePerk = mkSub({
    id: 'perk',
    name: 'YouTube Premium',
    price: 0,
    start: '2026-02-01',
    bundle: { parentId: 'p' },
  });
  const activeParent = mkSub({
    id: 'p2',
    name: 'Active Bundle',
    price: 100,
    start: '2026-02-01',
  });
  const paidAddon = mkSub({
    id: 'addon',
    name: 'Paid Add-on',
    price: 4.99,
    start: '2026-02-02',
    bundle: { parentId: 'p2' },
  });
  const ownEndingPerk = mkSub({
    id: 'ownend',
    name: 'Own Ending Perk',
    price: 0,
    start: '2026-02-01',
    end: '2026-03-04',
    bundle: { parentId: 'p2' },
  });
  const st = mkState([trialParent, freePerk, activeParent, paidAddon, ownEndingPerk], {
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', remindDays: 3, monthlyDigest: true },
  });

  const daily = buildDaily(st, today);
  assert.ok(daily);
  const dailyRows = daily.sections.flatMap((sec) => sec.rows);
  // Parent's own trial/ending alert appears, freePerk does NOT get a duplicate trial or ending or renewal alert!
  assert.equal(
    dailyRows.some((r) => r.title.includes('YouTube Premium')),
    false,
  );
  // Paid add-on renewal on Mar 2 (1 day away) DOES fire
  assert.equal(
    dailyRows.some((r) => r.title.includes('Paid Add-on')),
    true,
  );
  // Child's own explicit end (3 days away) DOES fire
  assert.equal(
    dailyRows.some((r) => r.title.includes('Own Ending Perk')),
    true,
  );

  const monthly = buildMonthly(st, today);
  assert.ok(monthly);
  const monthlyRows = monthly.sections.flatMap((sec) => sec.rows);
  assert.equal(
    monthlyRows.some((r) => r.title.includes('YouTube Premium')),
    false,
  );
  assert.equal(
    monthlyRows.some((r) => r.title.includes('Paid Add-on')),
    true,
  );

  const ics = buildIcs(st, 'https://example.test');
  assert.equal(ics.includes('YouTube Premium'), false);
  assert.equal(ics.includes('Paid Add-on'), true);
});

// ---------- 10. MCP Tools & Assistant Confirmation Pinning ----------

test('MCP tools support create/read/update/change_plan/delete with bundle and assistant pins parent id and inherited defaults', async () => {
  const { runTool } = dbFixture();
  const today = '2026-03-15';

  // Seed default method and parent
  const pm = (await runTool('update_payment_method', { action: 'create', set: { name: 'Amex', currency: 'USD', kind: 'credit' } }, { today })) as {
    after: { id: string };
  };
  await runTool('update_settings', { set: { defaultMethodId: pm.after.id } }, { today });
  const parentRes = (await runTool(
    'create_subscription',
    { name: 'Google AI Ultra 30TB', price: 249.99, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-15' },
    { today },
  )) as { subscription: { id: string } };
  const parentId = parentRes.subscription.id;
  assert.ok(parentId);

  // Create free bundled YouTube Premium omitting currency, cycle, and method!
  const ytRes = (await runTool(
    'create_subscription',
    { name: 'YouTube Premium', price: 0, start: '2026-01-15', bundle: { parent: 'Google AI Ultra' } },
    { today },
  )) as { subscription: { id: string } };
  const ytId = ytRes.subscription.id;
  assert.ok(ytId);

  // get_subscription keeps record raw while returning resolved views + bundle/linked_children
  const ytGet = (await runTool('get_subscription', { subscription: ytId }, { today })) as {
    record: Subscription;
    bundle: { parent_id: string; parent_name: string; follow: boolean; included: boolean };
    next_charge: string | null;
    charges: unknown[];
  };
  assert.equal(ytGet.record.bundleAvail, undefined);
  assert.equal(ytGet.record.included, undefined);
  assert.equal(ytGet.record.methodId, undefined, 'free bundled perk must not inherit defaultMethodId');
  assert.equal(ytGet.record.currency, 'USD');
  assert.deepEqual(ytGet.record.cycle, { unit: 'month', every: 1 });
  assert.deepEqual(ytGet.bundle, { parent_id: parentId, parent_name: 'Google AI Ultra 30TB', follow: true });
  assert.equal(ytGet.next_charge, null);
  assert.equal(ytGet.charges.length, 0);

  const parentGet = (await runTool('get_subscription', { subscription: parentId }, { today })) as {
    linked_children: Array<{ id: string; name: string; follow: boolean }>;
  };
  assert.equal(parentGet.linked_children.length, 1);
  assert.equal(parentGet.linked_children[0].id, ytId);

  // list_subscriptions matches parent name in query
  const listed = (await runTool('list_subscriptions', { query: 'Ultra' }, { today })) as {
    items: Array<{ id: string; bundle?: unknown; linked_children?: unknown[] }>;
  };
  assert.equal(listed.items.length, 2);

  // Assistant confirmationArgs pins fuzzy parent name -> exact parentId and inherited currency/cycle/method:null against real dry_run preview
  const dryPreview = await runTool(
    'create_subscription',
    { name: 'Included Cloud', price: 0, start: '2026-01-15', bundle: { parent: 'Google AI Ultra' }, dry_run: true },
    { today },
  );
  const pinnedArgs = confirmationArgs(
    'create_subscription',
    { name: 'Included Cloud', price: 0, start: '2026-01-15', bundle: { parent: 'Google AI Ultra' }, dry_run: true },
    dryPreview,
  ) as { bundle: { parent: string; follow?: boolean }; currency?: string; cycle?: unknown; method?: unknown };
  assert.equal(pinnedArgs.bundle.parent, parentId);
  assert.equal(pinnedArgs.currency, 'USD');
  assert.deepEqual(pinnedArgs.cycle, { unit: 'month', every: 1 });
  assert.equal(pinnedArgs.method, null);

  // delete_subscription refuses deleting parent while child exists and reports linked_children
  await assert.rejects(() => runTool('delete_subscription', { subscription: parentId }, { today }), /YouTube Premium/);

  // change_plan switch with bundle: null unlinks child; update_subscription re-links and unlinks
  await runTool(
    'change_plan',
    { subscription: ytId, action: 'switch', at: '2026-03-15', plan: { price: 13.99, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: null } },
    { today },
  );
  // Previous phase STILL references parent so delete is still refused!
  await assert.rejects(() => runTool('delete_subscription', { subscription: parentId }, { today }), /YouTube Premium/);

  // Edit historical phase to unlink -> parent delete succeeds
  const editPreview = await runTool(
    'change_plan',
    { subscription: ytId, action: 'edit', at: '2026-01-15', set: { bundle: { parent: 'Google AI Ultra', follow: false } }, dry_run: true },
    { today },
  );
  const pinnedEdit = confirmationArgs(
    'change_plan',
    { subscription: ytId, action: 'edit', at: '2026-01-15', set: { bundle: { parent: 'Google AI Ultra', follow: false } }, dry_run: true },
    editPreview,
  ) as { set: { bundle: { parent: string; follow?: boolean } } };
  assert.deepEqual(pinnedEdit.set.bundle, { parent: parentId, follow: false });

  await runTool('change_plan', { subscription: ytId, action: 'edit', at: '2026-01-15', set: { bundle: null } }, { today });
  const delOk = (await runTool('delete_subscription', { subscription: parentId }, { today })) as { ok: boolean; after: null };
  assert.equal(delOk.ok, true);
  assert.equal(delOk.after, null);

  // Verify addDays import sanity
  assert.equal(addDays('2026-01-01', 1), '2026-01-02');
});

// ---------- 11. Codex Code Review Regression Suite (Findings #1 - #9) ----------

test('Codex #1: savePayment and MCP record_payment never materialize skipped charges during parent pauses', async () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 100,
    start: '2026-01-01',
    pauses: [{ from: '2026-02-01', to: '2026-04-01' }],
  });
  const addon = mkSub({
    id: 'a',
    name: 'Paid Add-on',
    price: 30,
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
  });
  // Direct savePayment with full ledger subs
  const saved = savePayment(addon, '2026-04-15', { date: '2026-04-01', amount: 30, currency: 'USD' }, undefined, undefined, [parent, addon]);
  assert.equal(saved.bundleAvail, undefined, 'raw record must not persist bundleAvail');
  assert.deepEqual(
    saved.payments?.map((p) => [p.date, p.amount]),
    [
      ['2026-01-01', 30],
      ['2026-04-01', 30],
    ],
  );
  const total = chargesBetween(bundleView(saved, [parent, saved]), '2026-01-01', '2026-04-30', '2026-04-15').reduce((a, c) => a + c.amount, 0);
  assert.equal(total, 60);

  // MCP record_payment uses full ledger context (Feb & Mar pause charges are NEVER materialized)
  const { request, runTool } = dbFixture();
  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/a', 'PUT', addon)).status, 200);
  const rec = (await runTool('record_payment', { subscription: 'a', date: '2026-04-01', amount: 30 })) as { after: Subscription };
  const dates = (rec.after.payments ?? []).map((p) => p.date);
  assert.equal(dates.includes('2026-01-01'), true);
  assert.equal(dates.includes('2026-04-01'), true);
  assert.equal(dates.includes('2026-02-01'), false);
  assert.equal(dates.includes('2026-03-01'), false);
});

test('Codex #2 & #5: member receivables skip completed parent pauses, preserve receipts, isolate future bundled phase, and match memberStatus/receivableOf', () => {
  // Case 2a: Parent paused Feb-Mar and resumed Apr -> owed in May is $30 (Jan, Apr, May), NOT $50
  const resumedParent = mkSub({
    id: 'p',
    name: 'Resumed Parent',
    price: 50,
    start: '2026-01-01',
    pauses: [{ from: '2026-02-01', to: '2026-04-01' }],
  });
  const shared = mkSub({
    id: 'sa',
    name: 'Shared Add-on',
    price: 20,
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [
        { id: 'm1', name: 'Alice', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' },
        {
          id: 'm2',
          name: 'Bob',
          share: 10,
          fee: 10,
          feeCurrency: 'USD',
          joined: '2026-01-01',
          receipts: [{ id: 'r1', date: '2026-02-01', amount: 10, currency: 'USD', periods: ['2026-02-01'] }],
        },
      ],
    },
  });
  const st = mkState([resumedParent, shared]);
  const today = '2026-05-15';
  const dues = memberDues(bundleView(shared, st.subscriptions), today, 'USD', st);
  assert.equal(dues[0].owed, 30);
  assert.equal(dues[0].periodsOwed, 3);
  // Bob's existing Feb receipt stays attributed (not dumped to unmatched) while Mar is skipped
  const bobRec = receivableOf(st, shared, { kind: 'share', member: shared.share!.members[1] }, today, '2026-05-31');
  assert.equal(bobRec.unmatched.length, 0);
  assert.equal(
    bobRec.periods.some((p) => p.key === '2026-02-01' && p.status === 'paid'),
    true,
  );
  assert.equal(
    bobRec.periods.some((p) => p.key === '2026-03-01'),
    false,
  );

  // Case 2b: Future bundled phase starting Jun 1 must NOT apply parent pause to current standalone phase Jan-May ($50 owed!)
  const pausedParent = mkSub({ id: 'pp', name: 'Paused Parent', price: 50, start: '2026-01-01', status: 'paused', pausedAt: '2026-02-01' });
  const futureBundled = mkSub({
    id: 'fb',
    name: 'Future Bundled Share',
    price: 20,
    start: '2026-01-01',
    phases: [
      { start: '2026-01-01', end: '2026-05-31', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: '2026-06-01', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'pp', follow: true } },
    ],
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [{ id: 'm1', name: 'Carol', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  });
  const st2 = mkState([pausedParent, futureBundled]);
  const view2 = bundleView(futureBundled, st2.subscriptions);
  assert.equal(view2.bundleAvail, undefined, 'multi-phase view must not mirror future phase bundleAvail to top level');
  assert.equal(memberDues(view2, today, 'USD', st2)[0].owed, 50);

  // Case #5: memberStatus and receivableOf agree with paused parent ($10 owed, no Feb-May due periods offered)
  const pausedShared = mkSub({
    id: 'ps',
    name: 'Paused Shared',
    price: 20,
    start: '2026-01-01',
    bundle: { parentId: 'pp', follow: true },
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [{ id: 'm1', name: 'Dan', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  });
  const st3 = mkState([pausedParent, pausedShared]);
  const ms = memberStatus(st3, pausedShared, pausedShared.share!.members[0], today);
  assert.equal(ms.owed, 10);
  const rec3 = receivableOf(st3, pausedShared, { kind: 'share', member: pausedShared.share!.members[0] }, today, '2026-06-30');
  assert.deepEqual(
    rec3.periods.map((p) => p.key),
    ['2026-01-01'],
  );
});

test('Codex #3: billingPeriod and suggestedRefund keep original cycle length when parent pauses next month', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 100,
    start: '2026-01-01',
    pauses: [{ from: '2026-02-01', to: '2026-04-01' }],
  });
  const addon = mkSub({
    id: 'a',
    name: 'Monthly Add-on',
    price: 30,
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
  });
  const view = bundleView(addon, [parent, addon]);
  const bp = billingPeriod(view, '2026-01-15');
  assert.equal(bp.from, '2026-01-01');
  assert.equal(bp.paidThrough, '2026-01-31');
  assert.equal(bp.days, 31);
  assert.equal(bp.paid, 30);
  // Stop on Jan 15: suggestedRefund matches standalone ($15.48, NOT $5.33 stretched across Feb-Mar pause!)
  const standalone = mkSub({ id: 'sa', name: 'Standalone', price: 30, start: '2026-01-01' });
  const stoppedBundled = stopSubscription(addon, '2026-01-15', 'cancel', '2026-01-15', undefined, undefined, [parent, addon]);
  const bundledStop = stopSummary(bundleView(stoppedBundled, [parent, stoppedBundled]))!;
  const standaloneStop = stopSummary(stopSubscription(standalone, '2026-01-15', 'cancel', '2026-01-15'))!;
  assert.equal(bundledStop.suggestedRefund, 15.48);
  assert.equal(bundledStop.suggestedRefund, standaloneStop.suggestedRefund);
});

test('Codex #4: confirmationArgs pins implicitly inherited parent and explicit null on change_plan switch', async () => {
  const { runTool } = dbFixture();
  const today = '2026-03-15';
  const pa = (
    (await runTool(
      'create_subscription',
      { name: 'Parent A', price: 50, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-01' },
      { today },
    )) as { subscription: { id: string } }
  ).subscription.id;
  const pb = (
    (await runTool(
      'create_subscription',
      { name: 'Parent B', price: 60, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-01' },
      { today },
    )) as { subscription: { id: string } }
  ).subscription.id;
  const child = (
    (await runTool('create_subscription', { name: 'Add-on', price: 5, start: '2026-01-01', bundle: { parent: pa } }, { today })) as {
      subscription: { id: string };
    }
  ).subscription.id;

  // Preview switch WITHOUT passing plan.bundle -> implicitly inherits Parent A
  const switchArgs = {
    subscription: child,
    action: 'switch',
    at: '2026-04-01',
    plan: { price: 8, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    dry_run: true,
  };
  const preview = await runTool('change_plan', switchArgs, { today });
  const pinned = confirmationArgs('change_plan', switchArgs, preview);
  assert.deepEqual((pinned.plan as { bundle?: unknown }).bundle, { parent: pa });

  // Before confirmation, current link changes from Parent A to Parent B
  await runTool('update_subscription', { subscription: child, set: { bundle: { parent: pb } } }, { today });
  // Applying pinned confirmation args MUST still link the switched phase to Parent A!
  const applied = (await runTool('change_plan', pinned, { today })) as { after: Subscription };
  const switchedPhase = applied.after.phases?.find((p) => p.start === '2026-04-01');
  assert.equal(switchedPhase?.bundle?.parentId, pa);

  // Also test standalone switch pins bundle: null
  const solo = (
    (await runTool(
      'create_subscription',
      { name: 'Solo', price: 10, currency: 'USD', cycle: { unit: 'month', every: 1 }, start: '2026-01-01' },
      { today },
    )) as { subscription: { id: string } }
  ).subscription.id;
  const soloArgs = {
    subscription: solo,
    action: 'switch',
    at: '2026-04-01',
    plan: { price: 12, currency: 'USD', cycle: { unit: 'month', every: 1 } },
    dry_run: true,
  };
  const soloPinned = confirmationArgs('change_plan', soloArgs, await runTool('change_plan', soloArgs, { today }));
  assert.equal((soloPinned.plan as { bundle?: unknown }).bundle, null);
});

test('Codex #6: concurrent child PUT and parent DELETE cannot both succeed or leave a dangling link', async () => {
  const { db, env, request } = dbFixture();
  const parent = mkSub({ id: 'p', name: 'Parent', price: 50, start: '2026-01-01' });
  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);

  // Force deterministic interleaving: pause both requests right after their first read batch so both observe the same rev
  const origBatch = env.DB.batch.bind(env.DB);
  let readsPaused = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((r) => {
    releaseReads = r;
  });
  let intercepting = true;
  (env.DB as { batch: typeof origBatch }).batch = async (stmts) => {
    const out = await origBatch(stmts);
    if (intercepting && stmts.length === 2) {
      readsPaused++;
      if (readsPaused === 2) {
        intercepting = false;
        releaseReads();
      } else {
        await bothRead;
      }
    }
    return out;
  };

  const child = mkSub({ id: 'c', name: 'Child', price: 0, start: '2026-01-01', bundle: { parentId: 'p' } });
  const [putRes, delRes] = await Promise.all([request('subscriptions/c', 'PUT', child), request('subscriptions/p', 'DELETE')]);
  const statuses = [putRes.status, delRes.status].sort();
  assert.deepEqual(statuses, [200, 400], 'strictly one concurrent write wins and the loser fails validation on retry');

  const ids = (db.prepare('SELECT id FROM subscriptions').all() as Array<{ id: string }>).map((r) => r.id).sort();
  if (putRes.status === 200) assert.deepEqual(ids, ['c', 'p']);
  else assert.deepEqual(ids, []);
});

test('Codex #7: linked meters exclude readings during parent pauses and gaps and reset cumulative base', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 50,
    start: '2026-01-01',
    pauses: [{ from: '2026-02-01', to: '2026-04-01' }],
    meters: [
      { id: 'odo', name: 'Mileage', unit: 'km', kind: 'reading' },
      { id: 'gb', name: 'Traffic', unit: 'GB' },
    ],
    readings: [
      { id: 'r1', date: '2026-01-10', values: { odo: 100, gb: 10 } },
      { id: 'r2', date: '2026-01-25', values: { odo: 150, gb: 20 } },
      { id: 'r3', date: '2026-02-15', values: { odo: 300, gb: 99 } }, // during parent pause -> excluded!
      { id: 'r4', date: '2026-03-15', values: { odo: 450, gb: 88 } }, // during parent pause -> excluded from usage; only base marker for cumulative!
      { id: 'r5', date: '2026-04-05', values: { odo: 500, gb: 15 } },
      { id: 'r6', date: '2026-04-20', values: { odo: 560, gb: 25 } },
    ],
  });
  const child = mkSub({
    id: 'c',
    name: 'Bundled Insurance',
    price: 10,
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
    meters: [
      { id: 'm1', name: 'Mileage', unit: 'km', link: { subId: 'p', meterId: 'odo' } },
      { id: 'm2', name: 'Traffic', unit: 'GB', link: { subId: 'p', meterId: 'gb' } },
    ],
  });
  const mv = meterView(child, [parent, child]);
  const odoRows = meterRows(mv, mv.meters![0], '2026-05-01');
  // r3 is completely excluded; r4 is ONLY a base marker (usage undefined) so Feb-Mar 300km gap is NEVER counted as usage
  assert.equal(
    odoRows.some((r) => r.reading.id === 'r3'),
    false,
  );
  const r4Row = odoRows.find((r) => r.reading.id === 'r4');
  assert.equal(r4Row?.reading.base, true);
  assert.equal(r4Row?.usage, undefined);
  assert.equal(odoRows.find((r) => r.reading.id === 'r2')?.usage, 50);
  assert.equal(odoRows.find((r) => r.reading.id === 'r5')?.usage, 50);
  assert.equal(odoRows.find((r) => r.reading.id === 'r6')?.usage, 60);

  // Usage meter completely drops both r3 and r4 during parent pause (total = 10 + 20 + 15 + 25 = 70, NOT 257!)
  const gbRows = meterRows(mv, mv.meters![1], '2026-05-01');
  assert.equal(
    gbRows.some((r) => r.reading.id === 'r3' || r.reading.id === 'r4'),
    false,
  );
  assert.equal(
    gbRows.reduce((sum, r) => sum + (r.usage ?? 0), 0),
    70,
  );
});

test('Codex #8: contractEvents, buildDaily, and buildIcs honor follow-parent end while keeping independent contracts', () => {
  const endedParent = mkSub({ id: 'p', name: 'Ended Parent', price: 50, start: '2025-11-01', end: '2026-01-31', status: 'cancelled' });
  const followAddon = mkSub({
    id: 'fa',
    name: 'Follow Contract Add-on',
    price: 10,
    start: '2025-11-01',
    bundle: { parentId: 'p', follow: true },
    contract: { start: '2025-11-01', term: { unit: 'year', every: 1 }, renew: 'auto', noticeDays: 1 },
  });
  const indepAddon = mkSub({
    id: 'ia',
    name: 'Independent Contract Add-on',
    price: 10,
    start: '2025-11-01',
    bundle: { parentId: 'p', follow: false },
    contract: { start: '2025-11-01', term: { unit: 'year', every: 1 }, renew: 'auto', noticeDays: 1 },
  });
  const today = '2026-10-31';
  const subs = [endedParent, followAddon, indepAddon];
  assert.deepEqual(contractEvents(bundleView(followAddon, subs), '2026-01-01', '2026-12-31', today), []);
  assert.equal(contractEvents(bundleView(indepAddon, subs), '2026-01-01', '2026-12-31', today).length, 1);

  const st = mkState(subs, { settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', remindDays: 3 } });
  const daily = buildDaily(st, today);
  const titles = (daily?.sections.flatMap((sec) => sec.rows) ?? []).map((r) => r.title);
  assert.equal(
    titles.some((x) => x.includes('Follow Contract Add-on')),
    false,
  );
  assert.equal(
    titles.some((x) => x.includes('Independent Contract Add-on')),
    true,
  );

  const ics = buildIcs(st, 'https://example.test');
  assert.equal(ics.includes('Follow Contract Add-on'), false);
  assert.equal(ics.includes('Independent Contract Add-on'), true);
});

test('Codex #9: childrenOf and MCP linked_children report the upcoming linked phase price and cycle', async () => {
  const { request, runTool } = dbFixture();
  const today = todayIn('UTC');
  const start = addMonths(today, -2);
  const futureStart = addMonths(today, 2);
  const parent = mkSub({ id: 'p', name: 'Bundle Parent', price: 100, cycle: { unit: 'year', every: 1 }, start });
  const child = mkSub({
    id: 'c',
    name: 'Switching Child',
    price: 30,
    cycle: { unit: 'month', every: 1 },
    start,
    phases: [
      { start, end: addDays(futureStart, -1), price: 30, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: futureStart, price: 0, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'p', follow: true } },
    ],
  });
  const kids = childrenOf('p', [parent, child], today);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].upcoming, true);
  assert.equal(kids[0].phase.price, 0);
  assert.deepEqual(displayCycle(kids[0].phase, kids[0].phase.start), { unit: 'year', every: 1 });

  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/c', 'PUT', child)).status, 200);
  const got = (await runTool('get_subscription', { subscription: 'p' })) as {
    linked_children: Array<{ id: string; price: { amount: number }; cycle: string; upcoming?: boolean }>;
  };
  assert.equal(got.linked_children.length, 1);
  assert.equal(got.linked_children[0].price.amount, 0);
  assert.equal(got.linked_children[0].upcoming, true);
});

test('linking an existing subscription in place cannot silently erase its past charges; switching plan from the link date still saves', () => {
  const today = '2026-05-15';
  const ultra = mkSub({ id: 'ultra', name: 'Google AI Ultra', price: 249.99, start: '2026-03-01' });
  const yt = mkSub({ id: 'yt', name: 'YouTube Premium', price: 13.99, start: '2026-01-01', methodId: 'card' });
  const refs = mkState([ultra, yt]);

  // In-place link (paid add-on or free perk) would drop Jan/Feb charges that predate the parent: refused
  for (const edit of [
    { ...yt, bundle: { parentId: 'ultra' } },
    { ...yt, price: 0, methodId: undefined, bundle: { parentId: 'ultra' } },
  ]) {
    const res = prepareSubWrite(yt, edit, today, refs);
    assert.equal('error' in res && res.error, 'Linking would change past charges or service. Link from the link date under History → Switch plan instead.');
  }

  // Switching plan from the link date keeps history and saves
  const switched = switchPlan(yt, '2026-03-01', { price: 0, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'ultra' } });
  assert.ok(!('error' in prepareSubWrite(yt, switched, today, refs)));

  // A perk whose own start is inside the parent's coverage links in place without losing anything
  const perk = mkSub({ id: 'perk', name: 'Perk', price: 0, start: '2026-03-01' });
  assert.ok(!('error' in prepareSubWrite(perk, { ...perk, bundle: { parentId: 'ultra' } }, today, mkState([ultra, perk]))));

  // Unrelated edits to an already linked record are not re-checked
  const linked = { ...yt, bundle: { parentId: 'ultra' } };
  assert.ok(!('error' in prepareSubWrite(linked, { ...linked, notes: 'x' }, today, mkState([ultra, linked]))));
});

// ---------- 12. Codex Round-2 Code Review Regressions ----------

test('Codex R2 #1: billingPeriod and suggestedRefund stay 31 days ($15.48) even after recording Jan payment with skipped nextDue=04-01', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Parent',
    price: 100,
    start: '2026-01-01',
    pauses: [{ from: '2026-02-01', to: '2026-04-01' }],
  });
  const addon = mkSub({
    id: 'a',
    name: 'Monthly Add-on',
    price: 30,
    start: '2026-01-01',
    bundle: { parentId: 'p', follow: true },
  });
  // Record Jan payment -> materializes payments=[Jan 1] and nextDue='2026-04-01' (skipping Feb-Mar pause)
  const paidAddon = savePayment(addon, '2026-01-15', { date: '2026-01-01', amount: 30, currency: 'USD' }, undefined, undefined, [parent, addon]);
  assert.equal(paidAddon.nextDue, '2026-04-01');
  const view = bundleView(paidAddon, [parent, paidAddon]);
  const bp = billingPeriod(view, '2026-01-15');
  assert.equal(bp.from, '2026-01-01');
  assert.equal(bp.paidThrough, '2026-01-31');
  assert.equal(bp.days, 31);
  assert.equal(bp.paid, 30);
  const stopped = stopSubscription(paidAddon, '2026-01-15', 'cancel', '2026-01-15', undefined, undefined, [parent, paidAddon]);
  assert.equal(stopSummary(bundleView(stopped, [parent, stopped]))!.suggestedRefund, 15.48);
});

test('Codex R2 #2: prepaid Feb receipt stays attributed (never unmatched) when parent pauses from Feb or ends in Jan', () => {
  for (const parent of [
    mkSub({ id: 'p', name: 'Paused Parent', price: 50, start: '2026-01-01', status: 'paused', pausedAt: '2026-02-01' }),
    mkSub({ id: 'p', name: 'Ended Parent', price: 50, start: '2026-01-01', end: '2026-01-31', status: 'cancelled' }),
  ]) {
    const shared = mkSub({
      id: 'sa',
      name: 'Shared Add-on',
      price: 20,
      start: '2026-01-01',
      bundle: { parentId: 'p', follow: true },
      share: {
        role: 'owner',
        seats: 2,
        collectFrom: '2026-01-01',
        members: [
          {
            id: 'm1',
            name: 'Prepaid Alice',
            share: 10,
            fee: 10,
            feeCurrency: 'USD',
            joined: '2026-01-01',
            receipts: [{ id: 'r1', date: '2026-01-05', amount: 20, currency: 'USD', periods: ['2026-01-01', '2026-02-01'] }],
          },
          { id: 'm2', name: 'Unpaid Bob', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' },
        ],
      },
    });
    const st = mkState([parent, shared]);
    const today = '2026-05-15';
    const aliceRec = receivableOf(st, shared, { kind: 'share', member: shared.share!.members[0] }, today, '2026-05-31');
    assert.equal(aliceRec.unmatched.length, 0, `${parent.name}: prepaid Feb must stay matched`);
    const feb = aliceRec.periods.find((p) => p.key === '2026-02-01');
    assert.equal(feb?.status, 'paid');
    assert.equal(feb?.due, 10);
    assert.equal(
      aliceRec.periods.some((p) => p.key === '2026-03-01'),
      false,
    );
    // Unpaid Bob only owes Jan ($10), never Feb-May
    const dues = memberDues(bundleView(shared, st.subscriptions), today, 'USD', st);
    assert.equal(dues[0].owed, 0);
    assert.equal(dues[1].owed, 10);
  }
});

test('Codex R2 #3: concurrent category rename cannot resurrect an unlinked bundle after parent deletion', async () => {
  const { db, env, request } = dbFixture();
  const parent = mkSub({ id: 'p', name: 'Parent', price: 50, start: '2026-01-01', category: 'AI' });
  const child = mkSub({ id: 'c', name: 'Child', price: 0, start: '2026-01-01', category: 'Media', bundle: { parentId: 'p' } });
  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/c', 'PUT', child)).status, 200);

  // Interleave: category rename reads stale child (linked to p), then unlink + delete parent commit before category rename writes
  const origBatch = env.DB.batch.bind(env.DB);
  let paused = false;
  let resumeRename!: () => void;
  const waitUnlinkDelete = new Promise<void>((r) => {
    resumeRename = r;
  });
  let hitFirstRead!: () => void;
  const renameReadDone = new Promise<void>((r) => {
    hitFirstRead = r;
  });
  (env.DB as { batch: typeof origBatch }).batch = async (stmts) => {
    const out = await origBatch(stmts);
    if (!paused && stmts.length === 2) {
      paused = true;
      hitFirstRead();
      await waitUnlinkDelete;
    }
    return out;
  };

  const renamePromise = request('categories', 'PUT', {
    categories: [
      { name: 'AI', icon: 'sparkles', color: 'blue' },
      { name: 'Streaming', icon: 'tv', color: 'purple' },
    ],
    renames: { Media: 'Streaming' },
  });
  await renameReadDone;
  assert.equal((await request('subscriptions/c', 'PUT', { ...child, bundle: undefined })).status, 200);
  assert.equal((await request('subscriptions/p', 'DELETE')).status, 200);
  resumeRename();

  const renameRes = await renamePromise;
  assert.equal(renameRes.status, 200);
  const storedChild = JSON.parse((db.prepare("SELECT data FROM subscriptions WHERE id = 'c'").get() as { data: string }).data) as Subscription;
  assert.equal(storedChild.category, 'Streaming');
  assert.equal(storedChild.bundle, undefined, 'category rename retry must NOT resurrect deleted parent link');
});

test('Codex R3 #1: skipped nextDue=04-01 gives $0 refund during Feb-Mar pause, $0 after mid-period Mar 15 resume, and accurate mid-period pause refund', () => {
  // Case A: pause 02-01..04-01, query during pause (02-15) -> paidThrough 02-15, unusedDays 0, suggestedRefund $0 (never 59d / 02-28 / $6.61)
  const parent = mkSub({ id: 'p', name: 'Parent', price: 100, start: '2026-01-01', pauses: [{ from: '2026-02-01', to: '2026-04-01' }] });
  const addon = mkSub({ id: 'a', name: 'Monthly Add-on', price: 30, start: '2026-01-01', bundle: { parentId: 'p', follow: true } });
  const paidAddon = savePayment(addon, '2026-01-15', { date: '2026-01-01', amount: 30, currency: 'USD' }, undefined, undefined, [parent, addon]);
  assert.equal(paidAddon.nextDue, '2026-04-01');

  const duringPause = billingPeriod(bundleView(paidAddon, [parent, paidAddon]), '2026-02-15');
  assert.equal(duringPause.from, '2026-01-01');
  assert.equal(duringPause.paidThrough, '2026-02-15');
  assert.equal(duringPause.days, 31);
  const stoppedDuring = stopSubscription(paidAddon, '2026-02-15', 'cancel', '2026-02-15', undefined, undefined, [parent, paidAddon]);
  const sumDuring = stopSummary(bundleView(stoppedDuring, [parent, stoppedDuring]))!;
  assert.equal(sumDuring.unusedDays, 0);
  assert.equal(sumDuring.unusedValue, 0);
  assert.equal(sumDuring.suggestedRefund, 0);

  // stopPreview / applyStopForm / editStop agree with stopSubscription
  const form = { ...stopForm(paidAddon, '2026-01-15', mkState([parent, paidAddon])), mode: 'cancel' as const, date: '2026-01-15', refund: true };
  assert.equal(stopPreview(paidAddon, form, '2026-01-15', [parent, paidAddon]).summary.suggestedRefund, 15.48);
  const formStopped = applyStopForm(paidAddon, form, '2026-01-15', [parent, paidAddon]);
  assert.equal(formStopped.stop!.paidThrough, '2026-01-31');
  const edited = editStop(formStopped, { mode: 'cancel', date: '2026-02-15', refund: null }, '2026-02-15', [parent, formStopped]);
  assert.equal(edited.stop!.paidThrough, '2026-02-15');
  assert.equal(stopSummary(bundleView(edited, [parent, edited]))!.suggestedRefund, 0);

  // Case B: mid-period resume (pause 02-01..03-15) -> on 03-20 (resumed, skipped Mar 1 bill): from 03-15, paidThrough 03-31, paid 0, suggestedRefund $0
  const midResumeParent = mkSub({ id: 'p', name: 'Parent', price: 100, start: '2026-01-01', pauses: [{ from: '2026-02-01', to: '2026-03-15' }] });
  const paidMidResume = savePayment(addon, '2026-01-15', { date: '2026-01-01', amount: 30, currency: 'USD' }, undefined, undefined, [midResumeParent, addon]);
  assert.equal(paidMidResume.nextDue, '2026-04-01');
  const afterResume = billingPeriod(bundleView(paidMidResume, [midResumeParent, paidMidResume]), '2026-03-20');
  assert.equal(afterResume.from, '2026-03-15');
  assert.equal(afterResume.paidThrough, '2026-03-31');
  assert.equal(afterResume.paid, 0);
  assert.equal(afterResume.days, 17);
  const stoppedAfterResume = stopSubscription(paidMidResume, '2026-03-20', 'cancel', '2026-03-20', undefined, undefined, [midResumeParent, paidMidResume]);
  assert.equal(stopSummary(bundleView(stoppedAfterResume, [midResumeParent, stoppedAfterResume]))!.suggestedRefund, 0);
  const aprilPeriod = billingPeriod(bundleView(paidMidResume, [midResumeParent, paidMidResume]), '2026-04-15');
  assert.equal(aprilPeriod.from, '2026-04-01');
  assert.equal(aprilPeriod.paidThrough, '2026-04-30');
  assert.equal(aprilPeriod.paid, 30);

  // Case C: mid-period pause (pause 01-20..04-01) -> stopping on 01-25 still has 6 unused days ($5.81) from Jan 1..31 paid period
  const midPauseParent = mkSub({ id: 'p', name: 'Parent', price: 100, start: '2026-01-01', pauses: [{ from: '2026-01-20', to: '2026-04-01' }] });
  const paidMidPause = savePayment(addon, '2026-01-15', { date: '2026-01-01', amount: 30, currency: 'USD' }, undefined, undefined, [midPauseParent, addon]);
  const stoppedMidPause = stopSubscription(paidMidPause, '2026-01-25', 'cancel', '2026-01-25', undefined, undefined, [midPauseParent, paidMidPause]);
  const sumMidPause = stopSummary(bundleView(stoppedMidPause, [midPauseParent, stoppedMidPause]))!;
  assert.equal(sumMidPause.paidThrough, '2026-01-31');
  assert.equal(sumMidPause.unusedDays, 6);
  assert.equal(sumMidPause.suggestedRefund, 5.81);

  // Case D (Codex R4): chargeLeadDays: 5 + parent pause 02-01..03-15 -> nextDue is cash date 03-27 (service 04-01);
  // 01-28 stays in Jan paid period, 02-15/03-20 give $0 refund, and 04-15 is 04-01..04-30 ($30 paid, $15 refund)
  const leadAddon = mkSub({ ...addon, chargeLeadDays: 5 });
  const paidLead = savePayment(leadAddon, '2026-01-15', { date: '2026-01-01', amount: 30, currency: 'USD' }, undefined, undefined, [
    midResumeParent,
    leadAddon,
  ]);
  assert.equal(paidLead.nextDue, '2026-03-27');
  const leadView = bundleView(paidLead, [midResumeParent, paidLead]);
  assert.deepEqual(billingPeriod(leadView, '2026-01-28'), { from: '2026-01-01', paidThrough: '2026-01-31', paid: 30, days: 31 });
  assert.equal(billingPeriod(leadView, '2026-02-15').paidThrough, '2026-02-15');
  assert.deepEqual(billingPeriod(leadView, '2026-03-20'), { from: '2026-03-15', paidThrough: '2026-03-31', paid: 0, days: 17 });
  assert.deepEqual(billingPeriod(leadView, '2026-04-15'), { from: '2026-04-01', paidThrough: '2026-04-30', paid: 30, days: 30 });
  const leadStoppedApr = stopSubscription(paidLead, '2026-04-15', 'cancel', '2026-04-15', undefined, undefined, [midResumeParent, paidLead]);
  assert.equal(stopSummary(bundleView(leadStoppedApr, [midResumeParent, leadStoppedApr]))!.suggestedRefund, 15);
});

test('Codex R3 #2: GET /api/state auto-migration (ensurePeople) cannot resurrect an unlinked bundle after concurrent parent deletion', async () => {
  const { db, env, request } = dbFixture();
  const parent = mkSub({ id: 'p', name: 'Parent', price: 50, start: '2026-01-01' });
  // Child has a legacy member without personId so GET /api/state triggers ensurePeople()
  const child = mkSub({
    id: 'c',
    name: 'Shared Child',
    price: 20,
    start: '2026-01-01',
    bundle: { parentId: 'p' },
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [{ id: 'm1', name: 'Legacy Alice', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  });
  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/c', 'PUT', child)).status, 200);

  // Interleave: GET /api/state reads snapshot (5-stmt batch incl. files), pauses before ensurePeople writes, while unlink + parent DELETE commit
  const origBatch = env.DB.batch.bind(env.DB);
  let paused = false;
  let resumeStateRead!: () => void;
  const waitWrites = new Promise<void>((r) => {
    resumeStateRead = r;
  });
  let stateReadHit!: () => void;
  const stateReadReady = new Promise<void>((r) => {
    stateReadHit = r;
  });
  (env.DB as { batch: typeof origBatch }).batch = async (stmts) => {
    const out = await origBatch(stmts);
    if (!paused && stmts.length === 5) {
      paused = true;
      stateReadHit();
      await waitWrites;
    }
    return out;
  };

  const statePromise = request('state', 'GET');
  await stateReadReady;
  assert.equal((await request('subscriptions/c', 'PUT', { ...child, bundle: undefined })).status, 200);
  assert.equal((await request('subscriptions/p', 'DELETE')).status, 200);
  resumeStateRead();

  const stateRes = await statePromise;
  assert.equal(stateRes.status, 200);
  const storedChild = JSON.parse((db.prepare("SELECT data FROM subscriptions WHERE id = 'c'").get() as { data: string }).data) as Subscription;
  assert.equal(storedChild.bundle, undefined, 'ensurePeople CAS retry must NOT resurrect deleted parent link');
  assert.ok(storedChild.share?.members[0].personId, 'ensurePeople still links member personId on fresh snapshot');
});

// ---------- Codex R4 ----------

/** 在下一次带版本守卫的写入前，模拟别处先提交一次（kv.rev + 1） */
function bumpBeforeGuardedWrites(env: Env, db: DatabaseSync, times: number, match: (sqls: string[]) => boolean = () => true) {
  const orig = env.DB.batch.bind(env.DB);
  let left = times;
  (env.DB as { batch: typeof orig }).batch = async (stmts) => {
    const sqls = (stmts as unknown as Array<{ sql: string }>).map((x) => x.sql);
    if (left > 0 && sqls.some((q) => q.startsWith("INSERT INTO kv (key, value, updated_at) SELECT 'rev'")) && match(sqls)) {
      left--;
      db.exec("UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'");
    }
    return orig(stmts);
  };
}

test('Codex R4 #2: an MCP write that loses a revision race reports a conflict instead of replaying a positional delete', async () => {
  const { db, env, request, runTool } = dbFixture();
  const sub = mkSub({
    id: 's',
    name: 'Twice Paid',
    price: 10,
    start: '2026-01-01',
    payments: [
      { date: '2026-02-01', amount: 10 },
      { date: '2026-02-01', amount: 12 },
    ],
  });
  assert.equal((await request('subscriptions/s', 'PUT', sub)).status, 200);
  bumpBeforeGuardedWrites(env, db, 1);
  await assert.rejects(runTool('delete_payment', { subscription: 's', date: '2026-02-01', index: 0 }), /changed elsewhere/);
  const stored = JSON.parse((db.prepare("SELECT data FROM subscriptions WHERE id = 's'").get() as { data: string }).data) as Subscription;
  assert.equal(stored.payments?.length, 2, 'no payment is removed by a replay against the newer ledger');
});

test('Codex R4 #3: a committed replace import is never replayed when the follow-up migration keeps conflicting', async () => {
  const { db, env, request } = dbFixture();
  const legacy = mkSub({
    id: 'legacy',
    name: 'Legacy Shared',
    price: 20,
    start: '2026-01-01',
    share: {
      role: 'owner',
      seats: 2,
      collectFrom: '2026-01-01',
      members: [{ id: 'm1', name: 'Legacy Bob', share: 10, fee: 10, feeCurrency: 'USD', joined: '2026-01-01' }],
    },
  } as Partial<Subscription> & { id: string; name: string });
  let replaces = 0;
  const orig = env.DB.batch.bind(env.DB);
  (env.DB as { batch: typeof orig }).batch = async (stmts) => {
    if ((stmts as unknown as Array<{ sql: string }>).some((x) => x.sql === 'DELETE FROM subscriptions')) replaces++;
    return orig(stmts);
  };
  // 替换提交后，每次迁移写入前都有别处先提交
  bumpBeforeGuardedWrites(env, db, 20, (sqls) => !sqls.includes('DELETE FROM subscriptions'));
  const res = await request('import', 'POST', { mode: 'replace', subscriptions: [legacy], methods: [] });
  assert.equal(replaces, 1, 'the whole-ledger replace runs exactly once');
  assert.equal(res.status, 200, 'the committed import is reported as done, not as retryable');
  assert.deepEqual(
    ((await res.json()) as AppState).subscriptions.map((x) => x.id),
    ['legacy'],
  );
});

test('Codex R4 #7: import rejects duplicate subscription ids', async () => {
  const { request } = dbFixture();
  const a = mkSub({ id: 'dup', name: 'First' });
  const res = await request('import', 'POST', { mode: 'merge', subscriptions: [a, { ...a, name: 'Second', proxy: true }], methods: [] });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /dup/);
});

test('Codex R4 #4: upgrade credit uses the bundle-resolved period, so a charge skipped during the parent pause is not credited', () => {
  const parent = mkSub({ id: 'p', name: 'Parent', price: 30, start: '2026-01-01', pauses: [{ from: '2026-02-20', to: '2026-03-15' }] });
  const child = mkSub({ id: 'c', name: 'Child', price: 10, start: '2026-01-01', bundle: { parentId: 'p' } });
  const subs = [parent, child];
  const next = { price: 50, currency: 'USD', cycle: { unit: 'month' as const, every: 1 } };
  const plain = upgradeQuote(child, '2026-03-21', next, '2026-03-21');
  assert.ok(plain && plain.credit > 0, 'without the ledger the skipped March charge looks paid');
  assert.equal(upgradeQuote(child, '2026-03-21', next, '2026-03-21', subs), undefined, 'nothing was paid for the current period');
  assert.throws(() => upgradePlan(child, '2026-03-21', next, '2026-03-21', 'reset', undefined, subs));
});

test('Codex R4 #5: a parent pause that would invalidate a child payment allocation is refused on the parent write', () => {
  const parent = mkSub({ id: 'p', name: 'Parent', price: 30, start: '2026-01-01' });
  const child = mkSub({
    id: 'c',
    name: 'Separate Child',
    price: 10,
    start: '2026-01-01',
    settlement: 'separate',
    settledBefore: '2026-01-01',
    bundle: { parentId: 'p' },
    payments: [{ date: '2026-02-10', amount: 10, periods: ['2026-02-01'] }],
  } as Partial<Subscription> & { id: string; name: string });
  const refs = { subscriptions: [parent, child], methods: mkState([]).methods, fx: FX };
  assert.equal(subError(child, refs.subscriptions), undefined);
  const paused: Subscription = { ...parent, status: 'paused', pausedAt: '2026-01-25' };
  const r = prepareSubWrite(parent, paused, '2026-03-21', refs);
  assert.ok('error' in r && r.error?.includes('Separate Child'), String('error' in r ? r.error : 'saved'));
  // 与子订阅无关的主订阅编辑照常保存
  const noted = prepareSubWrite(parent, { ...parent, note: 'hello' }, '2026-03-21', refs);
  assert.equal(noted.error, undefined);
});

test('Codex R4 #6: public bundle availability carries only unit/every for cycles', () => {
  const avail = {
    spans: [{ from: '2026-01-01' }],
    pauses: [],
    trial: { from: '2026-01-01', until: '2026-01-08', extra: 'x' },
    cycles: [{ from: '2026-01-01', cycle: { unit: 'month', every: 1, name: 'Secret Parent', price: 99 } }],
  } as unknown as Parameters<typeof publicBundleAvail>[0];
  for (const keep of [true, false]) {
    const out = publicBundleAvail(avail, '2026-01-05', keep);
    assert.deepEqual(out.cycles[0].cycle, { unit: 'month', every: 1 });
    assert.deepEqual(out.trial, { from: '2026-01-01', until: '2026-01-08' });
  }
});

test('Codex R4 #8: a lifetime parent stopped on an unknown date stops forecasting paid follow charges', () => {
  const parent = mkSub({ id: 'p', name: 'Lifetime', price: 200, cycle: { unit: 'lifetime', every: 1 }, start: '2026-01-01', status: 'cancelled' });
  const child = mkSub({ id: 'c', name: 'Paid Follow', price: 5, start: '2026-01-01', bundle: { parentId: 'p' } });
  const view = bundleView(child, [parent, child]);
  assert.deepEqual(
    chargesBetween(view, '2026-01-01', '2026-12-31', '2026-06-15').map((c) => c.date),
    ['2026-01-01'],
  );
});

test('Codex R5: merge import is refused when an imported parent change invalidates a following child allocation', async () => {
  const { request } = dbFixture();
  const parent = mkSub({ id: 'p', name: 'Parent', price: 30, start: '2026-01-01' });
  const child = mkSub({
    id: 'c',
    name: 'Separate Child',
    price: 10,
    start: '2026-01-01',
    settlement: 'separate',
    settledBefore: '2026-01-01',
    bundle: { parentId: 'p' },
    payments: [{ date: '2026-02-10', amount: 10, periods: ['2026-02-01'] }],
  } as Partial<Subscription> & { id: string; name: string });
  assert.equal((await request('subscriptions/p', 'PUT', parent)).status, 200);
  assert.equal((await request('subscriptions/c', 'PUT', child)).status, 200);
  const res = await request('import', 'POST', { mode: 'merge', subscriptions: [{ ...parent, status: 'paused', pausedAt: '2026-01-25' }], methods: [] });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Separate Child/);
});

test('Codex R5: an undated-stop monthly parent with a later planned phase still forecasts no child charges after its known coverage', () => {
  const parent = mkSub({
    id: 'p',
    name: 'Monthly',
    price: 20,
    start: '2026-01-01',
    status: 'cancelled',
    phases: [
      { start: '2026-01-01', end: '2026-01-31', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 } },
      { start: '2026-07-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, planned: true },
    ],
  } as Partial<Subscription> & { id: string; name: string });
  const child = mkSub({ id: 'c', name: 'Paid Follow', price: 5, start: '2026-01-01', bundle: { parentId: 'p' } });
  const dates = chargesBetween(bundleView(child, [parent, child]), '2026-01-01', '2026-12-31', '2026-06-15').map((c) => c.date);
  assert.ok(!dates.includes('2026-07-01'), dates.join(','));
});

test('linking in place to a parent that stopped earlier cannot shorten past service even when recorded payments stay', () => {
  const today = '2026-11-23';
  const parent = mkSub({ id: 'px', name: 'Pixel Studio', price: 20, start: '2026-01-01', end: '2026-10-22', status: 'cancelled' });
  const notes = mkSub({
    id: 'pn',
    name: 'Plain Notes',
    price: 5,
    start: '2026-08-01',
    payments: ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'].map((date, i) => ({ id: `n${i}`, date, amount: 5 })),
  });
  const res = prepareSubWrite(notes, { ...notes, bundle: { parentId: 'px' } }, today, mkState([parent, notes]));
  assert.equal('error' in res && res.error, 'Linking would change past charges or service. Link from the link date under History → Switch plan instead.');

  // The same link to a parent that covers the whole history saves
  const active = mkSub({ id: 'pa', name: 'Active', price: 20, start: '2026-01-01' });
  assert.ok(!('error' in prepareSubWrite(notes, { ...notes, bundle: { parentId: 'pa' } }, today, mkState([active, notes]))));
});

test('linking in place to a parent that was paused in the past is refused; a plan switch after the pause still saves', () => {
  const today = '2026-04-01';
  const parent = mkSub({ id: 'pp', name: 'Paused Once', price: 20, start: '2025-12-01', pauses: [{ from: '2026-02-01', to: '2026-03-01' }] });
  const perk = mkSub({ id: 'pk', name: 'Perk', price: 0, start: '2026-01-01' });
  const refs = mkState([parent, perk]);
  const res = prepareSubWrite(perk, { ...perk, bundle: { parentId: 'pp' } }, today, refs);
  assert.equal('error' in res && res.error, 'Linking would change past charges or service. Link from the link date under History → Switch plan instead.');
  // Independent mode does not follow the parent's pauses
  assert.ok(!('error' in prepareSubWrite(perk, { ...perk, bundle: { parentId: 'pp', follow: false } }, today, refs)));
  // Switching from a day after the pause keeps the earlier history intact
  const switched = switchPlan(perk, '2026-03-15', { price: 0, currency: 'USD', cycle: { unit: 'month', every: 1 }, bundle: { parentId: 'pp' } });
  assert.ok(!('error' in prepareSubWrite(perk, switched, today, refs)));
});

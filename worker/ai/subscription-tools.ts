import { preserveRenewalHistory, chargesBetween, currentPhase, effectiveStatus, phaseSubs, uid } from '../../shared/billing.ts';
import {
  editPhase,
  removePhase,
  changePrice,
  editPricePoint,
  removePricePoint,
  affectedPriceCharges,
  confirmPlan,
  deletePayment,
  dropPlan,
  prependPlan,
  resume,
  savePayment,
  switchPlan,
  syncPhase,
  toEditForm,
  stopSubscription,
  reactivate,
  cancelAtEnd,
  stopUndated,
  movePhaseStart,
} from '../../shared/phases.ts';
import { editStop } from '../../shared/stop-form.ts';
import { iconInput } from '../../shared/icon.ts';
import type { Payment, Subscription } from '../../shared/types.ts';
import { t } from '../../shared/i18n.ts';
import { billingSchema, drySchema, nullable, objectSchema as obj } from '../../shared/tool-schema.ts';
import { SUBSCRIPTION_SCHEMA } from '../../shared/subscription-schema.ts';
import { prepareSubWrite } from '../../shared/sub-write.ts';
import { validateCurrency, deleteSubscriptionSettings } from '../../shared/ledger-edit.ts';
import { cleanTransfers } from '../../shared/transfers.ts';
import { removeMeter, stableId } from '../../shared/meters.ts';
import type { Meter, Reading } from '../../shared/types.ts';
import type { Tool } from './tool-kit.ts';
import {
  state,
  findSub,
  DATE,
  SUBREF,
  SUBREF_EXACT,
  CYCLE,
  ICON_DESCRIPTION,
  SHIFT_BILLING,
  CATEGORY,
  CATEGORY_CREATE,
  FUNDING,
  decodeEntities,
  commit,
  persist,
  writeLedger,
  str,
  num,
  date,
  allPayments,
  refundInput,
  assertNotDuplicate,
  defaultCategory,
  methodRef,
  fundingOf,
  subscriptionCategory,
  dropNulls,
} from './tool-kit.ts';
import { row, fieldChanges, computedOf } from './tool-views.ts';

export const create_subscription: Tool = {
  name: 'create_subscription',
  description:
    'Create a subscription. price is per cycle in the given currency. Same name and start date with explicitly different login accounts are independent subscriptions. Otherwise a possible duplicate requires force=true. Use dry_run=true to preview first. Call list_categories first and reuse an existing code/name. Unknown categories fail; use save_category action=create or create_category=true with optional category_icon/category_color to explicitly create one. Past records can be created already stopped: status=cancelled with end = last service day, or status=cancelled / terminated without end when the stop date is unknown. method=null creates it without a payment method (no default). For a complete record with phases or stop details use save_subscription.',
  write: true,
  inputSchema: obj(
    {
      name: { type: 'string' },
      price: { type: 'number', minimum: 0 },
      currency: { type: 'string', description: 'ISO code, e.g. USD, CNY, TRY.' },
      cycle: CYCLE,
      billing: billingSchema,
      start: { ...DATE, description: 'First charge / purchase date (postpaid: first service day). Defaults to today.' },
      category: { ...CATEGORY, description: `${CATEGORY.description} Defaults to the existing Tools category; if absent, specify an existing category.` },
      ...CATEGORY_CREATE,
      tags: { type: 'array', items: { type: 'string' } },
      method: {
        type: ['string', 'null'],
        description: 'Payment method id or name. Omitted uses the default payment method; null means no payment method.',
      },
      region: { type: 'string', description: 'ISO country code for region-priced stores (App Store TR, NG…).' },
      url: { type: 'string' },
      icon: { type: 'string', description: ICON_DESCRIPTION },
      notes: { type: 'string' },
      account: { type: 'string', description: 'Login account: email, phone number (for carriers) or username shown on the receipt.' },
      status: {
        type: 'string',
        enum: ['active', 'trial', 'cancelled', 'terminated'],
        default: 'active',
        description:
          'cancelled / terminated: already stopped. cancelled + end: did not renew after end (last service day). terminated + end: the provider disabled it on end. Without end the stop date is unknown.',
      },
      trial_end: DATE,
      chargeLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
      cancelLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
      end: { ...DATE, description: 'Will not renew after this date.' },
      intro: {
        type: 'object',
        properties: { price: { type: 'number' }, until: DATE },
        required: ['price', 'until'],
        description: 'Intro price until a date.',
      },
      payments: {
        type: 'array',
        description:
          'Actual past charges with their real amounts (e.g. a monthly bill history). When given they become the whole charge history, so include EVERY period, including ones equal to price; future charges continue at price from the last one. Dates on or after start and not after today.',
        items: obj(
          {
            date: DATE,
            amount: { type: 'number', minimum: 0, description: 'Positive; refunds are stored negative.' },
            kind: { type: 'string', enum: ['charge', 'refund', 'adjust', 'failed'], default: 'charge' },
            method: {
              type: ['string', 'null'],
              description: 'Payment method id or name used for this one charge; omitted or null uses the subscription method.',
            },
            settled: obj({ amount: { type: 'number', minimum: 0 }, currency: { type: 'string' } }, ['amount', 'currency']),
            funding: FUNDING,
            note: { type: 'string' },
          },
          ['date', 'amount'],
        ),
      },
      force: { type: 'boolean', default: false },
      id: { type: 'string', description: 'Internal: keep this id (used when confirming an earlier draft).' },
      dry_run: drySchema,
    },
    ['name', 'price', 'currency', 'cycle'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const name = decodeEntities(String(a.name ?? '').trim());
    const start = date(a.start, 'start', today);
    const currency = String(a.currency ?? '').toUpperCase();
    // 历史扣款：按日期排序，必须落在开始日到今天之间
    const payments = (Array.isArray(a.payments) ? (a.payments as Array<Record<string, unknown>>) : [])
      .map((p): Payment => {
        const d = date(p.date, 'payments.date');
        if (d < start || d > today) throw new Error(t('mcp.error.paymentOutOfRange', { date: d }));
        const kind = str(p.kind) ?? 'charge';
        const sign = kind === 'refund' ? -1 : 1;
        const settled = p.settled as { amount: unknown; currency: unknown } | undefined;
        const funding = fundingOf(st, p.funding, sign);
        if (funding && p.method != null) throw new Error(t('core.subError.funding'));
        return {
          date: d,
          amount: sign * Math.abs(num(p.amount, 'payments.amount')),
          ...(kind !== 'charge' ? { kind: kind as Payment['kind'] } : {}),
          ...(settled ? { settled: { amount: sign * Math.abs(num(settled.amount, 'settled.amount')), currency: String(settled.currency).toUpperCase() } } : {}),
          ...(p.method != null ? { methodId: methodRef(st, p.method) } : {}),
          ...(funding ? { funding } : {}),
          ...(str(p.note) ? { note: str(p.note) } : {}),
        };
      })
      .sort((x, y) => x.date.localeCompare(y.date));
    if (!st.fx.rates[currency]) throw new Error(t('mcp.error.unsupportedCurrency', { code: currency }));
    const account = str(a.account)?.trim();
    if (!a.force) assertNotDuplicate(st, name, start, account);
    const category = a.category === undefined ? { name: defaultCategory(st) } : subscriptionCategory(st, a.category, a);
    const cyc = a.cycle as { unit: Subscription['cycle']['unit']; every?: number };
    let sub: Subscription = {
      // 确认草稿时沿用草稿里生成的 id，后续基于它的草稿（合租、成员）才能对上
      id: str(a.id) && !st.subscriptions.some((s) => s.id === str(a.id)) ? str(a.id)! : uid(),
      name,
      category: category.name,
      tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
      price: num(a.price, 'price'),
      currency,
      cycle: { unit: cyc?.unit, every: Math.max(1, Number(cyc?.every ?? 1)) },
      ...(a.billing === 'postpaid' ? { billing: 'postpaid' as const } : {}),
      start,
      chargeLeadDays: a.chargeLeadDays == null ? undefined : Number(a.chargeLeadDays),
      cancelLeadDays: a.cancelLeadDays == null ? undefined : Number(a.cancelLeadDays),
      status: (['trial', 'cancelled', 'terminated'].includes(String(a.status)) ? a.status : 'active') as Subscription['status'],
      // null 明确不绑定支付方式；省略时才用默认的
      methodId: a.method === null ? undefined : (methodRef(st, a.method) ?? st.settings.defaultMethodId),
      region: str(a.region)?.toUpperCase(),
      url: str(a.url),
      icon: iconInput(a.icon),
      notes: str(a.notes),
      account,
      trialEnd: a.trial_end ? date(a.trial_end, 'trial_end') : undefined,
      end: a.end ? date(a.end, 'end') : undefined,
      intro: a.intro
        ? { price: num((a.intro as { price: unknown }).price, 'intro.price'), until: date((a.intro as { until: unknown }).until, 'intro.until') }
        : undefined,
      ...(payments.length ? { payments } : {}),
      createdAt: today,
    };
    if (sub.end && sub.end < start) throw new Error(t('mcp.error.stopBeforeStart'));
    // 被停用且知道日期：按提供方停用记一个 stop（原已付服务期由计费规则推出）
    if (sub.status === 'terminated' && sub.end) {
      if (sub.end > today) throw new Error(t('mcp.error.invalidStop'));
      sub = stopSubscription({ ...sub, status: 'active', end: undefined }, today, 'terminate', sub.end);
    }
    return commit(ctx, st, today, sub, a.dry_run, ['created'], category.creation);
  },
};

export const save_subscription: Tool = {
  name: 'save_subscription',
  description:
    'Create or fully replace one subscription from a complete Subscription record (same shape as get_subscription.record): phases, payments with per-charge methodId / settled / kind (refund, adjust, failed) / funding (split across sources), status (active, trial, paused, cancelled, terminated), stop and end. Use it to enter a whole history at once (several phases, region or plan switches, every past charge) or to record an already-stopped subscription; for single edits prefer the narrower tools. The record is the entire new state, stored as given like the web editor’s save (keep top-level price/currency/cycle/methodId equal to the last phase): omitted fields are removed and null values are dropped; methodId absent or null means no payment method (no default is applied). cancelled / terminated without end or stop means stopped on an unknown date. Runs the same normalization and validation as saving in the web editor (renewal-rule history, clearing a member exit clears its refund, full-record and status-transition checks); referenced payment methods must exist. Without id, or with an id that does not exist, it creates a subscription; a same-name same-start duplicate then requires force=true. Preview returns changes (field-level before/after against the stored record) and computed before/after: status, next charge, last charge, total spent to date and charge count.',
  write: true,
  destructive: true,
  inputSchema: obj(
    {
      subscription: SUBSCRIPTION_SCHEMA,
      force: { type: 'boolean', default: false },
      ...CATEGORY_CREATE,
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const raw = dropNulls(a.subscription) as Partial<Subscription>;
    const previous = raw.id ? st.subscriptions.find((s) => s.id === raw.id) : undefined;
    const name = decodeEntities(String(raw.name ?? '').trim());
    const start = String(raw.start ?? '');
    if (!['active', 'trial', 'paused', 'cancelled', 'terminated'].includes(String(raw.status)))
      throw new Error(t('mcp.error.invalidInput', { field: 'subscription.status' }));
    if (!previous && !a.force) assertNotDuplicate(st, name, start, str(raw.account)?.trim());
    // 原分类不变时照旧（包括历史名称）；改了或新建时按分类规则解析
    const category =
      raw.category == null
        ? previous
          ? { name: previous.category }
          : { name: defaultCategory(st) }
        : previous && raw.category === previous.category
          ? { name: previous.category }
          : subscriptionCategory(st, raw.category, a);
    const { updatedAt: _u, ...rest } = raw;
    const next = {
      ...rest,
      id: previous?.id ?? str(raw.id) ?? uid(),
      name,
      category: category.name,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      createdAt: previous?.createdAt ?? str(raw.createdAt) ?? today,
    } as Subscription;
    const prepared = prepareSubWrite(previous, next, today, st);
    if (prepared.error !== undefined) throw new Error(prepared.error);
    const after = prepared.sub;
    const { updatedAt: _b, ...stored } = previous ?? ({} as Subscription);
    const changes = fieldChanges(previous ? stored : {}, after);
    return persist(ctx, st, today, after, a.dry_run, [previous ? 'replaced' : 'created'], category.creation, {
      changes: changes.slice(0, 300),
      ...(changes.length > 300 ? { changes_truncated: changes.length - 300 } : {}),
      computed: { before: previous ? computedOf(st, previous, today) : null, after: computedOf(st, after, today) },
    });
  },
};

export const update_subscription: Tool = {
  name: 'update_subscription',
  description:
    'Change descriptive fields and settings of a subscription (name, category, tags, url, notes, icon, payment method, region, billing (prepaid / postpaid), reminder days, start, end date (no renewal after it), next due date, trial end). Only provided keys change. A start correction keeps the original billing anchor and future charge dates (preview next_charges) unless shift_billing=true. For price changes use change_price; for plan/region switches use change_plan. Call list_categories before assigning a category. Unknown names fail; use save_category action=create or create_category=true with optional category_icon/category_color to explicitly create one.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      set: obj({
        icon: { type: ['string', 'null'], description: `${ICON_DESCRIPTION} null clears it.` },
        show_on_public: { type: 'boolean' },
        start: { ...DATE, description: 'Service start (single-phase only). Keeps the billing anchor unless shift_billing=true.' },
        intro: {
          type: ['object', 'null'],
          properties: { price: { type: 'number', minimum: 0 }, until: DATE },
          required: ['price', 'until'],
          additionalProperties: false,
        },
        bonus: { type: ['object', 'null'], properties: { from: DATE, until: DATE }, required: ['from', 'until'], additionalProperties: false },
        name: { type: 'string' },
        category: CATEGORY,
        tags: { type: 'array', items: { type: 'string' } },
        url: { type: 'string' },
        manage_url: { type: 'string' },
        notes: { type: 'string' },
        account: { type: 'string', description: 'Login account (email / phone / username).' },
        method: { type: ['string', 'null'], description: 'Payment method id or name.' },
        region: { type: 'string' },
        billing: { ...nullable(billingSchema), description: `${billingSchema.description} Applies to the current phase.` },
        remind_days: { type: ['integer', 'null'], minimum: -1, description: '-1 disables; null restores the global setting.' },
        end: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear (will renew again).' },
        next_due: { type: ['string', 'null'] },
        trial_end: { type: ['string', 'null'] },
        expires: { type: ['string', 'null'] },
        chargeLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
        cancelLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
      }),
      ...CATEGORY_CREATE,
      shift_billing: SHIFT_BILLING,
      dry_run: drySchema,
    },
    ['subscription', 'set'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    const set = (a.set ?? {}) as Record<string, unknown>;
    // 改开始日与网页同一套：默认保留原扣款锚点（之后的扣款日不变），shift_billing=true 才整体平移
    let base = s;
    if ('start' in set) {
      if (s.phases?.length) throw new Error(t('mcp.error.invalidInput', { field: 'start: use change_plan edit for phased subscriptions' }));
      base = movePhaseStart(s, s.start, date(set.start, 'start'), { shiftBilling: a.shift_billing === true });
    } else if (a.shift_billing != null) throw new Error(t('mcp.error.invalidInput', { field: 'shift_billing requires set.start' }));
    // 多段订阅：顶层字段先换成今天所在的那段，改完再同步回去
    const next: Subscription = toEditForm({ ...base }, today);
    const changed: string[] = [];
    const put = <K extends keyof Subscription>(k: K, v: Subscription[K], label = String(k)) => {
      next[k] = v;
      changed.push(label);
    };
    if ('chargeLeadDays' in set) put('chargeLeadDays', Number(set.chargeLeadDays));
    if ('cancelLeadDays' in set) put('cancelLeadDays', Number(set.cancelLeadDays));
    if ('icon' in set) put('icon', iconInput(set.icon));
    if ('show_on_public' in set) put('showOnPublic', set.show_on_public as boolean);
    if ('start' in set) changed.push('start');
    if ('intro' in set) put('intro', set.intro == null ? undefined : (set.intro as Subscription['intro']));
    if ('bonus' in set) put('bonus', set.bonus == null ? undefined : (set.bonus as Subscription['bonus']));
    if ('name' in set) put('name', String(set.name).trim());
    const category = 'category' in set ? subscriptionCategory(st, set.category, a) : undefined;
    if (category) put('category', category.name);
    if ('tags' in set) put('tags', Array.isArray(set.tags) ? set.tags.map(String) : []);
    if ('url' in set) put('url', str(set.url));
    if ('manage_url' in set) put('manageUrl', str(set.manage_url), 'manage_url');
    if ('notes' in set) put('notes', str(set.notes));
    if ('account' in set) put('account', str(set.account));
    if ('method' in set) put('methodId', methodRef(st, set.method), 'method');
    if ('region' in set) put('region', str(set.region)?.toUpperCase());
    if ('billing' in set) put('billing', set.billing === 'postpaid' ? 'postpaid' : undefined);
    if ('remind_days' in set) put('remindDays', set.remind_days == null ? undefined : Number(set.remind_days), 'remind_days');
    for (const [k, f] of [
      ['end', 'end'],
      ['next_due', 'nextDue'],
      ['trial_end', 'trialEnd'],
      ['expires', 'expires'],
    ] as const) {
      if (k in set) put(f, set[k] == null ? undefined : date(set[k], k), k);
    }
    if (!changed.length) throw new Error(t('mcp.error.noFields'));
    return commit(ctx, st, today, syncPhase(preserveRenewalHistory(base, next, today), today), a.dry_run, changed, category?.creation);
  },
};

export const change_price: Tool = {
  name: 'change_price',
  description:
    'Add (default), edit or remove a dated price point in an existing plan. edit/remove require phase and original_from. The initial price can be edited but not removed. Dates must be within the phase and unique. Past estimated charges are recalculated; recorded payments stay unchanged. Preview reports affected_estimated_charges.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      action: {
        type: 'string',
        enum: ['add', 'edit', 'remove'],
        description: 'Default add (upsert by date). edit/remove target an existing point using phase and original_from. The initial point cannot be removed.',
      },
      phase: { ...DATE, description: 'Exact phase start; required for edit/remove, including single-phase subscriptions.' },
      original_from: { ...DATE, description: 'Original effective date; required for edit/remove.' },
      amount: { type: 'number', minimum: 0 },
      from: { ...DATE, description: 'Effective date; defaults to today for add, original_from for edit.' },
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    const action = a.action ?? 'add';
    const phase = action === 'add' ? undefined : date(a.phase, 'phase');
    const original = action === 'add' ? undefined : date(a.original_from, 'original_from');
    const after =
      action === 'remove'
        ? removePricePoint(s, phase!, original!)
        : action === 'edit'
          ? editPricePoint(s, phase!, original!, { from: date(a.from, 'from', original), amount: num(a.amount, 'amount') })
          : changePrice(s, date(a.from, 'from', today), num(a.amount, 'amount'));
    return { ...(await commit(ctx, st, today, after, a.dry_run, ['price'])), affected_estimated_charges: affectedPriceCharges(s, after, today) };
  },
};

export const change_plan: Tool = {
  name: 'change_plan',
  destructive: true,
  description:
    'Correct an existing phase using action=edit, at=its exact start date, set=only changed fields (camelCase; null clears); preserves unrelated phases and payments. set.start moves the phase start like the web editor: recorded payments, stops and the billing anchor stay, so future charge dates are unchanged (preview next_charges); shift_billing=true moves the anchor too. action=remove deletes that phase and its payments, requires at least two phases; remove and drop accept only the subscription id or exact full name. Preview before rewriting history. Start a new phase of the same subscription: switch plan, region, currency or payment method from a date (action=switch), resubscribe after a gap or provider termination (action=resume, preserves the stopped phase), add missing history BEFORE the subscription’s start (action=earlier: at = when that earlier phase began, e.g. a one-time purchase before it became a subscription; it runs until the current first phase starts, or until earlier_until if there was a gap), or confirm / drop a planned future phase (action=confirm|drop, at = that phase’s start). Set plan.planned=true for an uncertain future switch. For action=switch, keep_previous_until keeps the previous phase running (and billing) in parallel until that date — e.g. a new Turkey account while the prepaid US one runs out; omit it for a seamless switch.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      action: { type: 'string', enum: ['switch', 'resume', 'earlier', 'confirm', 'drop', 'edit', 'remove'] },
      at: DATE,
      set: obj({
        start: { ...DATE, description: 'New phase start; keeps the billing anchor unless shift_billing=true.' },
        end: { type: ['string', 'null'], format: 'date' },
        price: { type: 'number', minimum: 0 },
        currency: { type: 'string' },
        cycle: CYCLE,
        billing: nullable(billingSchema),
        method: { type: ['string', 'null'] },
        region: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
        nextDue: { type: ['string', 'null'], format: 'date' },
        planned: { type: 'boolean' },
        priceHistory: {
          type: ['array', 'null'],
          description:
            'Full replacement, retaining the initial effective date; use change_price action=edit to move that initial date. Latest amount becomes phase price.',
          items: obj({ from: DATE, amount: { type: 'number', minimum: 0 } }, ['from', 'amount']),
        },
        intro: {
          type: ['object', 'null'],
          properties: { price: { type: 'number', minimum: 0 }, until: DATE },
          required: ['price', 'until'],
          additionalProperties: false,
        },
        bonus: { type: ['object', 'null'], properties: { from: DATE, until: DATE }, required: ['from', 'until'], additionalProperties: false },
      }),
      plan: obj(
        {
          price: { type: 'number' },
          currency: { type: 'string' },
          cycle: CYCLE,
          billing: billingSchema,
          method: { type: ['string', 'null'] },
          region: { type: 'string' },
          note: { type: 'string' },
          planned: { type: 'boolean' },
        },
        ['price', 'currency', 'cycle'],
      ),
      keep_previous_until: {
        ...DATE,
        description: 'action=switch only: the previous phase keeps running until this date (after `at`), overlapping the new one.',
      },
      earlier_until: { ...DATE, description: 'action=earlier only: the earlier phase ended on this date (a gap before the next one).' },
      shift_billing: SHIFT_BILLING,
      dry_run: drySchema,
    },
    ['subscription', 'action', 'at'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const act = String(a.action);
    const s = findSub(st, a.subscription, { exact: act === 'remove' || act === 'drop' });
    const at = date(a.at, 'at');
    if (act === 'edit' || act === 'remove') {
      const phases = s.phases?.length ? s.phases : [{ ...s, phases: undefined }];
      const index = phases.findIndex((p) => p.start === at);
      if (index < 0 || (act === 'remove' && phases.length < 2)) throw new Error(t('mcp.error.invalidTarget'));
      const patch = { ...((a.set ?? {}) as Record<string, unknown>) };
      if ('method' in patch) {
        patch.methodId = methodRef(st, patch.method) ?? null;
        delete patch.method;
      }
      if (patch.currency) validateCurrency(st, String(patch.currency));
      if (a.shift_billing != null && (act !== 'edit' || patch.start == null))
        throw new Error(t('mcp.error.invalidInput', { field: 'shift_billing requires set.start' }));
      // 改开始日走网页同一个 movePhaseStart（保留扣款锚点）；其余字段再按新开始日修改
      const { start: moveTo, ...rest } = patch;
      const moved =
        act === 'edit' && moveTo != null && moveTo !== at ? movePhaseStart(s, at, date(moveTo, 'set.start'), { shiftBilling: a.shift_billing === true }) : s;
      const target = act === 'edit' && moveTo != null ? String(moveTo) : at;
      const after = act === 'remove' ? removePhase(s, index) : Object.keys(rest).length ? editPhase(moved, target, rest) : moved;
      return {
        ...(await commit(ctx, st, today, after, a.dry_run, [act])),
        affected_estimated_charges: affectedPriceCharges(s, after, today),
        before: phases[index],
        after: act === 'remove' ? null : (after.phases?.find((p) => p.start === target) ?? phaseSubs(after).find((p) => p.start === target)),
        references: { subscription: s.id, phase: at, removed_payments: act === 'remove' ? (phases[index].payments ?? []) : [] },
      };
    }
    if (act === 'confirm') return commit(ctx, st, today, confirmPlan(s, at), a.dry_run, ['confirm_plan']);
    if (act === 'drop') return commit(ctx, st, today, dropPlan(s, at), a.dry_run, ['drop_plan']);
    const p = a.plan as Record<string, unknown> | undefined;
    if (!p) throw new Error(t('mcp.error.needPlan'));
    const cyc = p.cycle as { unit: Subscription['cycle']['unit']; every?: number };
    const plan = {
      price: num(p.price, 'plan.price'),
      currency: String(p.currency).toUpperCase(),
      cycle: { unit: cyc.unit, every: Math.max(1, Number(cyc.every ?? 1)) },
      ...(p.billing === 'postpaid' ? { billing: 'postpaid' as const } : {}),
      methodId: 'method' in p ? methodRef(st, p.method) : currentPhase(s, today).methodId,
      region: str(p.region)?.toUpperCase(),
      note: str(p.note),
      planned: p.planned ? true : undefined,
    };
    if (!st.fx.rates[plan.currency]) throw new Error(t('mcp.error.unsupportedCurrency', { code: plan.currency }));
    if (act === 'earlier')
      return commit(ctx, st, today, prependPlan(s, at, plan, a.earlier_until != null ? date(a.earlier_until, 'earlier_until') : undefined), a.dry_run, [act]);
    const keep = act === 'switch' && a.keep_previous_until != null ? date(a.keep_previous_until, 'keep_previous_until') : undefined;
    return commit(
      ctx,
      st,
      today,
      act === 'resume' ? resume(s, at, plan) : switchPlan(s, at, plan, keep),
      a.dry_run,
      keep ? [act, 'keep_previous_until'] : [act],
    );
  },
};

export const set_status: Tool = {
  name: 'set_status',
  description:
    'Mark as trial (action=trial, trial_end is the first paid charge date; null clears; stopped subscriptions must resume a new phase first); pause (recoverable); cancel with immediate=false (default): do not renew after at, the last service day; cancel with immediate=true: voluntarily stop using it on at; terminate: provider disabled access on at, with optional reason. Immediate cancel and terminate compute the original paidThrough and accept an optional refund (positive amount, stored negative in the subscription currency; settled is the actual card refund). Omit refund when no refund information was supplied; never invent one. The tool derives paidThrough from the existing billing history, so the user need not confirm automatically inferred charges before you stop it. Inferred charges in a stopped gap disappear when the status and resumed phase dates change; do not delete or ask to confirm those estimates as if they were recorded payments. When the user supplies both the termination date and the later restart date/price/cycle, terminate at the supplied date, then change_plan action=resume; no optional refund clarification is required to make those known changes. Preview includes paidThrough, suggestedRefund, unusedDays, unusedValue and wastedDays. Terminated subscriptions cannot reactivate; use change_plan action=resume to resubscribe with a new phase. Reactivate clears pause, stop and end for other subscriptions. To correct an existing stop (date, non-renewal vs immediate cancel, reason, refund) pass edit=true with action=cancel|terminate; omitted fields keep the recorded values and a provider termination stays terminate. An undated stop needs its real date in at. cancel / terminate never assume today for a subscription that started or was charged before today: pass the actual date in at, or at=null when the user only knows it has stopped (stored as cancelled / terminated with no end or stop date; no refund or reason then).',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      action: { type: 'string', enum: ['pause', 'cancel', 'terminate', 'reactivate', 'trial'] },
      at: {
        ...DATE,
        type: ['string', 'null'],
        description:
          'Non-immediate cancel: last service day. Immediate cancel / terminate: actual stop day. Required for cancel / terminate when the subscription started or has charges before today; null = stopped on an unknown date. pause / trial default to today.',
      },
      trial_end: { ...DATE, type: ['string', 'null'], description: 'trial only: first paid charge date; null clears, omitted preserves the existing value.' },
      immediate: { type: 'boolean', default: false, description: 'cancel only: stop using the service immediately instead of non-renewal.' },
      reason: { type: 'string', description: 'Optional provider termination reason; terminate only.' },
      refund: {
        ...obj(
          {
            amount: { type: 'number', minimum: 0 },
            date: DATE,
            currency: { type: 'string', description: 'Must equal the subscription currency; usually omit.' },
            settled: obj({ amount: { type: 'number', minimum: 0 }, currency: { type: 'string' } }, ['amount', 'currency']),
          },
          ['amount'],
        ),
        type: ['object', 'null'],
        description: 'Immediate cancel / terminate only. With edit=true it replaces the latest stop refund; null removes it; omitted keeps it.',
      },
      edit: {
        type: 'boolean',
        default: false,
        description:
          'Correct an already stopped subscription with action=cancel|terminate: change the stop date (at; omitted keeps it), non-renewal vs immediate cancel, reason or refund. Provider termination cannot become cancel.',
      },
      dry_run: drySchema,
    },
    ['subscription', 'action'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    const act = String(a.action);
    const stopping = act === 'cancel' || act === 'terminate';
    // 修改已有停用：与网页停用表单同一套（先重开再停用），省略的字段保留原值
    if (a.edit === true) {
      if (!stopping) throw new Error(t('mcp.error.invalidStop'));
      if (a.at === null) throw new Error(t('mcp.error.editStopDate'));
      const next = editStop(
        s,
        {
          mode: act === 'terminate' ? 'terminate' : a.immediate === true ? 'cancel' : 'nonrenew',
          date: a.at === undefined ? undefined : date(a.at, 'at'),
          reason: 'reason' in a ? (str(a.reason) ?? null) : undefined,
          refund: a.refund === null ? null : a.refund ? refundInput(a.refund) : undefined,
        },
        today,
      );
      return commit(ctx, st, today, next, a.dry_run, [act, 'edit_stop']);
    }
    // 停用不默认今天：已经开始或付过钱的订阅，今天未必是真实的停用日，需显式给出（或 null 表示日期未知）
    if (stopping && a.at === undefined) {
      const paid = allPayments(s).some((p) => p.date < today);
      if (paid || s.start < today) throw new Error(t('mcp.error.stopDateRequired'));
    }
    if (stopping && a.at === null) {
      if (a.refund || a.reason) throw new Error(t('mcp.error.unknownStopDetails'));
      return commit(ctx, st, today, stopUndated(s, act === 'terminate' ? 'terminate' : 'cancel', today), a.dry_run, [act, 'date_unknown']);
    }
    const at = date(a.at ?? undefined, 'at', today);
    let next: Subscription;
    if (act === 'reactivate') next = reactivate(s, today);
    else if (act === 'terminate' || (act === 'cancel' && a.immediate === true)) {
      next = stopSubscription(s, today, act === 'terminate' ? 'terminate' : 'cancel', at, str(a.reason), a.refund ? refundInput(a.refund, at) : undefined);
    } else {
      if (['ended', 'terminated'].includes(effectiveStatus(s, today)) || s.stop) throw new Error(t('mcp.error.subscriptionEnded'));
      if (act === 'trial')
        next = {
          ...s,
          status: 'trial',
          pausedAt: undefined,
          trialEnd: 'trial_end' in a ? (a.trial_end == null ? undefined : date(a.trial_end, 'trial_end')) : s.trialEnd,
        };
      else if (act === 'pause') next = { ...s, status: 'paused', pausedAt: at };
      else if (act === 'cancel') {
        if (a.refund) throw new Error(t('mcp.error.invalidStop'));
        next = cancelAtEnd(s, at, today);
      } else throw new Error(t('mcp.error.invalidStop'));
    }
    return commit(ctx, st, today, next, a.dry_run, [act]);
  },
};

export const record_payment: Tool = {
  name: 'record_payment',
  description:
    'Record or replace an actual charge (replace={date,index}, same-day zero-based index; phase selects overlapping history), refund (positive amount — stored negative; total refunds cannot exceed the current period paid amount), adjustment or failed charge for a subscription, in the subscription’s currency. Optional currency must equal the selected phase currency for every kind (charge, refund, adjust, failed); a different card currency belongs in settled. settled = what the card was actually charged in another currency (e.g. TRY subscription billed in USD). method = payment method (id or name) used for this one charge when it differs from the phase’s method; null clears it; omitted keeps a replaced charge’s own method. funding = one order paid from several sources (amounts in the subscription currency summing to amount, e.g. 178.80 = PayPal 168.05 + Balance 10.75); wallet balances are reduced by each part. funding and method are exclusive; null clears a split; omitted keeps a replaced charge’s split. Rejects same-day same-amount duplicates unless allow_duplicate.',
  write: true,
  inputSchema: obj(
    {
      replace: obj({ date: DATE, index: { type: 'integer', minimum: 0 } }, ['date', 'index']),
      subscription: SUBREF,
      date: { ...DATE, description: 'Defaults to today.' },
      amount: { type: 'number', minimum: 0 },
      currency: {
        type: 'string',
        description: 'Must equal the subscription / selected phase currency for every kind; usually omit. Use settled for a different card currency.',
      },
      kind: { type: 'string', enum: ['charge', 'refund', 'adjust', 'failed'], default: 'charge' },
      settled: obj({ amount: { type: 'number' }, currency: { type: 'string' } }, ['amount', 'currency']),
      method: { type: ['string', 'null'], description: 'Payment method id or name for this single charge; null clears it.' },
      funding: FUNDING,
      note: { type: 'string' },
      allow_duplicate: { type: 'boolean', default: false },
      phase: {
        ...DATE,
        description: 'Start date of the phase this payment belongs to; only needed when two phases overlap on that date (defaults to the latest-started one).',
      },
      dry_run: drySchema,
    },
    ['subscription', 'amount'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    const d = date(a.date, 'date', today);
    const kind = str(a.kind) ?? 'charge';
    const sign = kind === 'refund' ? -1 : 1;
    const amount = sign * Math.abs(num(a.amount, 'amount'));
    const existing = chargesBetween(s, d, d, today).filter((c) => !c.projected && Math.abs(c.amount - amount) < 0.005);
    const isRecorded = allPayments(s).some((p) => p.date === d && Math.abs(p.amount - amount) < 0.005);
    if (isRecorded && existing.length && !a.allow_duplicate && !a.replace) throw new Error(t('mcp.error.duplicatePayment', { date: d, amount }));
    const st2 = a.settled as { amount: unknown; currency: unknown } | undefined;
    if (a.funding != null && a.method != null) throw new Error(t('core.subError.funding'));
    const pay: Payment = {
      date: d,
      currency: str(a.currency)?.toUpperCase(),
      amount,
      kind: kind === 'charge' ? undefined : (kind as Payment['kind']),
      settled: st2 ? { amount: sign * Math.abs(num(st2.amount, 'settled.amount')), currency: String(st2.currency).toUpperCase() } : undefined,
      note: str(a.note),
      // 只有显式给了 method（含 null）才带这个键；不给时改写沿用原来那一笔的支付方式
      ...(a.method !== undefined ? { methodId: a.method === null ? undefined : methodRef(st, a.method) } : {}),
      // 拆分同理：给了（含 null）才带键；给了拆分就清掉单独的支付方式
      ...(a.funding !== undefined ? { funding: fundingOf(st, a.funding, sign) } : {}),
      ...(a.funding != null ? { methodId: undefined } : {}),
    };
    return commit(
      ctx,
      st,
      today,
      savePayment(s, today, pay, a.replace as { date: string; index: number } | undefined, a.phase != null ? date(a.phase, 'phase') : undefined),
      a.dry_run,
      ['payment'],
    );
  },
};

export const delete_payment: Tool = {
  name: 'delete_payment',
  description: 'Delete one recorded payment of a subscription by date (index picks among several on the same day, 0-based).',
  write: true,
  destructive: true,
  inputSchema: obj(
    {
      subscription: SUBREF_EXACT,
      date: DATE,
      index: { type: 'integer', default: 0 },
      phase: { ...DATE, description: 'Start date of the phase holding the payment, when two phases overlap.' },
      dry_run: drySchema,
    },
    ['subscription', 'date'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription, { exact: true });
    return commit(
      ctx,
      st,
      today,
      deletePayment(s, today, date(a.date, 'date'), Number(a.index ?? 0), a.phase != null ? date(a.phase, 'phase') : undefined),
      a.dry_run,
      ['delete_payment'],
    );
  },
};

export const record_transfer: Tool = {
  name: 'record_transfer',
  description:
    'Record, replace or delete a transfer of a subscription between owners (e.g. a second-hand VPS): kind=buy is the cash paid to the previous owner when taking it over, kind=sell is the cash received when handing it on. amount is the actual cash (positive), in any currency (converted at the transfer date); do not estimate residual value. Transfers count in lifetime net cost (service charges + buy − sell, averaged over the holding period) and yearly/monthly cash flow, not in MRR, forecasts, wallet runway, refunds or charge counts; a sale inside a stopped phase’s paid period removes its paid-but-unused loss. replace={date,index} edits one (index = zero-based among that date’s transfers, as listed by get_subscription.transfers); delete={date,index} removes one.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      kind: { type: 'string', enum: ['buy', 'sell'] },
      date: { ...DATE, description: 'Defaults to today.' },
      amount: { type: 'number', minimum: 0 },
      currency: { type: 'string', description: 'ISO code; defaults to the subscription’s current currency.' },
      note: { type: 'string' },
      replace: obj({ date: DATE, index: { type: 'integer', minimum: 0 } }, ['date', 'index']),
      delete: obj({ date: DATE, index: { type: 'integer', minimum: 0 } }, ['date', 'index']),
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    if (s.proxy) throw new Error(t('mcp.error.transferProxy'));
    const list = s.transfers ?? [];
    const locate = (ref: unknown, field: string) => {
      const r = ref as { date: unknown; index: unknown };
      const d = date(r.date, `${field}.date`);
      const at = list.map((x, i) => [x, i] as const).filter(([x]) => x.date === d)[Number(r.index ?? 0)]?.[1];
      if (at == null) throw new Error(t('mcp.error.transferNotFound', { date: d }));
      return at;
    };
    let next: typeof list;
    if (a.delete) {
      const at = locate(a.delete, 'delete');
      next = list.filter((_, i) => i !== at);
    } else {
      const kind = str(a.kind);
      if (kind !== 'buy' && kind !== 'sell') throw new Error(t('mcp.error.invalidInput', { field: 'kind' }));
      const amount = num(a.amount, 'amount');
      if (!(amount > 0)) throw new Error(t('core.subError.transfer'));
      const currency = (str(a.currency) ?? currentPhase(s, today).currency).toUpperCase();
      validateCurrency(st, currency);
      const item = { kind, date: date(a.date, 'date', today), amount, currency, ...(str(a.note) ? { note: str(a.note)!.trim() } : {}) } as const;
      if (a.replace) {
        const at = locate(a.replace, 'replace');
        next = list.map((x, i) => (i === at ? item : x));
      } else next = [...list, item];
    }
    return commit(ctx, st, today, { ...s, transfers: cleanTransfers(next) }, a.dry_run, [a.delete ? 'delete_transfer' : 'transfer']);
  },
};

const METER_INPUT = obj(
  {
    id: { type: 'string', description: 'Existing meter id to update; omit to match by name or create a new meter.' },
    name: { type: 'string', description: 'Free text, e.g. Electricity, Mileage, Egress traffic.' },
    unit: { type: 'string', description: 'Free text, e.g. kWh, km, GB, times, L; may be empty.' },
    kind: {
      type: 'string',
      enum: ['usage', 'reading'],
      description: 'usage (default) = the amount used in that period; reading = a cumulative counter (odometer, meter reading), usage = this − previous.',
    },
  },
  [],
);

/** 指标引用：id，或名称（不区分大小写，须唯一） */
function findMeter(meters: Meter[], ref: string): Meter {
  const byId = meters.find((m) => m.id === ref);
  if (byId) return byId;
  const hits = meters.filter((m) => m.name.trim().toLowerCase() === ref.trim().toLowerCase());
  if (hits.length === 1) return hits[0];
  throw new Error(t('mcp.error.meterNotFound', { q: ref, list: meters.map((m) => t('mcp.item', { name: m.name, id: m.id })).join(t('mcp.sep')) || '—' }));
}

export const set_meters: Tool = {
  name: 'set_meters',
  description:
    'Define custom business meters on a subscription (anything the user tracks per period: electricity of a utility bill, car mileage, server egress traffic, calls…). Names and units are free text; nothing is built in. Each item in meters updates the meter with that id (or the same name, case-insensitive) or creates a new one; omitted fields keep their values. remove = meter ids to delete — their values are cleared from every reading and readings left empty are deleted (subscription must then be an id or exact name). Record values with add_readings; get_subscription.meters returns per-period usage, totals and unit price (period charges ÷ usage).',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      meters: { type: 'array', maxItems: 50, items: METER_INPUT },
      remove: { type: 'array', maxItems: 50, items: { type: 'string' }, description: 'Meter ids to delete together with their recorded values.' },
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const inputs = (a.meters as Array<Record<string, unknown>> | undefined) ?? [];
    const remove = (a.remove as string[] | undefined) ?? [];
    if (!inputs.length && !remove.length) throw new Error(t('mcp.error.invalidInput', { field: 'meters' }));
    const s = findSub(st, a.subscription, { exact: remove.length > 0 });
    let next: Subscription = s;
    for (const id of remove) {
      if (!(next.meters ?? []).some((m) => m.id === id))
        throw new Error(
          t('mcp.error.meterNotFound', { q: id, list: (s.meters ?? []).map((m) => t('mcp.item', { name: m.name, id: m.id })).join(t('mcp.sep')) || '—' }),
        );
      next = removeMeter(next, id);
    }
    const meters = [...(next.meters ?? [])];
    for (const input of inputs) {
      const id = str(input.id);
      const name = str(input.name)?.trim();
      const at = meters.findIndex((m) => (id ? m.id === id : !!name && m.name.trim().toLowerCase() === name.toLowerCase()));
      const kind = input.kind === 'reading' ? 'reading' : input.kind === 'usage' ? undefined : at >= 0 ? meters[at].kind : undefined;
      if (at >= 0) {
        const old = meters[at];
        const { kind: _k, ...rest } = old;
        meters[at] = { ...rest, ...(name ? { name } : {}), ...(input.unit != null ? { unit: String(input.unit).trim() } : {}), ...(kind ? { kind } : {}) };
        continue;
      }
      if (!name) throw new Error(t('core.subError.meter'));
      const taken = new Set(meters.map((m) => m.id));
      meters.push({ id: id ?? stableId('m', `${s.id}|${name.toLowerCase()}`, taken), name, unit: String(input.unit ?? '').trim(), ...(kind ? { kind } : {}) });
    }
    next = { ...next, meters: meters.length ? meters : undefined };
    return commit(ctx, st, today, next, a.dry_run, [remove.length ? 'remove_meters' : 'meters']);
  },
};

export const add_readings: Tool = {
  name: 'add_readings',
  description:
    'Record custom meter values on a subscription in bulk (e.g. import dozens of electricity bills at once). Each reading has a date (billing period / record day), values = {meter id or exact meter name: number} (only some meters may be filled) and an optional note. A reading with an existing id, or else on a date that already has a reading, is merged: given values overwrite, null removes that value, note replaces (null clears); otherwise a new reading is added. Readings left without values are deleted. delete = reading ids to remove. Define meters first with set_meters. Values are stored apart from payments; get_subscription.meters derives usage (cumulative readings: this − previous, none on rollback), totals and unit price (actual charges in the period after the previous reading up to this one ÷ usage).',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      readings: {
        type: 'array',
        maxItems: 500,
        items: obj(
          {
            id: { type: 'string', description: 'Existing reading id to edit (from get_subscription), or a stable new id.' },
            date: DATE,
            values: { type: 'object', additionalProperties: true, description: 'Meter id or exact name → number (null removes it).' },
            note: { type: ['string', 'null'] },
          },
          ['date'],
        ),
      },
      delete: { type: 'array', maxItems: 500, items: { type: 'string' }, description: 'Reading ids to delete.' },
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const inputs = (a.readings as Array<Record<string, unknown>> | undefined) ?? [];
    const remove = (a.delete as string[] | undefined) ?? [];
    if (!inputs.length && !remove.length) throw new Error(t('mcp.error.invalidInput', { field: 'readings' }));
    const s = findSub(st, a.subscription, { exact: remove.length > 0 });
    const meters = s.meters ?? [];
    if (inputs.length && !meters.length) throw new Error(t('mcp.error.noMeters'));
    let list: Reading[] = [...(s.readings ?? [])];
    for (const id of remove) {
      if (!list.some((r) => r.id === id)) throw new Error(t('mcp.error.readingNotFound', { q: id }));
      list = list.filter((r) => r.id !== id);
    }
    inputs.forEach((input, i) => {
      const day = date(input.date, `readings[${i}].date`);
      const id = str(input.id);
      const raw = input.values ?? {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('mcp.error.invalidInput', { field: `readings[${i}].values` }));
      const at = list.findIndex((r) => (id ? r.id === id : r.date === day));
      const values: Record<string, number> = at >= 0 ? { ...list[at].values } : {};
      for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
        const m = findMeter(meters, key);
        if (v === null) delete values[m.id];
        else if (typeof v === 'number' && Number.isFinite(v)) values[m.id] = v;
        else throw new Error(t('mcp.error.notNumber', { what: `readings[${i}].values.${key}` }));
      }
      const note = input.note === undefined ? (at >= 0 ? list[at].note : undefined) : str(input.note)?.trim();
      const item: Reading = {
        id: at >= 0 ? list[at].id : (id ?? stableId('r', `${s.id}|${day}`, new Set(list.map((r) => r.id)))),
        date: day,
        values,
        ...(note ? { note } : {}),
      };
      if (at >= 0) list[at] = item;
      else list.push(item);
    });
    list = list.filter((r) => Object.keys(r.values).length > 0);
    return commit(ctx, st, today, { ...s, readings: list.length ? list : undefined }, a.dry_run, [
      remove.length && !inputs.length ? 'delete_readings' : 'readings',
    ]);
  },
};

export const delete_subscription: Tool = {
  name: 'delete_subscription',
  description: 'Delete a subscription and its whole history. Irreversible: always preview with dry_run first; the user confirms.',
  write: true,
  destructive: true,
  inputSchema: obj({ subscription: SUBREF_EXACT, dry_run: drySchema }, ['subscription']),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription, { exact: true });
    const preview = {
      before: s,
      after: null,
      subscription: row(st, s, today),
      changed: ['deleted'],
      references: {
        phases: s.phases?.length ?? 1,
        payments: (s.payments?.length ?? 0) + (s.phases ?? []).reduce((n, p) => n + (p.payments?.length ?? 0), 0),
        share: s.share ?? null,
        proxy: s.proxy ?? null,
        default_public_hidden: st.settings.publicHidden?.includes(s.id) ?? false,
      },
    };
    return writeLedger(ctx, st, { settings: deleteSubscriptionSettings(st.settings, s.id), deletedSubscriptions: [s.id] }, preview, a.dry_run);
  },
};

import { dueTotal } from '../../shared/fx-total.ts';
import { cycleLabel, memberDues, memberCollection, collectionAnchor, memberBillMonths, memberPeriods, memberAboard, uid } from '../../shared/billing.ts';
import { setOpening } from '../../shared/receivables.ts';
import {
  deleteRecord,
  openPeriods,
  receivableOf,
  recordProxyCharge,
  recordReceipt,
  recordWaiver,
  type ReceivableTarget,
} from '../../shared/receivable-edit.ts';
import { personLink } from '../../shared/people.ts';
import { MAX_BILL_MONTHS, validBillMonths, type Receipt, type ShareMember, type Subscription } from '../../shared/types.ts';
import {
  applyCarRule,
  moveCollectFrom,
  waiveExemptSpan,
  suggestedLeaveRefund,
  updateMemberLeave,
  carLedger,
  carRule,
  followCarRule,
  memberFee,
  changeMemberFee,
  sameRule,
  shareFromFee,
} from '../../shared/carpool.ts';
import { t } from '../../shared/i18n.ts';
import { drySchema, objectSchema as obj } from '../../shared/tool-schema.ts';
import { validateCurrency } from '../../shared/ledger-edit.ts';
import type { Tool } from './tool-kit.ts';
import { state, findSub, findMember, findPerson, DATE, SUBREF, SUBREF_EXACT, commit, str, num, date, personTarget } from './tool-kit.ts';
import { money, fin, collectionSummary, ruleOut, collectCcy, partialOut } from './tool-views.ts';

export const get_carpool: Tool = {
  name: 'get_carpool',
  description:
    'Shared plans (carpools): for each plan I organize (role owner) or joined (role member): seats taken / total and free seats, the shared collection anchor (collect_from), the plan collection rule (rule: fee, currency, every_months; stored=false means inferred from the most common member rate); members with their actual leave_refund (null when not refunded), fee and billing months, follows_rule (true = fee follows the plan rule, false = custom fee or exempt), overdue_days (days the next unpaid collection is past due, 0 if not), alignment anchor, paid_until, first_collection (join date through aligned end, inclusive, and first fee), next_collection and next_collection_date (earliest unpaid coverage start, possibly overdue; free partial first periods are skipped), is_first_period (whether that next unpaid period is the first), and pending_amount (total currently owed, zero when nothing is due); per year: cost, expected income from members, and i_pay (what I still pay myself) or i_earn (profit when members pay more than the cost); since the carpool started: paid, received, and i_pay / i_earn to date. Amounts in the base currency unless noted.',
  inputSchema: obj({ subscription: { ...SUBREF, description: 'Optional: only this plan.' } }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const subs = a.subscription ? [findSub(st, a.subscription)] : st.subscriptions.filter((s) => s.share);
    const base = st.settings.baseCurrency;
    return {
      currency: base,
      plans: subs
        .filter((s) => s.share)
        .map((s) => {
          const sh = s.share!;
          const live = sh.members.filter((m) => memberAboard(m, today));
          const dues = new Map(memberDues(s, today, collectCcy(st), st).map((d) => [d.member.id, d]));
          const book = carLedger(st, s, today);
          return {
            id: s.id,
            name: s.name,
            role: sh.role,
            price: money(st, s.price, s.currency),
            cycle: cycleLabel(s.cycle),
            seats: { total: sh.seats, taken: live.length + 1, free: Math.max(0, sh.seats - live.length - 1) },
            owner: sh.role === 'member' ? (sh.ownerName ?? null) : undefined,
            since: book.since ?? null,
            collect_from: collectionAnchor(s),
            rule: sh.role === 'owner' ? ruleOut(st, s, today) : null,
            // 方向写清楚：i_pay = 我自己净掏的钱，i_earn = 收的比付的多（赚了）；两者至多一个大于 0
            // 缺汇率时对应数字为 null，incomplete 标出这一组不完整
            year: {
              ...partialOut(book.partial.yearNet),
              totals: { cost: partialOut(book.partial.yearCost), expected_income: partialOut(book.partial.yearIncome), net: partialOut(book.partial.yearNet) },
              cost: fin(book.yearCost),
              expected_income: fin(book.yearIncome),
              i_pay: fin(Math.max(0, book.yearNet)),
              i_earn: fin(Math.max(0, -book.yearNet)),
              incomplete: ![book.yearCost, book.yearIncome, book.yearNet].every(Number.isFinite),
            },
            to_date: {
              ...partialOut(book.partial.net),
              totals: { paid: partialOut(book.partial.paid), received: partialOut(book.partial.received), net: partialOut(book.partial.net) },
              paid: fin(book.paid),
              received: fin(book.received),
              i_pay: fin(Math.max(0, book.net)),
              i_earn: fin(Math.max(0, -book.net)),
              incomplete: ![book.paid, book.received, book.net].every(Number.isFinite),
            },
            members: sh.members.map((m) => {
              const fee = memberFee(st, s, m, today);
              const d = dues.get(m.id);
              return {
                id: m.id,
                name: m.name,
                exempt: !!m.exempt,
                active: memberAboard(m, today),
                joined: m.joined ?? null,
                left: m.left ?? null,
                fee: { amount: fee.amount, currency: fee.currency, every_months: memberBillMonths(s, m, today) },
                ...collectionSummary(st, s, m, d, today),
                first_period: m.firstPeriod ?? 'prorate',
                first_amount: m.firstAmount ?? null,
                owed: d && d.periodsOwed > 0 ? { ...money(st, d.owed, d.currency), ...partialOut(dueTotal(st, d)) } : null,
                receipts: (m.receipts ?? []).length,
              };
            }),
          };
        }),
    };
  },
};

export const set_share: Tool = {
  name: 'set_share',
  destructive: true,
  description:
    'Turn a subscription into a shared plan or change its sharing: role owner (I pay the full price and collect from members) or member (I joined someone else’s plan; price is my part), seats = total seats including me, owner_name for member role, since = date the carpool started. collect_from optionally overrides the shared collection anchor; otherwise since, earliest recorded coverage start (or a period inferred from paid-until when coverage starts are absent), then subscription start is inferred. Returns the effective collect_from in both previews and saves. Only the joining period aligns to the anchor; later collections start after individual paid-through. Null clears since/collect_from/owner_name so defaults can be inferred again. role none stops sharing (subscription must then be its id or exact full name). rule sets the owner plan collection rule {fee, fee_currency, bill_every}: members following the rule get the new fee from rule_from (default today) as a dated fee change, keeping receipts and earlier periods; custom-fee, exempt and departed members are untouched. The first time a rule is saved, members whose fee differs are marked custom. Returns the effective rule. Describe the returned fee, cycle, date and affected members; do not infer annual income or savings from this result.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      role: { type: 'string', enum: ['owner', 'member', 'none'] },
      seats: { type: 'integer', minimum: 1, description: 'Total seats including me.' },
      owner_name: { type: ['string', 'null'] },
      since: { ...DATE, type: ['string', 'null'] },
      collect_from: {
        ...DATE,
        type: ['string', 'null'],
        description:
          'Optional shared collection anchor. Members align to this date + k × bill_every months, preserving month-end alignment. Omit to preserve the existing anchor or infer from since, recorded coverage / paid-until, then subscription start.',
      },
      rule: {
        type: 'object',
        description: 'Owner only: the plan collection rule followed by non-custom members.',
        properties: {
          fee: { type: 'number', minimum: 0, description: 'Amount collected from each member per bill.' },
          fee_currency: { type: 'string', description: 'Defaults to the current rule currency, else the collection currency.' },
          bill_every: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_BILL_MONTHS,
            description:
              'Billing interval in months: 1 monthly, 3 quarterly, 6 half-yearly, 12 yearly, or any whole number of months up to 120 (e.g. 2 bimonthly, 24 every two years).',
          },
        },
        additionalProperties: false,
      },
      rule_from: { ...DATE, description: 'Effective date for the rule change; defaults to today. Whole periods starting on/after it use the new fee.' },
      dry_run: drySchema,
    },
    ['subscription', 'role'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription, { exact: a.role === 'none' });
    if (a.role === 'none') return commit(ctx, st, today, { ...s, share: undefined }, a.dry_run, ['share_removed']);
    const role = a.role === 'member' ? 'member' : 'owner';
    const cur = s.share;
    const share = {
      role,
      seats: Math.max(1, Math.round(Number(a.seats ?? cur?.seats ?? 2))),
      members: cur?.members ?? [],
      ownerName: role === 'member' ? ('owner_name' in a ? str(a.owner_name) : cur?.ownerName) : undefined,
      since: 'since' in a ? (a.since == null ? undefined : date(a.since, 'since')) : cur ? cur.since : today,
      collectFrom: cur?.collectFrom,
      rule: role === 'owner' ? cur?.rule : undefined,
    } as NonNullable<Subscription['share']>;
    let after: Subscription = { ...s, share };
    // 改收款日：已有成员钉住原基准，历史各期不重切（与界面同一个 moveCollectFrom）；null 清掉存的基准日、回到推算
    if ('collect_from' in a)
      after = a.collect_from == null ? { ...after, share: { ...share, collectFrom: undefined } } : moveCollectFrom(after, date(a.collect_from, 'collect_from'));
    if (a.rule != null) {
      if (role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
      const r = a.rule as Record<string, unknown>;
      const prev = carRule(st, after, today);
      const currency = (str(r.fee_currency) ?? prev.currency).toUpperCase();
      validateCurrency(st, currency);
      const billEvery = r.bill_every != null ? Number(r.bill_every) : prev.billEvery;
      if (!validBillMonths(billEvery)) throw new Error(t('mcp.error.invalidInput', { field: 'rule.bill_every' }));
      const rule = { fee: r.fee != null ? num(r.fee, 'rule.fee') : prev.fee, currency, billEvery };
      after = applyCarRule(st, after, rule, date(a.rule_from, 'rule_from', today), today);
    }
    return {
      ...(await commit(ctx, st, today, after, a.dry_run, [cur ? 'share_updated' : 'share_created', ...(a.rule != null ? ['rule_updated'] : [])])),
      collect_from: collectionAnchor(after),
      ...(after.share?.role === 'owner' ? { rule: ruleOut(st, after, today) } : {}),
    };
  },
};

export const save_share_member: Tool = {
  name: 'save_share_member',
  description:
    'Add a member to a shared plan I organize, or update one (pass member = id or name to update). fee = how much they pay each time, in fee_currency (defaults to the collection currency), every bill_every months (1 monthly, 3 quarterly, 6 half-yearly, 12 yearly, or any whole number up to 120). exempt = takes a seat but pays nothing. paid_until = settled before record-keeping through this date (periods starting on/before it become an opening settlement with no amount; null removes it); record real money with record_receivable. Only the joining period aligns to the shared anchor; later periods follow the member’s own billing cycle. Fee changes use fee_from (default today), preserve the old rate and receipts, and apply to whole periods starting on/after that date. A mid-period join covers joined through the aligned period end inclusive: first_period prorate (default, actual days / full period days, rounded to cents), full, or free. first_amount optionally overrides the first amount in fee_currency; free always charges zero. Later periods use the regular fee. Use save_person for name/contact changes of a linked roster person; person=null detaches the link. New members default to the plan collection rule (see get_carpool rule) when fee and bill_every are omitted. follow_rule=true makes the member follow the plan rule from fee_from (default today); follow_rule=false keeps their own fee. Changing fee, fee_currency or bill_every without follow_rule marks the member custom unless the result at fee_from equals the rule. Each call inserts/replaces one dated fee point; later fee_history points remain. For an ongoing custom rate, also replace conflicting later points with the same fee and cycle. Do not postpone fee_from to avoid them; omit it to start today. Set left to retain all join/receipt history. Optional leave_refund stores the actual positive refund, with date defaulting to left and currency to the suggested refund currency; null means no refund. left=null also clears the refund. Preview returns suggested_refund (including original-currency parts) and unused_days; never save the suggestion as an actual refund without user confirmation. Preview and save return member.first_collection (inclusive coverage and amount), follows_rule, collect_from, paid_until, next_collection_date and overdue_days.',
  write: true,
  inputSchema: obj(
    {
      subscription: SUBREF,
      person: {
        type: ['string', 'null'],
        description:
          'Link an existing roster person by id/name; copies their name/contact. Omitted: an unlinked member is matched by name (+ contact) like the web form, else a roster person is created (preview created_person). null keeps the member unlinked.',
      },
      member: { type: 'string', description: 'Existing member id or name to update; omit to add a new member.' },
      id: { type: 'string', description: 'Internal: id for a new member (used when confirming an earlier draft).' },
      name: { type: 'string' },
      fee: { type: 'number', minimum: 0 },
      fee_currency: { type: 'string' },
      fee_from: {
        ...DATE,
        description:
          'Effective date for a fee/currency/billing-cycle change; omit when the user gave no date (today), including follow_rule switches. Do not align it to a future plan-rule date. Period start selects the whole-period rate; no split at price changes.',
      },
      bill_every: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_BILL_MONTHS,
        description:
          'Billing interval in months: 1 monthly, 3 quarterly, 6 half-yearly, 12 yearly, or any whole number of months up to 120 (e.g. 2 bimonthly, 24 every two years).',
      },
      follow_rule: { type: 'boolean', description: 'true = follow the plan collection rule (ignores fee/fee_currency/bill_every); false = custom fee.' },
      first_period: {
        type: 'string',
        enum: ['prorate', 'full', 'free'],
        description:
          'Partial first period only: prorate (default, actual inclusive days / full aligned period days, rounded to cents), full (regular fee), or free (zero; skipped for the next collection). Later periods charge the regular fee.',
      },
      first_amount: { type: ['number', 'null'], minimum: 0, description: 'Custom first-period fee; null resets to calculated amount.' },
      collect_day: {
        type: 'string',
        enum: ['plan', 'joined'],
        description:
          'New members only: plan (default) aligns the first period to the shared anchor; joined collects from the join date on the member’s own day, so the first period is a full period and later ones start on that day. Ignored when the join date already falls on the shared collection day, for exempt members and for lifetime plans.',
      },
      exempt: { type: 'boolean' },
      paid_until: { ...DATE, type: ['string', 'null'] },
      joined: {
        ...DATE,
        type: ['string', 'null'],
        description: 'Join date, inclusive; defaults to today for a new member. A mid-period join covers this day through the shared aligned period end.',
      },
      left: { ...DATE, type: ['string', 'null'], description: 'Left the plan on this date (keeps history). null also clears leave_refund.' },
      leave_refund: {
        type: ['object', 'null'],
        description: 'Actual refund on leaving, positive amount. Requires left; null clears it. Omit to preserve. Date cannot precede joining.',
        properties: {
          amount: { type: 'number', minimum: 0 },
          date: DATE,
          currency: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['amount'],
        additionalProperties: false,
      },
      source: { type: 'string' },
      contact_via: { type: 'string', description: 'e.g. 微信, Telegram, 邮箱' },
      contact: { type: 'string' },
      account: { type: 'string', description: 'This person’s account on this shared plan (arbitrary text: email, phone number, username or ID).' },
      note: { type: 'string' },
      dry_run: drySchema,
    },
    ['subscription'],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription);
    if (!s.share || s.share.role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
    const old = str(a.member) ? findMember(s, a.member) : undefined;
    const live = s.share.members.filter((m) => memberAboard(m, today));
    if (!old && live.length + 1 >= s.share.seats) throw new Error(t('mcp.error.shareFull', { name: s.name, seats: s.share.seats }));
    const feeArgs = a.follow_rule === true ? {} : a;
    const ccy = (str(feeArgs.fee_currency) ?? old?.feeCurrency ?? collectCcy(st)).toUpperCase();
    validateCurrency(st, ccy);
    // 新成员没给收费标准时按车的收款规则
    const rule = carRule(st, s, today);
    const ruleDefault = !old && a.fee == null && a.bill_every == null && a.fee_currency == null;
    const billEvery =
      feeArgs.bill_every != null
        ? Number(feeArgs.bill_every)
        : old
          ? memberBillMonths(s, old, a.fee_from ? date(a.fee_from, 'fee_from') : today)
          : ruleDefault
            ? rule.billEvery
            : 1;
    if (!validBillMonths(billEvery)) throw new Error(t('mcp.error.invalidInput', { field: 'bill_every' }));
    if (a.first_period != null && !['prorate', 'full', 'free'].includes(String(a.first_period))) throw new Error(t('mcp.error.invalidFirstPeriod'));
    let m: ShareMember = {
      ...(old ?? { id: str(a.id) ?? uid(), name: '', share: 0 }),
      name: str(a.name) ?? old?.name ?? '',
      ...(feeArgs.fee != null ? { fee: num(feeArgs.fee, 'fee'), feeCurrency: ccy } : ruleDefault ? { fee: rule.fee, feeCurrency: rule.currency } : {}),
      billEvery,
      ...(a.first_period != null
        ? {
            firstPeriod: a.first_period as ShareMember['firstPeriod'],
            ...(a.first_period !== (old?.firstPeriod ?? 'prorate') ? { firstAmount: undefined } : {}),
          }
        : {}),
      ...('first_amount' in a ? { firstAmount: a.first_amount == null ? undefined : num(a.first_amount, 'first_amount') } : {}),
      ...(a.exempt != null ? { exempt: !!a.exempt } : {}),
      ...(a.joined ? { joined: date(a.joined, 'joined') } : !old ? { joined: today } : {}),
      ...(a.left ? { left: date(a.left, 'left') } : {}),
      ...(a.contact_via ? { contactVia: String(a.contact_via) } : {}),
      ...(a.contact ? { contact: String(a.contact) } : {}),
      ...(a.account ? { account: String(a.account) } : {}),
      ...(a.note ? { note: String(a.note) } : {}),
    };
    if (a.collect_day != null && !['plan', 'joined'].includes(String(a.collect_day))) throw new Error(t('mcp.error.invalidCollectDay'));
    if ('fee_currency' in feeArgs) m.feeCurrency = ccy;
    if (a.person === null) m.personId = undefined;
    if (a.person) {
      const p = findPerson(st, a.person);
      Object.assign(m, { personId: p.id, name: p.name, contactVia: p.contactVia, contact: p.contact });
    }
    for (const [input, field] of [
      ['left', 'left'],
      ['joined', 'joined'],
    ] as const)
      if (a[input] === null) m[field] = undefined;
    for (const [input, field] of [
      ['contact_via', 'contactVia'],
      ['contact', 'contact'],
      ['account', 'account'],
      ['note', 'note'],
      ['source', 'source'],
    ] as const)
      if (input in a) m[field] = field === 'account' ? str(a[input])?.trim() || undefined : str(a[input]);
    if ('leave_refund' in a && a.leave_refund !== null) {
      if (!m.left) throw new Error(t('core.subError.refundDate'));
      const r = a.leave_refund as Record<string, unknown>;
      const suggestion = suggestedLeaveRefund(st, s, m);
      const currency = (str(r.currency) ?? suggestion.currency).toUpperCase();
      validateCurrency(st, currency);
      m.leaveRefund = {
        amount: num(r.amount, 'leave_refund.amount'),
        date: date(r.date, 'leave_refund.date', m.left),
        currency,
        ...(r.note ? { note: String(r.note) } : {}),
      };
    } else if (a.leave_refund === null) m.leaveRefund = undefined;
    m = updateMemberLeave(m, {});
    // 新成员从加入日起收：收款基准日钉在加入日，与网页成员表单一致；不分摊的不用收款日
    // 加入日正好在收款日上、买断的首期本来就完整，不钉；首期方式、金额随之不再适用
    if (!old && a.collect_day === 'joined' && !m.exempt && s.cycle.unit !== 'lifetime') {
      const joined = m.joined ?? s.share.since ?? s.start;
      if (memberCollection(s, m, joined, collectCcy(st)).partial) m = { ...m, anchor: joined, firstPeriod: undefined, firstAmount: undefined };
    }
    // 从加入日起收的已有成员改加入日：收款基准日一起挪，与网页一致
    if (old?.anchor && old.anchor === (old.joined ?? s.share.since ?? s.start) && m.anchor === old.anchor && m.joined && m.joined !== old.joined)
      m.anchor = m.joined;
    if (!m.name) throw new Error(t('mcp.error.needMemberName'));
    const feeEdited = ['fee', 'fee_currency', 'bill_every'].some((key) => key in a);
    if (old && feeEdited && a.follow_rule !== true) {
      const from = date(a.fee_from, 'fee_from', today);
      const prev = memberFee(st, s, old, from);
      m = changeMemberFee(
        st,
        s,
        { ...m, fee: old.fee, feeCurrency: old.feeCurrency, billEvery: old.billEvery },
        {
          from,
          fee: a.fee == null ? prev.amount : num(a.fee, 'fee'),
          currency: a.fee_currency == null ? prev.currency : ccy,
          billEvery,
        },
        today,
      );
    }
    if (a.follow_rule === true)
      m = old
        ? followCarRule(st, s, m, date(a.fee_from, 'fee_from', today), today)
        : { ...m, custom: undefined, fee: rule.fee, feeCurrency: rule.currency, billEvery: rule.billEvery };
    else if (a.follow_rule === false) m = { ...m, custom: true };
    else if (feeEdited) {
      const from = date(a.fee_from, 'fee_from', today);
      const r = memberFee(st, s, m, from);
      m = { ...m, custom: sameRule({ fee: r.amount, currency: r.currency, billEvery: memberBillMonths(s, m, from) }, rule) ? undefined : true };
    }
    // 取消不分摊：fee_from（缺省今天）之前没结清的期记成免收，与网页成员表单同一个 waiveExemptSpan
    if (old?.exempt && !m.exempt) m = waiveExemptSpan(s, m, date(a.fee_from, 'fee_from', today), today, collectCcy(st));
    // 每期份额（订阅币种）由收费标准换算；不分摊的为 0
    m.share = m.exempt ? 0 : m.fee != null ? shareFromFee(st, s, m.fee, m.feeCurrency ?? ccy, memberBillMonths(s, m, today)) : m.share;
    // 期初已付至：这天及之前的期算开始记账前就收清了
    if ('paid_until' in a) {
      const until = a.paid_until == null ? undefined : date(a.paid_until, 'paid_until');
      m = { ...m, ...setOpening(m, memberPeriods(s, m, until ?? today, collectCcy(st)), until) };
    }
    // 与网页成员表单同一套建档规则：没关联到人的按称呼（+ 联系方式）认已有的人，认不到就新建；person=null 明确不关联
    const link = !m.personId && a.person !== null ? personLink(st.people ?? [], { name: m.name, contactVia: m.contactVia, contact: m.contact }) : undefined;
    if (link) m = { ...m, personId: link.id };
    const members = old ? s.share.members.map((x) => (x.id === old.id ? m : x)) : [...s.share.members, m];
    const after = { ...s, share: { ...s.share, collectFrom: collectionAnchor(s), members } };
    const suggestion = suggestedLeaveRefund(st, after, m);
    return {
      ...(await commit(ctx, st, today, after, a.dry_run, [old ? `member_updated:${m.name}` : `member_added:${m.name}`], undefined, link?.created)),
      suggested_refund: suggestion,
      unused_days: suggestion.unusedDays,
      member: {
        id: m.id,
        name: m.name,
        custom: !!m.custom,
        fee_history: m.feeHistory ?? [],
        ...collectionSummary(
          st,
          after,
          m,
          memberDues(after, today, collectCcy(st), st).find((d) => d.member.id === m.id),
          today,
        ),
      },
    };
  },
};

export const remove_share_member: Tool = {
  name: 'remove_share_member',
  description: 'Remove a member from a shared plan entirely (their payment history goes too). To keep history, use save_share_member with left instead.',
  write: true,
  destructive: true,
  inputSchema: obj({ subscription: SUBREF_EXACT, member: { type: 'string', description: 'Member id or exact name (case-insensitive).' }, dry_run: drySchema }, [
    'subscription',
    'member',
  ]),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const s = findSub(st, a.subscription, { exact: true });
    if (!s.share) throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
    const m = findMember(s, a.member);
    return commit(
      ctx,
      st,
      today,
      { ...s, share: { ...s.share, collectFrom: collectionAnchor(s), members: s.share.members.filter((x) => x.id !== m.id) } },
      a.dry_run,
      [`member_removed:${m.name}`],
    );
  },
};

export const record_receivable: Tool = {
  name: 'record_receivable',
  destructive: true,
  description:
    'Receivables are kept per period: each shared-plan member period (identified by its start date) and each proxy charge (identified by its charge date) is paid, waived, free, due or upcoming; periods need not be settled in order. Read periods, statuses, receipt_id and waiver_id with get_subscription. action=record (default) records money received: periods = the period keys it covers (may skip earlier unpaid ones, may be future = prepayment), or count = the N earliest unsettled periods (default 1). amount defaults to the total due of those periods (converted to currency at the receipt date); an explicit amount is the actual receipt and is split across the periods in proportion to their dues. action=waive marks periods as not owed (no money). action=update replaces receipt/waiver id with the given fields (periods/amount/currency/date/note; omitted fields keep their values). action=delete removes receipt/waiver id; its periods become unsettled again (subscription and member must be ids or exact names). action=charged (proxy only) sets the actual card charge of one charge date: charged_amount and charged_currency; null charged_amount clears the override. A period can be covered by only one record. Pass person (name or id) instead of subscription/member/kind: their only open item is picked (pass subscription when they owe on several).',
  write: true,
  inputSchema: obj(
    {
      action: { type: 'string', enum: ['record', 'waive', 'update', 'delete', 'charged'] },
      subscription: {
        ...SUBREF,
        description: 'Subscription id or name. Optional when person is given and only one of their plans / proxy payments matches.',
      },
      person: { type: 'string', description: 'Person id or name (see list_people). Picks the matching member or proxy payment automatically.' },
      kind: { type: 'string', enum: ['share', 'proxy'], description: 'Inferred when person or member is given; defaults to proxy for a proxy subscription.' },
      member: { type: 'string', description: 'share: member id or name.' },
      periods: { type: 'array', items: DATE, maxItems: 240, description: 'Period keys (share: period start; proxy: charge date).' },
      count: { type: 'integer', minimum: 1, maximum: 240, description: 'Without periods: cover the N earliest unsettled periods.' },
      id: {
        type: 'string',
        description: 'update/delete: receipt or waiver id. For record/waive: optional stable new record id, pinned when confirming a draft.',
      },
      amount: { type: 'number', minimum: 0, description: 'Actual amount received; defaults to the total due of the covered periods.' },
      currency: { type: 'string', description: 'Receipt currency; defaults to the currency of the covered periods.' },
      date: { ...DATE, description: 'When the money arrived (or the waiver was agreed); defaults to today.' },
      note: { type: ['string', 'null'] },
      charge: { ...DATE, description: 'charged: which proxy charge date.' },
      charged_amount: { type: ['number', 'null'], minimum: 0 },
      charged_currency: { type: ['string', 'null'] },
      dry_run: drySchema,
    },
    [],
  ),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    if (a.person != null && String(a.person).trim()) a = { ...a, ...personTarget(st, a, today) };
    if (!a.subscription) throw new Error(t('mcp.error.needSubOrPerson'));
    const action = String(a.action ?? 'record');
    const s = findSub(st, a.subscription, { exact: action === 'delete' });
    const kind = a.kind ?? (a.member ? 'share' : s.proxy ? 'proxy' : a.kind);
    if (kind !== 'share' && kind !== 'proxy') throw new Error(t('mcp.error.needKind'));
    if (action === 'charged') {
      if (kind !== 'proxy') throw new Error(t('mcp.error.needKind'));
      const currency = str(a.charged_currency)?.toUpperCase();
      if (currency) validateCurrency(st, currency);
      const r = recordProxyCharge(
        s,
        {
          charge: date(a.charge, 'charge'),
          ...(a.charged_amount != null ? { amount: num(a.charged_amount, 'charged_amount') } : {}),
          ...(currency ? { currency } : {}),
          ...(str(a.note) ? { note: str(a.note) } : {}),
        },
        today,
      );
      return { ...(await commit(ctx, st, today, r.after, a.dry_run, [`proxy_charged:${a.charge}`])), before: r.before, after: r.record };
    }
    let target: ReceivableTarget = { kind: 'proxy' };
    if (kind === 'share') {
      if (!s.share || s.share.role !== 'owner') throw new Error(t('mcp.error.notShareOwner', { name: s.name }));
      target = { kind: 'share', member: findMember(s, a.member, { fuzzy: action !== 'delete' }) };
    }
    const ledger = receivableOf(st, s, target, today);
    const existing = a.id ? [...(ledger.record.receipts ?? []), ...(ledger.record.waivers ?? [])].find((x) => x.id === a.id) : undefined;
    if ((action === 'update' || action === 'delete') && !existing) throw new Error(t('mcp.error.invalidTarget'));
    let result;
    if (action === 'delete') result = deleteRecord(st, s, target, existing!.id, today);
    else {
      const periods = Array.isArray(a.periods)
        ? (a.periods as unknown[]).map((d) => date(d, 'periods'))
        : existing && a.count == null
          ? existing.periods
          : openPeriods(ledger.periods, Number(a.count ?? 1)).map((p) => p.key);
      const id = existing?.id ?? str(a.id) ?? uid();
      const note = 'note' in a ? str(a.note) : existing?.note;
      const on = date(a.date, 'date', existing?.date ?? today);
      const isWaiver = action === 'waive' || (action === 'update' && !!existing && !('amount' in existing));
      if (isWaiver) result = recordWaiver(st, s, target, { id, date: on, periods, note }, today);
      else {
        const old = existing && 'amount' in existing ? (existing as Receipt) : undefined;
        const currency = str(a.currency)?.toUpperCase() ?? old?.currency;
        if (currency) validateCurrency(st, currency);
        result = recordReceipt(
          st,
          s,
          target,
          { id, date: on, amount: a.amount != null ? num(a.amount, 'amount') : old?.amount, currency, periods, note },
          today,
        );
      }
    }
    const after = result.after;
    const m = target.kind === 'share' ? after.share!.members.find((x) => x.id === (target as { member: ShareMember }).member.id)! : undefined;
    return {
      ...(await commit(ctx, st, today, after, a.dry_run, [`receivable_${action}:${m?.name ?? s.proxy?.forName ?? s.name}`])),
      before: result.before,
      after: result.record,
      ...(m
        ? {
            member: {
              id: m.id,
              name: m.name,
              ...collectionSummary(
                st,
                after,
                m,
                memberDues(after, today, collectCcy(st), st).find((d) => d.member.id === m.id),
                today,
              ),
            },
          }
        : {}),
    };
  },
};

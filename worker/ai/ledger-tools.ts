import { validateAvatar, personSummary } from '../../shared/avatar.ts';
// Non-secret ledger editing, shared by external MCP and the confirmed in-app assistant.
import type { AppState, PaymentMethod, Person, Proxy, TopUp } from '../../shared/types.ts';
import { PERSON_COLORS } from '../../shared/types.ts';
import { uid, runwayFor } from '../../shared/billing.ts';
import { t } from '../../shared/i18n.ts';
import { objectSchema as obj, textSchema as text, drySchema as dry, nullable } from '../../shared/tool-schema.ts';
import {
  METHOD_FIELDS,
  TOP_UP_FIELDS,
  SETTINGS_FIELDS,
  PREF_FIELDS,
  applyFields,
  categoryEdit,
  deleteMethodData,
  editRecord,
  excludedAccess,
  personEdit,
  safeSettings,
  settingsEdit,
  validateCurrency,
  validateMethod,
} from '../../shared/ledger-edit.ts';
import { PERSON_COLOR_PATTERN, personColor, personLink } from '../../shared/people.ts';
import { state, findSub, findPerson, methodRef, commit, writeLedger, type Tool, type ToolCtx } from './tool-kit.ts';

const action = (values: string[]) => ({ type: 'string', enum: values });
const body = (value: unknown) => (value ?? {}) as Record<string, unknown>;
/** 账本工具的写入：交给 mcp-tools 的唯一写入出口 writeLedger */
const save = (ctx: ToolCtx, st: AppState, patch: Partial<AppState>, deletes: string[], preview: object, dryRun: unknown) =>
  writeLedger(ctx, st, { ...patch, deletedMethods: deletes }, preview, dryRun);

export const paymentMethodTool: Tool = {
  name: 'update_payment_method',
  write: true,
  destructive: true,
  description:
    'Create (action=create), update (default), or delete (action=delete) a payment method/wallet. set uses PaymentMethod fields: name, kind, currency, balance/balanceAsOf, balanceExpires (day the whole balance expires; later balance is forfeited; null clears), logo, notes, card details, order, etc. Create requires name/kind/currency in set. Delete blocks ALL subscription/phase/default-method references unless migrate_to names an existing target; returns references and lost top-up history. top_up appends and recalibrates current balance; top_up_action=update|delete with zero-based top_up_index edits stored history only, preserving the calibrated balance unless balance/set.balance is explicitly supplied. Read stored records and indices with list_payment_methods. Currency edits relabel the wallet, never convert historical amounts. Preview first.',
  inputSchema: obj({
    action: action(['create', 'update', 'delete']),
    id: { ...text, description: 'Stable new id when confirming a create draft.' },
    method: text,
    migrate_to: text,
    set: METHOD_FIELDS,
    balance: { type: 'number' },
    name: text,
    region: text,
    top_up: {
      ...TOP_UP_FIELDS,
      properties: { ...TOP_UP_FIELDS.properties, cost_currency: nullable(text) },
      description: 'Append: amount required, date defaults to today. Update: only supplied fields change.',
    },
    top_up_action: action(['add', 'update', 'delete']),
    top_up_index: { type: 'integer', minimum: 0 },
    expected_top_up: TOP_UP_FIELDS,
    dry_run: dry,
  }),
  async run(a, ctx) {
    const { st, today } = await state(ctx);
    const act = a.action ?? 'update';
    const creating = act === 'create';
    const id = creating ? String(a.id ?? uid()) : methodRef(st, a.method);
    if (!id || (creating && st.methods.some((m) => m.id === id))) throw new Error(t('mcp.error.invalidTarget'));
    const old = st.methods.find((m) => m.id === id);
    if (act === 'delete') {
      const into = a.migrate_to ? methodRef(st, a.migrate_to) : undefined;
      const result = deleteMethodData(st, id, into);
      return save(
        ctx,
        st,
        { settings: result.settings, subscriptions: result.subscriptions, methods: [] },
        [id],
        { before: old, after: null, references: result.references, removed_top_ups: old?.topUps ?? [], migrate_to: into ?? null },
        a.dry_run,
      );
    }
    const set = body(a.set);
    if (creating && (!set.name || !set.kind || !set.currency)) throw new Error(t('mcp.error.invalidInput', { field: 'set.name/kind/currency' }));
    let next = applyFields(old ?? { id }, set) as PaymentMethod;
    if (typeof a.name === 'string') next.name = a.name;
    if (typeof a.region === 'string') next.region = a.region || undefined;
    if (a.balance !== undefined) next.balance = Number(a.balance);
    if (a.balance !== undefined || 'balance' in set)
      next.balanceAsOf = next.balance == null ? undefined : typeof set.balanceAsOf === 'string' ? set.balanceAsOf : today;
    if (next.balance == null) delete next.balanceExpires;
    validateMethod(st, next);
    const topAction = a.top_up_action ?? 'add';
    if (a.top_up || topAction !== 'add') {
      const raw = { ...body(a.top_up) };
      if ('cost_currency' in raw) {
        if ('costCurrency' in raw && raw.costCurrency !== raw.cost_currency) throw new Error(t('mcp.error.invalidInput', { field: 'top_up.cost_currency' }));
        raw.costCurrency = raw.cost_currency;
        delete raw.cost_currency;
      }
      const tops = old?.topUps ?? [];
      if (topAction === 'delete' || topAction === 'update') {
        const index = Number(a.top_up_index);
        const replacement = topAction === 'delete' ? undefined : (applyFields(tops[index] ?? {}, raw) as TopUp);
        next.topUps = editRecord(tops, index, replacement, a.expected_top_up as TopUp | undefined);
      } else {
        if (typeof raw.amount !== 'number') throw new Error(t('mcp.error.invalidInput', { field: 'top_up.amount' }));
        const top = applyFields({ date: today }, raw) as TopUp;
        next.topUps = [...tops, top];
        if (a.balance === undefined && !('balance' in set) && old?.balance != null) {
          // A missing FX estimate must never silently become the saved balance.
          const current = runwayFor(old, st, today)?.current ?? old.balance;
          if (!Number.isFinite(current)) throw new Error(t('mcp.error.invalidInput', { field: 'current_balance' }));
          next.balance = Math.round((current + top.amount) * 100) / 100;
          next.balanceAsOf = today;
        }
      }
      for (const top of next.topUps ?? []) if (top.costCurrency) validateCurrency(st, top.costCurrency);
    }
    if (!creating && JSON.stringify(old) === JSON.stringify(next)) throw new Error(t('mcp.error.noFields'));
    return save(
      ctx,
      st,
      { methods: [next] },
      [],
      {
        before: old ?? null,
        method: { ...next, balance_as_of: next.balanceAsOf ?? null, balance_expires: next.balanceExpires ?? null, top_ups: next.topUps?.length ?? 0 },
        after: next,
        ...(creating ? { created: { id } } : {}),
      },
      a.dry_run,
    );
  },
};

export const ledgerTools = (connectionInfo: (ctx: ToolCtx, settings: AppState['settings'], today: string) => object): Tool[] => [
  {
    name: 'save_category',
    write: true,
    destructive: true,
    description:
      'Create, update/rename, delete or reorder categories. category is the exact existing name. set contains name/icon/color; order is the complete ordered name list. Renames update every subscription atomically. Delete with references requires migrate_to (another existing category); preview and result list affected subscriptions. Never deletes subscriptions.',
    inputSchema: obj(
      {
        action: action(['create', 'update', 'delete', 'reorder']),
        category: text,
        set: obj({ name: text, icon: nullable(text), color: nullable(text) }),
        migrate_to: text,
        order: { type: 'array', items: text },
        dry_run: dry,
      },
      ['action'],
    ),
    async run(a, ctx) {
      const { st } = await state(ctx);
      const result = categoryEdit(
        st,
        String(a.action),
        a.category as string | undefined,
        body(a.set),
        a.migrate_to as string | undefined,
        a.order as string[] | undefined,
      );
      const settings = { ...st.settings, categories: result.categories };
      return save(
        ctx,
        st,
        { settings, subscriptions: result.subscriptions },
        [],
        { before: st.settings.categories ?? null, after: result.categories, references: result.references },
        a.dry_run,
      );
    },
  },
  {
    name: 'save_person',
    write: true,
    destructive: true,
    description:
      'Create/update a person in the shared-plan/proxy roster, or delete/merge one. person accepts id or unambiguous name; create requires set.name. set: name/contactVia/contact/note/color, null clears optional fields. Avatar upload: avatar_base64 plus mime (image/png or image/webp), square <=128px and <=64KiB, no metadata. avatar=null removes it. Remote URLs are unsupported; upload a prepared thumbnail. All linked names and contacts update together. Accounts belong to person × shared-plan memberships; use save_share_member.account, never save_person. Delete blocks references unless migrate_to identifies another existing person (merge); preserves receipts and returns reference summary. Use list_people for ids.',
    inputSchema: obj(
      {
        action: action(['create', 'update', 'delete']),
        id: text,
        person: text,
        avatar: { type: 'null' },
        avatar_base64: text,
        mime: { type: 'string', enum: ['image/png', 'image/webp'] },
        migrate_to: text,
        set: obj({
          name: text,
          contactVia: nullable(text),
          contact: nullable(text),
          note: nullable(text),
          color: nullable({ type: 'string', pattern: PERSON_COLOR_PATTERN, description: `One of ${PERSON_COLORS.join(', ')}, or a custom #RRGGBB.` }),
        }),
        dry_run: dry,
      },
      ['action'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const old = a.action === 'create' ? undefined : findPerson(st, a.person);
      const id = old?.id ?? String(a.id ?? uid());
      if (!old && st.people?.some((p) => p.id === id)) throw new Error(t('mcp.error.invalidTarget'));
      const person = applyFields(old ?? { id, createdAt: today }, body(a.set)) as Person;
      if (person.color) person.color = personColor(person.color);
      if ('avatar' in a && ('avatar_base64' in a || 'mime' in a)) throw new Error(t('server.avatarInvalid'));
      if ('avatar_base64' in a || 'mime' in a) person.avatar = validateAvatar(`data:${a.mime};base64,${a.avatar_base64}`);
      if (a.avatar === null) delete person.avatar;
      if (a.action === 'delete' && ('avatar' in a || 'avatar_base64' in a || 'mime' in a)) throw new Error(t('server.avatarInvalid'));
      if (a.action !== 'delete' && !person.name?.trim()) throw new Error(t('mcp.error.needMemberName'));
      const into = a.migrate_to ? findPerson(st, a.migrate_to).id : undefined;
      const result = personEdit(st, person, a.action === 'delete', into);
      return save(
        ctx,
        st,
        { people: result.people, subscriptions: result.subscriptions },
        [],
        {
          avatar_action: a.avatar === null ? 'remove' : a.avatar_base64 ? 'replace' : null,
          before: old ? personSummary(old) : null,
          after: a.action === 'delete' ? null : personSummary(person),
          references: result.references,
          ...(a.action === 'create' ? { created: { id } } : {}),
        },
        a.dry_run,
      );
    },
  },
  {
    name: 'get_settings',
    description: `Read connection identity, today's ledger date, timezone, base currency, actual caller permissions and available tool names; also non-security business settings, existing notification channel metadata/enabled switches and saved UI preferences. ${excludedAccess}`,
    inputSchema: obj({}),
    async run(_a, ctx) {
      const { st, today } = await state(ctx);
      return { ...safeSettings(st), connection: connectionInfo(ctx, st.settings, today) };
    },
  },
  {
    name: 'update_settings',
    write: true,
    idempotent: true,
    description: `Patch whitelisted business settings (camelCase keys), channel_enabled [{id,enabled}], and prefs (known UI preference keys, string values; null clears). Only supplied fields change; unknown/security fields are rejected. Null resets optional fields. Returns sanitized before/after, never credentials. ${excludedAccess}`,
    inputSchema: obj({
      set: SETTINGS_FIELDS,
      channel_enabled: { type: 'array', items: obj({ id: text, enabled: { type: 'boolean' } }, ['id', 'enabled']) },
      prefs: PREF_FIELDS,
      dry_run: dry,
    }),
    async run(a, ctx) {
      const { st } = await state(ctx);
      const result = settingsEdit(
        st,
        body(a.set),
        a.channel_enabled as Array<{ id: string; enabled: boolean }> | undefined,
        a.prefs as Record<string, string | null> | undefined,
      );
      return save(ctx, st, result, [], { before: safeSettings(st), after: safeSettings({ ...st, ...result }) }, a.dry_run);
    },
  },
  {
    name: 'set_proxy',
    write: true,
    destructive: true,
    description:
      'Set up/edit paying on behalf of a person, or action=remove to remove the proxy relationship and its repayment records (subscription/provider charges remain; remove needs the subscription id or exact full name). Prefer person id/name from list_people; for_name without person links a same-name roster person (matching contact when given) like the web editor, or creates one (preview created_person); person=null keeps it unlinked. Updates preserve receipts, waivers and charged overrides; only supplied fields change. Receipts and charged overrides are edited/deleted via record_receivable kind=proxy. Returns removed-record/reference summary.',
    inputSchema: obj(
      {
        subscription: text,
        action: action(['save', 'remove']),
        person: nullable(text),
        for_name: text,
        contact_via: nullable(text),
        contact: nullable(text),
        note: nullable(text),
        dry_run: dry,
      },
      ['subscription'],
    ),
    async run(a, ctx) {
      const { st, today } = await state(ctx);
      const s = findSub(st, a.subscription, { exact: a.action === 'remove' });
      let proxy: Proxy | undefined;
      let link: ReturnType<typeof personLink> | undefined;
      if (a.action !== 'remove') {
        const p = a.person ? findPerson(st, a.person) : undefined;
        proxy = {
          ...(s.proxy ?? { forName: '' }),
          ...(p ? { personId: p.id, forName: p.name, contactVia: p.contactVia, contact: p.contact } : {}),
        };
        if (a.person === null) proxy.personId = undefined;
        if ('for_name' in a) {
          proxy.forName = String(a.for_name);
          if (!p && proxy.forName !== s.proxy?.forName) proxy.personId = undefined;
        }
        for (const [input, key] of [
          ['contact_via', 'contactVia'],
          ['contact', 'contact'],
          ['note', 'note'],
        ] as const)
          if (input in a) proxy = applyFields(proxy, { [key]: a[input] });
        if (!proxy.forName.trim()) throw new Error(t('mcp.error.needMemberName'));
        // 与网页代付表单同一套建档规则；person=null 明确不关联
        if (!proxy.personId && a.person !== null) {
          link = personLink(st.people ?? [], { name: proxy.forName, contactVia: proxy.contactVia, contact: proxy.contact });
          proxy = { ...proxy, personId: link.id };
        }
      }
      return {
        ...(await commit(ctx, st, today, { ...s, proxy }, a.dry_run, ['proxy'], undefined, link?.created)),
        before: s.proxy ?? null,
        after: proxy ?? null,
        references: { subscription: s.id, removed_receipts: proxy ? [] : (s.proxy?.receipts ?? []), removed_waivers: proxy ? [] : (s.proxy?.waivers ?? []) },
      };
    },
  },
];

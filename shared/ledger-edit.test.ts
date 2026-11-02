import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryEdit, deleteMethodData, methodReferences, personEdit, safeSettings, settingsEdit, editRecord, SETTINGS_FIELDS } from './ledger-edit.ts';
import { validateToolInput } from './tool-schema.ts';
import { DEFAULT_SETTINGS, type AppState } from './types.ts';
import { FALLBACK_FX } from './billing.ts';
import { editPhase, removePhase } from './phases.ts';

const fixture = (): AppState => ({
  subscriptions: [
    {
      id: 's',
      name: 'Fictional',
      category: 'Old',
      tags: [],
      price: 10,
      currency: 'USD',
      cycle: { unit: 'month', every: 1 },
      start: '2026-01-01',
      status: 'active',
      methodId: 'm',
      phases: [
        {
          start: '2026-01-01',
          end: '2026-06-30',
          price: 10,
          currency: 'USD',
          cycle: { unit: 'month', every: 1 },
          methodId: 'm',
          payments: [{ date: '2026-01-01', amount: 10 }],
        },
        { start: '2026-07-01', price: 20, currency: 'USD', cycle: { unit: 'month', every: 1 }, methodId: 'target' },
      ],
      share: {
        role: 'owner',
        seats: 3,
        members: [
          { id: 'member', personId: 'p', name: 'Old person', share: 3, payments: [{ date: '2026-01-01', amount: 3, currency: 'USD', until: '2026-01-31' }] },
        ],
      },
      proxy: { personId: 'p', forName: 'Old person', entries: [{ charge: '2026-01-01', received: 10 }] },
    },
  ],
  methods: [
    { id: 'm', name: 'Wallet', kind: 'prepaid', currency: 'USD' },
    { id: 'target', name: 'Target', kind: 'credit', currency: 'USD' },
  ],
  people: [
    { id: 'p', name: 'Old person' },
    { id: 'target', name: 'New person', contact: 'fictional@example.test' },
  ],
  settings: {
    ...DEFAULT_SETTINGS,
    categories: [{ name: 'Old', preset: 'tools', icon: 'wrench' }, { name: 'New' }],
    defaultMethodId: 'm',
    channels: [{ id: 'channel', kind: 'webhook', name: 'Private', enabled: false, config: { token: 'SECRET', url: 'https://private.example.test' } }],
    icsToken: 'PRIVATE',
  },
  fx: FALLBACK_FX,
  prefs: { theme: 'light', 'other-extension': 'untouched' },
});

test('wallet references include historical phases/payments and default, migration preserves original amounts and receipts', () => {
  const st = fixture();
  const before = structuredClone(st);
  assert.equal(methodReferences(st, 'm').length, 3);
  assert.throws(() => deleteMethodData(st, 'm'));
  assert.throws(() => deleteMethodData(st, 'm', 'm'));
  const r = deleteMethodData(st, 'm', 'target');
  assert.equal(r.subscriptions[0].phases![0].methodId, 'target');
  assert.deepEqual(r.subscriptions[0].phases![0].payments, st.subscriptions[0].phases![0].payments);
  assert.equal(r.settings.defaultMethodId, 'target');
  assert.deepEqual(st, before);
});

test('category rename retains preset, clears optional appearance, prevents duplicate names, delete requires valid migration', () => {
  const st = fixture();
  const r = categoryEdit(st, 'update', 'Old', { name: 'Renamed', icon: null } as never);
  assert.equal(r.categories[0].preset, 'tools');
  assert.equal(r.categories[0].icon, undefined);
  assert.equal(r.subscriptions[0].category, 'Renamed');
  assert.throws(() => categoryEdit(st, 'update', 'Old', { name: 'New' }));
  assert.throws(() => categoryEdit(st, 'delete', 'Old', {}));
  assert.throws(() => categoryEdit(st, 'delete', 'Old', {}, 'Old'));
  assert.equal(categoryEdit(st, 'delete', 'Old', {}, 'New').subscriptions[0].category, 'New');
  assert.throws(() => categoryEdit(st, 'reorder', undefined, {}, undefined, ['Old', 'Old']));
});

test('person changes and merge synchronize both kinds without dropping actual money/history', () => {
  const st = fixture();
  const renamed = personEdit(st, { id: 'p', name: 'Renamed', contact: 'new@example.test' }, false);
  assert.equal(renamed.subscriptions[0].share!.members[0].name, 'Renamed');
  assert.equal(renamed.subscriptions[0].proxy!.forName, 'Renamed');
  assert.throws(() => personEdit(st, st.people![0], true));
  const merged = personEdit(st, st.people![0], true, 'target');
  assert.equal(merged.people.length, 1);
  assert.equal(merged.references.length, 2);
  assert.deepEqual(merged.subscriptions[0].share!.members[0].payments, st.subscriptions[0].share!.members[0].payments);
  assert.equal(merged.subscriptions[0].proxy!.personId, 'target');
});

test('settings allowlist rejects nested secrets, omits all credentials and preserves unknown stored data', () => {
  const st = fixture();
  assert.doesNotMatch(JSON.stringify(safeSettings(st)), /SECRET|PRIVATE|private.example/);
  assert.throws(() => validateToolInput(SETTINGS_FIELDS, { channels: [] }));
  assert.throws(() => validateToolInput(SETTINGS_FIELDS, JSON.parse('{"constructor": {"aiEnabled": false}}')));
  assert.throws(() => validateToolInput(SETTINGS_FIELDS, JSON.parse('{"__proto__": {"aiEnabled": false}}')));
  assert.throws(() => validateToolInput(SETTINGS_FIELDS, { maxSessions: 1 }));
  const r = settingsEdit(st, { signedAmounts: false }, [{ id: 'channel', enabled: true }], { theme: 'dark' });
  assert.equal(r.settings.channels![0].config.token, 'SECRET');
  assert.equal(r.settings.channels![0].enabled, true);
  assert.equal(r.settings.icsToken, 'PRIVATE');
  assert.equal(r.prefs['other-extension'], 'untouched');
  assert.equal(r.prefs.theme, 'dark');
  assert.throws(() => settingsEdit(st, { timezone: 'Not/AZone' }));
  assert.throws(() => settingsEdit(st, { baseCurrency: 'ZZZ' }));
});

test('#12 盈亏配色只接受绿盈红亏或红盈绿亏', () => {
  const st = fixture();
  assert.equal(settingsEdit(st, { gainColor: 'red' }).settings.gainColor, 'red');
  assert.throws(() => validateToolInput(SETTINGS_FIELDS, { gainColor: 'blue' }));
  // 网页 PUT /api/settings 不走工具 schema，checkSettings 也要拦住
  assert.throws(() => settingsEdit(st, { gainColor: 'blue' }));
});

test('indexed history editing rejects missing/stale records and preserves siblings', () => {
  const records = [{ amount: 10 }, { amount: 20 }];
  assert.deepEqual(editRecord(records, 0, { amount: 12 }), [{ amount: 12 }, { amount: 20 }]);
  assert.throws(() => editRecord(records, 3, undefined));
  assert.throws(() => editRecord(records, 0, undefined, { amount: 11 }));
  assert.equal(records[0].amount, 10);
});

test('phase corrections keep historical payments, reject invalid dates and leave unrelated phases intact', () => {
  const s = fixture().subscriptions[0];
  const after = editPhase(s, '2026-01-01', { price: 12, intro: { price: 1, until: '2026-01-02' } });
  assert.deepEqual(after.phases![0].payments, s.phases![0].payments);
  assert.deepEqual(after.phases![1], s.phases![1]);
  assert.throws(() => editPhase(s, '2026-01-01', { start: '2026-07-01' }));
  assert.throws(() => editPhase(s, '2026-01-01', { start: '2026-02-31' }));
  assert.equal(removePhase(s, 0).price, 20);
  const bonus = { from: '2026-02-01', until: '2026-02-10' };
  const previous = { ...s, phases: [{ ...s.phases![0], bonus }, s.phases![1]] };
  assert.deepEqual(removePhase(previous, 1).bonus, bonus);
});

// Editable full records use the same domain validation as the web editor. This schema
// describes the wire shape to models without rejecting preserved legacy extension fields.
import { billingSchema, daySchema as day, type Schema } from './tool-schema.ts';
import { MAX_BILL_MONTHS, type Phase, type Subscription } from './types.ts';

const text: Schema = { type: 'string' };
const amount: Schema = { type: 'number' };
const positive: Schema = { ...amount, minimum: 0 };
const bool: Schema = { type: 'boolean' };
const list = (items: Schema): Schema => ({ type: 'array', items });
function record(properties: Record<string, Schema>, required: string[] = []): Schema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        key,
        required.includes(key) ? schema : { ...schema, type: [String(schema.type), 'null'], ...(schema.enum ? { enum: [...schema.enum, null] } : {}) },
      ]),
    ),
    required,
    additionalProperties: true,
  };
}
const cycle = record(
  {
    unit: { type: 'string', enum: ['day', 'week', 'month', 'year', 'lifetime'] },
    every: { type: 'integer', description: 'Positive interval for recurring plans: month/3 = quarterly. Use lifetime/1 for a one-time purchase.' },
  },
  ['unit'],
);
const stop = record(
  {
    kind: { type: 'string', enum: ['cancel', 'terminate'] },
    date: { ...day, description: 'Actual last service day; must equal end. Omit stop entirely when the stopping date is unknown.' },
    paidThrough: { ...day, description: 'Original last paid service day, inclusive, before early cancellation or provider termination.' },
    pausedAt: { ...day, description: 'Pause date when stopped while paused; no charges from this day on. Set by the stop action.' },
    reason: { ...text, description: 'Only provider termination (kind=terminate) can have a reason.' },
  },
  ['kind', 'date', 'paidThrough'],
);
const payment = record(
  {
    date: { ...day, description: 'Actual payment date, which may precede the service phase start for early renewal.' },
    amount: {
      ...amount,
      description: 'Original order amount: charge/adjust positive, refund negative, free gift zero. Split funding still represents ONE order.',
    },
    currency: text,
    kind: { type: 'string', enum: ['refund', 'adjust', 'failed'], description: 'Omit for an ordinary successful charge. failed is not spending.' },
    note: text,
    methodId: { ...text, description: 'Existing method id. Omit when funding splits the order.' },
    settled: record({ amount, currency: text }, ['amount', 'currency']),
    funding: list(record({ methodId: text, amount }, ['methodId', 'amount'])),
  },
  ['date', 'amount'],
);
const renewal = {
  chargeLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
  cancelLeadDays: { type: 'integer', minimum: 0, maximum: 3660 },
  renewalOffsetDays: { type: 'integer', minimum: 0, maximum: 3660 },
  renewalHistory: list(record({ from: day, chargeLeadDays: positive, cancelLeadDays: positive }, ['from', 'chargeLeadDays', 'cancelLeadDays'])),
};
const phaseFields = {
  ...renewal,
  start: { ...day, description: 'First service day of this phase, NOT an early payment date.' },
  end: {
    ...day,
    description:
      'Last service day, inclusive (the day before the renewal/expiry date). Never equal to the next phase start; omit when continuing into the next phase or still held.',
  },
  billingStart: { ...day, description: 'Original recurring billing anchor when the service start was corrected.' },
  price: positive,
  currency: text,
  cycle,
  billing: billingSchema,
  methodId: text,
  region: text,
  stop,
  priceHistory: list(record({ from: day, amount: positive }, ['from', 'amount'])),
  intro: record({ price: positive, until: day }, ['price', 'until']),
  bonus: {
    ...record({ from: day, until: day }, ['from', 'until']),
    description: 'Free interval [from, until); until is the first paid day. The advertised gift list price is not a payment.',
  },
  payments: {
    ...list(payment),
    description: 'Actual payments owned by THIS phase, including early payments before start. Explicit charges override same-day estimates.',
  },
  nextDue: { ...day, description: 'Next renewal/billing anchor AFTER recorded payments; may be later than end when sold before the prepaid year expired.' },
  note: text,
  planned: bool,
} satisfies Record<keyof Phase, Schema>;
const receipt = record({ id: text, date: day, amount: positive, currency: text, periods: list(day), note: text, opening: bool }, ['id', 'date', 'periods']);
const waiver = record({ id: text, date: day, periods: list(day), note: text }, ['id', 'date', 'periods']);
const member = record(
  {
    id: text,
    personId: text,
    name: text,
    share: amount,
    contactVia: text,
    contact: text,
    tg: text,
    source: text,
    account: text,
    exempt: bool,
    custom: bool,
    fee: positive,
    feeCurrency: text,
    billEvery: { type: 'integer', minimum: 1, maximum: MAX_BILL_MONTHS },
    feeHistory: list(record({ from: day, fee: positive, currency: text, billEvery: positive, share: amount }, ['from', 'fee', 'currency', 'billEvery'])),
    firstPeriod: { type: 'string', enum: ['prorate', 'full', 'free'] },
    firstAmount: positive,
    periodDues: list(record({ from: day, amount: positive }, ['from', 'amount'])),
    restarts: list(day),
    anchor: day,
    receipts: list(receipt),
    waivers: list(waiver),
    note: text,
    joined: day,
    left: day,
    leaveRefund: record({ date: day, amount: positive, currency: text, note: text }, ['date', 'amount', 'currency']),
  },
  ['id', 'name', 'share'],
);
const full = {
  ...phaseFields,
  id: text,
  name: text,
  icon: text,
  url: text,
  manageUrl: text,
  category: text,
  tags: list(text),
  start: day,
  status: { type: 'string', enum: ['active', 'trial', 'paused', 'cancelled', 'terminated'] },
  estimateFrom: day,
  trialEnd: { ...day, description: 'First paid day after the free trial.' },
  pausedAt: day,
  share: record(
    {
      role: { type: 'string', enum: ['owner', 'member'] },
      seats: positive,
      members: list(member),
      ownerName: text,
      since: day,
      collectFrom: day,
      rule: record({ billEvery: positive, fee: positive, currency: text }, ['billEvery', 'fee', 'currency']),
    },
    ['role', 'seats', 'members'],
  ),
  proxy: record(
    {
      personId: text,
      forName: text,
      contactVia: text,
      contact: text,
      note: text,
      receipts: list(receipt),
      waivers: list(waiver),
      charged: list(record({ charge: day, amount: positive, currency: text, note: text }, ['charge'])),
    },
    ['forName'],
  ),
  remindDays: { type: 'integer', minimum: -1 },
  expires: day,
  phases: {
    ...list(record(phaseFields, ['start', 'price', 'currency', 'cycle'])),
    description: 'Plan/service history. Keep top-level price/currency/cycle/methodId mirrored from the last phase. Put payments inside their owning phases.',
  },
  showOnPublic: bool,
  payments: {
    ...list(payment),
    description: 'For SINGLE-phase records only. When phases exist, put actual payments in phases[i].payments; top-level payments are not billed.',
  },
  transfers: list(
    record({ kind: { type: 'string', enum: ['buy', 'sell'] }, date: day, amount: positive, currency: text, note: text }, [
      'kind',
      'date',
      'amount',
      'currency',
    ]),
  ),
  meters: {
    ...list(
      record(
        { id: text, name: text, unit: text, kind: { type: 'string', enum: ['reading'] }, link: record({ subId: text, meterId: text }, ['subId', 'meterId']) },
        ['id', 'name', 'unit'],
      ),
    ),
    description:
      'Custom business meters (electricity, mileage, traffic…). kind=reading is a cumulative counter; omitted = usage per period. link points at a meter owned by another subscription; its values stay there. Prefer set_meters.',
  },
  readings: {
    ...list(
      record({ id: text, date: day, values: { type: 'object', additionalProperties: true, description: 'Meter id → finite number.' }, note: text }, [
        'id',
        'date',
        'values',
      ]),
    ),
    description: 'Recorded meter values by date; values maps meter id to a number. Prefer set_meters / add_readings for edits.',
  },
  account: text,
  notes: text,
  createdAt: text,
  updatedAt: text,
// pauses is recorded by the write path when a pause ends, so it is not an editable field.
} satisfies Record<Exclude<keyof Subscription, 'pauses'>, Schema> & { note: Schema };

// note is a Phase field; a Subscription stores notes instead.
const { note: _note, ...subscription } = full;
export const SUBSCRIPTION_SCHEMA: Schema = {
  ...record(subscription, ['name', 'price', 'currency', 'cycle', 'start', 'status']),
  description:
    'Complete editable record, same as get_subscription.record. Optional nulls are removed. Known last service day goes in end; omit end and stop when unknown. Omit stop unless early-stop details are known. Example: a free gift followed by an early-paid year, sold before expiry.',
  examples: [
    {
      name: 'Gifted server',
      category: 'Tools',
      tags: [],
      start: '2025-11-12',
      end: '2026-07-17',
      status: 'cancelled',
      price: 45.9,
      currency: 'USD',
      cycle: { unit: 'year', every: 1 },
      phases: [
        {
          start: '2025-11-12',
          end: '2026-02-18',
          price: 0,
          currency: 'USD',
          cycle: { unit: 'year', every: 1 },
          bonus: { from: '2025-11-12', until: '2026-02-19' },
          payments: [{ date: '2025-11-12', amount: 0 }],
        },
        {
          start: '2026-02-19',
          end: '2026-07-17',
          price: 45.9,
          currency: 'USD',
          cycle: { unit: 'year', every: 1 },
          nextDue: '2027-02-19',
          payments: [{ date: '2026-02-06', amount: 45.9 }],
        },
      ],
    },
  ],
};

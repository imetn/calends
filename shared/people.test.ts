import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_FX, memberDues } from './billing.ts';
import { maskForPublic } from './mask.ts';
import { linkPeople, mergePeople, normContact, peopleLedger, peopleListRows, personKey, personLink, refsFor, syncPerson } from './people.ts';
import { proxyRows } from './proxy.ts';
import { DEFAULT_SETTINGS, type AppState, type Person, type Subscription } from './types.ts';

const sub = (o: Partial<Subscription>): Subscription => ({
  id: 'x',
  name: 'X',
  category: '工具',
  tags: [],
  price: 60,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-10',
  status: 'active',
  ...o,
});
const st = (subscriptions: Subscription[], people: Person[] = []): AppState => ({
  subscriptions,
  methods: [],
  people,
  settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' },
  fx: FALLBACK_FX,
});

const spotify = sub({
  id: 'sp',
  name: 'Spotify',
  share: {
    role: 'owner',
    seats: 6,
    since: '2026-01-10',
    members: [
      { id: 'a', name: 'Alice', share: 10, contactVia: 'Telegram', contact: '@alice' },
      { id: 'b', name: 'Bob', share: 10, tg: 'bob' },
    ],
  },
});
const yt = sub({
  id: 'yt',
  name: 'YouTube',
  share: {
    role: 'owner',
    seats: 6,
    since: '2026-01-10',
    members: [
      {
        id: 'a2',
        name: ' alice ',
        share: 10,
        contactVia: 'Telegram',
        contact: 'Alice',
        receipts: [
          {
            id: 'o',
            date: '2026-01-10',
            amount: 0,
            currency: 'CNY',
            periods: [
              '2026-01-10',
              '2026-02-10',
              '2026-03-10',
              '2026-04-10',
              '2026-05-10',
              '2026-06-10',
              '2026-07-10',
              '2026-08-10',
              '2026-09-10',
              '2026-10-10',
              '2026-11-10',
            ],
            opening: true,
          },
        ],
      },
      { id: 'c', name: 'Carol', share: 10 },
    ],
  },
});
const proxy = sub({
  id: 'gpt',
  name: 'ChatGPT',
  price: 20,
  start: '2026-08-01',
  proxy: { forName: 'Bob', receipts: [{ id: 'r1', date: '2026-08-03', amount: 20, currency: 'USD', periods: ['2026-08-01'] }] },
});

test('联系方式归一化', () => {
  assert.equal(normContact('Telegram', '@Alice'), 'Telegram:alice');
  assert.equal(normContact(undefined, undefined, 'bob'), 'Telegram:bob');
  assert.equal(normContact('手机', '+86 138-0000-0000'), '手机:8613800000000');
  assert.equal(normContact('Telegram', '  '), '');
  assert.equal(personKey('Ａlice ', 'Telegram', 'alice'), 'alice|Telegram:alice');
});

test('自动建档：同名同联系方式合为一人，只有称呼的归到唯一同名者，可重复执行', () => {
  const r = linkPeople([], [spotify, yt, proxy]);
  // Alice（两处同一 TG）、Bob（TG + 代付只有称呼）、Carol
  assert.equal(r.created.length, 3);
  const id = (sid: string, mid?: string) => {
    const s = r.subs.find((x) => x.id === sid)!;
    return mid ? s.share!.members.find((m) => m.id === mid)!.personId : s.proxy!.personId;
  };
  assert.equal(id('sp', 'a'), id('yt', 'a2'));
  assert.equal(id('sp', 'b'), id('gpt'));
  assert.notEqual(id('sp', 'a'), id('sp', 'b'));
  // 原有字段一个不动
  assert.equal(r.subs.find((x) => x.id === 'yt')!.share!.members[0].name, ' alice ');
  assert.equal(r.subs.find((x) => x.id === 'sp')!.share!.members[1].tg, 'bob');
  // 再跑一次：没有改动
  const again = linkPeople(r.people, [r.subs.find((x) => x.id === 'sp')!, r.subs.find((x) => x.id === 'yt')!, r.subs.find((x) => x.id === 'gpt')!]);
  assert.equal(again.created.length, 0);
  assert.equal(again.subs.length, 0);
  // 同样的数据（并发迁移）得到同样的 id
  assert.deepEqual(
    linkPeople([], [spotify, yt, proxy]).created.map((p) => p.id),
    r.created.map((p) => p.id),
  );
});

test('同名但联系方式不同不合并；同名有多个时只有称呼的单独建档', () => {
  const s = sub({
    id: 's',
    share: {
      role: 'owner',
      seats: 6,
      members: [
        { id: '1', name: 'Mom', share: 1, contactVia: '微信', contact: 'mom1' },
        { id: '2', name: 'Mom', share: 1, contactVia: '微信', contact: 'mom2' },
        { id: '3', name: 'Mom', share: 1 },
        { id: '4', name: '', share: 1 },
      ],
    },
  });
  const r = linkPeople([], [s]);
  assert.equal(r.created.length, 3);
  const ms = r.subs[0].share!.members;
  assert.equal(new Set(ms.slice(0, 3).map((m) => m.personId)).size, 3);
  assert.equal(ms[3].personId, undefined);
});

test('关联到已有的人；指向不存在的人时重新关联', () => {
  const alice: Person = { id: 'alice', name: 'Alice', contactVia: 'Telegram', contact: 'alice' };
  const s = sub({
    id: 's',
    share: { role: 'owner', seats: 6, members: [{ id: '1', name: 'alice', share: 1, contactVia: 'Telegram', contact: '@ALICE', personId: 'ghost' }] },
  });
  const r = linkPeople([alice], [s]);
  assert.equal(r.created.length, 0);
  assert.equal(r.subs[0].share!.members[0].personId, 'alice');
});

test('改人的联系方式处处生效；合并两个人', () => {
  const linked = linkPeople([], [spotify, yt, proxy]);
  const subs = [spotify, yt, proxy].map((s) => linked.subs.find((x) => x.id === s.id) ?? s);
  const bob = linked.people.find((p) => p.name === 'Bob')!;
  const changed = syncPerson(subs, { ...bob, contactVia: 'WhatsApp', contact: '+63 900' });
  assert.equal(changed.length, 2);
  const m = changed.find((s) => s.id === 'sp')!.share!.members.find((x) => x.id === 'b')!;
  assert.equal(m.contact, '+63 900');
  assert.equal(m.tg, undefined);
  assert.equal(changed.find((s) => s.id === 'gpt')!.proxy!.contactVia, 'WhatsApp');

  const carol = linked.people.find((p) => p.name === 'Carol')!;
  const merged = mergePeople(linked.people, subs, carol.id, bob.id);
  assert.equal(merged.people.length, 2);
  const after = subs.map((s) => merged.subs.find((x) => x.id === s.id) ?? s);
  assert.equal(refsFor(after, bob.id).length, 3);
  assert.equal(after.find((s) => s.id === 'yt')!.share!.members.find((x) => x.id === 'c')!.name, 'Bob');
});

test('按人汇总应收：与 memberDues、proxyRows 的结果一致', () => {
  const linked = linkPeople([], [spotify, yt, proxy]);
  const state = st(
    [spotify, yt, proxy].map((s) => linked.subs.find((x) => x.id === s.id) ?? s),
    linked.people,
  );
  const today = '2026-10-19';
  const book = peopleLedger(state, today);
  const bob = book.find((l) => l.person.name === 'Bob')!;
  const shareOwed = memberDues(state.subscriptions[0], today).find((d) => d.member.id === 'b')!.owed;
  const proxyOwed = proxyRows(state, state.subscriptions[2], today)
    .filter((r) => r.receivedBase == null)
    .reduce((a, r) => a + r.chargedBase, 0);
  assert.equal(bob.items.length, 2);
  assert.equal(Math.round(bob.owed * 100), Math.round((shareOwed + proxyOwed) * 100));
  assert.equal(bob.received, 20);
  assert.equal(bob.lastPaid, '2026-08-03');
  const alice = book.find((l) => l.person.name === 'Alice')!;
  assert.equal(alice.items.length, 2);
  // 欠得多的在前
  assert.ok(book[0].owed >= book[book.length - 1].owed);
});

test('公开页不下发名册，也不带成员的 personId', () => {
  const linked = linkPeople([], [spotify]);
  const pub = maskForPublic(st(linked.subs, linked.people));
  assert.equal(pub.people, undefined);
  const json = JSON.stringify(pub);
  assert.ok(!json.includes('Alice') && !json.includes('alice') && !json.includes('personId'));
});

test('公开页不下发设置里取消展示的订阅', () => {
  const state = st([sub({ id: 'a', name: 'A' }), sub({ id: 'b', name: 'B' })]);
  state.settings.publicHidden = ['b'];
  const pub = maskForPublic(state);
  assert.deepEqual(
    pub.subscriptions.map((s) => s.name),
    ['A'],
  );
  // 隐藏列表本身不公开
  assert.equal(pub.settings.publicHidden, undefined);
});

test('同一人的两辆车各有账号，人员同步、合并和公开脱敏保持关系边界', () => {
  const person: Person = { id: 'alex', name: 'Alex', contact: 'contact@example.test', contactVia: '邮箱', note: 'Profile note' };
  const youtube = sub({
    id: 'youtube',
    name: 'YouTube',
    share: { role: 'owner', seats: 6, members: [{ id: 'yt-alex', personId: 'alex', name: 'Alex', share: 10, account: 'alex@example.test' }] },
  });
  const spotify = sub({
    id: 'spotify',
    name: 'Spotify',
    share: { role: 'owner', seats: 6, members: [{ id: 'sp-alex', personId: 'alex', name: 'Alex', share: 10, account: '+65 8000 0000' }] },
  });
  const subscriptions = syncPerson([youtube, spotify], { ...person, name: 'Alex Chen', contact: 'new@example.test' });
  const state = st(subscriptions, [{ ...person, name: 'Alex Chen' }]);
  const ledger = peopleLedger(state, '2026-10-22');
  assert.equal(ledger.length, 1);
  assert.deepEqual(Object.fromEntries(ledger[0].items.map((i) => [i.sub.id, i.member?.account])), { youtube: 'alex@example.test', spotify: '+65 8000 0000' });
  const merged = mergePeople([...state.people!, { id: 'target', name: 'Target' }], subscriptions, 'alex', 'target');
  assert.deepEqual(
    merged.subs.map((s) => s.share!.members[0].account),
    ['alex@example.test', '+65 8000 0000'],
  );
  const publicState = maskForPublic(state);
  for (const s of publicState.subscriptions) assert.equal(s.share, undefined);
  assert.equal(publicState.people, undefined);
});

test('人员列表按待收、最近收款排序，筛选不重复跨车人员且不修改总账', () => {
  const linked = linkPeople([], [spotify, yt, proxy]);
  const book = peopleLedger(st(linked.subs, linked.people), '2026-10-22');
  assert.equal(book.length, 3);
  assert.equal(book.find((l) => l.person.name === 'Alice')?.items.length, 2);
  const before = JSON.stringify(book);
  const owing = peopleListRows(book, { filter: 'owe' });
  const settled = peopleListRows(book, { filter: 'settled' });
  assert.equal(owing.length + settled.length, book.length);
  assert.ok(owing.every((l) => l.owed > 0.005));
  assert.ok(settled.every((l) => l.owed <= 0.005));
  assert.ok(owing.every((l, i) => !i || owing[i - 1].owed >= l.owed));
  assert.equal(JSON.stringify(book), before);
});

test('人员列表金额同值时最近收款优先，表头切换方向，缺失与未知始终靠后', () => {
  const row = (name: string, owed: number, lastPaid?: string) => ({ person: { id: name, name }, owed, received: owed, periodsOwed: 1, items: [], lastPaid });
  const book = [row('A', 0), row('B', 20, '2026-10-01'), row('C', 20, '2026-10-20'), row('D', NaN), row('E', -10, '2026-09-01')];
  const names = (rows: ReturnType<typeof peopleListRows>) => rows.map((l) => l.person.name);
  assert.deepEqual(names(peopleListRows(book)), ['C', 'B', 'A', 'E', 'D']);
  assert.deepEqual(names(peopleListRows(book, { sort: 'received', dir: 'asc' })), ['E', 'A', 'C', 'B', 'D']);
  assert.deepEqual(names(peopleListRows(book, { sort: 'lastPaid', dir: 'asc' })), ['E', 'B', 'C', 'A', 'D']);
  assert.deepEqual(names(peopleListRows(book, { sort: 'lastPaid' })), ['C', 'B', 'E', 'A', 'D']);
  assert.deepEqual(names(peopleListRows(book, { sort: 'name', dir: 'asc' })), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(names(peopleListRows(book, { sort: 'name', dir: 'desc' })), ['E', 'D', 'C', 'B', 'A']);
  assert.deepEqual(names(peopleListRows(book, { filter: 'settled' })), ['A', 'E']);
  assert.deepEqual(
    peopleListRows(book, { filter: 'owe' }).map((l) => l.person.name),
    ['C', 'B'],
  );
  assert.deepEqual(peopleListRows([], { filter: 'owe' }), []);
});

test('personLink：已关联沿用并报告改动，同名唯一复用，联系方式不同或无称呼不复用，新建 id 稳定', () => {
  const people: Person[] = [
    { id: 'a', name: 'Fictional Ann', color: 'blue' },
    { id: 'b', name: 'Fictional Bo', contactVia: 'Telegram', contact: '@bo', color: 'green' },
    { id: 'c1', name: 'Twin', color: 'red' },
    { id: 'c2', name: 'Twin', contactVia: 'Email', contact: 'twin@example.test', color: 'red' },
  ];
  assert.deepEqual(personLink(people, { personId: 'a', name: 'Fictional Ann' }), { id: 'a', after: undefined });
  assert.equal(personLink(people, { personId: 'a', name: 'Ann B.' }).after?.name, 'Ann B.');
  assert.deepEqual(personLink(people, { name: ' fictional  ann ' }), { id: 'a' });
  assert.deepEqual(personLink(people, { name: 'Fictional Bo', contactVia: 'Telegram', contact: 'bo' }), { id: 'b' });
  assert.deepEqual(personLink(people, { name: 'Twin' }), { id: 'c1' });
  const other = personLink(people, { name: 'Fictional Bo', contactVia: 'Telegram', contact: '@someone' });
  assert.equal(other.created?.name, 'Fictional Bo');
  assert.equal(other.created?.contact, '@someone');
  assert.equal(other.id, other.created?.id);
  const fresh = personLink(people, { name: 'Fictional New' });
  assert.deepEqual(personLink(people, { name: 'Fictional New' }), fresh);
  assert.ok(!people.some((p) => p.id === fresh.id));
  assert.deepEqual(personLink(people, { name: '  ' }), { id: undefined });
  assert.equal(personLink(people, { personId: 'kept', name: 'Fictional New' }).created?.id, 'kept');
});

test('人员颜色：预设名原样，色盘自选的 #rrggbb 统一小写，其余丢弃；MCP 用同一条规则', async () => {
  const { personColor, isCustomColor, PERSON_COLOR_PATTERN } = await import('./people.ts');
  assert.equal(personColor('teal'), 'teal');
  assert.equal(personColor('#A1B2C3'), '#a1b2c3');
  assert.equal(personColor('#abc'), undefined);
  assert.equal(personColor('chartreuse'), undefined);
  assert.equal(personColor(42), undefined);
  assert.equal(isCustomColor('#a1b2c3'), true);
  assert.equal(isCustomColor('blue'), false);
  const re = new RegExp(PERSON_COLOR_PATTERN, 'u');
  assert.ok(re.test('indigo') && re.test('#A1B2C3'));
  assert.ok(!re.test('#a1b2c') && !re.test('url(x)'));
});

import { dueTotal, convertedTotal, emptyTotal, sumTotals } from './fx-total.ts';
import { memberCashFlows, memberFlowValue, memberPaidThrough } from './carpool.ts';
// 人：合租成员与代付对象的统一名册。
// 成员、代付上存 personId 指向名册；原来的称呼、联系方式保留为镜像副本，老数据和只认副本的地方（提醒邮件、导出）照常工作。
// 应收按人汇总时，直接复用合租（memberDues）与代付（proxyRows）各自的算法，只是换个维度加起来。
import { collectCurrencyOf, effectiveStatus, fnv1a, isStopped, memberDues, memberAboard } from './billing.ts';
import { toBaseOrNaN } from './fx.ts';
import { proxyRows, proxyTotals } from './proxy.ts';
import { PERSON_COLORS, type AppState, type CustomColor, type Person, type PersonColor, type ShareMember, type Subscription } from './types.ts';

// ---------- 归一化：判断两条记录是不是同一个人 ----------

/** 称呼：全角半角统一、去首尾空白、合并空格、不分大小写 */
export const normName = (s: string | undefined): string => (s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * 反向兜底：查询里包含已有称呼时认出这个人，比如「小柏刚转了我」认出「小柏」。
 * 只用于 list_people 这类读取，且只在正向匹配落空时用；写入不靠它定人，「老王媳妇」不能记到老王头上。称呼至少 2 个字，纯 ASCII 称呼须整词出现；多个命中只留最长的。
 */
export function namesInQuery<T>(items: T[], nameOf: (x: T) => string | undefined, query: string): T[] {
  const q = normName(query);
  const hits = items.filter((x) => {
    const n = normName(nameOf(x));
    if ([...n].length < 2 || n === q) return false;
    if ([...n].every((c) => c.codePointAt(0)! <= 0x7f))
      return new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(q);
    return q.includes(n);
  });
  const len = (x: T) => [...normName(nameOf(x))].length;
  const top = Math.max(0, ...hits.map(len));
  return hits.filter((x) => len(x) === top);
}

/** 联系方式：渠道 + 账号；Telegram、X 去掉 @，手机、WhatsApp 只留数字。没有账号时为空串 */
export function normContact(via?: string, contact?: string, tg?: string): string {
  const v = via ?? (tg ? 'Telegram' : '');
  const raw = (contact ?? tg ?? '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return '';
  const id = v === 'Telegram' || v === 'X' ? raw.replace(/^@+/, '') : v === '手机' || v === 'WhatsApp' ? raw.replace(/\D/g, '') : raw.replace(/\s+/g, '');
  return id ? `${v}:${id}` : '';
}

/** 一个人的身份键：称呼 + 联系方式 */
export const personKey = (name: string | undefined, via?: string, contact?: string, tg?: string): string =>
  `${normName(name)}|${normContact(via, contact, tg)}`;

/** 自动建档的人用 FNV-1a 短哈希当 id，同样的数据算出同样的 id，并发迁移也不会重复建档 */
const hash = fnv1a;

export const colorFor = (seed: string): PersonColor => PERSON_COLORS[hash(seed) % PERSON_COLORS.length];

/** 人员颜色：八种预设之一，或色盘自选的 #rrggbb；MCP 参数用同一条规则 */
export const PERSON_COLOR_PATTERN = `^(${PERSON_COLORS.join('|')}|#[0-9a-fA-F]{6})$`;
export const isCustomColor = (c: unknown): c is CustomColor => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c);
/** 读入时规整：预设名原样，自选色统一小写；其余一律丢弃 */
export const personColor = (c: unknown): PersonColor | CustomColor | undefined =>
  typeof c !== 'string'
    ? undefined
    : PERSON_COLORS.includes(c as PersonColor)
      ? (c as PersonColor)
      : /^#[0-9a-f]{6}$/i.test(c)
        ? (c.toLowerCase() as CustomColor)
        : undefined;

// ---------- 引用：订阅里哪些地方指向人 ----------

/** 一处引用：某个合租的某位成员，或某个代付的对象 */
export type PersonRef = { kind: 'member'; sub: Subscription; member: ShareMember } | { kind: 'proxy'; sub: Subscription };

function refsOf(subs: Subscription[]): PersonRef[] {
  const out: PersonRef[] = [];
  for (const s of subs) {
    for (const m of s.share?.members ?? []) out.push({ kind: 'member', sub: s, member: m });
    if (s.proxy) out.push({ kind: 'proxy', sub: s });
  }
  return out;
}

/** 引用上的镜像副本：称呼与联系方式（早期的 tg 字段视为 Telegram） */
function refInfo(r: PersonRef): { personId?: string; name: string; contactVia?: string; contact?: string } {
  if (r.kind === 'proxy')
    return { personId: r.sub.proxy!.personId, name: r.sub.proxy!.forName ?? '', contactVia: r.sub.proxy!.contactVia, contact: r.sub.proxy!.contact };
  const m = r.member;
  return { personId: m.personId, name: m.name ?? '', contactVia: m.contactVia ?? (m.tg && !m.contact ? 'Telegram' : undefined), contact: m.contact ?? m.tg };
}

/** 某个人在哪些合租、代付里出现 */
export const refsFor = (subs: Subscription[], personId: string): PersonRef[] => refsOf(subs).filter((r) => refInfo(r).personId === personId);

/** 把一组引用改写成新的样子，返回改动过的订阅（同一订阅的多处改动合并在一起） */
function rewrite(subs: Subscription[], fn: (r: PersonRef) => Partial<ShareMember> | undefined): Subscription[] {
  const changed: Subscription[] = [];
  for (const s of subs) {
    let next = s;
    if (s.share?.members.length) {
      const members = s.share.members.map((m) => {
        const p = fn({ kind: 'member', sub: s, member: m });
        return p ? { ...m, ...p } : m;
      });
      if (members.some((m, i) => m !== s.share!.members[i])) next = { ...next, share: { ...s.share, members } };
    }
    if (s.proxy) {
      const p = fn({ kind: 'proxy', sub: s });
      if (p) {
        const { name, ...rest } = p;
        next = { ...next, proxy: { ...s.proxy, ...rest, ...(name !== undefined ? { forName: name } : {}) } };
      }
    }
    if (next !== s && JSON.stringify(next) !== JSON.stringify(s)) changed.push(next);
  }
  return changed;
}

// ---------- 自动建档：一次性迁移，可重复执行 ----------

/**
 * 给还没关联到人的成员、代付找到对应的人；找不到就建档。只做「补上 personId」，不改动任何原有字段。
 * - 称呼 + 联系方式都一样 → 同一个人；
 * - 没填联系方式的，若同名的人只有一个，就归到他名下；同名的有好几个时单独建档，留给用户手动合并；
 * - 没有称呼的不建档；personId 指向已不存在的人时当作未关联重新处理（数据只会更全，不会丢）。
 * 已全部关联时返回空的改动，可以放心在每次读取时调用。
 */
export function linkPeople(people: Person[], subs: Subscription[]): { people: Person[]; created: Person[]; subs: Subscription[] } {
  const ids = new Set(people.map((p) => p.id));
  const byKey = new Map<string, string>();
  const byName = new Map<string, Set<string>>();
  const addName = (n: string, id: string) => {
    if (!byName.has(n)) byName.set(n, new Set());
    byName.get(n)!.add(id);
  };
  for (const p of people) {
    const k = personKey(p.name, p.contactVia, p.contact);
    if (!byKey.has(k)) byKey.set(k, p.id);
    addName(normName(p.name), p.id);
  }
  const created: Person[] = [];
  const create = (k: string, info: ReturnType<typeof refInfo>): string => {
    const id = `p${hash(k).toString(36)}`;
    if (!ids.has(id)) {
      ids.add(id);
      created.push({
        id,
        name: info.name.trim(),
        contactVia: info.contact ? info.contactVia : undefined,
        contact: info.contact || undefined,
        color: colorFor(k),
      });
    }
    byKey.set(k, id);
    addName(normName(info.name), id);
    return id;
  };
  const pending = refsOf(subs).filter((r) => {
    const i = refInfo(r);
    return normName(i.name) && (!i.personId || !ids.has(i.personId));
  });
  const assign = new Map<string, string>();
  const refId = (r: PersonRef) => (r.kind === 'proxy' ? `proxy:${r.sub.id}` : `member:${r.sub.id}:${r.member.id}`);
  // 先处理有联系方式的，再让只有称呼的去认领
  const withContact = pending.filter((r) => normContact(refInfo(r).contactVia, refInfo(r).contact));
  const nameOnly = pending.filter((r) => !withContact.includes(r));
  for (const r of withContact) {
    const i = refInfo(r);
    const k = personKey(i.name, i.contactVia, i.contact);
    assign.set(refId(r), byKey.get(k) ?? create(k, i));
  }
  for (const r of nameOnly) {
    const i = refInfo(r);
    const n = normName(i.name);
    const same = byName.get(n);
    const k = `${n}|`;
    assign.set(refId(r), same?.size === 1 ? [...same][0] : (byKey.get(k) ?? create(k, i)));
  }
  const changed = assign.size ? rewrite(subs, (r) => (assign.has(refId(r)) ? { personId: assign.get(refId(r)) } : undefined)) : [];
  return { people: created.length ? [...people, ...created] : people, created, subs: changed };
}

/**
 * 保存一位成员或代付对象时决定关联到哪个人（网页表单与 MCP 共用）：
 * - personId 指向名册里的人：沿用；称呼或联系方式改了时返回 after，由调用方在保存订阅后同步；
 * - personId 给了但名册里没有：用这个 id 新建；
 * - 没有 personId：按 linkPeople 的规则认人——称呼 + 联系方式都一样的是同一个人；没填联系方式时，同名的只有一个就归他，
 *   有好几个时取其中没留联系方式的那位，都不符合就新建（id 由称呼 + 联系方式算出，预览与确认得到同一个 id）。
 * 没有称呼时不建档。只返回计划，不写入。
 */
export function personLink(
  people: Person[],
  ref: { personId?: string; name: string; contactVia?: string; contact?: string },
): { id?: string; created?: Person; after?: Person } {
  const name = ref.name.trim();
  if (!name) return { id: ref.personId };
  const contact = ref.contact?.trim() || undefined;
  const contactVia = contact ? ref.contactVia : undefined;
  const cur = ref.personId ? people.find((p) => p.id === ref.personId) : undefined;
  if (cur) {
    const changed = cur.name !== name || cur.contact !== contact || (!!contact && cur.contactVia !== contactVia);
    return { id: cur.id, after: changed ? { ...cur, name, contactVia, contact } : undefined };
  }
  const create = (id: string): { id: string; created: Person } => ({ id, created: { id, name, contactVia, contact, color: colorFor(id) } });
  if (ref.personId) return create(ref.personId);
  const key = personKey(name, contactVia, contact);
  const same = people.filter((p) => normName(p.name) === normName(name));
  const match = normContact(contactVia, contact)
    ? people.find((p) => personKey(p.name, p.contactVia, p.contact) === key)
    : same.length === 1
      ? same[0]
      : same.find((p) => !normContact(p.contactVia, p.contact));
  if (match) return { id: match.id };
  const ids = new Set(people.map((p) => p.id));
  let id = `p${hash(key).toString(36)}`;
  for (let i = 2; ids.has(id); i++) id = `p${hash(`${key}#${i}`).toString(36)}`;
  return create(id);
}

// ---------- 改一个人：处处生效 ----------

/** 把这个人的称呼、联系方式同步到所有引用他的成员、代付上，返回改动过的订阅 */
export function syncPerson(subs: Subscription[], p: Person): Subscription[] {
  return rewrite(subs, (r) => {
    if (refInfo(r).personId !== p.id) return undefined;
    // 镜像副本整体换成名册里的：清掉旧的 tg，联系方式跟着人走
    return r.kind === 'member'
      ? { name: p.name, contactVia: p.contact ? p.contactVia : undefined, contact: p.contact || undefined, tg: undefined }
      : { name: p.name, contactVia: p.contact ? p.contactVia : undefined, contact: p.contact || undefined };
  });
}

/** 合并两个人：from 的所有引用改指向 into，再按 into 同步副本；from 从名册里去掉 */
export function mergePeople(people: Person[], subs: Subscription[], fromId: string, intoId: string): { people: Person[]; subs: Subscription[] } {
  const into = people.find((p) => p.id === intoId);
  if (!into || fromId === intoId) return { people, subs: [] };
  const moved = rewrite(subs, (r) => (refInfo(r).personId === fromId ? { personId: intoId } : undefined));
  const all = subs.map((s) => moved.find((x) => x.id === s.id) ?? s);
  const synced = syncPerson(all, into);
  const ids = new Set([...moved, ...synced].map((s) => s.id));
  return { people: people.filter((p) => p.id !== fromId), subs: all.map((s) => synced.find((x) => x.id === s.id) ?? s).filter((s) => ids.has(s.id)) };
}

/** 显示用：引用对应的人；没关联（或名册里找不到）时用副本拼一个 */
function personOf(state: Pick<AppState, 'people'>, r: PersonRef): Person {
  const i = refInfo(r);
  return state.people?.find((p) => p.id === i.personId) ?? { id: '', name: i.name, contactVia: i.contactVia, contact: i.contact };
}

// ---------- 应收：按人汇总 ----------

export interface PersonItem {
  kind: 'share' | 'proxy';
  sub: Subscription;
  member?: ShareMember;
  /** 现在欠我多少（本位币） */
  owed: number;
  /** 欠几期 */
  periodsOwed: number;
  /** 至今收回多少（本位币，按收款当天汇率） */
  received: number;
  lastPaid?: string;
  /** 合租：已付至；代付：无 */
  paidUntil?: string;
  /** 还在进行：成员没退出、订阅没停 */
  active: boolean;
}

export interface PersonLedger {
  person: Person;
  items: PersonItem[];
  owed: number;
  periodsOwed: number;
  received: number;
  lastPaid?: string;
}

/** 一笔合租关系的账：欠款来自 memberDues，收回来自成员的收款记录 */
function shareItem(state: AppState, s: Subscription, m: ShareMember, today: string, dues: ReturnType<typeof memberDues>): PersonItem {
  const d = dues.find((x) => x.member.id === m.id);
  const flows = memberCashFlows(m);
  return {
    kind: 'share',
    sub: s,
    member: m,
    owed: d && !m.exempt ? (Number.isFinite(d.owed) ? toBaseOrNaN(state, d.owed, d.currency) : NaN) : 0,
    periodsOwed: d && !m.exempt ? d.periodsOwed : 0,
    received: flows.reduce((a, p) => a + memberFlowValue(state, p), 0),
    lastPaid: flows.filter((p) => p.kind === 'receipt').reduce<string | undefined>((a, p) => (!a || p.date > a ? p.date : a), undefined),
    paidUntil: memberPaidThrough(s, m, today, collectCurrencyOf(state.settings)),
    active: !!d && memberAboard(m, today) && ['active', 'ending', 'trial'].includes(effectiveStatus(s, today)),
  };
}

/** 一笔代付的账：每期实扣与收回来自 proxyRows */
function proxyItem(state: AppState, s: Subscription, today: string): PersonItem {
  const rows = proxyRows(state, s, today);
  const open = rows.filter((r) => r.receivedBase == null);
  const done = rows.filter((r) => r.receivedBase != null);
  return {
    kind: 'proxy',
    sub: s,
    owed: open.reduce((a, r) => a + r.chargedBase, 0),
    periodsOwed: open.length,
    received: done.reduce((a, r) => a + r.receivedBase!, 0),
    lastPaid: proxyTotals(rows).lastIn,
    active: !isStopped(effectiveStatus(s, today)),
  };
}

/**
 * 每个人的应收总账：在哪些合租 / 代付里、现在欠多少、至今收回多少、最近一次收款。
 * 只统计我发起的合租（我向成员收钱）与代付；没关联到名册的引用按副本里的称呼单独成行，不会漏算。
 * 欠得多的排在前面，其余按称呼排序。
 */
export function peopleLedger(state: AppState, today: string): PersonLedger[] {
  const book = new Map<string, PersonLedger>();
  for (const p of state.people ?? []) book.set(p.id, { person: p, items: [], owed: 0, periodsOwed: 0, received: 0 });
  const dues = new Map<string, ReturnType<typeof memberDues>>();
  for (const r of refsOf(state.subscriptions)) {
    if (r.kind === 'member' && r.sub.share?.role !== 'owner') continue;
    const person = personOf(state, r);
    if (!person.id && !normName(person.name)) continue;
    const key = person.id || `~${personKey(person.name, person.contactVia, person.contact)}`;
    if (!book.has(key)) book.set(key, { person, items: [], owed: 0, periodsOwed: 0, received: 0 });
    if (r.kind === 'member' && !dues.has(r.sub.id)) dues.set(r.sub.id, memberDues(r.sub, today, collectCurrencyOf(state.settings), state));
    const item = r.kind === 'member' ? shareItem(state, r.sub, r.member, today, dues.get(r.sub.id)!) : proxyItem(state, r.sub, today);
    const l = book.get(key)!;
    l.items.push(item);
    l.owed += item.owed;
    l.periodsOwed += item.periodsOwed;
    l.received += item.received;
    if (item.lastPaid && (!l.lastPaid || item.lastPaid > l.lastPaid)) l.lastPaid = item.lastPaid;
  }
  for (const l of book.values()) l.items.sort((a, b) => Number(b.active) - Number(a.active) || b.owed - a.owed || a.sub.name.localeCompare(b.sub.name));
  return [...book.values()].sort(
    (a, b) => (b.owed > 0.005 ? 1 : 0) - (a.owed > 0.005 ? 1 : 0) || b.owed - a.owed || a.person.name.localeCompare(b.person.name),
  );
}

/** Roster presentation only: never alter the underlying ledger or its financial totals. */
export type PeopleSort = 'owed' | 'received' | 'lastPaid' | 'name';
export function peopleListRows(
  book: PersonLedger[],
  {
    filter = 'all',
    sort = 'owed',
    dir = 'desc',
    locale,
  }: { filter?: 'all' | 'owe' | 'settled'; sort?: PeopleSort; dir?: 'asc' | 'desc'; locale?: string } = {},
): PersonLedger[] {
  const byName = (a: PersonLedger, b: PersonLedger) => a.person.name.localeCompare(b.person.name, locale);
  return book
    .filter((l) => filter === 'all' || (Number.isFinite(l.owed) && (filter === 'owe' ? l.owed > 0.005 : l.owed <= 0.005)))
    .sort((a, b) => {
      if (sort === 'name') return (dir === 'asc' ? 1 : -1) * byName(a, b);
      if (sort === 'lastPaid') {
        // Missing dates stay last in either direction.
        if (!a.lastPaid || !b.lastPaid) return Number(!!b.lastPaid) - Number(!!a.lastPaid) || byName(a, b);
        return (dir === 'asc' ? 1 : -1) * a.lastPaid.localeCompare(b.lastPaid) || byName(a, b);
      }
      if (!Number.isFinite(a[sort]) || !Number.isFinite(b[sort])) return Number(Number.isFinite(b[sort])) - Number(Number.isFinite(a[sort])) || byName(a, b);
      return (dir === 'asc' ? 1 : -1) * (a[sort] - b[sort]) || (b.lastPaid ?? '').localeCompare(a.lastPaid ?? '') || byName(a, b);
    });
}

/** Rebuild receivable display totals in the requested currency without losing original cash. */
export function personAmounts(state: AppState, ledger: Pick<PersonLedger, 'items'>, today: string, to = state.settings.baseCurrency) {
  const target = { ...state, settings: { ...state.settings, baseCurrency: to } };
  const parts = ledger.items.map((i) => {
    if (i.kind === 'proxy') return proxyTotals(proxyRows(target, i.sub, today)).partial;
    const m = i.member!;
    const due = memberDues(i.sub, today, collectCurrencyOf(state.settings), state).find((d) => d.member.id === m.id);
    return {
      owed: due && !m.exempt ? dueTotal(state, due, undefined, to) : emptyTotal(),
      received: sumTotals(memberCashFlows(m).map((p) => convertedTotal(state, p.amount, p.currency, p.date, to))),
    };
  });
  return { owed: sumTotals(parts.map((p) => p.owed)), received: sumTotals(parts.map((p) => p.received)) };
}

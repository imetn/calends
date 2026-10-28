import { useEffect, useState } from 'react';
import { todayIn, uid, addDays, memberBillMonths, memberCollection, memberRate, collectionAnchor, collectCurrencyOf } from '../../../../shared/billing.ts';
import type { AppState, Receipt, ShareMember, Subscription } from '../../../../shared/types.ts';
import { editRecordPeriod, isSettled, putRecord, removeRecordPeriod, resolveKey, type LedgerPeriod } from '../../../../shared/receivables.ts';

import { useSubmit } from '../../components/inputs.tsx';
import { getState, savePerson, saveSub } from '../../store.ts';
import { run } from '../../toast.ts';
import { linkPerson } from '../person-fields.tsx';

import {
  carRule,
  followCarRule,
  followsCar,
  memberFee,
  changeMemberFee,
  shareFromFee,
  updateMemberLeave,
  memberCashFlows,
  memberFlowValue,
  waiveExemptSpan,
  memberPaidThrough,
  nextCollectionDay,
  dropReshaped,
  moveMemberJoin,
  putPeriodDues,
} from '../../../../shared/carpool.ts';

import { t } from '../../../../shared/i18n.ts';

import { saveReceivable } from '../MemberReceipt.tsx';
import { memberLedgerAhead } from '../MemberReceipt.tsx';

import { memberStatus } from '../member-status.ts';
export function refundInvalid(s: Subscription, m: ShareMember) {
  const r = m.leaveRefund;
  return !!r && (!m.left || !Number.isFinite(r.amount) || r.amount <= 0 || r.date < (m.joined ?? s.share?.since ?? s.start));
}
export function useMemberForm({
  memberDialog,
  state,
  s,
  member,
  initialReceipt,
  onClose,
  onAdded,
}: {
  memberDialog: typeof import('../Members.tsx').MemberSheet;
  state: AppState;
  s: Subscription;
  member?: ShareMember;
  /** 打开时就叠上的收款表单：欠款时记一笔，从某笔收款进来时改那一笔 */
  initialReceipt?: { edit?: string; preset?: string[] } | null;
  onClose: () => void;
  /** 新成员存好后要接着记收款：交给 MemberSheet 换成这个成员并叠上收款表单 */
  onAdded?: (id: string) => void;
}) {
  const today = todayIn(state.settings.timezone);
  const isNew = !member;
  const once = s.cycle.unit === 'lifetime';
  // 收款默认币种：设置里的「合租收款币种」，缺省同本位币
  const collectCcy = collectCurrencyOf(state.settings);
  const initF = (): ShareMember => {
    // 早期单独记的 Telegram 并入通用的联系方式
    const init =
      member?.tg && !member.contact
        ? { ...member, contactVia: 'Telegram', contact: member.tg, tg: undefined }
        : (member ??
          (() => {
            // 新成员默认跟随车的收款规则
            const r = carRule(state, s, today);
            return {
              id: uid(),
              name: '',
              share: shareFromFee(state, s, r.fee, r.currency, r.billEvery),
              fee: r.fee,
              feeCurrency: r.currency,
              billEvery: r.billEvery,
              joined: today,
            };
          })());
    // 老数据只有每期份额：换算成「每次收多少人民币」
    const fee = memberFee(state, s, init, today);
    return { ...init, fee: fee.amount, feeCurrency: fee.currency };
  };
  const [f, setF] = useState<ShareMember>(initF);
  const up = (p: Partial<ShareMember>) => setF(updateMemberLeave(f, p));
  const via = f.contactVia ?? 'Telegram';
  const setVia = (v: string) => up({ contactVia: v });
  const setContact = (c: string) => up({ contactVia: via, contact: c || undefined, tg: undefined });
  const val = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;

  // 收费：跟随车 / 自定义 / 不分摊。老数据收费与车不一致时视为自定义
  const rule = carRule(state, s, today);
  const initialMode: 'follow' | 'custom' | 'exempt' = member?.exempt ? 'exempt' : !member || followsCar(state, s, member, today) ? 'follow' : 'custom';
  const [mode, setMode] = useState(initialMode);
  const cur = memberFee(state, s, f, today);
  const [fee, setFee] = useState({ amount: cur.amount, currency: cur.currency, billEvery: memberBillMonths(s, f, today) });
  const [feeFrom, setFeeFrom] = useState(today);
  const feeEdited = fee.amount !== cur.amount || fee.currency !== cur.currency || fee.billEvery !== memberBillMonths(s, f, today);
  // 新成员从加入日起按选定的收费；已有成员从生效日起调价，历史收款不变
  const start = isNew ? (f.joined ?? today) : feeFrom;
  const withFee = (m: ShareMember): ShareMember => {
    if (mode === 'exempt') return { ...m, exempt: true };
    const base = { ...m, exempt: undefined };
    // 对齐车的节奏会改动期初结清、免收盖住的期，以账本里最新的记录为准
    if (mode === 'follow')
      return isNew || initialMode !== 'follow'
        ? followCarRule(state, s, { ...base, receipts: member?.receipts, waivers: member?.waivers }, start, today)
        : { ...base, custom: undefined };
    const custom = { ...base, custom: true as const };
    return feeEdited ? changeMemberFee(state, s, custom, { from: start, fee: fee.amount, currency: fee.currency, billEvery: fee.billEvery }, today) : custom;
  };
  const rateChanged = !isNew && mode !== 'exempt' && (mode === 'follow' ? initialMode !== 'follow' : initialMode !== 'custom' || feeEdited);

  // 已有成员改回跟随车：收款日对齐车的节奏，车的下一个收款日前那期（过渡期）不满一整期时缺省按天折算，
  // 可以改收整期或自定义金额，存成这一期的单独定价
  const aligned = withFee(f);
  const alignDay = !isNew && mode === 'follow' && initialMode !== 'follow' ? nextCollectionDay(s, rule.billEvery, addDays(start, -1)) : undefined;
  const bridgeAt = alignDay
    ? memberLedgerAhead(state, s, { ...aligned, periodDues: undefined }, today).periods.find((p) => p.until === addDays(alignDay, -1))
    : undefined;
  const bridgeFull = bridgeAt ? memberRate(s, aligned, bridgeAt.from, collectCcy).amount : 0;
  const bridge = bridgeAt && bridgeAt.due < bridgeFull ? { ...bridgeAt, full: bridgeFull } : undefined;
  const [bridgeDue, setBridgeDue] = useState<number | undefined>(() => f.periodDues?.find((d) => d.from === bridgeAt?.from)?.amount);
  // 编辑里点「取消」：资料、收费都回到账本里的样子，弹窗不关
  const reset = () => {
    const fresh = initF();
    const c = memberFee(state, s, fresh, today);
    setF(fresh);
    setMode(initialMode);
    setFee({ amount: c.amount, currency: c.currency, billEvery: memberBillMonths(s, fresh, today) });
    setFeeFrom(today);
    setBridgeDue(undefined);
  };
  const realigned = !isNew && mode === 'follow' && initialMode !== 'follow';
  const draft = (): ShareMember => {
    let m = aligned;
    if (bridge) {
      const rest = (m.periodDues ?? []).filter((d) => d.from !== bridge.from);
      const dues = bridgeDue == null ? rest : [...rest, { from: bridge.from, amount: bridgeDue }].sort((a, b) => a.from.localeCompare(b.from));
      m = { ...m, periodDues: dues.length ? dues : undefined };
    }
    // 收款、免收以账本为准：收款表单另行保存
    const out = realigned ? m : { ...m, receipts: member?.receipts, waivers: member?.waivers };
    return member ? moveMemberJoin(s, member, out, today, collectCcy).member : out;
  };
  const next = draft();
  // 加入日往后改：新加入日之前已收、免收的期保存时删掉，保存前提示
  const joinDropped = member ? moveMemberJoin(s, member, { ...f, receipts: member.receipts, waivers: member.waivers }, today, collectCcy).dropped : [];
  const ledger = memberLedgerAhead(state, s, next, today);

  // 新成员：勾上就在保存后接着打开收款表单，与之后记收款是同一个表单
  const [collectAfter, setCollectAfter] = useState(false);

  const first = memberCollection(s, f, f.joined ?? s.share?.since ?? s.start, collectCcy);
  // 同一个人还出现在别的合租、代付里：已关联名册里的人，称呼、联系方式只读，改人员资料去人员详情
  const linked = !!f.personId && !!state.people?.some((p) => p.id === f.personId);
  const [profile, setProfile] = useState(false);
  // 收款与免收记录，新的在前；期初结清单独一行，不能当收款编辑
  const records = [...(member?.receipts ?? []), ...(member?.waivers ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const received = member ? memberCashFlows(member).reduce((a, p) => a + memberFlowValue(state, p, collectCcy), 0) : 0;
  const st = memberStatus(state, { ...s, share: { ...s.share!, members: s.share!.members.map((x) => (x.id === next.id ? next : x)) } }, next, today);
  const [receipt, setReceipt] = useState<{ edit?: string; preset?: string[] } | null>(null);
  // 打开时就要叠的收款表单等成员弹窗挂上之后再开：两层同一刻挂载时收款表单会排在成员弹窗下面、被遮住且点不动
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    if (stacked) return;
    setStacked(true);
    if (initialReceipt) setReceipt(initialReceipt);
  }, [stacked, initialReceipt]);
  // 已付至按没退出算：退出后还有已付的天数时照样显示到那期期末，算退款要看
  const paidUntil = memberPaidThrough(s, next, today, collectCcy);

  // 同一笔收款复制给其他成员：大家每期交的一样，不用一个个重填。对方这几期都还空着才能复制
  const others = (s.share?.members ?? []).filter((x) => x.id !== f.id);
  const [copying, setCopying] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const copyable = (o: ShareMember, r: Receipt) => {
    const l = memberLedgerAhead(state, s, o, today);
    // 对方每期都要还空着，而且这几期不能落进对方的同一期（对方按季收、这笔按月抵扣时会撞上）
    const keys = r.periods.map((k) => resolveKey(l.periods, k));
    return new Set(keys).size === keys.length && keys.every((k) => l.periods.some((p) => p.key === k && !isSettled(p)));
  };
  const startCopy = (r: Receipt) => {
    setTargets(others.filter((o) => copyable(o, r)).map((o) => o.id));
    setCopying(r.id);
  };
  const copyTo = (r: Receipt) => {
    const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
    const sh = current.share!;
    run(
      async () => {
        const members = sh.members.map((o) =>
          targets.includes(o.id) ? { ...o, ...putRecord(o, 'receipt', { ...r, id: uid() }, memberLedgerAhead(state, current, o, today).periods) } : o,
        );
        await saveSub({ ...current, share: { ...sh, collectFrom: collectionAnchor(current), members } });
        setCopying(null);
      },
      t('family.member.copied', { count: targets.length }),
    );
  };
  // 每期弹窗里删：只去掉这一期，同一笔的其余期照旧
  const removeRecordPeriodOf = (id: string, period: LedgerPeriod) =>
    run(() => saveReceivable(s, f.id, removeRecordPeriod(member!, id, period, ledger.periods)), t('receivable.toastRemoved'));
  // 每期弹窗里改：日期、这一期的金额、备注；一笔分几期时这一期单独拆出
  const editRecordPeriodOf = (id: string, period: LedgerPeriod, patch: { date: string; amount?: number; note?: string }) =>
    run(() => saveReceivable(s, f.id, editRecordPeriod(member!, id, period, patch, ledger.periods, uid())), t('family.member.saved'));

  // 每期弹窗里改应收：只改这一期，存成这一期的单独定价（与过渡期同一字段）；留空恢复按收费标准算。
  // 与收款一样即时保存，表单里的副本同步更新，之后保存成员表单不会把它改回去
  const setPeriodDue = (period: LedgerPeriod, amount: number | undefined) => {
    const dues = (list: ShareMember['periodDues']) => putPeriodDues(list, { [period.from]: amount ?? null });
    setF((c) => ({ ...c, periodDues: dues(c.periodDues) }));
    if (period.from === bridgeAt?.from) setBridgeDue(amount);
    return run(async () => {
      const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
      const sh = current.share!;
      const members = sh.members.map((o) => (o.id === f.id ? { ...o, periodDues: dues(o.periodDues) } : o));
      await saveSub({ ...current, share: { ...sh, collectFrom: collectionAnchor(current), members } });
    }, t('receivable.dueSaved'));
  };

  const [busy, submit] = useSubmit();
  // after：已有成员存好后的去处（MemberForm 退出编辑、留在弹窗）；缺省关掉
  const save = (after = onClose) =>
    run(
      async () => {
        // 新的人先建档；已有的人改了称呼或联系方式，订阅保存后再同步到他的其他合租、代付
        const link = await linkPerson(state, f.personId, f.name, f.contact ? via : undefined, f.contact);
        const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
        const sh = current.share!;
        const stored = sh.members.find((x) => x.id === next.id);
        const base: ShareMember = { ...next, name: f.name.trim(), account: f.account?.trim() || undefined, personId: link.id };
        // 收款、免收以账本里最新的为准（期间可能在收款表单里记过）；加入日改了，按新加入日对一遍
        const fresh = { ...base, receipts: stored?.receipts, waivers: stored?.waivers };
        const latest = stored ? moveMemberJoin(current, stored, fresh, today, collectCcy).member : fresh;
        // 改回跟随车对齐了节奏：起止变了的期不再被期初结清、免收盖住
        const opened = realigned && stored ? dropReshaped(current, stored, latest) : latest;
        // 取消不分摊：生效日之前没结清的期记成免收，不补收不分摊那段时间
        const out = !isNew && member?.exempt && !opened.exempt ? waiveExemptSpan(current, opened, feeFrom, today, collectCcy) : opened;
        await saveSub({
          ...current,
          share: {
            ...sh,
            collectFrom: collectionAnchor(current),
            members: stored ? sh.members.map((x) => (x.id === out.id ? out : x)) : [...sh.members, out],
          },
        });
        if (link.after) await savePerson(link.after);
        if (isNew && collectAfter && !out.exempt && onAdded) onAdded(out.id);
        else after();
      },
      isNew ? t('family.member.added') : t('family.member.saved'),
    );

  return {
    reset,
    memberDialog,
    state,
    s,
    member,
    onClose,
    today,
    isNew,
    once,
    collectCcy,
    f,
    setF,
    up,
    via,
    setVia,
    setContact,
    val,
    rule,
    initialMode,
    mode,
    setMode,
    cur,
    fee,
    setFee,
    feeFrom,
    setFeeFrom,
    feeEdited,
    start,
    withFee,
    rateChanged,
    bridge,
    bridgeDue,
    setBridgeDue,
    draft,
    next,
    ledger,
    joinDropped,
    collectAfter,
    setCollectAfter,
    first,
    linked,
    profile,
    setProfile,
    records,
    received,
    st,
    receipt,
    setReceipt,
    paidUntil,
    others,
    copying,
    setCopying,
    targets,
    setTargets,
    copyable,
    startCopy,
    copyTo,
    removeRecordPeriodOf,
    editRecordPeriodOf,
    setPeriodDue,
    busy,
    submit,
    save,
  };
}

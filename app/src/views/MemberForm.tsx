import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { useMemberForm, refundInvalid } from './member/useMemberForm.ts';
import { PeriodPop } from './member/Receipts.tsx';

import { PersonAvatar, personFor } from '../components/PersonAvatar.tsx';
import { useEffect, useState } from 'react';
import { calendarSpan, collectionAnchor } from '../../../shared/billing.ts';
import { cnDate, cnDateFull, money } from '../../../shared/format.ts';
import type { AppState, Person, ShareMember, Subscription } from '../../../shared/types.ts';
import type { LedgerPeriod } from '../../../shared/receivables.ts';
import { PeriodStrip } from './Receivable.tsx';
import { DatePicker } from '../components/DatePicker.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { Sheet } from '../components/overlays.tsx';
import { Icon } from '../components/icons.tsx';
import { NumInput, Seg, Toggle } from '../components/inputs.tsx';
import { getState, saveSub } from '../store.ts';
import { run } from '../toast.ts';

import { PersonProfileSheet } from './PersonProfile.tsx';
import { PersonPicker } from './person-fields.tsx';
import { suggestedLeaveRefund, updateMemberLeave } from '../../../shared/carpool.ts';
import { CurrencySelect, Picker } from '../components/Picker.tsx';
import { t } from '../../../shared/i18n.ts';
import { contactText } from '../components/Contact.tsx';
import { perBill } from './member-fields.tsx';
import { FeeRuleFields } from './member-fields.tsx';

import { ReceiptForm } from './MemberReceipt.tsx';

/**
 * 成员的称呼：没关联人员时是输入框，打字时下面联想名册里的人，选中即关联；不选就按输入的称呼新建。
 * 已关联后这一行换成「人员」选择胶囊（PersonPicker），点开换人或选「新建人员」重新输入
 */
export function PersonNameField({
  state,
  name,
  autoFocus,
  onType,
  onPick,
}: {
  state: AppState;
  name: string;
  autoFocus?: boolean;
  onType: (name: string) => void;
  onPick: (p: Person | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const q = name.trim().toLowerCase();
  const people = (state.people ?? [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || contactText(p).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 6);
  const show = open && people.length > 0;
  return (
    <span className="pn-field">
      <input
        value={name}
        autoFocus={autoFocus}
        placeholder={t(people.length || !q ? 'family.member.namePickPh' : 'family.member.namePh')}
        onChange={(e) => {
          onType(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') setHi((i) => Math.min(people.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setHi((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter') onPick(people[hi]);
          else if (e.key === 'Escape') setOpen(false);
          else return;
          // 只操作联想框，不让 Esc、回车冒泡去关弹窗或提交
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {show && (
        <div className="ed-suggest pn-suggest" role="listbox">
          <div className="ed-suggest-h">{t('family.member.pickPerson')}</div>
          {people.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`hit ${i === hi ? 'hi' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setHi(i)}
              onClick={() => onPick(p)}
            >
              <PersonAvatar p={p} size={24} />
              <span style={{ minWidth: 0 }}>
                <b>{p.name}</b>
                {contactText(p) && <small>{contactText(p)}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * 成员表单（新增与编辑同一个、同一顺序）：是谁 → 收款 → 收费 → 座位。
 * 人员本身的称呼、联系方式属于人员，已关联时在人员详情里改；这里是「这个人在这辆车上的座位」。
 * 新增时可勾「保存后记收款」，存好后接着打开与之后记收款相同的收款表单。
 */
export function MemberForm({
  memberDialog,
  state,
  s,
  member,
  initialReceipt,
  onOpenSub,
  onClose,
  onAdded,
}: {
  memberDialog: typeof import('./Members.tsx').MemberSheet;
  state: AppState;
  s: Subscription;
  member?: ShareMember;
  /** 打开时就叠上的收款表单（见 MemberSheet） */
  initialReceipt?: { edit?: string; preset?: string[] } | null;
  /** 收款表单顶部「查看详情」 */
  onOpenSub?: () => void;
  onClose: () => void;
  /** 新成员存好后接着记收款（见 MemberSheet） */
  onAdded?: (id: string) => void;
}) {
  const context = useMemberForm({ memberDialog, state, s, member, initialReceipt, onClose, onAdded });
  // 已有成员：资料平时只读，点「编辑」才换成输入框
  const [editing, setEditing] = useState(false);
  const [cell, setCell] = useState<{ period: LedgerPeriod; anchor: HTMLElement } | null>(null);
  const {
    today,
    isNew,
    once,
    f,
    setF,
    up,
    val,
    rule,
    mode,
    setMode,
    fee,
    setFee,
    feeFrom,
    setFeeFrom,
    rateChanged,
    bridge,
    bridgeDue,
    setBridgeDue,
    next,
    ledger,
    joinDropped,
    collectAfter,
    setCollectAfter,
    first,
    canOwnDay,
    ownDay,
    setOwnDay,
    setFeeRule,
    linked,
    profile,
    setProfile,
    st,
    receipt,
    setReceipt,
    paidUntil,
    busy,
    submit,
    save,
    reset,
  } = context;
  // 只读时跟着账本走：存好、在收款表单里记过一笔后，资料和收费都以账本里最新的为准，下次编辑从这里起
  useEffect(() => {
    if (!isNew && !editing) reset();
  }, [member, editing]);
  // 加入时长：从加入日期算到退出日期（还在合租就到今天），几年几个月几天
  const joinedOn = f.joined ?? s.share?.since ?? s.start;
  const span = calendarSpan(joinedOn, f.left && f.left < today ? f.left : today);
  const tenure =
    joinedOn <= today
      ? [
          span.years && t('detail.stats.years', { count: span.years }),
          span.months && t('detail.stats.months', { count: span.months }),
          (span.days || (!span.years && !span.months)) && t('detail.stats.days', { count: span.days }),
        ]
          .filter(Boolean)
          .join(' ')
      : undefined;
  // 加入日往后改要删掉的期：几期、其中实收多少（按收款币种分开写）
  const dropPaid: Record<string, number> = {};
  for (const p of joinDropped)
    if (p.receipt && !p.receipt.opening && p.share != null) dropPaid[p.receipt.currency] = (dropPaid[p.receipt.currency] ?? 0) + p.share;
  const dropNote = joinDropped.length
    ? t(Object.keys(dropPaid).length ? 'family.member.joinDropPaid' : 'family.member.joinDrop', {
        count: joinDropped.length,
        amount: Object.entries(dropPaid)
          .map(([c, a]) => money(a, c))
          .join(' + '),
      })
    : undefined;
  const pickPerson = (p: Person | undefined) => {
    if (!p) return up({ personId: undefined, name: '', contactVia: undefined, contact: undefined, tg: undefined });
    // 这个人在别的车上只用过一个账号时一起带出来，可以再改
    const used = [
      ...new Set(
        state.subscriptions
          .flatMap((x) => x.share?.members ?? [])
          .filter((m) => m.personId === p.id && m.account)
          .map((m) => m.account!),
      ),
    ];
    up({
      personId: p.id,
      name: p.name,
      contactVia: p.contactVia,
      contact: p.contact,
      tg: undefined,
      ...(!f.account && used.length === 1 ? { account: used[0] } : {}),
    });
  };
  // 人员：已关联的人是选择胶囊，点开换人；没关联时输入称呼，打字时联想已有的人
  const personField = linked ? (
    <Cell label={t('people.field.person')}>
      <PersonPicker state={state} value={f.personId} onPick={pickPerson} />
    </Cell>
  ) : (
    <Cell
      label={
        <span className="row">
          <PersonAvatar p={personFor(state, f.personId, f.name)} size={28} />
          {t('family.member.name')}
        </span>
      }
    >
      <PersonNameField state={state} name={f.name} autoFocus={isNew} onType={(name) => up({ name })} onPick={pickPerson} />
    </Cell>
  );
  const accountField = (
    <Cell label={t('family.member.accountHere')}>
      <input autoCapitalize="off" value={f.account ?? ''} placeholder={t('family.member.accountPhShort')} onChange={(e) => up({ account: val(e) })} />
    </Cell>
  );
  const joinedField = (
    <Cell label={t('family.member.joined')}>
      <DatePicker
        value={f.joined}
        clearable
        max={f.left}
        placeholder={s.share?.since ? t('family.member.joinedPh', { date: cnDateFull(s.share.since) }) : t('family.member.notSet')}
        onChange={(v) => up({ joined: v })}
      />
    </Cell>
  );
  // 收费：一行选跟随车 / 自定义 / 不分摊，跟随车时标签下写车的标准；自定义才展开金额和周期，改了才问从哪天生效
  // 已有成员的调价记录按时间往下排：之前的标准灰字，现行的一条接在最后；自定义时现行的就是下面的输入框
  const carFee = perBill('family.pool.perFee', rule.billEvery, { fee: money(rule.fee, rule.currency) });
  const history = member?.feeHistory ?? [];
  const current = history.filter((p) => p.from <= today).at(-1);
  const pointRow = (point: (typeof history)[number]) => (
    <Cell key={point.from} label={cnDateFull(point.from)}>
      <span className="muted">{perBill('family.pool.perFee', point.billEvery, { fee: money(point.fee, point.currency) })}</span>
    </Cell>
  );
  // 收费方式三选一，平铺出来一眼看清当前是哪种
  const modeSeg = (onChange: (v: typeof mode) => void) => (
    <Seg
      small
      value={mode}
      onChange={onChange}
      options={[
        ['follow', t('family.rule.follow')],
        ['custom', t('family.rule.custom')],
        ['exempt', t('family.member.exempt')],
      ]}
    />
  );
  const feeFields = (
    <>
      <Cell label={t('family.member.feeGroup')}>{modeSeg(setMode)}</Cell>
      {!isNew && history.filter((p) => p.from <= today && p !== current).map(pointRow)}
      {!isNew && mode === 'follow' && !rateChanged && <Cell label={cnDateFull(current?.from ?? joinedOn)}>{carFee}</Cell>}
      {mode === 'custom' && (
        <FeeRuleFields
          value={{ billEvery: fee.billEvery, fee: fee.amount, currency: fee.currency }}
          onChange={(r) => setFee({ billEvery: r.billEvery, amount: r.fee, currency: r.currency })}
        />
      )}
      {!isNew && history.filter((p) => p.from > today).map(pointRow)}
      {rateChanged && (
        <>
          <Cell label={t('family.collect.feeFrom')} sub={mode === 'follow' ? carFee : undefined}>
            <DatePicker value={feeFrom} onChange={(v) => v && setFeeFrom(v)} />
          </Cell>
          {/* 改回跟随车时收款日对齐车的节奏：之前截短的那期缺省按天折算，可收整期或改金额 */}
          {bridge && (
            <>
              <Cell label={t('family.member.bridge')} sub={`${cnDate(bridge.from)} – ${cnDate(bridge.until)}`}>
                <Picker
                  value={bridgeDue === bridge.full ? 'full' : 'prorate'}
                  onChange={(v) => setBridgeDue(v === 'full' ? bridge.full : undefined)}
                  options={['prorate', 'full'].map((value) => ({ value, label: t(`family.member.firstMode.${value}`) }))}
                />
              </Cell>
              <Cell label={t('family.member.bridgeAmount')}>
                <NumInput ccy={bridge.currency} className="num" value={bridgeDue} placeholder={String(bridge.due)} onValue={(n) => setBridgeDue(n)} />
              </Cell>
            </>
          )}
        </>
      )}
    </>
  );
  // 是谁：新增和已有成员都放最前面
  const whoGroup = (
    <>
      {/* 是谁：新建或从人员里选；已关联的人只读，资料在人员详情里改 */}
      <Group
        title={t('family.member.group')}
        action={
          linked ? (
            <button type="button" className="btn plain" onClick={() => setProfile(true)}>
              {t('people.field.editProfile')}
            </button>
          ) : undefined
        }
      >
        {personField}
        {/* 联系方式属于人员，在人员资料里看和改；这里只填这个人在这辆车上用的账号 */}
        {accountField}
      </Group>
    </>
  );
  // 新成员：哪天上车、首期怎么算
  const seatGroup = (
    <>
      <Group title={t('family.member.seatGroup')}>
        {joinedField}
        {/* 收款日跟着加入日期写：跟随车的日子，或从加入日起；下面写出下次收款日 */}
        {canOwnDay && (
          <Cell label={t('family.member.collectDay')} sub={t('family.member.nextCollect', { date: cnDate(first.next) })}>
            <Picker
              value={ownDay ? 'own' : 'car'}
              onChange={(v) => setOwnDay(v === 'own')}
              options={[
                { value: 'car', label: t('family.member.collectDayCar') },
                { value: 'own', label: t('family.member.collectDayOwn') },
              ]}
            />
          </Cell>
        )}
        {first.partial && mode !== 'exempt' && bridge?.from !== first.from && !ledger.periods.some((p) => p.key === first.from && p.status === 'paid') && (
          <>
            {/* 首期起止写在「首期方式」标签下面；折算出的金额是首期金额的占位，不再单独一行提示 */}
            <Cell label={t('family.member.firstPeriod')} sub={`${cnDate(first.from)} – ${cnDate(first.until)}`}>
              <Picker
                value={f.firstPeriod ?? 'prorate'}
                onChange={(v) => up({ firstPeriod: v as ShareMember['firstPeriod'], firstAmount: undefined })}
                options={['prorate', 'full', 'free'].map((value) => ({ value, label: t(`family.member.firstMode.${value}`) }))}
              />
            </Cell>
            {f.firstPeriod !== 'free' && (
              <Cell label={t('family.member.firstAmount')}>
                <NumInput
                  ccy={first.currency}
                  className="num"
                  value={f.firstAmount}
                  placeholder={String(first.amount)}
                  onValue={(n) => up({ firstAmount: n })}
                />
              </Cell>
            )}
          </>
        )}
        {/* 首笔款紧跟首期金额；勾上则存好后接着打开收款表单 */}
        {mode !== 'exempt' && (
          <Cell label={t('family.member.firstPayToggle')}>
            <Toggle checked={collectAfter} onChange={setCollectAfter} />
          </Cell>
        )}
      </Group>
    </>
  );
  // 新成员：周期、金额直接摆出来，默认是合租的标准；改了就成自定义，点「跟随合租」回到合租的标准
  const feeRule = mode === 'custom' ? { billEvery: fee.billEvery, fee: fee.amount, currency: fee.currency } : rule;
  const feeGroup = (
    <Group title={t('family.member.feeGroup')} foot={mode === 'follow' ? t('family.rule.followNote') : undefined}>
      <Cell label={t('family.rule.mode')}>{modeSeg((v) => (v === 'follow' ? setFeeRule(rule) : setMode(v)))}</Cell>
      {mode !== 'exempt' && <FeeRuleFields value={feeRule} onChange={setFeeRule} />}
    </Group>
  );
  // 已有成员的收费标准、退出写成一句话（只读时）
  const feeText =
    mode === 'exempt'
      ? t('family.member.exempt')
      : mode === 'custom'
        ? perBill('family.pool.perFee', fee.billEvery, { fee: money(fee.amount, fee.currency) })
        : carFee;
  const refund = f.leaveRefund;
  // 已付至（从第一期起连续结清到哪天）和加入时长两种状态都显示，改退出、退款时要看
  const paidCell = !once && mode !== 'exempt' && (
    <Cell label={t('family.member.paidUntil')}>
      <span className={paidUntil ? '' : 'muted'}>{paidUntil ? cnDateFull(paidUntil) : t('family.pool.noPay')}</span>
    </Cell>
  );
  const tenureCell = tenure && <Cell label={t('family.member.tenure')}>{tenure}</Cell>;
  // 已有成员：人员和账号在最上面，平时只读，点「编辑」才可重选人员、改账号；人员资料点人员那一行打开
  const memberWho = (
    <Group title={t('family.member.group')}>
      {editing ? (
        personField
      ) : (
        // 已关联的人点这一行看、改人员资料（联系方式在那里）
        <Cell label={linked ? t('people.field.person') : t('family.member.name')} onClick={linked ? () => setProfile(true) : undefined}>
          <span className="row">
            <PersonAvatar p={personFor(state, f.personId, f.name)} size={22} />
            {f.name}
          </span>
        </Cell>
      )}
      {editing ? accountField : <Cell label={t('family.member.accountHere')}>{f.account || <span className="muted">{t('family.member.notSet')}</span>}</Cell>}
    </Group>
  );
  // 收费和日期合在一组；平时只读，点底部「编辑」换成输入框。
  // 加入日期往后改时，新日期之前已收、免收的期保存时删掉，组底先提示
  const infoGroup = (
    <Group foot={editing ? [dropNote, rateChanged && t('family.collect.feeHelp')].filter(Boolean).join('\n') || undefined : undefined}>
      {editing ? (
        <>
          {feeFields}
          {paidCell}
          {joinedField}
          {tenureCell}
          <MemberLeaveFields state={state} s={s} member={f} onChange={up} />
          {/* 来源这类说明属于人员（人员资料里的备注）；只给已经填过的旧数据留着，可改可清空 */}
          {member?.source && (
            <Cell label={t('family.member.source')}>
              <input value={f.source ?? ''} placeholder={t('family.member.sourcePh')} onChange={(e) => up({ source: val(e) || undefined })} />
            </Cell>
          )}
        </>
      ) : (
        <>
          <Cell label={t('family.member.feeGroup')}>{feeText}</Cell>
          {paidCell}
          <Cell label={t('family.member.joined')}>{cnDateFull(joinedOn)}</Cell>
          {tenureCell}
          <Cell label={t('family.member.left')}>{f.left ? cnDateFull(f.left) : <span className="muted">{t('family.member.leftPh')}</span>}</Cell>
          {refund && <Cell label={t('family.refund.title')}>{money(refund.amount, refund.currency)}</Cell>}
        </>
      )}
    </Group>
  );
  return (
    <Sheet
      narrow
      title={isNew ? t('family.member.titleNew', { name: s.name }) : s.name}
      onClose={onClose}
      foot={
        <>
          {!isNew && (
            <ConfirmButton
              disabled={busy}
              hint={t('family.member.confirmDelete', { name: f.name || t('family.member.unnamed') })}
              onConfirm={() =>
                submit(() =>
                  run(async () => {
                    const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
                    await saveSub({
                      ...current,
                      share: { ...current.share!, collectFrom: collectionAnchor(current), members: current.share!.members.filter((x) => x.id !== f.id) },
                    });
                    onClose();
                  }, t('family.member.deleted')),
                )
              }
            >
              {t('family.member.delete')}
            </ConfirmButton>
          )}
          <span className="grow" />
          {isNew || editing ? (
            <>
              {/* 新成员取消即关掉；已有成员取消只退出编辑，改动丢掉，留在这个弹窗 */}
              <button
                className="btn"
                onClick={() => {
                  if (isNew) return onClose();
                  reset();
                  setEditing(false);
                }}
              >
                {t('family.member.cancel')}
              </button>
              <button
                className="btn primary"
                disabled={busy || !f.name.trim() || refundInvalid(s, next)}
                onClick={() => void submit(() => save(isNew ? onClose : () => setEditing(false)))}
              >
                {isNew ? t('family.member.add') : t('family.member.save')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" aria-expanded={false} onClick={() => setEditing(true)}>
                {t('detail.action.edit')}
              </button>
              <button className="btn primary" onClick={onClose}>
                {t('common.done')}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="stack">
        {isNew ? (
          <>
            {whoGroup}
            {seatGroup}
            {feeGroup}
          </>
        ) : (
          <>
            {memberWho}
            {/* 收款格子在人员下面：一格一期，点已收的格子看明细；欠款默认勾欠的期，结清了默认勾下一期（预收） */}
            {mode !== 'exempt' && (
              <Group
                foot={
                  [
                    st.gone || !st.owe
                      ? once && !st.gone
                        ? t('family.pool.settled')
                        : ''
                      : `${st.late > 0 ? `${t('family.quick.late', { count: st.late })}\n` : ''}${once ? t('family.quick.owe', { amount: st.owed, date: cnDateFull(st.next.from) }) : t('family.pool.owedAmount', { amount: st.owed })}`,
                    ledger.unmatched.length ? t('receivable.unmatchedNote', { count: ledger.unmatched.length }) : '',
                  ]
                    .filter(Boolean)
                    .join('\n') || undefined
                }
              >
                {!once && (
                  <div className="cell">
                    <PeriodStrip mode="months" periods={ledger.periods} today={today} onPick={(p, anchor) => setCell({ period: p, anchor })} />
                  </div>
                )}
                {!st.gone && (
                  <button type="button" className="cell tap member-pay-add" onClick={() => setReceipt({})}>
                    <Icon name="plus" /> {t('family.quick.backCollect')}
                  </button>
                )}
              </Group>
            )}
            {infoGroup}
          </>
        )}
      </div>
      {cell && <PeriodPop key={cell.period.key} context={context} period={cell.period} anchor={cell.anchor} onClose={() => setCell(null)} />}
      {/* 记一笔、改某一笔：叠在成员表单上，存完回到这里，成员表单里没保存的修改不丢 */}
      {receipt !== null && member && (
        <ReceiptForm state={state} s={s} member={member} editId={receipt.edit} preset={receipt.preset} onOpenSub={onOpenSub} onDone={() => setReceipt(null)} />
      )}
      {profile && f.personId && (
        <PersonProfileSheet
          memberDialog={memberDialog}
          state={state}
          today={today}
          personId={f.personId}
          onOpen={() => setProfile(false)}
          onClose={() => {
            setProfile(false);
            // 人员资料改过后，把这里的称呼、联系方式副本对齐到最新
            const p = getState().people?.find((x) => x.id === f.personId);
            if (p) setF((c) => ({ ...c, name: p.name, contactVia: p.contactVia, contact: p.contact, tg: undefined }));
          }}
        />
      )}
    </Sheet>
  );
}

/** 下车退款仅记录用户确认的实退；选择退还时才填入建议值。 */

export function MemberLeaveFields({
  state,
  s,
  member: m,
  onChange,
}: {
  state: AppState;
  s: Subscription;
  member: ShareMember;
  onChange: (p: Partial<ShareMember>) => void;
}) {
  const r = m.leaveRefund;
  return (
    <>
      <Cell label={t('family.member.left')}>
        <DatePicker
          value={m.left}
          clearable
          min={m.joined ?? s.share?.since ?? s.start}
          placeholder={t('family.member.leftPh')}
          onChange={(v) => onChange(updateMemberLeave(m, { left: v }))}
        />
      </Cell>
      {m.left && (
        <>
          <Cell label={t('family.refund.title')}>
            <Seg
              value={r ? 'refund' : 'none'}
              onChange={(v) => {
                const suggestion = suggestedLeaveRefund(state, s, m);
                onChange({
                  leaveRefund:
                    v === 'none'
                      ? undefined
                      : { amount: Number.isFinite(suggestion.amount) ? suggestion.amount : 0, currency: suggestion.currency, date: m.left! },
                });
              }}
              options={[
                ['none', t('family.refund.none')],
                ['refund', t('family.refund.unused')],
              ]}
            />
          </Cell>
          {r && (
            <>
              <Cell label={t('family.member.amount')}>
                <span className="contact-field">
                  <NumInput className="num" ccy={r.currency} value={r.amount} onValue={(n) => onChange({ leaveRefund: { ...r, amount: n ?? 0 } })} />
                  <CurrencySelect value={r.currency} onChange={(currency) => onChange({ leaveRefund: { ...r, currency } })} />
                </span>
              </Cell>
              <Cell label={t('family.refund.date')}>
                <DatePicker value={r.date} min={m.joined ?? s.share?.since ?? s.start} onChange={(date) => date && onChange({ leaveRefund: { ...r, date } })} />
              </Cell>
              <Cell label={t('family.member.note')}>
                <input value={r.note ?? ''} onChange={(e) => onChange({ leaveRefund: { ...r, note: e.target.value || undefined } })} />
              </Cell>
            </>
          )}
        </>
      )}
    </>
  );
}

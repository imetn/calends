import { personFor } from '../components/PersonAvatar.tsx';
import { addMonths, cycleLabel, todayIn, memberBillMonths, memberLedger, collectionAnchor, collectCurrencyOf } from '../../../shared/billing.ts';
import { money } from '../../../shared/format.ts';
import type { AppState, ShareMember, Subscription } from '../../../shared/types.ts';
import { type Receivable } from '../../../shared/receivables.ts';
import { ReceivableSheet } from './Receivable.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { SubIcon } from '../components/marks.tsx';
import { getState, saveSub } from '../store.ts';
import { memberFee, putPeriodDues, type PeriodDueChanges } from '../../../shared/carpool.ts';
import { t } from '../../../shared/i18n.ts';
import { perBill } from './member-fields.tsx';

/** 把一个成员的收款、免收写回账本：以账本里最新的成员为底，只换这两项；记收款时改了单期应收的一并写入 */
export async function saveReceivable(s: Subscription, memberId: string, r: Receivable, dues?: PeriodDueChanges) {
  const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
  const sh = current.share!;
  const members = sh.members.map((x) =>
    x.id === memberId ? { ...x, receipts: r.receipts, waivers: r.waivers, ...(dues ? { periodDues: putPeriodDues(x.periodDues, dues) } : {}) } : x,
  );
  await saveSub({ ...current, share: { ...sh, collectFrom: collectionAnchor(current), members } });
}

/** 成员的各期：算到十年后，可以提前收 */
export const memberLedgerAhead = (state: AppState, s: Subscription, m: ShareMember, today: string) =>
  memberLedger(s, m, today, collectCurrencyOf(state.settings), addMonths(today, 120));

/**
 * 收款表单（全站唯一）：上面是这辆车和收费标准（只读），下面勾选这笔钱抵扣哪几期、实际收了多少。
 * 传 editId 时是修改已记的那一笔（收款或免收），可删除。
 */
export function ReceiptForm({
  state,
  s,
  member: m,
  editId,
  preset,
  onDone,
  onOpenSub,
}: {
  state: AppState;
  s: Subscription;
  member: ShareMember;
  editId?: string;
  preset?: string[];
  onDone: () => void;
  onOpenSub?: () => void;
}) {
  const today = todayIn(state.settings.timezone);
  const cur = memberFee(state, s, m, today);
  const collectCcy = collectCurrencyOf(state.settings);
  const edit = [...(m.receipts ?? []), ...(m.waivers ?? [])].find((x) => x.id === editId);
  const name = m.name || t('family.member.defaultName');
  return (
    <ReceivableSheet
      state={state}
      today={today}
      person={{ ...personFor(state, m.personId, m.name), name }}
      head={
        <>
          {/* 从合租页进来时标明是哪辆车：同一个人可能在好几辆车上 */}
          {onOpenSub && (
            <div className="collect-sub">
              <SubIcon sub={s} size={32} />
              <span className="collect-sub-id">
                <b>{s.name}</b>
                <small>
                  {money(s.price, s.currency)} {cycleLabel(s.cycle)}
                </small>
              </span>
              <button type="button" className="collect-sub-link" onClick={onOpenSub}>
                {t('family.collect.viewSub')}
              </button>
            </div>
          )}
          {!m.exempt && (
            <Group>
              <Cell label={t('family.member.feeGroup')}>
                <span className="muted">{perBill('family.pool.perFee', memberBillMonths(s, m, today), { fee: money(cur.amount, cur.currency) })}</span>
              </Cell>
            </Group>
          )}
        </>
      }
      ledger={(through, dues) => memberLedger(s, dues ? { ...m, periodDues: putPeriodDues(m.periodDues, dues) } : m, today, collectCcy, through).periods}
      dueEditable={!m.exempt}
      record={m}
      edit={edit}
      preset={preset}
      save={(r, dues) => saveReceivable(s, m.id, r, dues)}
      onDone={onDone}
    />
  );
}

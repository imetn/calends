import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmButton } from '../../components/ConfirmButton.tsx';
import { FileSheet } from '../../components/FileSheet.tsx';
import { useFilePicker, useUpload } from '../../components/FileUpload.tsx';
import { Icon } from '../../components/icons.tsx';
import { NumInput } from '../../components/inputs.tsx';
import { cnDate } from '../../../../shared/format.ts';
import { filesForReceipt } from '../../../../shared/files.ts';

import { isSettled, paidThrough, type LedgerPeriod } from '../../../../shared/receivables.ts';
import { isReceipt, periodRange, PeriodTip, usePeriodEdit } from '../Receivable.tsx';
import { canAttach } from '../detail/FilesCard.tsx';
import { Pop } from '../../components/Pop.tsx';

import { t } from '../../../../shared/i18n.ts';

import { memberLedgerAhead } from '../MemberReceipt.tsx';

import type { useMemberForm } from './useMemberForm.ts';

/**
 * 点开一格：这一期的明细，字段与悬停提示、代付每期弹窗相同。点应收金额单独改这一期的应收；
 * 已记的期点「编辑」原地改日期、这一期的金额和备注，点「一笔分几期」改整笔（调整抵扣哪几期），也可复制给其他成员、删掉这一期（其余期照旧）；
 * 没记的期直接记收款
 */
export function PeriodPop({
  context,
  period: p,
  anchor,
  onClose,
}: {
  context: ReturnType<typeof useMemberForm>;
  period: LedgerPeriod;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const { state, s, today, setReceipt, others, copying, setCopying, startCopy, removeRecordPeriodOf, editRecordPeriodOf, setPeriodDue } = context;
  const r = p.receipt ?? p.waiver;
  const realReceipt = r && isReceipt(r) && !r.opening ? r : undefined;
  const attached = realReceipt ? filesForReceipt(state.files ?? [], s.id, realReceipt.id) : [];
  const [openFile, setOpenFile] = useState<string>();
  const up = useUpload(realReceipt ? { subId: s.id, kind: 'receipt', date: realReceipt.date, receiptId: realReceipt.id } : {});
  const [picker, pick] = useFilePicker((files) => void up.uploadAsync(files));
  const can = !!realReceipt && canAttach(state);
  const edit = usePeriodEdit(p);
  // 改应收：null 是没在改；留空（undefined）保存即恢复按收费标准算
  const [due, setDue] = useState<number | undefined | null>(null);
  const openWhole = () => {
    onClose();
    setCopying(null);
    setReceipt({ edit: r!.id });
  };
  const editing = edit.editing || due !== null;
  return (
    <Pop triggerRef={{ current: anchor }} label={periodRange(p)} className="period-pop" placement="bottom start" onClose={onClose}>
      <PeriodTip
        p={p}
        edit={edit}
        onBatch={edit.editable && r && isReceipt(r) ? openWhole : undefined}
        onDue={editing ? undefined : () => setDue(p.due)}
        dueInput={
          due !== null ? <NumInput autoFocus className="num" ccy={p.currency} value={due} onValue={setDue} aria-label={t('receivable.grid.due')} /> : undefined
        }
      />
      {edit.editing && edit.splits && <small className="period-pop-foot">{t('receivable.splitEdit')}</small>}
      {due !== null && <small className="period-pop-foot">{t('receivable.dueOverrideFoot')}</small>}
      {realReceipt && (attached.length > 0 || can) && !editing && copying !== realReceipt.id && (
        <div className="period-pop-files">
          {attached.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`period-pop-file${f.dupReceipt ? ' dup' : ''}`}
              title={f.dupReceipt ? `${f.name}\n${t('files.dupHint')}` : f.name}
              onClick={() => setOpenFile(f.id)}
            >
              <Icon name="clip" size={12} />
              <span>{f.name}</span>
            </button>
          ))}
          {can && (
            <button type="button" className="period-pop-file" onClick={pick} disabled={up.pending.length > 0}>
              <Icon name="upload" size={12} />
              <span>{t('files.addReceipt')}</span>
            </button>
          )}
          {picker}
        </div>
      )}
      {openFile && createPortal(<FileSheet id={openFile} list={attached} state={state} today={today} onClose={() => setOpenFile(undefined)} />, document.body)}
      {r && copying === r.id && isReceipt(r) ? (
        <CopyReceiptFields context={context} record={r} />
      ) : (
        <div className="period-pop-actions">
          {r && due === null && (
            <ConfirmButton
              onConfirm={() => {
                onClose();
                void removeRecordPeriodOf(r.id, p);
              }}
            >
              {t('common.delete')}
            </ConfirmButton>
          )}
          <span className="grow" />
          {editing ? (
            <>
              <button className="btn" onClick={() => (due !== null ? setDue(null) : edit.cancel())}>
                {t('common.cancel')}
              </button>
              <button
                className="btn primary"
                disabled={due !== null ? due === p.due || (due != null && !(due >= 0)) : !edit.dirty || !edit.valid}
                onClick={() => {
                  onClose();
                  void (due !== null ? setPeriodDue(p, due) : editRecordPeriodOf(r!.id, p, edit.patch));
                }}
              >
                {t('common.save')}
              </button>
            </>
          ) : r ? (
            <>
              {isReceipt(r) && !r.opening && others.length > 0 && (
                <button className="btn" onClick={() => startCopy(r)}>
                  {t('family.member.copyAria')}
                </button>
              )}
              {edit.editable && (
                <button className="btn primary" onClick={edit.start}>
                  {t('detail.action.edit')}
                </button>
              )}
            </>
          ) : (
            !isSettled(p) && (
              <button
                className="btn primary"
                onClick={() => {
                  onClose();
                  setReceipt({ preset: [p.key] });
                }}
              >
                {t('family.quick.backCollect')}
              </button>
            )
          )}
        </div>
      )}
    </Pop>
  );
}

export function CopyReceiptFields({
  context,
  record: r,
}: { context: ReturnType<typeof useMemberForm> } & { record: import('../../../../shared/types.ts').Receipt }) {
  const { state, s, today, others, setCopying, targets, setTargets, copyable, copyTo } = context;
  return (
    <div className="copy-pay" data-submit=".btn.primary">
      {others.map((o) => {
        const dup = !copyable(o, r);
        const until = paidThrough(memberLedgerAhead(state, s, o, today).periods);
        return (
          <label key={o.id} className={`copy-target ${dup ? 'dup' : ''}`}>
            <input
              type="checkbox"
              disabled={dup}
              checked={!dup && targets.includes(o.id)}
              onChange={(e) => setTargets((e.target as HTMLInputElement).checked ? [...targets, o.id] : targets.filter((x) => x !== o.id))}
            />
            <span>{o.name || t('family.member.unnamed')}</span>
            <small>{dup ? t('family.member.dup') : until ? t('family.member.paidUntilDate', { date: cnDate(until) }) : t('family.member.noPay')}</small>
          </label>
        );
      })}
      <div className="sheet-actions">
        <button className="btn" onClick={() => setCopying(null)}>
          {t('family.member.cancel')}
        </button>
        <button className="btn primary" disabled={!targets.length} onClick={() => copyTo(r)}>
          {t('family.member.copyN', { count: targets.length })}
        </button>
      </div>
    </div>
  );
}

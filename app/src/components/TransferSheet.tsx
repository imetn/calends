import { ConfirmButton } from './ConfirmButton.tsx';
import { useState } from 'react';
import { t } from '../../../shared/i18n.ts';
import type { Transfer } from '../../../shared/types.ts';
import { DatePicker } from './DatePicker.tsx';
import { CurrencySelect } from './Picker.tsx';
import { Sheet } from './overlays.tsx';
import { Cell, Group } from './ui.tsx';
import { MoneyInput, Seg, useSubmit } from './inputs.tsx';

/**
 * 记一笔 / 修改一笔转让收付：二手买入付给原主的钱，或卖出时收到的钱。金额是实际现金，不推算剩余价值。
 * 只把改好的整组记录交给调用方：编辑器写进表单（完成时一起保存），详情页直接保存。
 * 由调用方在成功后关闭：保存失败时表单保留，可以直接重试
 */
export function TransferSheet({
  list,
  index,
  currency,
  today,
  onSave,
  onClose,
}: {
  list: Transfer[];
  /** 修改的那一笔在原数组里的位置；缺省为新增 */
  index?: number;
  currency: string;
  today: string;
  onSave: (next: Transfer[]) => unknown;
  onClose: () => void;
}) {
  const edit = index != null ? list[index] : undefined;
  const [kind, setKind] = useState<Transfer['kind']>(edit?.kind ?? (list.some((x) => x.kind === 'buy') ? 'sell' : 'buy'));
  const [date, setDate] = useState(edit?.date ?? today);
  const [ccy, setCcy] = useState(edit?.currency ?? currency);
  const [amount, setAmount] = useState(edit ? String(edit.amount) : '');
  const [note, setNote] = useState(edit?.note ?? '');
  const n = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(n) && n > 0;

  const [busy, submit] = useSubmit();
  const save = () => {
    if (!valid) return;
    const item: Transfer = { kind, date, amount: n, currency: ccy, ...(note.trim() ? { note: note.trim() } : {}) };
    return submit(() => onSave(index != null ? list.map((x, i) => (i === index ? item : x)) : [...list, item]));
  };

  return (
    <Sheet
      narrow
      title={t(edit ? 'detail.transfer.editTitle' : 'detail.transfer.addTitle')}
      onClose={onClose}
      foot={
        <>
          {edit && (
            <ConfirmButton disabled={busy} onConfirm={() => void submit(() => onSave(list.filter((_, i) => i !== index)))}>
              {t('common.delete')}
            </ConfirmButton>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !valid} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group foot={t(`detail.transfer.hint.${kind}`)}>
          <Cell label={t('detail.transfer.kind.label')}>
            <Seg
              small
              value={kind}
              onChange={setKind}
              options={[
                ['buy', t('detail.transfer.kind.buy')],
                ['sell', t('detail.transfer.kind.sell')],
              ]}
            />
          </Cell>
          <Cell label={t('editor.payment.date')}>
            <DatePicker value={date} onChange={(v) => setDate(v ?? today)} />
          </Cell>
        </Group>
        <Group>
          <Cell label={t(kind === 'buy' ? 'detail.transfer.paid' : 'detail.transfer.received')}>
            <span className="contact-field">
              <MoneyInput ccy={ccy} className="num" value={amount} placeholder="0" onChange={(e) => setAmount((e.target as HTMLInputElement).value)} />
              <CurrencySelect value={ccy} onChange={setCcy} />
            </span>
          </Cell>
        </Group>
        <Group>
          <Cell label={t('editor.field.notes')}>
            <input value={note} placeholder={t('editor.field.optional')} onChange={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Cell>
        </Group>
      </div>
    </Sheet>
  );
}

import { useState } from 'react';
import { LIFETIME_BILL_MONTHS, validBillMonths } from '../../../shared/billing.ts';
import type { CarRule } from '../../../shared/types.ts';
import { Cell } from '../components/ui.tsx';
import { NumInput, Seg } from '../components/inputs.tsx';
import { CurrencySelect } from '../components/Picker.tsx';
import { t, type Params } from '../../../shared/i18n.ts';

/** 按收费周期选文案：常用周期各有一条，买断只收一次（once），其余走 custom（带 count） */
export const perBill = (key: string, months = 1, params: Params = {}): string =>
  t(`${key}.${months >= LIFETIME_BILL_MONTHS ? 'once' : [1, 3, 6, 12].includes(months) ? `m${months}` : 'custom'}`, { count: months, ...params });

const PRESETS = [1, 3, 6, 12];

/**
 * 收费标准：周期（按月 / 按季 / 半年 / 按年 / 自定义几个月）+ 每期金额与币种。
 * 订阅编辑器的「我发起」、转为合租、车的收费规则、成员的自定义收费共用，四处长得一样
 */
export function FeeRuleFields({ value, onChange }: { value: CarRule; onChange: (r: CarRule) => void }) {
  const months = value.billEvery;
  // 在自定义里输到 3、12 这类常用值也不跳回按季、按年（记下自定义时的月数）；外面把周期改成别的（如跟随合租）就收起
  const [customAt, setCustomAt] = useState<number | null>(null);
  const custom = !PRESETS.includes(months) || customAt === months;
  const setMonths = (n: number, keepCustom: boolean) => {
    setCustomAt(keepCustom ? n : null);
    onChange({ ...value, billEvery: n });
  };
  return (
    <>
      <div className="cell">
        <Seg
          value={custom ? 'custom' : String(months)}
          onChange={(v) => {
            // 从常用周期切到自定义先给两个月，再按需改
            if (v !== 'custom') setMonths(Number(v), false);
            else if (!custom) setMonths(2, true);
          }}
          options={[
            ['1', t('family.member.seg.m1')],
            ['3', t('family.member.seg.m3')],
            ['6', t('family.member.seg.m6')],
            ['12', t('family.member.seg.m12')],
            ['custom', t('family.rule.custom')],
          ]}
        />
      </div>
      {custom && (
        <Cell label={t('family.member.billMonths')}>
          <span className="contact-field">
            <NumInput
              className="num"
              inputMode="numeric"
              value={months}
              placeholder="2"
              aria-label={t('family.member.billMonths')}
              onValue={(n) => n != null && validBillMonths(n) && setMonths(n, true)}
            />
            <span className="muted">{t('family.member.monthsUnit')}</span>
          </span>
        </Cell>
      )}
      <Cell label={perBill('family.member.feeLabel', months)}>
        <span className="contact-field">
          <NumInput ccy={value.currency} className="num" value={value.fee} placeholder="0" onValue={(n) => onChange({ ...value, fee: n ?? 0 })} />
          <CurrencySelect value={value.currency} onChange={(c) => onChange({ ...value, currency: c })} ariaLabel={t('family.member.feeCcyAria')} />
        </span>
      </Cell>
    </>
  );
}

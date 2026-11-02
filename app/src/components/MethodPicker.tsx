import { useRef, useState } from 'react';
import type { PaymentMethod } from '../../../shared/types.ts';
import { KIND_LABEL } from '../derive.ts';
import { t } from '../../../shared/i18n.ts';
import { Icon } from './icons.tsx';
import { touchFirst } from './inputs.tsx';
import { MethodMark } from './marks.tsx';
import { fitBelowSheetHead, Pop } from './Pop.tsx';
import { useTextSearch } from '../use-search.ts';

/**
 * 支付方式选择器：系统下拉框放不了图片，这里自己画一个，每项带产品 logo 与国旗角标。
 * 弹层用共用的 Pop，窄屏时贴底显示，与日期选择器一致。
 */
export function MethodPicker({ methods, value, onChange }: { methods: PaymentMethod[]; value?: string; onChange: (id: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState<ReturnType<typeof fitBelowSheetHead>>();
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const cur = methods.find((m) => m.id === value);
  const searchText = (m: PaymentMethod) => `${m.name} ${KIND_LABEL[m.kind]} ${m.currency}`;
  const none = t('picker.method.none');
  const matches = useTextSearch([none, ...methods.map(searchText)], open);
  const shown = methods.filter((m) => matches(q, searchText(m)));
  const showNone = matches(q, none);
  const close = () => {
    setOpen(false);
    setQ('');
  };

  const pick = (id: string | undefined) => {
    onChange(id);
    close();
  };

  return (
    <>
      <button
        type="button"
        ref={btn}
        className={`mp-btn ${cur ? '' : 'empty'}`}
        onClick={() => {
          if (!open) setFit(fitBelowSheetHead(btn.current, 420));
          setOpen(!open);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {cur && <MethodMark m={cur} size={20} />}
        <span>{cur ? cur.name : t('picker.method.none')}</span>
        <Icon name="updown" />
      </button>
      {open && (
        <Pop triggerRef={btn} onClose={close} label={t('picker.method.label')} className="mp-pop" placement={fit?.placement} maxHeight={fit?.maxHeight}>
          <label className="cp-search">
            <Icon name="search" />
            <input autoFocus={!touchFirst()} value={q} placeholder={t('common.search')} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div role="listbox" aria-label={t('picker.method.label')}>
            {showNone && (
              <button type="button" role="option" aria-selected={!cur} className={`mp-opt ${cur ? '' : 'sel'}`} onClick={() => pick(undefined)}>
                <span className="mp-none" />
                <span className="mp-name">{t('picker.method.none')}</span>
                {!cur && <Icon name="check" />}
              </button>
            )}
            {shown.map((m) => (
              <button
                type="button"
                role="option"
                key={m.id}
                aria-selected={m.id === value}
                className={`mp-opt ${m.id === value ? 'sel' : ''}`}
                onClick={() => pick(m.id)}
              >
                <MethodMark m={m} size={28} />
                <span className="mp-name">
                  {m.name}
                  <small>
                    {KIND_LABEL[m.kind]} <span className="copy-gap" aria-hidden="true" /> {m.currency}
                  </small>
                </span>
                {m.id === value && <Icon name="check" />}
              </button>
            ))}
            {!showNone && !shown.length && <div className="cp-empty">{t('picker.noMatch')}</div>}
          </div>
        </Pop>
      )}
    </>
  );
}

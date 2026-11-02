import { useEffect, useId, useRef, useState } from 'react';
import { dateFormat } from '../../../shared/intl.ts';
import { addDays, addMonths, parseDay } from '../../../shared/billing.ts';
import { cnDateFull, monthLabel, weekdayShort } from '../../../shared/format.ts';
import { intlLocale, t } from '../../../shared/i18n.ts';
import { parseDateInput } from '../../../shared/date-input.ts';
import { getState, today as todayOf } from '../store.ts';
import { IconButton } from './ui.tsx';
import { Icon } from './icons.tsx';
import { Pop } from './Pop.tsx';
import { Picker } from './Picker.tsx';

/** 每周起始日跟随设置（1 周一、0 周日）；weekdayShort 的 0 是周日 */
const weekStart = () => getState()?.settings.weekStart ?? 1;
const dows = () => Array.from({ length: 7 }, (_, i) => (i + weekStart()) % 7);
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function grid(month: string): string[] {
  const first = month + '-01';
  const dow = (new Date(parseDay(first)).getUTCDay() - weekStart() + 7) % 7;
  const start = addDays(first, -dow);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** 数字短日期，顺序与分隔符跟随语言：2026/10/25、10/25/2026、25.10.2026 */
const numericDate = (d: string) =>
  dateFormat(intlLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(parseDay(d)));

/** 「2026年」「2026」：年份按当前语言写 */
const yearLabel = (year: number) => dateFormat(intlLocale(), { year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, 0, 1)));

/** 当前语言里年、月谁在前：中日韩「2026年10月」，英文等「Oct 2026」 */
function ymOrder(): Array<'year' | 'month'> {
  const parts = dateFormat(intlLocale(), { year: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2026, 9, 1)));
  const year = parts.findIndex((p) => p.type === 'year');
  const month = parts.findIndex((p) => p.type === 'month');
  return year < month ? ['year', 'month'] : ['month', 'year'];
}

/** 年份下拉覆盖 1970 到今年后 20 年，并纳入已有值/输入值的年份；输入框本身不受窗口限制。 */
function yearWindow(...dates: Array<string | undefined>): number[] {
  const thisYear = Number(todayOf().slice(0, 4));
  const years = dates.filter((d): d is string => !!d && ISO.test(d)).map((d) => Number(d.slice(0, 4)));
  years.push(thisYear);
  const first = Math.min(1970, ...years);
  const last = Math.max(thisYear + 20, ...years);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * 日期选择器：输入框可手填日期，点开是月历；头部用年/月下拉框切换月份。
 * 弹层用共用的 Pop（react-aria），不会被弹窗的滚动容器裁掉；窄屏时贴底显示。
 */
export function DatePicker({
  value,
  onChange,
  placeholder = t('picker.date.placeholder'),
  clearable,
  min,
  max,
  ariaLabel,
  compact,
}: {
  value?: string;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
  clearable?: boolean;
  min?: string;
  max?: string;
  ariaLabel?: string;
  /** 窄位置（如两个日期并排）用数字短格式：中文 2026/10/25，英文 10/25/2026 */
  compact?: boolean;
}) {
  const today = todayOf();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((value ?? today).slice(0, 7));
  const [cursor, setCursor] = useState(value ?? today);
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  // 进入输入模式时沿用日期按钮当时的宽度，切换前后不跳宽
  const [editWidth, setEditWidth] = useState<number>();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const errorId = useId();

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  // 进入输入模式后自动聚焦并全选，直接可改
  useEffect(() => {
    if (!editing) return;
    const el = input.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        input.current?.focus();
      }
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) {
        e.preventDefault();
        const n = addDays(cursor, step);
        setCursor(n);
        setMonth(n.slice(0, 7));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        pick(cursor);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, cursor]);

  const toggle = () => {
    if (!open) {
      setMonth((value ?? today).slice(0, 7));
      setCursor(value ?? today);
      setError(undefined);
    }
    setOpen(!open);
  };
  const startEditing = () => {
    setEditWidth(trigger.current?.offsetWidth || undefined);
    setOpen(false);
    setError(undefined);
    setDraft(value ?? '');
    setEditing(true);
  };
  const disabled = (d: string) => (!!min && d < min) || (!!max && d > max);
  const pick = (d: string) => {
    if (disabled(d)) return;
    onChange(d);
    setDraft(d);
    setError(undefined);
    setOpen(false);
  };
  const submit = () => {
    if (!editing) return;
    if (!draft.trim()) {
      if (!clearable) {
        setError(t('picker.date.invalid'));
        return;
      }
      setError(undefined);
      onChange(undefined);
      setEditing(false);
      return;
    }
    const parsed = parseDateInput(draft);
    if (!parsed) {
      setError(t('picker.date.invalid'));
      return;
    }
    if (disabled(parsed)) {
      setError(t('picker.date.range'));
      return;
    }
    setError(undefined);
    setDraft(parsed);
    onChange(parsed);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value ?? '');
    setError(undefined);
    setEditing(false);
  };
  const years = yearWindow(value, draft);
  const [y, m] = month.split('-').map(Number);

  return (
    <div className="dp">
      {editing ? (
        <span className={`dp-btn editing ${error ? 'invalid' : ''}`} style={editWidth ? { width: editWidth } : undefined}>
          <input
            ref={input}
            value={draft}
            placeholder={placeholder}
            aria-label={ariaLabel ?? t('picker.date.placeholder')}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(undefined);
            }}
            onBlur={(e) => {
              // 点确认按钮时不要提前失焦提交
              const next = e.relatedTarget;
              if (next instanceof Node && e.currentTarget.parentElement?.contains(next)) return;
              submit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
          />
          <IconButton className="dp-commit" aria-label={t('picker.date.confirm')} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={submit}>
            <Icon name="check" />
          </IconButton>
        </span>
      ) : (
        // 外层只是外观；打开月历的是里面的按钮，手动输入是并排的另一个按钮，不再互相嵌套。
        // 点外层空白处（内边距、间隙）仍然打开月历，与之前整块可点一致。
        <span
          ref={trigger}
          className={`dp-btn ${draft ? '' : 'empty'} ${open ? 'open' : ''} ${error ? 'invalid' : ''}`}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            // 包在 <label> 里时阻止 label 再把点击转给内层按钮，否则月历开了又立刻关上
            e.preventDefault();
            toggle();
          }}
        >
          <button type="button" className="dp-open" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
            <Icon name="cal" />
            {/* 显示按当前语言写日期（中文「2026年10月25日」）；手动输入时仍可填 2026-10-25 等格式 */}
            <span className="dp-val">{draft ? (ISO.test(draft) ? (compact ? numericDate(draft) : cnDateFull(draft)) : draft) : placeholder}</span>
          </button>
          <IconButton className="dp-edit" aria-label={t('picker.date.type')} tabIndex={-1} onClick={startEditing}>
            <Icon name="edit" />
          </IconButton>
        </span>
      )}
      {error && (
        <span id={errorId} className="dp-error" role="alert">
          {error}
        </span>
      )}
      {open && (
        <Pop triggerRef={trigger} onClose={() => setOpen(false)} label={t('picker.date.placeholder')}>
          {/* 两端箭头只切月份（跨年自动进位）；年、月下拉居中，顺序跟随语言习惯（中文年在前，英文月在前） */}
          <div className="dp-head">
            <IconButton className="dp-nav" aria-label={t('picker.date.prev')} onClick={() => setMonth(addMonths(month + '-01', -1).slice(0, 7))}>
              <Icon name="left" />
            </IconButton>
            <span className="dp-ym">
              {ymOrder().map((part) =>
                part === 'year' ? (
                  <Picker
                    key="year"
                    value={y}
                    ariaLabel={t('picker.date.year')}
                    onChange={(v) => setMonth(`${v}-${month.slice(5)}`)}
                    options={years.map((year) => ({ value: year, label: yearLabel(year) }))}
                  />
                ) : (
                  <Picker
                    key="month"
                    value={m}
                    ariaLabel={t('picker.date.month')}
                    onChange={(v) => setMonth(`${month.slice(0, 4)}-${String(v).padStart(2, '0')}`)}
                    options={Array.from({ length: 12 }, (_, i) => {
                      const ym = `${month.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`;
                      return { value: i + 1, label: monthLabel(ym, { year: false }) };
                    })}
                  />
                ),
              )}
            </span>
            <IconButton className="dp-nav" aria-label={t('picker.date.next')} onClick={() => setMonth(addMonths(month + '-01', 1).slice(0, 7))}>
              <Icon name="right" />
            </IconButton>
          </div>
          <div className="dp-grid">
            {dows().map((d) => (
              <span key={d} className="dp-dow">
                {weekdayShort(d, true)}
              </span>
            ))}
            {grid(month).map((d) => (
              <button
                type="button"
                key={d}
                className={[
                  'dp-day',
                  d.startsWith(month) ? '' : 'out',
                  d === today ? 'today' : '',
                  d === value ? 'sel' : '',
                  d === cursor ? 'cursor' : '',
                ].join(' ')}
                disabled={disabled(d)}
                onClick={() => pick(d)}
              >
                {Number(d.slice(8))}
              </button>
            ))}
          </div>
          <div className="dp-foot">
            <button type="button" className="btn plain" onClick={() => pick(today)}>
              {t('common.today')}
            </button>
            {clearable && value && (
              <button
                type="button"
                className="btn plain"
                onClick={() => {
                  setDraft('');
                  setError(undefined);
                  onChange(undefined);
                  setOpen(false);
                }}
              >
                {t('common.clear')}
              </button>
            )}
          </div>
        </Pop>
      )}
    </div>
  );
}

import { copyParts } from './copy.tsx';
import { base } from '../base.ts';
import type { ReactNode as ComponentChildren } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CURRENCIES } from '../../../shared/format.ts';
import { locale, t } from '../../../shared/i18n.ts';
import { ccyFlag, ccyName, FLAGS } from '../display.ts';
import { Icon } from './icons.tsx';
import { touchFirst } from './inputs.tsx';
import { Pop } from './Pop.tsx';
import { useTextSearch } from '../use-search.ts';

export interface PickOption<T> {
  value: T;
  label: string;
  /** 右侧的灰字，如货币代码 */
  hint?: string;
  icon?: ComponentChildren;
  /** 分组标题；相邻同组的排在一起 */
  group?: string;
}

/**
 * 全站统一的下拉选择：替代系统 <select>，样式与侧边栏的货币切换一致。
 * 一行一项（图标 · 名称 · 右侧灰字 · 选中打勾），选项多时自带搜索；上下键移动、回车选中、Esc 关闭；窄屏贴底。
 * variant：btn = 工具栏里的胶囊按钮；inline = 表单行右侧的蓝字。
 */
export function Picker<T extends string | number>({
  value,
  options,
  onChange,
  variant = 'inline',
  ariaLabel,
  display,
  search,
  mark,
}: {
  value: T;
  options: Array<PickOption<T>>;
  onChange: (v: T) => void;
  variant?: 'btn' | 'inline';
  ariaLabel?: string;
  /** 按钮上显示的内容，缺省用选中项的名称 */
  display?: ComponentChildren;
  /** 是否显示搜索框，缺省超过 12 项时显示 */
  search?: boolean;
  /** 选中项右侧的标记，缺省为对勾（排序用它显示升降序） */
  mark?: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchable = search ?? options.length > 12;
  const cur = options.find((o) => o.value === value);
  const H = Math.min(400, (searchable ? 48 : 8) + options.length * 36 + new Set(options.map((o) => o.group).filter(Boolean)).size * 26);

  const searchText = (o: PickOption<T>) => `${o.label} ${o.hint ?? ''} ${o.value}`;
  const matches = useTextSearch(options.map(searchText), open && searchable);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? options.filter((o) => matches(k, searchText(o))) : options;
  }, [q, options, matches]);

  useEffect(() => {
    if (!open) return;
    setHi(
      Math.max(
        0,
        shown.findIndex((o) => o.value === value),
      ),
    );
    // 弹层打开后把焦点给搜索框（没有搜索框或触屏时给列表，方便上下键）
    requestAnimationFrame(() => ((touchFirst() ? null : input.current) ?? list.current)?.focus({ preventScroll: true }));
  }, [open]);
  useEffect(() => {
    if (q) setHi(0);
  }, [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const close = () => {
    setOpen(false);
    setQ('');
  };
  const pick = (v: T) => {
    onChange(v);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHi((i) => Math.min(shown.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setHi((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' && shown[hi]) pick(shown[hi].value);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        type="button"
        ref={btn}
        className={`pk-btn ${variant} ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => !open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {display ?? (
          <>
            {cur?.icon && <span className="pk-ico">{cur.icon}</span>}
            <span>{copyParts(cur?.label ?? t('picker.choose'))}</span>
          </>
        )}
        {/* 上下双箭头：一眼看出是下拉选择，不是链接 */}
        <Icon name="updown" />
      </button>
      {open && (
        <Pop triggerRef={btn} onClose={close} label={ariaLabel ?? t('picker.choose')} className="cp-pop pk-pop" style={{ height: H }}>
          <div className="pk-in" onKeyDown={onKey}>
            {searchable && (
              <label className="cp-search">
                <Icon name="search" />
                <input ref={input} value={q} placeholder={t('common.search')} onChange={(e) => setQ(e.target.value)} />
              </label>
            )}
            <div className="cp-list" ref={list} role="listbox" aria-label={ariaLabel} tabIndex={searchable ? undefined : -1}>
              {shown.map((o, i) => (
                <div key={String(o.value)}>
                  {o.group && o.group !== shown[i - 1]?.group && <div className="cp-head">{o.group}</div>}
                  <button
                    type="button"
                    data-i={i}
                    role="option"
                    aria-selected={o.value === value}
                    className={`cp-opt ${o.value === value ? 'sel' : ''} ${i === hi ? 'hi' : ''}`}
                    onMouseMove={() => setHi(i)}
                    onClick={() => pick(o.value)}
                  >
                    {o.icon !== undefined && <span className="pk-ico">{o.icon}</span>}
                    <span className="cp-name">{copyParts(o.label)}</span>
                    {o.hint && <span className="cp-code">{o.hint}</span>}
                    {o.value === value && (mark ?? <Icon name="check" />)}
                  </button>
                </div>
              ))}
              {!shown.length && <div className="cp-empty">{t('picker.noMatch')}</div>}
            </div>
          </div>
        </Pop>
      )}
    </>
  );
}

/** 国旗小图；没有对应国旗时用货币代码 */
function CcyFlag({ code }: { code: string }) {
  const src = ccyFlag(code);
  return <span className="cp-flag">{src ? <img src={src} alt="" loading="lazy" /> : <b>{code.slice(0, 2)}</b>}</span>;
}

/** 货币选择：国旗 + 中文名 + 代码，人民币、美元置顶 */
export function CurrencySelect({ value, onChange, ariaLabel = t('picker.currency') }: { value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  const list = [...new Set(['CNY', 'USD', ...CURRENCIES, value])];
  return (
    <Picker
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      search
      display={
        <>
          <CcyFlag code={value} />
          <span>{value}</span>
        </>
      }
      options={list.map((c) => ({ value: c, label: ccyName(c), hint: c, icon: <CcyFlag code={c} /> }))}
    />
  );
}

/** 地区名跟随当前语言，按语言缓存 */
const regionCache = new Map<string, Intl.DisplayNames | undefined>();
function regionNames(): Intl.DisplayNames | undefined {
  const loc = locale();
  if (!regionCache.has(loc)) {
    try {
      regionCache.set(loc, new Intl.DisplayNames([loc], { type: 'region' }));
    } catch {
      regionCache.set(loc, undefined);
    }
  }
  return regionCache.get(loc);
}
/** 有国旗图片的地区（两位国家码），与 public/flags 一致 */
const REGIONS = [...FLAGS].filter((c) => c !== 'eu');

/** 地区选择：国旗 + 中文名 + 代码，可搜索。常用的放前面，空值表示不区分地区 */
export function RegionSelect({ value, onChange, common = [] }: { value?: string; onChange: (v: string | undefined) => void; common?: string[] }) {
  const name = (cc: string) => {
    try {
      return regionNames()?.of(cc.toUpperCase()) ?? cc.toUpperCase();
    } catch {
      return cc.toUpperCase();
    }
  };
  const top = [...new Set(['us', 'cn', ...common.map((c) => c.toLowerCase())])].filter((c) => REGIONS.includes(c));
  const rest = REGIONS.filter((c) => !top.includes(c)).sort((a, b) => name(a).localeCompare(name(b), locale()));
  const v = value?.toLowerCase() ?? '';
  const opt = (group: string) => (c: string) => ({ value: c, label: name(c), hint: c.toUpperCase(), icon: <CcyFlagImg cc={c} />, group });
  return (
    <Picker
      value={v}
      onChange={(c) => onChange(c ? c.toUpperCase() : undefined)}
      search
      ariaLabel={t('picker.region.label')}
      display={
        v ? (
          <>
            <span className="cp-flag">
              <img src={base(`/flags/${v}.png`)} alt="" />
            </span>
            <span>{name(v)}</span>
          </>
        ) : (
          <span>{t('picker.region.any')}</span>
        )
      }
      options={[{ value: '', label: t('picker.region.none') }, ...top.map(opt(t('picker.common'))), ...rest.map(opt(t('picker.region.all')))]}
    />
  );
}

function CcyFlagImg({ cc }: { cc: string }) {
  return (
    <span className="cp-flag">
      <img src={base(`/flags/${cc}.png`)} alt="" loading="lazy" />
    </span>
  );
}

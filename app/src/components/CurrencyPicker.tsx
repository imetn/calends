import { useEffect, useMemo, useRef, useState } from 'react';
import { symbol } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { ccyFlag, ccyName } from '../display.ts';
import { Icon } from './icons.tsx';
import { Pop } from './Pop.tsx';
import { useTextSearch } from '../use-search.ts';

/**
 * 侧边栏的货币切换：点开在右侧弹出，可搜索。最上面是「原币」，然后是常用币种，再往下是汇率接口支持的全部货币。
 * 上下键移动、回车选中、Esc 关闭；窄屏贴底显示。
 */
/** arc：手机「更多」圆弧里的圆形按钮，只有图标和名称 */
export function CurrencyPicker({
  value,
  used,
  all,
  onChange,
  arc,
}: {
  value: string;
  used: string[];
  all: string[];
  onChange: (v: string) => void;
  arc?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const origText = `${t('picker.ccy.orig')} 原币 original`;
  const searchText = (c: string) => `${c} ${ccyName(c)} ${symbol(c)}`;
  const matches = useTextSearch([origText, ...used.map(searchText), ...all.map(searchText)], open);

  // 搜索：代码、中文名、符号都能搜
  const sections = useMemo(() => {
    const k = q.trim().toLowerCase();
    const hit = (c: string) => matches(k, searchText(c));
    const out: Array<{ title?: string; items: string[] }> = [];
    if (matches(k, origText)) out.push({ items: ['orig'] });
    const u = used.filter(hit);
    if (u.length) out.push({ title: t('picker.common'), items: u });
    const r = all.filter((c) => !used.includes(c) && hit(c));
    if (r.length) out.push({ title: k ? t('common.other') : t('picker.ccy.all'), items: r });
    return out;
  }, [q, used, all, matches, origText]);
  const flat = sections.flatMap((s) => s.items);

  useEffect(() => setHi(Math.max(0, flat.indexOf(value))), [open]);
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
  const pick = (v: string) => {
    onChange(v);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHi((i) => Math.min(flat.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setHi((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' && flat[hi]) pick(flat[hi]);
    else return;
    e.preventDefault();
  };

  const [turn, setTurn] = useState(0);
  const orig = value === 'orig';
  let n = 0;
  return (
    <>
      <button
        type="button"
        ref={btn}
        className={arc ? 'arc-item' : `side-item theme-item ${open ? 'open' : ''}`}
        onClick={() => {
          setOpen(!open);
          setTurn(turn + 1);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('picker.ccy.switch')}
        aria-label={arc ? `${t('picker.ccy.label')} ${orig ? t('picker.ccy.orig') : ccyName(value)}` : undefined}
      >
        {/* 每点一下两枚硬币交换位置（转半圈，带回弹） */}
        <span className="ico-turn swap" style={{ transform: `rotate(${turn * 180}deg)` }}>
          <Icon name="coins" />
        </span>
        <span className={arc ? 'arc-label' : undefined}>{arc ? t('app.navShort.currency') : t('picker.ccy.label')}</span>
        {!arc && <small>{orig ? t('picker.ccy.orig') : ccyName(value)}</small>}
      </button>
      {open && (
        <Pop triggerRef={btn} onClose={close} label={t('picker.ccy.label')} className="cp-pop" placement="right bottom">
          <div className="pk-in" onKeyDown={onKey}>
            <label className="cp-search">
              <Icon name="search" />
              <input autoFocus value={q} placeholder={t('picker.ccy.search')} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="cp-list" ref={list} role="listbox" aria-label={t('picker.ccy.label')}>
              {sections.map((s) => (
                <div key={s.title ?? 'orig'}>
                  {s.title && <div className="cp-head">{s.title}</div>}
                  {s.items.map((c) => {
                    const i = n++;
                    const sel = c === value;
                    return (
                      <button
                        type="button"
                        key={c}
                        data-i={i}
                        role="option"
                        aria-selected={sel}
                        className={`cp-opt ${sel ? 'sel' : ''} ${i === hi ? 'hi' : ''}`}
                        onMouseMove={() => setHi(i)}
                        onClick={() => pick(c)}
                      >
                        <span className="cp-flag">
                          {c === 'orig' ? <Icon name="swap" /> : ccyFlag(c) ? <img src={ccyFlag(c)} alt="" loading="lazy" /> : <b>{symbol(c).trim() || c}</b>}
                        </span>
                        <span className="cp-name">{c === 'orig' ? t('picker.ccy.orig') : ccyName(c)}</span>
                        <span className="cp-code">{c === 'orig' ? t('picker.ccy.origHint') : c}</span>
                        {sel && <Icon name="check" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              {!flat.length && <div className="cp-empty">{t('picker.ccy.noMatch')}</div>}
            </div>
          </div>
        </Pop>
      )}
    </>
  );
}

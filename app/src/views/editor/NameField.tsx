import { copyParts } from '../../components/copy.tsx';
import { base } from '../../base.ts';
import { useRef, useState } from 'react';
import { t } from '../../../../shared/i18n.ts';
import { SubIcon } from '../../components/marks.tsx';
import { api } from '../../store.ts';
import { searchCatalog, type CatalogItem } from '../../catalog.ts';
import { LogoSearch } from '../../components/LogoSearch.tsx';

export interface AppHit {
  /** App Store 数字 ID，用来读内购套餐 */
  id?: string;
  name: string;
  icon: string;
  url: string;
  seller: string;
  genre: string;
  /** 搜索用的商店地区，如 tr */
  country?: string;
  /** 地区是从粘贴的链接里读出来的 */
  fromLink?: boolean;
}

/** App Store 类别 → 账本分类（内置分类代码） */
export const GENRE_CAT: Record<string, string> = {
  Music: 'music',
  Entertainment: 'media',
  'Photo & Video': 'media',
  Productivity: 'productivity',
  Utilities: 'tools',
  'Developer Tools': 'developer',
  'Graphics & Design': 'design',
  Business: 'productivity',
  'Social Networking': 'social',
  Games: 'games',
  Education: 'education',
  Shopping: 'shopping',
  Lifestyle: 'daily',
  Finance: 'finance',
  'Health & Fitness': 'health',
  Medical: 'health',
  Books: 'news',
  'Magazines & Newspapers': 'news',
  News: 'news',
  Reference: 'education',
};

/**
 * 名称输入：边输入边联想 App Store 里的 App（按订阅地区的商店搜），选中带出名称、图标和链接。
 * 也可以直接粘贴 App Store 链接，地区从链接里读（apps.apple.com/tr/app/…），不用另外选。
 */
export function NameField({
  value,
  region,
  onChange: onInput,
  onPick,
  onPickCatalog,
  onPickLogo,
}: {
  value: string;
  region: string;
  onChange: (v: string) => void;
  onPick: (h: AppHit) => void;
  onPickCatalog: (c: CatalogItem) => void;
  onPickLogo: (icon: string) => void;
}) {
  const [hits, setHits] = useState<AppHit[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const composing = useRef(false);
  const keyboardHighlight = useRef(false);
  const timer = useRef(0);
  const seq = useRef(0);
  // 常用服务（本地目录）马上出；App Store 的结果随后补在下面
  const local = /apps\.apple\.com\//i.test(value) ? [] : searchCatalog(value);
  const all: Array<{ c?: CatalogItem; h?: AppHit }> = [...local.map((c) => ({ c })), ...hits.map((h) => ({ h }))];
  const search = (q: string) => {
    window.clearTimeout(timer.current);
    const term = q.trim();
    setHi(-1);
    keyboardHighlight.current = false;
    setOpen(true);
    if (term.length < 2) return setHits([]);
    const fromLink = term.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1]?.toLowerCase();
    const country = fromLink ?? region;
    timer.current = window.setTimeout(async () => {
      const n = ++seq.current;
      try {
        const r = await api<{ results: AppHit[] }>(`/api/appstore/search?q=${encodeURIComponent(term)}&country=${country}`);
        if (n === seq.current) setHits(r.results.slice(0, 5).map((h) => ({ ...h, country, fromLink: !!fromLink })));
      } catch {
        /* 联想失败不影响手动输入 */
      }
    }, 350);
  };
  const pick = (x: { c?: CatalogItem; h?: AppHit }) => {
    if (x.c) onPickCatalog(x.c);
    else onPick(x.h!);
    setOpen(false);
    setHi(-1);
    keyboardHighlight.current = false;
    setHits([]);
  };
  return (
    <div className="ed-name">
      <input
        value={value}
        autoFocus={!value}
        placeholder={t('editor.name.placeholder')}
        onChange={(e) => {
          const v = (e.target as HTMLInputElement).value;
          onInput(v);
          search(v);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onFocus={() => {
          setHi(-1);
          keyboardHighlight.current = false;
          if (all.length) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || !open || !all.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            keyboardHighlight.current = true;
            setHi((i) => (e.key === 'ArrowDown' ? Math.min(all.length - 1, i + 1) : i < 0 ? all.length - 1 : Math.max(0, i - 1)));
          } else if (e.key === 'Enter') {
            if (!keyboardHighlight.current || !all[hi]) return;
            pick(all[hi]);
          } else if (e.key === 'Escape') setOpen(false);
          else return;
          // 只关联想框，不让 Esc 冒泡去关整个编辑器
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <LogoSearch value={value} onPick={onPickLogo} />
      {open && all.length > 0 && (
        <div className="ed-suggest" role="listbox">
          {all.map((x, i) => (
            <div key={x.c ? `c-${x.c.name}` : `h-${x.h!.url}`}>
              {i === 0 && x.c && <div className="ed-suggest-h">{copyParts(t('editor.name.catalog'))}</div>}
              {x.h && (i === 0 || all[i - 1].c) && (
                <div className="ed-suggest-h">
                  App Store <span className="copy-gap" aria-hidden="true" /> <img className="pk-flag" src={base(`/flags/${x.h.country}.png`)} alt="" />
                </div>
              )}
              <button
                type="button"
                className={`hit ${i === hi ? 'hi' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => {
                  keyboardHighlight.current = false;
                  setHi(i);
                }}
                onClick={() => pick(x)}
              >
                {x.c ? (
                  <span className="ed-cat-ico">
                    <img src={base(x.c.icon)} alt="" />
                  </span>
                ) : (
                  <SubIcon sub={{ name: x.h!.name, icon: x.h!.icon, category: '' }} size={32} />
                )}
                <span style={{ minWidth: 0 }}>
                  <b>{x.c ? x.c.name : x.h!.name}</b>
                  <small>{copyParts(x.c ? `${x.c.category}\n${x.c.url.replace(/^https?:\/\//, '')}` : `${x.h!.seller}\n${x.h!.genre}`)}</small>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

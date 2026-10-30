import { useEffect, useRef, useState } from 'react';
import { t } from '../../../shared/i18n.ts';
import { api } from '../store.ts';
import { base } from '../base.ts';
import { Icon } from './icons.tsx';
import { IconButton } from './ui.tsx';

interface LogoHit {
  url: string;
  thumb: string;
  source: 'site' | 'selfhst' | 'dashboard' | 'web';
  name: string;
  width?: number;
  height?: number;
}

// 用函数而不是模块级常量：语言包是异步加载的，常量会在 t() 可用之前就求值
const sources = (): Array<{ id: LogoHit['source']; label: string }> => [
  // 官网排第一：从订阅自己的站点抓的图，最可能是用户要的那张
  { id: 'site', label: t('editor.logoSearch.sourceSite') },
  { id: 'selfhst', label: 'selfh.st' },
  { id: 'dashboard', label: 'Dashboard Icons' },
  { id: 'web', label: t('editor.logoSearch.sourceWeb') },
];

/**
 * 网上搜 Logo：从两套开源图标库和搜索引擎找图，选中后只写订阅的 icon 字段。
 * 与「内置目录」「App Store 搜索」分开：那两个在输入名称时联想，这个是点按钮展开的面板。
 * 面板内联在编辑器里展开，不再套一层弹框；三个来源一次全部列出，按来源分组。
 */
export function LogoSearch({ value, onPick }: { value: string; onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value);
  const [hits, setHits] = useState<LogoHit[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // 展开时用当前名称做初始查询
  useEffect(() => {
    if (open && q.trim().length >= 2) run(q);
  }, [open]);

  const run = async (term: string) => {
    const n = ++seq.current;
    setBusy(true);
    try {
      const r = await api<{ results: LogoHit[] }>(`/api/logos/search?q=${encodeURIComponent(term.trim())}`);
      if (n === seq.current) setHits(r.results);
    } catch {
      if (n === seq.current) setHits([]);
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };

  const groups = sources()
    .map((s) => ({ ...s, items: hits.filter((h) => h.source === s.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <IconButton
        className="ed-logo-btn"
        aria-label={t('editor.logoSearch.search')}
        title={t('editor.logoSearch.search')}
        onClick={() => {
          setQ(value.trim());
          setOpen(!open);
        }}
      >
        <Icon name="search" size={16} />
      </IconButton>
      {open && (
        <div className="logo-panel" data-submit="">
          {/* data-submit="" 告诉弹窗的捕获阶段回车监听：这里的回车自己处理，别去点主按钮（添加） */}
          <div className="logo-head">
            {/* 用 div 而不是 form：编辑器整个是一个表单，HTML 不允许 form 嵌套，
                内层 form 会被浏览器忽略，回车就变成提交外层表单（保存）而不是搜索 */}
            <div className="logo-q">
              <Icon name="search" size={15} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  // 拦住冒泡，避免触发编辑器的提交
                  e.preventDefault();
                  e.stopPropagation();
                  if (q.trim().length >= 2) run(q);
                }}
                placeholder={t('editor.logoSearch.placeholder')}
                aria-label={t('editor.logoSearch.placeholder')}
                autoFocus
              />
            </div>
            <IconButton className="logo-close" aria-label={t('ui.close')} title={t('ui.close')} onClick={() => setOpen(false)}>
              <Icon name="x" size={15} />
            </IconButton>
          </div>
          <div className="logo-body">
            {busy && <div className="logo-state">{t('editor.logoSearch.searching')}</div>}
            {!busy && groups.length === 0 && <div className="logo-state">{t('editor.logoSearch.empty')}</div>}
            {!busy &&
              groups.map((g) => (
                <div key={g.id} className="logo-group">
                  <div className="logo-group-h">
                    {g.label}
                    <small>{g.items.length}</small>
                  </div>
                  <div className="logo-grid">
                    {g.items.map((h) => (
                      <IconButton
                        key={h.url}
                        className="logo-cell"
                        aria-label={h.name}
                        title={h.name}
                        onClick={() => {
                          // 存原始地址：公开页没有登录态，读不了 /api/img；分享图和取色会在渲染时自己走代理
                          onPick(h.url);
                          setOpen(false);
                        }}
                      >
                        <img src={base(`/api/img?u=${encodeURIComponent(h.thumb)}`)} alt="" loading="lazy" />
                      </IconButton>
                    ))}
                  </div>
                </div>
              ))}
          </div>
          <div className="logo-foot">{t('editor.logoSearch.hint')}</div>
        </div>
      )}
    </>
  );
}

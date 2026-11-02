import { ArrowLeft, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../shared/i18n.ts';
import { maskForPublic } from '../../../shared/mask.ts';
import {
  metricsFor,
  metricWithTemplate,
  newMetricItem,
  PUBLIC_BIO_MAX,
  PUBLIC_BOTTOM_SECTIONS,
  PUBLIC_METRIC_CARDS_MAX,
  PUBLIC_METRIC_ROWS_MAX,
  PUBLIC_METRIC_TEMPLATES,
  PUBLIC_PREVIEW_DATA,
  PUBLIC_PREVIEW_DRAFT,
  PUBLIC_PREVIEW_DROP,
  PUBLIC_PREVIEW_LAYOUT,
  PUBLIC_PREVIEW_READY,
  PUBLIC_TITLE_MAX,
  publicBottomShown,
  publicConfigForVisitors,
  publicGrid,
  gridConfig,
  gridSections,
  hideItem,
  setMetric,
  showItem,
  validPublicPage,
  type PublicBottomId,
  type PublicGridItem,
  type PublicMetricCard,
  type PublicMetricTemplate,
} from '../../../shared/public-layout.ts';
import type { AppState, PublicPageConfig, PublicSectionConfig, Settings } from '../../../shared/types.ts';
import { base } from '../base.ts';
import { ask } from '../components/overlays.tsx';
import { Seg, useMedia } from '../components/inputs.tsx';
import { Cell, Group, IconButton, Toolbar } from '../components/ui.tsx';
import { href, setLeaveGuard } from '../router.ts';
import { saveSettings } from '../store.ts';
import { run } from '../toast.ts';
import { AvatarField } from './Settings.tsx';
import { WidgetThumb } from './PublicWidgetThumb.tsx';
import './public-page-editor.css';

interface Draft {
  publicTitle: string;
  browserTitle: string;
  bio: string;
  avatar?: string;
  grid: PublicGridItem[];
  bottom: Record<PublicBottomId, boolean>;
}

const draftOf = (publicTitle: string | undefined, cfg: PublicPageConfig | undefined): Draft => ({
  publicTitle: publicTitle ?? '',
  browserTitle: cfg?.browserTitle ?? '',
  bio: cfg?.bio ?? '',
  avatar: cfg?.avatar,
  grid: publicGrid(cfg),
  bottom: { footer: publicBottomShown(cfg, 'footer'), pile: publicBottomShown(cfg, 'pile') },
});

/** 草稿转成要存的配置：和默认一样的部分不存，全部默认时返回 undefined（设置里不留这个字段） */
function configOf(d: Draft): PublicPageConfig | undefined {
  const hiddenBottom = PUBLIC_BOTTOM_SECTIONS.filter((id) => !d.bottom[id]).map((id) => ({ id: id as string, hidden: true }));
  const sections = [...gridConfig(d.grid), ...hiddenBottom];
  const cfg: PublicPageConfig = {
    ...(d.browserTitle.trim() ? { browserTitle: d.browserTitle.trim() } : {}),
    ...(d.bio.trim() ? { bio: d.bio.trim() } : {}),
    ...(d.avatar ? { avatar: d.avatar } : {}),
    ...(sections.length ? { sections } : {}),
  };
  return Object.keys(cfg).length ? cfg : undefined;
}

const isBottom = (id: string): id is PublicBottomId => (PUBLIC_BOTTOM_SECTIONS as readonly string[]).includes(id);
const isTemplate = (id: string): id is PublicMetricTemplate => (PUBLIC_METRIC_TEMPLATES as readonly string[]).includes(id);
const hideSection = (d: Draft, id: string): Draft => (isBottom(id) ? { ...d, bottom: { ...d.bottom, [id]: false } } : { ...d, grid: hideItem(d.grid, id) });

/** 点一下添加：放到页面最下面。指标卡每次新建一张 */
function addWidget(d: Draft, id: string): Draft {
  if (isBottom(id)) return { ...d, bottom: { ...d.bottom, [id]: true } };
  if (isTemplate(id)) return { ...d, grid: publicGrid({ sections: gridSections([...d.grid, newMetricItem(d.grid, id)]) }) };
  return { ...d, grid: showItem(d.grid, id) };
}

/** 组件库的分组：同一类放一起，主人按想展示什么来找 */
const LIBRARY: { title: string; ids: string[] }[] = [
  { title: 'metrics', ids: ['stats', ...PUBLIC_METRIC_TEMPLATES] },
  { title: 'charts', ids: ['chart', 'composition', 'treemap', 'waterfall', 'fx'] },
  { title: 'lists', ids: ['timeline', 'calendar', 'years', 'list', 'tenure', 'changes', 'ended', 'lifetime'] },
  { title: 'bottom', ids: ['footer', 'pile'] },
];

const widgetName = (id: string) => t(`settings.publicPage.widget.${id}.name`);
const widgetDesc = (id: string) => t(`settings.publicPage.widget.${id}.desc`);
const metricName = (id: string) => t(`public.metric.${id}`);
const canvasIds = LIBRARY.flatMap((g) => g.ids);

/** 指针移动超过这么多才算拖动，否则算点击 */
const DRAG_START = 4;

/** 预览：iframe 按真实页面宽度渲染再等比缩小，不因预览区窄而变成平板布局 */
function Preview({ device, frame }: { device: 'desktop' | 'phone'; frame: React.RefObject<HTMLIFrameElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const width = device === 'desktop' ? 1040 : 390;
  const scale = size.w ? Math.min(1, size.w / width) : 1;
  return (
    <div ref={box} className="ppe-frame">
      <iframe
        ref={frame}
        title={t('settings.publicPage.previewTab')}
        // 嵌的是本站自己的页面，消息校验要靠同源；sandbox 仍能挡住顶层跳转和弹窗
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin"
        src={`${base('/public')}?preview`}
        style={{ width, height: size.h ? size.h / scale : '100%', transform: `translateX(${Math.max(0, (size.w - width * scale) / 2)}px) scale(${scale})` }}
      />
    </div>
  );
}

/** 组件库的一项：缩略图说明它长什么样。能拖就拖到画布，点一下放到页面最下面 */
function LibraryItem({ id, placed, disabled, draggable, onAdd, onRemove, onDrag }: {
  id: string;
  placed: boolean;
  disabled: boolean;
  draggable: boolean;
  onAdd: () => void;
  onRemove: () => void;
  /** 返回 true：画布上已经显示真实卡片，不用再画缩略图跟着指针 */
  onDrag: (phase: 'move' | 'end' | 'cancel', x: number, y: number) => boolean;
}) {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const canDrag = draggable && !placed && !disabled;
  return (
    <div className="ppe-item" data-placed={placed ? '' : undefined}>
      <button
        type="button"
        className="ppe-item-main"
        data-drag={canDrag ? '' : undefined}
        disabled={placed || disabled}
        onPointerDown={(e) => {
          if (!canDrag || e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          if (!s.moved && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < DRAG_START) return;
          s.moved = true;
          setGhost(onDrag('move', e.clientX, e.clientY) ? null : { x: e.clientX, y: e.clientY });
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          setGhost(null);
          if (s?.moved) onDrag('end', e.clientX, e.clientY);
          else if (s) onAdd();
        }}
        onPointerCancel={(e) => {
          start.current = null;
          setGhost(null);
          onDrag('cancel', e.clientX, e.clientY);
        }}
        // 键盘和不能拖的场合（窄屏、触屏）走点击；能拖时指针已在 pointerup 处理过
        onClick={(e) => {
          if (!canDrag || e.detail === 0) onAdd();
        }}
      >
        <WidgetThumb id={id} />
        <span className="ppe-item-text">
          <span className="ppe-item-name">{widgetName(id)}</span>
          <span className="ppe-item-desc">{widgetDesc(id)}</span>
        </span>
        {!placed && <Plus size={14} className="ppe-item-add" />}
      </button>
      {placed && (
        <IconButton aria-label={t('settings.publicPage.remove')} title={t('settings.publicPage.remove')} onClick={onRemove}>
          <X size={14} />
        </IconButton>
      )}
      {ghost && (
        <div className="ppe-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <WidgetThumb id={id} />
        </div>
      )}
    </div>
  );
}

/** 选中一张指标卡时侧栏显示它的设置：换模板、换数据 */
function MetricInspector({ card, onChange, onClose, onRemove }: { card: PublicMetricCard; onChange: (card: PublicMetricCard) => void; onClose: () => void; onRemove: () => void }) {
  const options = metricsFor(card.template);
  const setAt = (i: number, value: string) => onChange({ ...card, items: card.items.map((x, j) => (j === i ? value : x)) });
  const unused = options.find((m) => !card.items.includes(m.id));
  return (
    <div className="ppe-panel stack">
      <div className="ppe-panel-head">
        <IconButton aria-label={t('settings.publicPage.backToLibrary')} title={t('settings.publicPage.backToLibrary')} onClick={onClose}>
          <ArrowLeft size={16} />
        </IconButton>
        <span className="ppe-panel-title">{t('settings.publicPage.metricCard')}</span>
        <button type="button" className="btn" onClick={onRemove}>
          {t('settings.publicPage.remove')}
        </button>
      </div>
      <Group title={t('settings.publicPage.template')}>
        <div className="ppe-templates">
          {PUBLIC_METRIC_TEMPLATES.map((tpl) => (
            <button key={tpl} type="button" className="ppe-template" data-on={tpl === card.template ? '' : undefined} aria-pressed={tpl === card.template} onClick={() => onChange(metricWithTemplate(card, tpl))}>
              <WidgetThumb id={tpl} />
              <span>{widgetName(tpl)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t('settings.publicPage.metricData')}>
        {card.items.map((id, i) => (
          <div key={id} className="cell ppe-metric-row">
            <select aria-label={t('settings.publicPage.metricData')} value={id} onChange={(e) => setAt(i, (e.target as HTMLSelectElement).value)}>
              {options
                .filter((m) => m.id === id || !card.items.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {metricName(m.id)}
                  </option>
                ))}
            </select>
            {card.items.length > 1 && (
              <IconButton aria-label={t('settings.publicPage.remove')} title={t('settings.publicPage.remove')} onClick={() => onChange({ ...card, items: card.items.filter((_, j) => j !== i) })}>
                <X size={14} />
              </IconButton>
            )}
          </div>
        ))}
        {card.template === 'rows' && card.items.length < PUBLIC_METRIC_ROWS_MAX && unused && (
          <Cell label={t('settings.publicPage.addMetric')} onClick={() => onChange({ ...card, items: [...card.items, unused.id] })}>
            <Plus size={14} />
          </Cell>
        )}
      </Group>
    </div>
  );
}

export function PublicPageEditor({ state }: { state: AppState }) {
  const s: Settings = state.settings;
  const saved = useMemo(() => draftOf(s.publicTitle, s.publicPage), [s.publicTitle, s.publicPage]);
  const [draft, setDraft] = useState(saved);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [panel, setPanel] = useState<'widgets' | 'page'>('widgets');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [selected, setSelected] = useState<string | null>(null);
  const narrow = useMedia('(max-width: 860px)');
  // 触屏上手指要用来滚动页面，画布只看不改
  const touch = useMedia('(pointer: coarse)');
  const up = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const canvasOn = !narrow && !touch && device === 'desktop';

  const config = configOf(draft);
  const dirty = draft.publicTitle.trim() !== (s.publicTitle ?? '') || JSON.stringify(config) !== JSON.stringify(configOf(saved));
  const isDefault = !config && !draft.publicTitle.trim();

  // 预览数据：真实账本走同一个脱敏，所有组件都下发（草稿可能拖进任何组件）；账本没变就不重发
  const masked = useMemo(() => maskForPublic(state, { untrimmed: true }), [state]);
  // config 每次渲染都是新对象，按内容判断有没有变
  const configKey = JSON.stringify(config);
  const previewDraft = useMemo(
    () => ({
      publicTitle: draft.publicTitle.trim() || undefined,
      displayName: draft.publicTitle.trim() ? '' : s.displayName,
      avatar: config?.avatar ?? s.avatar,
      config: publicConfigForVisitors(config),
      // 手机宽度、窄屏和触屏上只看效果
      canvas: canvasOn ? { labels: Object.fromEntries(canvasIds.map((id) => [id, widgetName(id)])), remove: t('settings.publicPage.remove'), empty: t('settings.publicPage.emptyCard'), selected: selected ?? undefined } : undefined,
    }),
    [configKey, draft.publicTitle, s.displayName, s.avatar, canvasOn, selected],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, location.origin);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === PUBLIC_PREVIEW_LAYOUT) {
        const { sections, remove, select } = e.data as { sections?: PublicSectionConfig[]; remove?: string; select?: string };
        if (sections && validPublicPage({ sections })) {
          setDraft((d) => {
            // 刚拖进来的指标卡直接选中，接着选数据
            const added = publicGrid({ sections }).find((x) => x.metric && !d.grid.some((o) => o.id === x.id));
            if (added) setSelected(added.id);
            return { ...d, grid: publicGrid({ sections }) };
          });
        }
        if (remove) {
          setDraft((d) => hideSection(d, remove));
          setSelected((cur) => (cur === remove ? null : cur));
        }
        if (select) setSelected(select);
        return;
      }
      if (e.data?.type !== PUBLIC_PREVIEW_READY) return;
      ready.current = true;
      post({ type: PUBLIC_PREVIEW_DATA, state: masked });
      post({ type: PUBLIC_PREVIEW_DRAFT, draft: previewDraft });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [masked, previewDraft]);
  useEffect(() => {
    if (ready.current) post({ type: PUBLIC_PREVIEW_DATA, state: masked });
  }, [masked]);
  useEffect(() => {
    if (ready.current) post({ type: PUBLIC_PREVIEW_DRAFT, draft: previewDraft });
  }, [previewDraft]);

  // 有未保存的改动时，离开前问一声：关页面走浏览器提示，站内跳转（链接、快捷键、命令面板）走确认弹窗
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    const release = setLeaveGuard(() => ask(t('settings.publicPage.leave'), { ok: t('settings.publicPage.leaveOk') }));
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      release();
    };
  }, [dirty]);

  const save = () => run(() => saveSettings({ publicTitle: (draft.publicTitle.trim() || null) as string | undefined, publicPage: (config ?? null) as PublicPageConfig | undefined }), t('settings.toast.saved'));

  /** 组件库拖动：指针被捕获在编辑页，换算成 iframe 里的坐标发过去；不在画布上就取消 */
  const dragWidget = (id: string, phase: 'move' | 'end' | 'cancel', x: number, y: number) => {
    const el = frame.current;
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const over = phase !== 'cancel' && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (isBottom(id)) {
      if (phase === 'end' && over) setDraft((d) => addWidget(d, id));
      return false;
    }
    const scale = box.width / el.offsetWidth;
    if (!over) post({ type: PUBLIC_PREVIEW_DROP, phase: 'cancel', widget: id, x: 0, y: 0 });
    else post({ type: PUBLIC_PREVIEW_DROP, phase, widget: id, x: (x - box.left) / scale, y: (y - box.top) / scale });
    return over;
  };

  const placedOf = (id: string) => (isTemplate(id) ? false : isBottom(id) ? draft.bottom[id] : !draft.grid.find((x) => x.id === id)?.hidden);
  const metricCards = draft.grid.filter((x) => x.metric);
  const full = metricCards.length >= PUBLIC_METRIC_CARDS_MAX;
  const current = draft.grid.find((x) => x.id === selected && x.metric);
  const placeholderTitle = s.displayName.trim() ? t('public.title', { name: s.displayName.trim() }) : t('public.titleAnon');
  const showEdit = !narrow || tab === 'edit';
  const showPreview = !narrow || tab === 'preview';
  const deviceSeg = (
    <Seg
      small
      value={device}
      onChange={setDevice}
      options={[
        ['desktop', t('settings.publicPage.desktop')],
        ['phone', t('settings.publicPage.phone')],
      ]}
    />
  );

  return (
    <>
      <Toolbar
        title={
          <span className="ppe-title">
            <a className="icon-btn" href={href('settings')} aria-label={t('settings.publicPage.back')} title={t('settings.publicPage.back')}>
              <ArrowLeft size={16} />
            </a>
            {t('settings.publicPage.title')}
          </span>
        }
      >
        {!narrow && deviceSeg}
        <button type="button" className="btn" disabled={isDefault} onClick={() => { setDraft(draftOf(undefined, undefined)); setSelected(null); }}>
          {t('settings.publicPage.reset')}
        </button>
        <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save()}>
          {t('common.save')}
        </button>
      </Toolbar>
      <div className="page ppe fade-in">
        {narrow && (
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              ['edit', t('settings.publicPage.editTab')],
              ['preview', t('settings.publicPage.previewTab')],
            ]}
          />
        )}
        <div className="ppe-preview" hidden={!showPreview}>
          {narrow && deviceSeg}
          <Preview device={device} frame={frame} />
        </div>
        <div className="ppe-side" hidden={!showEdit}>
          {current?.metric ? (
            <MetricInspector
              card={current.metric}
              onChange={(metric) => setDraft((d) => ({ ...d, grid: setMetric(d.grid, current.id, metric) }))}
              onClose={() => setSelected(null)}
              onRemove={() => {
                setDraft((d) => hideSection(d, current.id));
                setSelected(null);
              }}
            />
          ) : (
            <div className="ppe-panel stack">
              <Seg
                value={panel}
                onChange={setPanel}
                options={[
                  ['widgets', t('settings.publicPage.sections')],
                  ['page', t('settings.publicPage.head')],
                ]}
              />
              {panel === 'widgets' ? (
                <>
                  <p className="ppe-hint">{t(canvasOn ? 'settings.publicPage.hintDrag' : 'settings.publicPage.hintTap')}</p>
                  {LIBRARY.map((group) => (
                    <section key={group.title} className="ppe-group">
                      <h3 className="ppe-group-title">{t(`settings.publicPage.library.${group.title}`)}</h3>
                      {group.ids.map((id) => (
                        <LibraryItem
                          key={id}
                          id={id}
                          placed={placedOf(id)}
                          disabled={isTemplate(id) && full}
                          draggable={canvasOn}
                          onAdd={() => setDraft((d) => addWidget(d, id))}
                          onRemove={() => setDraft((d) => hideSection(d, id))}
                          onDrag={(phase, x, y) => dragWidget(id, phase, x, y)}
                        />
                      ))}
                      {/* 窄屏和触屏没有画布可点，已放的指标卡在这里改和移除 */}
                      {!canvasOn &&
                        group.title === 'metrics' &&
                        metricCards.map((x) => (
                          <Cell key={x.id} label={metricName(x.metric!.items[0])} sub={widgetName(x.metric!.template)} onClick={() => setSelected(x.id)} />
                        ))}
                    </section>
                  ))}
                </>
              ) : (
                <>
                  <Group title={t('settings.publicPage.head')}>
                    <Cell label={t('settings.publicPage.browserTitle')}>
                      <input
                        value={draft.browserTitle}
                        maxLength={PUBLIC_TITLE_MAX}
                        placeholder={draft.publicTitle.trim() || placeholderTitle}
                        onChange={(e) => up({ browserTitle: (e.target as HTMLInputElement).value })}
                      />
                    </Cell>
                    <Cell label={t('settings.open.publicTitle')}>
                      <input
                        value={draft.publicTitle}
                        maxLength={PUBLIC_TITLE_MAX}
                        placeholder={placeholderTitle}
                        onChange={(e) => up({ publicTitle: (e.target as HTMLInputElement).value })}
                      />
                    </Cell>
                    <AvatarField
                      avatar={draft.avatar}
                      fallback={s.avatar}
                      defaultLabel={t('settings.publicPage.avatarFollow')}
                      linkHint={t('settings.publicPage.avatarLinkHint')}
                      onChange={(v) => up({ avatar: v ?? undefined })}
                    />
                  </Group>
                  <Group title={t('settings.publicPage.bio')}>
                    <div className="cell">
                      <span className="cell-r">
                        <textarea
                          value={draft.bio}
                          maxLength={PUBLIC_BIO_MAX}
                          placeholder={t('settings.publicPage.bioPlaceholder')}
                          aria-label={t('settings.publicPage.bio')}
                          onChange={(e) => up({ bio: (e.target as HTMLTextAreaElement).value })}
                        />
                      </span>
                    </div>
                  </Group>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../shared/i18n.ts';
import { maskForPublic } from '../../../shared/mask.ts';
import {
  PUBLIC_BIO_MAX,
  PUBLIC_BOTTOM_SECTIONS,
  PUBLIC_COLUMNS,
  PUBLIC_HERO_PARTS,
  PUBLIC_PREVIEW_DATA,
  PUBLIC_PREVIEW_DRAFT,
  PUBLIC_PREVIEW_READY,
  PUBLIC_TITLE_MAX,
  publicBottomShown,
  publicConfigForVisitors,
  publicGrid,
  publicHeroShown,
  type PublicBottomId,
  type PublicGridItem,
  type PublicHeroPart,
} from '../../../shared/public-layout.ts';
import type { AppState, PublicPageConfig, Settings } from '../../../shared/types.ts';
import { base } from '../base.ts';
import { ask } from '../components/overlays.tsx';
import { Icon } from '../components/icons.tsx';
import { Seg, Stepper, Toggle, useMedia } from '../components/inputs.tsx';
import { Cell, Group, IconButton, Toolbar } from '../components/ui.tsx';
import { href, setLeaveGuard } from '../router.ts';
import { saveSettings } from '../store.ts';
import { run } from '../toast.ts';
import { AvatarField } from './Settings.tsx';
import './public-page-editor.css';

interface Draft {
  publicTitle: string;
  browserTitle: string;
  bio: string;
  avatar?: string;
  grid: PublicGridItem[];
  bottom: Record<PublicBottomId, boolean>;
  hero: Record<PublicHeroPart, boolean>;
}

const draftOf = (publicTitle: string | undefined, cfg: PublicPageConfig | undefined): Draft => ({
  publicTitle: publicTitle ?? '',
  browserTitle: cfg?.browserTitle ?? '',
  bio: cfg?.bio ?? '',
  avatar: cfg?.avatar,
  grid: publicGrid(cfg),
  bottom: { footer: publicBottomShown(cfg, 'footer'), pile: publicBottomShown(cfg, 'pile') },
  hero: { stats: publicHeroShown(cfg, 'stats'), timeline: publicHeroShown(cfg, 'timeline'), chart: publicHeroShown(cfg, 'chart') },
});

const defaultGrid = () => JSON.stringify(publicGrid(undefined));

/** 草稿转成要存的配置：和默认一样的部分不存，全部默认时返回 undefined（设置里不留这个字段） */
function configOf(d: Draft): PublicPageConfig | undefined {
  const hiddenBottom = PUBLIC_BOTTOM_SECTIONS.filter((id) => !d.bottom[id]).map((id) => ({ id: id as string, hidden: true }));
  const grid = JSON.stringify(d.grid) === defaultGrid() ? [] : d.grid.map((s) => ({ id: s.id as string, span: s.span, ...(s.hidden ? { hidden: true } : {}) }));
  const sections = [...grid, ...hiddenBottom];
  const heroOff = PUBLIC_HERO_PARTS.filter((p) => !d.hero[p]);
  const cfg: PublicPageConfig = {
    ...(d.browserTitle.trim() ? { browserTitle: d.browserTitle.trim() } : {}),
    ...(d.bio.trim() ? { bio: d.bio.trim() } : {}),
    ...(d.avatar ? { avatar: d.avatar } : {}),
    ...(sections.length ? { sections } : {}),
    ...(heroOff.length ? { heroParts: Object.fromEntries(heroOff.map((p) => [p, false])) } : {}),
  };
  return Object.keys(cfg).length ? cfg : undefined;
}

const sectionLabel: Record<string, () => string> = {
  hero: () => t('settings.publicPage.hero'),
  composition: () => t('public.composition.title'),
  fx: () => t('public.fx.title'),
  list: () => t('public.list.title'),
  ended: () => t('public.ended.title'),
  lifetime: () => t('public.lifetime.title'),
  stats: () => t('settings.publicPage.stats'),
  timeline: () => t('public.timeline.title'),
  chart: () => t('public.chart.title'),
  footer: () => t('settings.publicPage.footer'),
  pile: () => t('settings.publicPage.pile'),
};

function SectionRow({ item, onChange }: { item: PublicGridItem; onChange: (patch: Partial<PublicGridItem>) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const label = sectionLabel[item.id]();
  return (
    <div
      ref={setNodeRef as (el: HTMLDivElement | null) => void}
      className={`cell cat-row nav-row ${isDragging ? 'lifted' : ''}`}
      style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition } as Record<string, string | undefined>}
    >
      <IconButton
        type="button"
        ref={setActivatorNodeRef as (el: HTMLButtonElement | null) => void}
        className="cat-grip"
        aria-label={t('settings.cat.dragHandle')}
        {...(attributes as unknown as Record<string, unknown>)}
        {...(listeners as Record<string, unknown>)}
      >
        <Icon name="grip" />
      </IconButton>
      <span className="nav-row-name">{label}</span>
      {!item.hidden && (
        <span className="cell-r">
          <Stepper
            value={item.span}
            min={item.min}
            max={PUBLIC_COLUMNS}
            label={t('settings.publicPage.width', { name: label })}
            unit={() => `/${PUBLIC_COLUMNS}`}
            onChange={(span) => onChange({ span })}
          />
        </span>
      )}
      <Toggle label={label} checked={!item.hidden} onChange={(v) => onChange({ hidden: !v })} />
    </div>
  );
}

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
  const width = device === 'desktop' ? 1200 : 390;
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

export function PublicPageEditor({ state }: { state: AppState }) {
  const s: Settings = state.settings;
  const saved = useMemo(() => draftOf(s.publicTitle, s.publicPage), [s.publicTitle, s.publicPage]);
  const [draft, setDraft] = useState(saved);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const narrow = useMedia('(max-width: 860px)');
  const up = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const config = configOf(draft);
  const dirty = draft.publicTitle.trim() !== (s.publicTitle ?? '') || JSON.stringify(config) !== JSON.stringify(configOf(saved));
  const isDefault = !config && !draft.publicTitle.trim();

  // 预览数据：真实账本走同一个脱敏，所有组件都下发（草稿可能重新打开任何组件）；账本没变就不重发
  const masked = useMemo(() => maskForPublic(state, { untrimmed: true }), [state]);
  // config 每次渲染都是新对象，按内容判断有没有变
  const configKey = JSON.stringify(config);
  const previewDraft = useMemo(
    () => ({
      publicTitle: draft.publicTitle.trim() || undefined,
      displayName: draft.publicTitle.trim() ? '' : s.displayName,
      avatar: config?.avatar ?? s.avatar,
      config: publicConfigForVisitors(config),
    }),
    [configKey, draft.publicTitle, s.displayName, s.avatar],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, location.origin);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.type !== PUBLIC_PREVIEW_READY) return;
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

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = draft.grid.map((x) => x.id as string);
    up({ grid: arrayMove(draft.grid, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))) });
  };
  const save = () => run(() => saveSettings({ publicTitle: (draft.publicTitle.trim() || null) as string | undefined, publicPage: (config ?? null) as PublicPageConfig | undefined }), t('settings.toast.saved'));

  const heroRow = draft.grid.find((x) => x.id === 'hero');
  const placeholderTitle = s.displayName.trim() ? t('public.title', { name: s.displayName.trim() }) : t('public.titleAnon');
  const showEdit = !narrow || tab === 'edit';
  const showPreview = !narrow || tab === 'preview';

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
        <button type="button" className="btn" disabled={isDefault} onClick={() => setDraft(draftOf(undefined, undefined))}>
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
        <div className="ppe-form stack" hidden={!showEdit}>
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
          <Group title={t('settings.publicPage.sections')} foot={t('settings.publicPage.sectionsFoot')}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={draft.grid.map((x) => x.id)} strategy={verticalListSortingStrategy}>
                {draft.grid.map((item) => (
                  <SectionRow key={item.id} item={item} onChange={(patch) => up({ grid: draft.grid.map((x) => (x.id === item.id ? { ...x, ...patch } : x)) })} />
                ))}
              </SortableContext>
            </DndContext>
            {PUBLIC_BOTTOM_SECTIONS.map((id) => (
              <Cell key={id} label={sectionLabel[id]()}>
                <Toggle label={sectionLabel[id]()} checked={draft.bottom[id]} onChange={(v) => up({ bottom: { ...draft.bottom, [id]: v } })} />
              </Cell>
            ))}
          </Group>
          {heroRow && !heroRow.hidden && (
            <Group title={t('settings.publicPage.heroParts')}>
              {PUBLIC_HERO_PARTS.map((part) => (
                <Cell key={part} label={sectionLabel[part]()}>
                  <Toggle label={sectionLabel[part]()} checked={draft.hero[part]} onChange={(v) => up({ hero: { ...draft.hero, [part]: v } })} />
                </Cell>
              ))}
            </Group>
          )}
        </div>
        <div className="ppe-preview" hidden={!showPreview}>
          <Seg
            small
            value={device}
            onChange={setDevice}
            options={[
              ['desktop', t('settings.publicPage.desktop')],
              ['phone', t('settings.publicPage.phone')],
            ]}
          />
          <Preview device={device} frame={frame} />
        </div>
      </div>
    </>
  );
}


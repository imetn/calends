import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../shared/i18n.ts';
import { maskForPublic } from '../../../shared/mask.ts';
import {
  PUBLIC_BIO_MAX,
  PUBLIC_BOTTOM_SECTIONS,
  PUBLIC_GRID_SECTIONS,
  PUBLIC_HERO_PARTS,
  PUBLIC_PREVIEW_DATA,
  PUBLIC_PREVIEW_DRAFT,
  PUBLIC_PREVIEW_LAYOUT,
  PUBLIC_PREVIEW_READY,
  PUBLIC_TITLE_MAX,
  publicBottomShown,
  publicConfigForVisitors,
  publicGrid,
  publicHeroShown,
  gridConfig,
  hideItem,
  showItem,
  validPublicPage,
  type PublicBottomId,
  type PublicGridItem,
  type PublicHeroPart,
} from '../../../shared/public-layout.ts';
import type { AppState, PublicPageConfig, PublicSectionConfig, Settings } from '../../../shared/types.ts';
import { base } from '../base.ts';
import { ask } from '../components/overlays.tsx';
import { Seg, Toggle, useMedia } from '../components/inputs.tsx';
import { Cell, Group, Toolbar } from '../components/ui.tsx';
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

/** 草稿转成要存的配置：和默认一样的部分不存，全部默认时返回 undefined（设置里不留这个字段） */
function configOf(d: Draft): PublicPageConfig | undefined {
  const hiddenBottom = PUBLIC_BOTTOM_SECTIONS.filter((id) => !d.bottom[id]).map((id) => ({ id: id as string, hidden: true }));
  const sections = [...gridConfig(d.grid), ...hiddenBottom];
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

const isBottom = (id: string): id is PublicBottomId => (PUBLIC_BOTTOM_SECTIONS as readonly string[]).includes(id);
const hideSection = (d: Draft, id: string): Draft =>
  isBottom(id) ? { ...d, bottom: { ...d.bottom, [id]: false } } : { ...d, grid: hideItem(d.grid, id) };
const addSection = (d: Draft, id: string): Draft => (isBottom(id) ? { ...d, bottom: { ...d.bottom, [id]: true } } : { ...d, grid: showItem(d.grid, id) });

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

export function PublicPageEditor({ state }: { state: AppState }) {
  const s: Settings = state.settings;
  const saved = useMemo(() => draftOf(s.publicTitle, s.publicPage), [s.publicTitle, s.publicPage]);
  const [draft, setDraft] = useState(saved);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const narrow = useMedia('(max-width: 860px)');
  // 触屏上手指要用来滚动页面，画布只看不改
  const touch = useMedia('(pointer: coarse)');
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
      // 手机宽度、窄屏和触屏上只看效果
      canvas: narrow || touch || device !== 'desktop' ? undefined : { labels: Object.fromEntries(Object.keys(sectionLabel).map((id) => [id, sectionLabel[id]()])), remove: t('settings.publicPage.remove'), empty: t('settings.publicPage.emptyCard') },
    }),
    [configKey, draft.publicTitle, s.displayName, s.avatar, narrow, touch, device],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, location.origin);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === PUBLIC_PREVIEW_LAYOUT) {
        const { sections, remove } = e.data as { sections?: PublicSectionConfig[]; remove?: string };
        if (sections && validPublicPage({ sections })) setDraft((d) => ({ ...d, grid: publicGrid({ sections }) }));
        if (remove) setDraft((d) => hideSection(d, remove));
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
          <Group title={t('settings.publicPage.sections')} foot={t('settings.publicPage.sectionsFoot')}>
            {[...PUBLIC_GRID_SECTIONS.map((x) => x.id as string), ...PUBLIC_BOTTOM_SECTIONS].map((id) => {
              const on = isBottom(id) ? draft.bottom[id] : !draft.grid.find((x) => x.id === id)?.hidden;
              return (
                <Cell key={id} label={sectionLabel[id]()}>
                  <button type="button" className="btn" onClick={() => setDraft((d) => (on ? hideSection(d, id) : addSection(d, id)))}>
                    {t(on ? 'settings.publicPage.remove' : 'settings.publicPage.add')}
                  </button>
                </Cell>
              );
            })}
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


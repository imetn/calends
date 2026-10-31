import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';
import { arcAngle } from '../mobile-nav.ts';
import { usePageAdd } from '../page-add.ts';
import { href } from '../router.ts';
import { THEME_LABEL, ThemeIcon, type ThemeMode } from '../theme.tsx';
import { Icon } from './icons.tsx';

/** 手机导航的一项：key 是底栏设置里的键，path 是点下去的路由 */
export interface MobileItem {
  key: string;
  path: string;
  label: string;
  icon: string;
}

/** 当前路由属于哪个入口：分类页算订阅，成员页算合租，助手与连接算 AI */
export function routeKey(route: string) {
  if (route.startsWith('cat/')) return 'list';
  if (route === 'family/people') return 'family';
  if (route === 'assistant' || route === 'connect') return 'ai';
  return route;
}

/** 输入框聚焦时软键盘会顶起底栏、挡住内容：触屏上这时先把底栏收起 */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const coarse = matchMedia('(pointer: coarse)');
    const check = () => {
      const el = document.activeElement as HTMLElement | null;
      const editable =
        !!el &&
        (el.isContentEditable ||
          el.tagName === 'TEXTAREA' ||
          (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/.test((el as HTMLInputElement).type)));
      setTyping(coarse.matches && editable);
    };
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', check);
    return () => {
      document.removeEventListener('focusin', check);
      document.removeEventListener('focusout', check);
    };
  }, []);
  return typing;
}

/**
 * 圆弧几何：圆按钮直径 56、任意相邻两圆之间留 12（同圈相邻按弦长，内外圈按半径差），
 * 所以圆心间距 PITCH 同时是弦长和两圈半径差。改直径要同步 styles.css 的 .arc-item。
 */
const PITCH = 56 + 12;
const RING = { inner: 100, outer: 100 + PITCH };

const at = (deg: number, r: number) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];

/** 放进圆弧的一项：独立的圆按钮，图标与名称上下排在圆内 */
function Slot({ ring, i, n, delay, children }: { ring: 'inner' | 'outer'; i: number; n: number; delay: number; children: ReactNode }) {
  const deg = arcAngle(i, n, RING[ring], PITCH);
  const [x, y] = at(deg, RING[ring]);
  const style = { '--x': `${x}px`, '--y': `${y}px`, '--d': `${delay}ms` } as CSSProperties;
  return (
    <div className="arc-slot" style={style}>
      {children}
    </div>
  );
}

/**
 * 手机底栏：左边 4 个入口的胶囊，右边圆形「更多」；只在窄屏渲染，桌面端没有这段 DOM。
 * 点「更多」胶囊向左退出，从按钮处展开两圈 90° 圆弧：内圈货币、主题、设置，外圈其余模块和新建。
 */
export function Dock({
  bar,
  more,
  route,
  open,
  onOpen,
  currency,
  theme,
  toggleTheme,
  settings,
  onAdd,
}: {
  bar: MobileItem[];
  more: MobileItem[];
  route: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** 货币切换（CurrencyPicker 的圆弧形态） */
  currency: ReactNode;
  theme: ThemeMode;
  toggleTheme: () => void;
  settings: boolean;
  onAdd?: () => void;
}) {
  const typing = useTyping();
  const key = routeKey(route);
  const inBar = bar.some((n) => n.key === key);
  const btn = useRef<HTMLButtonElement>(null);
  const arc = useRef<HTMLDivElement>(null);
  // 关上时先播收起动画再卸载；打开时先挂上收起态，下一帧再展开
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setShown(true))));
      return () => cancelAnimationFrame(raf);
    }
    // 焦点在圆弧里时（点遮罩、点链接、Esc）交回「更多」，不让它随圆弧卸载掉到 body
    if (arc.current?.contains(document.activeElement)) btn.current?.focus();
    setShown(false);
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
  }, [open]);
  // 展开后焦点进入圆弧；键盘用户从第一项开始，触屏不会显示焦点环
  useEffect(() => {
    if (shown) arc.current?.querySelector<HTMLElement>('.arc-item')?.focus({ preventScroll: true });
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 货币选择器开着时按键交给选择器
      if (document.querySelector('.dp-scrim')) return;
      if (e.key === 'Escape') onOpen(false);
      if (e.key !== 'Tab' || !arc.current || !btn.current) return;
      // Tab 只在圆弧各项与「更多」之间循环
      const ring = [...arc.current.querySelectorAll<HTMLElement>('.arc-item'), btn.current];
      const i = ring.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => onOpen(false);
  // 唯一的新建：当前页登记了自己的新建（合租、代付、人员）就执行它，否则新建普通订阅；只读时没有
  const pageAdd = usePageAdd();
  const add = onAdd && (pageAdd?.run ?? onAdd);
  const outer: ReactNode[] = more.map((n) => (
    <a key={n.key} className={`arc-item ${n.key === key ? 'on' : ''}`} href={href(n.path)} aria-current={n.key === key ? 'page' : undefined} onClick={close}>
      <Icon name={n.icon} />
      <span className="arc-label">{n.label}</span>
    </a>
  ));
  if (add)
    outer.push(
      <button
        key="add"
        type="button"
        className="arc-item"
        aria-label={pageAdd?.label}
        onClick={() => {
          close();
          add();
        }}
      >
        <Icon name="plus" />
        <span className="arc-label">{t('app.sidebar.new')}</span>
      </button>,
    );
  const inner: ReactNode[] = [
    <Fragment key="currency">{currency}</Fragment>,
    <button key="theme" type="button" className="arc-item" onClick={toggleTheme} aria-label={`${t('app.sidebar.theme')} ${THEME_LABEL[theme]}`}>
      <ThemeIcon mode={theme} size={20} />
      <span className="arc-label">{t('app.sidebar.theme')}</span>
    </button>,
  ];
  if (settings)
    inner.push(
      <a key="settings" className={`arc-item ${route === 'settings' ? 'on' : ''}`} href={href('settings')} onClick={close}>
        <Icon name="gear" />
        <span className="arc-label">{t('app.nav.settings')}</span>
      </a>,
    );

  return (
    <>
      {mounted && (
        <>
          <div className={`arc-scrim ${shown ? 'on' : ''}`} onClick={close} />
          <div ref={arc} className={`arc ${shown ? 'on' : ''}`} role="dialog" aria-modal="true" aria-label={t('app.nav.more')}>
            {inner.map((node, i) => (
              <Slot key={i} ring="inner" i={i} n={inner.length} delay={i * 35}>
                {node}
              </Slot>
            ))}
            {outer.map((node, i) => (
              <Slot key={i} ring="outer" i={i} n={outer.length} delay={60 + i * 35}>
                {node}
              </Slot>
            ))}
          </div>
        </>
      )}
      <nav className={`dock ${typing ? 'hide' : ''} ${open ? 'open' : ''}`} aria-label={t('app.nav.label')}>
        <div className="dock-bar" inert={open}>
          {bar.map((n) => (
            <a key={n.key} className={`tab ${n.key === key ? 'on' : ''}`} href={href(n.path)} aria-current={n.key === key ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </div>
        <button
          ref={btn}
          type="button"
          className={`dock-more ${!inBar ? 'on' : ''}`}
          onClick={() => onOpen(!open)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('app.nav.more')}
        >
          <Icon name="more" />
          <Icon name="x" />
        </button>
      </nav>
    </>
  );
}

/** AI 页顶部的「助手 | 连接」切换：两个页面都可用时才出现 */
export function AiSwitch({ route }: { route: string }) {
  return (
    <div className="seg ai-switch" role="tablist">
      {(['assistant', 'connect'] as const).map((p) => (
        <a key={p} role="tab" aria-selected={route === p} className={route === p ? 'on' : ''} href={href(p)}>
          {t(p === 'assistant' ? 'app.nav.assistant' : 'app.nav.ai')}
        </a>
      ))}
    </div>
  );
}

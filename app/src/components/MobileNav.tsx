import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';
import { href } from '../router.ts';
import { THEME_LABEL, ThemeIcon, type ThemeMode } from '../theme.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './overlays.tsx';

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

/** 手机底栏：4 个入口 +「更多」；只在窄屏渲染，桌面端没有这段 DOM */
export function TabBar({ bar, route, moreOpen, onMore }: { bar: MobileItem[]; route: string; moreOpen: boolean; onMore: () => void }) {
  const typing = useTyping();
  const at = routeKey(route);
  const inBar = bar.some((n) => n.key === at);
  return (
    <nav className={`tabbar ${typing ? 'hide' : ''}`} aria-label={t('app.nav.label')}>
      {bar.map((n) => (
        <a key={n.key} className={`tab ${!moreOpen && n.key === at ? 'on' : ''}`} href={href(n.path)} aria-current={n.key === at ? 'page' : undefined}>
          <Icon name={n.icon} />
          <span>{n.label}</span>
        </a>
      ))}
      <button type="button" className={`tab ${moreOpen || !inBar ? 'on' : ''}`} onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen}>
        <Icon name="more" />
        <span>{t('app.nav.more')}</span>
      </button>
    </nav>
  );
}

/** 「更多」：底栏放不下的模块，以及货币、主题、设置这些低频项 */
export function MoreSheet({
  more,
  route,
  currency,
  theme,
  toggleTheme,
  settings,
  onClose,
}: {
  more: MobileItem[];
  route: string;
  currency: ReactNode;
  theme: ThemeMode;
  toggleTheme: () => void;
  settings: boolean;
  onClose: () => void;
}) {
  const at = routeKey(route);
  return (
    <Sheet title={t('app.nav.more')} onClose={onClose} narrow>
      <div className="more">
        {more.length > 0 && (
          <div className="more-group">
            {more.map((n) => (
              <a key={n.key} className={`side-item ${n.key === at ? 'active' : ''}`} href={href(n.path)} onClick={onClose}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
              </a>
            ))}
          </div>
        )}
        <div className="more-group">
          {currency}
          <button type="button" className="side-item theme-item" onClick={toggleTheme} title={t('app.sidebar.themeHint')}>
            <ThemeIcon mode={theme} size={17} />
            <span>{t('app.sidebar.theme')}</span>
            <small>{THEME_LABEL[theme]}</small>
          </button>
          {settings && (
            <a className={`side-item ${route === 'settings' ? 'active' : ''}`} href={href('settings')} onClick={onClose}>
              <Icon name="gear" />
              <span>{t('app.nav.settings')}</span>
            </a>
          )}
        </div>
      </div>
    </Sheet>
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

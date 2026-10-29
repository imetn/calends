import { commandLabel, focusPageSearch, pageShortcut, preventBrowserSave } from './keyboard.ts';
import { KeyboardHelp } from './components/KeyboardHelp.tsx';
import { isPasskeyCancellation } from './passkey-autofill.ts';
import { base } from './base.ts';
import { createRoot } from 'react-dom/client';
import { FocusScope } from 'react-aria';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { addDays, diffDays, effectiveStatus, nextCharge, isStopped } from '../../shared/billing.ts';
import { cnDate, money, setSignedAmounts } from '../../shared/format.ts';
import { avatarOf, type AppState, type Subscription } from '../../shared/types.ts';
import { IconButton } from './components/ui.tsx';
import { AskLayer, TipLayer, Toasts } from './components/overlays.tsx';
import { Icon } from './components/icons.tsx';
import { SubIcon } from './components/marks.tsx';
import { useMedia } from './components/inputs.tsx';
import { authStatus, boot, login, loginPasskey, saveSettings, setupPassword, startPasskeyAutofill, today, useStore } from './store.ts';
import { run } from './toast.ts';
import { usePref } from './prefs.ts';
import { HIDDEN_CCY, setOrig, useOrig } from './display.ts';
import { syncCategories } from './derive.ts';
import { CurrencyPicker } from './components/CurrencyPicker.tsx';
import { THEME_LABEL, ThemeIcon, useThemeMode, type ThemeMode } from './theme.tsx';
import './heroui.css';
import './styles.css';
import { Carpool } from './views/Carpool.tsx';
import { ProxyPage } from './views/Proxy.tsx';
import { PeopleView } from './views/People.tsx';
import { Detail } from './views/Detail.tsx';
import { Editor } from './views/Editor.tsx';
import { newSub } from './views/editor/new-sub.ts';
import { List } from './views/List.tsx';
import { Overview } from './views/Overview.tsx';
import { Report } from './views/Report.tsx';
import { IcsSheet, Settings } from './views/Settings.tsx';
import { currentRoute, go as navigate, href, initRouter, loginNext, onRoute, replaceRoute, sortNav } from './router.ts';
import { locale, t } from '../../shared/i18n.ts';
import { initialLocale, loadLocale, preferredLocale } from './i18n.ts';
import { monthEnd } from '../../shared/metrics.ts';
import { useTextSearch } from './use-search.ts';

// AI 助手页带着 Markdown 渲染器（Streamdown），按需加载，不拖慢其他页面的首屏
const loadAssistant = () => import('./views/Assistant.tsx');
const Assistant = lazy(() => loadAssistant().then((m) => ({ default: m.Assistant })));
// 日历、钱包、连接与年度回顾不在首屏：按需加载，首屏渲染后空闲时预取，切过去不用等
const loadCalendar = () => import('./views/Calendar.tsx');
const loadWallet = () => import('./views/Wallet.tsx');
const loadAi = () => import('./views/Ai.tsx');
const loadReview = () => import('./views/Review.tsx');
const Calendar = lazy(() => loadCalendar().then((m) => ({ default: m.Calendar })));
const Wallet = lazy(() => loadWallet().then((m) => ({ default: m.Wallet })));
const Ai = lazy(() => loadAi().then((m) => ({ default: m.Ai })));
const Review = lazy(() => loadReview().then((m) => ({ default: m.Review })));
function prefetchViews() {
  const run = () => [loadCalendar, loadWallet, loadAi, loadReview, loadAssistant].forEach((load) => void load().catch(() => {}));
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

/** label 是 app.nav.* 的键，取用时再翻译 */
const NAV = [
  { path: 'overview', label: 'overview', icon: 'home' },
  { path: 'list', label: 'list', icon: 'list' },
  { path: 'calendar', label: 'calendar', icon: 'cal' },
  { path: 'report', label: 'report', icon: 'chart' },
  { path: 'wallet', label: 'wallet', icon: 'wallet' },
  { path: 'family', label: 'family', icon: 'users' },
  { path: 'behalf', label: 'behalf', icon: 'swap' },
  { path: 'assistant', label: 'assistant', icon: 'chat' },
  { path: 'connect', label: 'ai', icon: 'bot' },
];

/** 侧边栏实际显示的模块：去掉设置里隐藏的；AI 接入关掉时也不显示 */
function navOf(st: AppState['settings']) {
  const hidden = st.hiddenNav ?? [];
  const shown = NAV.filter((n) => !hidden.includes(n.path) && (n.path !== 'connect' || st.aiEnabled !== false));
  return sortNav(shown, (n) => n.path, st.navOrder).map((n) => ({
    ...n,
    label: t(`app.nav.${n.label}`),
  }));
}

function useRoute() {
  const [r, setR] = useState(currentRoute());
  useEffect(
    () =>
      onRoute(() => {
        setR(currentRoute());
        window.scrollTo({ top: 0 });
      }),
    [],
  );
  return r;
}

/** 整页提示（连不上且没有缓存、页面出错）：沿用登录页的卡片，只给重试，不出现密码框 */
function Notice({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="login">
      <div className="login-card fade-in">
        <img src={base('/icons/icon-192.png')} alt="" />
        <h1>{t('app.name')}</h1>
        <p>{text}</p>
        <button type="button" className="btn primary lg" onClick={onRetry}>
          {t('app.reload')}
        </button>
      </div>
    </div>
  );
}

/** 渲染出错时不留白屏：整页提示并可重新加载；正常渲染时不包任何元素 */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.failed ? <Notice text={t('app.crashed')} onRetry={() => location.reload()} /> : this.props.children;
  }
}

function Login() {
  const [status, setStatus] = useState<{ needsSetup: boolean; passkeys: number }>();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const autofill = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    authStatus().then(setStatus, () => setStatus({ needsSetup: false, passkeys: 0 }));
  }, []);
  const go = async (fn: () => Promise<void>) => {
    autofill.current?.();
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (x) {
      // 用户在系统弹窗里取消 Passkey 不算错误
      if (!isPasskeyCancellation(x)) setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  const setupMode = status?.needsSetup;
  const mismatch = setupMode && pw2 !== '' && pw !== pw2;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void go(() => (setupMode ? setupPassword(token.trim(), pw) : login(pw)));
  };
  const canPasskey = !setupMode && !!status?.passkeys && typeof window.PublicKeyCredential === 'function';
  useEffect(() => {
    if (!canPasskey || busy) return;
    const stop = startPasskeyAutofill((x) => setErr(x instanceof Error ? x.message : String(x)));
    autofill.current = stop;
    return stop;
  }, [canPasskey, busy]);
  return (
    <div className="login">
      <form className="login-card fade-in" onSubmit={submit}>
        <img src={base('/icons/icon-192.png')} alt="" />
        <h1>{t('app.name')}</h1>
        <p>{setupMode ? t('app.login.setupHint') : t('app.login.tagline')}</p>
        <label className="login-account" htmlFor="login-username">
          <span>{t('app.login.username')}</span>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete={setupMode ? 'username' : 'username webauthn'}
            value={`owner@${location.hostname}`}
            readOnly
          />
        </label>
        {setupMode && (
          <input
            type="password"
            autoComplete="off"
            aria-label={t('app.login.setupToken')}
            placeholder={t('app.login.setupToken')}
            value={token}
            onChange={(e) => setToken((e.target as HTMLInputElement).value)}
          />
        )}
        <input
          type="password"
          autoFocus
          name="password"
          aria-label={setupMode ? t('app.login.newPassword') : t('app.login.password')}
          autoComplete={setupMode ? 'new-password' : 'current-password webauthn'}
          placeholder={setupMode ? t('app.login.newPassword') : t('app.login.password')}
          value={pw}
          onChange={(e) => setPw((e.target as HTMLInputElement).value)}
        />
        {setupMode && (
          <input
            type="password"
            autoComplete="new-password"
            aria-label={t('app.login.again')}
            placeholder={t('app.login.again')}
            value={pw2}
            onChange={(e) => setPw2((e.target as HTMLInputElement).value)}
          />
        )}
        {(err || mismatch) && (
          <div className="red" style={{ fontSize: 'var(--fs-2)' }}>
            {mismatch ? t('app.login.mismatch') : err}
          </div>
        )}
        <button className="btn primary lg" disabled={!status || !pw || busy || (setupMode && (!token || pw.length < 8 || pw !== pw2))}>
          {busy ? t('app.login.verifying') : setupMode ? t('app.login.setupEnter') : t('app.login.enter')}
        </button>
        {canPasskey && (
          <button type="button" className="btn lg" disabled={busy} onClick={() => go(() => loginPasskey())}>
            <Icon name="key" /> {t('app.login.passkey')}
          </button>
        )}
      </form>
    </div>
  );
}

function Sidebar({
  state,
  route,
  d,
  theme,
  toggleTheme,
  onOpen,
  onAdd,
  onSearch,
  onCollapse,
  inert,
}: {
  state: AppState;
  route: string;
  d: string;
  theme: ThemeMode;
  toggleTheme: () => void;
  onOpen: (s: Subscription) => void;
  onAdd: () => void;
  onSearch: () => void;
  onCollapse: () => void;
  inert?: boolean;
}) {
  const [gear, setGear] = useState(0);
  // 即将扣款：像聊天记录一样列在导航下方；往后看 0 天表示看到本月月底
  const days = state.settings.upcomingDays ?? 45;
  const horizon = days === 0 ? monthEnd(d.slice(0, 7)) : addDays(d, days);
  const upcoming = state.subscriptions
    .filter((s) => !s.proxy) // 代付在「代付」页单独管
    .map((s) => ({ s, n: nextCharge(s, addDays(d, 1)) }))
    .filter((x) => x.n && x.n <= horizon)
    .sort((a, b) => a.n!.localeCompare(b.n!))
    .slice(0, 12);
  const showUpcoming = state.settings.sidebarUpcoming !== false;
  return (
    <aside className="sidebar" inert={inert}>
      <div className="sb-top">
        <a className="sb-mark" href={href('overview')}>
          <img src={base(avatarOf(state.settings))} alt="" />
          {t('app.name')}
        </a>
        <IconButton className="sb-btn sb-toggle" onClick={onCollapse} title={t('app.sidebar.collapse')} aria-label={t('app.sidebar.collapse')}>
          <Icon name="sidebar" />
        </IconButton>
      </div>
      {!state.readonly && (
        <button className="side-item" onClick={onAdd}>
          <Icon name="compose" />
          <span>{t('app.sidebar.new')}</span>
          <kbd>N</kbd>
        </button>
      )}
      <button className="side-item" onClick={onSearch}>
        <Icon name="search" />
        <span>{t('app.sidebar.search')}</span>
        <kbd>{commandLabel()}K</kbd>
      </button>
      <div className="side-gap" />
      {navOf(state.settings).map((n) => (
        <a
          key={n.path}
          className={`side-item ${route === n.path || (n.path === 'list' && route.startsWith('cat/')) || (n.path === 'family' && route === 'family/people') ? 'active' : ''}`}
          href={href(n.path)}
        >
          <Icon name={n.icon} />
          <span>{n.label}</span>
        </a>
      ))}
      <div className="side-scroll side-recent">
        {showUpcoming && upcoming.length > 0 && <div className="side-label">{t('app.sidebar.upcoming')}</div>}
        {showUpcoming &&
          upcoming.map(({ s, n }) => {
            const days = diffDays(d, n!);
            return (
              <button key={s.id} className={`side-item ${days <= 3 ? 'soon' : ''}`} onClick={() => onOpen(s)}>
                <SubIcon sub={s} size={18} />
                <span>{s.name}</span>
                <small>
                  {days === 0
                    ? t('app.sidebar.today')
                    : days === 1
                      ? t('app.sidebar.tomorrow')
                      : days < 7
                        ? t('app.sidebar.inDays', { count: days })
                        : cnDate(n!)}
                </small>
              </button>
            );
          })}
      </div>
      <div className="side-foot">
        <CurrencyItem state={state} />
        <button className="side-item theme-item" onClick={toggleTheme} title={t('app.sidebar.themeHint')}>
          <ThemeIcon mode={theme} size={17} />
          <span>{t('app.sidebar.theme')}</span>
          <small>{THEME_LABEL[theme]}</small>
        </button>
        {!state.readonly && (
          <a className={`side-item ${route === 'settings' ? 'active' : ''}`} href={href('settings')} onClick={() => setGear(gear + 1)}>
            {/* 每点一下齿轮转一圈：先慢、再快、再慢 */}
            <span className="ico-turn gear" style={{ transform: `rotate(${gear * 360}deg)` }}>
              <Icon name="gear" />
            </span>
            <span>{t('app.nav.settings')}</span>
          </a>
        )}
      </div>
    </aside>
  );
}

/**
 * 侧边栏「货币」：点开直接是下拉。原币 = 列表按各自币种显示；选一种货币 = 全站统计按它折算，列表也换成它。
 * 原币只影响显示，统计仍沿用上次选的货币。
 */
function CurrencyItem({ state }: { state: AppState }) {
  const orig = useOrig();
  const base = state.settings.baseCurrency;
  const value = orig ? 'orig' : base;
  // 常用：美元、人民币，再加订阅里实际用到的币种（含各个分段），按出现次数排；其余按代码排序，汇率接口支持的全部列出
  const count = new Map<string, number>();
  for (const s of state.subscriptions) for (const c of new Set([s.currency, ...(s.phases ?? []).map((p) => p.currency)])) count.set(c, (count.get(c) ?? 0) + 1);
  const used = [...new Set(['USD', 'CNY', ...[...count].sort((a, b) => b[1] - a[1]).map(([c]) => c)])].filter((c) => state.fx.rates[c]);
  const rest = Object.keys(state.fx.rates)
    .filter((c) => !used.includes(c) && !HIDDEN_CCY.has(c))
    .sort();
  const pick = (v: string) => {
    if (v === 'orig') return setOrig(true);
    setOrig(false);
    if (v !== base && !state.readonly) run(() => saveSettings({ baseCurrency: v }));
  };
  return <CurrencyPicker value={value} used={used} all={rest} onChange={pick} />;
}

/** ⌘K 搜索：订阅、页面、操作 */
function Palette({
  state,
  d,
  onClose,
  onOpen,
  onAdd,
}: {
  state: AppState;
  d: string;
  onClose: () => void;
  onOpen: (s: Subscription) => void;
  onAdd: () => void;
}) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const lower = q.trim().toLowerCase();
  const haystack = (s: Subscription) => {
    const m = state.methods.find((x) => x.id === s.methodId)?.name ?? '';
    return `${s.name} ${s.category} ${s.tags.join(' ')} ${m} ${s.region ?? ''} ${s.notes ?? ''} ${s.proxy?.forName ?? ''}`;
  };
  const nav = [...navOf(state.settings), { path: 'settings', label: t('app.nav.settings'), icon: 'gear' }];
  const addKeywords = t('app.palette.addKeywords');
  const matches = useTextSearch([...state.subscriptions.map(haystack), ...nav.map((n) => n.label), addKeywords]);
  const subs = state.subscriptions
    // Multiple words must all match, as before.
    .filter((s) => !lower || lower.split(/\s+/).every((w) => matches(w, haystack(s))))
    .sort((a, b) => (isStopped(effectiveStatus(a, d)) ? 1 : 0) - (isStopped(effectiveStatus(b, d)) ? 1 : 0))
    .slice(0, 8);
  const pages = nav.filter((n) => matches(lower, n.label));
  const items: Array<{ key: string; run: () => void; el: React.JSX.Element }> = [
    ...subs.map((s) => ({
      key: s.id,
      run: () => onOpen(s),
      el: (
        <>
          <SubIcon sub={s} size={24} />
          {s.name}
          <small>{money(s.price, s.currency)}</small>
        </>
      ),
    })),
    ...pages.map((n) => ({
      key: n.path,
      run: () => navigate(n.path),
      el: (
        <>
          <Icon name={n.icon} />
          {n.label}
          <small>{t('app.palette.page')}</small>
        </>
      ),
    })),
    ...(!state.readonly && matches(lower, addKeywords)
      ? [
          {
            key: 'add',
            run: onAdd,
            el: (
              <>
                <Icon name="compose" />
                {t('app.palette.add')}
                <small>N</small>
              </>
            ),
          },
        ]
      : []),
  ];
  const go = (k: number) => {
    items[k]?.run();
    onClose();
  };
  // autoFocus 只在首次挂载可靠，第二次打开时手动聚焦
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="palette" role="dialog" aria-modal="true">
        <input
          ref={input}
          placeholder={t('app.palette.placeholder')}
          value={q}
          onChange={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setI(Math.min(items.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setI(Math.max(0, i - 1));
            }
            if (e.key === 'Enter') go(i);
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="palette-list">
          {items.length === 0 && <div className="pal-group">{t('app.palette.empty')}</div>}
          {items.map((it, k) => (
            <button key={it.key} className={`pal-item ${k === i ? 'on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => go(k)}>
              {it.el}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const { phase, state, error } = useStore();
  const route = useRoute();
  const [theme, toggleTheme] = useThemeMode();
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  // 从详情点「编辑」时记下来源，编辑关闭后回到这条订阅的详情，直接看到改动效果（删除后该订阅不存在，就不再打开）
  const [backTo, setBackTo] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [ics, setIcs] = useState(false);
  const [palette, setPalette] = useState(false);
  const [keyboardHelp, setKeyboardHelp] = useState(false);
  const editFromDetail = () => {
    const sub = state?.subscriptions.find((s) => s.id === viewId);
    if (!sub || state?.readonly) return;
    setBackTo(sub.id);
    setViewId(null);
    setEditing(sub);
  };
  const [collapsedPref, setCollapsedPref] = usePref<'0' | '1'>('sidebar-collapsed', '0', (v): v is '0' | '1' => v === '0' || v === '1');
  const collapsed = collapsedPref === '1';
  const setCollapsed = (v: boolean) => setCollapsedPref(v ? '1' : '0');
  const [drawer, setDrawer] = useState(false);
  const loaded = !!state;
  useEffect(() => {
    if (loaded) prefetchViews();
  }, [loaded]);
  const narrow = useMedia('(max-width: 860px)');
  // 变宽后抽屉不再适用：关掉
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  useEffect(() => {
    if (!drawer) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.scrim, [aria-modal="true"]')) return;
      e.preventDefault();
      setDrawer(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawer]);

  useEffect(() => setDrawer(false), [route]);
  // 未登录：除登录页外都跳到 /login 并记下原地址；根路径在开了公开页时让访客看公开页
  useEffect(() => {
    if (phase !== 'login' || route === 'login') return;
    if (route) return replaceRoute(`login?next=${encodeURIComponent(route)}`);
    authStatus().then(
      (s) => (s.publicView ? location.replace(base('/public')) : replaceRoute('login')),
      () => replaceRoute('login'),
    );
  }, [phase, route]);
  // 根路径和登录页都不是页面：登录后回到原地址，否则去设置里的启动页（默认概览）
  useEffect(() => {
    if (!state || (route !== '' && route !== 'login')) return;
    const sp = state.settings.startPage;
    const start = sp && navOf(state.settings).some((n) => n.path === sp) ? sp : 'overview';
    replaceRoute((route === 'login' && loginNext()) || start);
  }, [state, route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      // ⌘B 折叠或展开侧栏（旧的 ⌘\ 保留）；窄屏时开关抽屉
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'b' || e.key === '\\')) {
        e.preventDefault();
        if (narrow) setDrawer(!drawer);
        else setCollapsed(!collapsed);
        return;
      }
      const detail = viewId ? document.querySelector<HTMLElement>('.sheet-dlg:has(.dt)') : null;
      const action = pageShortcut(e, detail);
      if (action === 'edit') {
        e.preventDefault();
        editFromDetail();
      } else if (action === 'search') {
        e.preventDefault();
        if (!focusPageSearch(document)) setPalette(true);
      } else if (action === 'help') {
        e.preventDefault();
        setKeyboardHelp(true);
      } else if (action === 'new' && state && !state.readonly) {
        e.preventDefault();
        setEditing(newSub(today(), state.settings.defaultMethodId, state.settings.baseCurrency));
      } else if (typeof action === 'number' && state && action <= navOf(state.settings).length) {
        navigate(navOf(state.settings)[action - 1].path);
      }
    };
    const onDrawer = () => (matchMedia('(max-width: 860px)').matches ? setDrawer(true) : setCollapsed(false));
    // 可以带着草稿（AI 助手「编辑后添加」）
    const onAdd = (e: Event) =>
      state &&
      !state.readonly &&
      setEditing((e as CustomEvent<Subscription | undefined>).detail ?? newSub(today(), state?.settings.defaultMethodId, state?.settings.baseCurrency));
    document.addEventListener('keydown', onKey);
    document.addEventListener('keydown', preventBrowserSave, true);
    window.addEventListener('ledger:drawer', onDrawer);
    window.addEventListener('ledger:add', onAdd);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', preventBrowserSave, true);
      window.removeEventListener('ledger:drawer', onDrawer);
      window.removeEventListener('ledger:add', onAdd);
    };
  }, [state, collapsed, narrow, drawer, editing, viewId, review, ics, palette]);

  if (phase === 'loading' || (phase === 'login' && route !== 'login')) return <div className="login" />;
  // 连不上又没有缓存：只提示离线并可重试，不显示登录表单（此时输入密码也无法验证）
  if (phase === 'offline' && !state) return <Notice text={t('app.offlineError', { error: error ?? '' })} onRetry={() => void boot()} />;
  if (phase === 'login' || !state) return <Login />;
  // 分类表（图标、颜色、顺序）先于各页面同步，页面里按分类名直接查
  syncCategories(state);

  const d = today();
  const ro = !!state.readonly;
  const open = (s: Subscription) => {
    setDrawer(false);
    setViewId(s.id);
  };
  const add = () => {
    setDrawer(false);
    setEditing(newSub(d, state?.settings.defaultMethodId, state?.settings.baseCurrency));
  };
  const viewing = state.subscriptions.find((s) => s.id === viewId);

  let view;
  if (route.startsWith('cat/')) view = <List key={route} state={state} today={d} onOpen={open} onAdd={add} category={route.slice(4)} />;
  else
    switch (route) {
      case 'calendar':
        view = <Calendar state={state} today={d} onOpen={open} onIcs={() => setIcs(true)} />;
        break;
      case 'list':
        view = <List key="all" state={state} today={d} onOpen={open} onAdd={add} />;
        break;
      case 'wallet':
        view = <Wallet state={state} today={d} onOpen={open} />;
        break;
      case 'family':
        view = <Carpool state={state} today={d} onOpen={open} />;
        break;
      case 'family/people':
        view = ro ? <Carpool state={state} today={d} onOpen={open} /> : <PeopleView state={state} today={d} onOpen={open} />;
        break;
      case 'behalf':
        view = <ProxyPage state={state} today={d} onOpen={open} />;
        break;
      case 'connect':
        view = <Ai state={state} />;
        break;
      case 'assistant':
        view = ro ? null : <Assistant state={state} today={d} onOpen={open} />;
        break;
      case 'report':
        view = <Report state={state} today={d} onOpen={open} onReview={(y) => setReview(String(y))} />;
        break;
      case 'settings':
        view = ro ? null : <Settings state={state} today={d} />;
        break;
      case '':
      case 'login':
        // 等上面的副作用跳到启动页或原地址
        view = null;
        break;
      case 'overview':
        view = <Overview state={state} today={d} onOpen={open} onAdd={add} />;
        break;
      default:
        // 不认识的地址回到概览，地址栏也一并改正
        queueMicrotask(() => replaceRoute('overview'));
        view = null;
    }

  const sidebar = (
    <Sidebar
      inert={narrow ? !drawer : collapsed}
      state={state}
      route={route}
      d={d}
      theme={theme}
      toggleTheme={toggleTheme}
      onOpen={open}
      onAdd={add}
      onSearch={() => {
        setDrawer(false);
        setPalette(true);
      }}
      onCollapse={() => (drawer ? setDrawer(false) : setCollapsed(true))}
    />
  );

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''} ${drawer ? 'drawer' : ''}`}>
      {drawer && narrow ? (
        <FocusScope contain autoFocus restoreFocus>
          {sidebar}
        </FocusScope>
      ) : (
        sidebar
      )}
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <div className="main" inert={drawer && narrow}>
        {phase === 'offline' && (
          <div className="badge orange" style={{ position: 'fixed', top: 10, right: 10, zIndex: 50 }}>
            {t('app.offline')}
          </div>
        )}
        {collapsed && (
          <IconButton
            className="sb-btn sb-toggle reopen"
            onClick={() => setCollapsed(false)}
            title={t('app.sidebar.expand')}
            aria-label={t('app.sidebar.expand')}
          >
            <Icon name="sidebar" />
          </IconButton>
        )}
        <Suspense fallback={null}>{view}</Suspense>
      </div>

      {viewing && <Detail sub={viewing} state={state} today={d} onEdit={editFromDetail} onClose={() => setViewId(null)} />}
      {editing && (
        <Editor
          key={editing.id}
          sub={editing}
          state={state}
          today={d}
          onClose={() => {
            setEditing(null);
            if (backTo) setViewId(backTo);
            setBackTo(null);
          }}
        />
      )}
      {review && (
        <Suspense fallback={null}>
          <Review state={state} today={d} year={review} onClose={() => setReview(null)} />
        </Suspense>
      )}
      {ics && <IcsSheet state={state} onClose={() => setIcs(false)} />}
      {palette && <Palette state={state} d={d} onClose={() => setPalette(false)} onOpen={open} onAdd={add} />}
      {keyboardHelp && <KeyboardHelp onClose={() => setKeyboardHelp(false)} />}
      <Toasts />
      <TipLayer />
      <AskLayer />
    </div>
  );
}

/** 语言跟着设置走：设置变了就加载新语言包，并整棵树重新挂载 */
function Root() {
  const { state } = useStore();
  const [loc, setLoc] = useState(locale());
  const want = state ? preferredLocale(state.settings.language) : loc;
  const signed = state?.settings.signedAmounts !== false;
  setSignedAmounts(signed);
  useEffect(() => {
    if (want !== loc) void loadLocale(want).then(() => setLoc(want));
    document.title = t('app.name');
    // 跟随浏览器时，把实际用的语言记到设置里，提醒邮件和 MCP 用同一种
    if (state && !state.readonly && !state.settings.language && state.settings.languageSeen !== want) void saveSettings({ languageSeen: want }).catch(() => {});
    // 记下站点地址，定时提醒里的链接要用（本地开发不记）
    if (
      state &&
      !state.readonly &&
      state.settings.siteUrl !== `${location.origin}${base('/').replace(/\/$/, '')}` &&
      !/^http:\/\/(localhost|127\.)/.test(location.origin)
    )
      void saveSettings({ siteUrl: `${location.origin}${base('/').replace(/\/$/, '')}` }).catch(() => {});
  }, [want, loc]);
  return (
    <ErrorBoundary>
      <App key={`${loc}:${signed}`} />
    </ErrorBoundary>
  );
}

initRouter();
void loadLocale(initialLocale()).then(() => {
  createRoot(document.getElementById('app')!).render(<Root />);
  boot();
});

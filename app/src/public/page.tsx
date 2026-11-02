import { copyParts } from '../components/copy.tsx';
import { base as appPath, readStored, storageKey } from '../base.ts';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { addDays, addMonths, currentPhase, cycleLabel, diffDays, effectiveStatus, monthlyGross, myShareFactor, nextCharge, todayIn, isStopped } from '../../../shared/billing.ts';
import { cnDate, flow, moneyTick, money, monthLabel, setSignedAmounts, symbol } from '../../../shared/format.ts';
import { locale, t, type Params } from '../../../shared/i18n.ts';
import { chargeBaseOrNaN, chargeValue, toBaseAt, toBaseOrNaN } from '../../../shared/fx.ts';
import { cancelSavings, contributionOn, mrrSeries } from '../../../shared/metrics.ts';
import { avatarOf, type AppState, type PublicPageConfig, type Subscription } from '../../../shared/types.ts';
import { collapseEmpty, fillRows, flowSpans, gridSections, PUBLIC_GRID_SECTIONS, isCustomLayout, PUBLIC_PREVIEW_DATA, PUBLIC_PREVIEW_DRAFT, PUBLIC_PREVIEW_LAYOUT, PUBLIC_PREVIEW_READY, publicGrid, publicParts, tabletSpan, type PublicGridId, type PublicGridItem } from '../../../shared/public-layout.ts';
import { allCharges, catIcon, periodRange, sumBase, syncCategories, firstStart } from '../derive.ts';
import { CatGlyph } from '../components/CatGlyph.tsx';
import { THEME_LABEL, ThemeIcon, useThemeMode } from '../theme.tsx';
import { AppIcon } from '@/public/components/app-icon';
import { Timeline, type TimelineGroup } from '../components/Timeline.tsx';
import { Num } from '@/public/components/number';
import { Badge } from '@/public/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/public/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/public/components/ui/chart';
import { Separator } from '@/public/components/ui/separator';
import { Skeleton } from '@/public/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/public/components/ui/tabs';
import { TooltipProvider } from '@/public/components/ui/tooltip';
import { cn } from '@/public/lib/utils';
import { PROJECT_NAME, PROJECT_URL } from '../../../shared/brand.ts';
import { IconPile } from './components/icon-pile.tsx';
import { Canvas, CanvasFixed, cellVars, type CanvasText } from './canvas.tsx';
import { loadLocale, preferredLocale } from '../i18n.ts';

/** 公开页可切换的币种：本位币，和（本位币不是美元时）美元 */
type Ccy = string;

const save = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* 隐私模式下忽略 */
  }
};

/** 公开页去掉名字里的国旗 emoji，地区另有标签 */
const clean = (name: string) => name.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ').replace(/\s+/g, ' ').trim();

/** 标题：「某某的订阅」；没设名字时用通用标题 */
let owner = '';
let custom = '';
let tabTitle = '';
const title = () => custom.trim() || (owner.trim() ? t('public.title', { name: owner.trim() }) : t('public.titleAnon'));

/** 文案里嵌元素：先按 params 填文字（含复数），再把 {name} 换成 parts 里的节点 */
function rich(key: string, params: Params, parts: Record<string, React.ReactNode>): React.ReactNode[] {
  const s = t(key, params);
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    out.push(s.slice(last, m.index));
    out.push(m[1] in parts ? <Fragment key={m[1]}>{parts[m[1]]}</Fragment> : m[0]);
    last = m.index! + m[0].length;
  }
  out.push(s.slice(last));
  return out.map((node, i) => <Fragment key={i}>{copyParts(node)}</Fragment>);
}

/** 卡片留白：手机 16px，桌面 24px */
const roomy = 'sm:[--card-spacing:--spacing(6)]';

/** 页头和布局：访客来自账本设置；编辑页预览时由草稿实时覆盖，账本数据不重算 */
type View = { title?: string; avatar?: string; config?: PublicPageConfig; canvas?: CanvasText };
type Draft = Omit<View, 'title'> & { publicTitle?: string; displayName?: string };

/** 被同源页面嵌入的编辑预览：数据由编辑页发来，不请求接口，公开页关闭时也能看 */
const previewing = new URLSearchParams(location.search).has('preview') && window.parent !== window;

const applyTitle = (name: string | undefined, publicTitle: string | undefined, browserTitle: string | undefined) => {
  owner = name ?? '';
  custom = publicTitle ?? '';
  tabTitle = browserTitle?.trim() ?? '';
  document.title = tabTitle || title();
};

/** 对外公开的只读账本：数据已在服务端脱敏 */
export function PublicPage() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>({});
  const [err, setErr] = useState<string>();
  useEffect(() => {
    document.title = title();
    const show = async (body: AppState) => {
      // 语言包加载失败（发版后旧分包失效、断网）不挡账本：继续用当前语言渲染
      if (preferredLocale(body.settings.language) !== locale()) await loadLocale(preferredLocale(body.settings.language)).catch(() => undefined);
      if (body.settings.gainColor === 'red') document.documentElement.dataset.gain = 'red';
      applyTitle(body.settings.displayName, body.settings.publicTitle, body.settings.publicPage?.browserTitle);
      setSignedAmounts(body.settings.signedAmounts !== false);
      setView({ title: title(), avatar: body.settings.avatar, config: body.settings.publicPage });
      setState(body);
    };
    if (previewing) {
      document.documentElement.dataset.preview = '';
      let latest: Draft | undefined;
      const applyDraft = () => {
        if (!latest) return;
        applyTitle(latest.displayName, latest.publicTitle, latest.config?.browserTitle);
        setView({ title: title(), avatar: latest.avatar, config: latest.config, canvas: latest.canvas });
      };
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== location.origin || e.source !== window.parent) return;
        const m = e.data as { type?: string; state?: AppState; draft?: Draft };
        // 账本要先等语言包，草稿可能先到：账本到位后再套一次，不让已保存的布局盖掉草稿
        if (m?.type === PUBLIC_PREVIEW_DATA && m.state) void show(m.state).then(applyDraft);
        if (m?.type === PUBLIC_PREVIEW_DRAFT && m.draft) {
          latest = m.draft;
          applyDraft();
        }
      };
      // 预览里不跳走：页脚链接点了只会把 iframe 带离编辑页
      const onClick = (e: MouseEvent) => {
        if ((e.target as Element).closest?.('a')) e.preventDefault();
      };
      window.addEventListener('message', onMessage);
      document.addEventListener('click', onClick, true);
      window.parent.postMessage({ type: PUBLIC_PREVIEW_READY }, location.origin);
      return () => {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('click', onClick, true);
      };
    }
    fetch(appPath('/api/public'))
      .then(async (r) => {
        // 不是 JSON（代理错误页、静态页顶替）或不是账本：统一显示加载失败，不露出解析异常
        const body = (await r.json().catch(() => null)) as (AppState & { error?: string }) | null;
        if (!r.ok) throw new Error(body?.error ?? t('public.loadFailed'));
        if (!Array.isArray(body?.subscriptions) || !body.settings) throw new Error(t('public.loadFailed'));
        await show(body);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  return (
    <TooltipProvider delayDuration={80}>
      <MotionConfig reducedMotion="user" transition={{ type: 'tween', ease: 'easeOut', duration: 0.25 }}>
        {err ? (
          <Shell>
            <p className="py-24 text-center text-sm text-muted-foreground">{err}</p>
          </Shell>
        ) : state ? (
          <Ledger state={state} view={view} />
        ) : (
          <Shell>
            <Skeleton className="h-[560px] rounded-xl" />
          </Shell>
        )}
      </MotionConfig>
    </TooltipProvider>
  );
}

/** 没传 head 时不画页头（加载中、出错）：不先闪一下默认标题和头像 */
function Shell({ children, right, head }: { children: React.ReactNode; right?: React.ReactNode; head?: { title?: string; avatar?: string; bio?: string } }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-[max(env(safe-area-inset-top),1.25rem)] pb-12 sm:px-6 sm:pt-10">
      {head && (
        <header className="mb-5 sm:mb-6">
          <div className="flex items-center gap-3">
            <img src={appPath(avatarOf({ avatar: head.avatar }))} alt="" className="size-9 rounded-md object-cover" />
            <h1 className="min-w-0 flex-1 truncate text-[length:var(--fs-2)] font-semibold">{head.title}</h1>
            {right}
          </div>
          {head.bio && <p className="mt-3 text-[length:var(--fs-2)] break-words whitespace-pre-line text-muted-foreground">{head.bio}</p>}
        </header>
      )}
      {children}
    </div>
  );
}

function ThemeButton() {
  const [mode, cycle] = useThemeMode();
  return (
    <button
      type="button"
      title={t('public.theme.title', { mode: THEME_LABEL[mode] })}
      aria-label={t('public.theme.aria', { mode: THEME_LABEL[mode] })}
      // 预览和主人的应用同源，这里切换会改掉主人本机的主题
      onClick={previewing ? undefined : cycle}
      className="public-icon-btn"
    >
      <ThemeIcon mode={mode} size={16} />
    </button>
  );
}

function Ledger({ state, view }: { state: AppState; view: View }) {
  const base = state.settings.baseCurrency;
  const [ccy, setCcy] = useState<Ccy>(() => (base !== 'USD' && readStored('ledger:public-ccy') === 'USD' ? 'USD' : base));
  const today = todayIn(state.settings.timezone);
  const d = useMemo(() => derive(state, today), [state, today]);

  // 当前值按今天汇率换算；历史扣款按扣款当天汇率单独累计
  const k = (ccy as string) === base ? 1 : toBaseAt(state, 1, base, undefined, ccy);
  const sym = symbol(ccy);
  // 折算金额取整；不足 10 的保留分，免得出现 ¥0
  const fmt = (v: number) => money(v, ccy, { decimals: Math.abs(v) < 10 ? 2 : 0 });
  const diff = (d.mrr - d.yearAgoMrr) * k;
  // 时间线上的扣款：按日分组
  const loadTimeline = useCallback(
    (from: string, to: string) => {
      const map = new Map<string, TimelineGroup>();
      for (const c of allCharges(state, from, to, today)) {
        const g = map.get(c.date) ?? { date: c.date, items: [] };
        const v = chargeValue(state, c) * k;
        g.items.push({
          key: `${c.sub.id}-${c.date}-${g.items.length}`,
          icon: <AppIcon sub={c.sub} className="rounded-md bg-card" size={30} />,
          name: clean(c.sub.name),
          amount: `${flow(-c.amount, c.currency)}${c.currency !== ccy ? ` ≈ ${flow(-v, ccy, { decimals: Math.abs(v) < 10 ? 2 : 0 })}` : ''}`,
          value: chargeBaseOrNaN(state, c) * k,
        });
        map.set(c.date, g);
      }
      for (const g of map.values()) {
        const sum = g.items.reduce((s, it) => s + (it.value ?? 0), 0);
        g.total = Number.isFinite(sum) ? flow(-sum, ccy, { decimals: Math.abs(sum) < 10 ? 2 : 0 }) : undefined;
      }
      return [...map.values()];
    },
    [state, today, ccy, k],
  );

  const config = view.config;
  const parts = publicParts(config);
  const heroParts = [
    parts.has('stats') && (
            <CardContent key="stats" className="flex flex-col gap-6 @[976px]:flex-row @[976px]:items-end @[976px]:justify-between">
              <div>
                <div className="text-sm text-muted-foreground">{t('public.hero.monthly')}</div>
                <Num value={d.mrr * k} ccy={ccy} prefix={sym} className="mt-1 text-5xl font-semibold tracking-tight tnum sm:text-6xl" />
                <div className="mt-2 text-[length:var(--fs-2)] text-muted-foreground tnum">
                  {Math.abs(diff) < 1 ? t('public.hero.flat') : t(diff > 0 ? 'public.hero.more' : 'public.hero.less', { amount: fmt(Math.abs(diff)) })}
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-6 sm:gap-10">
                <Stat label={t('public.hero.yearly')} value={<Num value={d.mrr * 12 * k} ccy={ccy} prefix={sym} />} />
                {/* 与下方订阅列表「全部」同一组（含试用、暂停），标题也用列表的标题 */}
                <Stat label={t('public.list.title')} value={<Num value={d.live.length} />} />
                <Stat label={t('public.hero.paid', { year: d.first.slice(0, 4) })} value={<Num value={ccy === base ? d.paidBase : d.paidUsd} ccy={ccy} prefix={sym} />} />
              </dl>
            </CardContent>
    ),
    parts.has('timeline') && (
            <CardContent key="timeline">
              {/* 手机上标题与「接下来 30 天」上下排，不把说明挤成三行 */}
              <div className="mb-2 flex flex-col items-start gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3 sm:pr-16">
                <h2 className="font-medium">{t('public.timeline.title')}</h2>
                <span className="text-[length:var(--fs-2)] text-muted-foreground tnum">
                  {rich('public.timeline.upcoming', { count: d.upcoming.length }, { amount: <Num value={d.upcoming.reduce((a, c) => a + c.value, 0) * k} ccy={ccy} prefix={sym} className="text-foreground" /> })}
                </span>
              </div>
              <Timeline today={today} load={loadTimeline} start={firstStart(state, today)} />
            </CardContent>
    ),
    parts.has('chart') && (
            <Tabs key="chart" defaultValue="paid" className="gap-0">
              <CardHeader>
                <CardTitle className="text-sm">{t('public.chart.title')}</CardTitle>
                <CardDescription className="text-[length:var(--fs-2)]">{t('public.chart.desc')}</CardDescription>
                <CardAction>
                  <TabsList>
                    <TabsTrigger value="paid" className="px-2.5 text-xs">
                      {t('public.chart.paid')}
                    </TabsTrigger>
                    <TabsTrigger value="mrr" className="px-2.5 text-xs">
                      {t('public.chart.mrr')}
                    </TabsTrigger>
                  </TabsList>
                </CardAction>
              </CardHeader>
              <TabsContent value="paid" className="mt-4 px-2 sm:px-4">
                <PaidChart months={ccy === base ? d.monthsBase : d.monthsUsd} cur={today.slice(0, 7)} ccy={ccy} fmt={fmt} />
              </TabsContent>
              <TabsContent value="mrr" className="mt-4 px-2 sm:px-4">
                <MrrChart data={d.mrrTrend.map((p) => ({ ...p, mrr: p.mrr * k }))} ccy={ccy} fmt={fmt} />
              </TabsContent>
            </Tabs>
    ),
  ].filter(Boolean);
  // 没有内容的组件（没有退订、没有买断）不占位，同一行的其他卡片自动补满
  const blocks: Partial<Record<PublicGridId, React.ReactNode>> = {
    hero: heroParts.length > 0 && (
      <Card className={cn(roomy, 'h-full')}>
        {heroParts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <Separator />}
            {part}
          </Fragment>
        ))}
      </Card>
    ),
    composition: <Composition cats={d.cats} total={d.mrr} k={k} fmt={fmt} />,
    fx: <Currencies d={d} ccy={ccy} fmt={fmt} />,
    list: <SubList d={d} today={today} ccy={ccy} k={k} fmt={fmt} />,
    ended: d.ended.length > 0 && (
              <Card className={cn(roomy, 'h-full')}>
                <CardHeader>
                  <CardTitle>{t('public.ended.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="-my-1.5">
                    {d.ended.map((x) => (
                      <li key={x.sub.id} className="flex items-center gap-3 py-1.5">
                        <AppIcon sub={x.sub} className="size-7 rounded-md opacity-50 grayscale" />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{clean(x.sub.name)}{effectiveStatus(x.sub, today) === 'terminated' && <Badge variant="secondary" className="ml-2">{t('list.status.terminated')}</Badge>}</span>
                        <span className="text-right tnum">
                          <span className="text-[length:var(--fs-2)] text-muted-foreground line-through decoration-muted-foreground/50">{t('public.perMonth', { amount: fmt(x.monthly * k) })}</span>
                          <span className="ml-3 text-[length:var(--fs-2)] text-muted-foreground">{monthLabel(x.since.slice(0, 7))}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
    ),
    lifetime: d.lifetime.length > 0 && (
              <Card className={cn(roomy, 'h-full')}>
                <CardHeader>
                  <CardTitle>{t('public.lifetime.title')}</CardTitle>
                  <CardDescription>{t('public.lifetime.desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="-my-1.5">
                    {d.lifetime.map((s) => (
                      <li key={s.id} className="flex items-center gap-3 py-1.5">
                        <AppIcon sub={s} className="size-7 rounded-md" />
                        <span className="min-w-0 flex-1 truncate">{clean(s.name)}</span>
                        <span className="text-[length:var(--fs-2)] text-muted-foreground tnum">{s.start.slice(0, 4)}</span>
                        <span className="w-20 text-right tnum">{money(s.price, s.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
    ),
  };
  const grid = publicGrid(config);
  const flowCells = grid.filter((s) => !s.hidden && blocks[s.id]);
  const desktop = flowSpans(flowCells.map((s) => s.id));
  const tablet = fillRows(flowCells.map((s) => tabletSpan(PUBLIC_GRID_SECTIONS.find((d) => d.id === s.id)!.w)));
  const canvas = view.canvas;
  const sendLayout = (message: { sections?: ReturnType<typeof gridSections>; remove?: string }) => window.parent.postMessage({ type: PUBLIC_PREVIEW_LAYOUT, ...message }, location.origin);
  const fixed = (id: 'footer' | 'pile', node: React.ReactNode) =>
    canvas ? (
      <CanvasFixed label={canvas.labels[id]} text={canvas} onRemove={() => sendLayout({ remove: id })}>
        {node}
      </CanvasFixed>
    ) : (
      node
    );

  return (
    <Shell
      head={{ title: view.title, avatar: view.avatar, bio: config?.bio }}
      right={
        <div className="flex items-center gap-1.5">
          {base !== 'USD' && (
            <Tabs
              value={ccy}
              onValueChange={(v: string) => {
                setCcy(v);
                save(storageKey('ledger:public-ccy'), v);
              }}
            >
              <TabsList aria-label={t('public.currency')}>
                {[base, 'USD'].map((c) => (
                  <TabsTrigger key={c} value={c} className="px-2.5 text-xs">
                    {symbol(c).trim()} {c}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <ThemeButton />
        </div>
      }
    >
      {canvas ? (
        <Canvas config={config} blocks={blocks} text={canvas} onCommit={(items: PublicGridItem[]) => sendLayout({ sections: gridSections(items) })} onRemove={(id: string) => sendLayout({ remove: id })} />
      ) : isCustomLayout(config) ? (
        <div className="public-grid" data-free="">
          {collapseEmpty(grid, (id) => !blocks[id]).map((s) => (
            <div key={s.id} className="public-cell @container" style={cellVars(s)}>
              {blocks[s.id]}
            </div>
          ))}
        </div>
      ) : (
        <div className="public-grid">
          {flowCells.map((s, i) => (
            <div key={s.id} className="public-cell @container" style={{ '--span-md': tablet[i], '--span-lg': desktop[i] } as React.CSSProperties}>
              {blocks[s.id]}
            </div>
          ))}
        </div>
      )}

      {parts.has('footer') &&
        fixed(
          'footer',
          <footer className="mt-10 text-[length:var(--fs-2)] text-muted-foreground">
            <a href={PROJECT_URL} className="transition hover:text-foreground">
              {PROJECT_NAME} v{__APP_VERSION__}
            </a>
          </footer>,
        )}
      {/* 页脚下面的订阅堆：继续往下滑才会从屏幕顶端落下来；每个正在付费的订阅一个图标，越贵越大 */}
      {/* 抵消外层的底部留白（pb-12），让图标堆贴着页面最底部 */}
      {parts.has('pile') &&
        fixed(
          'pile',
          <div className="mt-6 -mb-12">
            <IconPile items={d.live.filter((x) => x.v > 0)} />
          </div>,
        )}
    </Shell>
  );
}

// ---------- 数据 ----------

type Derived = ReturnType<typeof derive>;

function derive(state: AppState, today: string) {
  syncCategories(state);
  const base = state.settings.baseCurrency;
  const first = firstStart(state, today);
  const past = allCharges(state, first, today, today);
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;

  const live = state.subscriptions
    .map((s) => ({ s, v: contributionOn(state, s, today) }))
    .filter((x) => ['active', 'ending', 'trial', 'paused'].includes(effectiveStatus(x.s, today)))
    .sort((a, b) => b.v - a.v);
  const mrr = live.reduce((a, x) => a + x.v, 0);
  const trend = mrrSeries(state, today, 25);

  // 先按分类表的顺序放好：筛选标签沿用这个顺序，构成图按金额排
  const cats = new Map<string, { v: number; n: number }>();
  for (const c of syncCategories(state)) if (live.some((x) => x.s.category === c.name)) cats.set(c.name, { v: 0, n: 0 });
  for (const x of live) {
    const c = cats.get(x.s.category) ?? { v: 0, n: 0 };
    c.v += x.v;
    c.n++;
    cats.set(x.s.category, c);
  }

  // 过去 12 个月 + 之后 3 个月的实际扣款
  const months = Array.from({ length: 15 }, (_, i) => {
    const m = addMonths(today.slice(0, 8) + '01', i - 11).slice(0, 7);
    const [a, b] = periodRange('month', `${m}-15`);
    const cs = allCharges(state, a, b, today);
    return { m, base: sumBase(state, cs), usd: sumBase(state, cs, 'USD') };
  });


  const upcoming = allCharges(state, addDays(today, 1), addDays(today, 30), today)
    .filter((c) => c.amount > 0 && c.kind !== 'refund' && c.kind !== 'failed')
    .map((c) => ({ ...c, value: chargeValue(state, c) }));

  const byCcy = new Map<string, { v: number }>();
  for (const x of live) {
    const c = currentPhase(x.s, today).currency;
    const e = byCcy.get(c) ?? { v: 0 };
    e.v += x.v;
    byCcy.set(c, e);
  }
  // 相对显示币种：外币一年涨跌，以及按一年前汇率每月要付多少（v 为本位币，先还原成原币）
  const fxFor = (to: string) => {
    const rows = [...byCcy.entries()]
      .filter(([c]) => c !== to)
      .sort((a, b) => b[1].v - a[1].v)
      .map(([c, e]) => {
        const now = toBaseAt(state, 1, c, undefined, to);
        const then = toBaseAt(state, 1, c, yearAgo, to);
        const native = e.v / (toBaseAt(state, 1, c, undefined, base) || 1);
        return { c, now, share: e.v / (mrr || 1), chg: then ? (now - then) / then : 0, effect: native * (now - then) };
      });
    return { rows, effect: rows.reduce((a, r) => a + r.effect, 0) };
  };

  const savings = cancelSavings(state, today);
  return {
    first,
    paidBase: sumBase(state, past),
    paidUsd: sumBase(state, past, 'USD'),
    live,
    mrr,
    yearAgoMrr: trend[trend.length - 13]?.mrr ?? mrr,
    mrrTrend: trend.map((p) => ({ month: p.month, mrr: p.mrr })),
    cats: [...cats.entries()].sort((a, b) => b[1].v - a[1].v),
    /** 筛选标签按分类表的顺序 */
    catTabs: [...cats.entries()],
    monthsBase: months.map((x) => ({ m: x.m, v: x.base })),
    monthsUsd: months.map((x) => ({ m: x.m, v: x.usd })),
    upcoming,
    fx: { [base]: fxFor(base), USD: fxFor('USD') } as Record<Ccy, ReturnType<typeof fxFor>>,
    // 退订：按退订时间新的在前；只给「原来每月多少」这种不随时间膨胀的数，不算「退订至今省了多少」
    ended: state.subscriptions.filter((s) => isStopped(effectiveStatus(s, today))).map((sub) => ({ sub, since: sub.stop?.date ?? sub.end ?? sub.start, monthly: savings.items.find((x) => x.sub.id === sub.id)?.monthly ?? toBaseOrNaN(state, monthlyGross(currentPhase(sub, sub.end ?? today), sub.end ?? today), sub.currency) * myShareFactor(sub, sub.end ?? today) })).sort((a, b) => b.since.localeCompare(a.since)),
    lifetime: state.subscriptions.filter((s) => s.cycle.unit === 'lifetime'),
  };
}

const monthTick = (m: string, cur: string) => (m === cur ? t('public.chart.thisMonth') : monthLabel(m, { year: false }));
const monthFull = (m: string) => monthLabel(m);


// ---------- 组件 ----------

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      {/* 窄屏放不下时折行，不截成「Paid since 2…」 */}
      <dt className="text-[length:var(--fs-2)] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tracking-tight tnum">{value}</dd>
    </div>
  );
}


function PaidChart({ months, cur, ccy, fmt }: { months: Array<{ m: string; v: number }>; cur: string; ccy: string; fmt: (v: number) => string }) {
  const paidConfig = { v: { label: t('public.chart.charge'), color: 'var(--c1)' } } satisfies ChartConfig;
  // barCategoryGap 是每一侧的留白：25% 正好让柱子占格宽的一半（--bar-ratio），写 50% 柱宽为 0、一根都不显示
  // 与 --bar-radius 同一断点：Recharts 的 radius 只收数字
  const radius = globalThis.matchMedia?.('(max-width: 700px)').matches ? 4 : 6;
  return (
    <ChartContainer config={paidConfig} className="aspect-auto h-52 w-full">
      <BarChart data={months} barCategoryGap="25%" margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <CartesianGrid strokeWidth={0.5} vertical={false} strokeDasharray="2 4" />
        <XAxis dataKey="m" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={6} tickFormatter={(m: string) => monthTick(m, cur)} />
        <YAxis tickLine={false} axisLine={false} width={44} tickCount={4} tickFormatter={(v: number) => moneyTick(v, ccy)} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideIndicator labelFormatter={(m) => (String(m) > cur ? copyParts(t('public.chart.projected', { month: monthFull(String(m)) })) : monthFull(String(m)))} formatter={(v) => <span className="font-medium tnum">{fmt(Number(v))}</span>} />}
        />
        <Bar dataKey="v" radius={[radius, radius, 0, 0]} maxBarSize={24}>
          {months.map((x) => (
            <Cell
              key={x.m}
              fill={x.m === cur ? 'var(--color-v)' : x.m > cur ? 'transparent' : 'color-mix(in srgb, var(--color-v) 70%, var(--card))'}
              stroke={x.m > cur ? 'var(--color-v)' : undefined}
              strokeWidth={0.5}
              strokeDasharray={x.m > cur ? '3 3' : undefined}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}


function MrrChart({ data, ccy, fmt }: { data: Array<{ month: string; mrr: number }>; ccy: string; fmt: (v: number) => string }) {
  const mrrConfig = { mrr: { label: t('public.chart.mrr'), color: 'var(--c1)' } } satisfies ChartConfig;
  return (
    <ChartContainer config={mrrConfig} className="aspect-auto h-52 w-full">
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="mrr-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-mrr)" stopOpacity={0.14} />
            <stop offset="100%" stopColor="var(--color-mrr)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeWidth={0.5} vertical={false} strokeDasharray="2 4" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={(m: string) => `${m.slice(2, 4)}/${Number(m.slice(5))}`} />
        <YAxis tickLine={false} axisLine={false} width={44} tickCount={4} tickFormatter={(v: number) => moneyTick(v, ccy)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(m) => monthFull(String(m))} formatter={(v) => <span className="font-medium tnum">{fmt(Number(v))}</span>} />} />
        <Area dataKey="mrr" type="stepAfter" stroke="var(--color-mrr)" strokeWidth={1.5} fill="url(#mrr-fill)" />
      </AreaChart>
    </ChartContainer>
  );
}

/** 构成：一条分段比例条 + 图例 */
function Composition({ cats, total, k, fmt }: { cats: Derived['cats']; total: number; k: number; fmt: (v: number) => string }) {
  const top: Array<{ name: string; v: number; n: number; other?: boolean }> = cats.slice(0, 4).map(([name, c]) => ({ name, v: c.v, n: c.n }));
  const rest = cats.slice(4);
  if (rest.length) top.push({ name: t('public.composition.other'), v: rest.reduce((a, [, c]) => a + c.v, 0), n: rest.reduce((a, [, c]) => a + c.n, 0), other: true });
  return (
    <Card className={cn(roomy, 'h-full')}>
      <CardHeader>
        <CardTitle>{t('public.composition.title')}</CardTitle>
        <CardDescription>{t('public.composition.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {top.map((x, i) => (
            <motion.i
              key={x.name}
              className="block h-full min-w-1"
              style={{ background: shade(i), flexGrow: x.v, originX: 0 }}
              initial={false}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            />
          ))}
        </div>
        <ul className="mt-5 space-y-2.5">
          {top.map((x, i) => (
            <li key={x.name} className="flex items-center gap-2.5">
              <i className="size-2.5 rounded-md" style={{ background: shade(i) }} />
              <span className="flex flex-1 items-center gap-1.5">
                {!x.other && <CatGlyph icon={catIcon(x.name)} size={14} className="size-3.5 text-muted-foreground" />}
                {copyParts(x.name)} <span className="text-[length:var(--fs-2)] text-muted-foreground">{t('public.count', { count: x.n })}</span>
              </span>
              <span className="tnum">{fmt(x.v * k)}</span>
              <span className="w-10 text-right text-[length:var(--fs-2)] text-muted-foreground tnum">{Math.round((x.v / (total || 1)) * 100)}%</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** 汇率：外币占比与一年变化 */
/** 占比条的灰阶：第一名最深，依次变浅（构成与汇率两张卡共用） */
const shade = (i: number) => `var(--c${[1, 4, 5, 6, 7][i] ?? 9})`;

function Currencies({ d, ccy, fmt }: { d: Derived; ccy: Ccy; fmt: (v: number) => string }) {
  const { rows, effect: eff } = d.fx[ccy];
  return (
    <Card className={cn(roomy, 'h-full')}>
      <CardHeader>
        <CardTitle>{t('public.fx.title')}</CardTitle>
        <CardDescription>
          {Math.abs(eff) < 1 ? (
            t('public.fx.flat')
          ) : (
            <>{rich(eff < 0 ? 'public.fx.less' : 'public.fx.more', {}, { amount: <span className="font-medium text-foreground tnum">{fmt(Math.abs(eff))}</span> })}</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* 和「构成」卡一样，顶部一条按各币种花费占比分段的条 */}
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {rows.map((f, i) => (
            <motion.i
              key={f.c}
              className="block h-full min-w-1"
              style={{ background: shade(i), flexGrow: f.share, originX: 0 }}
              initial={false}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            />
          ))}
        </div>
        <ul className="mt-5 space-y-2.5">
          {rows.map(({ now, ...f }, i) => {
            return (
              <li key={f.c} className="flex items-center gap-2.5">
                <i className="size-2.5 shrink-0 rounded-md" style={{ background: shade(i) }} />
                <span className="w-12 shrink-0 text-xs font-medium">
                  {f.c}
                </span>
                <span className="flex-1 text-[length:var(--fs-2)] text-muted-foreground tnum">
                  1 {f.c} = {now < 0.1 ? now.toFixed(4) : now.toFixed(3)} {ccy}
                </span>
                <span className="text-[length:var(--fs-2)] text-muted-foreground tnum">{t('public.fx.share', { pct: Math.round(f.share * 100) })}</span>
                <span className={cn('w-14 text-right tnum', Math.abs(f.chg) < 0.005 ? 'text-muted-foreground' : f.chg > 0 ? 'text-up' : 'text-down')}>
                  {f.chg > 0 ? '↑' : f.chg < 0 ? '↓' : ''}
                  {Math.abs(f.chg * 100).toFixed(1)}%
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function SubList({ d, today, ccy, k, fmt }: { d: Derived; today: string; ccy: Ccy; k: number; fmt: (v: number) => string }) {
  // 空字符串代表「全部」，避免和名为「全部」的分类撞车
  const [tab, setTab] = useState('');
  const rows = tab === '' ? d.live : d.live.filter((x) => x.s.category === tab);
  const tabs = [['', d.live.length] as const, ...d.catTabs.map(([c, x]) => [c, x.n] as const)];
  return (
    <Card className={cn(roomy, 'h-full')}>
      <CardHeader>
        <CardTitle>{t('public.list.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="-mx-1 mb-2 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]">
          <div className="flex w-max gap-1.5">
            {tabs.map(([c, n]) => (
              <button
                key={c || '*'}
                type="button"
                onClick={() => setTab(c)}
                aria-pressed={tab === c}
                className={cn('public-filter-btn relative rounded-md px-3 text-xs font-medium transition-colors', tab === c ? 'text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
              >
                {tab === c && <motion.span layoutId="cat-pill" className="absolute inset-0 rounded-md bg-primary" transition={{ type: 'tween', ease: 'easeOut', duration: 0.25 }} />}
                <span className="relative flex items-center gap-1">
                  {c && <CatGlyph icon={catIcon(c)} size={13} className="size-[13px]" />}
                  {c || t('public.list.all')} <span className="opacity-60 tnum">{n}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <ul className="grid gap-x-10 @[720px]:grid-cols-2">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map(({ s, v }) => (
              <motion.li key={s.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }} className="border-b-[0.5px] border-border/60">
                <Row s={s} v={v} today={today} ccy={ccy} k={k} fmt={fmt} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </CardContent>
    </Card>
  );
}

function Row({ s, v, today, ccy, k, fmt }: { s: Subscription; v: number; today: string; ccy: Ccy; k: number; fmt: (v: number) => string }) {
  const ph = currentPhase(s, today);
  const status = effectiveStatus(s, today);
  const ending = ['ending', 'ended', 'terminated'].includes(status);
  const end = ph.stop?.date ?? ph.end ?? s.stop?.date ?? s.end;
  const n = ending ? undefined : nextCharge(s, today);
  const soon = n !== undefined && diffDays(today, n) <= 7;
  const monthly = ph.currency === ccy && ph.cycle.unit === 'month' && ph.cycle.every === 1;
  const repeatsPrice = monthly && Math.abs(v * k - ph.price) < 0.005;
  return (
    <div className="flex items-center gap-3 py-3">
      <AppIcon sub={s} className="size-9 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{clean(s.name)}</span>
          {['trial', 'paused', 'ending'].includes(status) && <Badge variant="secondary" className="text-[length:var(--fs-1)]">{t(`list.status.${status}`)}</Badge>}
          {ph.region && (
            <span className="shrink-0 text-[length:var(--fs-1)] text-muted-foreground">
              {ph.region}
            </span>
          )}
        </div>
        <div className="truncate text-[length:var(--fs-2)] text-muted-foreground tnum">
          {cycleLabel(ph.cycle)}{!repeatsPrice && ` ${money(ph.price, ph.currency)}`}
          {ending && end ? <span>{copyParts(t('public.row.ends', { date: cnDate(end) }))}</span> : n && <span className={cn(soon && 'text-foreground')}>{copyParts(t('public.row.renews', { date: cnDate(n) }))}</span>}
        </div>
      </div>
      <div className="text-right tnum">
        <div className="font-medium">{fmt(v * k)}</div>
        {/* 每月扣的左边已写「每月」，右边不再重复；其他周期写明是折合每月 */}
        {!monthly && <div className="text-[length:var(--fs-2)] text-muted-foreground">{t('public.row.perMonthEq')}</div>}
      </div>
    </div>
  );
}

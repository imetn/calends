import { formatTotal, scaleTotal, sumTotals } from '../../../shared/fx-total.ts';
import { monthlyTotal } from '../../../shared/billing.ts';
import { isMarked, nextSort } from '../components/LtHead.tsx';
import { copyParts } from '../components/copy.tsx';
import { StopBadge, StopText, stopDescription, stopLabel } from '../components/StopPanel.tsx';
import { base } from '../base.ts';
import { useEffect, useState } from 'react';
import {
  activePhases,
  addDays,
  currentPhase,
  diffDays,
  effectiveStatus,
  monthlyMine,
  nextCharge,
  priceAt,
  upcomingPhase,
  isStopped,
} from '../../../shared/billing.ts';
import { cnDate, money, relDays } from '../../../shared/format.ts';
import { toBaseOrNaN } from '../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { IconButton, Toolbar } from '../components/ui.tsx';
import { Amount, Seg } from '../components/inputs.tsx';
import { CatChip, CatIcon, MethodMark, PayBadge, RegionTag, FlagImg, regionLabel, subRegion, SubIcon } from '../components/marks.tsx';
import { Icon } from '../components/icons.tsx';
import { proxyOwed } from './proxy/common.tsx';
import { locale, t } from '../../../shared/i18n.ts';
import { tx } from '../i18n.ts';
import { catColor, categories, isDomainCat, subImage, toBase } from '../derive.ts';
import { useIconTint } from '../iconTint.ts';
import { useOrig } from '../display.ts';
import { Gantt } from './Gantt.tsx';
import { perLabel } from './Overview.tsx';
import { SortControl } from '../components/SortControl.tsx';
import { usePref } from '../prefs.ts';
import { scopeReport } from '../../../shared/scope-report.ts';
import { ScopeReport } from '../components/ScopeReport.tsx';
import { useTextSearch } from '../use-search.ts';
import { inListScope, listHaystack, listMethod, listStatus, listWords, type ListFacet, type ListStatus } from '../../../shared/list-scope.ts';

type Filter = ListStatus;
type Sort = 'next' | 'cost' | 'name' | 'category' | 'method' | 'amount' | 'start';
type Dir = 'asc' | 'desc';
/** 各排序的默认方向：最近扣款在前、最贵在前、名称 A→Z、分类按设置里的顺序、最新开始在前 */
const DEFAULT_DIR: Record<Sort, Dir> = { next: 'asc', cost: 'desc', name: 'asc', category: 'asc', method: 'asc', amount: 'desc', start: 'desc' };
type View = 'grid' | 'list' | 'gantt';
const isSort = (v: string): v is Sort => ['next', 'cost', 'name', 'category', 'method', 'amount', 'start'].includes(v);
const isDir = (v: string): v is Dir => v === 'asc' || v === 'desc';
const isView = (v: string): v is View => ['grid', 'list', 'gantt'].includes(v);

const FILTERS = (): Array<[Filter, string]> => [
  ['all', t('list.all')],
  ['live', t('list.status.active')],
  ['upcoming', t('list.status.upcoming')],
  ['trial', t('list.status.trialShort')],
  ['paused', t('list.status.paused')],
  ['lifetime', t('list.status.lifetime')],
  ['ended', t('list.status.ended')],
  ['terminated', t('list.status.terminated')],
];

export function List({
  state,
  today,
  onOpen,
  onAdd,
  category,
}: {
  state: AppState;
  today: string;
  onOpen: (s: Subscription) => void;
  onAdd: () => void;
  category?: string;
}) {
  // 全部订阅页的状态筛选记在服务端；分类页默认看全部状态，只在本页有效
  const [savedFilter, setSavedFilter] = usePref<Filter>('list-status', 'all', (v): v is Filter => FILTERS().some(([k]) => k === v));
  const [catFilter, setCatFilter] = useState<Filter>('all');
  const filter = category ? catFilter : savedFilter;
  const setFilter = (v: Filter) => (category ? setCatFilter(v) : setSavedFilter(v));
  const [cat, setCat] = useState<string>(category ?? 'all');
  const [pay, setPay] = useState<string>('all');
  const [q, setQ] = useState('');
  useEffect(() => setCat(category ?? 'all'), [category]);
  // 排序、方向、视图存在服务端，多台设备一致；切换到另一种排序时用它的默认方向，再点同一种则反转
  const [sort, setSort] = usePref<Sort>('list-sort', 'next', isSort);
  const [dir, setDir] = usePref<Dir>('list-dir', DEFAULT_DIR[sort], isDir);
  const chooseSort = (k: Sort) => {
    setSort(k);
    setDir(DEFAULT_DIR[k]);
  };
  // 表头三态：该列默认方向、反向、回到默认（按下次扣款）；默认排序不标箭头，与合租、代付、人员表一致
  const toggleSort = (k: Sort) => {
    const [ns, nd] = nextSort(k, sort, dir, DEFAULT_DIR, 'next');
    setSort(ns);
    setDir(nd);
  };
  const marked = (k: Sort) => isMarked(k, sort, dir, ['next', DEFAULT_DIR.next]);
  const [view, setView] = usePref<View>('list-view', 'grid', isView);
  // 金额显示：原币，或折算成侧边栏选的货币（大字为折算后，小字为原币）
  const orig = useOrig();
  const money2 = orig ? 'orig' : state.settings.baseCurrency;
  // 显示今天生效的那一段：下次扣款落在下一段时，金额仍按当前这段，变更另起一行提示
  const shown = (s: Subscription, n?: string): { value: number; ccy: string; sub?: string } => {
    const cur = currentPhase(s, today);
    s = cur;
    if (n && cur.end && n >= cur.end) n = undefined;
    const price = n ? priceAt(s, n) : s.price;
    const live = !['lifetime', 'ended', 'terminated'].includes(effectiveStatus(s, today));
    if (money2 === 'orig' || s.currency === money2) {
      return {
        value: price,
        ccy: s.currency,
        sub: s.proxy
          ? t('list.proxyExcluded')
          : live && (s.currency !== base || s.cycle.unit !== 'month' || s.cycle.every !== 1)
            ? t('list.perMonthApprox', { amount: money(mo(s), base, { compact: true }) })
            : undefined,
      }; // 外币或不是按月付的，都折成每月多少
    }
    return { value: toBaseOrNaN(state, price, s.currency, undefined, money2), ccy: money2, sub: t('list.originalPrice', { amount: money(price, s.currency) }) };
  };
  const base = state.settings.baseCurrency;

  // 多维筛选：状态、分类、支付方式；每个选项的数字按「其他维度已选条件」计算
  // 代付是替别人付的，不进「全部订阅」，在「代付」页单独管
  const mine = state.subscriptions.filter((s) => !s.proxy);
  const payOf = (s: Subscription) => listMethod(s, today);
  // 搜索也是一个筛选条件：名称、分类、标签、备注、地区、支付方式、网址都能搜，各维度的计数随之变化
  const words = listWords(q);
  const methodName = new Map(state.methods.map((m) => [m.id, m.name]));
  const matches = useTextSearch(mine.map((s) => listHaystack(state, s, today)));
  // 与 MCP scope_report 共用 shared/list-scope.ts 的判定；网页额外支持拼音
  const scope = { status: filter, category: cat === 'all' ? undefined : cat, method: pay === 'all' ? undefined : pay, words };
  const hit = (s: Subscription, skip?: ListFacet) => inListScope(state, s, today, scope, skip, matches);
  const match = (s: Subscription) => hit(s);
  const facet = <K extends string>(skip: ListFacet, key: (s: Subscription) => K) => {
    const n = new Map<string, number>();
    let all = 0;
    for (const s of mine) {
      if (!hit(s, skip)) continue;
      all++;
      n.set(key(s), (n.get(key(s)) ?? 0) + 1);
    }
    n.set('all', all);
    return n;
  };
  const statusN = facet('status', (s) => listStatus(s, today));
  const catN = facet('cat', (s) => s.category);
  const payN = facet('pay', payOf);
  // 按分类表的顺序（设置里可拖动调整）
  const cats = categories()
    .map((c) => c.name)
    .filter((c) => mine.some((s) => s.category === c));
  const dirty = filter !== 'all' || cat !== (category ?? 'all') || pay !== 'all' || !!q;
  const mo = (s: Subscription) => monthlyMine(state, s, today);
  const catOrder = categories().map((c) => c.name);
  const catRank = (s: Subscription) => {
    const i = catOrder.indexOf(s.category);
    return i < 0 ? catOrder.length : i;
  };
  // 金额列显示的是「当前阶段、下次扣款日的价格」折算后的值，排序也用同一个数
  const amountOf = (s: Subscription) => {
    const cur = currentPhase(s, today);
    const n = nextCharge(s, addDays(today, 1));
    const price = n && !(cur.end && n >= cur.end) ? priceAt(cur, n) : cur.price;
    return toBase(state, price, cur.currency);
  };
  // 排序时缺汇率（NaN）按 0 比较，与显示无关，保持原有顺序
  const n0 = (v: number) => (Number.isFinite(v) ? v : 0);
  // 先按升序比较，再按方向翻转；没有下次扣款的始终排在最后
  const asc = (a: Subscription, b: Subscription) => {
    if (sort === 'name') return a.name.localeCompare(b.name, locale());
    // 分类按设置里的顺序，同类里最贵的在前
    if (sort === 'category') return catRank(a) - catRank(b) || n0(mo(b)) - n0(mo(a)) || a.name.localeCompare(b.name, locale());
    if (sort === 'cost') return n0(mo(a)) - n0(mo(b)) || n0(toBase(state, a.price, a.currency)) - n0(toBase(state, b.price, b.currency));
    // 支付方式按设置里的顺序，未指定的排最后
    if (sort === 'method') {
      const rank = (s: Subscription) => {
        const i = state.methods.findIndex((m) => m.id === payOf(s));
        return i < 0 ? state.methods.length : i;
      };
      return rank(a) - rank(b) || a.name.localeCompare(b.name, locale());
    }
    // 金额按列里显示的那个数（当前阶段、下次扣款日的价格）折算成本位币，跨币种才比得准
    if (sort === 'amount') return n0(amountOf(a)) - n0(amountOf(b));
    if (sort === 'start') return a.start.localeCompare(b.start);
    return (nextCharge(a, addDays(today, 1)) ?? '').localeCompare(nextCharge(b, addDays(today, 1)) ?? '');
  };
  const rows = mine.filter(match).sort((a, b) => {
    if (sort === 'next') {
      const na = nextCharge(a, addDays(today, 1));
      const nb = nextCharge(b, addDays(today, 1));
      if (!na || !nb) return na ? -1 : nb ? 1 : 0;
    }
    return dir === 'asc' ? asc(a, b) : asc(b, a);
  });
  const sum = sumTotals(rows.filter((s) => !isStopped(effectiveStatus(s, today))).map((s) => monthlyTotal(state, s, today)));
  // 只按筛选范围识别报告，排序、视图及时间轴窗口不影响报告。
  const reportKey = JSON.stringify([category ?? null, filter, cat, pay, words.join(' ')]);
  const [reportPref] = usePref<string>('list-report', '');
  const reportVisible = dirty && rows.length > 0 && readReportPref(reportPref, reportKey)?.open;
  const reportScope = [
    cat !== 'all' && cat,
    filter !== 'all' && filter !== 'live' && FILTERS().find(([k]) => k === filter)?.[1],
    pay !== 'all' && (pay === 'none' ? t('list.unassigned') : methodName.get(pay)),
    q.trim() && t('scope.search', { query: q.trim().replace(/\s+/g, ' ') }),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      <Toolbar
        title={category ?? t('list.title')}
        sub={
          reportVisible
            ? undefined
            : t('list.summary', {
                count: rows.length,
                monthly: formatTotal(sum, base, { direction: -1, compact: true }),
                yearly: formatTotal(scaleTotal(sum, 12), base, { direction: -1, compact: true }),
              })
        }
      >
        <label className="tb-search">
          <Icon name="search" />
          <input
            type="search"
            value={q}
            placeholder={t('list.search')}
            aria-label={t('list.search')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))}
          />
          {q && (
            <IconButton type="button" className="tb-search-x" onClick={() => setQ('')} aria-label={t('common.clear')}>
              <Icon name="x" size={15} />
            </IconButton>
          )}
        </label>
        {/* 三种视图顶部一致；列表视图另可点表头排序，两处共用同一排序状态 */}
        <SortControl
          value={sort}
          dir={dir}
          onSort={chooseSort}
          onDir={setDir}
          options={[
            { value: 'next', label: t('list.sort.next') },
            { value: 'cost', label: t('list.sort.cost') },
            { value: 'amount', label: t('list.sort.amount') },
            { value: 'name', label: t('list.sort.name') },
            { value: 'category', label: t('list.sort.category') },
            { value: 'method', label: t('list.sort.method') },
            { value: 'start', label: t('list.sort.start') },
          ]}
        />
        {!state.readonly && (
          <IconButton className="accent d-only page-add" onClick={onAdd} aria-label={t('list.add')}>
            <Icon name="plus" />
          </IconButton>
        )}
        {/* 视图切换固定在右上角最后一个，各页一致 */}
        <Seg
          small
          value={view}
          onChange={setView}
          options={[
            ['grid', t('list.view.grid')],
            ['list', t('list.view.list')],
            ['gantt', t('list.view.gantt')],
          ]}
        />
      </Toolbar>
      <div className="page fade-in">
        <div className="facets">
          {dirty && (
            <button
              className="facet-clear"
              onClick={() => {
                setFilter('all');
                setCat(category ?? 'all');
                setPay('all');
                setQ('');
              }}
            >
              <Icon name="x" size={12} />
              {t('list.clear')}
            </button>
          )}
          <FacetRow
            label={t('list.facet.status')}
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={FILTERS().map(([k, l]) => ({ key: k, label: l, n: statusN.get(k) ?? 0 }))}
          />
          <FacetRow
            label={t('list.facet.category')}
            value={cat}
            onChange={setCat}
            options={[
              { key: 'all', label: t('list.all'), n: catN.get('all') ?? 0 },
              ...cats.map((c) => ({ key: c, label: c, icon: <CatIcon cat={c} size={13} />, n: catN.get(c) ?? 0 })),
            ]}
          />
          <FacetRow
            label={t('list.facet.pay')}
            value={pay}
            onChange={setPay}
            options={[
              { key: 'all', label: t('list.all'), n: payN.get('all') ?? 0 },
              ...state.methods.map((m) => ({ key: m.id, label: m.name, icon: <MethodMark m={m} size={16} />, n: payN.get(m.id) ?? 0 })),
              { key: 'none', label: t('list.unassigned'), n: payN.get('none') ?? 0 },
            ]}
          />
        </div>
        {rows.length === 0 && <div className="empty">{t('list.empty')}</div>}
        {view === 'gantt' ? (
          rows.length > 0 && <Gantt rows={rows} state={state} today={today} onOpen={onOpen} />
        ) : view === 'grid' ? (
          <div className="sgrid">
            {rows.map((s) => {
              const st = effectiveStatus(s, today);
              const n = nextCharge(s, addDays(today, 1));
              const d = n ? diffDays(today, n) : undefined;
              const v = shown(s, n);
              const cur = currentPhase(s, today);
              const up = upcomingPhase(s, today);
              const m = state.methods.find((x) => x.id === cur.methodId);
              return (
                <button key={s.id} className={`scard st-${st}`} onClick={() => onOpen(s)}>
                  <CardGlow sub={s} />
                  <div className="sc-top">
                    <SubIcon sub={s} size={48} />
                    <span className="sc-flags">
                      {/* 右上角放状态与标识：地区只显示国旗，待生效变更与并行只显示短标签，详情在提示里 */}
                      {subRegion(cur, m) && (
                        <span className="sc-region" title={regionLabel(subRegion(cur, m)!)}>
                          <FlagImg cc={subRegion(cur, m)} />
                        </span>
                      )}
                      {up && (
                        <span className="badge blue" title={changeSummary(cur, up, st, today, state).full}>
                          {changeSummary(cur, up, st, today, state).short}
                        </span>
                      )}
                      {parallelSummary(s, cur, today) && (
                        <span className="badge" title={parallelSummary(s, cur, today)}>
                          {t('list.badge.parallel')}
                        </span>
                      )}
                      <SubBadges state={state} s={s} today={today}>
                        <StopBadge sub={s} today={today} />
                      </SubBadges>
                    </span>
                  </div>
                  <div className="sc-name">
                    <span>{s.name}</span>
                    {s.intro && s.intro.until > today && <Icon name="leaf" size={13} />}
                  </div>
                  <div className="sc-meta">
                    <CatChip cat={s.category} />
                    <PayBadge m={m} />
                  </div>
                  <div className="sc-price">
                    <Amount plain value={v.value} ccy={v.ccy} />
                    <span className="sc-per">/{perLabel(cur)}</span>
                  </div>
                  <div className="sc-foot">
                    <span>{v.sub ?? '\u00a0'}</span>
                    <span className={d != null && d <= 3 ? 'soon' : ''}>
                      {st === 'lifetime' ? s.start.slice(0, 7) : isStopped(st) ? (s.end ?? '') : n ? (d! <= 14 ? relDays(d!) : cnDate(n)) : ''}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="ltable-wrap">
            <div className="ltable" role="table">
              <div className="lt-row lt-head table-head" role="row">
                {(
                  [
                    ['name', t('list.col.name')],
                    ['category', t('list.col.category')],
                    ['method', t('list.col.method')],
                    ['amount', t('list.col.amount')],
                    ['cost', t('list.col.monthly')],
                    ['start', t('list.col.start')],
                    ['next', t('list.col.next')],
                  ] as Array<[Sort, string]>
                ).map(([k, l]) => (
                  // 每列都可排序；只有正在排序（且不是默认的按下次扣款）的那一列带单支箭头
                  <button
                    key={k}
                    className={`lt-sort ${marked(k) ? 'on' : ''}`}
                    onClick={() => toggleSort(k)}
                    aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={t(`list.sort.${k}`)}
                  >
                    {l}
                    {marked(k) && <Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />}
                  </button>
                ))}
              </div>
              {rows.map((s) => {
                const st = effectiveStatus(s, today);
                const n = nextCharge(s, addDays(today, 1));
                const d = n ? diffDays(today, n) : undefined;
                const cur = currentPhase(s, today);
                const up = upcomingPhase(s, today);
                const m = state.methods.find((x) => x.id === cur.methodId);
                const v = shown(s, n);
                const live = !['lifetime', 'ended', 'terminated'].includes(st);
                return (
                  <button key={s.id} className={`lt-row st-${st}`} role="row" onClick={() => onOpen(s)}>
                    <span className="lt-name">
                      <SubIcon sub={s} size={32} />
                      <span className="lt-title">
                        <span className="nm">
                          <b>{s.name}</b>
                          {s.intro && s.intro.until > today && <Icon name="leaf" size={13} />}
                          <RegionTag
                            cc={subRegion(
                              cur,
                              state.methods.find((x) => x.id === cur.methodId),
                            )}
                          />
                          <SubBadges state={state} s={s} today={today} />
                        </span>
                        {/* 退款情况单独一行，窄屏不挤掉名称 */}
                        {!state.readonly && stopLabel(cur, today) && (
                          <small className="lt-stop" title={stopDescription(cur, today)}>
                            <StopText sub={cur} today={today} />
                          </small>
                        )}
                        {up && <ChangeNote cur={cur} up={up} st={st} today={today} state={state} />}
                        <ParallelNote sub={s} cur={cur} today={today} />
                      </span>
                    </span>
                    <span className="lt-cat">
                      <CatChip cat={s.category} />
                    </span>
                    <span className="lt-pay">
                      <PayBadge m={m} />
                    </span>
                    <span className="lt-amt">
                      <span>
                        <Amount plain value={v.value} ccy={v.ccy} />
                        <small>/{perLabel(cur)}</small>
                      </span>
                      {money2 !== 'orig' && s.currency !== money2 && <small>{v.sub}</small>}
                    </span>
                    <span className="lt-mo">
                      {s.proxy ? (
                        <small>{t('list.notCounted')}</small>
                      ) : live ? (
                        cur.cycle.unit === 'month' && cur.cycle.every === 1 && v.ccy === base && Math.abs(mo(s) - v.value) < 0.005 ? (
                          <small>{t('list.monthlySame')}</small>
                        ) : (
                          money(mo(s), base, { compact: true })
                        )
                      ) : (
                        '—'
                      )}
                    </span>
                    <span className="lt-start">
                      {cnDate(s.start)}
                      <small>{s.start.slice(0, 4)}</small>
                    </span>
                    <span className={`lt-next ${d != null && d <= 3 ? 'soon' : ''}`}>
                      {st === 'lifetime' ? (
                        t('list.status.lifetime')
                      ) : isStopped(st) ? (
                        <>{tx('list.endedOn', { date: <small>{s.end ?? '—'}</small> })}</>
                      ) : n ? (
                        <>
                          {cnDate(n)}
                          <small>{relDays(d!)}</small>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {dirty && rows.length > 0 && (
          <ListReport
            key={reportKey}
            reportKey={reportKey}
            state={state}
            rows={rows}
            today={today}
            onOpen={onOpen}
            // 有搜索词时标题就是「DMIT 相关订阅」，订阅数在报告首卡里
            title={q.trim() ? reportScope : t('scope.selectionTitle', { scope: reportScope || FILTERS().find(([k]) => k === filter)![1], count: rows.length })}
          />
        )}
      </div>
    </>
  );
}

/** 换范围时重置本次生成动画；匹配服务端偏好时直接恢复报告及折叠状态。 */
function ListReport({
  reportKey,
  state,
  rows,
  today,
  onOpen,
  title,
}: {
  reportKey: string;
  state: AppState;
  rows: Subscription[];
  today: string;
  onOpen: (s: Subscription) => void;
  title: string;
}) {
  const [pref, setPref] = usePref<string>('list-report', '');
  const [animate, setAnimate] = useState(false);
  const saved = readReportPref(pref, reportKey);
  return (
    <div className="list-report">
      {saved ? (
        <ScopeReport
          report={scopeReport(state, rows, today)}
          state={state}
          today={today}
          onOpen={onOpen}
          title={title}
          animate={animate}
          open={saved.open}
          onToggle={() => {
            setAnimate(false);
            setPref(JSON.stringify({ key: reportKey, open: !saved.open }));
          }}
        />
      ) : (
        <button
          type="button"
          className="scope-trigger"
          onClick={() => {
            setAnimate(true);
            setPref(JSON.stringify({ key: reportKey, open: true }));
          }}
        >
          {t('scope.generate')}
        </button>
      )}
    </div>
  );
}

function readReportPref(pref: string, key: string): { key: string; open: boolean } | undefined {
  try {
    const value = JSON.parse(pref);
    if (value && value.key === key && typeof value.open === 'boolean') return value;
  } catch {
    // 未生成或旧偏好损坏时保留生成入口。
  }
}

/** 待生效变更的简短说明（卡片右上角标签）与完整说明（悬停提示），和 ChangeNote 同一口径 */
function changeSummary(cur: Subscription, up: Subscription, st: string, today: string, state: AppState) {
  const d = diffDays(today, up.start);
  const when = d <= 14 ? relDays(d) : cnDate(up.start);
  const m = state.methods.find((x) => x.id === up.methodId);
  const short = t(st === 'upcoming' ? 'list.change.starts' : 'list.change.from', { when });
  const parts = [
    up.planned ? t('list.change.planned').trim() : '',
    short,
    up.region && up.region !== cur.region ? up.region : '',
    st === 'upcoming' || up.price !== cur.price || up.currency !== cur.currency ? `${money(up.price, up.currency)}/${perLabel(up)}` : '',
    up.methodId !== cur.methodId || st === 'upcoming' ? (m ? m.name : t('list.change.noMethod')) : '',
  ].filter(Boolean);
  return { short, full: parts.join('\n') };
}

/** 换区后旧的那段还在付：卡片右上角只标「并行」，详细放在提示里 */
function parallelSummary(sub: Subscription, cur: Subscription, today: string): string {
  if (!sub.phases?.length) return '';
  return activePhases(sub, today)
    .filter((v) => v.start !== cur.start)
    .map((v) =>
      t('list.overlap.note', { what: v.region && v.region !== cur.region ? v.region : `${money(v.price, v.currency)}/${perLabel(v)}`, date: cnDate(v.end!) }),
    )
    .join('\n');
}

/** 待生效变更的一行提示：「10月27日起 🇺🇸 $9.99/月 · 支付方式」，未来才开始的订阅写「10月27日开始」 */
function ChangeNote({ cur, up, st, today, state }: { cur: Subscription; up: Subscription; st: string; today: string; state: AppState }) {
  const d = diffDays(today, up.start);
  const when = d <= 14 ? relDays(d) : cnDate(up.start);
  const m = state.methods.find((x) => x.id === up.methodId);
  const parts = [
    up.region && up.region !== cur.region ? up.region : '',
    st === 'upcoming' || up.price !== cur.price || up.currency !== cur.currency ? `${money(up.price, up.currency)}/${perLabel(up)}` : '',
    up.methodId !== cur.methodId || st === 'upcoming' ? (m ? m.name : t('list.change.noMethod')) : '',
  ].filter(Boolean);
  return (
    <div className="change-note">
      <Icon name="right" size={12} />
      <span>
        {copyParts(up.planned ? t('list.change.planned') : '')}
        {t(st === 'upcoming' ? 'list.change.starts' : 'list.change.from', { when })}
        {copyParts(parts.length ? `\n${parts.join('\n')}` : '')}
      </span>
    </div>
  );
}

/** 换区后旧的那段还没到期、两边都在付钱：标出它是哪一段、用到哪天 */
function ParallelNote({ sub, cur, today }: { sub: Subscription; cur: Subscription; today: string }) {
  if (!sub.phases?.length) return null;
  const vs = activePhases(sub, today).filter((v) => v.start !== cur.start);
  if (!vs.length) return null;
  return (
    <div className="change-note parallel">
      <Icon name="copy" size={12} />
      <span>
        {copyParts(
          vs
            .map((v) =>
              t('list.overlap.note', {
                what: v.region && v.region !== cur.region ? v.region : `${money(v.price, v.currency)}/${perLabel(v)}`,
                date: cnDate(v.end!),
              }),
            )
            .join('\n'),
        )}
      </span>
    </div>
  );
}

/** 只在代付仍有待收时显示状态角标。 */
function ProxyBadge({ state, s, today }: { state: AppState; s: Subscription; today: string }) {
  const n = proxyOwed(state, s, today);
  const name = s.proxy?.forName;
  if (!n) return null;
  const key = `list.proxyBadge.owed${name ? 'For' : ''}`;
  return (
    <span className="badge orange" title={s.proxy?.note}>
      {t(key, { count: n, name })}
    </span>
  );
}

/** 一行筛选：左边维度名，右边「全部」+ 各选项胶囊（数量在胶囊内；没有匹配的隐藏，已选中的保留）；再点已选中的回到「全部」，一行放不下时横向滑动 */
function FacetRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ key: string; label: string; n: number; icon?: React.ReactNode }>;
}) {
  return (
    <div className="facet-row">
      <span className="facet-label">{label}</span>
      <div className="facet-opts">
        {options
          .filter((o) => o.key === 'all' || o.n > 0 || o.key === value)
          .map((o) => (
            <button
              key={o.key}
              className={`facet ${value === o.key ? 'on' : ''} ${o.icon ? 'has-icon' : ''}`}
              aria-pressed={value === o.key}
              onClick={() => onChange(value === o.key && o.key !== 'all' ? 'all' : o.key)}
            >
              {o.icon}
              {o.label}
              <span className="n">×{o.n}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

/**
 * 卡片顶部的光晕：用图标的主色（白底图标模糊后只剩一片白，所以不直接铺图片）；
 * 域名类用注册商图标（默认 Cloudflare）；取不到颜色时用分类色
 */
function CardGlow({ sub }: { sub: Subscription }) {
  const src = isDomainCat(sub.category)
    ? sub.icon?.startsWith('http')
      ? sub.icon
      : base('/brands/cloudflare.svg')
    : sub.icon?.startsWith('/')
      ? sub.icon
      : subImage(sub);
  const tint = useIconTint(src);
  return <div className="sc-glow" style={{ '--glow': tint ?? catColor(sub.category) } as Record<string, string>} />;
}

/** 卡片与列表视图共用的状态徽章（试用、即将到期、暂停、已结束、被停用）；未开始、合租、代付由 SubBadges 统一判定 */
function StatusBadges({ st }: { st: string }) {
  return (
    <>
      {st === 'trial' && <span className="badge green">{t('list.status.trialShort')}</span>}
      {st === 'ending' && <span className="badge orange">{t('list.status.ending')}</span>}
      {st === 'paused' && <span className="badge">{t('list.status.pausedShort')}</span>}
      {st === 'ended' && <span className="badge">{t('list.status.ended')}</span>}
      {st === 'terminated' && <span className="badge red">{t('list.status.terminated')}</span>}
    </>
  );
}

/** Both list layouts use the same relationship and upcoming-state rules. */
function SubBadges({ state, s, today, children }: { state: AppState; s: Subscription; today: string; children?: React.ReactNode }) {
  const st = effectiveStatus(s, today);
  const up = upcomingPhase(s, today);
  return (
    <>
      {st === 'upcoming' && !up && <span className="badge blue">{t('list.status.upcoming')}</span>}
      <StatusBadges st={st} />
      {children}
      {s.share?.role === 'owner' && s.share.members.length > 0 && <span className="badge blue">{t('list.badge.share')}</span>}
      {s.share?.role === 'member' && <span className="badge blue">{t('list.badge.joined')}</span>}
      {s.proxy && <ProxyBadge state={state} s={s} today={today} />}
    </>
  );
}

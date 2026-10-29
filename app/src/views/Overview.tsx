import { useSnapshotRender } from '../snapshot-render.tsx';
import { chargeTotal, chargesTotal, emptyTotal, formatTotal, scaleTotal, totalNote } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { DAYS_PER_MONTH } from '../../../shared/billing.ts';
import { CopyImageButton } from '../components/CopyImageButton.tsx';
import { copyParts } from '../components/copy.tsx';
import { base as appPath } from '../base.ts';
import { type CSSProperties, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMonths, cycleLabel, diffDays, perLabel, runwayFor, totals, type Charge, chargeMethodId } from '../../../shared/billing.ts';
import { moneyTick, flow, cnDate, money, monthLabel, relDays } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { chargeBaseOrNaN, chargeValue } from '../../../shared/fx.ts';
import { contributionOn, insights, mrrChangeSinceLastMonth, mrrSeries, stopLosses } from '../../../shared/metrics.ts';
import { BALANCE_KINDS, type AppState, type Subscription } from '../../../shared/types.ts';
import { Activity, packCircles, type Bucket } from '../components/charts.tsx';
import { Timeline, type TimelineGroup } from '../components/Timeline.tsx';
import { TailName } from '../components/TailName.tsx';
import { MetricCards, Metric, IconButton, CardTitle, Toolbar } from '../components/ui.tsx';
import { Seg } from '../components/inputs.tsx';
import { CatIcon, MethodMark, SubIcon } from '../components/marks.tsx';
import { TipTable } from '../components/overlays.tsx';
import { Icon } from '../components/icons.tsx';
import { allCharges, catColor, sortValue, sumBaseOrNaN, firstStart } from '../derive.ts';
import { yearOutlook } from '../../../shared/scope-report.ts';
import { go } from '../router.ts';
import { useMoneyPair } from '../components/MoneyPair.tsx';

type Scale = 'month' | 'year';
const PROJ = '__proj';

export function Overview({ state, today, onOpen, onAdd }: { state: AppState; today: string; onOpen: (s: Subscription) => void; onAdd: () => void }) {
  return (
    <>
      <Toolbar title={t('overview.title')}>
        {!state.readonly && (
          <button className="btn primary d-only page-add" onClick={onAdd}>
            <Icon name="plus" /> {t('overview.add')}
          </button>
        )}
      </Toolbar>
      <div className="page fade-in stack" style={{ gap: 20 }}>
        <Statement state={state} today={today} onOpen={onOpen} />
        <ChargeTimeline state={state} today={today} onOpen={onOpen} />
        <Spending state={state} today={today} onOpen={onOpen} />
        <div className="grid g-2">
          <DueSoon state={state} today={today} onOpen={onOpen} />
          <WalletBrief state={state} today={today} />
        </div>
        <Tips state={state} today={today} onOpen={onOpen} />
      </div>
    </>
  );
}

/** 扣款时间线：今天居中，左右滑动看前后的扣款 */
function ChargeTimeline({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const past30 = useMemo(() => {
    // 缺汇率的一笔让合计为 NaN（显示「—」），不当作 0
    return chargesTotal(state, allCharges(state, addDays(today, -29), today, today));
  }, [state, today]);
  // 时间线按需加载：拖到哪段算哪段
  const load = useCallback(
    (from: string, to: string) => {
      const map = new Map<string, TimelineGroup>();
      const byDay = new Map<string, Charge[]>();
      for (const c of allCharges(state, from, to, today)) {
        const g = map.get(c.date) ?? { date: c.date, items: [] };
        const real = state.subscriptions.find((x) => x.id === c.sub.id) ?? c.sub;
        g.items.push({
          key: `${c.sub.id}-${c.date}-${g.items.length}`,
          icon: <SubIcon sub={c.sub} size={30} />,
          name: c.sub.name,
          amount: flow(-c.amount, c.currency),
          value: chargeTotal(state, c).value,
          onClick: () => onOpen(real),
        });
        map.set(c.date, g);
        byDay.set(c.date, byDay.get(c.date)?.concat(c) ?? [c]);
      }
      // 当天合计：缺汇率时带「不完整」标记，不当作 0
      for (const g of map.values()) g.total = formatTotal(chargesTotal(state, byDay.get(g.date)!), base, { direction: -1 });
      return [...map.values()];
    },
    [state, today, onOpen, base],
  );
  return (
    <section className="card copy-card" data-copy-card>
      <div className="row tl-head" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <CardTitle className="sec-title">{t('overview.timeline.title')}</CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
          <span className="sec-sub" style={{ marginTop: 0 }}>
            {copyParts(t('overview.timeline.past', { amount: formatTotal(past30, base, { direction: -1, compact: true }) }))}
          </span>
        </div>
      </div>
      <Timeline load={load} today={today} start={firstStart(state, today)} />
    </section>
  );
}

/** 主图：每月 / 每年花了多少，按分类堆叠 */
function Spending({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const [scale, setScale] = useState<Scale>('month');
  const [hidden, setHidden] = useState<string[]>([]);
  const [selKey, setSelKey] = useState<string | undefined>();
  const first = firstStart(state, today);

  const ranges = useMemo(() => {
    const out: Array<{ key: string; label: string; from: string; to: string }> = [];
    if (scale === 'month') {
      for (let i = -11; i <= 6; i++) {
        const m = addMonths(today.slice(0, 8) + '01', i);
        out.push({
          key: m.slice(0, 7),
          label:
            i === 0 || m.endsWith('-01-01')
              ? t('overview.axis.yearMonth', { yy: m.slice(2, 4), m: Number(m.slice(5, 7)), mon: monthLabel(m.slice(0, 7), { year: false }) })
              : monthLabel(m.slice(0, 7), { year: false }),
          from: m,
          to: addDays(addMonths(m, 1), -1),
        });
      }
    } else {
      for (let yy = Number(first.slice(0, 4)); yy <= Number(today.slice(0, 4)) + 1; yy++)
        out.push({ key: String(yy), label: String(yy), from: `${yy}-01-01`, to: `${yy}-12-31` });
    }
    return out;
  }, [scale, today, first]);

  const data = useMemo(
    () =>
      ranges.map((r) => {
        const cs = allCharges(state, r.from, r.to, today).filter((c) => !hidden.includes(c.sub.category));
        return { r, cs };
      }),
    [state, ranges, hidden, today],
  );

  const curKey = scale === 'month' ? today.slice(0, 7) : today.slice(0, 4);
  // 柱高用缺汇率按 0 的值（图表几何必须是有限数）；提示框里显示的金额用缺汇率为 NaN 的值，显示「—」
  const buckets: Bucket[] = data.map(({ r, cs }) => {
    const parts = new Map<string, number>();
    for (const c of cs) {
      const k = c.projected && r.key === curKey ? PROJ : c.sub.category;
      parts.set(k, (parts.get(k) ?? 0) + chargeValue(state, c));
    }
    const arr = [...parts.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => (a.k === PROJ ? 1 : b.k === PROJ ? -1 : b.v - a.v));
    return { key: r.key, label: r.label, parts: arr, total: arr.reduce((a, p) => a + p.v, 0), future: r.key > curKey, current: r.key === curKey };
  });

  const sel = selKey && buckets.some((b) => b.key === selKey) ? selKey : curKey;
  const selData = data.find((d) => d.r.key === sel);
  const selPart = chargesTotal(state, selData?.cs ?? []);
  const selTotal = selPart.value;
  const selPaid = selData
    ? sumBaseOrNaN(
        state,
        selData.cs.filter((c) => !c.projected),
      )
    : 0;
  const bySub = new Map<string, { sub: Subscription; v: number; n: number; proj: boolean }>();
  for (const c of selData?.cs ?? []) {
    const e = bySub.get(c.sub.id) ?? { sub: c.sub, v: 0, n: 0, proj: true };
    e.v += chargeBaseOrNaN(state, c);
    e.n++;
    e.proj = e.proj && c.projected;
    bySub.set(c.sub.id, e);
  }
  const items = [...bySub.values()].sort((a, b) => sortValue(b.v) - sortValue(a.v));

  // 图例：所选区间（全部柱子）里各分类的合计
  const catTotals = new Map<string, number>();
  for (const { cs } of allRanges(state, ranges, today))
    for (const c of cs) catTotals.set(c.sub.category, (catTotals.get(c.sub.category) ?? 0) + chargeBaseOrNaN(state, c));
  const cats = [...catTotals.entries()].sort((a, b) => sortValue(b[1]) - sortValue(a[1]));
  const selLabel = scale === 'month' ? monthLabel(sel) : t('overview.spending.year', { year: sel });
  const isFuture = sel > curKey;

  return (
    <div className="card copy-card" data-copy-card style={{ padding: '22px 24px 20px' }}>
      <div className="ov-head">
        <div>
          {/* 「浅色为预计」并入说明，标题下不再单列一行 */}
          <CardTitle as="h3" className="sec-title" hint={`${t('report.cash.fullPaidHint')}\n${totalNote(selPart) || t('overview.spending.sub')}`}>
            {t('overview.spending.title')}
          </CardTitle>
        </div>
        <div className="copy-controls">
          <CopyImageButton hover />
          <Seg
            value={scale}
            onChange={(v) => {
              setScale(v);
              setSelKey(undefined);
            }}
            options={[
              ['month', t('overview.spending.month')],
              ['year', t('overview.spending.yearly')],
            ]}
          />{' '}
        </div>
      </div>

      <Activity
        buckets={buckets}
        color={(k) => (k === PROJ ? 'pending' : 'var(--chart-ink)')}
        selected={selKey ? sel : undefined}
        current={sel}
        onSelect={(k) => setSelKey(k === selKey ? undefined : k)}
        fmt={(v) => moneyTick(v, base)}
        tip={(b) => (
          <TipTable
            head={[b.label, formatTotal(chargesTotal(state, data.find((d) => d.r.key === b.key)?.cs ?? []), base, { direction: -1, compact: true })]}
            rows={b.parts
              .filter((p) => p.k !== PROJ)
              .slice(0, 5)
              .map((p) => ({
                key: p.k,
                label: p.k,
                value: formatTotal(
                  chargesTotal(
                    state,
                    (data.find((d) => d.r.key === b.key)?.cs ?? []).filter((c) => c.sub.category === p.k),
                  ),
                  base,
                  { direction: -1, compact: true },
                ),
              }))}
          />
        )}
      />

      <div className="legend-chips">
        {cats.map(([k]) => (
          <button
            key={k}
            data-snapshot-keep
            className={`lc ${hidden.includes(k) ? 'off' : ''}`}
            onClick={() => setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k])}
          >
            <CatIcon cat={k} size={13} />
            {k}
            <b>
              {formatTotal(
                chargesTotal(
                  state,
                  allRanges(state, ranges, today)
                    .flatMap((r) => r.cs)
                    .filter((c) => c.sub.category === k),
                ),
                base,
                { direction: -1, compact: true },
              )}
            </b>
          </button>
        ))}
      </div>

      <div className="sel-box">
        <div>
          <h4>
            {selLabel}
            {copyParts(isFuture ? t('overview.spending.projected') : sel === curKey ? t('overview.spending.inProgress') : '')}
          </h4>
          <div className="big">
            <FxAmount total={selPart} direction={-1} ccy={base} />
          </div>
          <div className="muted" style={{ fontSize: 'var(--fs-1)', marginTop: 2 }}>
            {t('overview.n.subs', { count: items.length })} <span className="copy-gap" aria-hidden="true" />{' '}
            {t('overview.n.charges', { count: selData?.cs.length ?? 0 })}
            {copyParts(sel === curKey && selTotal > selPaid ? t('overview.spending.paid', { amount: flow(-selPaid, base, { compact: true }) }) : '')}
          </div>
        </div>
        <div className="sel-items" data-snapshot-list=".sel-item" data-snapshot-total={items.length}>
          {items.length === 0 && (
            <span className="muted" style={{ fontSize: 'var(--fs-2)' }}>
              {t('overview.spending.empty')}
            </span>
          )}
          {items.slice(0, 12).map((e) => (
            <button key={e.sub.id} className="sel-item" data-snapshot-keep onClick={() => onOpen(e.sub)}>
              <SubIcon sub={e.sub} size={22} />
              <TailName className="si-name" style={{ opacity: e.proj && !isFuture ? 0.6 : 1 }} name={e.sub.name} after={e.n > 1 ? ` ×${e.n}` : ''} />
              <b>
                {formatTotal(
                  chargesTotal(
                    state,
                    (selData?.cs ?? []).filter((c) => c.sub.id === e.sub.id),
                  ),
                  base,
                  { direction: -1, compact: true },
                )}
              </b>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function allRanges(state: AppState, ranges: Array<{ from: string; to: string }>, today: string): Array<{ cs: Charge[] }> {
  if (!ranges.length) return [];
  return [{ cs: allCharges(state, ranges[0].from, ranges[ranges.length - 1].to, today) }];
}

/** 接下来 30 天 */
function DueSoon({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  // 大字 / 小字金额跟随显示货币设置
  const pair = useMoneyPair(state);
  const base = state.settings.baseCurrency;
  const cs = allCharges(state, addDays(today, 1), addDays(today, 30), today).filter((c) => c.amount > 0 && c.kind !== 'refund' && c.kind !== 'failed');
  const total = chargesTotal(state, cs);
  const groups: Array<['thisWeek' | 'later', Charge[]]> = [
    ['thisWeek', cs.filter((c) => diffDays(today, c.date) <= 6)],
    ['later', cs.filter((c) => diffDays(today, c.date) > 6)],
  ];
  return (
    <div className="card">
      <div className="card-h">
        <CardTitle>{t('overview.due.title')}</CardTitle>
        <span className="meta">
          {t('overview.n.charges', { count: cs.length })} <span className="copy-gap" aria-hidden="true" />{' '}
          {formatTotal(total, base, { direction: -1, compact: true })}
        </span>
      </div>
      {cs.length === 0 && <div className="empty">{t('overview.due.empty')}</div>}
      <div className="due-list">
        {groups
          .filter(([, l]) => l.length)
          .map(([g, list]) => (
            <Fragment key={g}>
              <div className="due-g">{t(`overview.due.${g}`)}</div>
              {list.slice(0, g === 'thisWeek' ? 10 : 6).map((c, i) => {
                const d = diffDays(today, c.date);
                const m = state.methods.find((x) => x.id === chargeMethodId(c));
                const amt = pair(-c.amount, c.currency, { value: -chargeBaseOrNaN(state, c) });
                return (
                  <button key={c.sub.id + c.date + i} className="due-row" onClick={() => onOpen(c.sub)}>
                    <SubIcon sub={c.sub} size={36} />
                    <span className="nm">
                      <b>{c.sub.name}</b>
                      <small>
                        {m?.name ?? t('overview.due.noMethod')} <span className="copy-gap" aria-hidden="true" /> {cycleLabel(c.sub.cycle)}
                      </small>
                    </span>
                    <span className="am">
                      <b>{amt.main}</b>
                      {amt.alt && <small>{amt.alt}</small>}
                    </span>
                    <span className={`pill ${d <= 3 ? 'hot' : ''}`}>{d <= 13 ? relDays(d) : cnDate(c.date)}</span>
                  </button>
                );
              })}
            </Fragment>
          ))}
      </div>
    </div>
  );
}

/** 钱包小结：余额账户还能撑多久 */
function WalletBrief({ state, today }: { state: AppState; today: string }) {
  const rows = state.methods
    .filter((m) => BALANCE_KINDS.includes(m.kind) && state.subscriptions.some((s) => s.methodId === m.id))
    .map((m) => ({ m, r: runwayFor(m, state, today) }));
  const cards = state.methods.filter((m) => !BALANCE_KINDS.includes(m.kind));
  return (
    <div className="card">
      <div className="card-h">
        <CardTitle>{t('overview.wallet.title')}</CardTitle>
        <a className="btn plain" href={appPath('/wallet')}>
          {t('overview.wallet.manage')}
        </a>
      </div>
      {rows.map(({ m, r }) => {
        const days = r?.runsOutOn ? diffDays(today, r.runsOutOn) : undefined;
        const pct = r ? (r.monthlyDrain <= 0 ? 100 : Math.min(100, ((days ?? 365) / 365) * 100)) : 0;
        return (
          <a key={m.id} className="wal-row" href={appPath('/wallet')}>
            <MethodMark m={m} size={28} />
            <span className="nm">
              <b>{m.name}</b>
              {r ? (
                <>
                  <small>
                    {copyParts(
                      t('overview.wallet.balance', {
                        amount: formatTotal(r.partial.current, m.currency, { compact: true }),
                        status: r.incomplete
                          ? totalNote(r.partial.monthlyDrain)
                          : r.shortfall
                            ? r.coveredCharges
                              ? t('overview.wallet.covered', { count: r.coveredCharges, date: cnDate(r.shortfall.date) })
                              : t('overview.wallet.mustTopUp', { date: cnDate(r.shortfall.date) })
                            : t('overview.wallet.enough'),
                      }),
                    )}
                  </small>
                  <div className="wal-bar">
                    <i className={days != null && days <= 7 ? 'out' : days != null && days <= 30 ? 'low' : ''} style={{ width: `${Math.max(3, pct)}%` }} />
                  </div>
                </>
              ) : (
                <small style={{ color: 'var(--orange)' }}>{t('overview.wallet.noBalance')}</small>
              )}
            </span>
          </a>
        );
      })}
      {cards.length > 0 && (
        <div className="muted" style={{ fontSize: 'var(--fs-1)', marginTop: rows.length ? 12 : 0 }}>
          {t('overview.wallet.others', { list: cards.map((m) => m.name).join(t('overview.listSep')) })}
        </div>
      )}
    </div>
  );
}

/** 三条最值得看的洞察 */
function Tips({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const list = useMemo(() => insights(state, today).filter((i) => i.id !== 'unused'), [state, today]);
  const order = { warn: 0, info: 1, good: 2 } as const;
  const top = [...list].sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 3);
  if (!top.length) return null;
  const label = { warn: t('overview.tips.warn'), info: t('overview.tips.info'), good: t('overview.tips.good') };
  return (
    <div className="tips">
      {top.map((i) => (
        <div key={i.id} className={`tip-card ${i.tone}`}>
          <span className="k">
            <i />
            {label[i.tone]}
          </span>
          <b>{i.title}</b>
          <p>{i.body}</p>
          {!!(i.subs?.length || i.methods?.length) && (
            <div className="ins-subs" style={{ '--n': (i.methods?.length ?? 0) + Math.min(12, i.subs?.length ?? 0) } as CSSProperties}>
              {i.methods?.map((m) => (
                <a className="icon-btn sub-shortcut" data-snapshot-keep key={m.id} href={appPath('/wallet')} title={m.name} aria-label={m.name}>
                  <MethodMark m={m} size={22} />
                </a>
              ))}
              {(i.subs ?? []).slice(0, 12).map((s) => (
                <IconButton className="sub-shortcut" data-snapshot-keep key={s.id} onClick={() => onOpen(s)} title={s.name} aria-label={s.name}>
                  <SubIcon sub={s} size={22} />
                </IconButton>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export { perLabel };

/** 账单头：深色底，左边负 MRR，右边订阅星图（圆的面积 = 每月成本） */
/** 打开报告页并滚到「退订与停用」卡片；报告页是按需加载的，等卡片渲染出来再滚动 */
function openLosses() {
  go('report');
  let tries = 0;
  const scroll = () => {
    const el = document.getElementById('report-stops');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (tries++ < 60) requestAnimationFrame(scroll);
  };
  requestAnimationFrame(scroll);
}

function Statement({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const captureRef = useRef<HTMLElement>(null);
  useSnapshotRender(captureRef, () => <Statement state={state} today={today} onOpen={onOpen} />);
  const base = state.settings.baseCurrency;
  const tot = totals(state, today);
  const series = useMemo(() => mrrSeries(state, today, 24, true), [state, today]);
  const delta = mrrChangeSinceLastMonth(state, today);
  // 今年 = 已付 + 剩余预计，与报告页「本年」同一份结果
  const year = useMemo(() => yearOutlook(state, today).current.partial, [state, today]);
  const loss = useMemo(
    () => (state.readonly ? emptyTotal() : stopLosses(state, today, { from: `${today.slice(0, 4)}-01-01`, to: today }).partial),
    [state, today],
  );
  const live = useMemo(
    () =>
      state.subscriptions
        .map((s) => ({ s, v: contributionOn(state, s, today) }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v),
    [state, today],
  );
  const bubbles = useMemo(() => packCircles(live.map((x) => x.v)) as Array<{ x: number; y: number; r: number; i: number; h: number }>, [live]);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const h = bubbles[0]?.h ?? 1;
  const max = Math.max(1, ...series.map((p) => p.partial.value));
  const path = series
    .map((p, i) => `${i ? 'L' : 'M'}${((i / (series.length - 1)) * 100).toFixed(2)},${(30 - (p.partial.value / max) * 28).toFixed(2)}`)
    .join('');
  const [hover, setHover] = useState<number | null>(null);
  const hv = hover != null ? live[hover] : undefined;

  return (
    <section className="stmt copy-card" data-copy-card ref={captureRef}>
      <div className="copy-corner">
        <CopyImageButton hover />
      </div>
      <div className="stmt-l">
        <CardTitle as="div" className="stmt-kicker" hint={t('scope.mrrBasis')}>
          {t('overview.stmt.kicker')}
        </CardTitle>
        <div className="stmt-num">
          <FxAmount total={tot.partial.mrr} direction={-1} ccy={base} />
        </div>
        <div className="stmt-delta">
          <span className={delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : ''}>
            {copyParts(delta > 0.5 ? '↑' : delta < -0.5 ? '↓' : '')} {money(Math.abs(delta), base, { compact: true })}
          </span>
          {t('overview.stmt.vsLastMonth')}
        </div>
        <svg className="stmt-spark" viewBox="0 0 100 32" preserveAspectRatio="none">
          <path d={`${path}L100,32L0,32Z`} fill="url(#stmt-g)" />
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          <defs>
            <linearGradient id="stmt-g" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
        <MetricCards plain>
          <Metric label={t('overview.stmt.annual')} value={formatTotal(scaleTotal(tot.partial.mrr, 12), base, { direction: -1, compact: true, main: true })} />
          <Metric
            label={t('scope.yearTotal')}
            value={formatTotal(year.total, base, { direction: -1, compact: true, main: true })}
            note={
              <div className="stmt-paid-note">
                <small>{t('scope.paidAmount', { amount: formatTotal(year.paid, base, { direction: -1, compact: true }) })}</small>
                {!state.readonly && (loss.value !== 0 || loss.incomplete) && (
                  <button
                    type="button"
                    className="stmt-loss-note"
                    data-snapshot-keep
                    onClick={openLosses}
                    title={loss.incomplete ? totalNote(loss) : undefined}
                  >
                    {t('overview.stmt.loss')} <strong>{formatTotal(loss, base, { direction: -1, compact: true })}</strong>
                  </button>
                )}
              </div>
            }
          />
          <Metric
            label={t('overview.stmt.perDay')}
            value={formatTotal(scaleTotal(tot.partial.mrr, 1 / DAYS_PER_MONTH), base, { direction: -1, main: true, average: true })}
          />
          <Metric
            label={t('overview.stmt.active')}
            value={tot.activeCount}
            note={
              [totalNote(tot.partial.mrr), year.total.incomplete ? `${t('scope.yearTotal')}: ${totalNote(year.total)}` : ''].filter(Boolean).join('\n') ||
              undefined
            }
          />
        </MetricCards>
      </div>
      <div className="stmt-r">
        <div className="stmt-cap m-hide">
          {hv ? (
            <>
              <b>{hv.s.name}</b> <span className="copy-gap" aria-hidden="true" />{' '}
              {copyParts(
                tot.incomplete
                  ? flow(-hv.v, base, { compact: true })
                  : t('overview.stmt.share', { amount: flow(-hv.v, base, { compact: true }), pct: Math.round((hv.v / tot.mrr) * 100) }),
              )}
            </>
          ) : (
            <>{copyParts(t('overview.stmt.caption'))}</>
          )}
        </div>
        <div className="stars" ref={box} style={{ aspectRatio: `${1 / h}` }}>
          {w > 0 &&
            bubbles.map((b, k) => {
              const { s, v } = live[b.i];
              const d = b.r * 2 * w;
              return (
                <button
                  key={s.id}
                  data-snapshot-keep
                  className={`star ${hover === b.i ? 'on' : ''}`}
                  style={
                    {
                      left: `${(b.x - b.r) * 100}%`,
                      top: `${((b.y - b.r) / h) * 100}%`,
                      width: d,
                      height: d,
                      '--tint': catColor(s.category),
                      animationDelay: `${k * 35}ms`,
                    } as Record<string, string | number>
                  }
                  onMouseEnter={() => setHover(b.i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onOpen(s)}
                  aria-label={t('overview.stmt.aria', { name: s.name, amount: flow(-v, base) })}
                >
                  <SubIcon sub={s} size={Math.max(12, Math.round(d * 0.5))} />
                  {d > 86 && <span className="star-amt">{flow(-v, base, { compact: true })}</span>}
                </button>
              );
            })}
        </div>
      </div>
    </section>
  );
}

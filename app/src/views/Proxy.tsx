import { formatTotal, totalNote } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { currentPhase } from '../../../shared/billing.ts';
import { copyParts } from '../components/copy.tsx';
import { PersonAvatar, personFor } from '../components/PersonAvatar.tsx';
import { useState } from 'react';
import { addDays, cycleLabel, diffDays, effectiveStatus, nextCharge, todayIn, isStopped } from '../../../shared/billing.ts';
import { flow, cnDate, cnDateFull, money, relDays } from '../../../shared/format.ts';
import { toBaseAt } from '../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { MetricCards, Metric, Group, Toolbar } from '../components/ui.tsx';
import { Seg, useWidth } from '../components/inputs.tsx';
import { NameLink, PayBadge, StatusPill, SubIcon } from '../components/marks.tsx';
import { contactText } from '../components/Contact.tsx';
import { LtHead, nextSort, PlanPrice, usePhone } from '../components/LtHead.tsx';
import { usePref } from '../prefs.ts';
import { proxyAhead, proxyTotals } from '../../../shared/proxy.ts';
import { locale, t } from '../../../shared/i18n.ts';
import { rows } from './proxy/common.tsx';
import { proxyOwed } from './proxy/common.tsx';
import { proxySummary } from './proxy/common.tsx';
import { proxyStatus } from './proxy/common.tsx';
import { OwedOrNet } from './proxy/common.tsx';
import { LedgerSheet } from './proxy/sheets.tsx';
import { ConvertProxySheet } from './proxy/ConvertProxySheet.tsx';
import { isProxyCandidate } from './proxy/candidates.ts';
import { newSub } from './editor/new-sub.ts';

/**
 * 代付卡片：头部（图标、名称）点开是订阅详情；底部「N 期明细」点开是逐期的扣款与收款。
 * 卡片本身只放摘要，高度统一；停止的盖一枚模糊的 🚫 水印。
 */
export function ProxyCard({ state, s, onOpen }: { state: AppState; s: Subscription; onOpen: (s: Subscription) => void }) {
  const today = todayIn(state.settings.timezone);
  const base = state.settings.baseCurrency;
  const list = rows(state, s, today);
  const ahead = proxyAhead(state, s, today);
  const [ledger, setLedger] = useState(false);
  const next = nextCharge(s, addDays(today, 1));
  const method = state.methods.find((m) => m.id === s.methodId);
  const { partial } = proxyTotals(list);
  const st = effectiveStatus(s, today);
  const stopped = isStopped(st);
  const [tone, label] = proxyStatus(st, list, ahead);

  return (
    <>
      {/* 整张卡片点开代付详情 */}
      <div
        className={`card proxy-card ${stopped ? 'stopped' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setLedger(true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setLedger(true))}
      >
        <div className="proxy-top">
          <div className="proxy-head">
            <SubIcon sub={s} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ph-name text-ellipsis">
                <NameLink onClick={() => onOpen(s)}>{s.name}</NameLink>
              </div>
              <div className="muted ph-meta">
                {money(currentPhase(s, today).price, currentPhase(s, today).currency)} {cycleLabel(currentPhase(s, today).cycle)}
                {copyParts(stopped ? (s.end ? t('proxy.stoppedOn', { date: cnDate(s.end) }) : '') : next ? t('proxy.nextOn', { date: cnDate(next) }) : '')}
              </div>
            </div>
          </div>
          {/* 待收的金额已在第三格，胶囊不再重复 */}
          {tone !== 'owe' && <StatusPill tone={tone}>{label}</StatusPill>}
        </div>
        <div className="ph-chips">
          <span className="who-chip" title={s.proxy!.note}>
            <PersonAvatar p={personFor(state, s.proxy!.personId, s.proxy!.forName)} size={16} />
            {t('proxy.payFor', { name: s.proxy!.forName || t('proxy.unset') })}
            {contactText(s.proxy!) && <em>{contactText(s.proxy!)}</em>}
          </span>
          <PayBadge m={method} />
        </div>

        <MetricCards inline>
          <Metric
            label={t('proxy.paidPeriods', { count: list.length })}
            value={formatTotal(partial.charged, base, { direction: -1, compact: true, main: true })}
            note={totalNote(partial.charged) || undefined}
          />
          <Metric
            label={t('proxy.received')}
            value={formatTotal(partial.received, base, { direction: 1, compact: true, main: true })}
            note={totalNote(partial.received) || undefined}
            valueClassName="green"
          />
          <OwedOrNet list={list} base={base} />
        </MetricCards>
      </div>
      {/* 弹窗放在卡片外面：卡片的定位与裁切不会影响弹层，也不会把同一行的卡片撑高 */}
      {ledger && <LedgerSheet state={state} s={s} onClose={() => setLedger(false)} onOpen={onOpen} />}
    </>
  );
}

export const PROXY_FILTERS = ['all', 'live', 'owe', 'ended'] as const;

export type ProxyFilter = (typeof PROXY_FILTERS)[number];

export type ProxyView = 'grid' | 'list';

export type ProxySort = 'status' | 'name' | 'who' | 'price' | 'next' | 'paid' | 'received' | 'profit';

export const isProxySort = (v: string): v is ProxySort => ['status', 'name', 'who', 'price', 'next', 'paid', 'received', 'profit'].includes(v);

/** 默认方向：待收多的在前、名称与对象 A→Z、扣款近的在前、金额大的在前、亏得多的在前 */
export const PROXY_SORT_DIR: Record<ProxySort, 'asc' | 'desc'> = {
  status: 'desc',
  name: 'asc',
  who: 'asc',
  price: 'desc',
  next: 'asc',
  paid: 'desc',
  received: 'desc',
  profit: 'asc',
};

/**
 * 代付的列表视图（桌面）：一行一个代付，比卡片多出支付方式、每期本币金额、下次扣款与最近一次收款；点一行打开代付详情。
 * 各列按比例分宽度；表格变窄时先收起 data-p=2 的列，再收起 data-p=3。手机上不出表格，仍用卡片
 */
/**
 * 代付的排序：卡片与列表共用一份，在列表表头切换，对两种视图都生效。
 * 排序存在服务端；默认按状态（待收多的在前、已结清其次，已停止始终最后），表头不为默认排序标箭头
 */
export function useProxySort(state: AppState, today: string, subs: Subscription[]) {
  // 三态：该列默认方向、反向、回到默认
  const [sort, setSort] = usePref<ProxySort>('proxy-sort', 'status', isProxySort);
  const [dir, setDir] = usePref<'asc' | 'desc'>('proxy-dir', PROXY_SORT_DIR[sort], (v): v is 'asc' | 'desc' => v === 'asc' || v === 'desc');
  const onSort = (k: ProxySort) => {
    const [ns, nd] = nextSort(k, sort, dir, PROXY_SORT_DIR, 'status');
    setSort(ns);
    setDir(nd);
  };
  const items = subs.map((s) => {
    const list = rows(state, s, today);
    const st = effectiveStatus(s, today);
    const stopped = isStopped(st);
    return {
      s,
      list,
      ahead: proxyAhead(state, s, today),
      st,
      stopped,
      ...proxyTotals(list),
      next: stopped ? undefined : nextCharge(s, addDays(today, 1)),
      priceBase: toBaseAt(state, currentPhase(s, today).price, currentPhase(s, today).currency),
    };
  });
  type Item = (typeof items)[number];
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  // 状态：待收的按金额排在最前，其次已结清，还没扣过款的最后
  const statusRank = (x: Item) => (x.open.length ? 1e9 + num(x.owed) : x.done.length ? 1 : 0);
  const amountOf = (x: Item) => ({ status: statusRank(x), price: x.priceBase, paid: x.charged, received: x.received, profit: x.diff });
  const asc = (a: Item, b: Item): number =>
    sort === 'name'
      ? a.s.name.localeCompare(b.s.name, locale())
      : sort === 'who'
        ? (a.s.proxy!.forName ?? '').localeCompare(b.s.proxy!.forName ?? '', locale())
        : sort === 'next'
          ? (a.next ?? a.s.end ?? '9999').localeCompare(b.next ?? b.s.end ?? '9999')
          : num(amountOf(a)[sort]) - num(amountOf(b)[sort]);
  const sorted = [...items].sort((a, b) => Number(a.stopped) - Number(b.stopped) || (dir === 'asc' ? asc(a, b) : asc(b, a)));
  return { sorted, sort, dir, onSort };
}

export type ProxyItem = ReturnType<typeof useProxySort>['sorted'][number];

export function ProxyTable({
  state,
  sorted,
  sort,
  dir,
  onSort,
  onOpen,
}: {
  state: AppState;
  sorted: ProxyItem[];
  sort: ProxySort;
  dir: 'asc' | 'desc';
  onSort: (k: ProxySort) => void;
  onOpen: (s: Subscription) => void;
}) {
  const base = state.settings.baseCurrency;
  const today = todayIn(state.settings.timezone);
  const [ledger, setLedger] = useState<string | null>(null);
  const ledgerSub = ledger ? state.subscriptions.find((x) => x.id === ledger) : undefined;
  return (
    <div className="ltable-wrap">
      <div className="ltable lt-x proxy-lt" role="table">
        <LtHead<ProxySort>
          initial={['status', PROXY_SORT_DIR.status]}
          sort={sort}
          dir={dir}
          onSort={onSort}
          cols={[
            { label: t('list.col.name'), sort: 'name' },
            { label: t('proxy.forWhom'), sort: 'who' },
            { label: t('family.pool.status'), sort: 'status' },
            { label: t('proxy.method'), p: 2 },
            { label: t('list.col.planPrice'), sort: 'price', p: 3, num: true },
            { label: t('proxy.nextCharge'), sort: 'next', num: true },
            { label: t('proxy.paid'), sort: 'paid', p: 3, num: true },
            { label: t('proxy.received'), sort: 'received', p: 3, num: true },
            { label: t('family.strip.profit'), sort: 'profit', num: true },
          ]}
        />
        {sorted.map(({ s, list, ahead, st, stopped, next, charged, done, received, diff, lastIn }) => {
          const [tone, label] = proxyStatus(st, list, ahead);
          const px = s.proxy!;
          return (
            <button key={s.id} className={`lt-row ${stopped ? 'st-ended' : ''}`} role="row" onClick={() => setLedger(s.id)}>
              <span className="lt-name">
                <SubIcon sub={s} size={32} />
                <span className="lt-title">
                  <span className="nm">
                    <b>{s.name}</b>
                  </span>
                  <small className="lt-sub">{t('family.strip.since', { date: cnDateFull(s.start) })}</small>
                </span>
              </span>
              {/* 人员一律用胶囊，与卡片里的「替谁付」一致 */}
              <span className="lt-who" title={px.note}>
                <span className="who-chip">
                  <PersonAvatar p={personFor(state, px.personId, px.forName)} size={16} />
                  {px.forName || t('proxy.unset')}
                  {contactText(px) && <em>{contactText(px)}</em>}
                </span>
              </span>
              {/* 状态胶囊：已停止 > 待收约多少 > 已结清；计费中还没扣过款的不显示。放在左侧文字区，右边都是数字 */}
              <span className="lt-status">
                {tone === 'ok' ? (
                  <small>—</small>
                ) : (
                  <StatusPill tone={tone}>
                    {tone === 'owe'
                      ? t('family.pool.owedAmount', { amount: formatTotal(proxyTotals(list).partial.owed, base, { compact: true, approx: true }) })
                      : label}
                  </StatusPill>
                )}
              </span>
              <span className="lt-pay" data-p={2}>
                <PayBadge m={state.methods.find((m) => m.id === s.methodId)} />
              </span>
              <PlanPrice state={state} s={s} today={today} />
              <span className="lt-num">
                {/* 已停止的不再有下次扣款，留空 */}
                {stopped ? null : next ? (
                  <>
                    {cnDate(next)}
                    <small>{relDays(diffDays(today, next))}</small>
                  </>
                ) : (
                  <small>—</small>
                )}
              </span>
              <span className="lt-num" data-p={3}>
                {formatTotal(proxyTotals(list).partial.charged, base, { direction: -1, compact: true })}
                <small>{t('proxy.periods', { count: list.length })}</small>
              </span>
              <span className="lt-num" data-p={3}>
                {done.length ? (
                  <>
                    {formatTotal(proxyTotals(list).partial.received, base, { direction: 1, compact: true })}
                    {lastIn && <small>{t('proxy.lastIn', { date: cnDate(lastIn) })}</small>}
                  </>
                ) : (
                  <small>—</small>
                )}
              </span>
              <span className={`lt-num ${proxyTotals(list).partial.diff.incomplete || Math.abs(diff) < 0.5 ? '' : diff > 0 ? 'gain' : 'loss'}`}>
                {!done.length ? (
                  <small>—</small>
                ) : Math.abs(diff) < 0.5 ? (
                  t('proxy.table.even')
                ) : (
                  formatTotal(proxyTotals(list).partial.diff, base, { direction: 1, compact: true })
                )}
              </span>
            </button>
          );
        })}
      </div>
      {ledgerSub && <LedgerSheet state={state} s={ledgerSub} onClose={() => setLedger(null)} onOpen={onOpen} />}
    </div>
  );
}

/** 代付页：替别人付的订阅，逐期记录实扣与收回 */
export function ProxyPage({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const sum = proxySummary(state, today);
  const [convert, setConvert] = useState<Subscription | null>(null);
  const candidates = state.subscriptions.filter((s) => isProxyCandidate(s, today));
  const add = () => {
    const draft = newSub(today, state.settings.defaultMethodId, base);
    window.dispatchEvent(new CustomEvent('ledger:add', { detail: { ...draft, proxy: { forName: '' } } }));
  };
  const [filter, setFilter] = usePref<ProxyFilter>('proxy-filter', 'all', (v): v is ProxyFilter => (PROXY_FILTERS as readonly string[]).includes(v));
  const stopped = (s: Subscription) => isStopped(effectiveStatus(s, today));
  const groups: Record<ProxyFilter, Subscription[]> = {
    all: sum.subs,
    live: sum.subs.filter((s) => !stopped(s)),
    owe: sum.subs.filter((s) => proxyOwed(state, s, today) > 0),
    ended: sum.subs.filter(stopped),
  };
  const shown = groups[filter];
  const order = useProxySort(state, today, shown);
  const [savedView, setView] = usePref<ProxyView>('proxy-view', 'grid', (v): v is ProxyView => v === 'grid' || v === 'list');
  const phone = usePhone();
  // 列数与合租卡片同一规则（每列至少约 340px，最多 4 列）
  const [colsRef, colsWidth] = useWidth();
  const colCount = Math.max(1, Math.min(4, Math.floor((colsWidth + 16) / 356)));
  const view = phone ? 'grid' : savedView;
  return (
    <>
      <Toolbar title={t('proxy.title')} onAdd={add}>
        {sum.subs.length > 0 && (
          <Seg
            small
            value={filter}
            onChange={setFilter}
            options={PROXY_FILTERS.map((f) => [f, `${t(`proxy.filter.${f}`)} ${groups[f].length}`] as [ProxyFilter, string])}
          />
        )}
        {sum.subs.length > 0 && !phone && (
          <Seg
            small
            value={view}
            onChange={setView}
            options={[
              ['grid', t('list.view.grid')],
              ['list', t('list.view.list')],
            ]}
          />
        )}
      </Toolbar>
      <div className="page fade-in stack">
        {/* 与卡片同一套口径：已代付、已收回、盈亏；还有没收回的才加一格待收。没有代付时只留空状态 */}
        {sum.subs.length > 0 && (
          <MetricCards>
            <Metric
              label={t('proxy.paidPeriods', { count: sum.count })}
              value={<FxAmount total={sum.partial.charged} ccy={base} direction={-1} />}
              note={
                totalNote(sum.partial.charged) ||
                (sum.next ? t('proxy.page.liveNext', { count: sum.live, date: cnDate(sum.next) }) : t('proxy.page.subs', { count: sum.subs.length }))
              }
            />
            <Metric
              label={t('proxy.received')}
              value={<FxAmount total={sum.partial.received} ccy={base} direction={1} />}
              valueStyle={{ color: 'var(--green)' }}
              note={totalNote(sum.partial.received) || (sum.lastIn ? t('proxy.page.lastIn', { date: cnDateFull(sum.lastIn) }) : t('proxy.page.noneIn'))}
            />
            <Metric
              label={t('family.strip.profit')}
              value={Math.abs(sum.diff) < 0.5 ? t('proxy.table.even') : <FxAmount total={sum.partial.diff} ccy={base} direction={1} />}
              valueStyle={{ color: sum.partial.diff.incomplete || Math.abs(sum.diff) < 0.5 ? undefined : sum.diff > 0 ? 'var(--green)' : 'var(--red)' }}
              note={
                // 持平时平均每期是 ±0，改写口径说明，不出现 −¥0.00
                sum.partial.diff.incomplete
                  ? totalNote(sum.partial.diff)
                  : sum.closedCount && Math.abs(sum.diff) >= 0.5
                    ? t('proxy.page.diffAvg', { count: sum.closedCount, amount: flow(sum.diff / sum.closedCount, base) })
                    : t('proxy.page.diffSub')
              }
            />
            {sum.owedCount > 0 && (
              <Metric
                label={t('proxy.owed')}
                value={<FxAmount plain total={sum.partial.owed} ccy={base} direction={1} />}
                valueStyle={{ color: 'var(--orange)' }}
                note={totalNote(sum.partial.owed) || t('proxy.page.owedSub', { count: sum.owedCount })}
              />
            )}
          </MetricCards>
        )}
        {sum.subs.length === 0 ? (
          <div className="card empty">
            <b>{t('proxy.page.emptyTitle')}</b>
            {t('proxy.page.emptyBody')}
          </div>
        ) : (
          <>
            {shown.length === 0 && <div className="card empty">{t('proxy.filter.none')}</div>}
            {view === 'list' ? (
              shown.length > 0 && <ProxyTable state={state} {...order} onOpen={onOpen} />
            ) : (
              <div className="car-cols proxy-cols" ref={colsRef} style={{ '--car-columns': colCount } as React.CSSProperties}>
                {/* 卡片与列表同一个排序（在列表表头切换） */}
                {order.sorted.map(({ s }) => (
                  <ProxyCard key={s.id} state={state} s={s} onOpen={onOpen} />
                ))}
              </div>
            )}
          </>
        )}
        {candidates.length > 0 && (
          <Group title={t('proxy.convert.maybeGroup')}>
            {candidates.map((s) => (
              <div key={s.id} className="cell">
                <span className="cell-l">
                  <span className="row">
                    <SubIcon sub={s} size={30} />
                    {s.name}
                  </span>
                </span>
                <span className="cell-r">
                  {money(currentPhase(s, today).price, currentPhase(s, today).currency)}
                  <button className="btn tinted" onClick={() => setConvert(s)}>
                    {t('proxy.convert.submit')}
                  </button>
                </span>
              </div>
            ))}
          </Group>
        )}
        {convert && <ConvertProxySheet state={state} s={convert} onClose={() => setConvert(null)} />}
      </div>
    </>
  );
}

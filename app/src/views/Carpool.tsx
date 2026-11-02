import { dueTotal, formatTotal, sumTotals, totalNote } from '../../../shared/fx-total.ts';
import { FxAmount } from '../components/FxAmount.tsx';
import { currentPhase } from '../../../shared/billing.ts';
import { copyParts } from '../components/copy.tsx';
import { ShareAvatars } from '../components/ShareAvatars.tsx';
import { cycleLabel, effectiveStatus, memberDues, nextCharge, isStopped, collectCurrencyOf } from '../../../shared/billing.ts';
import { toBaseAt } from '../../../shared/fx.ts';
import { useState } from 'react';
import { flow, cnDate, money } from '../../../shared/format.ts';
import { locale, t } from '../../../shared/i18n.ts';
import type { AppState, ShareMember, Subscription } from '../../../shared/types.ts';

import { nextSort, usePhone } from '../components/LtHead.tsx';
import { MemberSheet } from './Members.tsx';
import { carLedger, carYear } from '../../../shared/carpool.ts';
import { MetricCards, Metric, Cell, Group, Toolbar } from '../components/ui.tsx';
import { Seg, useWidth } from '../components/inputs.tsx';
import { Icon } from '../components/icons.tsx';
import { NameLink, StatusPill, SubIcon } from '../components/marks.tsx';
import { sortValue, toBase } from '../derive.ts';
import { usePref } from '../prefs.ts';
import { FamilyTabs } from './person-fields.tsx';
import { carpoolRoster } from '../../../shared/carpool-timeline.ts';
import { CAR_FILTERS } from './carpool/common.ts';
import type { CarFilter } from './carpool/common.ts';
import { parseIds } from './carpool/common.ts';
import type { CarSort } from './carpool/common.ts';
import type { CarView } from './carpool/common.ts';
import { isCarView } from './carpool/common.ts';
import { isCarSort } from './carpool/common.ts';
import { CAR_SORT_DIR } from './carpool/common.ts';
import { CarTable } from './carpool/CarTable.tsx';
import { MemberRows } from './carpool/Members.tsx';
import { CarSheet } from './carpool/CarSheet.tsx';
import { newSub } from './editor/new-sub.ts';
import { defaultSeats, ConvertSheet } from './carpool/ConvertSheet.tsx';
import { CarFacts } from './carpool/CarSheet.tsx';

export function Carpool({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const add = () => {
    const draft = newSub(today, state.settings.defaultMethodId, base);
    window.dispatchEvent(new CustomEvent('ledger:add', { detail: { ...draft, share: { role: 'owner', seats: defaultSeats(draft.name), members: [] } } }));
  };
  const [colsRef, colsWidth] = useWidth();
  const colCount = Math.max(1, Math.min(4, Math.floor((colsWidth + 16) / 356)));
  // 没有停止的车都算进行中：包括买断（没有到期）和还没开始的
  const live = (s: Subscription) => !isStopped(effectiveStatus(s, today));
  const owned = state.subscriptions.filter((s) => s.share?.role === 'owner' && live(s));
  const joined = state.subscriptions.filter((s) => s.share?.role === 'member' && live(s));
  // 卡片按状态筛选；顶部的统计始终按进行中的合租算
  // 筛选记在服务端：切到别的页面再回来、换台设备都还是上次选的
  const [filter, setFilter] = usePref<CarFilter>('car-filter', 'live', (v): v is CarFilter => (CAR_FILTERS as readonly string[]).includes(v));
  const ended = state.subscriptions.filter((s) => s.share?.role === 'owner' && !live(s));
  const all = [...owned, ...ended];
  const collect = collectCurrencyOf(state.settings);
  // 每辆车的成员待收、账、下次扣款只算一次：筛选、排序、统计、卡片与表格共用
  const duesBy = new Map(all.map((s) => [s.id, memberDues(s, today, collect, state)]));
  const duesOf = (s: Subscription) => duesBy.get(s.id) ?? memberDues(s, today, collect, state);
  const owes = (s: Subscription) => duesOf(s).some((d) => d.periodsOwed > 0);
  const groups: Record<CarFilter, Subscription[]> = {
    all,
    live: owned,
    owe: all.filter(owes),
    settled: owned.filter((s) => !owes(s)),
    ended,
  };
  const books = new Map(all.map((s) => [s.id, carLedger(state, s, today)]));
  // 排序与方向存在服务端；已停止的车始终排在最后。默认待收多的在前
  // 默认按状态：待收多的在前，已结清、已停止在后；表头不为默认排序标箭头
  const [sort, setSort] = usePref<CarSort>('car-sort', 'owed', isCarSort);
  const [dir, setDir] = usePref<'asc' | 'desc'>('car-dir', CAR_SORT_DIR[sort], (v): v is 'asc' | 'desc' => v === 'asc' || v === 'desc');
  // 表头三态：该列默认方向、反向、回到默认（按状态）
  const headSort = (k: CarSort) => {
    const [ns, nd] = nextSort(k, sort, dir, CAR_SORT_DIR, 'owed');
    setSort(ns);
    setDir(nd);
  };
  const [savedView, setView] = usePref<CarView>('car-view', 'grid', isCarView);
  const phone = usePhone();
  const view = phone ? 'grid' : savedView;
  const nextBy = new Map(all.map((s) => [s.id, nextCharge(s, today) ?? '9999-12-31']));
  const nextOf = (s: Subscription) => nextBy.get(s.id)!;
  // 待收合计（本位币）：算不出（缺汇率或缺金额）的一笔让合计为 NaN，只写「待收」，不写成少收的金额。每辆车与顶部合计同一算法
  const owedTotal = (dues: ReturnType<typeof duesOf>) => dues.reduce((a, d) => a + (Number.isFinite(d.owed) ? toBase(state, d.owed, d.currency) : NaN), 0);
  const owedBy = new Map(all.map((s) => [s.id, owedTotal(duesOf(s).filter((d) => d.periodsOwed > 0))]));
  const owedOf = (s: Subscription) => owedBy.get(s.id)!;
  // 当年盈亏：今年成本（已扣 + 预计）对比成员今年的收入（已收 + 今年还该收）
  const years = new Map(all.map((s) => [s.id, carYear(state, s, today)]));
  const netOf = (s: Subscription) => years.get(s.id)!.net;
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  const value: Record<Exclude<CarSort, 'name' | 'next'>, (s: Subscription) => number> = {
    owed: owedOf,
    net: netOf,
    price: (s) => num(toBaseAt(state, currentPhase(s, today).price, currentPhase(s, today).currency)),
    paid: (s) => books.get(s.id)!.paid,
    received: (s) => books.get(s.id)!.received,
    profit: (s) => -books.get(s.id)!.net,
  };
  const asc = (a: Subscription, b: Subscription) =>
    sort === 'name'
      ? a.name.localeCompare(b.name, locale())
      : sort === 'next'
        ? nextOf(a).localeCompare(nextOf(b))
        : sortValue(value[sort](a)) - sortValue(value[sort](b));
  const shown = [...groups[filter]].sort(
    (a, b) => Number(!live(a)) - Number(!live(b)) || (dir === 'asc' ? asc(a, b) : asc(b, a)) || nextOf(a).localeCompare(nextOf(b)),
  );
  const yearNet = owned.reduce((a, s) => a + books.get(s.id)!.yearNet, 0);
  const yearNetPartial = sumTotals(owned.map((s) => books.get(s.id)!.partial.yearNet));
  const yearIncomePartial = sumTotals(owned.map((s) => books.get(s.id)!.partial.yearIncome));
  // 第三格的小字：进行中的车上一共坐了几位成员、还空几个位置
  const seated = owned.reduce((a, s) => a + carpoolRoster(s, today).active.length, 0);
  const openSeats = owned.reduce((a, s) => a + carpoolRoster(s, today).vacancies, 0);
  const owedAll = all.flatMap(duesOf).filter((d) => d.periodsOwed > 0);
  const owedPartial = sumTotals(owedAll.map((d) => dueTotal(state, d, toBase(state, d.owed, d.currency))));
  const [convert, setConvert] = useState<Subscription | null>(null);
  const [member, setMember] = useState<{ s: Subscription; m?: ShareMember; editId?: string } | null>(null);
  // 点开的那辆车：只存 id，弹窗里总读最新数据（收款后立即更新）
  const [sheet, setSheet] = useState<string | null>(null);
  const sheetSub = sheet ? state.subscriptions.find((x) => x.id === sheet) : undefined;
  // 车卡默认收起，只看净成本与座位；展开才看账本与成员明细
  const [openRaw, setOpen] = usePref<string>('car-open', '[]');
  const expanded = parseIds(openRaw);
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(JSON.stringify([...next]));
  };
  const candidates = state.subscriptions.filter((s) => !s.share && !s.proxy && live(s) && s.tags.some((tag) => /合租|拼车|家庭|family|shared/i.test(tag)));

  return (
    <>
      <Toolbar title={t('family.pool.title')} onAdd={add}>
        <Seg
          small
          value={filter}
          onChange={setFilter}
          options={CAR_FILTERS.map((f) => [f, `${t(`family.pool.filter.${f}`)} ${groups[f].length}`] as [CarFilter, string])}
        />
        <FamilyTabs tab="plans" />
        {/* 卡片 / 列表切换固定在右上角最后一个；排序只在列表表头切换，对卡片同样生效 */}
        {!phone && (
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
        <MetricCards>
          <Metric
            label={yearNet < 0 ? t('family.pool.netGain') : t('family.pool.netCost')}
            value={<FxAmount total={yearNetPartial} direction={-1} ccy={base} />}
            valueStyle={{ color: yearNet < 0 ? 'var(--gain)' : undefined }}
            note={
              yearNetPartial.incomplete
                ? totalNote(yearNetPartial)
                : t('family.pool.yearIncome', { amount: formatTotal(yearIncomePartial, base, { direction: 1, compact: true }) })
            }
            noteStyle={{ color: 'var(--gain)' }}
          />
          <Metric
            label={t('family.pool.owed')}
            value={<FxAmount plain total={owedPartial} ccy={base} />}
            valueStyle={{ color: owedPartial.value > 0 ? 'var(--orange)' : undefined }}
            note={totalNote(owedPartial) || t('family.pool.owedSub', { count: owedAll.length })}
          />
          <Metric
            label={t('family.pool.count')}
            note={t('family.pool.countNote', { members: seated, free: openSeats })}
            value={
              <span className="amt car-plan-count">
                <span>
                  {owned.length}
                  <small>{copyParts(t('family.pool.countStarted'))}</small>
                </span>
                <span>
                  {joined.length}
                  <small>{t('family.pool.countJoined')}</small>
                </span>
              </span>
            }
          />
        </MetricCards>

        {owned.length + ended.length === 0 ? (
          <div className="card empty">
            <b>{t('family.pool.emptyTitle')}</b>
            {t('family.pool.emptyBody')}
          </div>
        ) : (
          shown.length === 0 && <div className="card empty">{t('family.pool.filter.none')}</div>
        )}
        {view === 'list' && shown.length > 0 && (
          <CarTable
            state={state}
            today={today}
            rows={shown}
            books={books}
            years={years}
            live={live}
            duesOf={duesOf}
            owedOf={owedOf}
            sort={sort}
            dir={dir}
            onSort={headSort}
            onOpen={setSheet}
          />
        )}
        {/* 列数随宽度变化（每列至少约 340px）；各列独立：展开一张卡只撑高它所在的那一列 */}
        {view === 'grid' && (
          <div className="car-cols" ref={colsRef} style={{ '--car-columns': colCount } as React.CSSProperties}>
            {Array.from({ length: colCount }, (_, col) => (
              <div className="car-col" key={col}>
                {shown.map((s, idx) => {
                  if (idx % colCount !== col) return null;
                  const sh = s.share!;
                  const owing = duesOf(s).filter((d) => d.periodsOwed > 0);
                  // 已退出的成员不占座，只在展开的明细里保留
                  const free = carpoolRoster(s, today).vacancies;
                  const next = nextCharge(s, today);
                  return (
                    // 整张卡片打开合租弹窗；里面的按钮、链接和订阅名各管各的
                    <div
                      key={s.id}
                      className={`card stack car-card ${live(s) ? '' : 'stopped'}`}
                      style={{ '--car-order': idx } as React.CSSProperties}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => !(e.target as HTMLElement).closest('button, a, [role=link]') && setSheet(s.id)}
                      onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSheet(s.id))}
                    >
                      <div className="car-head">
                        <SubIcon sub={s} size={40} />
                        <div className="car-card-identity">
                          <div className="car-name">
                            <NameLink onClick={() => onOpen(s)}>{s.name}</NameLink>
                          </div>
                          <div className="muted car-sub">
                            {money(currentPhase(s, today).price, currentPhase(s, today).currency)} {cycleLabel(currentPhase(s, today).cycle)}
                            {copyParts(next && live(s) ? `\n${t('family.pool.next', { date: cnDate(next) })}` : '')}
                          </div>
                        </div>
                        {/* 只提示满没满车；空位的「+」放到展开后的「添加成员」 */}
                        {live(s) ? (
                          <span className={`car-seats ${free ? '' : 'full'}`}>
                            {free ? t('family.pool.seatsFree', { count: free }) : t('family.pool.seatsFull')}
                          </span>
                        ) : (
                          <StatusPill tone="stop">{t('family.pool.filter.ended')}</StatusPill>
                        )}
                      </div>
                      <div className="seats-row">
                        <ShareAvatars sub={s} state={state} today={today} onMember={(m) => setMember({ s, m })} />
                        <button className={`car-toggle ${expanded.has(s.id) ? 'open' : ''}`} onClick={() => toggle(s.id)} aria-expanded={expanded.has(s.id)}>
                          {/* 待收的人数和金额已在下面第三格，这里与代付卡的状态胶囊一样不再重复 */}
                          {owing.length ? t('family.pool.members') : sh.members.length ? t('family.pool.settled') : t('family.pool.noMembers')}
                          <Icon name="down" size={14} />
                        </button>
                      </div>
                      <CarFacts
                        book={books.get(s.id)!}
                        base={base}
                        owed={sumTotals(owing.map((d) => dueTotal(state, d, toBase(state, d.owed, d.currency))))}
                        owedCount={owing.length}
                      />
                      {expanded.has(s.id) && (
                        <>
                          {free > 0 && live(s) && (
                            <button className="btn tinted car-add-member" onClick={() => setMember({ s })}>
                              <Icon name="plus" /> {t('family.pool.addMemberSeats', { count: free })}
                            </button>
                          )}
                          <MemberRows state={state} s={s} today={today} onMember={(m) => setMember({ s, m })} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {joined.length > 0 && (
          <Group title={t('family.pool.joinedGroup')}>
            {joined.map((s) => (
              <Cell
                key={s.id}
                label={
                  <span className="row">
                    <SubIcon sub={s} size={30} />
                    {s.name}
                  </span>
                }
                sub={undefined}
                onClick={() => onOpen(s)}
              >
                {copyParts(
                  t('family.pool.payTo', {
                    name: s.share?.ownerName ?? t('family.pool.ownerDefault'),
                    amount: flow(-currentPhase(s, today).price, currentPhase(s, today).currency),
                  }),
                )}
              </Cell>
            ))}
          </Group>
        )}

        {candidates.length > 0 && (
          <Group title={t('family.pool.maybeGroup')}>
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
                    {t('family.pool.convert')}
                  </button>
                </span>
              </div>
            ))}
          </Group>
        )}
        {convert && <ConvertSheet state={state} s={convert} today={today} onClose={() => setConvert(null)} />}
        {sheetSub?.share && (
          <CarSheet
            state={state}
            s={sheetSub}
            today={today}

            book={books.get(sheetSub.id) ?? carLedger(state, sheetSub, today)}
            onClose={() => setSheet(null)}
            onOpenSub={() => {
              setSheet(null);
              onOpen(sheetSub);
            }}
            onMember={(m) => setMember({ s: sheetSub, m })}
            onPayment={(m, editId) => setMember({ s: sheetSub, m, editId })}
          />
        )}
        {/* 点成员、点收款、点某一笔收款都打开同一个成员入口：欠款先记收款，其余是成员表单 */}
        {member && (
          <MemberSheet
            state={state}
            s={state.subscriptions.find((x) => x.id === member.s.id) ?? member.s}
            member={member.m}
            editId={member.editId}
            onClose={() => setMember(null)}
            onOpenSub={() => {
              const sub = state.subscriptions.find((x) => x.id === member.s.id) ?? member.s;
              setMember(null);
              setSheet(null);
              onOpen(sub);
            }}
          />
        )}
      </div>
    </>
  );
}

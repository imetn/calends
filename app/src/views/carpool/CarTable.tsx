import { dueTotal, formatTotal, sumTotals } from '../../../../shared/fx-total.ts';
import { ShareAvatars } from '../../components/ShareAvatars.tsx';
import { diffDays, convert, type MemberDue, nextCharge } from '../../../../shared/billing.ts';
import { cnDate, cnDateFull, money, relDays } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';

import { LtHead, perMonths, PlanPrice } from '../../components/LtHead.tsx';
import { carLedger, carRule, carYear } from '../../../../shared/carpool.ts';
import { StatusPill, SubIcon } from '../../components/marks.tsx';
import { carpoolRoster } from '../../../../shared/carpool-timeline.ts';
import type { CarSort } from './common.ts';
import { CAR_SORT_DIR } from './common.ts';

/**
 * 合租的列表视图（桌面）：一行一辆车，比卡片多出套餐价格、收费标准、下次扣款与累计净额；点一行打开合租弹窗。
 * 各列按比例分宽度；表格变窄时先收起 data-p=2 的列，再收起 data-p=3。手机上不出表格，仍用卡片
 */
export function CarTable({
  state,
  today,
  rows,
  books,
  years,
  live,
  duesOf,
  owedOf,
  sort,
  dir,
  onSort,
  onOpen,
}: {
  state: AppState;
  today: string;
  rows: Subscription[];
  books: Map<string, ReturnType<typeof carLedger>>;
  years: Map<string, ReturnType<typeof carYear>>;
  live: (s: Subscription) => boolean;
  duesOf: (s: Subscription) => MemberDue[];
  owedOf: (s: Subscription) => number;
  sort: CarSort;
  dir: 'asc' | 'desc';
  onSort: (k: CarSort) => void;
  onOpen: (id: string) => void;
}) {
  const base = state.settings.baseCurrency;
  return (
    <div className="ltable-wrap">
      <div className="ltable lt-x car-lt" role="table">
        <LtHead<CarSort>
          initial={['owed', CAR_SORT_DIR.owed]}
          sort={sort}
          dir={dir}
          onSort={onSort}
          cols={[
            { label: t('list.col.name'), sort: 'name' },
            { label: t('family.pool.members') },
            { label: t('family.pool.status'), sort: 'owed' },
            { label: t('list.col.planPrice'), sort: 'price', p: 3, num: true },
            { label: t('family.rule.title'), p: 2, num: true },
            { label: t('list.col.next'), sort: 'next', num: true },
            { label: t('family.pool.yearPnl'), sort: 'net', num: true },
            { label: t('family.pool.totalPnl'), sort: 'profit', num: true },
          ]}
        />
        {rows.map((s) => {
          const book = books.get(s.id)!;
          const on = live(s);
          const free = carpoolRoster(s, today).vacancies;
          const next = on ? nextCharge(s, today) : undefined;
          const dues = duesOf(s).filter((d) => d.periodsOwed > 0);
          void owedOf;
          const year = years.get(s.id) ?? carYear(state, s, today);
          const rule = carRule(state, s, today);
          return (
            <button key={s.id} className={`lt-row ${on ? '' : 'st-ended'}`} role="row" onClick={() => onOpen(s.id)}>
              <span className="lt-name">
                <SubIcon sub={s} size={32} />
                <span className="lt-title">
                  <span className="nm">
                    <b>{s.name}</b>
                  </span>
                  {book.since && <small className="lt-sub">{t('family.strip.since', { date: cnDateFull(book.since) })}</small>}
                </span>
              </span>
              <span className="lt-members">
                {/* 家庭组一般最多 6 人：连同自己最多排 6 个头像；坐满不写，只标出空位 */}
                <ShareAvatars sub={s} state={state} today={today} size={22} max={6} />
                {on && free > 0 && <small>{t('family.pool.seatsFree', { count: free })}</small>}
              </span>
              {/* 状态胶囊：已停止 > 待收多少 > 已结清；还没有成员的写提示。放在左侧文字区，右边都是数字 */}
              <span className="lt-status">
                {!on ? (
                  <StatusPill tone="stop">{t('family.pool.filter.ended')}</StatusPill>
                ) : dues.length ? (
                  <StatusPill tone="owe">
                    {t('family.pool.owedAmount', {
                      amount: formatTotal(sumTotals(dues.map((d) => dueTotal(state, d, convert(d.owed, d.currency, base, state.fx)))), base, {
                        compact: true,
                      }),
                    })}
                  </StatusPill>
                ) : s.share!.members.length ? (
                  <StatusPill tone="done">{t('family.pool.settled')}</StatusPill>
                ) : (
                  <StatusPill tone="notice">{t('family.pool.noMembers')}</StatusPill>
                )}
              </span>
              <PlanPrice state={state} s={s} today={today} cost={year.cost} />
              {/* 已停止的车：收费、下次扣款、每年净额都不再有意义，留空 */}
              <span className="lt-num" data-p={2}>
                {!on ? null : s.share!.members.length ? (
                  <>
                    {money(rule.fee, rule.currency)}/{perMonths(rule.billEvery)}
                  </>
                ) : (
                  <small>—</small>
                )}
              </span>
              <span className="lt-num">
                {!on ? null : next ? (
                  <>
                    {cnDate(next)}
                    <small>{relDays(diffDays(today, next))}</small>
                  </>
                ) : (
                  <small>—</small>
                )}
              </span>
              {/* 当年盈亏：今年的成本对比成员今年的收入，小字是收入；停止与买断的车同样有今年的账 */}
              <span className="lt-num">
                <span className={year.partial.net.incomplete || Math.abs(year.net) < 0.5 ? undefined : year.net > 0 ? 'gain' : 'loss'}>
                  {formatTotal(year.partial.net, base, { direction: 1, compact: true })}
                </span>
                <small>{t('family.pool.incomeShort', { amount: formatTotal(year.partial.income, base, { direction: 1, compact: true }) })}</small>
              </span>
              {/* 累计盈亏：发起至今收回减付出，与代付的盈亏同一口径；与左边的当年盈亏成对 */}
              <span className={`lt-num ${book.partial.net.incomplete || Math.abs(book.net) < 0.5 ? '' : book.net < 0 ? 'gain' : 'loss'}`}>
                {Math.abs(book.net) < 0.5 ? t('proxy.table.even') : formatTotal(book.partial.net, base, { direction: -1, compact: true })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

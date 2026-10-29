import { chargesTotal, formatTotal, scaleTotal, sumTotals, type FxTotal } from '../../../shared/fx-total.ts';
import { paymentMethodGroups } from '../../../shared/payment-groups.ts';
import { copyParts } from '../components/copy.tsx';
import { useMemo } from 'react';
import { totals, chargeSources, myShareFactor } from '../../../shared/billing.ts';
import { monthLabel } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { chargeBaseOrNaN } from '../../../shared/fx.ts';
import { yearReview, type YearReview } from '../../../shared/metrics.ts';
import type { AppState } from '../../../shared/types.ts';
import { packCircles } from '../components/charts.tsx';
import { ShareSheet } from '../components/ShareSheet.tsx';
import { MetricCards, Metric } from '../components/ui.tsx';
import { SubIcon } from '../components/marks.tsx';
import { allCharges, catColor, firstStart, sortValue } from '../derive.ts';

type Style = 'receipt' | 'poster' | 'card' | 'stars';
const STYLES = (): Array<[Style, string]> => [
  ['poster', t('review.style.poster')],
  ['receipt', t('review.style.receipt')],
  ['card', t('review.style.card')],
  ['stars', t('review.style.stars')],
];

interface Ctx {
  r: YearReview;
  /** 显示用：「2026」，全部时为「2021–2026」 */
  year: string;
  /** 全部：从第一笔到今天的累计回顾 */
  all: boolean;
  /** 所有格：「张三」/「Alex's」；没填名字时是「我」/「My」 */
  whose: string;
  ongoing: boolean;
  m: (v: number, part?: FxTotal, average?: boolean) => string;
  /** 不显示金额：用占比、笔数、时长代替 */
  hide: boolean;
  /** 占这一年总花费的百分比 */
  pct: (v: number) => string;
  mrr: number;
  mrrPartial?: FxTotal;
  /** 这一年按支付方式分的花费 */
  byMethod: Array<{ id: string; name: string; sum: number; partial: FxTotal }>;
  today: string;
}

/** 年度回顾分享：选一种样式，生成图片后复制或下载 */
/** 年份在报告页工具栏选定，弹窗里不再切换；year 为 'all' 时是累计回顾 */
export function Review({ state, today, year, onClose }: { state: AppState; today: string; year: string; onClose: () => void }) {
  const r = useMemo(() => yearReview(state, today, year), [state, today, year]);
  const all = year === 'all';
  const from = all ? firstStart({ ...state, subscriptions: state.subscriptions.filter((s) => !s.proxy) }, today) : `${year}-01-01`;
  const to = all || `${year}-12-31` >= today ? today : `${year}-12-31`;
  const label = all ? (from.slice(0, 4) === today.slice(0, 4) ? today.slice(0, 4) : `${from.slice(0, 4)}–${today.slice(0, 4)}`) : year;
  const tot = totals(state, today);
  const pct = (v: number) =>
    !r.partial.total.incomplete && Number.isFinite(v) && Number.isFinite(r.total) ? `${r.total > 0 ? Math.round((v / r.total) * 100) : 0}%` : '—';
  const base = state.settings.baseCurrency;
  const byMethod = useMemo(() => {
    return paymentMethodGroups(
      state.methods,
      allCharges(state, from, to, today).flatMap((c) =>
        chargeSources(c).map((x) => ({ methodId: x.methodId, value: chargeBaseOrNaN(state, c) * myShareFactor(c.sub, c.date) * x.share, item: c })),
      ),
      t('review.unassigned'),
    )
      .map(({ id, name, sum }) => ({
        id,
        name,
        sum,
        partial: sumTotals(
          allCharges(state, from, to, today).flatMap((c) =>
            chargeSources(c)
              .filter((x) => x.methodId === id)
              .map((x) => scaleTotal(chargesTotal(state, [c]), myShareFactor(c.sub, c.date) * x.share)),
          ),
        ),
      }))
      .sort((a, b) => sortValue(b.sum) - sortValue(a.sum));
  }, [state, today, from, to]);
  return (
    <ShareSheet
      title={t(all ? 'review.titleAll' : 'review.title')}
      styles={STYLES()}
      prefKey="share-style"
      base={state.settings.baseCurrency}
      fileName={(l) => (all ? t('review.fileNameAll', { style: l }) : t('review.fileName', { year, style: l }))}
      onClose={onClose}
      render={(style, { hide, m }) => {
        const dn = state.settings.displayName;
        const ctx: Ctx = {
          r,
          year: label,
          all,
          whose: dn ? t('review.whose', { name: dn }) : t('review.whoseSelf'),
          ongoing: all || year === today.slice(0, 4),
          m: (v, part, average) => (!hide && part?.incomplete ? formatTotal(part, base, { direction: 1, average }) : m(v)),
          hide,
          pct,
          mrr: tot.mrr,
          mrrPartial: tot.partial.mrr,
          byMethod,
          today,
        };
        return style === 'receipt' ? (
          <Receipt {...ctx} />
        ) : style === 'poster' ? (
          <Poster {...ctx} />
        ) : style === 'card' ? (
          <Card {...ctx} />
        ) : (
          <Stars {...ctx} />
        );
      }}
    />
  );
}

function ReviewLoss({ r, all, hide, m }: Pick<Ctx, 'r' | 'all' | 'hide' | 'm'>) {
  return !hide && r.stopLoss !== 0 ? (
    <div className="review-loss">{t(all ? 'review.stopLossAll' : 'review.stopLoss', { amount: m(-r.stopLoss, scaleTotal(r.partial.stopLoss, -1)) })}</div>
  ) : null;
}

/** 两端对齐的一行：左边名称、右边金额，中间用空格撑开（小票打印机的排法） */
function Line({ l, r, b }: { l: string; r: string; b?: boolean }) {
  return (
    <div className={`rp-line ${b ? 'b' : ''}`}>
      <span>{l}</span>
      <span>{r}</span>
    </div>
  );
}

/** 小票：热敏纸机打风格。店名、机号、流水，逐项明细、按支付方式合计，底部条码和一句从数据里挑的话 */
function Receipt({ r, year, all, whose, ongoing, m, hide, pct, byMethod, today }: Ctx) {
  const items = r.items.slice(0, 12);
  const rest = r.items.slice(12);
  const restSum = rest.reduce((a, x) => a + x.sum, 0);
  const bars = Array.from({ length: 52 }, (_, i) => 1 + ((Math.abs(Math.round(Number.isFinite(r.total) ? r.total : 0)) * 7 + r.charges * 13 + i * 31) % 4));
  const amt = (v: number, part?: FxTotal) => (hide ? pct(v) : m(-v, part ? scaleTotal(part, -1) : undefined));
  const no = `${year.slice(-4)}${String(r.charges).padStart(4, '0')}`;
  return (
    <div className="rp">
      <div className="rp-c rp-shop">{copyParts(t('review.receipt.shop', { whose }).trim())}</div>
      <div className="rp-c rp-small">
        {copyParts(
          all ? t('review.receipt.all', { date: today }) : ongoing ? t('review.receipt.asOf', { date: today }) : t('review.receipt.fullYear', { year }),
        )}
      </div>
      <div className="rp-rule">{'='.repeat(60)}</div>
      <div className="rp-rule">{'-'.repeat(60)}</div>
      <Line l={t('review.receipt.item')} r={hide ? t('review.receipt.share') : t('review.receipt.amount')} />
      <div className="rp-rule">{'-'.repeat(60)}</div>
      {items.map((x) => (
        <Line key={x.sub.id} l={x.sub.name} r={amt(x.sum, r.partial.bySub[x.sub.id])} />
      ))}
      {rest.length > 0 && <Line l={t('review.receipt.rest', { count: rest.length })} r={amt(restSum, sumTotals(rest.map((x) => r.partial.bySub[x.sub.id])))} />}
      <div className="rp-rule">{'-'.repeat(60)}</div>
      <Line l={t('review.receipt.count', { items: r.items.length, charges: r.charges })} r="" />
      {!hide && <Line l={t('review.receipt.total')} r={m(-r.total, scaleTotal(r.partial.total, -1))} b />}
      {!hide && <div style={{ fontSize: 'var(--fs-1)' }}>{t('review.spendBasis')}</div>}
      <ReviewLoss r={r} all={all} hide={hide} m={m} />
      <div className="rp-rule">{'-'.repeat(60)}</div>
      {byMethod.slice(0, 5).map((x) => (
        <Line key={x.id} l={x.name} r={amt(x.sum, x.partial)} />
      ))}
      <div className="rp-rule">{'='.repeat(60)}</div>
      <div className="rp-bars">
        {bars.map((w, i) => (
          <i key={i} style={{ width: w, marginRight: i % 3 === 0 ? 2 : 1 }} />
        ))}
      </div>
      <div className="rp-c rp-small">{no}</div>
      <div className="rp-c rp-small">{location.host}</div>
    </div>
  );
}

/** 海报：大字年份 + 总额，下面是这一年所有订阅的图标，按花费分大中小三档，整齐地铺满 */
function Poster({ r, year, all, whose, ongoing, m, hide, pct }: Ctx) {
  const glow = r.items.slice(0, 3).map((x) => catColor(x.sub.category));
  // 第一名占 3×3，接下来四个占 2×2，其余 1×1；dense 排布让格子自动补齐
  const span = (i: number) => (i === 0 ? 3 : i < 5 ? 2 : 1);
  return (
    <div className="ps" style={{ '--g1': glow[0] ?? 'var(--c1)', '--g2': glow[1] ?? 'var(--c7)', '--g3': glow[2] ?? 'var(--c10)' } as Record<string, string>}>
      <div className="ps-year">{year}</div>
      <div className="ps-kicker">{copyParts(t(all ? 'review.poster.kickerAll' : 'review.poster.kicker', { whose }).trim())}</div>
      <div className="ps-total">{hide ? t('review.n.subs', { count: r.items.length }) : m(-r.total, scaleTotal(r.partial.total, -1))}</div>
      {!hide && <div style={{ fontSize: 'var(--fs-1)' }}>{t('review.spendBasis')}</div>}
      <ReviewLoss r={r} all={all} hide={hide} m={m} />
      <div className="ps-line">
        {copyParts(
          t(`review.poster.${ongoing ? 'ongoing' : 'year'}${hide ? 'Hidden' : ''}`, {
            charges: t('review.n.charges', { count: r.charges }),
            currencies: t('review.n.currencies', { count: r.currencies }),
            subs: t('review.n.subs', { count: r.items.length }),
          }),
        )}
      </div>
      <div className="ps-wall">
        {r.items.map((x, i) => (
          <span key={x.sub.id} className={`s${span(i)}`} title={x.sub.name}>
            <SubIcon sub={x.sub} size={span(i) === 3 ? 96 : span(i) === 2 ? 60 : 30} proxied />
          </span>
        ))}
      </div>
      <div className="ps-top">
        <small>{t('review.topSpend')}</small>
        <b>{r.items[0]?.sub.name ?? '—'}</b>
        <span>
          {copyParts(
            r.items[0]
              ? hide
                ? t(all ? 'review.ofAll' : 'review.ofYear', { pct: pct(r.items[0].sum) })
                : `${m(-r.items[0].sum, scaleTotal(r.partial.bySub[r.items[0].sub.id], -1))}\n${t(all ? 'review.ofAll' : 'review.ofYear', { pct: pct(r.items[0].sum) })}`
              : '',
          )}
        </span>
      </div>
      <div className="ps-foot">
        <span>
          {copyParts(
            hide
              ? t('review.poster.newEnded', { added: r.newSubs.length, ended: r.ended.length })
              : t('review.poster.perDay', { amount: m(-r.perDay, scaleTotal(r.partial.perDay, -1), true) }),
          )}
        </span>
        <span>{location.host}</span>
      </div>
    </div>
  );
}

/** 卡片：原来的深色年度回顾卡 */
function Card({ r, year, all, whose, ongoing, m, mrr, mrrPartial, hide, pct }: Ctx) {
  const top = Math.max(1, ...r.top.map((x) => r.partial.bySub[x.sub.id].value));
  return (
    <div className="review">
      <div className="rv-head">
        <span>{year}</span>
        <span>{copyParts(t('review.card.head', { whose }).trim())}</span>
      </div>
      <div className="rv-big">
        <small>{t(`review.card.intro.${all ? 'all' : ongoing ? 'ongoing' : 'year'}${hide ? 'Hidden' : ''}`)}</small>
        <span className="rv-total">{hide ? t('review.n.subs', { count: r.items.length }) : m(-r.total, scaleTotal(r.partial.total, -1))}</span>
        {!hide && <small>{t('review.spendBasis')}</small>}
        <ReviewLoss r={r} all={all} hide={hide} m={m} />
        <span>
          {copyParts(
            hide
              ? `${t('review.n.charges', { count: r.charges })}\n${t('review.n.currencies', { count: r.currencies })}`
              : `${t('review.n.charges', { count: r.charges })}\n${t('review.card.perDay', { amount: m(-r.perDay, scaleTotal(r.partial.perDay, -1), true) })}`,
          )}
        </span>
      </div>
      <div className="rv-sec">
        <div className="rv-label">{t('review.topSpend')}</div>
        {r.top.map((x, i) => (
          <div key={x.sub.id} className="rv-bar">
            <span className="rv-rank">{i + 1}</span>
            <SubIcon sub={x.sub} size={26} proxied />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rv-name">
                <span>{x.sub.name}</span>
                <b>{hide ? pct(x.sum) : m(-x.sum, scaleTotal(r.partial.bySub[x.sub.id], -1))}</b>
              </div>
              <div className="rv-track">
                <i style={{ width: `${(r.partial.bySub[x.sub.id].value / top) * 100}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <MetricCards>
        {r.longest && (
          <Metric
            label={t('review.card.longest')}
            value={r.longest.sub.name}
            note={t('review.card.duration', { y: Math.floor(r.longest.days / 365), m: Math.floor((r.longest.days % 365) / 30) })}
          />
        )}
        {r.busiestMonth && (
          <Metric
            label={t('review.card.busiest')}
            // 跨年时月份带上年份
            value={
              all
                ? monthLabel(r.busiestMonth.month.slice(0, 7))
                : t('review.card.month', {
                    n: Number(r.busiestMonth.month.slice(5)),
                    month: monthLabel(r.busiestMonth.month.slice(0, 7), { year: false, long: true }),
                  })
            }
            note={
              hide
                ? t(all ? 'review.ofAll' : 'review.ofYear', { pct: pct(r.busiestMonth.sum) })
                : m(-r.busiestMonth.sum, scaleTotal(r.partial.byMonth[r.busiestMonth.month], -1))
            }
          />
        )}
        <Metric
          label={t('review.card.newEnded')}
          value={
            <>
              {r.newSubs.length} / {r.ended.length}
            </>
          }
          note={r.ended.length ? t('review.card.ended', { count: r.ended.length }) : t('review.card.noneEnded')}
        />
        <Metric
          label={t('review.card.currencies')}
          value={t('review.card.currencyCount', { count: r.currencies })}
          note={
            hide
              ? t('review.n.charges', { count: r.charges })
              : t('review.card.nowMonthly', { amount: m(-mrr, mrrPartial ? scaleTotal(mrrPartial, -1) : undefined) })
          }
        />
      </MetricCards>
      <div className="rv-foot">{location.host}</div>
    </div>
  );
}

/** 星图：每个订阅一个圆，面积按这一年花的钱 */
function Stars({ r, year, all, whose, m, hide, pct }: Ctx) {
  const items = r.items.slice(0, 24);
  // 接近正方形地排布；坐标按宽度归一，高度 = h × 宽
  const bubbles = packCircles(
    items.map((x) => r.partial.bySub[x.sub.id].value),
    1.1,
  ) as Array<{ x: number; y: number; r: number; i: number; h: number }>;
  const W = 312;
  return (
    <div className="st">
      <div className="st-head">
        <span>{copyParts(t('review.stars.head', { year, whose }).trim())}</span>
        <b>{hide ? t('review.n.subs', { count: r.items.length }) : m(-r.total, scaleTotal(r.partial.total, -1))}</b>
      </div>
      {!hide && <div style={{ fontSize: 'var(--fs-1)' }}>{t('review.spendBasis')}</div>}
      <ReviewLoss r={r} all={all} hide={hide} m={m} />
      <div className="st-map" style={{ height: (bubbles[0]?.h ?? 1) * W }}>
        {bubbles.map((b) => {
          const x = items[b.i];
          const d = b.r * 2 * W;
          return (
            <span key={x.sub.id} className="st-b" style={{ left: (b.x - b.r) * W, top: (b.y - b.r) * W, width: d, height: d }}>
              <SubIcon sub={x.sub} size={Math.max(12, Math.round(d * 0.48))} proxied />
              {d > 70 && <small>{hide ? pct(x.sum) : m(-x.sum, scaleTotal(r.partial.bySub[x.sub.id], -1))}</small>}
            </span>
          );
        })}
      </div>
      <div className="st-foot">
        <span>{t('review.stars.foot')}</span>
        <span>{location.host}</span>
      </div>
    </div>
  );
}

import { DAYS_PER_MONTH, durationLabel } from '../../../shared/billing.ts';
import { copyParts } from '../components/copy.tsx';
import {
  chargesBetween,
  currentPhase,
  cycleLabel,
  diffDays,
  effectiveStatus,
  paidServedDays,
  phaseSubs,
  priceAt,
  servedTime,
  isStopped,
} from '../../../shared/billing.ts';
import { cnDate, cnDateFull, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';

/** 不是今年的日期带上年份 */
const when = (d: string, today: string) => (d.slice(0, 4) === today.slice(0, 4) ? cnDate(d) : cnDateFull(d));
import { chargeBaseOrNaN, chargeValue } from '../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { ShareSheet } from '../components/ShareSheet.tsx';
import { MetricCards, Metric } from '../components/ui.tsx';
import { FlagImg, SubIcon } from '../components/marks.tsx';
import { catColor } from '../derive.ts';

type Style = 'card' | 'receipt' | 'timeline' | 'poster' | 'years';
const STYLES = (): Array<[Style, string]> => [
  ['card', t('share.style.card')],
  ['receipt', t('share.style.receipt')],
  ['timeline', t('share.style.timeline')],
  ['poster', t('share.style.poster')],
  ['years', t('share.style.years')],
];

/** 一个订阅的完整故事：花了多少、订了多久、换过几次、每年多少 */
function story(state: AppState, sub: Subscription, today: string) {
  const base = state.settings.baseCurrency;
  const charges = chargesBetween(sub, sub.start, today, today).filter((c) => c.kind !== 'failed');
  // 图形（柱高）用缺汇率按 0 的值；显示的合计与年度金额缺汇率时为 NaN，显示「—」
  const values = charges.map((c) => chargeValue(state, c));
  const total = charges.reduce((a, c) => a + chargeBaseOrNaN(state, c), 0);
  const vs = phaseSubs(sub);
  // 并行的阶段不重复计天数；断档只算前面各段都已结束的空档
  const { days: active, gaps } = servedTime(sub, today);
  // 均摊分母：预付费算到已付那期结束
  const paid = paidServedDays(sub, charges, today);
  const years = new Map<string, number>();
  charges.forEach((c, i) => years.set(c.date.slice(0, 4), (years.get(c.date.slice(0, 4)) ?? 0) + values[i]));
  const yearMissing = new Set(charges.filter((c) => !Number.isFinite(chargeBaseOrNaN(state, c))).map((c) => c.date.slice(0, 4)));
  const first = vs[0];
  const cur = currentPhase(sub, today);
  const p0 = priceAt(first, first.start);
  const p1 = priceAt(cur, today < cur.start ? cur.start : today);
  const same = first.currency === cur.currency && first.cycle.unit === cur.cycle.unit && first.cycle.every === cur.cycle.every && p0 > 0;
  const y = Math.floor(active / 365);
  const mo = Math.floor((active % 365) / DAYS_PER_MONTH);
  return {
    base,
    charges,
    values,
    total,
    vs,
    cur,
    active,
    gaps,
    years: [...years].sort((a, b) => a[0].localeCompare(b[0])),
    yearMissing,
    duration: y
      ? mo
        ? t('share.dur.ym', { y, m: mo })
        : t('share.dur.y', { count: y })
      : mo
        ? t('share.dur.m', { count: mo })
        : t('share.dur.d', { count: active }),
    perMonth: active > 0 ? total / Math.max(1, paid / DAYS_PER_MONTH) : 0,
    perDay: active > 0 ? total / Math.max(1, paid) : 0,
    change: same ? p1 / p0 - 1 : undefined,
    p0,
    p1,
    status: effectiveStatus(sub, today),
  };
}
type Story = ReturnType<typeof story>;
interface Ctx {
  sub: Subscription;
  st: Story;
  hide: boolean;
  m: (v: number, ccy?: string) => string;
  today: string;
}

const statusText = (st: Story) => t(`share.status.${st.status}`);
const changeText = (st: Story) =>
  st.change == null
    ? t('share.switched', { count: st.vs.length - 1 })
    : Math.abs(st.change) < 0.005
      ? t('share.priceSame')
      : t(st.change > 0 ? 'share.priceUp' : 'share.priceDown', { pct: Math.round(Math.abs(st.change) * 100) });

/** 单个订阅的分享图 */
export function SubShare({ sub, state, today, onClose }: { sub: Subscription; state: AppState; today: string; onClose: () => void }) {
  const st = story(state, sub, today);
  return (
    <ShareSheet
      title={t('share.title', { name: sub.name })}
      styles={STYLES()}
      prefKey="sub-share-style"
      base={st.base}
      fileName={(l) => `${sub.name}-${l}.png`}
      onClose={onClose}
      render={(style, { hide, m }) => {
        const ctx: Ctx = { sub, st, hide, m, today };
        return style === 'card' ? (
          <SCard {...ctx} />
        ) : style === 'receipt' ? (
          <SReceipt {...ctx} />
        ) : style === 'timeline' ? (
          <STimeline {...ctx} />
        ) : style === 'poster' ? (
          <SPoster {...ctx} />
        ) : (
          <SYears {...ctx} />
        );
      }}
    />
  );
}

/** 卡片：深色，总额 + 四格指标 + 一条按阶段着色的时间条 */
function SCard({ sub, st, hide, m, today }: Ctx) {
  const start = st.vs[0].start;
  const span = Math.max(1, diffDays(start, today));
  const colors = ['var(--c1)', 'var(--c4)', 'var(--c5)', 'var(--c3)', 'var(--c6)', 'var(--c7)'];
  return (
    <div className="sc">
      <div className="sc-head">
        <SubIcon sub={sub} size={44} proxied />
        <div>
          <b>{sub.name}</b>
          <span>
            {statusText(st)} <span className="copy-gap" aria-hidden="true" /> {t('share.since', { date: when(start, today) })}
          </span>
        </div>
      </div>
      <small className="sc-k">{hide ? t('share.together') : t('share.totalSpent')}</small>
      <div className="sc-big">{hide ? st.duration : m(-st.total)}</div>
      <MetricCards>
        <Metric label={hide ? t('share.charges') : t('share.subscribed')} value={hide ? t('share.times', { count: st.charges.length }) : st.duration} />
        <Metric label={hide ? t('share.gaps') : t('share.realMonthly')} value={hide ? t('share.times', { count: st.gaps.length }) : m(-st.perMonth)} />
        <Metric label={t('share.price')} value={changeText(st)} />
        <Metric
          label={hide ? t('share.phases') : t('share.charges')}
          value={hide ? t('share.phaseCount', { count: st.vs.length }) : t('share.times', { count: st.charges.length })}
        />
      </MetricCards>
      <div className="sc-bar">
        {st.vs.map((v, i) => {
          const end = v.end && v.end < today ? v.end : today;
          if (v.start > today) return null;
          return (
            <i
              key={v.start}
              style={{
                left: `${(diffDays(start, v.start) / span) * 100}%`,
                width: `${Math.max(1, (diffDays(v.start, end) / span) * 100)}%`,
                background: colors[i % colors.length],
              }}
            />
          );
        })}
      </div>
      <div className="sc-foot">
        <span>{t('share.untilToday', { date: when(start, today) })}</span>
        <span>{location.host}</span>
      </div>
    </div>
  );
}

/** 小票：逐笔列出扣款，最后合计；隐藏金额时列出每期的地区和日期 */
function SReceipt({ sub, st, hide, m, today }: Ctx) {
  const end = st.cur.stop?.date ?? st.cur.end ?? sub.end;
  const farewell = isStopped(st.status)
    ? end
      ? t('share.stoppedOn', { date: cnDateFull(end) })
      : statusText(st)
    : st.status === 'ending' && end
      ? t('share.endsOn', { date: cnDateFull(end) })
      : st.status === 'paused'
        ? statusText(st)
        : t('share.thanks');
  const rows = st.charges.map((c, i) => ({ c, v: st.values[i] })).reverse();
  const shown = rows.slice(0, 14);
  const rest = rows.slice(14);
  const bars = Array.from({ length: 46 }, (_, i) => 1 + (((Math.round(st.total) || 0) * 7 + st.charges.length * 13 + i * 31) % 4));
  return (
    <div className="rc">
      <div className="rc-shop">{sub.name}</div>
      <div className="rc-sub">SUBSCRIPTION RECEIPT</div>
      <div className="rc-meta">
        <span>{t('share.since', { date: when(st.vs[0].start, today) })}</span>
        <span>{statusText(st)}</span>
      </div>
      <div className="rc-cut" />
      {shown.map(({ c, v }, i) => (
        <div key={i} className="rc-row">
          <span className="rc-d">{c.date}</span>
          <span className="rc-n">
            {c.kind === 'refund' ? (
              t('share.refund')
            ) : c.sub.region ? (
              <>
                <FlagImg cc={c.sub.region} /> {c.sub.region}
              </>
            ) : (
              cycleLabel(c.sub.cycle)
            )}
          </span>
          <span className={`rc-v ${c.amount < 0 ? 'green' : ''}`}>
            {hide ? (c.kind === 'refund' ? t('share.refundShort') : t('share.nth', { n: rows.length - i })) : m(-c.amount, c.currency)}
          </span>
          {!hide && c.currency !== st.base && <span className={`rc-x ${v < 0 ? 'green' : ''}`}>≈{m(-v)}</span>}
        </div>
      ))}
      {rest.length > 0 && (
        <div className="rc-row">
          <span className="rc-d" />
          <span className="rc-n">{t('share.earlier', { count: rest.length })}</span>
          <span className="rc-v">{hide ? '' : m(-rest.reduce((a, x) => a + x.v, 0))}</span>
        </div>
      )}
      <div className="rc-cut" />
      <div className="rc-sum">
        <span>{hide ? t('share.time') : t('share.total')}</span>
        <b>{hide ? st.duration : m(-st.total)}</b>
      </div>
      <div className="rc-kv">
        <span>{t('share.chargeCount')}</span>
        <span>{t('share.count', { count: st.charges.length })}</span>
      </div>
      <div className="rc-kv">
        <span>{hide ? t('share.switches') : t('share.realMonthly')}</span>
        <span>{hide ? t('share.times', { count: st.vs.length - 1 }) : m(-st.perMonth)}</span>
      </div>
      <div className="rc-kv">
        <span>{t('share.price')}</span>
        <span>{changeText(st)}</span>
      </div>
      <div className="rc-cut" />
      <div className="rc-bars">
        {bars.map((w, i) => (
          <i key={i} style={{ width: w, marginRight: i % 3 === 0 ? 2 : 1 }} />
        ))}
      </div>
      <div className="rc-thanks">{farewell}</div>
      <div className="rc-site">{location.host}</div>
    </div>
  );
}

/** 历程：竖向时间线，每段一个节点，断档单独一行 */
function STimeline({ sub, st, hide, m, today }: Ctx) {
  const items: Array<{ key: string; gap?: number; v?: Subscription; from: string; to?: string }> = [];
  st.vs.forEach((v, i) => {
    const g = st.gaps.find((x) => x.to === v.start);
    if (i && g) items.push({ key: `g${v.start}`, gap: g.days, from: g.from, to: g.to });
    items.push({ key: v.start, v, from: v.start, to: v.end });
  });
  return (
    <div className="tlc" style={{ '--tint': catColor(sub.category) } as Record<string, string>}>
      <div className="tlc-head">
        <SubIcon sub={sub} size={48} proxied />
        <div>
          <b>{sub.name}</b>
          <span>
            {st.duration} <span className="copy-gap" aria-hidden="true" />{' '}
            {hide ? t('share.n.charges', { count: st.charges.length }) : t('share.sum', { amount: m(-st.total) })}
          </span>
        </div>
      </div>
      <div className="tlc-list">
        {items.map((it) =>
          it.gap ? (
            <div key={it.key} className="tlc-gap">
              {t('share.gap', { dur: durationLabel(it.gap) })}
            </div>
          ) : (
            <div key={it.key} className={`tlc-item ${it.v!.planned ? 'planned' : ''}`}>
              <i />
              <div>
                <small>
                  {when(it.from, today)} —{' '}
                  {it.to ? (it.to > today ? t('share.planned', { date: when(it.to, today) }) : when(it.to, today)) : t('share.present')}
                </small>
                <b>
                  {it.v!.region ? (
                    <>
                      <FlagImg cc={it.v!.region} /> {it.v!.region} <span className="copy-gap" aria-hidden="true" />{' '}
                    </>
                  ) : null}
                  {hide ? cycleLabel(it.v!.cycle) : `${money(it.v!.price, it.v!.currency, { compact: true })} ${cycleLabel(it.v!.cycle)}`}
                </b>
                {(it.v!.priceHistory?.length ?? 0) > 1 && !hide && (
                  <span>
                    {t('share.priceChanges', { list: it.v!.priceHistory!.map((p) => money(p.amount, it.v!.currency, { compact: true })).join(' → ') })}
                  </span>
                )}
                {sub.phases?.find((ph) => ph.start === it.v!.start)?.note && <span>{sub.phases!.find((ph) => ph.start === it.v!.start)!.note}</span>}
              </div>
            </div>
          ),
        )}
      </div>
      <div className="tlc-foot">{location.host}</div>
    </div>
  );
}

/** 海报：大图标 + 「陪伴了多久」 + 总额 */
function SPoster({ sub, st, hide, m }: Ctx) {
  return (
    <div className="sp" style={{ '--tint': catColor(sub.category) } as Record<string, string>}>
      <div className="sp-icon">
        <SubIcon sub={sub} size={112} proxied />
      </div>
      <div className="sp-name">{sub.name}</div>
      <div className="sp-k">{t('share.withYou')}</div>
      <div className="sp-big">{st.duration}</div>
      <div className="sp-line">
        {copyParts(
          hide
            ? `${t('share.n.charges', { count: st.charges.length })}\n${changeText(st)}`
            : t('share.totalPerDay', { total: m(-st.total), perDay: m(-st.perDay) }),
        )}
      </div>
      <div className="sp-chips">
        {st.status !== 'active' && st.status !== 'lifetime' && <span>{statusText(st)}</span>}
        {st.gaps.length > 0 && <span>{t('share.lapsed', { count: st.gaps.length })}</span>}
        {st.vs.length > 1 && <span>{t('share.switched', { count: st.vs.length - 1 })}</span>}
        {st.change != null && <span>{changeText(st)}</span>}
      </div>
      <div className="sp-foot">{location.host}</div>
    </div>
  );
}

/** 逐年：每年花了多少的柱状图 */
function SYears({ sub, st, hide, m }: Ctx) {
  const max = Math.max(1, ...st.years.map(([, v]) => v));
  return (
    <div className="sy">
      <div className="sy-head">
        <SubIcon sub={sub} size={36} proxied />
        <div>
          <b>{sub.name}</b>
          <span>{t('share.byYear')}</span>
        </div>
      </div>
      <div className="sy-big">{hide || st.years.length === 1 ? st.duration : m(-st.total)}</div>
      <div className="sy-bars">
        {st.years.map(([y, v]) => (
          <div key={y} className="sy-col">
            <span className="sy-v">{st.yearMissing.has(y) ? '—' : hide ? `${st.total > 0 ? Math.round((v / st.total) * 100) : 0}%` : m(-v)}</span>
            <i style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
            <span className="sy-y">{y}</span>
          </div>
        ))}
      </div>
      <div className="sy-foot">
        <span>
          {t('share.n.charges', { count: st.charges.length })} <span className="copy-gap" aria-hidden="true" /> {changeText(st)}
        </span>
        <span>{location.host}</span>
      </div>
    </div>
  );
}

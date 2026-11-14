import { addDays, billingPeriod, currentPhase, diffDays, effectiveStatus, isSeparate, memberAboard, renewalDates } from '../../../../shared/billing.ts';
import { carRule, collectionPeriod, memberStatus } from '../../../../shared/carpool.ts';
import { cnDateAuto } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { detailForecast } from '../detail-data.ts';

/**
 * 本期：只画当前这一期，不画历史各期。左端本期开始，右端到期，填充到今天；
 * 刻度标最晚取消日，提前扣款时另标扣款日；试用期、赠送期换颜色和名称。
 * 刻度的日期写在下面一行图例里，不在条上叠标签。split 时与收费周期并排，标题改为「订阅周期」
 */
export function PeriodBar({ sub, today, split = false }: { sub: Subscription; today: string; split?: boolean }) {
  const st = effectiveStatus(sub, today);
  const next = detailForecast(sub, today).charges[0];
  if (!next) return null;
  const renewal = renewalDates(sub, addDays(today, 1));
  const bonus = sub.bonus && sub.bonus.from <= today && today <= sub.bonus.until ? sub.bonus : undefined;
  const bp = billingPeriod(sub, today);
  const kind: 'trial' | 'bonus' | 'paid' = st === 'trial' ? 'trial' : bonus ? 'bonus' : 'paid';
  const from = bonus ? bonus.from : bp.from > today ? today : bp.from;
  // 分开记：本期就是今天所在的账单期，预缴了后面几期也不拉长
  const end = bonus
    ? addDays(bonus.until, 1)
    : isSeparate(currentPhase(sub, today))
      ? addDays(bp.paidThrough, 1)
      : renewal.serviceExpires && renewal.serviceExpires > next.date
        ? renewal.serviceExpires
        : next.date;
  const cancelBy = renewal.cancelBy && renewal.cancelBy >= today && renewal.cancelBy < end ? renewal.cancelBy : undefined;
  const charge = next.date > today && next.date < end ? next.date : undefined;
  const title = t(split && kind === 'paid' ? 'detail.period.sub' : `detail.period.${kind}`);
  return <Bar kind={kind} title={title} from={from} end={end} today={today} short={split} cancelBy={cancelBy} charge={charge} />;
}

/** 一条周期进度：end 是下一期的第一天，图例写到前一天 */
function Bar({
  kind,
  title,
  from,
  end,
  today,
  short,
  cancelBy,
  charge,
}: {
  kind: string;
  title: string;
  from: string;
  end: string;
  today: string;
  short: boolean;
  cancelBy?: string;
  charge?: string;
}) {
  const span = Math.max(1, diffDays(from, end));
  const at = (d: string) => `${Math.min(100, Math.max(0, (diffDays(from, d) / span) * 100))}%`;
  const pct = Math.round(Math.min(1, Math.max(0, diffDays(from, today) / span)) * 100);
  return (
    <div className={`dt-period ${kind}`}>
      <p className="dt-period-h">
        <b>{title}</b>
        {/* 并排时位置窄，只写百分比 */}
        <span>{short ? `${pct}%` : t('detail.renewal.elapsed', { pct })}</span>
      </p>
      <div className="dt-period-bar" role="img" aria-label={`${title} ${t('detail.renewal.elapsed', { pct })}`}>
        <i style={{ width: `${pct}%` }} />
        {cancelBy && <b className="cb" style={{ left: at(cancelBy) }} />}
        {charge && <b className="ch" style={{ left: at(charge) }} />}
      </div>
      <p className="dt-period-ends">
        <span>{cnDateAuto(from, today)}</span>
        <span>{cnDateAuto(addDays(end, -1), today)}</span>
      </p>
      {cancelBy && (
        <p className="dt-period-keys">
          <span className="cb">
            <i />
            {t('core.renewal.cancelBy')} {cnDateAuto(cancelBy, today)}
          </span>
        </p>
      )}
    </div>
  );
}

/** 计费中（未结束、未暂停、非买断）才画本期进度 */
export const periodLive = (sub: Subscription, today: string) => !['ended', 'terminated', 'lifetime', 'paused'].includes(effectiveStatus(sub, today));

/**
 * 我发起且仍在计费的合租：今天所在的收款期；其余为 undefined。
 * 在车上、要分摊的成员本期到期日不一样时（收费周期或起算日因人而异）也是 undefined，成员表的时间线已经说明各人的周期；
 * 还没有要分摊的成员时按车的收费规则推算
 */
export function collectNow(sub: Subscription, state: AppState, today: string) {
  if (!periodLive(sub, today) || sub.share?.role !== 'owner') return undefined;
  const paying = sub.share.members.filter((m) => memberAboard(m, today) && !m.exempt);
  if (!paying.length) return collectionPeriod(sub, carRule(state, sub, today).billEvery, today);
  // 中途上车的人首期按天折算、开始日晚一些，但和大家同一天到期，仍算同一个周期；条从最早的开始日画起
  const now = paying.map((m) => memberStatus(state, sub, m, today).period);
  if (new Set(now.map((p) => p.until)).size > 1) return undefined;
  return { from: now.map((p) => p.from).sort()[0], next: addDays(now[0].until, 1) };
}

/** 订阅周期与收费周期左右并排；订阅详情与合租详情共用 */
export function PeriodPair({ sub, today, collect }: { sub: Subscription; today: string; collect: { from: string; next: string } }) {
  return (
    <div className="dt-period-pair">
      <PeriodBar sub={sub} today={today} split />
      <Bar kind="collect" title={t('detail.period.collect')} from={collect.from} end={collect.next} today={today} short />
    </div>
  );
}

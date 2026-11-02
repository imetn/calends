import { copyParts } from '../../components/copy.tsx';
import {
  activePhases,
  currentPhase,
  cycleLabel,
  diffDays,
  effectiveStatus,
  isPostpaid,
  phaseSubs,
  priceAt,
  stopSummary,
  upcomingPhase,
} from '../../../../shared/billing.ts';
import { flow, cnDateFull, money, relDays } from '../../../../shared/format.ts';
import { stopLosses } from '../../../../shared/metrics.ts';
import { transferredStop } from '../../../../shared/transfers.ts';
import { convertOn } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { CardTitle } from '../../components/ui.tsx';
import { PayBadge } from '../../components/marks.tsx';
import { run } from '../../toast.ts';
import { saveSub } from '../../store.ts';
import { confirmPlan, dropPlan } from '../../../../shared/phases.ts';
import { t } from '../../../../shared/i18n.ts';
import { Panel, Prop } from '../../components/DetailKit.tsx';
import { Region } from './shared.tsx';
import { methodOf } from './shared.tsx';

/** 停止卡片：放在顶部，一句话说清怎么停的、退了多少、亏了多少；每个停止阶段各一张 */
export function Outcome({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const stopped = phaseSubs(sub).filter((phase) => phase.stop);
  const losses = stopLosses({ ...state, subscriptions: [sub] }, today).items;
  const base = state.settings.baseCurrency;
  if (!stopped.length) return null;
  return (
    <>
      {stopped.map((phase) => {
        const sm = stopSummary(phase, today)!;
        const loss = losses.find((item) => item.phase.start === phase.start);
        // 卖出时剩余服务随转让收回：不写已付未用损失，改写卖出日
        const sold = transferredStop(phase);
        if (sold) sm.unusedValue = 0;
        // 后付费没有预付期：不写原本付到日；没有退款记录时也不写退款
        const postpaid = isPostpaid(phase);
        return (
          <section key={phase.start} className={`dt-panel dt-outcome ${sm.kind === 'terminate' ? 'bad' : ''} ${sm.unusedValue > 0 ? 'lossy' : ''}`}>
            <div className="dt-ph row">
              <CardTitle>{t(sm.kind === 'terminate' ? 'core.stop.terminate' : 'report.stops.cancel')}</CardTitle>
            </div>
            {sm.unusedValue > 0 && (
              <div className="dt-oc-loss">
                <b>{flow(-(loss?.loss ?? sm.unusedValue), phase.currency)}</b>
                <small>
                  {copyParts(
                    [
                      t('core.stop.lossTitle'),
                      t('core.stop.lossDays', { count: sm.wastedDays }),
                      phase.currency !== base
                        ? `≈ ${flow(-(loss?.lossBase ?? convertOn(sm.unusedValue, phase.currency, base, sm.date, state.fxHistory, state.fx)), base)}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join('\n'),
                  )}
                </small>
              </div>
            )}
            {/* 停用原因是一句话，跟在金额下面，不挤到标题行最右边 */}
            {sm.kind === 'terminate' && sm.reason && <p className="dt-oc-reason">{sm.reason}</p>}
            <dl className="dt-props">
              <Prop k={t('core.stop.date')}>{cnDateFull(sm.date)}</Prop>
              {!postpaid && <Prop k={t('detail.stop.paidThrough')}>{cnDateFull(sm.paidThrough)}</Prop>}
              {sold && <Prop k={t('detail.transfer.kind.sell')}>{cnDateFull(sold.date)}</Prop>}
              {(!postpaid || sm.refunded > 0) && (
                <Prop k={t('editor.payment.kind.refund')}>
                  {sm.refunded > 0 ? (
                    <span className="dt-in">
                      {(phase.payments ?? []).filter((p) => p.kind === 'refund' && p.date >= sm.date && p.date <= today).length > 1
                        ? flow(sm.refunded, phase.currency)
                        : t(sm.refundStatus === 'full' ? 'core.stop.fullyRefunded' : 'core.stop.partial', { money: '' }).trim()}
                    </span>
                  ) : (
                    t('core.stop.refundNo')
                  )}
                </Prop>
              )}
            </dl>
          </section>
        );
      })}
    </>
  );
}

/** 提醒：停止结果、并行方案、即将变更或计划变更、首期优惠；有结论或待操作，放在指标下方通栏 */
export function Notices({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const st = effectiveStatus(sub, today);
  const cur = currentPhase(sub, today);
  const up = upcomingPhase(sub, today);
  const parallel = sub.phases?.length ? activePhases(sub, today).filter((v) => v.start !== cur.start) : [];
  return (
    <div className="dt-notices">
      <Outcome sub={sub} state={state} today={today} />
      {parallel.length > 0 && (
        <Panel title={t('detail.overlap.title')}>
          <dl className="dt-props one">
            {parallel.map((v) => (
              <Prop
                key={v.start}
                k={
                  <span className="dt-inline">
                    {v.region ? <Region cc={v.region} /> : t('detail.overlap.previous')}
                    <PayBadge m={methodOf(state, v.methodId)} />
                  </span>
                }
                hint={t('detail.overlap.until', { date: cnDateFull(v.end!), rel: relDays(diffDays(today, v.end!)) })}
              >
                {money(v.price, v.currency)} <span className="copy-gap" aria-hidden="true" /> {cycleLabel(v.cycle)}
              </Prop>
            ))}
          </dl>
        </Panel>
      )}

      {up && (
        <Panel
          title={up.planned ? t('detail.up.planned') : st === 'upcoming' ? t('detail.up.starting') : t('detail.up.changing')}
          // 待确认的计划：取舍按钮放在标题右侧，结论和操作同一眼看到
          aside={
            up.planned ? (
              <div className="dt-plan">
                <button
                  className="dt-btn"
                  onClick={() => run(() => saveSub(dropPlan(sub, up.start)), t('detail.plan.droppedToast', { date: cnDateFull(up.start) }))}
                >
                  {t('detail.plan.drop')}
                </button>
                <button className="dt-btn dark" onClick={() => run(() => saveSub(confirmPlan(sub, up.start)), t('detail.plan.confirmedToast'))}>
                  {t('detail.plan.confirm')}
                </button>
              </div>
            ) : undefined
          }
        >
          <dl className="dt-props one">
            <Prop k={t('detail.up.effective')} hint={relDays(diffDays(today, up.start))}>
              {cnDateFull(up.start)}
            </Prop>
            {up.region !== cur.region && up.region && (
              <Prop k={t('detail.field.region')}>
                <span className="dt-inline">
                  {cur.region && st !== 'upcoming' && (
                    <>
                      <Region cc={cur.region} /> →
                    </>
                  )}
                  <Region cc={up.region} />
                </span>
              </Prop>
            )}
            <Prop k={t('detail.field.amount')}>
              {st !== 'upcoming' && (up.price !== cur.price || up.currency !== cur.currency) ? `${money(cur.price, cur.currency)} → ` : ''}
              {money(up.price, up.currency)} <span className="copy-gap" aria-hidden="true" /> {cycleLabel(up.cycle)}
            </Prop>
            <Prop k={t('detail.field.method')}>
              <PayBadge m={methodOf(state, up.methodId)} />
            </Prop>
          </dl>
        </Panel>
      )}

      {/* 首期优惠还没结束才提醒；结束后写在历程里，图表里也画了省下的部分 */}
      {sub.intro && sub.intro.until > today && (
        <Panel title={t('detail.intro.title')}>
          <dl className="dt-props one">
            <Prop k={t('detail.intro.price')}>{money(sub.intro.price, sub.currency)}</Prop>
            <Prop k={t('detail.intro.until')}>{cnDateFull(sub.intro.until)}</Prop>
            <Prop k={t('detail.intro.then')}>{money(priceAt({ ...sub, intro: undefined }, sub.intro.until), sub.currency)}</Prop>
          </dl>
        </Panel>
      )}
    </div>
  );
}

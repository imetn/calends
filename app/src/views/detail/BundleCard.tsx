import { Plus } from 'lucide-react';
import { effectiveStatus, perLabel } from '../../../../shared/billing.ts';
import { bundleView, childrenOf, displayCycle, hasAnyBundleLink, isFreeBundlePhase } from '../../../../shared/bundle.ts';
import { money } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { SubIcon } from '../../components/marks.tsx';
import { TONE } from './shared.tsx';

/** 父订阅详情的「关联订阅」卡：列出当前或即将关联到它的附赠/加购，并可点击跳转或新增 */
export function BundleCard({
  sub,
  state,
  today,
  onOpen,
  onAddLinked,
  emptyOnly = false,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  onOpen?: (s: Subscription) => void;
  onAddLinked?: (parent: Subscription) => void;
  /** true 时只在没有子订阅时显示轻入口；false 时只在已有子订阅时显示完整卡片 */
  emptyOnly?: boolean;
}) {
  const items = childrenOf(sub.id, state.subscriptions, today);
  const canBeParent = !sub.proxy && !hasAnyBundleLink(sub);

  if (emptyOnly) {
    if (items.length > 0 || state.readonly || !canBeParent || !onAddLinked) return null;
    return (
      <div data-snapshot-hide="">
        <Panel className="dt-meters-empty">
          <button type="button" className="btn plain dt-meters-add" onClick={() => onAddLinked(sub)}>
            <Plus size={14} /> {t('detail.bundle.add')}
          </button>
        </Panel>
      </div>
    );
  }

  if (!items.length) return null;

  return (
    <Panel
      title={t('detail.bundle.title', { count: items.length })}
      className="dt-bundle"
      aside={
        !state.readonly &&
        canBeParent &&
        onAddLinked && (
          <button type="button" className="dt-btn sm dt-add" data-snapshot-hide="" onClick={() => onAddLinked(sub)}>
            <Plus size={14} /> {t('detail.charges.addShort')}
          </button>
        )
      }
    >
      <div className="dt-bundle-list">
        {items.map(({ sub: child, link, phase: cur, upcoming }) => {
          const view = bundleView(child, state.subscriptions);
          const st = effectiveStatus(view, today);
          const free = isFreeBundlePhase(cur);
          const cycle = displayCycle(cur, upcoming ? cur.start : today);
          return (
            <button key={child.id} type="button" className="dt-bundle-row" onClick={() => onOpen?.(child)}>
              <SubIcon sub={child} size={28} proxied />
              <span className="dt-bundle-main">
                <span className="dt-bundle-name">
                  <b>{child.name}</b>
                  {st !== 'active' && st !== 'lifetime' && (
                    <span className={`dt-badge dot ${TONE[st]}`}>
                      <i />
                      {t(`list.status.${st}`)}
                    </span>
                  )}
                </span>
                <small className="muted">
                  {t(link.follow === false ? 'detail.bundle.modeIndependent' : 'detail.bundle.modeFollow')}
                  {upcoming ? ` (${t('detail.bundle.upcoming')})` : ''}
                </small>
              </span>
              <span className="dt-bundle-price">
                {free ? (
                  <span className="dt-badge acc">{t('list.badge.included')}</span>
                ) : (
                  <span className="num">
                    {money(cur.price, cur.currency)}
                    <small>/{perLabel({ cycle })}</small>
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

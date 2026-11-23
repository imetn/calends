import { ChevronRight, Plus } from 'lucide-react';
import { currentPhase, effectiveStatus, perLabel } from '../../../../shared/billing.ts';
import { bundleSource, bundleView, childrenOf, displayCycle, followsParent, hasAnyBundleLink, isFreeBundlePhase } from '../../../../shared/bundle.ts';
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

/** 附属订阅详情顶部的「主订阅」卡：写明由谁附赠 / 是谁的加购、周期模式与主订阅当前状态，整行可跳到主订阅 */
export function ParentCard({ sub, state, today, onOpen }: { sub: Subscription; state: AppState; today: string; onOpen?: (s: Subscription) => void }) {
  const info = bundleSource(sub, state.subscriptions, today);
  if (!info) return null;
  const { parent } = info;
  const cur = currentPhase(bundleView(sub, state.subscriptions), today);
  const st = effectiveStatus(bundleView(parent, state.subscriptions), today);
  const follow = followsParent(cur);
  return (
    <Panel className="dt-bundle dt-parent">
      <div className="dt-bundle-list">
        <button type="button" className="dt-bundle-row" onClick={() => onOpen?.(parent)} disabled={!onOpen}>
          <SubIcon sub={parent} size={32} proxied />
          <span className="dt-bundle-main">
            <span className="dt-bundle-name">
              <b>{t(isFreeBundlePhase(cur) ? 'detail.bundle.fromFree' : 'detail.bundle.fromAddon', { name: parent.name })}</b>
            </span>
            <small className="muted">{t(follow ? 'detail.bundle.modeFollow' : 'detail.bundle.modeIndependent')}</small>
          </span>
          {st !== 'active' && st !== 'lifetime' && (
            <span className={`dt-badge dot ${TONE[st]}`}>
              <i />
              {t('detail.bundle.parentStatus', { status: t(`list.status.${st}`) })}
            </span>
          )}
          {onOpen && <ChevronRight size={16} className="dt-parent-go" />}
        </button>
      </div>
    </Panel>
  );
}

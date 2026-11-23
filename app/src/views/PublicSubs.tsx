import { copyParts } from '../components/copy.tsx';
import { Plus, X } from 'lucide-react';
import { effectiveStatus, isStopped } from '../../../shared/billing.ts';
import { bundleView } from '../../../shared/bundle.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { IconButton } from '../components/ui.tsx';
import { Sheet } from '../components/overlays.tsx';
import { SubIcon } from '../components/marks.tsx';
import { run } from '../toast.ts';
import { saveSettings } from '../store.ts';
import './public-subs.css';

/** 可以公开的订阅：代付涉及他人，从不公开；在订的排前面，其余按名称 */
export function publicCandidates(state: AppState, today: string): Subscription[] {
  const live = (s: Subscription) => (isStopped(effectiveStatus(bundleView(s, state.subscriptions), today)) ? 1 : 0);
  return state.subscriptions.filter((s) => !s.proxy).sort((a, b) => live(a) - live(b) || a.name.localeCompare(b.name));
}

/**
 * 公开页展示哪些订阅：展示中的是实心胶囊，点 × 取消展示；未展示的是虚线胶囊，点一下加回来。
 * 存的是「不展示」的名单，新加的订阅默认就会公开。
 */
export function PublicSubsSheet({ state, today, onClose }: { state: AppState; today: string; onClose: () => void }) {
  const all = publicCandidates(state, today);
  const hidden = new Set(state.settings.publicHidden ?? []);
  const shown = all.filter((s) => !hidden.has(s.id));
  const off = all.filter((s) => hidden.has(s.id));
  const save = (ids: string[]) => run(() => saveSettings({ publicHidden: ids.length ? ids : undefined }));
  return (
    <Sheet title={t('settings.open.publicSubs')} onClose={onClose}>
      <div className="pubs">
        <p className="pubs-hint">{t('settings.open.publicSubsHint')}</p>
        <div className="pubs-bar">
          <span>{copyParts(t('settings.open.publicShown', { count: shown.length }))}</span>
          <div className="sheet-actions">
            <button className="btn" disabled={!off.length} onClick={() => save([])}>
              {t('settings.open.publicShowAll')}
            </button>
            <button className="btn" disabled={!shown.length} onClick={() => save(all.map((s) => s.id))}>
              {t('settings.open.publicHideAll')}
            </button>
          </div>
        </div>
        {shown.length ? (
          <div className="pubs-chips">
            {shown.map((s) => (
              <span key={s.id} className="pubs-chip">
                <SubIcon sub={s} size={20} />
                <span className="pubs-name">{s.name}</span>
                <IconButton
                  className="pubs-x"
                  onClick={() => save([...hidden, s.id])}
                  title={t('settings.open.publicHideOne', { name: s.name })}
                  aria-label={t('settings.open.publicHideOne', { name: s.name })}
                >
                  <X size={13} strokeWidth={2.4} />
                </IconButton>
              </span>
            ))}
          </div>
        ) : (
          <div className="pubs-empty">{t('settings.open.publicNone')}</div>
        )}
        {off.length > 0 && (
          <>
            <div className="pubs-bar">
              <span>{copyParts(t('settings.open.publicOff2', { count: off.length }))}</span>
            </div>
            <div className="pubs-chips">
              {off.map((s) => (
                <button
                  key={s.id}
                  className="pubs-chip off"
                  onClick={() => save([...hidden].filter((id) => id !== s.id))}
                  title={t('settings.open.publicShowOne', { name: s.name })}
                >
                  <Plus size={14} strokeWidth={2.2} />
                  <SubIcon sub={s} size={20} />
                  <span className="pubs-name">{s.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

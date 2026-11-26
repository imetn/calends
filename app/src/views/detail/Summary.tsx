import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { IconButton } from '../../components/ui.tsx';
import { currentPhase, effectiveStatus, memberAboard, phaseSubs } from '../../../../shared/billing.ts';
import { bundleSource, followsParent, isFreeBundlePhase } from '../../../../shared/bundle.ts';
import { cnDateFull } from '../../../../shared/format.ts';
import type { AppState, ShareMember, Subscription } from '../../../../shared/types.ts';
import { CarMembers } from '../carpool/Members.tsx';
import { carRule } from '../../../../shared/carpool.ts';
import { t } from '../../../../shared/i18n.ts';
import { detailHistoryEnd } from '../detail-data.ts';
import { filesAt } from '../../../../shared/files.ts';
import { collectNow, contractNow, PeriodBar, PeriodPair, periodLive } from './Periods.tsx';
import { Note, Panel, Prop } from '../../components/DetailKit.tsx';

/** 详情：本期进度（我发起的合租另并排收费周期）、订阅期间、试用截止与付给谁；账号只在编辑里，备注放在详情最下面 */
export function Summary({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const st = effectiveStatus(sub, today);
  const cur = currentPhase(sub, today);
  const lifetime = sub.cycle.unit === 'lifetime' && phaseSubs(sub).length === 1;
  const live = periodLive(sub, today);
  const end = detailHistoryEnd(sub, today);
  const collect = collectNow(sub, state, today);
  const contract = contractNow(sub, today);
  const parentInfo = bundleSource(sub, state.subscriptions, today);
  const freeFollow = isFreeBundlePhase(cur) && followsParent(cur);
  // 免费跟随主订阅的权益本身没有扣款期，本期进度直接展示主订阅当前周期
  const barSub = freeFollow && parentInfo && periodLive(parentInfo.parent, today) ? parentInfo.parent : sub;
  const barTitle = barSub !== sub ? t('detail.bundle.parentPeriod') : undefined;
  return (
    <Panel className="dt-about">
      {collect || contract ? (
        <PeriodPair
          sub={sub}
          today={today}
          collect={collect}
          contract={contract}
          contractClip={!!contract && filesAt(state.files ?? [], sub.id, 'contract', contract.from).length > 0}
        />
      ) : (
        live && <PeriodBar sub={barSub} today={today} titleOverride={barTitle} />
      )}
      <dl className="dt-about-grid">
        {/* 计费中只画当前这一期；买断、未开始、已结束、暂停写订阅期间（买断的开始日就是那一笔扣款，不再重复） */}
        {!lifetime && !live && (
          <Prop className="dt-period-text" k={t('detail.field.period')}>
            {/* 还没开始：有停止日写到停止日，没有就只写开始日，不写「至今」 */}
            {st === 'upcoming'
              ? sub.end
                ? `${cnDateFull(sub.start)} – ${cnDateFull(sub.end)}`
                : cnDateFull(sub.start)
              : `${cnDateFull(sub.start)} – ${end.unknown ? t('detail.field.endedUnknown') : end.date ? cnDateFull(end.date) : t('detail.field.present')}`}
          </Prop>
        )}
        {/* 试用中顶部已写试用结束后的首次扣款，这里不再单列试用截止 */}
        {sub.trialEnd && st !== 'trial' && <Prop k={t('detail.field.trialEnd')}>{cnDateFull(sub.trialEnd)}</Prop>}
        {/* 加入别人的合租只有「付给谁」一项，放在详情里，不单独成卡 */}
        {sub.share?.role === 'member' && <Prop k={t('detail.share.payTo')}>{sub.share.ownerName ?? t('detail.share.host')}</Prop>}
      </dl>
    </Panel>
  );
}

/**
 * 备注不关键，放在详情最下面；右上角小眼睛悬停才出现，点了把备注打码，复制成图片时整块不带。
 * 显示时随图片导出；打码后眼睛常驻，方便再打开
 */
export function NoteBlock({ sub }: { sub: Subscription }) {
  const [masked, setMasked] = useState(false);
  if (!sub.notes) return null;
  return (
    <div data-snapshot-hide={masked || undefined}>
      <Panel
        title={t('editor.field.notes')}
        className={`dt-note-panel ${masked ? 'masked' : ''}`}
        aside={
          <IconButton
            className="dt-note-eye"
            data-snapshot-hide
            aria-label={t(masked ? 'family.sheet.showPersonal' : 'family.sheet.hidePersonal')}
            aria-pressed={masked}
            onClick={() => setMasked(!masked)}
          >
            {masked ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        }
      >
        {masked ? (
          <p className="dt-note-mask" aria-hidden>
            <span className="car-private">{'\u2007'.repeat(24)}</span>
          </p>
        ) : (
          <Note text={sub.notes} />
        )}
      </Panel>
    </div>
  );
}

/**
 * 合租：和合租详情用同一张成员表（收费、迷你时间线、收款状态），点一行看成员、记收款；
 * 标题右边进合租详情看收付款明细。只有我发起的合租才有这一块
 */
export function ShareCard({
  sub,
  state,
  today,
  onCar,
  onMember,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  onCar: () => void;
  onMember: (m?: ShareMember) => void;
}) {
  const share = sub.share;
  if (share?.role !== 'owner') return null;
  return (
    <Panel
      title={t('detail.share.owner', { count: share.members.filter((m) => memberAboard(m, today)).length + 1, seats: share.seats })}
      className="dt-share"
      aside={
        <button type="button" className="dt-link" onClick={onCar}>
          {t('detail.share.open')} ›
        </button>
      }
    >
      <CarMembers state={state} s={sub} today={today} onMember={onMember} billEvery={carRule(state, sub, today).billEvery} />
    </Panel>
  );
}

import { CopyImageButton } from '../components/CopyImageButton.tsx';
import { isStopped } from '../../../shared/billing.ts';
import { StopPanel } from '../components/StopPanel.tsx';
import { createPortal } from 'react-dom';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, CircleStop, Pause, Pencil, Play, Plus, Settings2, Share } from 'lucide-react';
import { addDays, chargesBetween, currentPhase, cycleLabel, effectiveStatus, isPostpaid, nextCharge, phaseSubs, priceAt, type Charge } from '../../../shared/billing.ts';
import { cnDateFull } from '../../../shared/format.ts';
import type { AppState, Payment, ShareMember, Subscription } from '../../../shared/types.ts';
import { CarSheet } from './carpool/CarSheet.tsx';
import { carLedger } from '../../../shared/carpool.ts';
import { MemberSheet } from './Members.tsx';
import { PaymentSheet } from './PaymentSheet.tsx';
import { IconButton } from '../components/ui.tsx';
import { CatChip, RegionTag, subRegion, SubIcon } from '../components/marks.tsx';
import { Sheet } from '../components/overlays.tsx';
import { run } from '../toast.ts';
import { saveSub } from '../store.ts';
import { snapshot } from '../snapshot.ts';
import { SubShare } from './SubShare.tsx';
import { reactivate } from '../../../shared/phases.ts';
import { t } from '../../../shared/i18n.ts';
import { useMoneyPair } from '../components/MoneyPair.tsx';
import { detailForecast } from './detail-data.ts';
import { DetailHead, DetailSheet } from '../components/DetailKit.tsx';
import { TransferSheet } from '../components/TransferSheet.tsx';
import type { Transfer } from '../../../shared/types.ts';
import { TONE } from './detail/shared.tsx';
import { Transfers } from './detail/Ledgers.tsx';
import { regular } from './detail/shared.tsx';
import { Kpis } from './detail/Kpis.tsx';
import { Timeline } from './detail/ChargeTimeline.tsx';
import { Events } from './detail/Events.tsx';
import { Summary } from './detail/Summary.tsx';
import { Notices } from './detail/Notices.tsx';
import { NoteBlock, ShareCard } from './detail/Summary.tsx';
import { Charges } from './detail/Ledgers.tsx';

/**
 * 详情顶部的操作按钮。宽屏：常用的带文字（胶囊），次要的只有图标（正圆）；
 * 窄屏：同高的胶囊与圆形图标操作，空间不足时整项换行
 */
export function Act({
  icon,
  label,
  onClick,
  href,
  round,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  round?: boolean;
  primary?: boolean;
}) {
  const inner = (
    <>
      <i className="dt-act-i">{icon}</i>
      <span className="dt-act-l">{label}</span>
    </>
  );
  const cls = `${round ? 'icon-btn dt-round' : 'btn dt-act'} ${primary ? 'primary' : ''}`;
  return href ? (
    <a className={cls} href={href} target="_blank" rel="noreferrer" title={label} aria-label={label}>
      {inner}
    </a>
  ) : round ? (
    <IconButton className="dt-round" onClick={onClick} title={label} aria-label={label}>
      {inner}
    </IconButton>
  ) : (
    <button className={cls} onClick={onClick} title={label} aria-label={label}>
      {inner}
    </button>
  );
}

/** 把详情复制成图片：和弹窗一样的圆角，圆角外透明；去掉顶部按钮 */
export async function detailImage(el: HTMLElement) {
  const sheet = el.closest<HTMLElement>('.sheet') ?? el;
  return (await snapshot(el, {
    radius: getComputedStyle(sheet).borderRadius,
    filter: (node) => !node.matches('.dt-actions, .dt-add, .dt-note .dt-link'),
  }))!;
}

export function Detail({ sub, state, today, onEdit, onClose }: { sub: Subscription; state: AppState; today: string; onEdit: () => void; onClose: () => void }) {
  const pair = useMoneyPair(state);
  const st = effectiveStatus(sub, today);
  const next = nextCharge(sub, addDays(today, 1));
  // 显示今天生效的那一段（换区前仍是旧区的价格与支付方式），未来的变更单独列出
  const cur = currentPhase(sub, today);
  const history = chargesBetween(sub, sub.start, today, today);
  const [pay, setPay] = useState<{ pay?: Payment; index?: number; phase?: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [share, setShare] = useState(false);
  // 合租弹窗：从详情的合租区点进去，看收了多少、付了多少；成员资料再叠一层
  const [car, setCar] = useState(false);
  const [member, setMember] = useState<{ m?: ShareMember } | null>(null);
  const [transfer, setTransfer] = useState<{ index?: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const nowPrice = next && (!cur.end || next < cur.end) ? priceAt(sub, next) : cur.price;
  const forecast = detailForecast(sub, today);
  const showForecast = !forecast.sparse && forecast.charges.length > 0;
  const once = sub.cycle.unit === 'lifetime' && phaseSubs(sub).length === 1;
  // 买断按买下那天的汇率折算，与扣款记录、摊到每月同一口径；按今天汇率会和记录里的金额对不上
  const big = pair(nowPrice, cur.currency, { compact: false, plain: true, date: once ? history[0]?.date : undefined });

  const editPay = (c: Charge) => {
    // 同一天可能有多笔（如重复扣款），用当天在同一段里的序号定位；并行的两段各算各的
    const index = history.filter((x) => x.date === c.date && x.sub.start === c.sub.start).indexOf(c);
    setPay({
      // 单笔支付方式与资金拆分一起带进编辑表单，改金额时不会丢
      pay: {
        date: c.date,
        amount: c.kind === 'failed' ? c.sub.price : c.amount,
        kind: c.kind,
        settled: c.settled,
        note: c.note,
        methodId: c.methodId,
        funding: c.funding,
      },
      index,
      phase: sub.phases?.length ? c.sub.start : undefined,
    });
  };

  const paused = sub.status === 'paused';
  // 买断，或刚开始的长周期订阅（一段、不合租，不到两笔扣款画不出走势，也没有未来扣款图）：
  // 主栏只剩指标卡，换成窄的单列，不留半屏空白
  const compact = phaseSubs(sub).length === 1 && !sub.share && (sub.cycle.unit === 'lifetime' || (!showForecast && regular(history).length < 2));
  const charges = (
    <Charges
      sub={sub}
      state={state}
      today={today}
      history={history}
      onRow={editPay}
      // 买断已有那一笔就不再提示记一笔，行仍可点开修改
      onAdd={once && history.length ? undefined : () => setPay({})}
    />
  );
  const events = !compact ? <Events sub={sub} state={state} today={today} /> : null;
  const actions = (
    <>
      {sub.cycle.unit !== 'lifetime' && !isStopped(st) && (
        <Act
          icon={paused ? <Play size={15} /> : <Pause size={15} />}
          label={paused ? t('detail.action.resume') : t('detail.action.pause')}
          onClick={() =>
            run(
              () => saveSub(paused ? { ...sub, status: 'active', pausedAt: undefined } : { ...sub, status: 'paused', pausedAt: today }),
              paused ? t('detail.toast.resumed') : t('detail.toast.paused'),
            )
          }
        />
      )}
      {sub.cycle.unit !== 'lifetime' && !isStopped(st) && (
        <Act icon={<CircleStop size={15} />} label={t('core.stop.title')} onClick={() => setStopping(true)} />
      )}
      {sub.stop?.kind === 'cancel' && (
        <Act icon={<Play size={15} />} label={t('core.stop.restore')} onClick={() => run(() => saveSub(reactivate(sub, today)), t('detail.toast.resumed'))} />
      )}
      {st === 'terminated' && <Act icon={<Plus size={15} />} label={t('editor.change.resume')} onClick={onEdit} />}
      {sub.manageUrl && <Act icon={<Settings2 size={15} />} label={t('detail.action.manage')} href={sub.manageUrl} />}
      <Act primary icon={<Pencil size={15} />} label={t('detail.action.edit')} onClick={onEdit} />
    </>
  );
  const utilityActions = (
    <>
      {sub.url && <Act icon={<ExternalLink size={15} />} label={t('detail.action.website')} href={sub.url} round />}
      <CopyImageButton render={() => detailImage(root.current!)} />
      <Act icon={<Share size={15} />} label={t('detail.action.share')} onClick={() => setShare(true)} round />
    </>
  );

  const content = (
    <div className={`dt ${compact ? 'compact' : ''}`} ref={root}>
      <DetailHead
        icon={<SubIcon sub={sub} size={48} proxied />}
        title={sub.name}
        badge={
          st !== 'active' &&
          st !== 'lifetime' && (
            <span className={`dt-badge dot ${TONE[st]}`}>
              <i />
              {t(`list.status.${st}`)}
            </span>
          )
        }
        meta={
          <>
            <b>
              {big.main} {st !== 'lifetime' && cycleLabel(cur.cycle)}
            </b>
            {big.alt && <span>{big.alt}</span>}
            <RegionTag
              cc={subRegion(
                cur,
                state.methods.find((x) => x.id === cur.methodId),
              )}
            />
            {isPostpaid(cur) && <span className="badge">{t('detail.billing.postpaid')}</span>}
            {sub.category && <CatChip cat={sub.category} />}
          </>
        }
        actions={
          <>
            {actions}
            <span className="dt-header-tools">{utilityActions}</span>
          </>
        }
        onClose={onClose}
      />

      {/*
          顶部四格随状态变：下次扣款、本期进度、累计、每月；下面单列分节，
          提醒仍是卡片，其余（走势、记录、合租、详情、历程）用分隔线隔开
        */}
      <div className="dt-body dt-flow">
        <Kpis sub={sub} state={state} today={today} history={history} />
        {/* 指标下面：本期进度与属性（不加标题），然后是扣款走势、提醒和记录 */}
        <Summary key={sub.id} sub={sub} state={state} today={today} />
        {!compact && <Timeline sub={sub} state={state} today={today} history={history} />}
        <Notices sub={sub} state={state} today={today} />
        {/* 合租比扣款记录重要，放在前面 */}
        <ShareCard sub={sub} state={state} today={today} onCar={() => setCar(true)} onMember={(m) => setMember({ m })} />
        {charges}
        <Transfers sub={sub} state={state} onRow={(index) => setTransfer({ index })} onAdd={() => setTransfer({})} />
        {events}
        <NoteBlock sub={sub} />
      </div>

      {/* 挂到 body：详情本身在弹层里，嵌套的弹层放在里面会被裁切 */}
      {stopping &&
        createPortal(
          <Sheet title={t('core.stop.title')} narrow onClose={() => setStopping(false)}>
            <StopPanel
              sub={sub}
              today={today}
              onApply={(next) =>
                run(
                  async () => {
                    await saveSub(next);
                    setStopping(false);
                  },
                  next.stop ? t('core.stop.stoppedDone') : next.end ? t('core.stop.nonrenewDone', { date: cnDateFull(next.end) }) : t('detail.toast.resumed'),
                )
              }
            />
          </Sheet>,
          document.body,
        )}
      {share && createPortal(<SubShare sub={sub} state={state} today={today} onClose={() => setShare(false)} />, document.body)}
      {car &&
        sub.share?.role === 'owner' &&
        createPortal(
          <CarSheet
            state={state}
            s={sub}
            today={today}
            book={carLedger(state, sub, today)}
            onClose={() => setCar(false)}
            onOpenSub={() => setCar(false)}
            onMember={(m) => setMember({ m })}
          />,
          document.body,
        )}
      {member && createPortal(<MemberSheet state={state} s={sub} member={member.m} onClose={() => setMember(null)} />, document.body)}
      {transfer &&
        createPortal(
          <TransferSheet
            list={sub.transfers ?? []}
            index={transfer.index}
            currency={cur.currency}
            today={today}
            onSave={(next: Transfer[]) =>
              run(async () => {
                await saveSub({ ...sub, transfers: next.length ? next : undefined });
                setTransfer(null);
              }, t('detail.transfer.saved'))
            }
            onClose={() => setTransfer(null)}
          />,
          document.body,
        )}
      {pay &&
        createPortal(
          <PaymentSheet
            sub={sub}
            today={today}
            edit={pay.pay ? { pay: pay.pay, index: pay.index ?? 0, phase: pay.phase } : undefined}
            onClose={() => setPay(null)}
          />,
          document.body,
        )}
    </div>
  );
  return (
    <DetailSheet label={sub.name} onClose={onClose}>
      {content}
    </DetailSheet>
  );
}

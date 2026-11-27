import { CopyImageButton } from '../components/CopyImageButton.tsx';
import { isStopped, pauseDay } from '../../../shared/billing.ts';
import { bundleSource, bundleView, displayCycle, followsParent, hasFinancialHistory, isFreeBundlePhase } from '../../../shared/bundle.ts';
import { meterView } from '../../../shared/meters.ts';
import { createPortal } from 'react-dom';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Paperclip, Pause, Pencil, Play, Plus, Settings2, Share } from '../components/ui-icons.tsx';
import {
  cashChargesBetween,
  chargesBetween,
  historyStart,
  currentPhase,
  cycleLabel,
  effectiveStatus,
  isPostpaid,
  isSeparate,
  nextCharge,
  phaseSubs,
  priceAt,
  type Charge,
} from '../../../shared/billing.ts';
import type { AppState, Payment, ShareMember, Subscription } from '../../../shared/types.ts';
import { CarSheet } from './carpool/CarSheet.tsx';
import { carLedger } from '../../../shared/carpool.ts';
import { MemberSheet } from './Members.tsx';
import { PaymentSheet } from './PaymentSheet.tsx';
import { IconButton } from '../components/ui.tsx';
import { CatChip, RegionTag, SubIcon } from '../components/marks.tsx';
import { PersonAvatar, personFor } from '../components/PersonAvatar.tsx';
import { withProxyCharged } from '../../../shared/proxy.ts';
import { subRegion } from '../region.ts';
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
import { Timeline, timelineAxis, type Range } from './detail/ChargeTimeline.tsx';
import { Events } from './detail/Events.tsx';
import { Summary } from './detail/Summary.tsx';
import { Notices } from './detail/Notices.tsx';
import { NoteBlock, ShareCard } from './detail/Summary.tsx';
import { Charges } from './detail/Ledgers.tsx';
import { Meters, usageMetrics } from './detail/Meters.tsx';
import { BundleCard, ParentCard } from './detail/BundleCard.tsx';
import { canAttach, FilesCard } from './detail/FilesCard.tsx';
import { filesRouteFor } from '../files.ts';
import { go } from '../router.ts';
import { useFilePicker, useUpload } from '../components/FileUpload.tsx';

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
    // 文件卡与回形针标记不进图片：文件是私人凭证
    filter: (node) => !node.matches('.dt-actions, .dt-add, .dt-note .dt-link, .dt-files, .dt-clip'),
  }))!;
}

export function Detail({
  sub,
  state,
  today,
  onEdit,
  onOpen,
  onClose,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  onEdit: () => void;
  onOpen?: (s: Subscription) => void;
  onClose: () => void;
}) {
  const pair = useMoneyPair(state);
  // view 带父订阅可用期（只读展示与计算），所有保存/编辑动作仍用原始 sub
  const view = bundleView(sub, state.subscriptions);
  const st = effectiveStatus(view, today);
  const next = nextCharge(view, today);
  // 显示今天生效的那一段（换区前仍是旧区的价格与支付方式），未来的变更单独列出
  const cur = currentPhase(view, today);
  const freeBundle = isFreeBundlePhase(cur);
  const parentInfo = bundleSource(sub, state.subscriptions, today);
  const parentMissing = !!cur.bundle?.parentId && !parentInfo;
  // 账单（权责）：走势图、用量按账单日期；扣款记录与指标按实际付款。账单与缴费分开记时两者不同，其余订阅是同一份
  // 逾期未缴的部分由走势图另行画成虚线（overdueBills），这里不重复
  const history = withProxyCharged(
    view,
    chargesBetween(view, historyStart(view), today, today).filter((c) => c.unpaid !== 'overdue'),
  );
  const separate = phaseSubs(view).some(isSeparate);
  const paid = separate ? cashChargesBetween(view, historyStart(view), today, today) : history;
  const [pay, setPay] = useState<{ pay?: Payment; index?: number; phase?: string } | null>(null);
  const [share, setShare] = useState(false);
  // 合租弹窗：从详情的合租区点进去，看收了多少、付了多少；成员资料再叠一层
  const [car, setCar] = useState(false);
  const [member, setMember] = useState<{ m?: ShareMember } | null>(null);
  const [transfer, setTransfer] = useState<{ index?: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // 回形针与拖入详情：上传为这个订阅的资料
  const attach = useUpload({ subId: sub.id, kind: 'sub', date: null });
  const [picker, pickFiles] = useFilePicker(attach.upload);

  const nowPrice = next && (!cur.end || next < cur.end) ? priceAt(view, next) : cur.price;
  const forecast = detailForecast(view, today);
  const showForecast = !forecast.sparse && forecast.charges.length > 0;
  const once = view.cycle.unit === 'lifetime' && phaseSubs(view).length === 1;
  // 买断按买下那天的汇率折算，与扣款记录、摊到每月同一口径；按今天汇率会和记录里的金额对不上
  const big = pair(nowPrice, cur.currency, { compact: false, plain: true, date: once ? history[0]?.date : undefined });

  const editPay = (c: Charge) => {
    // 同一天可能有多笔（如重复扣款），用当天在同一段里的序号定位；并行的两段各算各的
    const index = paid.filter((x) => x.date === c.date && x.sub.start === c.sub.start).indexOf(c);
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
        periods: c.periods,
      },
      index,
      phase: sub.phases?.length ? c.sub.start : undefined,
    });
  };

  const paused = sub.status === 'paused';
  const parentPaused = !paused && st === 'paused' && followsParent(cur);
  const pureFreePerk = freeBundle && !hasFinancialHistory(sub, paid);
  // 买断、纯免费附赠，或刚开始的长周期订阅（一段、不合租，不到两笔扣款画不出走势，也没有未来扣款图）：
  // 主栏只剩指标卡，换成窄的单列，不留半屏空白
  const compact =
    pureFreePerk || (phaseSubs(view).length === 1 && !sub.share && (view.cycle.unit === 'lifetime' || (!showForecast && regular(history).length < 2)));
  // 费用图与用量图共用一个范围和横轴；换订阅时回到默认范围
  const [rangePick, setRangePick] = useState<{ id: string; range: Range }>();
  const axis = timelineAxis(view, today, history, rangePick?.id === sub.id ? rangePick.range : undefined);
  // 当前看的用量指标：顶部用量行与用量卡共用
  const [meterPick, setMeterPick] = useState<{ id: string; meter: string }>();
  const usageSub = meterView(view, state.subscriptions);
  const meter = usageSub.meters?.find((m) => meterPick?.id === sub.id && m.id === meterPick.meter) ?? usageSub.meters?.[0];
  // 纯免费附赠（价格 0、没有过任何扣款）不会产生扣款，不放扣款记录和记一笔
  const charges = pureFreePerk ? null : (
    <Charges
      sub={view}
      state={state}
      today={today}
      history={paid}
      onRow={editPay}
      // 买断已有那一笔就不再提示记一笔，行仍可点开修改
      onAdd={once && paid.length ? undefined : () => setPay({})}
    />
  );
  const events = !compact ? <Events sub={view} state={state} today={today} /> : null;
  const actions = (
    <>
      {/* 跟随主订阅的免费附赠：暂停停订都随主订阅，不单独暂停（已暂停的旧数据仍可恢复） */}
      {sub.cycle.unit !== 'lifetime' && !isStopped(st) && !parentPaused && (paused || !(freeBundle && followsParent(cur))) && (
        <Act
          icon={paused ? <Play size={15} /> : <Pause size={15} />}
          label={paused ? t('detail.action.resume') : t('detail.action.pause')}
          onClick={() =>
            run(
              () => saveSub(paused ? { ...sub, status: 'active', pausedAt: undefined } : { ...sub, status: 'paused', pausedAt: pauseDay(sub, today) }),
              paused ? t('detail.toast.resumed') : t('detail.toast.paused'),
            )
          }
        />
      )}
      {(sub.stop || st === 'terminated') && (
        <Act icon={<Play size={15} />} label={t('core.stop.restore')} onClick={() => run(() => saveSub(reactivate(sub)), t('detail.toast.resumed'))} />
      )}
      {st === 'terminated' && <Act icon={<Plus size={15} />} label={t('editor.change.resume')} onClick={onEdit} />}
      {sub.manageUrl && <Act icon={<Settings2 size={15} />} label={t('detail.action.manage')} href={sub.manageUrl} />}
      <Act primary icon={<Pencil size={15} />} label={t('detail.action.edit')} onClick={onEdit} />
    </>
  );
  const utilityActions = (
    <>
      {canAttach(state) && <Act icon={<Paperclip size={15} />} label={t('files.add')} onClick={pickFiles} round />}
      <CopyImageButton render={() => detailImage(root.current!)} />
      <Act icon={<Share size={15} />} label={t('detail.action.share')} onClick={() => setShare(true)} round />
    </>
  );

  const content = (
    <div className={`dt ${compact ? 'compact' : ''}`} ref={root}>
      <DetailHead
        icon={<SubIcon sub={sub} size={48} proxied parent={parentInfo?.parent} />}
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
            {freeBundle ? (
              <>
                <b>{t('list.badge.included')}</b>
                {st !== 'lifetime' && <span>{cycleLabel(displayCycle(cur, today))}</span>}
              </>
            ) : (
              <>
                <b>
                  {big.main} {st !== 'lifetime' && cycleLabel(cur.cycle)}
                </b>
                {big.alt && <span>{big.alt}</span>}
              </>
            )}
            {parentMissing && <span className="dt-badge warn">{t('detail.bundle.parentMissing')}</span>}
            <RegionTag
              cc={subRegion(
                cur,
                state.methods.find((x) => x.id === cur.methodId),
              )}
            />
            {sub.proxy && (
              <span className="who-chip" title={sub.proxy.note}>
                <PersonAvatar p={personFor(state, sub.proxy.personId, sub.proxy.forName)} size={16} />
                {t('proxy.payFor', { name: sub.proxy.forName || t('proxy.unset') })}
              </span>
            )}
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
        {/* 附属订阅：先写明由谁附赠 / 是谁的加购，再看自己的指标 */}
        <ParentCard sub={sub} state={state} today={today} onOpen={onOpen} />
        <Kpis sub={view} state={state} today={today} history={paid} usage={meter && usageMetrics(usageSub, meter, today)} />
        {/* 指标下面：本期进度与属性（不加标题），然后是扣款走势、提醒和记录 */}
        <Summary key={sub.id} sub={view} state={state} today={today} />
        {!compact && (
          <Timeline sub={view} state={state} today={today} history={history} range={axis.range} onRange={(range) => setRangePick({ id: sub.id, range })} />
        )}
        {/* 用量紧跟费用走势：横轴日期对齐，切换范围两张图一起变 */}
        {!!sub.meters?.length && (
          <Meters
            key={`m${sub.id}`}
            sub={sub}
            state={state}
            today={today}
            history={history}
            meterId={meter?.id}
            onMeter={(id) => setMeterPick({ id: sub.id, meter: id })}
            axis={!compact && axis.drawn ? axis : undefined}
          />
        )}
        <Notices sub={sub} state={state} today={today} onOpen={onOpen} />
        {/* 合租、关联订阅比扣款记录重要，放在前面 */}
        <ShareCard sub={view} state={state} today={today} onCar={() => setCar(true)} onMember={(m) => setMember({ m })} />
        <BundleCard sub={sub} state={state} today={today} onOpen={onOpen} />
        {charges}
        <FilesCard
          sub={sub}
          state={state}
          today={today}
          pending={attach.pending}
          onFiles={attach.upload}
          onOpen={onOpen}
          onFilesPage={() => {
            onClose();
            go(filesRouteFor(sub.id));
          }}
        />
        <Transfers sub={sub} state={state} onRow={(index) => setTransfer({ index })} onAdd={() => setTransfer({})} />
        {/* 还没有指标时只留轻入口，放在记录后面不抢走势的位置 */}
        {!sub.meters?.length && <Meters key={`m${sub.id}`} sub={sub} state={state} today={today} />}
        {events}
        <NoteBlock sub={sub} />
      </div>

      {picker}
      {/* 挂到 body：详情本身在弹层里，嵌套的弹层放在里面会被裁切 */}
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

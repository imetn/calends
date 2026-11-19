import { durationLabel } from '../../../../shared/billing.ts';
import { copyParts } from '../../components/copy.tsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CalendarClock,
  CircleStop,
  Flag,
  Hourglass,
  Pause,
  Play,
  Repeat2,
  ScrollText,
  Tag,
  TrendingDown,
  TrendingUp,
  Undo2,
  Unlink,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { addDays, coveredUntil, cycleLabel, diffDays, isGap, phaseSubs, servedTime, upcomingPhase } from '../../../../shared/billing.ts';
import { contractEvents } from '../../../../shared/contract.ts';
import { cnDateFull, money } from '../../../../shared/format.ts';
import { transfersOf } from '../../../../shared/transfers.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { pricePoints } from '../../../../shared/phases.ts';
import { t } from '../../../../shared/i18n.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { Region } from './shared.tsx';
import { methodOf } from './shared.tsx';

export interface Ev {
  date: string;
  /** 节点里的小图标：一眼看出是哪类变化 */
  icon: LucideIcon;
  title: string;
  sub?: ReactNode;
  tone?: 'acc' | 'ok' | 'warn' | 'bad' | 'ink';
  future?: boolean;
}

/** 历程：开始、换方案、调价、断档、暂停、结束，以及计划中的变更 */
export function Events({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const [all, setAll] = useState(false);
  const vs = phaseSubs(sub);
  const plan = (v: Subscription) => {
    const m = methodOf(state, v.methodId);
    return (
      <span className="dt-inline">
        {v.region && <Region cc={v.region} />}
        {copyParts([`${money(pricePoints(v)[0].amount, v.currency)} ${cycleLabel(v.cycle)}`, m?.name].filter(Boolean).join('\n'))}
      </span>
    );
  };
  const evs: Ev[] = [];
  vs.forEach((v, i) => {
    const until = coveredUntil(vs, i);
    if (i > 0 && isGap(until, v.start)) {
      evs.push({
        date: until!,
        icon: Unlink,
        // 「断更 N 个月」本身就是标题，不再另起一行重复「断更」
        title: durationLabel(diffDays(until!, v.start), 'gap'),
        tone: 'warn',
      });
    }
    if (v.start <= today || !v.planned)
      evs.push({
        date: v.start,
        icon: i === 0 ? Play : Repeat2,
        title: i === 0 ? t('detail.ev.start') : t('detail.ev.switch'),
        sub: plan(v),
        tone: 'acc',
        future: v.start > today,
      });
    const hist = pricePoints(v);
    hist.forEach((p, k) => {
      if (!k || p.from === v.start) return;
      const prev = hist[k - 1].amount;
      evs.push({
        date: p.from,
        icon: p.amount > prev ? TrendingUp : TrendingDown,
        title: t('detail.ev.price'),
        sub: `${money(prev, v.currency)} → ${money(p.amount, v.currency)}${prev > 0 ? ` (${p.amount > prev ? '+' : '−'}${Math.round(Math.abs(p.amount / prev - 1) * 100)}%)` : ''}`,
        tone: p.amount > prev ? 'bad' : 'ok',
        future: p.from > today,
      });
    });
  });
  if (sub.intro && sub.intro.until <= today) evs.push({ date: sub.intro.until, icon: Tag, title: t('detail.intro.title'), sub: t('detail.ev.introEnd') });
  if (sub.trialEnd) evs.push({ date: sub.trialEnd, icon: Hourglass, title: t('detail.field.trialEnd'), future: sub.trialEnd > today });
  if (sub.pausedAt && sub.status === 'paused') evs.push({ date: sub.pausedAt, icon: Pause, title: t('detail.ev.paused'), tone: 'warn' });
  if (sub.share?.since)
    evs.push({
      date: sub.share.since,
      icon: Users,
      title: t('detail.ev.shareStart'),
      sub: t(`editor.share.${sub.share.role}`),
      tone: 'ok',
    });
  const up = upcomingPhase(sub, today);
  if (up?.planned) evs.push({ date: up.start, icon: CalendarClock, title: t('detail.up.planned').split('\n')[0], sub: plan(up), future: true });
  for (const v of vs) {
    if (v.stop)
      evs.push({
        date: v.stop.date,
        icon: v.stop.kind === 'terminate' ? Ban : CircleStop,
        title: t(v.stop.kind === 'terminate' ? 'core.stop.terminate' : 'core.stop.cancel'),
        sub: v.stop.kind === 'terminate' ? v.stop.reason : undefined,
        tone: v.stop.kind === 'terminate' ? 'bad' : 'ink',
      });
    for (const p of v.payments ?? [])
      if (p.kind === 'refund')
        evs.push({
          date: p.date,
          icon: Undo2,
          title: t('editor.payment.kind.refund'),
          tone: 'ok',
          future: p.date > today,
        });
  }
  // 转让只记发生了什么，金额在转让卡片里
  for (const tr of transfersOf(sub))
    evs.push({
      date: tr.date,
      icon: tr.kind === 'sell' ? ArrowUpFromLine : ArrowDownToLine,
      title: t(`detail.transfer.kind.${tr.kind}`),
      sub: tr.note,
      tone: tr.kind === 'sell' ? 'ok' : 'acc',
      future: tr.date > today,
    });
  // 合同续约与到期：已发生的都列，未来只列下一次
  const contract = contractEvents(sub, sub.start, addDays(today, 3660), today);
  for (const e of contract.filter((e, i) => e.date <= today || i === contract.findIndex((x) => x.date > today)))
    evs.push({
      date: e.kind === 'end' ? e.until : e.date,
      icon: ScrollText,
      title: t(`core.contract.${e.kind === 'end' ? (e.until < today ? 'ended' : 'ending') : e.date <= today ? 'renewed' : 'renewing'}`),
      tone: e.kind === 'end' ? 'ink' : undefined,
      future: e.date > today,
    });
  if (sub.end && !sub.stop)
    evs.push({ date: sub.end, icon: Flag, title: sub.end <= today ? t('detail.ev.ended') : t('detail.ev.ending'), tone: 'ink', future: sub.end > today });
  // 一条时间线，新的在上
  evs.sort((a, b) => b.date.localeCompare(a.date));

  // 只有开始订阅、开始合租这类一两条时，开始日已在摘要、方案在走势下方，不单独成卡
  if (evs.length < 3) return null;
  const shown = all || evs.length <= 6 ? evs : evs.slice(0, 6);
  const gaps = servedTime(sub, today).gaps.length;
  return (
    <Panel
      className="dt-events"
      title={t('detail.history')}
      aside={`${t('detail.ev.phases', { count: vs.length })}\n${gaps ? t('detail.stats.gaps', { count: gaps }) : t('detail.kpi.noGaps')}`}
    >
      <ol className="dt-evs">
        {shown.map((e, i) => (
          <li key={`${e.date}-${i}`} className={`dt-ev ${e.future ? 'fut' : ''} ${e.tone ?? ''}`}>
            <i aria-hidden>
              <e.icon size={12} strokeWidth={2.2} />
            </i>
            {/* 事件名一列对齐，说明从同一位置起排，日期靠右 */}
            <b>{e.title}</b>
            {e.sub && <small>{e.sub}</small>}
            <time dateTime={e.date}>{cnDateFull(e.date)}</time>
          </li>
        ))}
      </ol>
      {evs.length > shown.length && (
        <button className="dt-link" onClick={() => setAll(true)}>
          {t('detail.ev.more', { count: evs.length - shown.length })}
        </button>
      )}
    </Panel>
  );
}

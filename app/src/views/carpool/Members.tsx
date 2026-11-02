import { copyParts } from '../../components/copy.tsx';
import { dueTotal, formatTotal } from '../../../../shared/fx-total.ts';
import { PersonAvatar, personFor } from '../../components/PersonAvatar.tsx';
import {
  addDays,
  addMonths,
  chargesBetween,
  diffDays,
  memberDues,
  nextCharge,
  memberBillMonths,
  memberCollection,
  memberUnpaidFrom,
  collectCurrencyOf,
} from '../../../../shared/billing.ts';
import { useState } from 'react';
import { flow, billLabel, cnDate, cnDateAuto, cnDateFull, money, monthLabel } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { chargeBaseOrNaN } from '../../../../shared/fx.ts';
import type { AppState, ShareMember, Subscription } from '../../../../shared/types.ts';
import { base } from '../../base.ts';
import { memberStatus } from '../member-status.ts';
import { memberSegments } from '../../../../shared/carpool.ts';
import { perBill } from '../member-fields.tsx';
import { followsCar, memberFee } from '../../../../shared/carpool.ts';
import { Icon } from '../../components/icons.tsx';
import { tipProps } from '../../components/overlays.tsx';
import { carpoolRoster, carpoolTimeline } from '../../../../shared/carpool-timeline.ts';
import { useTimelinePan } from '../member-timeline-pan.ts';

/** 成员明细：收款状态、应收、收款按钮；车卡展开和合租弹窗共用 */
export function MemberRows({
  state,
  s,
  today,
  onMember,
  only,
  timeline,
  includeLeft = false,
  masked = false,
  win,
}: {
  state: AppState;
  s: Subscription;
  today: string;
  onMember: (m: ShareMember) => void;
  /** 只列一部分成员（合租弹窗里按收费周期分组时用） */
  only?: (m: ShareMember) => boolean;
  /** 合租详情里在每人下方画时间条（与宽屏表格一致） */
  timeline?: boolean;
  includeLeft?: boolean;
  masked?: boolean;
  win?: ReturnType<typeof carpoolTimeline>;
}) {
  const dues = memberDues(s, today, collectCurrencyOf(state.settings), state).filter(
    (d) => (includeLeft || !d.member.left || d.member.left > today) && (!only || only(d.member)),
  );
  const collect = collectCurrencyOf(state.settings);
  return (
    <div>
      {dues.map((d) => {
        const collection = memberCollection(s, d.member, memberUnpaidFrom(s, d.member), collect);
        return (
          <div
            key={d.member.id}
            className={`member ${d.member.left && d.member.left <= today ? 'departed' : ''}`}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('button')) {
                e.stopPropagation();
                onMember(d.member);
              }
            }}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                e.stopPropagation();
                onMember(d.member);
              }
            }}
          >
            {/* 一行称呼，一行动态日期：欠款写「应收 某日」，已结清写「下次应收 某日」；账号、周期在合租详情表格里看 */}
            <button className="member-info" aria-label={masked ? t('family.sheet.hiddenMember') : undefined} onClick={() => onMember(d.member)}>
              <div className="icon-text car-member-name">
                <MemberAvatar state={state} m={d.member} size={28} masked={masked} />
                <span className={`text-ellipsis member-label ${masked ? 'car-private' : ''}`} aria-hidden={masked || undefined}>
                  {d.member.name || t('family.pool.unnamed')}
                </span>
                {d.member.left && d.member.left <= today && <span className="badge">{t('family.pool.leftOn', { date: cnDate(d.member.left) })}</span>}
              </div>
              <div className="muted member-dates">
                <span className={`text-ellipsis ${d.periodsOwed > 0 && collection.from <= today ? 'owe' : ''}`}>
                  {copyParts(
                    d.member.exempt
                      ? masked
                        ? t('family.pool.exemptNote')
                        : (d.member.note ?? t('family.pool.exemptNote'))
                      : d.member.left && collection.from >= d.member.left
                        ? t('family.pool.leftOn', { date: cnDateAuto(d.member.left, today) })
                        : d.periodsOwed > 0 && collection.from < today
                          ? `${t('family.quick.late', { count: diffDays(collection.from, today) })}\n${t('family.pool.dueOn', { date: cnDateFull(collection.from) })}`
                          : d.periodsOwed > 0
                            ? t('family.pool.dueOn', { date: cnDateFull(collection.from) })
                            : (() => {
                                const p = memberStatus(state, s, d.member, today).period;
                                return t('family.sheet.range', { from: cnDateFull(p.from), until: cnDateFull(p.until) });
                              })(),
                  )}
                </span>
              </div>
            </button>
            <div className="member-amount num car-member-amount">
              {d.member.exempt ? (
                <span className="muted car-member-exempt">{t('family.pool.exempt')}</span>
              ) : d.periodsOwed > 0 ? (
                // 欠多少写多少（各期合计），与卡片的「N 人待收」和人员页同一口径；不是下一期的金额
                <b className="car-member-due">{d.originals ? formatTotal(dueTotal(state, d), state.settings.baseCurrency) : money(d.owed, d.currency)}</b>
              ) : (
                <span className="muted">{t('family.pool.settled')}</span>
              )}
            </div>
            {timeline && win && <MemberTimeline s={s} m={d.member} today={today} win={win} />}
          </div>
        );
      })}
    </div>
  );
}

/** 成员头像：隐藏个人信息时换成同尺寸的灰色占位，合租详情里所有成员头像都走这里，不会漏 */
export function MemberAvatar({ state, m, size, masked }: { state: AppState; m: ShareMember; size: number; masked?: boolean }) {
  return masked ? (
    <span className="pp-ava car-private-avatar" style={{ '--car-avatar-size': `${size}px` } as React.CSSProperties} aria-hidden="true" />
  ) : (
    <PersonAvatar p={personFor(state, m.personId, m.name || '?')} size={size} />
  );
}

export const pct = (d: string, win: { start: string; end: string }) => (diffDays(win.start, d) / Math.max(1, diffDays(win.start, win.end))) * 100;

/** 表头：季度刻度（1、4、7、10 月），1 月处只写年份，其余写月份，标签短、不会重叠 */
export function TimelineAxis({ win }: { win: { start: string; end: string } }) {
  const marks: string[] = [];
  for (let d = `${win.start.slice(0, 7)}-01`; d <= win.end; d = addMonths(d, 1))
    if (d >= win.start && ['01', '04', '07', '10'].includes(d.slice(5, 7))) marks.push(d);
  return (
    <span className="mt-viewport mt-axis" aria-label={t('family.sheet.period')}>
      <span className="mt-inner">
        {marks.map((d) => (
          <span key={d} className={`mt-mark ${d.slice(5, 7) === '01' ? 'year' : ''}`} style={{ '--mt-left': `${pct(d, win)}%` } as React.CSSProperties}>
            {d.slice(5, 7) === '01' ? d.slice(0, 4) : monthLabel(d.slice(0, 7), { year: false })}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * 成员时间条：按这个人自己的周期切出各期，已付实心、该收没收红色斜纹、下一期浅灰斜纹，
 * 一条今天竖线贯穿所有行——周期长短、谁提前付了、谁拖了多久一眼可见。
 */
export function MemberTimeline({
  s,
  m,
  today,
  win,
  fee,
}: {
  s: Subscription;
  m: ShareMember;
  today: string;
  win: { start: string; end: string };
  fee?: string;
}) {
  const segs = memberSegments(s, m, today, win.start, win.end);
  const label = {
    paid: t('family.timeline.paid'),
    due: t('family.timeline.due'),
    future: t('family.timeline.future'),
    unused: t('family.timeline.unused'),
    waived: t('family.timeline.waived'),
  };
  return (
    <span className={`mt-viewport mt-track ${m.exempt ? 'exempt' : ''}`}>
      <span className="mt-inner">
        {segs.map((g) => (
          <i
            key={`${g.from}-${g.kind}`}
            className={`mt-seg ${g.kind}`}
            style={
              {
                '--mt-left': `${pct(g.from, win)}%`,
                '--mt-width': `${Math.max(0.6, pct(addDays(g.until, 1), win) - pct(g.from, win))}%`,
              } as React.CSSProperties
            }
            {...tipProps(() => (
              <>
                <b>
                  {label[g.kind]}
                  {fee && (
                    <>
                      <span className="copy-gap" aria-hidden="true" />
                      {fee}
                    </>
                  )}
                </b>
                <div>
                  {cnDateFull(g.from)} – {cnDateFull(g.until)}
                </div>
              </>
            ))}
          />
        ))}
        <i className="mt-today" style={{ '--mt-left': `${pct(today, win)}%` } as React.CSSProperties} />
      </span>
    </span>
  );
}

/** 宽屏成员表：每人的收费（周期、金额、跟随车与否）和收款状态；点一行改收费，点「收款」记一笔。 */
export function MemberTable({
  state,
  s,
  today,
  onMember,
  win,
  expanded,
  onToggle,
  masked,
}: {
  state: AppState;
  s: Subscription;
  today: string;
  onMember: (m?: ShareMember) => void;
  win: ReturnType<typeof carpoolTimeline>;
  expanded: boolean;
  masked: boolean;
  onToggle: () => void;
}) {
  const roster = carpoolRoster(s, today);
  return (
    <table role="table" className="car-member-table" aria-label={t('family.sheet.members')}>
      <thead role="rowgroup">
        <tr role="row" className="table-head">
          <th role="columnheader" scope="col">
            {t('family.sheet.member')}
          </th>
          <th role="columnheader" scope="col">
            {t('family.sheet.fee')}
          </th>
          <th role="columnheader" scope="col" className="mt-head">
            <TimelineAxis win={win} />
          </th>
          <th role="columnheader" scope="col">
            {t('family.sheet.status')}
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {s.share?.role === 'owner' && <OwnerSeat state={state} s={s} today={today} win={win} table />}
        {[
          // 空位永远在最后：车主、分摊成员、不分摊成员、（展开时）已退出成员之后
          ...roster.active.filter((m) => !m.exempt),
          ...roster.active.filter((m) => m.exempt),
          ...(expanded ? roster.departed : []),
          ...Array.from({ length: roster.vacancies }, () => null),
        ].map((m, index) => {
          if (!m) return <Vacancy key={`vacancy-${index}`} onAdd={() => onMember()} table />;
          const st = memberStatus(state, s, m, today);
          const rate = memberFee(state, s, m, today);
          const left = !!m.left && m.left <= today;
          return (
            <tr
              role="row"
              key={m.id}
              className="car-member-row"
              tabIndex={0}
              aria-label={masked ? t('family.sheet.hiddenMember') : m.name || t('family.pool.unnamed')}
              onClick={() => onMember(m)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onMember(m);
                }
              }}
            >
              <td role="cell">
                <span
                  className={`car-member-chip ${left ? 'left' : ''}`}
                  {...(masked
                    ? {}
                    : tipProps(() => (
                        <>
                          <b>{m.name || t('family.pool.unnamed')}</b>
                          {m.account && m.account !== m.name && <div>{m.account}</div>}
                          {left && <div>{t('family.pool.leftOn', { date: cnDateFull(m.left!) })}</div>}
                          {!m.exempt && <div className="muted">{t(followsCar(state, s, m, today) ? 'family.rule.follow' : 'family.rule.custom')}</div>}
                        </>
                      )))}
                >
                  <MemberAvatar state={state} m={m} size={24} masked={masked} />
                  <span className={`text-ellipsis ${masked ? 'car-private' : ''}`} aria-hidden={masked || undefined}>
                    {m.name || t('family.pool.unnamed')}
                  </span>
                </span>
              </td>
              <td role="cell">
                {m.exempt ? (
                  <span className="muted">{t('family.pool.exempt')}</span>
                ) : (
                  <span className="car-member-fee">
                    {perBill('family.pool.perFee', memberBillMonths(s, m, today), { fee: money(rate.amount, rate.currency) })}
                  </span>
                )}
              </td>
              <td role="cell">
                <MemberTimeline s={s} m={m} today={today} win={win} fee={money(rate.amount, rate.currency)} />
              </td>
              <td role="cell">
                {m.exempt || st.gone ? (
                  <span className="muted">—</span>
                ) : st.owe ? (
                  <span className="car-member-lines">
                    <b className={st.late > 0 ? 'late' : 'warn'}>{st.late > 0 ? t('family.quick.late', { count: st.late }) : t('family.pool.owed')}</b>
                    <small className="muted">{t('family.pool.owedAmount', { amount: st.owed })}</small>
                  </span>
                ) : (
                  <span className="muted">{t('family.pool.settled')}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {roster.departed.length > 0 && (
        <tfoot>
          <tr>
            <td colSpan={4}>
              <DepartedToggle count={roster.departed.length} expanded={expanded} onToggle={onToggle} />
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

export function DepartedToggle({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="car-departed-toggle" aria-expanded={expanded} onClick={onToggle}>
      {t('family.sheet.departed', { count })}
      <Icon name="down" size={14} />
    </button>
  );
}

/** 车主自己占的那一座：不收费、不可点，只表明席位 */
/**
 * 车主自己的迷你时间线：订阅本身的每一期（车主实际付给服务方的扣款），
 * 已扣的为实色，下一期预测为斜纹；与成员的收款时间线共用同一条时间轴
 */
export function OwnerTimeline({ state, s, today, win }: { state: AppState; s: Subscription; today: string; win: { start: string; end: string } }) {
  const charges = chargesBetween(s, addMonths(win.start, -24), win.end, today).filter((c) => !c.kind);
  const segs = charges
    .map((c, i) => {
      const until = addDays(charges[i + 1]?.date ?? nextCharge(s, addDays(c.date, 1)) ?? win.end, -1);
      return { c, from: c.date, until, kind: c.date <= today ? 'owner' : 'future' };
    })
    .filter((g) => g.until >= win.start && g.from <= win.end)
    // 预测只画下一期
    .filter((g, i, all) => g.kind === 'owner' || all.findIndex((x) => x.kind === 'future') === i);
  return (
    <span className="mt-viewport mt-track">
      <span className="mt-inner">
        {segs.map((g) => {
          const from = g.from < win.start ? win.start : g.from;
          const until = g.until > win.end ? win.end : g.until;
          return (
            <i
              key={g.from}
              className={`mt-seg ${g.kind}`}
              style={
                { '--mt-left': `${pct(from, win)}%`, '--mt-width': `${Math.max(0.6, pct(addDays(until, 1), win) - pct(from, win))}%` } as React.CSSProperties
              }
              {...tipProps(() => (
                <>
                  <b>{g.kind === 'owner' ? flow(-chargeBaseOrNaN(state, g.c), state.settings.baseCurrency) : t('family.timeline.future')}</b>
                  <div>
                    {cnDateFull(g.from)} – {cnDateFull(g.until)}
                  </div>
                </>
              ))}
            />
          );
        })}
        <i className="mt-today" style={{ '--mt-left': `${pct(today, win)}%` } as React.CSSProperties} />
      </span>
    </span>
  );
}

export function OwnerSeat({
  state,
  s,
  today,
  win,
  table = false,
}: {
  state: AppState;
  s: Subscription;
  today: string;
  win: { start: string; end: string };
  table?: boolean;
}) {
  const chip = (
    <span className="car-member-chip owner">
      <img className="owner-avatar" src={state.settings.avatar || base('/icons/avatar.png')} alt="" />
      <span className="text-ellipsis">{t('family.pool.me')}</span>
    </span>
  );
  const line = <OwnerTimeline state={state} s={s} today={today} win={win} />;
  return table ? (
    <tr role="row" className="car-member-row owner-seat">
      <td role="cell">{chip}</td>
      <td role="cell" className="muted">
        {t('family.sheet.ownerFee')}
      </td>
      <td role="cell">{line}</td>
      <td role="cell" />
    </tr>
  ) : (
    <div className="member owner-seat">
      {chip}
      <span className="muted">{t('family.sheet.ownerFee')}</span>
      {line}
    </div>
  );
}

export function Vacancy({ onAdd, table = false }: { onAdd: () => void; table?: boolean }) {
  const props = {
    className: `car-vacancy ${table ? 'car-member-row' : 'member'}`,
    role: table ? 'row' : 'button',
    tabIndex: 0,
    'aria-label': t('family.sheet.addMember'),
    onClick: () => onAdd(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onAdd();
      }
    },
  };
  const chip = (
    <span className="car-member-chip vacancy">
      {/* 和成员胶囊同一个样子：左边头像位（虚线空圈），右边文字 */}
      <span className="vacancy-ava" aria-hidden="true" />
      <span className="vacancy-label">{t('family.sheet.vacancy')}</span>
      <span className="vacancy-add">{t('family.sheet.addMember')}</span>
    </span>
  );
  const track = (
    <span className="mt-viewport mt-track vacant">
      <span>{t('family.sheet.vacancyTrack')}</span>
    </span>
  );
  return table ? (
    <tr {...props}>
      <td role="cell">{chip}</td>
      <td role="cell" />
      <td role="cell">{track}</td>
      <td role="cell" />
    </tr>
  ) : (
    <div {...props}>
      {chip}
      {track}
    </div>
  );
}

/**
 * 合租成员：宽时成员表（收费、迷你时间线、收款状态），窄时按收费周期分组的卡片；
 * 合租详情与订阅详情共用，保证两处成员的样子一致
 */
export function CarMembers({
  state,
  s,
  today,
  onMember,
  masked = false,
  billEvery,
}: {
  state: AppState;
  s: Subscription;
  today: string;
  onMember: (m?: ShareMember) => void;
  masked?: boolean;
  billEvery: number;
}) {
  const [departedOpen, setDepartedOpen] = useState(false);
  const win = carpoolTimeline(s, today, billEvery);
  const timelineRef = useTimelinePan(win);
  const roster = carpoolRoster(s, today);
  const free = roster.vacancies;
  const groupOf = (m: ShareMember) => (m.exempt ? 'exempt' : `m${memberBillMonths(s, m, today)}`);
  const memberGroups = [...new Set(roster.active.map(groupOf))]
    .sort((a, b) => (a === 'exempt' ? 1 : b === 'exempt' ? -1 : Number(a.slice(1)) - Number(b.slice(1))))
    .map((k) => [k, k === 'exempt' ? t('family.pool.exempt') : billLabel(Number(k.slice(1))), roster.active.filter((m) => groupOf(m) === k).length] as const);
  return (
    <div className="car-members" ref={timelineRef}>
      <MemberTable
        state={state}
        s={s}
        today={today}

        onMember={onMember}
        win={win}
        masked={masked}
        expanded={departedOpen}
        onToggle={() => setDepartedOpen(!departedOpen)}
      />
      <div className="car-member-cards">
        <TimelineAxis win={win} />
        {s.share?.role === 'owner' && <OwnerSeat state={state} s={s} today={today} win={win} />}
        {memberGroups
          .filter(([key]) => key !== 'exempt')
          .map(([key, label, n]) => (
            <div key={key} className="car-sheet-members">
              <div className="car-group-head">
                {label} <span className="copy-gap" aria-hidden="true" /> {t('family.sheet.people', { count: n })}
              </div>
              <MemberRows state={state} s={s} today={today} onMember={onMember} only={(m) => groupOf(m) === key} masked={masked} timeline win={win} />
            </div>
          ))}
        {roster.active.some((m) => m.exempt) && (
          <div className="car-sheet-members">
            <div className="car-group-head">{t('family.pool.exempt')}</div>
            <MemberRows state={state} s={s} today={today} onMember={onMember} only={(m) => !!m.exempt} masked={masked} timeline win={win} />
          </div>
        )}
        {departedOpen && (
          <div className="car-sheet-members">
            <MemberRows
              state={state}
              s={s}
              today={today}

              onMember={onMember}
              only={(m) => !!m.left && m.left <= today}
              includeLeft
              masked={masked}
              timeline
              win={win}
            />
          </div>
        )}
        {Array.from({ length: free }, (_, i) => (
          <Vacancy key={i} onAdd={() => onMember()} />
        ))}
        {roster.departed.length > 0 && (
          <DepartedToggle count={roster.departed.length} expanded={departedOpen} onToggle={() => setDepartedOpen(!departedOpen)} />
        )}
      </div>
    </div>
  );
}

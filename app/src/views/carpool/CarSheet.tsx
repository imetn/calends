import { chargesTotal, convertedTotal, dueTotal, formatTotal, sumTotals, totalNote, type FxTotal } from '../../../../shared/fx-total.ts';
import { currentPhase } from '../../../../shared/billing.ts';
import { CopyImageButton } from '../../components/CopyImageButton.tsx';
import { DetailHead, DetailSheet, Panel, Prop } from '../../components/DetailKit.tsx';
import { ChargeMethods, chargeMethodIds, currencyTotals, YearLedger, YearMethods } from '../../components/YearLedger.tsx';
import { copyParts } from '../../components/copy.tsx';
import { chargesBetween, cycleLabel, effectiveStatus, memberDues, nextCharge, isStopped, collectCurrencyOf } from '../../../../shared/billing.ts';
import { useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { carpoolSnapshot } from '../carpool-snapshot.ts';
import { createPortal } from 'react-dom';
import { flow, cnDate, cnDateFull, money } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { tx } from '../../i18n.ts';
import { chargeBaseOrNaN } from '../../../../shared/fx.ts';
import type { AppState, ShareMember, Subscription } from '../../../../shared/types.ts';

import { FeeRuleFields, perBill } from '../member-fields.tsx';
import {
  applyCarRule,
  carLedger,
  carRule,
  carYear,
  costChange,
  followsCar,
  memberCashFlows,
  memberFlowValue,
  moveCollectFrom,
  nextCollectionDay,
} from '../../../../shared/carpool.ts';
import type { CarRule } from '../../../../shared/types.ts';
import { DatePicker } from '../../components/DatePicker.tsx';
import { MetricCards, Cell, Group, IconButton } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { NameLink, StatusPill, SubIcon } from '../../components/marks.tsx';
import { Seg, Stepper, useSubmit } from '../../components/inputs.tsx';
import { Sheet } from '../../components/overlays.tsx';
import { run } from '../../toast.ts';
import { saveSub } from '../../store.ts';
import { carpoolRoster } from '../../../../shared/carpool-timeline.ts';
import { MemberAvatar } from './Members.tsx';
import { CarMembers } from './Members.tsx';
import { collectNow, PeriodBar, PeriodPair, periodLive } from '../detail/Periods.tsx';

/**
 * 合租弹窗：一辆车的全部信息。上面是基本信息和指标，中间是成员与收款，下面是历来所有收款；
 * 订阅本身（价格、阶段、扣款）点「查看订阅详情」切过去
 */
export function CarSheet({
  state,
  s,
  today,
  book,
  onClose,
  onOpenSub,
  onMember,
  onPayment,
}: {
  state: AppState;
  s: Subscription;
  today: string;
  book: ReturnType<typeof carLedger>;
  onClose: () => void;
  onOpenSub: () => void;
  onMember: (m?: ShareMember) => void;
  /** 收款表点某一笔：直接编辑这笔收款 */
  onPayment?: (m: ShareMember, receiptId: string) => void;
}) {
  const [masked, setMasked] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const base = state.settings.baseCurrency;
  const sh = s.share!;
  const st = effectiveStatus(s, today);
  const stopped = isStopped(st);
  const next = nextCharge(s, today);
  const roster = carpoolRoster(s, today);
  const dues = memberDues(s, today, collectCurrencyOf(state.settings), state).filter((d) => d.periodsOwed > 0);
  const owe = dues.length;
  const owePartial = sumTotals(dues.map((d) => dueTotal(state, d)));
  const oweSum = owePartial.incomplete ? NaN : owePartial.value;
  const hasPending = oweSum > 0 || !Number.isFinite(oweSum);
  const rule = carRule(state, s, today);
  const collect = collectNow(s, state, today);
  const [editingRule, setEditingRule] = useState(false);
  // 订阅调价后提醒一次是否调整收费标准；只提示，不自动改
  const cost = stopped ? undefined : costChange(s, today);
  const actual = -book.net;
  // 历来所有收款，已退出的成员也保留
  const receipts = sh.members.flatMap((m) => memberCashFlows(m).map((p) => ({ m, p, base: memberFlowValue(state, p) })));
  // 收款、付款切换：两张表都按年分组，与订阅详情的扣款记录同一套
  const [tab, setTab] = useState<'in' | 'out'>('in');
  const outs = chargesBetween(s, book.since ?? s.start, today, today)
    .filter((c) => c.kind !== 'failed')
    // 缺汇率的一笔为 NaN：行与年小计显示「—」
    .map((c) => ({ c, base: chargeBaseOrNaN(state, c) }))
    .reverse();
  const inTotal = formatTotal(sumTotals(receipts.map((r) => convertedTotal(state, r.p.amount, r.p.currency, r.p.date))), base, { direction: 1 });
  const outTotal = formatTotal(
    chargesTotal(
      state,
      outs.map((r) => r.c),
    ),
    base,
    { direction: -1 },
  );
  return (
    <DetailSheet label={t('family.sheet.title')} onClose={onClose}>
      {/* 复制为图片取整张弹窗，收款表与按钮带 data-snapshot-hide 不入图 */}
      <div className="dt car-summary" ref={summaryRef}>
        <DetailHead
          icon={<SubIcon sub={s} size={48} proxied />}
          title={<NameLink onClick={onOpenSub}>{s.name}</NameLink>}
          badge={
            stopped ? (
              <StatusPill tone="stop">{t('family.pool.filter.ended')}</StatusPill>
            ) : (
              roster.vacancies === 0 && <span className="car-seats full">{t('family.pool.seatsFull')}</span>
            )
          }
          meta={
            <>
              <b>
                {money(currentPhase(s, today).price, currentPhase(s, today).currency)} {cycleLabel(currentPhase(s, today).cycle)}
              </b>
              {!stopped && next && <span>{t('family.pool.next', { date: cnDate(next) })}</span>}
              <span>{t('family.sheet.seatsVal', { used: roster.taken, total: sh.seats })}</span>
            </>
          }
          actions={
            <span className="dt-header-tools" data-snapshot-hide>
              {!stopped && (
                <button className="btn car-rule-btn" onClick={() => setEditingRule(true)} title={t('family.rule.title')}>
                  {perBill('family.pool.perFee', rule.billEvery, { fee: money(rule.fee, rule.currency) })}
                  <Icon name="right" size={14} />
                </button>
              )}
              <IconButton
                aria-label={t(masked ? 'family.sheet.showPersonal' : 'family.sheet.hidePersonal')}
                aria-pressed={masked}
                onClick={() => setMasked(!masked)}
              >
                {masked ? <EyeOff size={17} /> : <Eye size={17} />}
              </IconButton>
              <CopyImageButton render={() => carpoolSnapshot(summaryRef.current!)} />
            </span>
          }
          onClose={onClose}
        />
        <div className="dt-body">
          <MetricCards>
            <div>
              <small>{t('family.strip.paid')}</small>
              <b>{formatTotal(book.partial.paid, base, { direction: -1, main: true })}</b>
              <span aria-hidden={book.partial.paid.incomplete ? undefined : true}>{totalNote(book.partial.paid) || ' '}</span>
            </div>
            <div>
              <small>{t('family.strip.received')}</small>
              <b className={book.received > 0 ? 'done' : undefined}>{formatTotal(book.partial.received, base, { direction: 1, main: true })}</b>
              <span aria-hidden={book.partial.paid.incomplete ? undefined : true}>{totalNote(book.partial.received) || ' '}</span>
            </div>
            <div>
              <small>{t('family.strip.profit')}</small>
              <b className={actual > 0 ? 'done' : actual < 0 ? 'loss' : undefined}>{formatTotal(book.partial.net, base, { direction: -1, main: true })}</b>
              {/* 小字是当年盈亏，与列表的「当年盈亏」同一口径；买断的车也有今年的账 */}
              <span>
                {tx('family.strip.thisYear', {
                  amount: <span className="nowrap">{formatTotal(carYear(state, s, today).partial.net, base, { direction: 1 })}</span>,
                })}
              </span>
            </div>
            {hasPending && (
              <div>
                <small>{t('family.pool.owed')}</small>
                <b className="warn">{formatTotal(owePartial, base, { main: true })}</b>
                <span>{totalNote(owePartial) || t('family.pool.owedSub', { count: owe })}</span>
              </div>
            )}
          </MetricCards>

          {/* 指标下面：订阅周期与收费周期并排，与订阅详情的本期同一块 */}
          {/* 各人收费周期不一样时只画订阅周期，收费周期看下面成员表的时间线 */}
          {periodLive(s, today) && (
            <Panel className="dt-about">{collect ? <PeriodPair sub={s} today={today} collect={collect} /> : <PeriodBar sub={s} today={today} split />}</Panel>
          )}

          {cost && (
            <div className="dt-notices" data-snapshot-hide>
              <Panel
                title={t('family.costChange.title')}
                aside={
                  <button className="dt-btn" onClick={() => setEditingRule(true)}>
                    {t('family.costChange.adjust')}
                  </button>
                }
              >
                <dl className="dt-props one">
                  <Prop k={t('family.costChange.price')} hint={t('family.costChange.since', { date: cnDateFull(cost.from) })}>
                    {money(cost.before.price, cost.before.currency)} {cycleLabel(cost.before.cycle)} → {money(cost.after.price, cost.after.currency)}{' '}
                    {cycleLabel(cost.after.cycle)}
                  </Prop>
                </dl>
              </Panel>
            </div>
          )}

          {/* 与订阅详情一样：成员表、收付款表各在一张卡片里，标题在卡片内 */}
          {/* 成员卡片不加标题：表头第一列已经是「成员」 */}
          <Panel className="dt-share car-members-panel">
            <CarMembers state={state} s={s} today={today} onMember={onMember} masked={masked} billEvery={rule.billEvery} />
          </Panel>

          {/* 收进来的和我付出去的切换着看；表格与订阅详情的扣款记录同一套（YearLedger） */}
          {/* 与代付的逐期明细同一种卡片：标题在左，收款 / 付款切换在右 */}
          <Panel
            className="dt-charges car-ledger"
            title={t('family.sheet.ledgerTitle')}
            aside={
              <span data-snapshot-hide>
                <Seg
                  small
                  value={tab}
                  onChange={setTab}
                  options={[
                    // 切换上写明笔数与合计，表里不再加合计行；符号与表中金额一致。放不下时只写收款 / 付款（只剩金额分不清收付）
                    [
                      'in',
                      <TabLabel key="in" full={t('family.sheet.tabIn', { count: receipts.length, amount: inTotal })} short={t('family.sheet.tabInShort')} />,
                    ],
                    [
                      'out',
                      <TabLabel key="out" full={t('family.sheet.tabOut', { count: outs.length, amount: outTotal })} short={t('family.sheet.tabOutShort')} />,
                    ],
                  ]}
                />
              </span>
            }
          >
            <div data-snapshot-hide>
              {tab === 'out' ? (
                outs.length ? (
                  <YearLedger
                    key="out"
                    items={outs}
                    dateOf={(r) => r.c.date}
                    head={[t('family.sheet.chargeDate'), t('detail.field.method'), t('proxy.table.charged'), t('proxy.table.cost')]}
                    yearCells={(ys) => {
                      return {
                        second: <YearMethods ids={chargeMethodIds(ys.map((r) => r.c))} state={state} />,
                        orig: copyParts(
                          currencyTotals(
                            ys,
                            (r) => r.c,
                            (sum, ccy) => flow(-sum, ccy),
                          ),
                        ),
                        base: formatTotal(
                          chargesTotal(
                            state,
                            ys.map((r) => r.c),
                          ),
                          base,
                          { direction: -1 },
                        ),
                      };
                    }}
                    row={({ c, base: v }) => ({
                      date: <time dateTime={c.date}>{cnDateFull(c.date)}</time>,
                      second: <ChargeMethods c={c} state={state} />,
                      orig: (
                        <>
                          {flow(-c.amount, c.currency)}
                          {c.kind === 'refund' && <em className="dt-kind refund">{t('family.sheet.refund')}</em>}
                        </>
                      ),
                      base: Number.isFinite(v) ? flow(-v, base) : '—',
                    })}
                    rowKey={({ c }, i) => `${c.date}-${i}`}
                  />
                ) : (
                  <div className="car-empty">
                    <b>{t('family.sheet.noCharges')}</b>
                  </div>
                )
              ) : receipts.length ? (
                <YearLedger
                  key="in"
                  keepSecond
                  items={[...receipts].sort((x, y) => y.p.date.localeCompare(x.p.date))}
                  dateOf={(r) => r.p.date}
                  head={[t('family.sheet.date'), t('family.sheet.member'), t('family.sheet.amount'), t('list.col.inBase', { ccy: base })]}
                  yearCells={(ys) => ({
                    // 这一年交过钱的人：与付款表的支付方式一样，一个人写胶囊，几个人把头像叠在一起，悬停看名单
                    second: (() => {
                      const who = [...new Map(ys.map((r) => [r.m.id, r.m])).values()];
                      if (who.length === 1)
                        return (
                          <span className="who-chip">
                            <MemberAvatar state={state} m={who[0]} size={16} masked={masked} />
                            <span className={masked ? 'car-private' : undefined} aria-hidden={masked || undefined}>
                              {who[0].name || t('family.pool.unnamed')}
                            </span>
                          </span>
                        );
                      return (
                        <span className="dt-ava-stack" title={masked ? undefined : who.map((m) => m.name || t('family.pool.unnamed')).join('\n')}>
                          {who.slice(0, 6).map((m) => (
                            <MemberAvatar key={m.id} state={state} m={m} size={20} masked={masked} />
                          ))}
                          {who.length > 6 && <small>+{who.length - 6}</small>}
                        </span>
                      );
                    })(),
                    orig: copyParts(currencyTotals(ys, (r) => r.p, flow)),
                    base: formatTotal(sumTotals(ys.map((r) => convertedTotal(state, r.p.amount, r.p.currency, r.p.date))), base, { direction: 1 }),
                  })}
                  row={({ m, p, base: v }) => ({
                    date: <time dateTime={p.date}>{cnDateFull(p.date)}</time>,
                    // 人员一律用胶囊
                    second: (
                      <span className="who-chip">
                        <MemberAvatar state={state} m={m} size={16} masked={masked} />
                        <span className={masked ? 'car-private' : undefined} aria-hidden={masked || undefined}>
                          {m.name || t('family.pool.unnamed')}
                        </span>
                      </span>
                    ),
                    orig: (
                      <>
                        {flow(p.amount, p.currency)}
                        {p.kind === 'refund' && <em className="dt-kind">{t('family.sheet.refund')}</em>}
                      </>
                    ),
                    base: flow(v, base),
                  })}
                  rowKey={({ m, p }, i) => `${m.id}-${p.date}-${i}`}
                  rowTitle={({ p }) => (masked ? undefined : p.note)}
                  onRow={({ m, p }) => (onPayment && p.kind === 'receipt' ? onPayment(m, p.id) : onMember(m))}
                />
              ) : (
                <div className="car-empty">
                  <b>{t('family.facts.noRecords')}</b>
                  <span>{t('family.sheet.receiptHint')}</span>
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
      {editingRule && createPortal(<CarRuleSheet state={state} s={s} today={today} rule={rule} onClose={() => setEditingRule(false)} />, document.body)}
    </DetailSheet>
  );
}

/**
 * 合租账本，像一张小利润表：订阅一年花多少（成本）、成员一年交多少（收入）、两者之差（利润）。
 * 利润为负就是我自己用的那部分；下面一行是发起以来实际付出和收回的钱。
 */
/** 车卡上的数字：这辆车现在每年的成本与收入；第三格与代付卡同一规则，有人待收时是待收，否则是年净额 */
export function CarFacts({ book, base, owed, owedCount = 0 }: { book: ReturnType<typeof carLedger>; base: string; owed?: FxTotal; owedCount?: number }) {
  const net = book.yearIncome - book.yearCost;
  // 卡片看这辆车现在每年的账：量级稳定、各车可比；累计历史放在详情页
  return (
    <div className="car-book">
      <MetricCards inline>
        <div>
          <small>{t('family.facts.yearCost')}</small>
          <b>{formatTotal(book.partial.yearCost, base, { direction: -1, compact: true })}</b>
        </div>
        <div>
          <small>{t('family.facts.yearIncome')}</small>
          <b className={book.yearIncome > 0 ? 'green' : undefined}>{formatTotal(book.partial.yearIncome, base, { direction: 1, compact: true })}</b>
        </div>
        {owed && owedCount > 0 ? (
          <div>
            <small>{t('family.pool.owedN', { count: owedCount })}</small>
            <b className="warn">{formatTotal(owed, base, { compact: true, approx: true })}</b>
          </div>
        ) : (
          <div>
            <small>{t('family.strip.yearNet')}</small>
            <b className={net > 0 ? 'gain' : net < 0 ? 'loss' : undefined}>{formatTotal(book.partial.yearNet, base, { direction: -1, compact: true })}</b>
          </div>
        )}
      </MetricCards>
    </div>
  );
}

/** 修改车的收款规则：周期、每次收多少、统一收款日；跟随车的成员从生效日起改用新标准 */
export function CarRuleSheet({ state, s, today, rule, onClose }: { state: AppState; s: Subscription; today: string; rule: CarRule; onClose: () => void }) {
  const [draft, setDraft] = useState<CarRule>(rule);
  // 下期收款日：新标准从这天起执行，也是全车往后的收款节奏；默认按现在的节奏算出的下一次
  const [next, setNext] = useState(nextCollectionDay(s, rule.billEvery, today));
  const followers = (s.share?.members ?? []).filter((m) => followsCar(state, s, m, today) && (!m.left || m.left > today)).length;
  // 席位不能少于车上现有的人（含自己）
  const taken = carpoolRoster(s, today).taken;
  const [seats, setSeats] = useState(s.share?.seats ?? taken);
  const [busy, submit] = useSubmit();
  const save = () =>
    run(async () => {
      // 改了收款日：已有成员钉住原基准，历史不重切，从这天起按新节奏收
      const out = moveCollectFrom(applyCarRule(state, s, draft, next, today), next);
      await saveSub({ ...out, share: { ...out.share!, seats } });
      onClose();
    }, t('family.member.saved'));
  return (
    <Sheet
      narrow
      title={t('family.rule.sheetTitle')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('family.member.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !(draft.fee >= 0)} onClick={() => void submit(save)}>
            {t('family.member.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group foot={t('family.rule.applyNote', { count: followers })}>
          <FeeRuleFields value={draft} onChange={setDraft} />
          <Cell label={t('family.collect.feeFrom')}>
            <DatePicker value={next} onChange={(v) => v && setNext(v)} />
          </Cell>
        </Group>
        <Group>
          <Cell label={t('family.convert.seats')}>
            <Stepper
              label={t('family.convert.seats')}
              value={seats}
              min={Math.max(1, taken)}
              max={50}
              unit={(n) => t('family.convert.seatUnit', { count: n })}
              onChange={setSeats}
            />
          </Cell>
        </Group>
      </div>
    </Sheet>
  );
}

/** 收付切换的标签：两种写法都渲染，按卡片宽度只显示放得下的那种（styles.css 的 .car-ledger 容器查询） */
function TabLabel({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="tab-full">{full}</span>
      <span className="tab-short">{short}</span>
    </>
  );
}

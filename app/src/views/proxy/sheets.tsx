import { formatTotal, scaleTotal, totalNote } from '../../../../shared/fx-total.ts';
import { copyParts } from '../../components/copy.tsx';
import { PersonAvatar, personFor } from '../../components/PersonAvatar.tsx';
import { useRef, useState } from 'react';
import { cycleLabel, effectiveStatus, nextCharge, todayIn, isStopped, uid } from '../../../../shared/billing.ts';
import { flow, cnDate, cnDateFull, currencyDecimals, money } from '../../../../shared/format.ts';
import { toBaseOrNaN } from '../../../../shared/fx.ts';
import type { AppState, Receipt, Subscription, Waiver } from '../../../../shared/types.ts';
import { recordProxyCharge } from '../../../../shared/receivable-edit.ts';
import { editRecordPeriod, removeRecordPeriod } from '../../../../shared/receivables.ts';
import { periodFields, ReceivableSheet, usePeriodEdit } from '../Receivable.tsx';
import { DetailHead, DetailSheet, Facts, Note, Panel, Prop } from '../../components/DetailKit.tsx';
import { YearLedger } from '../../components/YearLedger.tsx';
import { MetricCards, Metric, Cell, Group, IconButton } from '../../components/ui.tsx';
import { MoneyInput, useSubmit } from '../../components/inputs.tsx';
import { NameLink, PayBadge, StatusPill, SubIcon } from '../../components/marks.tsx';
import { Sheet } from '../../components/overlays.tsx';
import { ConfirmButton } from '../../components/ConfirmButton.tsx';
import { CircleStop, Eye, EyeOff, Plus } from 'lucide-react';
import { createPortal } from 'react-dom';
import { StopPanel } from '../../components/StopPanel.tsx';
import { Act } from '../Detail.tsx';
import { contactText } from '../../components/Contact.tsx';
import { getState, saveSub } from '../../store.ts';
import { run } from '../../toast.ts';
import { CurrencySelect } from '../../components/Picker.tsx';
import { proxyAhead, proxyLedger, proxyTotals } from '../../../../shared/proxy.ts';
import { t } from '../../../../shared/i18n.ts';
import { CopyImageButton } from '../../components/CopyImageButton.tsx';
import { summarySnapshot } from '../carpool-snapshot.ts';
import type { Row } from './common.tsx';
import { rows } from './common.tsx';
import { proxyStatus } from './common.tsx';
import { OwedOrNet } from './common.tsx';

/** 代付详情：上面是订阅与对象的基本信息和汇总，下面是每一期的扣款与收款列表；点一行记收款或修改 */
export function LedgerSheet({ state, s, onClose, onOpen }: { state: AppState; s: Subscription; onClose: () => void; onOpen: (s: Subscription) => void }) {
  const today = todayIn(state.settings.timezone);
  const base = state.settings.baseCurrency;
  const summaryRef = useRef<HTMLDivElement>(null);
  const [masked, setMasked] = useState(false);
  const live = state.subscriptions.find((x) => x.id === s.id) ?? s;
  const list = rows(state, live, today);
  const ahead = proxyAhead(state, live, today);
  const [edit, setEdit] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [stopping, setStopping] = useState(false);
  const px = live.proxy!;
  const st = effectiveStatus(live, today);
  const stopped = isStopped(st);
  const next = nextCharge(live, today);
  const method = state.methods.find((m) => m.id === live.methodId);
  const { done, open, diff, lastIn, partial } = proxyTotals(list);
  // 表格的行：预收的期（还没扣款）在前，然后是已扣款的期，都按日期从新到旧
  const all = [...ahead, ...list];
  const cardCcy = list.find((r) => r.currency !== r.listCurrency)?.currency;
  const [tone, label] = proxyStatus(st, list, ahead);

  return (
    <DetailSheet label={t('proxy.detailTitle')} onClose={onClose}>
      <div className="dt car-summary" ref={summaryRef}>
        <DetailHead
          icon={<SubIcon sub={live} size={48} />}
          title={
            <NameLink
              onClick={() => {
                onClose();
                onOpen(live);
              }}
            >
              {live.name}
            </NameLink>
          }
          // 待收已在指标卡里写明期数和金额，标题旁不再重复
          badge={tone !== 'owe' && <StatusPill tone={tone}>{label}</StatusPill>}
          meta={
            <>
              <b>
                {money(live.price, live.currency)} {cycleLabel(live.cycle)}
              </b>
              {cardCcy && <span>{t('proxy.cardCcy', { ccy: cardCcy })}</span>}
            </>
          }
          actions={
            <span className="dt-header-tools" data-snapshot-hide>
              {/* 不用绕回订阅详情：在这里直接停止代付，与订阅详情是同一个停止面板 */}
              {live.cycle.unit !== 'lifetime' && !stopped && <Act icon={<CircleStop size={15} />} label={t('proxy.stop')} onClick={() => setStopping(true)} />}
              <IconButton
                aria-label={t(masked ? 'family.sheet.showPersonal' : 'family.sheet.hidePersonal')}
                aria-pressed={masked}
                onClick={() => setMasked(!masked)}
              >
                {masked ? <EyeOff size={17} /> : <Eye size={17} />}
              </IconButton>
              <CopyImageButton render={() => summarySnapshot(summaryRef.current!)} />
            </span>
          }
          onClose={onClose}
        />
        <div className="dt-body">
          <MetricCards>
            {/* 弹窗里看的是明细：金额都写到分，不用简写 */}
            <Metric
              label={t('proxy.paidPeriods', { count: list.length })}
              value={formatTotal(partial.charged, base, { direction: -1, main: true })}
              note={
                totalNote(partial.charged) ||
                (list.length
                  ? t('proxy.page.perPeriod', { amount: formatTotal(scaleTotal(partial.charged, 1 / list.length), base, { direction: -1, average: true }) })
                  : undefined)
              }
            />
            <Metric
              label={t('proxy.received')}
              value={formatTotal(partial.received, base, { direction: 1, main: true })}
              valueClassName="green"
              note={
                // 预收的期还没扣款，不计入已收回，在这里单独说一句
                partial.received.incomplete
                  ? totalNote(partial.received)
                  : ahead.length
                    ? t('proxy.page.prepaid', {
                        count: ahead.length,
                        amount: formatTotal(proxyTotals(ahead).partial.received, base),
                      })
                    : lastIn
                      ? t('proxy.page.lastIn', { date: cnDateFull(lastIn) })
                      : t('proxy.page.noneIn')
              }
            />
            <OwedOrNet list={list} base={base} exact />
            {/* 还有待收时，已收各期的汇差单列；全部结清后第三格就是盈亏，不再重复 */}
            {open.length > 0 && (Math.abs(diff) >= 0.5 || partial.diff.incomplete) && (
              <Metric
                label={t('family.strip.profit')}
                value={formatTotal(partial.diff, base, { direction: 1, main: true })}
                valueClassName={partial.diff.incomplete ? undefined : diff > 0 ? 'done' : 'loss'}
                note={
                  totalNote(partial.diff) ||
                  t('proxy.page.perPeriod', { amount: formatTotal(scaleTotal(partial.diff, 1 / done.length), base, { direction: 1, average: true }) })
                }
              />
            )}
          </MetricCards>
          <Facts
            items={
              <>
                <Prop k={t('proxy.forWhom')}>
                  <span className="row">
                    {masked ? (
                      <span className="car-private-avatar" style={{ width: 20, height: 20 }} aria-hidden="true" />
                    ) : (
                      <PersonAvatar p={personFor(state, px.personId, px.forName)} size={20} />
                    )}
                    <span className={masked ? 'car-private' : undefined} aria-hidden={masked || undefined}>
                      {px.forName || t('proxy.unset')}
                    </span>
                  </span>
                  {contactText(px) && (
                    <small>
                      <span className={masked ? 'car-private' : undefined} aria-hidden={masked || undefined}>
                        {contactText(px)}
                      </span>
                    </small>
                  )}
                </Prop>
                <Prop k={t('proxy.method')}>
                  <PayBadge m={method} />
                </Prop>
                <Prop k={stopped ? t('proxy.stoppedAt') : t('proxy.nextCharge')}>
                  {stopped ? (live.end ? cnDateFull(live.end) : '—') : next ? cnDateFull(next) : '—'}
                </Prop>
              </>
            }
          >
            {px.note &&
              (masked ? (
                <div className="dt-note">
                  <span className="car-private" aria-hidden="true">
                    {px.note}
                  </span>
                </div>
              ) : (
                <Note text={px.note} />
              ))}
          </Facts>

          {/* 与订阅详情、合租详情一样：标题和操作在卡片里，表格贴着卡片边 */}
          <Panel
            className="dt-charges"
            title={t('proxy.table.title')}
            aside={
              <button className="dt-btn dt-add" data-snapshot-hide onClick={() => setAdding(true)}>
                <Plus size={14} /> {t('proxy.receipt.add')}
              </button>
            }
          >
            {/* 与订阅详情、合租详情同一套表格（YearLedger）：每年最多一条时平铺，任一年多条则统一按年分组带小计；没有合计行，总数在上方指标卡 */}
            {all.length ? (
              <YearLedger
                items={all}
                keepSecond
                dateOf={(r) => r.date}
                head={[t('proxy.table.date'), t('proxy.table.charged'), t('proxy.table.received'), t('proxy.table.diff')]}
                extraHead={t('proxy.table.cost')}
                yearCells={(ys) => {
                  // 实扣、成本、差额只算已经扣款的期：预收的期还没扣，不计入已代付与盈亏（与上方指标卡一致）；收回按实际收到的钱，预收的也算
                  const done = ys.filter((r) => r.date <= today);
                  const ccys = new Set(done.map((r) => r.currency));
                  const settled = done.filter((r) => r.receivedBase != null);
                  const received = ys.filter((r) => r.receivedBase != null);
                  const d = settled.reduce((a, r) => a + r.receivedBase! - r.chargedBase, 0);
                  return {
                    second: ccys.size === 1 ? flow(-done.reduce((a, r) => a + r.charged, 0), done[0].currency) : '',
                    extra: formatTotal(proxyTotals(done).partial.charged, base, { direction: -1 }),
                    orig: <span className="green">{formatTotal(proxyTotals(received).partial.received, base, { direction: 1 })}</span>,
                    base: settled.length
                      ? Math.abs(d) < 0.5
                        ? t('proxy.table.even')
                        : formatTotal(proxyTotals(settled).partial.diff, base, { direction: 1 })
                      : '—',
                    baseClass: !settled.length || !Number.isFinite(d) || Math.abs(d) < 0.5 ? 'muted' : d > 0 ? 'gain' : 'loss',
                  };
                }}
                row={(r) => {
                  const ahead = r.date > today;
                  const d = ahead || r.receivedBase == null ? undefined : r.receivedBase - r.chargedBase;
                  return {
                    date: (
                      <>
                        {cnDate(r.date)}
                        {ahead && <small>{t('proxy.table.notCharged')}</small>}
                      </>
                    ),
                    second: flow(-r.charged, r.currency),
                    extra: flow(-r.chargedBase, base),
                    orig: r.receivedBase == null ? <em className="todo">{t('proxy.table.record')}</em> : <ReceivedCell r={r} base={base} brief />,
                    base: d == null ? '—' : Math.abs(d) < 0.5 ? t('proxy.table.even') : flow(d, base),
                    baseClass: d == null || !Number.isFinite(d) || Math.abs(d) < 0.5 ? 'muted' : d > 0 ? 'gain' : 'loss',
                  };
                }}
                rowKey={(r) => r.date}
                rowClass={(r) => (r.date > today ? 'ld-ahead' : '')}
                rowTitle={(r) => (masked ? undefined : (r.receipt?.note ?? r.waiver?.note ?? r.charge?.note))}
                onRow={setEdit}
              />
            ) : (
              <div className="muted dt-import-note">{t('proxy.table.none')}</div>
            )}
          </Panel>
        </div>
      </div>
      {stopping &&
        createPortal(
          <Sheet title={t('proxy.stop')} narrow onClose={() => setStopping(false)}>
            <StopPanel
              sub={live}
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
      {edit && <EntrySheet state={state} s={live} row={edit} onClose={() => setEdit(null)} />}
      {adding && <ReceiptSheet state={state} s={live} onClose={() => setAdding(false)} />}
    </DetailSheet>
  );
}

/** 收回一列：这一期分到的钱；收款日与扣款日不同、外币折合、一笔分几期时在下面补一行。免收、期初结清写明 */
export function ReceivedCell({ r, base, brief }: { r: Row; base: string; brief?: boolean }) {
  if (r.status === 'waived') return <span className="muted">{t('receivable.waived')}</span>;
  const e = r.receipt!;
  if (r.share == null) return <span className="green">{t('receivable.opening')}</span>;
  // 表格里只写收回多少，每行一样高；收款日、外币折合、一笔分几期点开这一期再看
  if (brief)
    return (
      <span>
        <b className="green">{flow(r.share, e.currency)}</b>
      </span>
    );
  const lines = [
    // 当天就收回的不再写收款日，和左边的扣款日重复
    e.date !== r.date && t('proxy.table.receivedOn', { date: cnDate(e.date) }),
    e.currency !== base && `≈ ${flow(r.receivedBase!, base)}`,
  ].filter(Boolean);
  return (
    <span className="green">
      <b className="green">{flow(r.share, e.currency)}</b>
      {lines.length > 0 && <small style={{ color: 'var(--green)' }}>{copyParts(lines.join('\n'))}</small>}
      {/* 一笔分几期只在宽屏写；窄屏点开这一期能看到 */}
      {e.periods.length > 1 && (
        <small className="ld-batch" style={{ color: 'var(--green)' }}>
          {t('receivable.batch', { amount: money(e.amount, e.currency), count: e.periods.length })}
        </small>
      )}
    </span>
  );
}

/**
 * 记一笔收款或免收（与合租同一个表单）：勾选抵扣哪几期，可以跳过前面没收的期，也可以勾还没扣款的期（预收）；
 * 金额按各期实扣的比例分摊。传 edit 时修改那一笔
 */
export function ReceiptSheet({
  state,
  s,
  edit,
  preset,
  onClose,
}: {
  state: AppState;
  s: Subscription;
  edit?: Receipt | Waiver;
  preset?: string[];
  onClose: () => void;
}) {
  const today = todayIn(state.settings.timezone);
  const px = s.proxy!;
  return (
    <ReceivableSheet
      state={state}
      today={today}
      person={{ ...personFor(state, px.personId, px.forName), name: px.forName || t('proxy.unset') }}
      ledger={(through) => proxyLedger(s, today, through).periods}
      record={px}
      edit={edit}
      preset={preset}
      defaultCurrency={state.settings.baseCurrency}
      save={async (r) => {
        const current = getState().subscriptions.find((x) => x.id === s.id) ?? s;
        await saveSub({ ...current, proxy: { ...current.proxy!, receipts: r.receipts, waivers: r.waivers } });
      }}
      onDone={onClose}
    />
  );
}

/**
 * 一期的详情：卡上实扣和这一期收回的情况。平时只看；点「编辑」后就地改实扣、收款日期、金额和备注，再点保存。
 * 一笔分几期时改的是这一期，保存时把它单独拆出来；删除也只去掉这一期。没收的期另记一笔
 */
export function EntrySheet({ state, s, row, onClose }: { state: AppState; s: Subscription; row: Row; onClose: () => void }) {
  const base = state.settings.baseCurrency;
  const today = todayIn(state.settings.timezone);
  const live = state.subscriptions.find((x) => x.id === s.id) ?? s;
  const future = row.date > today;
  const rec = row.receipt ?? row.waiver;
  // 收款这一组与成员表点开的一格是同一组字段（periodFields）；卡上实扣是代付独有的
  const edit = usePeriodEdit(row);
  const editing = edit.editing;
  const [recording, setRecording] = useState<'new' | 'batch' | null>(null);
  const charged0 = row.charge?.amount != null ? String(row.charge.amount) : '';
  const [charged, setCharged] = useState(charged0);
  const [chargedCcy, setChargedCcy] = useState(row.charge?.currency ?? row.listCurrency);
  // 卡币种与原价不同：按扣款当天汇率把原价折成卡币种，作建议值
  const suggest = (ccy: string) => {
    const n = toBaseOrNaN(state, row.list, row.listCurrency, row.date, ccy);
    const unit = 10 ** currencyDecimals(ccy);
    return Number.isFinite(n) ? Math.round(n * unit) / unit : undefined;
  };
  // 换币种时，没填或还是上一个建议值就换成新币种的建议值；换回原价币种则留空（按原价）
  const changeCcy = (ccy: string) => {
    const prev = suggest(chargedCcy);
    if (charged === '' || (prev != null && Number(charged) === prev)) setCharged(ccy === row.listCurrency ? '' : String(suggest(ccy) ?? ''));
    setChargedCcy(ccy);
  };
  const chargedN = charged === '' ? row.list : Number(charged);
  // 缺汇率时为 NaN：差额显示「—」，不按 0 算出假的盈亏
  const chargedBase = toBaseOrNaN(state, chargedN, charged === '' ? row.listCurrency : chargedCcy, row.date);
  // 还没扣款的期没有实扣，不比盈亏
  const diff = future || row.receivedBase == null ? undefined : row.receivedBase - chargedBase;
  const chargeDirty = !future && (charged !== charged0 || (charged !== '' && chargedCcy !== (row.charge?.currency ?? row.listCurrency)));
  const valid = (charged === '' || Number.isFinite(Number(charged))) && edit.valid;

  const [busy, submit] = useSubmit();
  const save = () =>
    run(async () => {
      let next = getState().subscriptions.find((x) => x.id === s.id) ?? live;
      if (chargeDirty) {
        const n = charged === '' ? undefined : Number(charged);
        next = recordProxyCharge(
          next,
          {
            charge: row.date,
            ...(n != null ? { amount: n } : {}),
            ...(n != null && chargedCcy !== row.listCurrency ? { currency: chargedCcy } : {}),
            ...(row.charge?.note ? { note: row.charge.note } : {}),
          },
          today,
        ).after;
      }
      if (edit.dirty && rec) {
        const periods = proxyLedger(next, today).periods;
        next = { ...next, proxy: { ...next.proxy!, ...editRecordPeriod(next.proxy!, rec.id, row, edit.patch, periods, uid()) } };
      }
      await saveSub(next);
      onClose();
    }, t('proxy.entry.saved'));
  // 只把这一期从记录里去掉：一笔分几期时其余期照旧，金额扣掉这一期分到的
  const remove = () =>
    rec &&
    submit(() =>
      run(async () => {
        const current = getState().subscriptions.find((x) => x.id === s.id) ?? live;
        const periods = proxyLedger(current, today).periods;
        await saveSub({ ...current, proxy: { ...current.proxy!, ...removeRecordPeriod(current.proxy!, rec.id, row, periods) } });
        onClose();
      }, t('receivable.toastRemoved')),
    );

  return (
    <Sheet
      narrow
      title={t('proxy.entry.title', { date: cnDateFull(row.date) })}
      onClose={onClose}
      foot={
        <>
          {rec && (
            <ConfirmButton disabled={busy} hint={t('receivable.toastRemoved')} onConfirm={() => void remove()}>
              {t('common.delete')}
            </ConfirmButton>
          )}
          <span className="grow" />
          <button
            className="btn"
            onClick={
              editing
                ? () => {
                    edit.cancel();
                    setCharged(charged0);
                    setChargedCcy(row.charge?.currency ?? row.listCurrency);
                  }
                : onClose
            }
          >
            {t('proxy.entry.cancel')}
          </button>
          {editing ? (
            <button className="btn primary" disabled={busy || !valid || !(chargeDirty || edit.dirty)} onClick={() => void submit(save)}>
              {t('proxy.entry.save')}
            </button>
          ) : (
            <>
              {(edit.editable || !future) && (
                <button className={rec ? 'btn primary' : 'btn'} disabled={busy} onClick={edit.start}>
                  {t('detail.action.edit')}
                </button>
              )}
              {!rec && (
                <button className="btn primary" disabled={busy} onClick={() => setRecording('new')}>
                  {t('proxy.table.record')}
                </button>
              )}
            </>
          )}
        </>
      }
    >
      <div className="stack">
        {/* 卡上实扣：已扣的点编辑后可修正；还没到扣款日的只写按原价预计 */}
        <Group
          title={t('proxy.table.charged')}
          foot={
            future
              ? undefined
              : [
                  (charged === '' ? row.listCurrency : chargedCcy) !== base && t('proxy.entry.chargedRate', { amount: money(chargedBase, base) }),
                  editing && t('proxy.entry.chargedBlank', { list: money(row.list, row.listCurrency) }),
                ]
                  .filter(Boolean)
                  .join('\n') || undefined
          }
        >
          {future ? (
            <Cell label={t('proxy.entry.amount')}>
              <span className="row">
                <span className="badge">{t('proxy.table.notCharged')}</span>
                <span className="muted">{flow(-row.list, row.listCurrency)}</span>
              </span>
            </Cell>
          ) : editing ? (
            <Cell label={t('proxy.entry.amount')}>
              {/* 金额与币种同一行：数字在前、币种选择在后，与收款表单一致 */}
              <span className="contact-field">
                <MoneyInput
                  ccy={chargedCcy}
                  className="num"
                  value={charged}
                  placeholder={String(chargedCcy === row.listCurrency ? row.list : (suggest(chargedCcy) ?? ''))}
                  onChange={(ev) => setCharged((ev.target as HTMLInputElement).value)}
                />
                <CurrencySelect value={chargedCcy} onChange={changeCcy} ariaLabel={t('proxy.entry.currency')} />
              </span>
            </Cell>
          ) : (
            <Cell label={t('proxy.entry.amount')}>
              <span className="num">{flow(-chargedN, charged === '' ? row.listCurrency : chargedCcy)}</span>
            </Cell>
          )}
        </Group>
        <Group
          title={
            row.waiver
              ? t('receivable.waiverGroup')
              : live.proxy!.forName
                ? t('proxy.entry.paidBack', { name: live.proxy!.forName })
                : t('proxy.entry.paidBackAnon')
          }
          foot={
            editing
              ? edit.splits
                ? t('receivable.splitEdit')
                : undefined
              : diff == null || row.status === 'waived'
                ? undefined
                : !Number.isFinite(diff)
                  ? t('core.fxIncomplete')
                  : t(Math.abs(diff) < 0.5 ? 'proxy.entry.receivedEven' : diff > 0 ? 'proxy.entry.receivedMore' : 'proxy.entry.receivedLess', {
                      amount: flow(row.receivedBase!, base),
                      diff: money(Math.abs(diff), base),
                    })
          }
        >
          {rec ? (
            periodFields(row, { due: false, edit, onBatch: () => setRecording('batch') }).map((f) => (
              <Cell key={f.key} label={f.label}>
                {f.value}
              </Cell>
            ))
          ) : (
            <div className="cell muted">{t('proxy.entry.notReceived')}</div>
          )}
        </Group>
      </div>
      {recording && (
        <ReceiptSheet
          state={state}
          s={live}
          edit={recording === 'batch' ? rec : undefined}
          preset={recording === 'new' ? [row.key] : undefined}
          onClose={() => setRecording(null)}
        />
      )}
    </Sheet>
  );
}

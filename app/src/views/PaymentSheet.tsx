import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { useState } from 'react';
import { activePhases, addDays, chargeServicePeriod, chargesBetween, currentPhase, cycleLabel, phaseSubs, uid } from '../../../shared/billing.ts';
import { cnDateAuto, currencyDecimals, money } from '../../../shared/format.ts';
import { settlementCurrencyOf } from '../../../shared/fx.ts';
import { t } from '../../../shared/i18n.ts';
import { meterRows, periodReading, periodReadingCount, setPeriodValues, usageWithin } from '../../../shared/meters.ts';
import { deletePayment, earlyRenewalEffect, savePayment, setPhaseMethod } from '../../../shared/phases.ts';
import type { Meter, Payment, Subscription } from '../../../shared/types.ts';
import { DatePicker } from '../components/DatePicker.tsx';
import { CurrencySelect, Picker } from '../components/Picker.tsx';
import { MethodPicker } from '../components/MethodPicker.tsx';
import { Sheet } from '../components/overlays.tsx';
import { MoneyInput, NumInput, Seg, useSubmit } from '../components/inputs.tsx';
import { Cell, Group, IconButton } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { getState, saveSub } from '../store.ts';
import { run } from '../toast.ts';

type Kind = 'charge' | NonNullable<Payment['kind']>;
const KINDS: Kind[] = ['charge', 'refund', 'adjust', 'failed'];

/**
 * 记一笔 / 修改一笔扣款。金额按这一段订阅的币种填；卡上实际扣的是别的币种（如日元订阅从美元卡扣）时，
 * 另填「卡上实扣」，统计就按实扣算，汇差和手续费都算进真实成本。
 */
export function PaymentSheet({
  sub,
  today,
  edit,
  onClose,
}: {
  sub: Subscription;
  today: string;
  edit?: { pay: Payment; index: number; phase?: string };
  onClose: () => void;
}) {
  const existingPay = edit?.pay;
  const originalDate = existingPay?.date;
  const originalIndex = edit?.index;
  const originalPhase = edit?.phase;
  const [date, setDate] = useState(existingPay?.date ?? today);
  const [kind, setKind] = useState<Kind>(existingPay?.kind ?? 'charge');
  // 换区后新旧两段并行的日子：要选这笔记在哪一段（缺省为最晚开始的那段，修改时为原记录所在的段）
  const lanes = sub.phases?.length ? (kind === 'refund' ? phaseSubs(sub).filter((v) => v.start <= date) : activePhases(sub, date)) : [];
  const [lane, setLane] = useState(edit?.phase);
  // 修改已有付款时以它实际所在的段为准：提前付款的日期可能落在上一段，按日期找会拿错段的支付方式、币种
  const stored = edit?.phase ? phaseSubs(sub).find((v) => v.start === edit.phase) : undefined;
  const phase = (lanes.length > 1 && lanes.find((v) => v.start === lane)) || stored || currentPhase(sub, date);
  const pick = lanes.length > 1 ? phase.start : edit?.phase;
  const ccy = phase.currency;
  const [amount, setAmount] = useState(edit ? String(Math.abs(edit.pay.amount)) : String(phase.price));
  const [settled, setSettled] = useState(existingPay?.settled ? String(Math.abs(existingPay.settled.amount)) : '');
  const [settledCcyOverride, setSettledCcy] = useState(existingPay?.settled?.currency);
  const [note, setNote] = useState(existingPay?.note ?? '');
  const sign = kind === 'refund' ? -1 : 1;
  // 支付方式：缺省为这一笔单独记的，否则是所属这一段的；换了卡时选只改这一笔，还是整段一起改
  const [method, setMethod] = useState(existingPay?.methodId ?? phase.methodId);
  const settledCcy = settledCcyOverride ?? settlementCurrencyOf(getState(), ccy, method);
  const changed = method !== (existingPay?.methodId ?? phase.methodId);
  const [scope, setScope] = useState<'one' | 'phase'>(phase.methodId ? 'one' : 'phase');
  const phaseCount = chargesBetween(phase, phase.start, today, today).length;
  // 资金拆分：一笔订单由几个来源合付；金额按订阅币种，合计等于本笔
  const [split, setSplit] = useState<Array<{ methodId?: string; amount: string }> | null>(
    existingPay?.funding?.length ? existingPay.funding.map((f) => ({ methodId: f.methodId, amount: String(Math.abs(f.amount)) })) : null,
  );
  const splitSum = (split ?? []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
  // 差额按这一段币种的小数位取整（日元等没有小数）
  const unit = 10 ** currencyDecimals(ccy);
  const left = Math.round((Number(amount) - splitSum) * unit) / unit;
  const amountValid = amount.trim() !== '' && Number(amount) >= 0;
  const blanks = (split ?? []).filter((x) => x.amount === '').length;
  // 用量跟计费周期走：填的数记在这笔扣款覆盖的那段时间里，周期内已有记录就改它；只写改过的指标
  // 关联指标的数值存在来源订阅上，这里只填自己的
  const meters = (sub.meters ?? []).filter((m) => !m.link);
  // 改日期时原记录还在旧日期上，按它算会把旧日期当成「已按时结清」的边界，周期归错；算周期前先拿掉正在改的这笔
  const others = (() => {
    const list = phase.payments ?? [];
    const at = existingPay ? list.findIndex((p) => p.date === existingPay.date && p.amount === existingPay.amount && p.kind === existingPay.kind) : -1;
    return at < 0 ? phase : { ...phase, payments: list.filter((_, i) => i !== at) };
  })();
  const period = kind === 'charge' && meters.length && phase.cycle.unit !== 'lifetime' ? chargeServicePeriod(others, date) : undefined;
  const [usage, setUsage] = useState<Record<string, number | undefined>>({});
  // 周期内同一指标记了多条时只读：本期用量显示合计（与扣款记录的用量列一致），累计读数显示最新一条
  const several = (m: Meter) => !!period && periodReadingCount(sub, period.from, period.until, m.id) > 1;
  const usageOf = (m: Meter) => {
    if (!period) return undefined;
    if (several(m) && m.kind !== 'reading') return usageWithin(meterRows(sub, m, today), period.from, period.until);
    return m.id in usage ? usage[m.id] : periodReading(sub, period.from, period.until, m.id)?.values[m.id];
  };
  const setPart = (i: number, patch: Partial<{ methodId?: string; amount: string }>) => setSplit((xs) => xs!.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  // 这笔会算提前续费时先说明结果；临时加购等额外费用可以一键改成调整，不影响到期日
  const target = originalDate && originalIndex != null ? { date: originalDate, index: originalIndex } : undefined;
  const early = kind === 'charge' ? earlyRenewalEffect(sub, today, { date, amount: Number(amount) || 0 }, target, pick) : undefined;

  const [busy, submit] = useSubmit();
  const save = () => {
    const n = Number(amount);
    if (!amountValid) return;
    const pay: Payment = {
      date,
      amount: sign * n,
      currency: ccy,
      kind: kind === 'charge' ? undefined : kind,
      settled: settled !== '' && Number(settled) >= 0 ? { amount: sign * Number(settled), currency: settledCcy } : undefined,
      note: note.trim() || undefined,
      methodId: split ? undefined : changed ? (scope === 'one' && method !== phase.methodId ? method : undefined) : existingPay?.methodId,
      // 只剩一个来源没填金额时，它补上差额；其余校验（来源不同、合计相等）由 savePayment 统一做
      // 没选来源也没填金额的空行直接忽略
      funding: split
        ?.filter((x) => x.methodId || x.amount !== '')
        .map((x) => ({ methodId: x.methodId ?? '', amount: sign * (x.amount === '' && blanks === 1 ? left : Number(x.amount)) })),
    };
    return submit(() =>
      run(
        async () => {
          let next = savePayment(sub, today, pay, target, pick);
          if (!split && changed && scope === 'phase') next = setPhaseMethod(next, phase.start, method);
          if (period && Object.keys(usage).length) {
            // 新建的记录记在周期末日，周期还没过完时记今天
            const last = addDays(period.until, -1);
            const day = last < today ? last : today < period.from ? period.from : today;
            next = setPeriodValues(next, period.from, period.until, usage, { id: uid(), date: day });
          }
          await saveSub(next);
          onClose();
        },
        t(edit ? 'editor.payment.toast.edited' : 'editor.payment.toast.added'),
      ),
    );
  };
  const remove = async () => {
    if (!originalDate || originalIndex == null) return;
    return submit(() =>
      run(async () => {
        await saveSub(deletePayment(sub, today, originalDate, originalIndex, originalPhase));
        onClose();
      }, t('editor.payment.toast.deleted')),
    );
  };

  return (
    <Sheet
      narrow
      title={t(edit ? 'editor.payment.editTitle' : 'editor.payment.addTitle')}
      onClose={onClose}
      foot={
        <>
          {edit && (
            <ConfirmButton disabled={busy} onConfirm={remove}>
              {t('common.delete')}
            </ConfirmButton>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !amountValid} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group
          foot={
            early && (
              <>
                {t('editor.payment.earlyHint', { settles: cnDateAuto(early.settles, today), next: cnDateAuto(early.next, today) })}{' '}
                <button type="button" className="as-link" onClick={() => setKind('adjust')}>
                  {t('editor.payment.earlyExtra')}
                </button>
              </>
            )
          }
        >
          <Cell label={t('editor.payment.date')}>
            <DatePicker value={date} onChange={(v) => setDate(v ?? today)} />
          </Cell>
          {lanes.length > 1 && (
            <Cell label={t('editor.overlap.payPhase')}>
              <Picker
                value={phase.start}
                onChange={(v) => {
                  setLane(v);
                  const p = lanes.find((x) => x.start === v);
                  if (!edit && p) setAmount(String(p.price));
                }}
                options={lanes.map((v) => ({
                  value: v.start,
                  label: `${v.region ? `${v.region}\n` : ''}${money(v.price, v.currency)} ${cycleLabel(v.cycle)}`,
                }))}
                ariaLabel={t('editor.overlap.payPhase')}
              />
            </Cell>
          )}
          <Cell label={t('editor.payment.kind.label')}>
            <Picker
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => ({ value: k, label: t(`editor.payment.kind.${k}`) }))}
              ariaLabel={t('editor.payment.kind.label')}
            />
          </Cell>
        </Group>
        <Group
          title={split ? t('editor.payment.sources') : undefined}
          action={
            <button
              type="button"
              className="btn plain"
              onClick={() =>
                setSplit(
                  split
                    ? null
                    : [
                        { methodId: method, amount },
                        { methodId: undefined, amount: '' },
                      ],
                )
              }
            >
              {t(split ? 'editor.payment.unsplit' : 'editor.payment.split')}
            </button>
          }
          foot={
            split
              ? Math.abs(left) < 0.5 / unit || (blanks === 1 && left > 0)
                ? t('editor.payment.splitOk', { amount: money(Number(amount) || 0, ccy) })
                : t('editor.payment.splitLeft', { amount: money(left, ccy) })
              : undefined
          }
        >
          {split ? (
            <>
              {split.map((x, i) => (
                <div className="cell pay-split" key={i}>
                  <MethodPicker methods={getState().methods} value={x.methodId} onChange={(v) => setPart(i, { methodId: v })} />
                  <MoneyInput
                    ccy={ccy}
                    className="num"
                    aria-label={t('editor.payment.amount', { currency: ccy })}
                    placeholder={x.amount === '' && blanks === 1 && left > 0 ? String(left) : '0'}
                    value={x.amount}
                    onChange={(e) => setPart(i, { amount: (e.target as HTMLInputElement).value })}
                  />
                  {split.length > 2 && (
                    <IconButton aria-label={t('common.delete')} onClick={() => setSplit(split.filter((_, k) => k !== i))}>
                      <Icon name="x" />
                    </IconButton>
                  )}
                </div>
              ))}
              <button type="button" className="cell tap pay-split-add" onClick={() => setSplit([...split, { methodId: undefined, amount: '' }])}>
                <Icon name="plus" />
                {t('editor.payment.addSource')}
              </button>
            </>
          ) : (
            <Cell label={t('editor.payment.method')}>
              <MethodPicker methods={getState().methods} value={method} onChange={setMethod} />
            </Cell>
          )}
          {!split && changed && phaseCount > 1 && (
            <Cell label={t('editor.payment.scope')}>
              <Seg
                small
                value={scope}
                onChange={setScope}
                options={[
                  ['one', t('editor.payment.scopeOne')],
                  ['phase', t('editor.payment.scopePhase', { count: phaseCount })],
                ]}
              />
            </Cell>
          )}
        </Group>
        {/* 金额按这一段的币种（写在标签里，跟方案走）；卡上用别的币种扣时先选实扣币种再填金额 */}
        <Group>
          <Cell label={t('editor.payment.amount', { currency: ccy })} sub={kind === 'refund' ? t('core.stop.currencyHint', { currency: ccy }) : undefined}>
            <MoneyInput ccy={ccy} className="num" value={amount} onChange={(e) => setAmount((e.target as HTMLInputElement).value)} />
          </Cell>
        </Group>
        {period && (
          <Group
            title={t('detail.meters.head.usage')}
            foot={t('editor.payment.usageFoot', { period: `${cnDateAuto(period.from, today)} – ${cnDateAuto(addDays(period.until, -1), today)}` })}
          >
            {meters.map((m) => (
              <Cell key={m.id} label={m.name} sub={m.kind === 'reading' ? t('detail.meters.reading') : undefined}>
                <NumInput
                  className="num"
                  inputMode="decimal"
                  value={usageOf(m)}
                  disabled={several(m)}
                  placeholder={t('editor.field.optional')}
                  onValue={(n) => setUsage((v) => ({ ...v, [m.id]: n }))}
                />
                {m.unit && <span className="cell-unit">{m.unit}</span>}
              </Cell>
            ))}
          </Group>
        )}
        <Group title={t('editor.payment.settled')}>
          <Cell label={t('editor.payment.settledCcy')}>
            <CurrencySelect value={settledCcy} onChange={setSettledCcy} />
          </Cell>
          <Cell label={t('editor.payment.settledAmount')}>
            <MoneyInput
              ccy={settledCcy}
              className="num"
              placeholder={t('editor.field.optional')}
              value={settled}
              onChange={(e) => setSettled((e.target as HTMLInputElement).value)}
            />
          </Cell>
        </Group>
        <Group>
          <Cell label={t('editor.field.notes')}>
            <input value={note} placeholder={t('editor.field.optional')} onChange={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Cell>
        </Group>
        {phase.payments?.length || sub.payments?.length ? null : (
          <small className="muted" style={{ padding: '0 4px' }}>
            {t('editor.payment.freezeHint', { amount: money(phase.price, ccy) })}
          </small>
        )}
      </div>
    </Sheet>
  );
}

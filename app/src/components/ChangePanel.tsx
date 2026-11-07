import { ConfirmButton } from './ConfirmButton.tsx';
import { popupOpen, sheetSubmitKey } from '../keyboard.ts';
import { useId, useState } from 'react';
import { addDays, addMonths, cycleLabel, nextCharge, nthCharge, phaseSubs } from '../../../shared/billing.ts';
import {
  changePrice,
  editPricePoint,
  removePricePoint,
  pricePoints,
  movePhaseStart,
  paymentsOutsideMovedPhase,
  syncPhase,
  removePhase,
  resume,
  setPhaseEnd,
  switchPlan,
  upgradePlan,
  upgradeQuote,
  type UpgradeMode,
} from '../../../shared/phases.ts';
import { cnDateAuto, money } from '../../../shared/format.ts';
import type { AppState, Cycle, Subscription } from '../../../shared/types.ts';
import { DatePicker } from './DatePicker.tsx';
import { History } from './History.tsx';
import { ask } from './overlays.tsx';
import { Group } from './ui.tsx';
import { Icon } from './icons.tsx';
import { Toggle } from './inputs.tsx';
import { MethodPicker } from './MethodPicker.tsx';
import { toast } from '../toast.ts';
import { CurrencySelect, Picker, RegionSelect } from './Picker.tsx';
import { t } from '../../../shared/i18n.ts';

/** 常用的续费周期（不含买断） */
export const CYCLES: Array<[string, Cycle]> = [
  ['w1', { unit: 'week', every: 1 }],
  ['m1', { unit: 'month', every: 1 }],
  ['m3', { unit: 'month', every: 3 }],
  ['m6', { unit: 'month', every: 6 }],
  ['y1', { unit: 'year', every: 1 }],
  ['y2', { unit: 'year', every: 2 }],
];
/** 周期选项的文字（w1、m1……lt） */
export const cycleName = (k: string) => t(`editor.cycle.${k}`);

type Mode = 'price' | 'switch' | 'resume';

/** 编辑页里的「历程与变更」：调价、换区 / 换套餐、续订 */
export function ChangePanel({
  f,
  setF,
  state,
  today,
  onPriceValidity,
}: {
  f: Subscription;
  setF: (s: Subscription) => void;
  state: AppState;
  today: string;
  onPriceValidity: (valid: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [point, setPoint] = useState<{ start: string; from: string; date: string; amount: string } | null>(null);
  const [pointError, setPointError] = useState('');
  const pointErrorId = useId();
  const pointPhase = point && phaseSubs(f).find((v) => v.start === point.start);
  const openPoint = (start: string, from: string) => {
    if (pointError) return;
    if (point?.start === start && point.from === from) return setPoint(null);
    const v = phaseSubs(f).find((v) => v.start === start)!;
    setPoint({ start, from, date: from, amount: String(pricePoints(v).find((p) => p.from === from)!.amount) });
    setPointError('');
    setMode(null);
  };
  const updatePoint = (patch: Partial<{ date: string; amount: string }>) => {
    if (!point) return;
    const draft = { ...point, ...patch };
    setPoint(draft);
    try {
      if (!draft.amount.trim()) throw new Error(t('editor.change.needPrice'));
      const next = editPricePoint(syncPhase(f, today), draft.start, draft.from, { from: draft.date, amount: Number(draft.amount) });
      setF(next);
      setPoint({ ...draft, from: draft.date });
      setPointError('');
      onPriceValidity(true);
    } catch (e) {
      setPointError(e instanceof Error ? e.message : String(e));
      onPriceValidity(false);
    }
  };
  const deletePoint = () => {
    if (!point) return;
    setF(removePricePoint(syncPhase(f, today), point.start, point.from));
    setPoint(null);
    setPointError('');
    onPriceValidity(true);
  };
  const [date, setDate] = useState(today);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(f.currency);
  // 现有周期不在常用列表里（如每 30 天、每 2 个月）：作为额外一项保留，不悄悄改成每月
  const same = (c: Cycle) => c.unit === f.cycle.unit && c.every === f.cycle.every;
  const [options] = useState<Array<[string, Cycle]>>(() => (CYCLES.some(([, c]) => same(c)) ? CYCLES : [['current', f.cycle], ...CYCLES]));
  const [cycle, setCycle] = useState(() => options.find(([, c]) => same(c))![0]);
  const [methodId, setMethodId] = useState(f.methodId ?? '');
  const [region, setRegion] = useState(f.region ?? '');
  const [billing, setBilling] = useState<'prepaid' | 'postpaid'>(f.billing ?? 'prepaid');
  const [planned, setPlanned] = useState(false);
  // 换区时旧的继续用到某天（已预付、还没到期），两段并行
  const [keep, setKeep] = useState(false);
  const [keepUntil, setKeepUntil] = useState(today);
  // 升级抵扣旧套餐剩余：扣款日重算或保持，实付金额默认按折算，可改；改过的金额只对同一组条件有效
  const [credit, setCredit] = useState(false);
  const [renewal, setRenewal] = useState<UpgradeMode>('reset');
  const [payEdit, setPayEdit] = useState<Record<string, string>>({});
  const ended = !!f.end || f.status === 'cancelled' || f.status === 'terminated';
  const phases = phaseSubs(f).length;

  const open = (m: Mode) => {
    if (pointError) return;
    setPoint(null);
    setMode(m);
    // 生效日要晚于当前阶段的开始日：今天就开始的新订阅，默认放到下次续费（或第二天）
    const lastStart = phaseSubs(f).pop()!.start;
    setDate(today > lastStart ? today : (nextCharge(f, addDays(lastStart, 1)) ?? addDays(lastStart, 1)));
    setPrice(m === 'price' ? '' : String(f.price));
    setCurrency(f.currency);
    setMethodId(f.methodId ?? '');
    setRegion(f.region ?? '');
    setPlanned(false);
    setKeep(false);
    setCredit(false);
    setRenewal('reset');
    setPayEdit({});
  };
  /** 旧的默认用到哪天：切换日之后它下一次扣款的前一天（已付到那天；结束日含当天，填扣款日会再扣一期），没有就用满一个月 */
  const paidThrough = (at: string) => {
    const last = phaseSubs(f).pop()!;
    return addDays(nextCharge(last, addDays(at, 2)) ?? addMonths(at, 1), -1);
  };
  const toggleKeep = (on: boolean) => {
    setKeep(on);
    if (on) setKeepUntil(paidThrough(date));
  };
  const [startError, setStartError] = useState('');
  const setStart = async (start: string, nextStart: string) => {
    if (pointError) return;
    setStartError('');
    try {
      const next = movePhaseStart(syncPhase(f, today), start, nextStart);
      const outside = paymentsOutsideMovedPhase(f, next);
      if (outside.length && !(await ask(t('editor.history.outsidePayments', { count: outside.length })))) return;
      setF(next);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    }
  };
  const setEnd = (start: string, end: string | undefined) => {
    if (pointError) return;
    try {
      setF(setPhaseEnd(f, start, end));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const planCycle = options.find(([k]) => k === cycle)![1];
  const quote =
    mode === 'switch' && !keep && !planned && price !== '' && Number(price) >= 0
      ? upgradeQuote(f, date, { price: Number(price), currency, cycle: planCycle, billing: billing === 'postpaid' ? 'postpaid' : undefined }, today)
      : undefined;
  const useCredit = credit && !!quote;
  const renewalMode: UpgradeMode = renewal === 'keep' && quote?.keep ? 'keep' : 'reset';
  const renewalLabel = quote
    ? t('editor.change.renewal', { date: cnDateAuto(renewalMode === 'keep' && quote.keep ? quote.keep.nextCharge : nthCharge(date, planCycle, 1), today) })
    : '';
  const payKey = [date, price, currency, cycle, billing, renewalMode].join('|');
  const pay = payEdit[payKey] ?? String(quote ? (renewalMode === 'keep' ? quote.keep!.amount : quote.reset) : '');

  const apply = () => {
    const n = Number(price);
    if (!(n >= 0) || price === '') return toast(t('editor.change.needPrice'), 'error');
    try {
      const plan = {
        price: n,
        currency,
        cycle: planCycle,
        billing: billing === 'postpaid' ? ('postpaid' as const) : undefined,
        methodId: methodId || undefined,
        region: region.trim().toUpperCase() || undefined,
        planned: mode === 'switch' && planned ? true : undefined,
      };
      if (useCredit && !(pay.trim() !== '' && Number(pay) >= 0)) return toast(t('editor.change.needPrice'), 'error');
      const next =
        mode === 'price'
          ? changePrice(f, date, n)
          : mode === 'switch'
            ? useCredit
              ? upgradePlan(f, date, plan, today, renewalMode, Number(pay))
              : switchPlan(f, date, plan, keep ? keepUntil : undefined)
            : resume(f, date, plan);
      setF(next);
      setMode(null);
      toast(
        t(mode === 'price' ? 'editor.change.toast.price' : mode === 'switch' ? 'editor.change.toast.switch' : 'editor.change.toast.resume', {
          done: t('common.done'),
        }),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Group title={t('editor.change.title')}>
      <History
        sub={f}
        state={state}
        today={today}
        onEnd={setEnd}
        onStart={setStart}
        onPrice={openPoint}
        priceEditor={
          point && pointPhase
            ? {
                start: point.start,
                from: point.from,
                content: (
                  <div
                    className="change-form h-price-editor"
                    data-submit=""
                    onBlur={(e) => {
                      if (!pointError && !e.currentTarget.contains(e.relatedTarget)) setPoint(null);
                    }}
                    onKeyDown={(e) => {
                      if (sheetSubmitKey(e.nativeEvent) && !popupOpen(e.currentTarget.ownerDocument)) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!pointError) setPoint(null);
                      }
                    }}
                  >
                    <label>
                      {t('editor.change.priceDate')}
                      <DatePicker
                        value={point.date}
                        min={pointPhase.start}
                        max={pointPhase.end}
                        ariaLabel={t('editor.change.priceDate')}
                        onChange={(d) => updatePoint({ date: d ?? '' })}
                      />
                    </label>
                    <label>
                      {t('editor.change.newPrice', { currency: pointPhase.currency })}
                      <input
                        inputMode="decimal"
                        value={point.amount}
                        autoFocus
                        aria-invalid={!!pointError}
                        aria-describedby={pointError ? pointErrorId : undefined}
                        onChange={(e) => updatePoint({ amount: e.target.value })}
                      />
                    </label>
                    {pointError && (
                      <p id={pointErrorId} className="h-error" role="alert">
                        {pointError}
                      </p>
                    )}
                    {pricePoints(pointPhase)[0].from !== point.from && (
                      <div className="h-price-delete">
                        <ConfirmButton hint={t('editor.history.deletePrice')} onConfirm={deletePoint}>
                          {t('common.delete')}
                        </ConfirmButton>
                      </div>
                    )}
                  </div>
                ),
              }
            : undefined
        }
      />
      {startError && (
        <p className="h-error" role="alert">
          {startError}
        </p>
      )}
      <div className="cell" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button aria-pressed={mode === 'price'} className={`btn ${mode === 'price' ? 'primary' : ''}`} onClick={() => open('price')}>
          {t('editor.change.price')}
        </button>
        <button aria-pressed={mode === 'switch'} className={`btn ${mode === 'switch' ? 'primary' : ''}`} onClick={() => open('switch')}>
          {t('editor.change.switch')}
        </button>
        {ended && (
          <button aria-pressed={mode === 'resume'} className={`btn ${mode === 'resume' ? 'primary' : ''}`} onClick={() => open('resume')}>
            {t('editor.change.resume')}
          </button>
        )}
        {phases > 1 && (
          <button className="btn danger" disabled={!!pointError} onClick={() => setF(removePhase(f, phases - 1))}>
            {t('editor.change.undo')}
          </button>
        )}
      </div>
      {mode && (
        <div className="change-form" data-submit=".sheet-actions .btn.primary">
          <label>
            {t(mode === 'price' ? 'editor.change.priceDate' : mode === 'switch' ? 'editor.change.switchDate' : 'editor.change.resumeDate')}
            <DatePicker
              compact
              value={date}
              onChange={(v) => {
                const d = v ?? today;
                setDate(d);
                if (keep && keepUntil <= d) setKeepUntil(paidThrough(d));
              }}
            />
          </label>
          <label>
            {mode === 'price' ? t('editor.change.newPrice', { currency: f.currency }) : t('editor.change.priceLabel')}
            <input inputMode="decimal" value={price} autoFocus placeholder="0.00" onChange={(e) => setPrice((e.target as HTMLInputElement).value)} />
          </label>
          {mode !== 'price' && (
            <>
              <label>
                {t('editor.field.currency')}
                <CurrencySelect value={currency} onChange={setCurrency} />
              </label>
              <label>
                {t('editor.field.cycle')}
                <Picker
                  value={cycle}
                  onChange={setCycle}
                  options={options.map(([k, c]) => ({ value: k, label: k === 'current' ? cycleLabel(c) : cycleName(k) }))}
                  ariaLabel={t('editor.field.cycle')}
                />
              </label>
              {planCycle.unit !== 'lifetime' && (
                <label>
                  {t('editor.field.billing')}
                  <Picker
                    value={billing}
                    onChange={setBilling}
                    options={[
                      { value: 'prepaid', label: t('editor.billing.prepaid') },
                      { value: 'postpaid', label: t('editor.billing.postpaid') },
                    ]}
                    ariaLabel={t('editor.field.billing')}
                  />
                </label>
              )}
              <label>
                {t('editor.field.method')}
                <MethodPicker methods={state.methods} value={methodId || undefined} onChange={(id) => setMethodId(id ?? '')} />
              </label>
              <label>
                {t('editor.field.region')}
                <RegionSelect
                  value={region || undefined}
                  onChange={(r) => setRegion(r ?? '')}
                  common={[
                    ...new Set(
                      [
                        ...state.subscriptions.flatMap((x) => [x.region, ...(x.phases ?? []).map((ph) => ph.region)]),
                        ...state.methods.map((m) => m.region),
                      ].filter(Boolean) as string[],
                    ),
                  ]}
                />
              </label>
              {quote && (
                <div className="change-keep">
                  <div className="change-keep-row">
                    <span>{t('editor.change.credit', { amount: money(quote.credit, currency) })}</span>
                    <Toggle checked={credit} onChange={setCredit} label={t('editor.change.credit', { amount: money(quote.credit, currency) })} />
                  </div>
                </div>
              )}
              {useCredit && quote && (
                <>
                  <label>
                    {renewalLabel}
                    <Picker
                      value={renewalMode}
                      onChange={setRenewal}
                      options={[
                        { value: 'reset', label: t('editor.change.renewalReset') },
                        ...(quote.keep ? [{ value: 'keep' as const, label: t('editor.change.renewalKeep') }] : []),
                      ]}
                      ariaLabel={renewalLabel}
                    />
                  </label>
                  <label>
                    {t(renewalMode === 'keep' ? 'editor.change.adjustPay' : 'editor.change.firstPay', { currency })}
                    <input inputMode="decimal" value={pay} onChange={(e) => setPayEdit({ ...payEdit, [payKey]: (e.target as HTMLInputElement).value })} />
                  </label>
                </>
              )}
              {mode === 'switch' && !useCredit && (
                <div className="change-keep">
                  <div className="change-keep-row">
                    <span>
                      {t('editor.overlap.keep')}
                      <small>{t('editor.overlap.keepHint')}</small>
                    </span>
                    <Toggle checked={keep} onChange={toggleKeep} label={t('editor.overlap.keep')} />
                  </div>
                  {keep && (
                    <label className="change-keep-date">
                      {t('editor.overlap.keepUntil')}
                      <DatePicker compact value={keepUntil} min={addDays(date, 1)} onChange={(v) => v && setKeepUntil(v)} />
                    </label>
                  )}
                </div>
              )}
              {mode === 'switch' && !useCredit && (
                <div className="change-plan">
                  <span>
                    {t('editor.change.planned')}
                    <small>{t('editor.change.plannedHint')}</small>
                  </span>
                  <Toggle checked={planned} onChange={setPlanned} label={t('editor.change.planned')} />
                </div>
              )}
            </>
          )}
          <div className="sheet-actions">
            <button className="btn" onClick={() => setMode(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" onClick={apply}>
              <Icon name="check" /> {t('common.apply')}
            </button>
          </div>
        </div>
      )}
    </Group>
  );
}

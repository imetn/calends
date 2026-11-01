import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings2 } from 'lucide-react';
import { uid, type Charge } from '../../../../shared/billing.ts';
import { chargesTotal, formatTotal } from '../../../../shared/fx-total.ts';
import { cnDateFull, monthLabel, weekdayOf } from '../../../../shared/format.ts';
import { intlLocale, t } from '../../../../shared/i18n.ts';
import { numberFormat } from '../../../../shared/intl.ts';
import { meterStats, meterSuggestions, meterSummary, replaceMeters, type MeterRow } from '../../../../shared/meters.ts';
import type { AppState, Meter, Reading, Subscription } from '../../../../shared/types.ts';
import { ConfirmButton } from '../../components/ConfirmButton.tsx';
import { DatePicker } from '../../components/DatePicker.tsx';
import { Panel } from '../../components/DetailKit.tsx';
import { Picker } from '../../components/Picker.tsx';
import { BarLine } from '../../components/charts.tsx';
import { ChargeBars } from '../DetailChart.tsx';
import { ChargeTip, chargeUsage, unitMoney, withUnit } from './ChargeTip.tsx';
import { NumInput, Seg, useSubmit } from '../../components/inputs.tsx';
import { ask, Sheet } from '../../components/overlays.tsx';
import { Cell, Group, Metric } from '../../components/ui.tsx';
import { saveSub } from '../../store.ts';
import { run } from '../../toast.ts';

/** 平均值是算出来的，按量级留小数：307.2 度、3.47 GB */
const avgQty = (n: number) => numberFormat(intlLocale(), { maximumFractionDigits: Math.abs(n) >= 100 ? 1 : 2 }).format(n);
/** 柱顶标数：过千用紧凑写法，免得挤 */
const compactQty = (n: number) =>
  numberFormat(intlLocale(), { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n);
const priceText = (r: MeterRow, unit: string) => unitMoney(r.unitPrice!, r.cost!.currency, unit);

/**
 * 顶部指标的第二行：当前指标的最近一期、平均每期、平均单价、累计（与上面一行同一网格，横竖分隔线）
 */
export function usageMetrics(sub: Subscription, cur: Meter, today: string) {
  const summary = meterSummary(sub, cur, today);
  const stats = meterStats(summary.rows);
  const latest = summary.latest;
  const isReading = cur.kind === 'reading';
  return [
    <Metric
      key="latest"
      // 多个指标时写明是哪一个（切换在下方用量卡里）
      label={(sub.meters?.length ?? 0) > 1 ? t('detail.meters.latestOf', { name: cur.name }) : t('detail.meters.latest')}
      value={latest?.usage != null ? withUnit(latest.usage, cur.unit) : '—'}
      note={latest && (isReading ? t('detail.meters.readingValue', { v: withUnit(latest.value, cur.unit) }) : cnDateFull(latest.reading.date))}
    />,
    <Metric
      key="average"
      label={t('detail.meters.average')}
      value={stats.average != null ? withUnit(stats.average, cur.unit, avgQty) : '—'}
      note={summary.periods ? t('detail.meters.periods', { n: summary.periods }) : undefined}
    />,
    <Metric
      key="price"
      label={t('detail.meters.avgPrice')}
      value={stats.unitPrice ? unitMoney(stats.unitPrice.amount, stats.unitPrice.currency, cur.unit) : '—'}
      note={summary.latestPriced && t('detail.meters.latestPrice', { v: priceText(summary.latestPriced, cur.unit) })}
    />,
    <Metric
      key="total"
      label={t('detail.meters.totalLabel')}
      value={summary.periods ? withUnit(summary.total, cur.unit) : '—'}
      note={summary.from && t('detail.meters.since', { date: cnDateFull(summary.from) })}
    />,
  ];
}

/**
 * 业务数据：订阅上自定义的指标（电量、里程、流量……）与按日期的记录，和付款分开存。
 * 没有指标时只留一个轻入口；有指标时卡片里是用量走势（指标数字在顶部第二行），点柱修改那条记录；
 * 每期用量另在扣款记录里按每笔的服务期列出。
 * 只读（公开页、演示）不显示任何编辑入口
 */
/** axis：与费用走势共用的日期横轴与范围；没有费用图时按自己的记录画 */
export function Meters({
  sub,
  state,
  today,
  history = [],
  meterId,
  onMeter,
  axis,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  /** 这个订阅的扣款：悬停用量柱时显示它所属那笔扣款的提示框 */
  history?: Charge[];
  /** 当前看的指标：与顶部用量指标行共用，由详情页持有 */
  meterId?: string;
  onMeter?: (id: string) => void;
  axis?: { from: string; to: string; since: string };
}) {
  const ro = !!state.readonly;
  const meters = sub.meters ?? [];
  const [manage, setManage] = useState(false);
  const [reading, setReading] = useState<{ id?: string } | null>(null);
  const cur = meters.find((m) => m.id === meterId) ?? meters[0];
  const setPicked = (id: string) => onMeter?.(id);
  const save = (next: Subscription, close: () => void) =>
    run(async () => {
      await saveSub(next);
      close();
    }, t('detail.meters.saved'));

  const sheets = (
    <>
      {manage &&
        createPortal(
          <MetersSheet
            sub={sub}
            suggestions={meterSuggestions(state.subscriptions, sub)}
            onSave={(next) => save(next, () => setManage(false))}
            onClose={() => setManage(false)}
          />,
          document.body,
        )}
      {reading &&
        createPortal(
          <ReadingSheet
            sub={sub}
            edit={sub.readings?.find((r) => r.id === reading.id)}
            today={today}
            onSave={(next) => save(next, () => setReading(null))}
            onClose={() => setReading(null)}
          />,
          document.body,
        )}
    </>
  );

  if (!meters.length) {
    if (ro) return null;
    return (
      <Panel className="dt-meters-empty">
        <button className="btn plain dt-meters-add" onClick={() => setManage(true)}>
          <Plus size={14} /> {t('detail.meters.add')}
        </button>
        {sheets}
      </Panel>
    );
  }

  const summary = meterSummary(sub, cur, today);
  const stats = meterStats(summary.rows);
  const base = state.settings.baseCurrency;
  const used = summary.rows.filter((r) => r.usage != null);
  const trend = axis ? used.filter((r) => r.reading.date >= axis.since && r.reading.date >= axis.from && r.reading.date <= axis.to) : used.slice(-24);
  // 提示框与费用走势同一套样式：标题行日期，逐行列用量、费用、单价；平均每期已在指标卡里，不再重复
  const tipOf = (i: number) => {
    const r = trend[i];
    // 读数所属的那笔扣款（结算区间含这一天）：与费用走势同一个提示框；还没出账的只写日期和用量
    const c = history.find((h) => chargeUsage([r], h) != null);
    if (c)
      return (
        <ChargeTip
          c={c}
          state={state}
          converted={c.currency !== base ? formatTotal(chargesTotal(state, [c], base), base, { direction: -1 }) : undefined}
          usage={chargeUsage(summary.rows, c)}
          meter={cur}
          note={r.reading.note}
        />
      );
    return (
      <>
        <div className="cc-tip-h">
          <b>{cnDateFull(r.reading.date)}</b>
          <span>{weekdayOf(r.reading.date)}</span>
        </div>
        <div className="cc-tip-r">
          <span>{t('detail.meters.head.usage')}</span>
          <b>{withUnit(r.usage!, cur.unit)}</b>
        </div>
        {r.reading.note && <div className="cc-tip-f">{r.reading.note}</div>}
      </>
    );
  };
  return (
    <Panel
      className="dt-chart dt-meters"
      title={t('detail.meters.title')}
      aside={
        !ro && (
          <>
            <button className="dt-btn sm dt-add" onClick={() => setManage(true)} title={t('detail.meters.manageTitle')}>
              <Settings2 size={14} /> {t('detail.meters.manage')}
            </button>
            <button className="dt-btn sm dt-add" onClick={() => setReading({})} title={t('detail.meters.addTitle')}>
              <Plus size={14} /> {t('detail.charges.addShort')}
            </button>
          </>
        )
      }
    >
      <div className="dt-meters-body">
        {meters.length > 1 && (
          <div className="dt-meters-pick">
            {meters.length <= 4 ? (
              <Seg small value={cur.id} onChange={setPicked} options={meters.map((m) => [m.id, m.name] as [string, string])} />
            ) : (
              <Picker variant="btn" value={cur.id} onChange={setPicked} options={meters.map((m) => ({ value: m.id, label: m.name }))} />
            )}
          </div>
        )}
        {/* 走势：横线是平均每期。有费用图时与它同一条日期横轴、同一个范围；否则画最近 24 期 */}
        {trend.length > 1 &&
          (axis ? (
            <ChargeBars
              bars={trend.map((r) => ({ date: r.reading.date, v: r.usage!, ref: stats.average }))}
              from={axis.from}
              to={axis.to}
              today={today}
              todayLabel={t('calendar.today')}
              fmt={compactQty}
              lanes={[]}
              onPick={ro ? undefined : (idx) => idx.length === 1 && setReading({ id: trend[idx[0]].reading.id })}
              tip={(idx, summed) =>
                summed && idx.length > 1 ? (
                  <>
                    <div className="cc-tip-h">
                      <b>
                        {cnDateFull(trend[idx[0]].reading.date)} – {cnDateFull(trend[idx[idx.length - 1]].reading.date)}
                      </b>
                    </div>
                    <div className="cc-tip-r">
                      <i className="k-v" />
                      <span>{t('detail.meters.periods', { n: idx.length })}</span>
                      <b>
                        {withUnit(
                          idx.reduce((a, i) => a + trend[i].usage!, 0),
                          cur.unit,
                        )}
                      </b>
                    </div>
                  </>
                ) : (
                  tipOf(idx[0])
                )
              }
            />
          ) : (
            <BarLine
              bars={trend.map((r) => r.usage!)}
              line={trend.map(() => stats.average ?? 0)}
              future={trend.map(() => false)}
              labels={trend.map((r) => monthLabel(r.reading.date.slice(0, 7), { year: false }))}
              fmt={(v) => compactQty(v)}
              tip={tipOf}
              onPick={ro ? undefined : (i) => setReading({ id: trend[i].reading.id })}
            />
          ))}
        {/* 指标在顶部，这里只有走势；画不出时留一句说明，不留空卡 */}
        {trend.length <= 1 && <p className="muted dt-meters-none">{t('detail.meters.noTrend')}</p>}
      </div>
      {sheets}
    </Panel>
  );
}

type Draft = { id: string; name: string; unit: string; kind?: 'reading' };

/** 管理指标：增删、改名、改单位、切换本期用量 / 累计读数；删掉有历史数值的指标前确认（数值一并清除） */
function MetersSheet({
  sub,
  suggestions,
  onSave,
  onClose,
}: {
  sub: Subscription;
  suggestions: Array<Pick<Meter, 'name' | 'unit' | 'kind'>>;
  onSave: (next: Subscription) => unknown;
  onClose: () => void;
}) {
  const blank = (): Draft => ({ id: uid(), name: '', unit: '' });
  const [list, setList] = useState<Draft[]>(() => (sub.meters?.length ? sub.meters.map((m) => ({ ...m })) : [blank()]));
  const set = (id: string, patch: Partial<Draft>) => setList((l) => l.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const names = list.map((d) => d.name.trim().toLowerCase());
  const dup = names.some((n, i) => n && names.indexOf(n) !== i);
  const valid = !dup && list.every((d) => d.name.trim());
  // 已填的名称不再出现在建议里
  const offered = suggestions.filter((s) => !names.includes(s.name.trim().toLowerCase()));
  const [busy, submit] = useSubmit();

  const save = () =>
    submit(async () => {
      if (!valid) return;
      const keep = new Set(list.map((d) => d.id));
      const used = new Set((sub.readings ?? []).flatMap((r) => Object.keys(r.values)));
      const lost = (sub.meters ?? []).filter((m) => !keep.has(m.id) && used.has(m.id));
      if (lost.length) {
        const label = new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(lost.map((m) => m.name));
        if (!(await ask(t('detail.meters.removeConfirm', { names: label }), { ok: t('common.delete') }))) return;
      }
      const meters: Meter[] = list.map((d) => ({
        id: d.id,
        name: d.name.trim(),
        unit: d.unit.trim(),
        ...(d.kind === 'reading' ? { kind: 'reading' as const } : {}),
      }));
      await onSave(replaceMeters(sub, meters));
    });

  return (
    <Sheet
      narrow
      title={t('detail.meters.manageTitle')}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !valid} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        {list.map((d) => (
          <Group
            key={d.id}
            title={d.name.trim() || t('detail.meters.newMeter')}
            action={
              <button type="button" className="btn plain" onClick={() => setList((l) => l.filter((x) => x.id !== d.id))}>
                {t('common.delete')}
              </button>
            }
          >
            <Cell label={t('detail.meters.name')}>
              <input value={d.name} placeholder={t('detail.meters.namePh')} onChange={(e) => set(d.id, { name: (e.target as HTMLInputElement).value })} />
            </Cell>
            <Cell label={t('detail.meters.unit')}>
              <input value={d.unit} placeholder={t('detail.meters.unitPh')} onChange={(e) => set(d.id, { unit: (e.target as HTMLInputElement).value })} />
            </Cell>
            <Cell label={t('detail.meters.kindLabel')}>
              <Seg
                small
                value={d.kind === 'reading' ? 'reading' : 'usage'}
                onChange={(v) => set(d.id, { kind: v === 'reading' ? 'reading' : undefined })}
                options={[
                  ['usage', t('detail.meters.usage')],
                  ['reading', t('detail.meters.reading')],
                ]}
              />
            </Cell>
          </Group>
        ))}
        <Group
          title={offered.length ? t('detail.meters.suggest') : undefined}
          action={
            <button type="button" className="btn plain" onClick={() => setList((l) => [...l, blank()])}>
              <Plus size={14} /> {t('detail.meters.newMeter')}
            </button>
          }
          foot={dup ? t('detail.meters.dupName') : t('detail.meters.kindFoot')}
        >
          {offered.length > 0 && (
            <div className="cell bonus-quick">
              {offered.slice(0, 8).map((s) => (
                <button
                  type="button"
                  key={`${s.name}\u0000${s.unit}`}
                  className="chip-btn"
                  onClick={() =>
                    setList((l) => {
                      // 有空白的那一行就填进去，否则新加一行
                      const empty = l.find((d) => !d.name.trim() && !d.unit.trim());
                      const fill = { name: s.name, unit: s.unit, kind: s.kind };
                      return empty ? l.map((d) => (d === empty ? { ...d, ...fill } : d)) : [...l, { ...blank(), ...fill }];
                    })
                  }
                >
                  {s.unit ? `${s.name} (${s.unit})` : s.name}
                </button>
              ))}
            </div>
          )}
        </Group>
      </div>
    </Sheet>
  );
}

/** 记一笔 / 修改一条记录：日期默认今天，每个指标一个数字框，可只填一部分 */
function ReadingSheet({
  sub,
  edit,
  today,
  onSave,
  onClose,
}: {
  sub: Subscription;
  edit?: Reading;
  today: string;
  onSave: (next: Subscription) => unknown;
  onClose: () => void;
}) {
  const meters = sub.meters ?? [];
  const list = sub.readings ?? [];
  const [date, setDate] = useState(edit?.date ?? today);
  const [values, setValues] = useState<Record<string, number | undefined>>(() => ({ ...edit?.values }));
  const [note, setNote] = useState(edit?.note ?? '');
  const filled = Object.fromEntries(Object.entries(values).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
  const valid = Object.keys(filled).length > 0;
  const [busy, submit] = useSubmit();
  const write = (readings: Reading[]) => onSave({ ...sub, readings: readings.length ? readings : undefined });

  const save = () => {
    if (!valid) return;
    const item: Reading = { id: edit?.id ?? uid(), date, values: filled, ...(note.trim() ? { note: note.trim() } : {}) };
    return submit(() => write(edit ? list.map((r) => (r.id === edit.id ? item : r)) : [...list, item]));
  };

  return (
    <Sheet
      narrow
      title={t(edit ? 'detail.meters.editTitle' : 'detail.meters.addTitle')}
      onClose={onClose}
      foot={
        <>
          {edit && (
            <ConfirmButton disabled={busy} onConfirm={() => void submit(() => write(list.filter((r) => r.id !== edit.id)))}>
              {t('common.delete')}
            </ConfirmButton>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !valid} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group>
          <Cell label={t('detail.meters.head.date')}>
            <DatePicker value={date} onChange={(v) => setDate(v ?? today)} />
          </Cell>
        </Group>
        <Group foot={t('detail.meters.valuesFoot')}>
          {meters.map((m) => (
            <Cell key={m.id} label={m.name} sub={m.kind === 'reading' ? t('detail.meters.reading') : undefined}>
              <NumInput
                className="num"
                inputMode="decimal"
                value={values[m.id]}
                placeholder={t('editor.field.optional')}
                onValue={(n) => setValues((v) => ({ ...v, [m.id]: n }))}
              />
              {m.unit && <span className="cell-unit">{m.unit}</span>}
            </Cell>
          ))}
        </Group>
        <Group>
          <Cell label={t('editor.field.notes')}>
            <input value={note} placeholder={t('editor.field.optional')} onChange={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Cell>
        </Group>
      </div>
    </Sheet>
  );
}

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings2 } from 'lucide-react';
import { uid } from '../../../../shared/billing.ts';
import { cnDateFull, money } from '../../../../shared/format.ts';
import { intlLocale, t } from '../../../../shared/i18n.ts';
import { numberFormat } from '../../../../shared/intl.ts';
import { meterSuggestions, meterSummary, replaceMeters, type MeterRow } from '../../../../shared/meters.ts';
import type { AppState, Meter, Reading, Subscription } from '../../../../shared/types.ts';
import { ConfirmButton } from '../../components/ConfirmButton.tsx';
import { DatePicker } from '../../components/DatePicker.tsx';
import { Panel } from '../../components/DetailKit.tsx';
import { Picker } from '../../components/Picker.tsx';
import { YearLedger } from '../../components/YearLedger.tsx';
import { NumInput, Seg, useSubmit } from '../../components/inputs.tsx';
import { ask, Sheet } from '../../components/overlays.tsx';
import { Cell, Group, Metric, MetricCards } from '../../components/ui.tsx';
import { saveSub } from '../../store.ts';
import { run } from '../../toast.ts';

const qty = (n: number) => numberFormat(intlLocale(), { maximumFractionDigits: 3 }).format(n);
const withUnit = (n: number, unit: string) => (unit ? `${qty(n)} ${unit}` : qty(n));
/** 单价常是零点几（每度电、每 GB），多留一位小数 */
const priceText = (r: MeterRow, unit: string) => {
  const p = r.unitPrice!;
  const s = money(p, r.cost!.currency, Math.abs(p) < 1 ? { decimals: 3 } : {});
  return unit ? `${s}/${unit}` : s;
};

/**
 * 业务数据：订阅上自定义的指标（电量、里程、流量……）与按日期的记录，和付款分开存。
 * 没有指标时只留一个轻入口；有指标时每个指标一张卡（最近一期用量、累计、最近单价），下面是选中指标的记录表，点一行修改。
 * 只读（公开页、演示）不显示任何编辑入口
 */
export function Meters({ sub, state, today }: { sub: Subscription; state: AppState; today: string }) {
  const ro = !!state.readonly;
  const meters = sub.meters ?? [];
  const [manage, setManage] = useState(false);
  const [reading, setReading] = useState<{ id?: string } | null>(null);
  const [picked, setPicked] = useState<string>();
  const cur = meters.find((m) => m.id === picked) ?? meters[0];
  const save = (next: Subscription, close: () => void) =>
    run(async () => {
      await saveSub(next);
      close();
    }, t('detail.meters.saved'));

  const sheets = (
    <>
      {manage &&
        createPortal(
          <MetersSheet sub={sub} suggestions={meterSuggestions(state.subscriptions, sub)} onSave={(next) => save(next, () => setManage(false))} onClose={() => setManage(false)} />,
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
      <Panel className="dt-meters">
        <button className="btn plain dt-meters-add" onClick={() => setManage(true)}>
          <Plus size={14} /> {t('detail.meters.add')}
        </button>
        {sheets}
      </Panel>
    );
  }

  const rows = meterSummary(sub, cur, today).rows.slice().reverse();
  const isReading = cur.kind === 'reading';
  return (
    <Panel
      className="dt-charges dt-meters"
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
      <MetricCards inline>
        {meters.map((m) => {
          const s = meterSummary(sub, m, today);
          const last = s.latest;
          const price = s.latestPriced && priceText(s.latestPriced, m.unit);
          const total = s.periods ? withUnit(s.total, m.unit) : undefined;
          const note =
            total && price
              ? t('detail.meters.both', { total, price })
              : total
                ? t('detail.meters.total', { v: total })
                : price
                  ? t('detail.meters.unitPrice', { v: price })
                  : last && m.kind === 'reading'
                    ? t('detail.meters.readingValue', { v: withUnit(last.value, m.unit) })
                    : undefined;
          return <Metric key={m.id} label={m.name} value={last?.usage != null ? withUnit(last.usage, m.unit) : '—'} note={note} />;
        })}
      </MetricCards>
      {meters.length > 1 && (
        <div className="dt-meters-pick">
          {meters.length <= 4 ? (
            <Seg small value={cur.id} onChange={setPicked} options={meters.map((m) => [m.id, m.name] as [string, string])} />
          ) : (
            <Picker variant="btn" value={cur.id} onChange={setPicked} options={meters.map((m) => ({ value: m.id, label: m.name }))} />
          )}
        </div>
      )}
      </div>
      <YearLedger
        items={rows}
        dateOf={(r) => r.reading.date}
        head={[
          t('detail.meters.head.date'),
          isReading ? t('detail.meters.head.reading') : t('detail.meters.head.note'),
          t('detail.meters.head.usage'),
          t('detail.meters.head.price'),
        ]}
        yearCells={(ys) => {
          const used = ys.filter((r) => r.usage != null);
          return {
            second: null,
            orig: used.length ? withUnit(used.reduce((a, r) => a + r.usage!, 0), cur.unit) : '—',
            base: null,
          };
        }}
        row={(r) => ({
          date: <time dateTime={r.reading.date}>{cnDateFull(r.reading.date)}</time>,
          second: isReading ? qty(r.value) : (r.reading.note ?? ''),
          orig: r.usage != null ? withUnit(r.usage, cur.unit) : '—',
          base: r.unitPrice != null ? priceText(r, cur.unit) : '—',
        })}
        rowKey={(r) => r.reading.id}
        rowTitle={(r) => r.reading.note}
        onRow={ro ? undefined : (r) => setReading({ id: r.reading.id })}
      />
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
      const meters: Meter[] = list.map((d) => ({ id: d.id, name: d.name.trim(), unit: d.unit.trim(), ...(d.kind === 'reading' ? { kind: 'reading' as const } : {}) }));
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
                placeholder={m.unit || t('editor.field.optional')}
                onValue={(n) => setValues((v) => ({ ...v, [m.id]: n }))}
              />
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

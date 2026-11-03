import { useMemo, useState } from 'react';
import { prepareImport, type ImportFixes, type ImportSource } from '../../../shared/import-ledger.ts';
import type { AppState, Cycle } from '../../../shared/types.ts';
import { t } from '../../../shared/i18n.ts';
import { cycleLabel, validDay } from '../../../shared/billing.ts';
import { ask, Sheet } from '../components/overlays.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { DatePicker } from '../components/DatePicker.tsx';
import { NumInput, Stepper, Toggle } from '../components/inputs.tsx';
import { CurrencySelect, Picker } from '../components/Picker.tsx';
import { importData } from '../store.ts';
import { run } from '../toast.ts';

export function ImportSheet({ source, state, today, onClose }: { source: ImportSource; state: AppState; today: string; onClose: () => void }) {
  const [user, setUser] = useState(source.users.length === 1 ? source.users[0].id : '');
  const [fixes, setFixes] = useState<ImportFixes>({});
  const [excluded, setExcluded] = useState<string[]>([]);
  const selected = useMemo(() => ({ ...source, rows: source.rows.filter((r) => !excluded.includes(r.key)) }), [source, excluded]);
  const preview = useMemo(
    () => prepareImport(selected, state.methods, today, fixes, user || undefined, Object.keys(state.fx.rates)),
    [selected, state.methods, state.fx.rates, today, fixes, user],
  );
  const rows = source.rows.filter((r) => !user || r.user === user);
  const ready = preview.subscriptions.length > 0 && preview.issues.length === 0;
  const edit = (key: string, patch: ImportFixes[string]) => setFixes((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
  const save = async (mode: 'merge' | 'replace') => {
    if (!ready || (mode === 'replace' && !(await ask(t('settings.import.confirmReplace'))))) return;
    await run(
      async () => {
        await importData({ subscriptions: preview.subscriptions, methods: preview.methods, mode });
        onClose();
      },
      t(mode === 'merge' ? 'settings.import.mergeDone' : 'settings.import.replaceDone'),
    );
  };
  return (
    <Sheet
      title={t('settings.import.title', { count: preview.subscriptions.length })}
      onClose={onClose}
      foot={
        <>
          <button className="btn danger" disabled={!ready} onClick={() => void save('replace')}>
            {t('settings.import.replaceAll')}
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('settings.restore.cancel')}
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void save('merge')}>
            {t('settings.import.merge')}
          </button>
        </>
      }
    >
      <Group foot={t('settings.import.history')}>
        {source.users.length > 1 && (
          <Cell label={t('settings.import.owner')}>
            <Picker
              value={user}
              onChange={setUser}
              ariaLabel={t('settings.import.owner')}
              options={[{ value: '', label: t('settings.import.choose') }, ...source.users.map((u) => ({ value: u.id, label: u.name }))]}
            />
          </Cell>
        )}
        <Cell label={t('settings.import.independent')} />
        {preview.created.length > 0 && (
          <Cell label={t('settings.import.newMethods', { names: preview.created.map((m) => `${m.name} (${m.currency})`).join(t('settings.import.sep')) })} />
        )}
        {!source.rows.length && <Cell label={t('settings.toast.csvEmpty')} />}
        {preview.issues
          .filter((i) => !i.key)
          .map((i) => (
            <Cell key={i.message} label={i.message} />
          ))}
      </Group>
      {(source.users.length < 2 || user) &&
        rows.map((row) => {
          const fix = fixes[row.key] ?? {};
          const issue = preview.issues.find((i) => i.key === row.key);
          const cycle = fix.cycle ?? row.cycle;
          // 源文件里认不出的日期不交给月历：显示为空，由预览报错、用户重选
          const start = fix.start ?? row.start ?? today;
          return (
            <Group key={row.key} title={row.name} foot={[issue?.message, !row.start ? t('core.import.unknownStart') : ''].filter(Boolean).join('\n')}>
              <Cell label={t('settings.import.include')} sub={[row.account, row.category, row.method].filter(Boolean).join(t('core.listSep'))}>
                <Toggle
                  label={`${t('settings.import.include')} ${row.name}`}
                  checked={!excluded.includes(row.key)}
                  onChange={(v) => setExcluded((all) => (v ? all.filter((key) => key !== row.key) : [...all, row.key]))}
                />
              </Cell>
              {!excluded.includes(row.key) && (
                <>
                  <Cell label={t('editor.field.amount')}>
                    {/* 按币种限制小数位（日元等不收小数） */}
                    <NumInput
                      className="num"
                      ccy={fix.currency ?? row.currency}
                      aria-label={`${t('editor.field.amount')} ${row.name}`}
                      value={Number.isFinite(fix.price ?? row.price) ? (fix.price ?? row.price) : undefined}
                      onValue={(n) => edit(row.key, { price: n ?? NaN })}
                    />
                  </Cell>
                  <Cell label={t('editor.field.currency')}>
                    <CurrencySelect
                      value={fix.currency ?? row.currency ?? ''}
                      ariaLabel={`${t('editor.field.currency')} ${row.name}`}
                      onChange={(currency) => edit(row.key, { currency })}
                    />
                  </Cell>
                  <Cell label={t('editor.field.cycle')}>
                    <Picker
                      value={cycle?.unit ?? ''}
                      ariaLabel={`${t('editor.field.cycle')} ${row.name}`}
                      options={[
                        { value: '', label: t('settings.import.choose') },
                        ...(['day', 'week', 'month', 'year', 'lifetime'] as const).map((unit) => ({ value: unit, label: cycleLabel({ unit, every: 1 }) })),
                      ]}
                      onChange={(unit) => edit(row.key, { cycle: unit ? { unit: unit as Cycle['unit'], every: 1 } : undefined })}
                    />
                  </Cell>
                  {cycle && cycle.unit !== 'lifetime' && (
                    <Cell label={t('settings.import.every')}>
                      <Stepper
                        label={`${t('settings.import.every')} ${row.name}`}
                        value={Number.isInteger(cycle.every) ? cycle.every : 1}
                        min={1}
                        max={Math.max(999, cycle.every || 0)}
                        unit={() => ''}
                        onChange={(every) => edit(row.key, { cycle: { ...cycle, every } })}
                      />
                    </Cell>
                  )}
                  <Cell label={t('editor.field.start')}>
                    <DatePicker
                      ariaLabel={`${t('editor.field.start')} ${row.name}`}
                      value={validDay(start) ? start : undefined}
                      onChange={(v) => edit(row.key, { start: v ?? today })}
                    />
                  </Cell>
                  {row.nextDue && <Cell label={t('settings.import.next')}>{row.nextDue}</Cell>}
                  {(row.inactive || row.manual) && <Cell label={t('settings.import.paused')} />}
                </>
              )}
            </Group>
          );
        })}
    </Sheet>
  );
}

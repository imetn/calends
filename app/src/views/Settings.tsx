import { collectCurrencyOf } from '../../../shared/billing.ts';
import { copyParts } from '../components/copy.tsx';
import { base } from '../base.ts';
import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useEffect, useRef, useState } from 'react';
import { toCsv } from '../../../shared/csv.ts';
import type { ImportSource } from '../../../shared/import-ledger.ts';
import { readImportFile } from '../import-file.ts';
import { ImportSheet } from './ImportSheet.tsx';
import { avatarOf, type AppState, type Subscription } from '../../../shared/types.ts';
import { IconButton, Cell, Group, Toolbar } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { LoadFailed, Sheet } from '../components/overlays.tsx';
import { Toggle } from '../components/inputs.tsx';
import { adoptRestored, api, logout, refreshFx, rotateIcs, saveSettings, saveSub, syncFx } from '../store.ts';
import { copyText, run, toast } from '../toast.ts';
import { MethodPicker } from '../components/MethodPicker.tsx';
import { ChannelsGroup } from './Channels.tsx';
import { SecurityGroup } from './Security.tsx';
import { CategoriesGroup } from './Categories.tsx';
import { PublicSubsSheet, publicCandidates } from './PublicSubs.tsx';
import { go, sortNav } from '../router.ts';
import { LOCALES, isLocale, t } from '../../../shared/i18n.ts';
import { preferredLocale } from '../i18n.ts';

/** 可设为启动页的页面（标签取 app.nav.*） */
const START_PAGES: Array<[string, string]> = [
  ['list', 'list'],
  ['calendar', 'calendar'],
  ['report', 'report'],
  ['wallet', 'wallet'],
];
/** 侧边栏模块：[排序键, 文案键, 能否隐藏]。概览、订阅始终显示，只能调整位置 */
const NAV_ROWS: Array<[string, string, boolean]> = [
  ['overview', 'overview', false],
  ['list', 'list', false],
  ['calendar', 'calendar', true],
  ['report', 'report', true],
  ['wallet', 'wallet', true],
  ['family', 'family', true],
  ['behalf', 'behalf', true],
  ['assistant', 'assistant', true],
  ['connect', 'ai', true],
];
import { CurrencySelect, Picker } from '../components/Picker.tsx';
import { localTime } from '../../../shared/format.ts';

interface Preview {
  day: string;
  digests: Array<{
    key: string;
    subject: string;
    intro: string;
    sections: Array<{ heading: string; rows: Array<{ title: string; sub?: string; amount?: string }> }>;
  }>;
  log: Array<{ dedupe_key: string; subject: string; status: string; sent_at: string }>;
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function icsUrl(state: AppState) {
  return state.settings.icsToken ? `${location.origin}${base(`/cal/${state.settings.icsToken}.ics`)}` : '';
}

export function IcsSheet({ state, onClose }: { state: AppState; onClose: () => void }) {
  const url = icsUrl(state);
  return (
    <Sheet narrow title={t('app.ics.title')} onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-2)', lineHeight: 1.6 }}>
          {t('app.ics.intro')}
        </p>
        {url ? (
          <>
            <div className="codebox">{url}</div>
            <div className="sheet-actions">
              <button className="btn" onClick={() => void copyText(url, t('app.ics.copied'))}>
                {t('app.ics.copy')}
              </button>
              <button className="btn ghost" onClick={() => run(rotateIcs, t('app.ics.resetDone'))}>
                {t('app.ics.reset')}
              </button>
              <a className="btn primary" href={url.replace(/^https?:/, 'webcal:')}>
                <Icon name="cal" /> {t('app.ics.subscribe')}
              </a>
            </div>
          </>
        ) : (
          <button className="btn primary" onClick={() => run(rotateIcs, t('app.ics.generated'))}>
            {t('app.ics.generate')}
          </button>
        )}
        <small className="soft">{t('app.ics.note')}</small>
      </div>
    </Sheet>
  );
}

/** 全部 IANA 时区，右侧标出当前偏移（GMT+8）；当前值不在列表里时也保留 */
function timeZones(current: string) {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const offset = (z: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts().find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };
  return [...new Set(['UTC', ...all, current])].map((z) => ({ value: z, label: z.replace(/_/g, ' '), hint: offset(z) }));
}

function ReminderPreview({ preview, timezone }: { preview: Preview | null; timezone: string }) {
  if (!preview) return null;
  const todayLog = preview?.log.filter((l) => localTime(l.sent_at, timezone, true) === preview.day) ?? [];
  const recentLog = preview?.log.filter((l) => localTime(l.sent_at, timezone, true) !== preview.day) ?? [];
  return (
    <>
      {preview && (preview.digests.length > 0 || todayLog.length > 0) && (
        <Group title={t('settings.today.title', { day: preview.day })}>
          {preview.digests.map((d) => (
            <Cell key={d.key} label={d.subject}>
              {t('settings.today.items', { count: d.sections.reduce((a, x) => a + x.rows.length, 0) })}
            </Cell>
          ))}
          {todayLog.map((l) => (
            <Cell key={l.dedupe_key} label={<span style={{ fontSize: 'var(--fs-2)' }}>{l.subject}</span>}>
              <span style={{ color: l.status === 'sent' ? undefined : 'var(--red)', fontSize: 'var(--fs-1)' }}>{localTime(l.sent_at, timezone).slice(11)}</span>
            </Cell>
          ))}
        </Group>
      )}

      {/* 最近记录今年的只写「月-日 时:分」：完整年份会挤窄标题列，让标题在字中间断行；往年的仍带年份 */}
      {recentLog.length > 0 && (
        <Group title={t('settings.today.recent')}>
          {recentLog.slice(0, 6).map((l) => (
            <Cell key={l.dedupe_key} label={<span style={{ fontSize: 'var(--fs-2)' }}>{l.subject}</span>}>
              <span style={{ color: l.status === 'sent' ? undefined : 'var(--red)', fontSize: 'var(--fs-1)', whiteSpace: 'nowrap' }}>
                {((at) => (at.startsWith(preview.day.slice(0, 4)) ? at.slice(5) : at))(localTime(l.sent_at, timezone))}
              </span>
            </Cell>
          ))}
        </Group>
      )}
    </>
  );
}

export function Settings({ state, today }: { state: AppState; today: string }) {
  const s = state.settings;
  // 侧边栏模块按设置里的顺序列出，拖动后存回 navOrder（服务端，多台设备一致）
  const navRows = sortNav(NAV_ROWS, ([k]) => k, s.navOrder);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // 只补没有分段、也不是代付的订阅：分段的每段各有支付方式，代付用的是别人的钱
  const unassigned = state.subscriptions.filter((x) => !x.methodId && !x.phases?.length && !x.proxy);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState(s.displayName);
  const [ics, setIcs] = useState(false);
  const [pubSubs, setPubSubs] = useState(false);
  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [reading, setReading] = useState(false);

  // 读取失败要显示出来：不能把失败当成「今天没有提醒」「汇率覆盖未知」
  const [failed, setFailed] = useState({ preview: false, fx: false });
  const loadPreview = () =>
    api<Preview>('/api/notify/preview').then(
      (v) => {
        setPreview(v);
        setFailed((f) => ({ ...f, preview: false }));
      },
      () => setFailed((f) => ({ ...f, preview: true })),
    );
  const [fxs, setFxs] = useState<{ needed: number; covered: number; sources: Record<string, number>; first?: string } | null>(null);
  const loadFx = () =>
    api<typeof fxs>('/api/fx/status').then(
      (v) => {
        setFxs(v);
        setFailed((f) => ({ ...f, fx: false }));
      },
      () => setFailed((f) => ({ ...f, fx: true })),
    );
  useEffect(() => {
    loadPreview();
    loadFx();
  }, []);

  const pickFile = (accept: string, cb: (text: string) => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => input.files?.[0]?.text().then(cb);
    input.click();
  };

  const pickImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.zip,.db,.sqlite,text/csv,application/zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setReading(true);
      try {
        const source = await readImportFile(file, state.methods, today);
        if (!source.rows.length) toast(t('settings.toast.csvEmpty'), 'error');
        else setImporting(source);
      } catch (e) {
        toast(e instanceof Error ? e.message : t('core.import.invalid'), 'error');
      } finally {
        setReading(false);
      }
    };
    input.click();
  };
  // 备份恢复：整份交给服务端，订阅、支付方式、设置、汇率一起原样还原
  const [restoring, setRestoring] = useState<{ raw: unknown; subs: number; methods: number; exportedAt?: string; version: number } | null>(null);
  const onJson = (text: string) => {
    try {
      const j = JSON.parse(text) as { subscriptions?: unknown[]; methods?: unknown[]; exportedAt?: string; version?: number };
      if (!Array.isArray(j.subscriptions)) throw new Error();
      setRestoring({ raw: j, subs: j.subscriptions.length, methods: j.methods?.length ?? 0, exportedAt: j.exportedAt, version: j.version ?? 1 });
    } catch {
      toast(t('settings.toast.badBackup'), 'error');
    }
  };

  const exportCsv = () => {
    const head = ['Name', 'Currency', 'Price', 'Category', 'Cycle', 'Starts', 'Ends', 'Tags', 'Payment Account', 'URL', 'Notes'];
    const cyc = (x: Subscription) =>
      x.cycle.unit === 'lifetime'
        ? 'Lifetime'
        : x.cycle.every === 1
          ? { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[x.cycle.unit]
          : `Every ${x.cycle.every} ${x.cycle.unit}s`;
    const rows = state.subscriptions.map((x) => [
      x.name,
      x.currency,
      x.price,
      x.category,
      cyc(x),
      x.start,
      x.end ?? '',
      x.tags.join(' '),
      state.methods.find((m) => m.id === x.methodId)?.name ?? '',
      x.url ?? '',
      x.notes ?? '',
    ]);
    download(`subscriptions-${today}.csv`, toCsv([head, ...rows]), 'text/csv');
  };

  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <>
      <Toolbar title={t('settings.title')} />
      <div className="page fade-in stack" style={{ maxWidth: 720, gap: 26, margin: '0 auto' }}>
        <Group title={t('settings.general.title')}>
          <Cell label={t('settings.general.language')}>
            <Picker
              value={isLocale(s.language) ? s.language : ''}
              onChange={(v) => run(() => saveSettings({ language: v || undefined }))}
              options={[
                { value: '', label: t('settings.general.followSystem'), hint: LOCALES.find((l) => l.code === preferredLocale())?.name },
                ...LOCALES.map((l) => ({
                  value: l.code as string,
                  label: l.name,
                  icon: (
                    <span className="cp-flag">
                      <img src={base(`/flags/${l.flag}.png`)} alt="" />
                    </span>
                  ),
                })),
              ]}
              ariaLabel={t('settings.general.language')}
            />
          </Cell>
          <Cell label={t('settings.general.name')}>
            <input
              value={name}
              placeholder={t('settings.general.namePlaceholder')}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
              onBlur={() => name.trim() !== s.displayName && run(() => saveSettings({ displayName: name.trim() }), t('settings.toast.saved'))}
            />
          </Cell>
          <AvatarField avatar={s.avatar} onChange={(v) => run(() => saveSettings({ avatar: v as string | undefined }), t('settings.toast.saved'))} />
          <Cell label={t('settings.general.startPage')}>
            <Picker
              value={s.startPage ?? ''}
              onChange={(v) => run(() => saveSettings({ startPage: v || undefined }))}
              options={[{ value: '', label: t('app.nav.overview') }, ...START_PAGES.map(([k, l]) => ({ value: k, label: t(`app.nav.${l}`) }))]}
              ariaLabel={t('settings.general.startPageAria')}
            />
          </Cell>
          <Cell label={t('settings.general.baseCurrency')}>
            <CurrencySelect
              value={s.baseCurrency}
              onChange={(c) => run(() => saveSettings({ baseCurrency: c }))}
              ariaLabel={t('settings.general.baseCurrency')}
            />
          </Cell>
          <Cell label={copyParts(t('settings.general.signedAmounts'))}>
            <Toggle
              label={t('settings.general.signedAmounts')}
              checked={s.signedAmounts !== false}
              onChange={(v) => run(() => saveSettings({ signedAmounts: v }))}
            />
          </Cell>
          <Cell label={t('settings.general.gainColor')}>
            {/* 示例数字跟着当前配色变，选项的意思一眼能看出来 */}
            <span className="gain-sample tnum" aria-hidden="true">
              <span className="gain">+12</span>
              <span className="loss">−12</span>
            </span>
            <Picker
              value={s.gainColor ?? 'green'}
              onChange={(v) => run(() => saveSettings({ gainColor: v === 'red' ? 'red' : 'green' }))}
              options={[
                { value: 'green', label: t('settings.general.gainGreen') },
                { value: 'red', label: t('settings.general.gainRed') },
              ]}
              ariaLabel={t('settings.general.gainColor')}
            />
          </Cell>
          <Cell label={t('settings.general.timezone')}>
            <Picker
              value={s.timezone}
              onChange={(z) => run(() => saveSettings({ timezone: z }))}
              options={timeZones(s.timezone)}
              search
              ariaLabel={t('settings.general.timezone')}
            />
          </Cell>
          <Cell label={t('settings.general.weekStart')}>
            <Picker
              value={String(s.weekStart ?? 1)}
              onChange={(v) => run(() => saveSettings({ weekStart: v === '0' ? 0 : 1 }))}
              options={[
                { value: '1', label: t('settings.general.monday') },
                { value: '0', label: t('settings.general.sunday') },
              ]}
              ariaLabel={t('settings.general.weekStartAria')}
            />
          </Cell>
        </Group>

        <Group title={t('settings.sidebar.title')}>
          {/* 模块顺序：拖动把手调整，侧边栏跟着变；能隐藏的右边有开关 */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e: DragEndEvent) => {
              if (!e.over || e.active.id === e.over.id) return;
              const keys = navRows.map(([k]) => k);
              const next = arrayMove(keys, keys.indexOf(String(e.active.id)), keys.indexOf(String(e.over.id)));
              void run(() => saveSettings({ navOrder: next }));
            }}
          >
            <SortableContext items={navRows.map(([k]) => k)} strategy={verticalListSortingStrategy}>
              {navRows.map(([k, l, hideable]) => (
                <NavRow
                  key={k}
                  id={k}
                  label={t(`app.nav.${l}`)}
                  checked={hideable ? !(s.hiddenNav ?? []).includes(k) : undefined}
                  onToggle={(v) => {
                    const rest = (s.hiddenNav ?? []).filter((x) => x !== k);
                    void run(() => saveSettings({ hiddenNav: v ? rest : [...rest, k] }));
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
          {/* 即将扣款在侧边栏最下面，这里也放在最后 */}
          <Cell label={t('settings.sidebar.upcoming')}>
            <Toggle
              label={t('settings.sidebar.upcoming')}
              checked={s.sidebarUpcoming !== false}
              onChange={(v) => run(() => saveSettings({ sidebarUpcoming: v }))}
            />
          </Cell>
          {s.sidebarUpcoming !== false && (
            <Cell label={t('settings.sidebar.lookAhead')}>
              <Picker
                value={s.upcomingDays ?? 45}
                onChange={(n) => run(() => saveSettings({ upcomingDays: n }))}
                options={[
                  { value: 0, label: t('settings.sidebar.thisMonth') },
                  ...[3, 7, 14, 30, 45, 60, 90, 180].map((n) => ({ value: n, label: t('settings.days', { count: n }) })),
                ]}
                ariaLabel={t('settings.sidebar.lookAheadAria')}
                search={false}
              />
            </Cell>
          )}
        </Group>

        <Group title={t('settings.remind.title')}>
          <Cell label={t('settings.remind.lead')}>
            <Picker
              value={s.remindDays}
              onChange={(n) => run(() => saveSettings({ remindDays: n }))}
              options={[0, 1, 2, 3, 5, 7, 14].map((n) => ({ value: n, label: n === 0 ? t('settings.remind.sameDay') : t('settings.days', { count: n }) }))}
              ariaLabel={t('settings.remind.lead')}
            />
          </Cell>
          <Cell label={t('settings.remind.hour')}>
            <Picker
              value={s.notifyHour}
              onChange={(h) => run(() => saveSettings({ notifyHour: h }))}
              options={Array.from({ length: 24 }, (_, h) => ({ value: h, label: hour(h) }))}
              ariaLabel={t('settings.remind.hour')}
              search={false}
            />
          </Cell>
          <Cell label={t('settings.remind.monthly')}>
            <Toggle label={t('settings.remind.monthly')} checked={s.monthlyDigest} onChange={(v) => run(() => saveSettings({ monthlyDigest: v }))} />
          </Cell>
          <Cell
            label={<span style={{ color: 'var(--accent)' }}>{t('settings.remind.test')}</span>}
            onClick={() =>
              run(async () => {
                const r = await api<{ sent: boolean; reason?: string; results?: Array<{ channel: string; ok: boolean; error?: string }> }>('/api/notify/test', {
                  method: 'POST',
                  body: '{}',
                });
                if (!r.sent) throw new Error(r.reason ?? t('settings.remind.testFailed'));
                const bad = r.results?.filter((x) => !x.ok) ?? [];
                if (bad.length)
                  throw new Error(
                    bad.map((x) => t('settings.remind.channelError', { channel: x.channel, error: x.error })).join(t('settings.remind.errorSep')),
                  );
                loadPreview();
              }, t('settings.remind.testSent'))
            }
          />
          <Cell
            label={<span style={{ color: 'var(--accent)' }}>{t('settings.remind.preview')}</span>}
            // 今天没有要发的提醒：直接说明，不打开空白或原始数据页
            onClick={() => (preview && !preview.digests.length ? toast(t('notify.previewEmpty')) : window.open(base('/api/notify/preview?html=1'), '_blank'))}
          />
        </Group>

        <ChannelsGroup state={state} />

        {failed.preview && !preview ? (
          <Group>
            <LoadFailed onRetry={() => void loadPreview()} />
          </Group>
        ) : (
          <ReminderPreview preview={preview} timezone={s.timezone} />
        )}

        <Group title={t('settings.books.title')}>
          <Cell label={t('settings.books.defaultMethod')}>
            <MethodPicker methods={state.methods} value={s.defaultMethodId} onChange={(id) => run(() => saveSettings({ defaultMethodId: id }))} />
          </Cell>
          {s.defaultMethodId && unassigned.length > 0 && (
            <Cell
              label={t('settings.books.unassigned', { count: unassigned.length })}
              onClick={() =>
                run(
                  async () => {
                    for (const x of unassigned) await saveSub({ ...x, methodId: s.defaultMethodId });
                  },
                  t('settings.books.assignAllDone', { count: unassigned.length }),
                )
              }
            >
              <span style={{ color: 'var(--accent)' }}>{t('settings.books.assignAll')}</span>
            </Cell>
          )}
          <Cell label={t('settings.books.collectCurrency')}>
            <CurrencySelect
              value={collectCurrencyOf(s)}
              onChange={(c) => run(() => saveSettings({ collectCurrency: c }))}
              ariaLabel={t('settings.books.collectCurrency')}
            />
          </Cell>
        </Group>

        <CategoriesGroup state={state} />

        <Group title={t('settings.fx.title')}>
          <Cell
            label={<span style={{ color: 'var(--accent)' }}>{t('settings.fx.current')}</span>}
            sub={t('settings.fx.updatedAt', { time: localTime(state.fx.fetchedAt, state.settings.timezone) })}
            onClick={() => run(refreshFx, t('settings.fx.updated'))}
          >
            1 USD = {state.fx.rates.CNY?.toFixed(2)} CNY
          </Cell>
          {failed.fx && !fxs ? (
            <LoadFailed onRetry={() => void loadFx()} />
          ) : (
            <Cell label={t('settings.fx.history')} sub={fxs?.first ? t('settings.fx.earliest', { date: fxs.first }) : undefined}>
              {fxs ? t('settings.fx.coverage', { covered: fxs.covered, count: fxs.needed }) : '…'}
            </Cell>
          )}
          {fxs && fxs.covered < fxs.needed && (
            <Cell
              label={<span style={{ color: 'var(--accent)' }}>{t('settings.fx.fill')}</span>}
              onClick={() =>
                run(async () => {
                  await syncFx();
                  await loadFx();
                }, t('settings.fx.historyUpdated'))
              }
            />
          )}
        </Group>

        <Group title={t('settings.open.public')}>
          <Cell label={t('settings.publicPage.access')} sub={s.publicView ? `${location.origin}${base('/public')}` : undefined}>
            <Toggle
              label={t('settings.publicPage.access')}
              checked={s.publicView}
              onChange={(v) => run(() => saveSettings({ publicView: v }), v ? t('settings.open.publicOn') : t('settings.open.publicOff'))}
            />
          </Cell>
          <Cell label={t('settings.publicPage.title')} onClick={() => go('settings/public')} />
          {s.publicView && (
            <Cell label={t('settings.open.publicSubs')} onClick={() => setPubSubs(true)}>
              {(() => {
                const all = publicCandidates(state, today);
                const hidden = new Set(s.publicHidden ?? []);
                return `${all.filter((x) => !hidden.has(x.id)).length} / ${all.length}`;
              })()}
            </Cell>
          )}
          {s.publicView && (
            <Cell
              label={<span style={{ color: 'var(--accent)' }}>{t('settings.open.previewPublic')}</span>}
              onClick={() => window.open(base('/public'), '_blank')}
            />
          )}
        </Group>

        <Group title={t('settings.open.title')}>
          <Cell label={t('settings.open.ics')} onClick={() => setIcs(true)}>
            {s.icsToken ? t('settings.open.on') : t('settings.open.off')}
          </Cell>
          <Cell label={t('settings.open.ai')}>
            <Toggle
              label={t('settings.open.ai')}
              checked={s.aiEnabled !== false}
              onChange={(v) => run(() => saveSettings({ aiEnabled: v }), v ? t('settings.open.aiOn') : t('settings.open.aiOff'))}
            />
          </Cell>
          {s.aiEnabled !== false && (
            <Cell label={<span style={{ color: 'var(--accent)' }}>{t('settings.open.manageAi')}</span>} onClick={() => go('connect')} />
          )}
        </Group>

        {!state.readonly && <SecurityGroup state={state} />}

        <Group title={t('settings.data.title')}>
          <Cell
            label={t('settings.data.importCsv')}
            sub={reading ? t('settings.import.reading') : t('settings.import.formats')}
            onClick={reading ? undefined : pickImport}
          />
          <Cell label={t('settings.data.restore')} onClick={() => pickFile('.json,application/json', onJson)} />
          <Cell label={t('settings.data.exportCsv')} onClick={exportCsv} />
          <Cell label={t('settings.data.backup')} onClick={() => (location.href = base('/api/backup'))} />
        </Group>

        <Group>
          <button className="cell tap logout-cell" onClick={() => logout()}>
            {t('settings.logout')}
          </button>
        </Group>
      </div>

      {restoring && (
        <Sheet
          narrow
          title={t('settings.data.restore')}
          onClose={() => setRestoring(null)}
          foot={
            <>
              <span className="grow" />
              <button className="btn" onClick={() => setRestoring(null)}>
                {t('settings.restore.cancel')}
              </button>
              <button
                className="btn primary"
                onClick={() =>
                  run(async () => {
                    const r = await api<{ restored: { subscriptions: number; methods: number; fxDays: number }; state: AppState }>('/api/backup', {
                      method: 'POST',
                      body: JSON.stringify(restoring.raw),
                    });
                    adoptRestored(r.state);
                    setRestoring(null);
                    return r;
                  }, t('settings.restore.done'))
                }
              >
                {t('settings.restore.replace')}
              </button>
            </>
          }
        >
          <Group foot={t('settings.restore.warning')}>
            <Cell label={t('settings.restore.subs')}>{t('settings.restore.count', { count: restoring.subs })}</Cell>
            <Cell label={t('settings.restore.methods')}>{t('settings.restore.count', { count: restoring.methods })}</Cell>
            {restoring.exportedAt && <Cell label={t('settings.restore.time')}>{localTime(restoring.exportedAt, state.settings.timezone)}</Cell>}
            {restoring.version < 2 && <Cell label={t('settings.restore.format')}>{t('settings.restore.legacy')}</Cell>}
          </Group>
        </Sheet>
      )}
      {ics && <IcsSheet state={state} onClose={() => setIcs(false)} />}
      {pubSubs && <PublicSubsSheet state={state} today={today} onClose={() => setPubSubs(false)} />}
      {importing && <ImportSheet source={importing} state={state} today={today} onClose={() => setImporting(null)} />}
    </>
  );
}

/** 侧边栏模块的一行：左边拖动把手，右边是显示开关（概览、订阅没有开关） */
function NavRow({ id, label, checked, onToggle }: { id: string; label: string; checked?: boolean; onToggle: (v: boolean) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef as (el: HTMLDivElement | null) => void}
      className={`cell cat-row nav-row ${isDragging ? 'lifted' : ''}`}
      style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition } as Record<string, string | undefined>}
    >
      <IconButton
        type="button"
        ref={setActivatorNodeRef as (el: HTMLButtonElement | null) => void}
        className="cat-grip"
        aria-label={t('settings.cat.dragHandle')}
        {...(attributes as unknown as Record<string, unknown>)}
        {...(listeners as Record<string, unknown>)}
      >
        <Icon name="grip" />
      </IconButton>
      <span className="nav-row-name">{label}</span>
      {checked !== undefined && <Toggle label={label} checked={checked} onChange={onToggle} />}
    </div>
  );
}

/** 头像：上传图片（裁成正方形缩到 256px）或填图片链接；全局头像和公开页单独的头像共用 */
export function AvatarField({
  avatar,
  fallback,
  defaultLabel = t('settings.general.avatarDefault'),
  linkHint,
  onChange,
}: {
  avatar?: string;
  /** 没设头像时预览显示的那张 */
  fallback?: string;
  defaultLabel?: string;
  linkHint?: string;
  onChange: (v: string | null) => void | Promise<unknown>;
}) {
  const [link, setLink] = useState(false);
  const linkOf = (v?: string) => (v?.startsWith('data:') ? '' : (v ?? ''));
  const [url, setUrl] = useState(linkOf(avatar));
  // 头像被外部改掉（如恢复默认）时跟上，否则失焦会把旧链接写回去
  const [seen, setSeen] = useState(avatar);
  if (avatar !== seen) {
    setSeen(avatar);
    setUrl(linkOf(avatar));
  }
  const file = useRef<HTMLInputElement>(null);
  const set = onChange;
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target as HTMLInputElement;
    const fl = input.files?.[0];
    input.value = '';
    if (!fl) return;
    const img = new Image();
    img.onload = () => {
      const n = 256;
      const side = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = n;
      c.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, n, n);
      URL.revokeObjectURL(img.src);
      setUrl('');
      setLink(false);
      void set(c.toDataURL('image/webp', 0.9));
    };
    img.src = URL.createObjectURL(fl);
  };
  let source = defaultLabel;
  if (avatar) source = avatar.startsWith('data:') ? t('wallet.logo.uploaded') : t('wallet.logo.link');
  return (
    <>
      <div className="cell logo-field">
        <span className="cell-l">
          {t('settings.general.avatar')}
          <small>{source}</small>
        </span>
        <span className="cell-r">
          <img className="avatar-preview" src={base(avatarOf({ avatar: avatar ?? fallback }))} alt="" />
          <button type="button" className="chip-btn" onClick={() => file.current?.click()}>
            {t('wallet.logo.upload')}
          </button>
          <button type="button" className={`chip-btn ${link ? 'on' : ''}`} onClick={() => setLink(!link)}>
            {t('wallet.logo.linkBtn')}
          </button>
          {avatar && (
            <button type="button" className="chip-btn" onClick={() => (setUrl(''), void set(null))}>
              {t('wallet.logo.clear')}
            </button>
          )}
          <input ref={file} type="file" accept="image/*" hidden onChange={onFile} />
        </span>
      </div>
      {link && (
        <Cell label={t('wallet.logo.link')} sub={linkHint}>
          <input
            value={url}
            placeholder="https://…/avatar.png"
            onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
            onBlur={() => url.trim() !== (avatar ?? '') && void set(url.trim() || null)}
          />
        </Cell>
      )}
    </>
  );
}

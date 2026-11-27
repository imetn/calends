// 在主订阅表单里添加或调整「关联订阅（附赠 / 加购）」的子弹窗：可新建一条，或挑选已有独立订阅挂过来；修改先暂存，随主订阅一起保存。
import { useState, type CSSProperties } from 'react';
import { currentPhase, cycleLabel, uid } from '../../../../shared/billing.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Cycle, Subscription } from '../../../../shared/types.ts';
import { DatePicker } from '../../components/DatePicker.tsx';
import { NumInput, Seg, Stepper } from '../../components/inputs.tsx';
import { SubIcon } from '../../components/marks.tsx';
import { Sheet } from '../../components/overlays.tsx';
import { CurrencySelect, Picker } from '../../components/Picker.tsx';
import { Cell, Group } from '../../components/ui.tsx';
import { catColor, presetCat } from '../../derive.ts';
import { CYCLES as RENEW_CYCLES, cycleName } from '../../components/ChangePanel.tsx';
import { GENRE_CAT, NameField } from './NameField.tsx';
import {
  linkableExistingChildren,
  validateExistingChildLink,
  type LinkedChildChange,
  type LinkedChildView,
  type LinkedNewChild,
  type LinkedPlan,
} from './linked.ts';

const CHILD_CYCLES: Array<[string, Cycle]> = [...RENEW_CYCLES, ['lt', { unit: 'lifetime', every: 1 }]];

export function LinkedSubSheet({
  parent,
  isNewParent,
  state,
  today,
  linked,
  edit,
  onSave,
  onRemove,
  onClose,
}: {
  parent: Subscription;
  isNewParent: boolean;
  state: AppState;
  today: string;
  linked: LinkedPlan;
  /** 有值表示编辑已列出的某一条；缺省表示新增 */
  edit?: LinkedChildView;
  onSave: (change: LinkedChildChange) => void;
  onRemove?: (item: LinkedChildView) => void;
  onClose: () => void;
}) {
  const pc = currentPhase(parent, today);
  const existingPool = linkableExistingChildren(parent.id, state.subscriptions, today, linked);
  const canPickExisting = !edit && existingPool.length > 0;
  const [source, setSource] = useState<'new' | 'existing'>(() => (edit ? (edit.kind === 'new' ? 'new' : 'existing') : 'new'));

  // 新建子订阅字段
  const draft = edit?.draft;
  const [name, setName] = useState(draft?.name ?? '');
  const [icon, setIcon] = useState<string | undefined>(draft?.icon);
  const [url, setUrl] = useState<string | undefined>(draft?.url);
  const [category, setCategory] = useState(draft?.category ?? (parent.category || presetCat('tools')));
  const [price, setPrice] = useState<number>(draft?.price ?? 0);
  const [currency, setCurrency] = useState(draft?.currency ?? pc.currency);
  const [cycle, setCycle] = useState<Cycle>(draft?.cycle ?? { ...pc.cycle });
  const preset = CHILD_CYCLES.find(([, c]) => c.unit === cycle.unit && c.every === cycle.every)?.[0];
  const [customCycle, setCustomCycle] = useState(!preset);
  const [start, setStart] = useState(draft?.start ?? (isNewParent ? parent.start : today));

  // 关联已有子订阅字段
  const [pickedId, setPickedId] = useState<string>(() => (edit && edit.kind !== 'new' ? edit.id : (existingPool[0]?.id ?? '')));
  const [follow, setFollow] = useState<boolean>(edit ? edit.follow : true);

  const pickedSub = source === 'existing' ? state.subscriptions.find((s) => s.id === pickedId) : undefined;
  const historyErr = pickedSub ? validateExistingChildLink(pickedSub, parent, follow, state.subscriptions, today) : undefined;

  const freeFollow = source === 'new' && !(price > 0) && follow;
  const cycleKey = customCycle || !preset ? 'custom' : preset;
  const valid = source === 'new' ? name.trim().length > 0 : !!pickedSub && !historyErr;
  const method = state.methods.find((m) => m.id === parent.methodId);
  const previewSub: Subscription = {
    id: draft?.id ?? 'preview',
    name,
    icon,
    url,
    category,
    tags: [],
    price,
    currency,
    cycle,
    start,
    status: 'active',
  };

  const handleSave = () => {
    if (!valid) return;
    if (source === 'new') {
      const next: LinkedNewChild = {
        kind: 'new',
        id: draft?.id ?? uid(),
        name: name.trim(),
        ...(icon ? { icon } : {}),
        ...(url ? { url } : {}),
        category,
        price,
        currency,
        cycle: freeFollow ? { ...pc.cycle } : cycle,
        start,
        follow,
      };
      onSave(next);
    } else if (pickedSub) {
      onSave({ kind: 'existing', subId: pickedSub.id, follow });
    }
    onClose();
  };

  return (
    <Sheet
      narrow
      title={t(edit ? 'editor.bundle.editTitle' : 'editor.bundle.addTitle')}
      onClose={onClose}
      foot={
        <>
          {edit && onRemove && (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                onRemove(edit);
                onClose();
              }}
            >
              {t(edit.kind === 'new' ? 'editor.bundle.remove' : 'editor.bundle.unlink')}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!valid} onClick={handleSave}>
            {t(edit ? 'common.done' : 'common.add')}
          </button>
        </>
      }
    >
      <div className="ed">
        {canPickExisting && (
          <Seg
            value={source}
            onChange={(v) => setSource(v as 'new' | 'existing')}
            options={[
              ['new', t('editor.bundle.sourceNew')],
              ['existing', t('editor.bundle.sourceExisting')],
            ]}
          />
        )}

        {source === 'new' ? (
          <>
            <div className="ed-id">
              <span className="ed-id-icon static" aria-hidden="true">
                {icon || url || name.trim() ? (
                  <SubIcon sub={previewSub} size={36} />
                ) : (
                  <span className="ico ed-id-ghost" style={{ '--s': '36px', '--tint': catColor(category) } as CSSProperties} />
                )}
              </span>
              <div className="ed-id-main">
                <NameField
                  value={name}
                  region={(parent.region || method?.region || 'us').toLowerCase()}
                  onChange={setName}
                  onPick={(h) => {
                    setName(h.name.split(/\s*[:：|]\s*|\s[-–—]\s/)[0].trim());
                    setIcon(h.icon);
                    if (!url && h.url) setUrl(h.url);
                    if (GENRE_CAT[h.genre]) setCategory(presetCat(GENRE_CAT[h.genre]));
                  }}
                  onPickCatalog={(c) => {
                    setName(c.name);
                    setIcon(c.icon);
                    if (!url && c.url) setUrl(c.url);
                    setCategory(c.category);
                  }}
                />
              </div>
            </div>
            <Group foot={t('editor.bundle.priceHint')}>
              <Cell label={t('editor.bundle.mode')}>
                <Seg
                  small
                  value={follow ? 'follow' : 'independent'}
                  onChange={(v) => setFollow(v === 'follow')}
                  options={[
                    ['follow', t('editor.bundle.follow')],
                    ['independent', t('editor.bundle.independent')],
                  ]}
                />
              </Cell>
              <Cell label={t('editor.field.amount')}>
                <span className="ed-amount">
                  <NumInput ccy={currency} className="num" value={price || undefined} placeholder="0.00" onValue={(n) => setPrice(n ?? 0)} />
                  <CurrencySelect value={currency} onChange={setCurrency} />
                </span>
              </Cell>
              {freeFollow ? (
                <Cell label={t('editor.field.cycle')}>
                  <span className="muted">{t('editor.bundle.followsCycle', { cycle: cycleLabel(pc.cycle) })}</span>
                </Cell>
              ) : (
                <>
                  <Cell label={t('editor.field.cycle')}>
                    <Picker
                      value={cycleKey}
                      onChange={(k) => {
                        if (k === 'custom') {
                          setCustomCycle(true);
                          if (cycle.unit === 'lifetime') setCycle({ unit: 'month', every: 1 });
                          return;
                        }
                        setCustomCycle(false);
                        const hit = CHILD_CYCLES.find(([id]) => id === k)?.[1];
                        if (hit) setCycle({ ...hit });
                      }}
                      options={[...CHILD_CYCLES.map(([k]) => ({ value: k, label: cycleName(k) })), { value: 'custom', label: cycleName('custom') }]}
                      ariaLabel={t('editor.field.cycle')}
                    />
                  </Cell>
                  {customCycle && cycle.unit !== 'lifetime' && (
                    <Cell label={t('editor.unit.every')}>
                      <Stepper
                        label={t('editor.unit.every')}
                        value={cycle.every}
                        min={1}
                        max={cycle.unit === 'day' ? 3650 : 120}
                        unit={() => ''}
                        onChange={(every) => setCycle({ ...cycle, every })}
                      />
                      <Picker
                        value={cycle.unit}
                        onChange={(u) => setCycle({ ...cycle, unit: u as 'day' | 'week' | 'month' | 'year' })}
                        options={(['day', 'week', 'month', 'year'] as const).map((u) => ({
                          value: u,
                          label: t(`editor.unit.${u}`, { count: cycle.every }),
                        }))}
                        ariaLabel={t('editor.unit.label')}
                      />
                    </Cell>
                  )}
                </>
              )}
              <Cell label={t('editor.field.start')}>
                <DatePicker value={start} onChange={(v) => v && setStart(v)} />
              </Cell>
            </Group>
          </>
        ) : (
          <Group foot={historyErr ? <span className="err">{historyErr}</span> : undefined}>
            {edit ? (
              <Cell label={t('editor.bundle.chooseSub')}>
                <span className="row" style={{ gap: 8 }}>
                  <SubIcon sub={edit.sub} size={20} />
                  <b>{edit.name}</b>
                </span>
              </Cell>
            ) : (
              <Cell label={t('editor.bundle.chooseSub')}>
                <Picker
                  value={pickedId}
                  search
                  onChange={setPickedId}
                  options={existingPool.map((s) => ({
                    value: s.id,
                    label: s.name,
                    hint: s.account || s.region || undefined,
                    icon: <SubIcon sub={s} size={18} />,
                  }))}
                  ariaLabel={t('editor.bundle.chooseSub')}
                />
              </Cell>
            )}
            <Cell label={t('editor.bundle.mode')}>
              <Seg
                small
                value={follow ? 'follow' : 'independent'}
                onChange={(v) => setFollow(v === 'follow')}
                options={[
                  ['follow', t('editor.bundle.follow')],
                  ['independent', t('editor.bundle.independent')],
                ]}
              />
            </Cell>
          </Group>
        )}
      </div>
    </Sheet>
  );
}

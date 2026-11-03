import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { useRef, useState, type CSSProperties } from 'react';
import { PersonAvatar } from '../components/PersonAvatar.tsx';
import { compressAvatar } from '../handoff.ts';
import { flow, cnDateAuto, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { colorFor, isCustomColor, peopleLedger, personColor, refsFor, type PersonItem, type PersonLedger } from '../../../shared/people.ts';
import { PERSON_COLORS, type AppState, type Person, type ShareMember, type Subscription } from '../../../shared/types.ts';
import { Picker } from '../components/Picker.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { ask, Sheet } from '../components/overlays.tsx';
import { ColorPop } from '../components/ColorPop.tsx';
import { Icon } from '../components/icons.tsx';
import { SubIcon } from '../components/marks.tsx';
import { toast, run } from '../toast.ts';
import { deletePerson, mergePerson, savePerson } from '../store.ts';
import type { MemberSheet } from './Members.tsx';
import { ContactField, contactText, contactUrl, viaLabel } from '../components/Contact.tsx';
import { LedgerSheet } from './proxy/sheets.tsx';
import './people-list.css';

/** 联系按钮：Telegram、WhatsApp、邮箱、手机等能直接打开的渠道 */
export function ContactLink({ p }: { p: Person }) {
  const url = contactUrl(p.contactVia ?? '', p.contact);
  if (!url) return null;
  const label = t('family.contact.open', { via: viaLabel(p.contactVia ?? '') });
  return (
    <a className="icon-btn" href={url} target="_blank" rel="noreferrer" aria-label={label} title={label} onClick={(e) => e.stopPropagation()}>
      <Icon name="link" />
    </a>
  );
}

/** 一个人的详情：资料（改了处处生效）、每个合租 / 代付的明细与快捷记收款、合并与删除 */
/** 从合租成员、代付对象那里打开某个人员的详情：在这里改称呼、联系方式、头像，所有引用他的地方一起变 */
export function PersonProfileSheet({
  memberDialog: MemberDialog,
  state,
  today,
  personId,
  onOpen,
  onClose,
}: {
  memberDialog: typeof MemberSheet;
  state: AppState;
  today: string;
  personId: string;
  onOpen: (s: Subscription) => void;
  onClose: () => void;
}) {
  const l = peopleLedger(state, today).find((x) => x.person.id === personId);
  return l ? <PersonSheet memberDialog={MemberDialog} state={state} today={today} l={l} onOpen={onOpen} onClose={onClose} /> : null;
}

export function PersonSheet({
  memberDialog: MemberDialog,
  state,
  today,
  l,
  onOpen,
  onClose,
}: {
  memberDialog: typeof MemberSheet;
  state: AppState;
  today: string;
  l: PersonLedger;
  onOpen: (s: Subscription) => void;
  onClose: () => void;
}) {
  const base = state.settings.baseCurrency;
  const stored = l.person.id ? state.people?.find((p) => p.id === l.person.id) : undefined;
  const [f, setF] = useState<Person>(() => ({ ...l.person }));
  const via = f.contactVia ?? 'Telegram';
  const profile = (p: Person) => JSON.stringify([p.name, p.contact ? p.contactVia : undefined, p.contact, p.note, p.color, p.avatar]);
  const [saving, setSaving] = useState(false);
  const dirty = !!stored && profile(stored) !== profile(f);
  const refs = l.person.id ? refsFor(state.subscriptions, l.person.id).length : l.items.length;
  const others = (state.people ?? []).filter((p) => p.id !== l.person.id).sort((a, b) => a.name.localeCompare(b.name));
  const [member, setMember] = useState<{ s: Subscription; m: ShareMember } | null>(null);
  const [ledger, setLedger] = useState<Subscription | null>(null);
  const ro = !!state.readonly;
  const [avatarBusy, setAvatarBusy] = useState(false);
  const live = (s: Subscription) => state.subscriptions.find((x) => x.id === s.id) ?? s;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await run(async () => {
        if (stored && profile(stored) !== profile(f)) {
          const saved = await savePerson({ ...f, name: f.name.trim(), contactVia: f.contact ? via : undefined });
          setF((current) => (profile(current) === profile(f) ? saved : current));
        }
      }, t('family.member.saved'));
    } finally {
      setSaving(false);
    }
  };
  const tap = (i: PersonItem) => {
    const s = live(i.sub);
    if (i.kind === 'share') {
      const m = s.share?.members.find((x) => x.id === i.member!.id);
      if (m) setMember({ s, m });
    } else setLedger(s);
  };

  return (
    <Sheet
      narrow
      title={l.person.name}
      onClose={onClose}
      foot={
        stored && !ro ? (
          <>
            {refs === 0 && (
              <ConfirmButton
                onConfirm={() =>
                  run(async () => {
                    await deletePerson(stored.id);
                    onClose();
                  }, t('family.member.deleted'))
                }
              >
                {t('family.member.delete')}
              </ConfirmButton>
            )}
            <span className="grow" />
            <button className="btn" onClick={onClose}>
              {t('family.member.cancel')}
            </button>
            <button className="btn primary" disabled={!dirty || !f.name.trim() || avatarBusy || saving} onClick={save}>
              {t('family.member.save')}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="stack">
        {/* 没建档的人没有资料可改：只在顶部显示头像和联系方式 */}
        {!stored && (
          <div className="ld-head">
            <PersonAvatar p={f} size={52} />
            <div className={`muted ph-meta grow ${contactText(f) ? '' : 'm-hide'}`}>{contactText(f) || t('people.card.noContact')}</div>
            <ContactLink p={f} />
          </div>
        )}
        {stored && (
          <Group title={t('people.sheet.profile')} foot={refs > 1 ? t('people.sheet.syncFoot', { count: refs }) : undefined}>
            <ProfileFields f={f} setF={setF} ro={ro} busy={avatarBusy} setBusy={setAvatarBusy} />
            {!ro && others.length > 0 && (
              <Cell label={t('people.sheet.merge')}>
                <Picker
                  value=""
                  search={others.length > 6}
                  ariaLabel={t('people.sheet.merge')}
                  display={<span>{t('people.sheet.mergePick')}</span>}
                  onChange={async (into) => {
                    const target = others.find((p) => p.id === into);
                    if (!target || !(await ask(t('people.sheet.mergeConfirm', { from: stored.name, into: target.name })))) return;
                    run(
                      async () => {
                        await mergePerson(stored.id, target.id);
                        onClose();
                      },
                      t('people.sheet.merged', { name: target.name }),
                    );
                  }}
                  options={others.map((p) => ({ value: p.id, label: p.name, hint: contactText(p) || undefined, icon: <PersonAvatar p={p} size={20} /> }))}
                />
              </Cell>
            )}
          </Group>
        )}

        {/* 参与的项目：一项一行，点开进成员弹窗（代付进账目），账号、记一笔都在那里 */}
        <Group title={t('people.sheet.in', { count: l.items.length })} foot={l.items.length ? undefined : t('people.sheet.inEmpty')}>
          {l.items.map((i) => {
            const gone = !!i.member?.left && i.member.left <= today;
            const detail =
              i.kind === 'share'
                ? i.member?.exempt
                  ? t('family.pool.exempt')
                  : i.periodsOwed > 0
                    ? t('people.item.owedPeriods', { count: i.periodsOwed })
                    : i.paidUntil
                      ? `${t('family.member.paidUntil')} ${cnDateAuto(i.paidUntil, today)}`
                      : t('people.item.noPay')
                : i.lastPaid
                  ? `${t('people.sheet.last')} ${cnDateAuto(i.lastPaid, today)}`
                  : t('people.item.noPay');
            return (
              <button
                key={`${i.kind}-${i.sub.id}-${i.member?.id ?? ''}`}
                type="button"
                className={`cell tap pp-head ${i.active ? '' : 'off'}`}
                disabled={ro || saving}
                onClick={() => tap(i)}
              >
                <span className="pp-item-l">
                  <SubIcon sub={i.sub} size={30} />
                  <span>
                    {i.sub.name}
                    <small>
                      {t(`people.kind.${i.kind}`)} {detail}
                    </small>
                  </span>
                </span>
                <span className="pp-item-r">
                  {i.owed > 0.005 ? (
                    <b style={{ color: 'var(--orange)' }}>{t('family.pool.owedAmount', { amount: money(i.owed, base) })}</b>
                  ) : (
                    <b style={{ color: i.active ? 'var(--green)' : undefined }}>
                      {gone ? t('people.item.left') : !i.active ? t('people.item.ended') : t('family.pool.settled')}
                    </b>
                  )}
                  <small className={i.received ? 'green' : undefined}>{flow(i.received, base)}</small>
                </span>
                <Icon name="right" />
              </button>
            );
          })}
        </Group>
      </div>
      {member && (
        <MemberDialog
          state={state}
          s={live(member.s)}
          member={live(member.s).share?.members.find((x) => x.id === member.m.id) ?? member.m}
          onClose={() => setMember(null)}
        />
      )}
      {ledger && <LedgerSheet state={state} s={live(ledger)} onOpen={onOpen} onClose={() => setLedger(null)} />}
    </Sheet>
  );
}

/** 人员资料表单：头像、称呼、联系方式、备注与颜色；人员详情与新建人员共用 */
export function ProfileFields({
  f,
  setF,
  ro = false,
  busy,
  setBusy,
  autoFocus,
}: {
  f: Person;
  setF: (update: (current: Person) => Person) => void;
  ro?: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  autoFocus?: boolean;
}) {
  const customDot = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const up = (p: Partial<Person>) => setF((current) => ({ ...current, ...p }));
  const via = f.contactVia ?? 'Telegram';
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const uploadAvatar = async (file?: File) => {
    if (!file || ro || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const avatar = await compressAvatar(file);
      setF((current) => ({ ...current, avatar }));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('server.avatarInvalid'), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const val = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;
  return (
    <>
      <Cell label={t('people.avatar.label')}>
        {!ro && (
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              void uploadAvatar(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        )}
        {!ro && f.avatar && (
          <ConfirmButton disabled={busy} onConfirm={() => setF((current) => ({ ...current, avatar: undefined }))}>
            {t('people.avatar.remove')}
          </ConfirmButton>
        )}
        {ro ? (
          <PersonAvatar p={f} size={32} />
        ) : (
          <button
            type="button"
            className="person-avatar-edit"
            aria-label={t('people.avatar.change')}
            title={t('people.avatar.help')}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void uploadAvatar(e.dataTransfer.files[0]);
            }}
            onPaste={(e) => {
              const file = [...e.clipboardData.files][0];
              if (file) {
                e.preventDefault();
                void uploadAvatar(file);
              }
            }}
          >
            <PersonAvatar p={f} size={32} />
          </button>
        )}
      </Cell>
      <Cell label={t('family.member.name')}>
        <input autoFocus={autoFocus} value={f.name} disabled={ro} placeholder={t('family.member.namePh')} onChange={(e) => up({ name: val(e) })} />
      </Cell>
      <Cell label={t('family.member.contact')}>
        <ContactField via={via} value={f.contact} onVia={(v) => up({ contactVia: v })} onChange={(c) => up({ contactVia: via, contact: c || undefined })} />
      </Cell>
      <Cell label={t('family.member.note')}>
        <input value={f.note ?? ''} disabled={ro} placeholder={t('people.sheet.notePh')} onChange={(e) => up({ note: val(e) || undefined })} />
      </Cell>
      <Cell label={t(f.avatar ? 'people.avatar.fallbackColor' : 'people.sheet.color')}>
        <span className="pp-colors" role="radiogroup" aria-label={t('people.sheet.color')}>
          {PERSON_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={(f.color ?? colorFor(f.id)) === c}
              aria-label={`${t('people.sheet.color')} ${i + 1}`}
              className={`pp-dot c-${c} ${(f.color ?? colorFor(f.id)) === c ? 'on' : ''}`}
              onClick={() => up({ color: c })}
            />
          ))}
          {/* 最后一个点打开取色面板：选过自选色就显示那个颜色，没选过是虚线圈加号 */}
          <button
            ref={customDot}
            type="button"
            role="radio"
            aria-checked={isCustomColor(f.color)}
            aria-label={t('people.sheet.customColor')}
            title={t('people.sheet.customColor')}
            className={`pp-dot custom ${isCustomColor(f.color) ? 'on' : ''}`}
            style={isCustomColor(f.color) ? ({ '--pc': f.color } as CSSProperties) : undefined}
            disabled={ro}
            onClick={() => setPicking(true)}
          >
            {!isCustomColor(f.color) && <Icon name="plus" />}
          </button>
          {picking && (
            <ColorPop
              triggerRef={customDot}
              value={isCustomColor(f.color) ? f.color : '#5b8def'}
              label={t('people.sheet.customColor')}
              onChange={(hex) => up({ color: personColor(hex) })}
              onClose={() => setPicking(false)}
            />
          )}
        </span>
      </Cell>
    </>
  );
}

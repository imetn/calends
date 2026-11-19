import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { EditorStatus } from './useEditorFields.ts';
import { MemberSheet } from '../Members.tsx';
import { isDataIcon } from '../../../../shared/icon.ts';
import { useIconUpload } from './icon-upload.tsx';

import { StopFields } from '../../components/StopPanel.tsx';
import {
  addDays,
  addMonths,
  contractFits,
  currentPhase,
  isPostpaid,
  isSeparate,
  nextCharge,
  nthCharge,
  pauseDay,
  preserveRenewalHistory,
  trackingStart,
} from '../../../../shared/billing.ts';
import { cnDateFull, flow, money } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { REMIND_DAYS, type Contract, type Cycle, type SubStatus, type Subscription } from '../../../../shared/types.ts';
import { DatePicker } from '../../components/DatePicker.tsx';
import { CatIcon, SubIcon } from '../../components/marks.tsx';
import { Cell, Group } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { NumInput, Seg, Stepper, Toggle } from '../../components/inputs.tsx';
import { isDomainCat } from '../../derive.ts';

import { stopForm } from '../../../../shared/stop-form.ts';
import { syncPhase, reactivate } from '../../../../shared/phases.ts';
import { CYCLES as RENEW_CYCLES, cycleName } from '../../components/ChangePanel.tsx';
import { MethodPicker } from '../../components/MethodPicker.tsx';
import { ContactField, contactText } from '../../components/Contact.tsx';
import { getState } from '../../store.ts';
import { PersonPicker } from '../person-fields.tsx';
import { PersonProfileSheet } from '../PersonProfile.tsx';
import { CurrencySelect, Picker, RegionSelect } from '../../components/Picker.tsx';

import { transfersOf } from '../../../../shared/transfers.ts';

import type { useEditorFields } from './useEditorFields.ts';
import { CYCLES, STATUS } from './useEditorFields.ts';

export function BillingFields({ context }: { context: ReturnType<typeof useEditorFields> }) {
  const { isNew, f, up, state, today, phoneCat, setCustom, cycleKey, catOptions, setNewCat, plans, setPlans } = context;
  return (
    <Group title={t('editor.group.billing')}>
      {/* 选套餐只是代填金额、币种和认得出的周期，之后照常可改 */}
      {plans && (
        <Cell label={t('editor.field.plan')}>
          <Picker
            value={plans.picked ?? -1}
            onChange={(i) => {
              const p = plans.list[i];
              if (!p?.price) return;
              setPlans({ ...plans, picked: i });
              if (p.cycle) setCustom(!CYCLES.some(([, c]) => c.unit === p.cycle!.unit && c.every === p.cycle!.every));
              up({ price: p.price, currency: plans.currency, ...(p.cycle ? { cycle: p.cycle } : {}) });
            }}
            options={plans.list.map((p, i) => ({ value: i, label: p.name, hint: p.priceText }))}
            display={plans.picked == null ? <span className="muted">{t('editor.plan.choose', { count: plans.list.length })}</span> : undefined}
            ariaLabel={t('editor.field.plan')}
          />
        </Cell>
      )}
      <Cell label={t('editor.field.amount')}>
        <span className="ed-amount">
          <NumInput ccy={f.currency} className="num" value={f.price || undefined} placeholder="0.00" onValue={(n) => up({ price: n ?? 0 })} />
          <CurrencySelect value={f.currency} onChange={(c) => up({ currency: c })} />
        </span>
      </Cell>
      <Cell label={t('editor.field.cycle')}>
        <Picker
          value={cycleKey}
          onChange={(k) => {
            const c = CYCLES.find(([key]) => key === k);
            setCustom(!c);
            if (c) up({ cycle: c[1] });
            else up({ cycle: { unit: 'month', every: 2 } });
          }}
          options={[...CYCLES.map(([k]) => ({ value: k, label: cycleName(k) })), { value: 'custom', label: cycleName('custom') }]}
          ariaLabel={t('editor.field.cycle')}
        />
      </Cell>
      {cycleKey === 'custom' && (
        <Cell label={t('editor.unit.every')}>
          <Stepper
            label={t('editor.unit.every')}
            value={f.cycle.every}
            min={1}
            max={999}
            unit={() => ''}
            onChange={(n) => up({ cycle: { unit: f.cycle.unit === 'lifetime' ? 'month' : f.cycle.unit, every: n } })}
          />
          <Picker
            value={f.cycle.unit}
            onChange={(u) => up({ cycle: { unit: u as Cycle['unit'], every: f.cycle.every } })}
            options={[
              { value: 'day', label: t('editor.unit.day', { count: f.cycle.every }) },
              { value: 'week', label: t('editor.unit.week', { count: f.cycle.every }) },
              { value: 'month', label: t('editor.unit.month', { count: f.cycle.every }) },
              { value: 'year', label: t('editor.unit.year', { count: f.cycle.every }) },
            ]}
            ariaLabel={t('editor.unit.label')}
          />
        </Cell>
      )}
      {f.cycle.unit !== 'lifetime' && (
        <Cell label={t('editor.field.billing')}>
          <Seg
            small
            value={f.billing ?? 'prepaid'}
            onChange={(v) => up({ billing: v === 'postpaid' ? 'postpaid' : undefined })}
            options={[
              ['prepaid', t('editor.billing.prepaid')],
              ['postpaid', t('editor.billing.postpaid')],
            ]}
          />
        </Cell>
      )}
      <Cell label={t('editor.field.category')}>
        <Picker
          value={f.category}
          onChange={(c) => (c === '__new' ? setNewCat(true) : up({ category: c }))}
          options={[
            ...catOptions.map((c) => ({ value: c, label: c, icon: <CatIcon cat={c} size={14} /> })),
            { value: '__new', label: t('editor.category.new'), icon: <Icon name="plus" size={14} /> },
          ]}
          ariaLabel={t('editor.field.category')}
          display={
            <>
              <CatIcon cat={f.category} size={13} />
              <span>{f.category || t('editor.category.choose')}</span>
            </>
          }
        />
      </Cell>
      <Cell label={t('editor.field.method')}>
        <MethodPicker
          methods={state.methods}
          value={f.methodId}
          onChange={(id) =>
            up({
              methodId: id,
              ...(isNew && f.cancelLeadDays == null && state.methods.find((m) => m.id === id)?.kind === 'appstore' ? { cancelLeadDays: 1 } : {}),
              ...(!f.region && state.methods.find((m) => m.id === id)?.region ? { region: state.methods.find((m) => m.id === id)!.region } : {}),
            })
          }
        />
      </Cell>
      {isNew && (
        <Cell label={t(f.cycle.unit === 'lifetime' ? 'editor.field.purchased' : 'editor.field.start')}>
          <DatePicker value={f.start} onChange={(v) => up({ start: v ?? today })} />
        </Cell>
      )}
      <Cell label={t('editor.field.region')}>
        <RegionSelect
          value={f.region}
          onChange={(r) => up({ region: r })}
          common={[
            ...new Set(
              [...state.subscriptions.flatMap((x) => [x.region, ...(x.phases ?? []).map((ph) => ph.region)]), ...state.methods.map((m) => m.region)].filter(
                Boolean,
              ) as string[],
            ),
          ]}
        />
      </Cell>
      {/* 账号：通信类叫「手机号」、用电话键盘，其余叫「账号」 */}
      <Cell label={phoneCat ? t('editor.field.phone') : t('editor.field.account')}>
        <input
          className="ed-account"
          type={phoneCat ? 'tel' : 'text'}
          inputMode={phoneCat ? 'tel' : 'email'}
          autoComplete="off"
          spellCheck={false}
          value={f.account ?? ''}
          placeholder={phoneCat ? t('editor.ph.phone') : t('editor.ph.account')}
          onChange={(e) => up({ account: e.target.value || undefined })}
        />
      </Cell>
    </Group>
  );
}

export function StatusFields({ context }: { context: ReturnType<typeof useEditorFields> }) {
  const { stop, setStop, f, up, state, today } = context;
  return (
    <Group title={t('editor.group.status')}>
      <div className="cell">
        <Seg<EditorStatus>
          value={stop ? 'stop' : (f.status as EditorStatus)}
          onChange={(v) => {
            if (v === 'stop') {
              setStop(stopForm(syncPhase(f, today), today, state));
            } else {
              const next = reactivate(f);
              up({ ...next, status: v as SubStatus, pausedAt: v === 'paused' ? (f.pausedAt ?? pauseDay(f, today)) : undefined });
              setStop(undefined);
            }
          }}
          options={STATUS.map((s) => [s, t(`editor.status.${s}`)])}
        />
      </div>
      {!stop && f.status === 'trial' && (
        <Cell label={t('editor.field.trialEnd')}>
          <DatePicker value={f.trialEnd} clearable onChange={(v) => up({ trialEnd: v })} />
        </Cell>
      )}
      {!stop && f.status === 'paused' && (
        <Cell label={t('editor.field.pausedAt')}>
          <DatePicker value={f.pausedAt ?? pauseDay(f, today)} onChange={(v) => up({ pausedAt: v ?? pauseDay(f, today) })} />
        </Cell>
      )}
      {stop && <StopFields sub={syncPhase(f, today)} today={today} value={stop} onChange={setStop} />}
    </Group>
  );
}

export function SharingFields({ context }: { context: ReturnType<typeof useEditorFields> }) {
  const { f, up, state, today, proxyLinked, proxyProfile, setProxyProfile, share, setShare, perHead, val } = context;
  return (
    <Group
      title={t('editor.group.who')}
      foot={
        f.proxy
          ? undefined
          : share?.role === 'member'
            ? t('editor.share.memberHint')
            : share?.role === 'owner'
              ? `${t('editor.share.perHead', { amount: money(perHead, f.currency) })}\n${t('editor.share.manageHint')}`
              : undefined
      }
    >
      <div className="cell">
        <Seg
          value={f.proxy ? 'proxy' : share ? share.role : 'none'}
          onChange={(v) =>
            v === 'proxy'
              ? up({ share: undefined, proxy: { ...f.proxy, forName: f.proxy?.forName ?? '' } })
              : up({ proxy: undefined, share: v === 'none' ? undefined : { seats: 6, members: [], ...share, role: v as 'owner' | 'member' } })
          }
          options={[
            ['none', t('editor.share.none')],
            ['owner', t('editor.share.owner')],
            ['member', t('editor.share.member')],
            ['proxy', t('editor.share.proxy')],
          ]}
        />
      </div>
      {f.proxy && (
        <>
          {(state.people?.length ?? 0) > 0 && (
            <Cell label={t('people.field.person')}>
              <PersonPicker
                state={state}
                value={proxyLinked ? f.proxy.personId : undefined}
                onPick={(p) =>
                  p
                    ? up({ proxy: { ...f.proxy!, personId: p.id, forName: p.name, contactVia: p.contactVia, contact: p.contact } })
                    : up({ proxy: { ...f.proxy!, personId: undefined, forName: '', contactVia: undefined, contact: undefined } })
                }
              />
            </Cell>
          )}
          {/* 与合租成员一致：这里只选替谁付；称呼、联系方式属于人员，到人员详情里改。新建人员时才在这里填 */}
          {proxyLinked ? (
            <Cell label={t('editor.proxy.contact')}>
              <span className={contactText(f.proxy) ? undefined : 'muted'}>{contactText(f.proxy) || t('people.field.noContact')}</span>
              <button type="button" className="btn plain" onClick={() => setProxyProfile(true)}>
                {t('people.field.editProfile')}
              </button>
            </Cell>
          ) : (
            <>
              <Cell label={t('editor.proxy.for')}>
                <input
                  value={f.proxy.forName}
                  placeholder={t('editor.proxy.forPlaceholder')}
                  onChange={(e) => up({ proxy: { ...f.proxy!, forName: val(e) } })}
                />
              </Cell>
              <Cell label={t('editor.proxy.contact')}>
                <ContactField
                  via={f.proxy.contactVia ?? 'Telegram'}
                  value={f.proxy.contact}
                  onVia={(v) => up({ proxy: { ...f.proxy!, contactVia: v } })}
                  onChange={(c) => up({ proxy: { ...f.proxy!, contactVia: f.proxy!.contactVia ?? 'Telegram', contact: c || undefined } })}
                />
              </Cell>
            </>
          )}
          {proxyProfile && f.proxy.personId && (
            <PersonProfileSheet
              memberDialog={MemberSheet}
              state={state}
              today={today}
              personId={f.proxy.personId}
              onOpen={() => setProxyProfile(false)}
              onClose={() => {
                setProxyProfile(false);
                const p = getState().people?.find((x) => x.id === f.proxy?.personId);
                if (p && f.proxy) up({ proxy: { ...f.proxy, forName: p.name, contactVia: p.contactVia, contact: p.contact } });
              }}
            />
          )}
          <Cell label={t('editor.field.notes')}>
            <input
              value={f.proxy.note ?? ''}
              placeholder={t('editor.proxy.notePlaceholder')}
              onChange={(e) => up({ proxy: { ...f.proxy!, note: val(e) || undefined } })}
            />
          </Cell>
        </>
      )}
      {share?.role === 'member' && (
        <Cell label={t('editor.share.ownerName')}>
          <input
            value={share.ownerName ?? ''}
            placeholder={t('editor.share.ownerPlaceholder')}
            onChange={(e) => setShare({ ownerName: val(e) || undefined })}
          />
        </Cell>
      )}
    </Group>
  );
}

/** 订阅图标：上传本地图片（缩成 128px 内嵌进数据里），也可拖入、粘贴图片；与钱包 Logo 一样，点「链接」才展开网址 / emoji 输入 */
function IconField({ f, up }: { f: Subscription; up: (p: Partial<Subscription>) => void }) {
  const pick = useIconUpload(up);
  const embedded = isDataIcon(f.icon);
  return (
    <div className="cell icon-field" onDragOver={pick.onDragOver} onDrop={pick.onDrop}>
      {/* 「是图片图标」写在标签下（可换行），长文案语言在窄屏也放得下 */}
      <span className="cell-l">
        {t('editor.field.icon')}
        {embedded && <small>{t('editor.field.iconImage')}</small>}
      </span>
      {/* 和网站、管理页一样一行写完：网址 / emoji 直接在行内输入，右边是预览与上传，高度不变 */}
      <span className="cell-r icon-actions">
        {/* 内嵌图片不把整串 base64 塞进来：留空并提示，输入网址或 emoji 即替换 */}
        <input
          value={embedded ? '' : (f.icon ?? '')}
          placeholder={embedded ? t('editor.field.iconImported') : t('editor.field.auto')}
          aria-label={t('editor.field.icon')}
          onChange={(e) => up({ icon: (e.target as HTMLInputElement).value || undefined })}
          onPaste={pick.onPaste}
        />
        <SubIcon sub={f} size={28} />
        <button type="button" className="chip-btn" disabled={pick.busy} title={t('editor.field.iconUploadHelp')} onClick={pick.open}>
          {t('editor.field.iconUpload')}
        </button>
        {/* 网址和 emoji 删掉输入就清空；上传的图片输入框里没有内容，单独给清除 */}
        {embedded && (
          <button type="button" className="chip-btn" disabled={pick.busy} onClick={() => up({ icon: undefined })}>
            {t('editor.field.iconClear')}
          </button>
        )}
        {pick.input}
      </span>
    </div>
  );
}

export function MoreFields({ context }: { context: ReturnType<typeof useEditorFields> }) {
  const { isNew, f, up, state, today, val, lt, setTransfer, more } = context;
  // 下次扣款日按保存后的样子显示：改了周期或提前天数，这里跟着重算；手动改的直接存成下次扣款日
  const saved = state.subscriptions.find((s) => s.id === f.id);
  const manualDue =
    !isNew && saved && !lt && !isSeparate(f) && !isPostpaid(f) && f.status === 'active' && !f.stop && !f.end
      ? nextCharge(syncPhase(preserveRenewalHistory(saved, f, today), today), today)
      : undefined;
  return (
    more && (
      <>
        {!lt && (
          <>
            <Group title={t('editor.more.intro')}>
              <Cell
                label={
                  <span className="row" style={{ gap: 6 }}>
                    <Icon name="leaf" /> {t('editor.intro.has')}
                  </span>
                }
              >
                <Toggle
                  checked={!!f.intro}
                  onChange={(v) =>
                    up({
                      intro: v
                        ? { price: f.price, until: nthCharge(f.start, f.cycle.unit === 'lifetime' ? { unit: 'year', every: 1 } : f.cycle, 1) }
                        : undefined,
                    })
                  }
                />
              </Cell>
              {f.intro && (
                <>
                  <Cell label={t('editor.intro.price')}>
                    <NumInput ccy={f.currency} className="num" value={f.intro.price} onValue={(n) => up({ intro: { ...f.intro!, price: n ?? 0 } })} />
                  </Cell>
                  <Cell label={t('editor.intro.until')}>
                    <DatePicker value={f.intro.until} onChange={(v) => up({ intro: { ...f.intro!, until: v ?? today } })} />
                  </Cell>
                </>
              )}
            </Group>
            <Group title={t('editor.more.bonus')} foot={f.bonus ? t('editor.bonus.resume', { date: cnDateFull(f.bonus.until) }) : undefined}>
              <Cell
                label={
                  <span className="row" style={{ gap: 6 }}>
                    <Icon name="receipt" /> {t('editor.bonus.has')}
                  </span>
                }
              >
                <Toggle
                  checked={!!f.bonus}
                  onChange={(v) => {
                    // 默认从下一次扣款日开始送一个周期
                    const from = f.cycle.unit === 'lifetime' ? today : (nextCharge(f, today) ?? nthCharge(f.start, f.cycle, 1));
                    up({ bonus: v ? { from, until: f.cycle.unit === 'lifetime' ? addMonths(from, 12) : nthCharge(from, f.cycle, 1) } : undefined });
                  }}
                />
              </Cell>
              {f.bonus && (
                <>
                  <Cell label={t('editor.bonus.from')}>
                    <DatePicker value={f.bonus.from} onChange={(v) => up({ bonus: { ...f.bonus!, from: v ?? today } })} />
                  </Cell>
                  <Cell label={t('editor.bonus.until')}>
                    <DatePicker value={f.bonus.until} onChange={(v) => up({ bonus: { ...f.bonus!, until: v ?? today } })} />
                  </Cell>
                  <div className="cell bonus-quick">
                    {(
                      [
                        ['d7', (d: string) => addDays(d, 7)],
                        ['m1', (d: string) => addMonths(d, 1)],
                        ['m3', (d: string) => addMonths(d, 3)],
                        ['m6', (d: string) => addMonths(d, 6)],
                        ['y1', (d: string) => addMonths(d, 12)],
                      ] as Array<[string, (d: string) => string]>
                    ).map(([l, fn]) => (
                      <button
                        key={l}
                        type="button"
                        className={`chip-btn ${f.bonus!.until === fn(f.bonus!.from) ? 'on' : ''}`}
                        onClick={() => up({ bonus: { ...f.bonus!, until: fn(f.bonus!.from) } })}
                      >
                        {t(`editor.bonus.quick.${l}`)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </Group>
            {/* 天数是手填的：减号、可直接输入的数字、加号收在一个胶囊里；说明放在组下方 */}
            <Group title={t('core.renewal.title')} foot={t('core.renewal.hint')}>
              {/* 账单与缴费分开记是少数账单才用的计费方式，收在这里；与「付费方式」一样用胶囊切换。分开记时下次扣款日改由账单推算，下面那行随之隐藏 */}
              <Cell label={t('editor.field.settlement')}>
                <Seg
                  small
                  value={f.settlement === 'separate' ? 'separate' : 'together'}
                  options={[
                    ['together', t('editor.settlement.together')],
                    ['separate', t('editor.settlement.separate')],
                  ]}
                  onChange={(v) =>
                    up(
                      v === 'separate'
                        ? // 打开时记下追踪起点（最早一笔缴费对应的账单，没有缴费时是离今天最近的一期），之前的账单视为已缴；不动账单锚点
                          { settlement: 'separate', settledBefore: f.settledBefore ?? trackingStart(f, today) }
                        : // 关掉时不留痕：追踪起点与各笔缴费指定的账单一并清掉
                          {
                            settlement: undefined,
                            settledBefore: undefined,
                            payments: f.payments?.map(({ periods: _, ...p }) => p),
                            ...(f.phases ? { phases: f.phases.map((ph) => ({ ...ph, payments: ph.payments?.map(({ periods: _, ...p }) => p) })) } : {}),
                          },
                    )
                  }
                />
              </Cell>
              {manualDue && (
                <Cell label={t('core.renewal.nextDue')}>
                  <DatePicker value={manualDue} onChange={(v) => v && up({ nextDue: v })} />
                </Cell>
              )}
              {(['chargeLeadDays', 'cancelLeadDays'] as const).map((field) => (
                <Cell key={field} label={t(`core.renewal.${field}`)}>
                  <Stepper
                    label={t(`core.renewal.${field}`)}
                    value={f[field] ?? 0}
                    unit={(n) => t('editor.unit.day', { count: n })}
                    onChange={(n) => up({ [field]: n })}
                  />
                </Cell>
              ))}
            </Group>
            <ContractFields f={f} up={up} today={today} />
            <Group title={t('editor.more.remind')}>
              <Cell
                label={
                  <span className="row" style={{ gap: 6 }}>
                    <Icon name="bell" /> {t('editor.remind.days')}
                  </span>
                }
              >
                <Picker
                  value={f.remindDays == null ? '' : String(f.remindDays)}
                  onChange={(v) => up({ remindDays: v === '' ? undefined : Number(v) })}
                  options={[
                    {
                      value: '',
                      label:
                        state.settings.remindDays < 0
                          ? t('editor.remind.defaultNever')
                          : state.settings.remindDays === 0
                            ? t('editor.remind.defaultSameDay')
                            : t('editor.remind.default', { count: state.settings.remindDays }),
                    },
                    ...REMIND_DAYS.map((n) => ({ value: String(n), label: n === 0 ? t('editor.remind.sameDay') : t('editor.remind.before', { count: n }) })),
                    { value: '-1', label: t('editor.remind.never') },
                  ]}
                  ariaLabel={t('editor.more.remind')}
                />
              </Cell>
            </Group>
          </>
        )}
        {/* 转让收付：二手买入、卖出的实际现金；完成时随整张表单保存。代付是别人的订阅，没有转让 */}
        {!f.proxy && (
          <Group
            title={t('detail.transfer.title')}
            foot={t('detail.transfer.foot')}
            action={
              <button type="button" className="btn plain" onClick={() => setTransfer({})}>
                <Plus size={14} /> {t('detail.transfer.add')}
              </button>
            }
          >
            {f.transfers?.length ? (
              transfersOf(f).map((tr) => {
                const index = f.transfers!.indexOf(tr);
                return (
                  <Cell
                    key={index}
                    label={`${t(`detail.transfer.kind.${tr.kind}`)}\n${cnDateFull(tr.date)}`}
                    sub={tr.note}
                    onClick={() => setTransfer({ index })}
                  >
                    <span className={`num ${tr.kind === 'sell' ? 'green' : ''}`}>{flow(tr.kind === 'buy' ? -tr.amount : tr.amount, tr.currency)}</span>
                  </Cell>
                );
              })
            ) : (
              <Cell label={<span className="muted">{t('detail.transfer.none')}</span>} />
            )}
          </Group>
        )}
        <Group title={t('editor.group.links')}>
          <Cell label={t('editor.field.url')}>
            <input value={f.url ?? ''} placeholder="https://" onChange={(e) => up({ url: val(e) || undefined })} />
          </Cell>
          <Cell label={t('editor.field.manageUrl')}>
            <input value={f.manageUrl ?? ''} placeholder={t('editor.field.optional')} onChange={(e) => up({ manageUrl: val(e) || undefined })} />
          </Cell>
          <IconField f={f} up={up} />
          {isDomainCat(f.category) && (
            <Cell label={t('editor.field.showDomain')} sub={t(f.showOnPublic ? 'editor.field.showDomainOn' : 'editor.field.showDomainOff')}>
              <Toggle label={t('editor.field.showDomain')} checked={!!f.showOnPublic} onChange={(v) => up({ showOnPublic: v || undefined })} />
            </Cell>
          )}
        </Group>
        <Group title={t('editor.group.tags')}>
          <Cell label={t('editor.more.tags')}>
            <input
              value={f.tags.join(' ')}
              placeholder={t('editor.field.tagsPlaceholder')}
              onChange={(e) => up({ tags: val(e).split(/\s+/).filter(Boolean) })}
            />
          </Cell>
          <div className="cell">
            <span className="cell-r">
              <textarea
                value={f.notes ?? ''}
                placeholder={t('editor.field.notesPlaceholder')}
                onChange={(e) => up({ notes: (e.target as HTMLTextAreaElement).value || undefined })}
              />
            </span>
          </div>
        </Group>
      </>
    )
  );
}

// 合同期限的选项与订阅周期菜单一致：去掉按周计的和买断，末尾是自定义；合同只按整月或整年算
const CONTRACT_TERMS = RENEW_CYCLES.filter(([, c]) => c.unit === 'month' || c.unit === 'year');
const CONTRACT_NOTICE = [0, 7, 14, 30, 60, 90];
const sameTerm = (a: Cycle, b: Cycle) => a.unit === b.unit && a.every === b.every;
/** 某个单位下不短于付费周期的最小期数，用作自定义步进器的下限 */
const minEvery = (unit: 'month' | 'year', cycle: Cycle) => {
  for (let n = 1; n < 1200; n++) if (contractFits({ unit, every: n }, cycle)) return n;
  return 1200;
};

/** 合同期：期限、起始日、到期续约与续约提醒；只影响展示与提醒，不改扣款 */
function ContractFields({ f, up, today }: { f: Subscription; up: (p: Partial<Subscription>) => void; today: string }) {
  const c = f.contract;
  const terms = CONTRACT_TERMS.filter(([, x]) => contractFits(x, f.cycle));
  const [custom, setCustom] = useState(!!c && !terms.some(([, x]) => sameTerm(x, c.term)));
  const set = (p: Partial<Contract>) => up({ contract: { ...c!, ...p } });
  const setTerm = (term: Cycle) => up({ contract: { start: c?.start ?? currentPhase(f, today).start, ...c, term } });
  const unit = c?.term.unit === 'month' ? 'month' : 'year';
  return (
    <Group title={t('core.contract.title')}>
      <Cell label={t('core.contract.term')}>
        <Picker
          value={!c ? '' : custom ? 'custom' : (terms.find(([, x]) => sameTerm(x, c.term))?.[0] ?? 'custom')}
          onChange={(v) => {
            setCustom(v === 'custom');
            if (v === '') return up({ contract: undefined });
            // 自定义沿用当前期限；还没有合同期时从不短于付费周期的整年起
            const term = v === 'custom' ? (c?.term ?? { unit: 'year', every: minEvery('year', f.cycle) }) : terms.find(([k]) => k === v)?.[1];
            if (term) setTerm(term);
          }}
          options={[
            { value: '', label: t('core.contract.off') },
            ...terms.map(([k]) => ({ value: k, label: cycleName(k) })),
            { value: 'custom', label: cycleName('custom') },
          ]}
          ariaLabel={t('core.contract.term')}
        />
      </Cell>
      {c && custom && (
        <Cell label={t('editor.unit.every')}>
          <Stepper
            label={t('editor.unit.every')}
            value={c.term.every}
            min={minEvery(unit, f.cycle)}
            max={unit === 'month' ? 1200 : 100}
            unit={() => ''}
            onChange={(n) => setTerm({ unit, every: n })}
          />
          <Picker
            value={unit}
            onChange={(u) => {
              const next = u === 'month' ? 'month' : 'year';
              setTerm({ unit: next, every: Math.max(c.term.every, minEvery(next, f.cycle)) });
            }}
            options={[
              { value: 'month', label: t('editor.unit.month', { count: c.term.every }) },
              { value: 'year', label: t('editor.unit.year', { count: c.term.every }) },
            ]}
            ariaLabel={t('editor.unit.label')}
          />
        </Cell>
      )}
      {c && (
        <>
          <Cell label={t('core.contract.start')}>
            <DatePicker value={c.start} onChange={(v) => v && set({ start: v })} />
          </Cell>
          <Cell label={t('core.contract.renews')}>
            <Toggle label={t('core.contract.renews')} checked={c.renew !== 'none'} onChange={(v) => set({ renew: v ? undefined : 'none' })} />
          </Cell>
          <Cell label={t('core.contract.noticeDays')}>
            <Picker
              value={c.noticeDays == null ? '' : String(c.noticeDays)}
              onChange={(v) => set({ noticeDays: v === '' ? undefined : Number(v) })}
              options={[
                { value: '', label: t('core.contract.noticeOff') },
                ...[...new Set([...CONTRACT_NOTICE, ...(c.noticeDays != null ? [c.noticeDays] : [])])]
                  .sort((a, b) => a - b)
                  .map((n) => ({ value: String(n), label: n === 0 ? t('editor.remind.sameDay') : t('editor.remind.before', { count: n }) })),
              ]}
              ariaLabel={t('core.contract.noticeDays')}
            />
          </Cell>
        </>
      )}
    </Group>
  );
}

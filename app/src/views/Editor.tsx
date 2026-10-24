import { copyParts } from '../components/copy.tsx';
import { preserveRenewalHistory, migrateRenewalRules } from '../../../shared/billing.ts';
import { base } from '../base.ts';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StopFields } from '../components/StopPanel.tsx';
import { Minus, Plus, ReceiptText } from 'lucide-react';
import { compressImage, handoff } from '../handoff.ts';
import { addDays, addMonths, diffDays, memberCollection, memberUnpaidFrom, nextCharge, nthCharge, uid } from '../../../shared/billing.ts';
import { carRule, followsCar, shareFromFee } from '../../../shared/carpool.ts';
import { cnDateFull, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Cycle, ShareMember, SubStatus, Subscription } from '../../../shared/types.ts';
import { DatePicker } from '../components/DatePicker.tsx';
import { RowActions } from '../components/RowActions.tsx';
import { ask, CatIcon, Cell, Group, Icon, NumInput, Seg, Sheet, SubIcon, Toggle } from '../components/ui.tsx';
import { categories, isDomainCat, presetCat } from '../derive.ts';
import { CategorySheet } from './Categories.tsx';
import { applyStopForm, stopForm, type StopForm } from '../../../shared/stop-form.ts';
import { affectedPriceCharges, changePrice, syncPhase, toEditForm, reactivate } from '../../../shared/phases.ts';
import { ChangePanel, cycleName, CYCLES as RENEW_CYCLES } from '../components/ChangePanel.tsx';
import { MethodPicker } from '../components/MethodPicker.tsx';
import { ContactField, MemberSheet } from './Members.tsx';
import { api, deleteSub, getState, mergeEdits, run, savePerson, saveSub } from '../store.ts';
import { linkPerson, PersonPicker } from './People.tsx';
import { CurrencySelect, Picker, RegionSelect } from '../components/Picker.tsx';
import { searchCatalog, type CatalogItem } from '../catalog.ts';
import type { AppStorePlan } from '../../../shared/appstore-plans.ts';

const CYCLES: Array<[string, Cycle]> = [...RENEW_CYCLES, ['lt', { unit: 'lifetime', every: 1 }]];

type EditorStatus = 'active' | 'trial' | 'paused' | 'stop';
// 按订阅生命周期排列：先试用，再计费，可暂停，最后停止
const STATUS: EditorStatus[] = ['trial', 'active', 'paused', 'stop'];

export function newSub(today: string, methodId?: string, currency = 'USD'): Subscription {
  return {
    id: uid(),
    name: '',
    category: presetCat('tools'),
    tags: [],
    price: 0,
    currency,
    cycle: { unit: 'month', every: 1 },
    start: today,
    status: 'active',
    methodId,
  };
}

/**
 * 表单草稿：关掉时有改动就存一份，下次打开接着填，不再弹「放弃修改？」。
 * 新建共用一份，编辑按订阅各存一份；只存在本机。编辑的订阅在别处改过后，旧草稿作废
 */
interface Draft {
  form: Subscription;
  basePrice: number;
  stop?: StopForm;
  /** 打开表单时订阅的样子：和现在不一样说明别处改过，草稿不再适用 */
  base: string;
}
const draftKey = (isNew: boolean, id: string) => `ledger:draft:${isNew ? 'new' : id}`;
/** 比较表单内容时不看 id：清空后的新表单 id 不同，但内容是空的 */
const sig = (x: Subscription) => JSON.stringify({ ...x, id: '' });
function readDraft(key: string, base: string): Draft | undefined {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null;
    if (d && d.base === base) return d;
    localStorage.removeItem(key);
  } catch {
    /* 隐私模式或坏数据 */
  }
  return undefined;
}
function writeDraft(key: string, d: Draft | undefined) {
  try {
    if (d) localStorage.setItem(key, JSON.stringify(d));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function Editor({ sub, state, today, onClose }: { sub: Subscription; state: AppState; today: string; onClose: () => void }) {
  const [isNew] = useState(() => !state.subscriptions.some((s) => s.id === sub.id));
  const key = draftKey(isNew, sub.id);
  // 有多个阶段时，表单显示今天所在的阶段
  const [initialForm] = useState(() => toEditForm(migrateRenewalRules(structuredClone(sub)), today));
  const [initial] = useState(() => sig(initialForm));
  // 新建的草稿不看 base（每次新建 id 都不同）；编辑的要求订阅没被别处改过
  const [draft] = useState(() => readDraft(key, isNew ? 'new' : initial));
  const [restored, setRestored] = useState(!!draft);
  const [priceValid, setPriceValid] = useState(true);
  const [historyReset, setHistoryReset] = useState(0);
  const [f, setFRaw] = useState<Subscription>(() => draft?.form ?? initialForm);
  const [stop, setStop] = useState<StopForm | undefined>(
    () => draft?.stop ?? (f.stop || f.end || ['cancelled', 'terminated'].includes(f.status) ? stopForm(f, today) : undefined),
  );
  // 历程操作会改写价格；记录操作后的价格，用来判断表单里的价格是否又被手动改过
  const [basePrice, setBasePrice] = useState(draft?.basePrice ?? initialForm.price);
  const setF = (next: Subscription) => {
    const form = toEditForm(next, today);
    setFRaw(form);
    setBasePrice(form.price);
    // Existing history actions can resume or change an end date; keep the status draft aligned.
    if (form.end !== f.end || form.status !== f.status || JSON.stringify(form.stop) !== JSON.stringify(f.stop)) {
      setStop(form.stop || form.end || ['cancelled', 'terminated'].includes(form.status) ? stopForm(form, today) : undefined);
    }
  };
  const up = (p: Partial<Subscription>) => setFRaw((x) => ({ ...x, ...p }));
  const dirty =
    sig(f) !== initial ||
    !priceValid ||
    !!stop !== !!(initialForm.stop || initialForm.end || ['cancelled', 'terminated'].includes(initialForm.status)) ||
    (!!stop && JSON.stringify(stop) !== JSON.stringify(stopForm(initialForm, today)));
  // 关闭即存草稿；没改动就清掉
  const close = () => {
    writeDraft(key, dirty ? { form: f, basePrice, stop, base: isNew ? 'new' : initial } : undefined);
    onClose();
  };
  /** 新建：清空成一张新表；编辑：回到保存过的样子 */
  const reset = () => {
    writeDraft(key, undefined);
    setRestored(false);
    setPriceValid(true);
    setHistoryReset((n) => n + 1);
    const fresh = isNew ? toEditForm(newSub(today, state.settings.defaultMethodId, state.settings.baseCurrency), today) : initialForm;
    setFRaw(fresh);
    setBasePrice(fresh.price);
    setStop(fresh.stop || fresh.end || ['cancelled', 'terminated'].includes(fresh.status) ? stopForm(fresh, today) : undefined);
  };

  /** 交给 AI 助手：已经填的名称一并带过去 */
  const toAssistant = (images: string[] = []) => {
    close();
    handoff(f.name.trim() ? `${f.name.trim()}\n` : '', images);
  };

  const save = async () => {
    if (!priceValid) return;
    let out: Subscription = { ...f, name: f.name.trim(), account: f.account?.trim() || undefined };
    if (!isNew) out = preserveRenewalHistory(sub, out, today);
    // 直接改了价格框：视为今天起调价，过往账单保持原价
    try {
      if (!isNew && basePrice !== out.price) out = changePrice(syncPhase({ ...out, price: basePrice }, today), today, out.price);
      else out = syncPhase(out, today);
      if (stop && out.cycle.unit !== 'lifetime') out = applyStopForm(out, stop, today);
    } catch (e) {
      await run(async () => {
        throw e;
      });
      return;
    }
    const affected = !isNew && affectedPriceCharges(sub, out, today);
    if (affected && !(await ask(t('editor.history.repriceCharges', { count: affected })))) return;
    await run(
      async () => {
        if (out.status === 'cancelled' && !out.end) out.end = today;
        if (out.status === 'paused' && !out.pausedAt) out.pausedAt = today;
        if (out.status !== 'paused') delete out.pausedAt;
        // 代付对象：新的人先建档，已有的人改了资料等订阅保存后再同步
        const px = out.proxy;
        const link: Awaited<ReturnType<typeof linkPerson>> = px
          ? await linkPerson(state, px.personId, px.forName, px.contact ? (px.contactVia ?? 'Telegram') : undefined, px.contact)
          : {};
        if (px) out = { ...out, proxy: { ...px, forName: px.forName.trim(), personId: link.id } };
        await saveSub(
          isNew
            ? out
            : mergeEdits(
                sub,
                out,
                getState().subscriptions.find((x) => x.id === sub.id),
              ),
        );
        if (link.after) await savePerson(link.after);
        writeDraft(key, undefined);
        onClose();
      },
      t(isNew ? 'editor.toast.added' : 'editor.toast.saved'),
    );
  };

  return (
    <Sheet
      narrow
      title={isNew ? t('editor.addTitle') : t('editor.editTitle', { name: sub.name })}
      onClose={close}
      foot={
        <>
          {!isNew && (
            <button
              className="btn danger"
              onClick={async () =>
                (await ask(t('editor.confirmDelete', { name: sub.name }))) &&
                run(
                  async () => {
                    await deleteSub(sub.id);
                    writeDraft(key, undefined);
                    onClose();
                  },
                  // 删了还能撤销：把删掉的订阅原样存回去
                  { text: t('editor.toast.deleted'), action: { label: t('ui.undo'), onClick: () => void run(() => saveSub(sub), t('ui.restored')) } },
                )
              }
            >
              {t('common.delete')}
            </button>
          )}
          {dirty ? (
            <button className="btn plain" onClick={reset}>
              {isNew ? t('editor.clearForm') : t('editor.revert')}
            </button>
          ) : null}
          <span className="grow" />
          <button
            className="btn"
            onClick={() => {
              writeDraft(key, undefined);
              onClose();
            }}
          >
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!f.name.trim() || !priceValid} onClick={save}>
            {isNew ? t('common.add') : t('common.done')}
          </button>
        </>
      }
    >
      {restored && dirty && <div className="ed-draft">{t('editor.draftRestored')}</div>}
      {isNew && (
        <button type="button" className="ed-ai" onClick={() => toAssistant()}>
          <span className="ed-ai-ico">
            <ReceiptText size={18} />
          </span>
          <span className="ed-ai-text">
            <b>{t('editor.ai.title')}</b>
          </span>
          <span className="ed-ai-go">{t('editor.ai.go')}</span>
        </button>
      )}
      <div
        onPaste={(e) => {
          // 新建时在表单里粘贴截图：交给 AI 助手识别
          const files = isNew ? [...e.clipboardData.files].filter((x) => x.type.startsWith('image/')) : [];
          if (!files.length) return;
          e.preventDefault();
          void Promise.all(files.slice(0, 8).map(compressImage)).then(toAssistant, () => toAssistant());
        }}
      >
        <Form isNew={isNew} f={f} setF={setF} up={up} state={state} today={today} stop={stop} setStop={setStop} />
      </div>
      {!isNew && (
        <div style={{ marginTop: 18 }}>
          <ChangePanel key={historyReset} f={f} setF={setF} state={state} today={today} onPriceValidity={setPriceValid} />
        </div>
      )}
    </Sheet>
  );
}

function Form({
  isNew,
  stop,
  setStop,
  f,
  setF,
  up,
  state,
  today,
}: {
  isNew: boolean;
  stop?: StopForm;
  setStop: (value: StopForm | undefined) => void;
  f: Subscription;
  setF: (s: Subscription) => void;
  up: (p: Partial<Subscription>) => void;
  state: AppState;
  today: string;
}) {
  const phoneCat = f.category === presetCat('phone');
  const preset = CYCLES.find(([, c]) => c.unit === f.cycle.unit && c.every === f.cycle.every)?.[0];
  // 选了「自定义」就一直停在自定义，填到恰好等于某个预设（如每 1 个月）时也不跳回去
  const [custom, setCustom] = useState(!preset);
  const cycleKey = custom || !preset ? 'custom' : preset;
  const share = f.share;
  const setShare = (p: Partial<NonNullable<Subscription['share']>> | null) =>
    up({ share: p === null ? undefined : { role: 'owner', seats: 6, members: [], ...share, ...p } });
  const setMember = (i: number, p: Partial<ShareMember>) => setShare({ members: share!.members.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const perHead = share && share.seats > 0 ? Math.round((f.price / share.seats) * 100) / 100 : 0;
  // 已保存过的成员只显示摘要；刚在这里加的成员可以先填称呼
  const stored = state.subscriptions.find((x) => x.id === f.id);
  const savedMembers = new Map((stored?.share?.members ?? []).map((m) => [m.id, m]));
  // 单个成员的收费方式、周期、收款在成员弹窗里编辑，弹窗直接保存到账本
  const [editMember, setEditMember] = useState<ShareMember>();
  // 打开成员弹窗时表单里的合租设置是否已和账本不同；没改过就不动表单，保存时整体沿用账本里的新数据
  const shareEdited = useRef(false);
  const openMember = (m: ShareMember) => {
    shareEdited.current = JSON.stringify(share) !== JSON.stringify(stored?.share);
    setEditMember(m);
  };
  const closeMember = () => {
    setEditMember(undefined);
    // 这里改过合租设置时，表单里的成员换成刚保存的版本，免得点「完成」把弹窗里的修改覆盖回去
    const latest = getState()?.subscriptions.find((x) => x.id === f.id)?.share?.members;
    if (!latest || !share || !shareEdited.current) return;
    const byId = new Map(latest.map((m) => [m.id, m]));
    setShare({ members: share.members.filter((m) => !savedMembers.has(m.id) || byId.has(m.id)).map((m) => byId.get(m.id) ?? m) });
  };
  const val = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;
  const method = state.methods.find((m) => m.id === f.methodId);
  // 「更多选项」里有内容时默认展开，并在标题上列出已设置的项
  // 买断是一次性的：没有续费、状态、到期、提醒、优惠期这些概念，表单里不显示
  const lt = f.cycle.unit === 'lifetime';
  const extras = [
    f.intro && t('editor.more.intro'),
    f.bonus && t('editor.more.bonus'),
    f.remindDays != null && t('editor.more.remind'),
    (f.chargeLeadDays || f.cancelLeadDays) && t('core.renewal.title'),
    (f.url || f.manageUrl) && t('editor.more.links'),
    f.tags.length > 0 && t('editor.more.tags'),
    f.notes && t('editor.more.notes'),
  ].filter(Boolean) as string[];
  const [more, setMore] = useState(extras.length > 0);
  // 分类表的顺序；表单里的分类万一不在表里（刚被删掉），也留着它
  const catOptions = [...new Set([...categories().map((c) => c.name), f.category].filter(Boolean))];
  const [newCat, setNewCat] = useState(false);
  // 选中 App Store 结果后读它的内购套餐；读不到就不显示，金额照常手填
  const [plans, setPlans] = useState<{ currency: string; list: AppStorePlan[]; picked?: number }>();
  const plansSeq = useRef(0);
  const loadPlans = (h?: AppHit) => {
    const n = ++plansSeq.current;
    setPlans(undefined);
    if (!h?.id) return;
    api<{ currency?: string; plans: AppStorePlan[] }>(`/api/appstore/plans?id=${h.id}&country=${h.country ?? 'us'}`)
      .then((r) => {
        const list = r.plans.filter((p) => p.price);
        if (n === plansSeq.current && r.currency && list.length) setPlans({ currency: r.currency, list });
      })
      .catch(() => {
        /* 读不到套餐不影响手填 */
      });
  };

  return (
    <div className="ed">
      {/* 一、是什么：图标 + 名称（输入时联想 App Store）+ 分类 */}
      <div className="ed-id">
        {/* 有图标或网址时显示真实图标；否则是灰色占位（填了名称就显示首字母） */}
        {f.icon || f.url ? (
          <SubIcon sub={f} size={36} />
        ) : (
          <span className="ed-id-ph" aria-hidden="true">
            {[...f.name.trim()][0]?.toUpperCase()}
          </span>
        )}
        <div className="ed-id-main">
          <NameField
            value={f.name}
            region={(f.region || method?.region || 'us').toLowerCase()}
            onChange={(name) => {
              up({ name });
              if (plans) loadPlans();
            }}
            onPick={(h) => {
              loadPlans(h);
              up({
                // 「Spotify: Music and Podcasts」只取冒号、破折号前的产品名
                name: h.name.split(/\s*[:：|]\s*|\s[-–—]\s/)[0].trim(),
                icon: h.icon,
                ...(isNew && f.cancelLeadDays == null ? { cancelLeadDays: 1 } : {}),
                url: f.url || h.url,
                // 只有粘贴的链接里带了地区才填，按名称搜时不猜
                ...(h.fromLink && !f.region && h.country !== 'cn' ? { region: h.country!.toUpperCase() } : {}),
                // 分类按 App Store 的类别给个默认值，已经选过的不动
                ...(!f.name.trim() || f.category === presetCat('tools') ? { category: GENRE_CAT[h.genre] ? presetCat(GENRE_CAT[h.genre]) : f.category } : {}),
              });
            }}
            onPickCatalog={(c) => {
              loadPlans();
              up({
                name: c.name,
                icon: c.icon,
                url: f.url || c.url,
                category: c.category,
                ...(isNew ? { chargeLeadDays: f.chargeLeadDays ?? c.chargeLeadDays, cancelLeadDays: f.cancelLeadDays ?? c.cancelLeadDays } : {}),
              });
            }}
          />
        </div>
      </div>

      {/* 二、怎么付钱 */}
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
            <NumInput
              className="num"
              style={{ width: 60 }}
              inputMode="numeric"
              value={f.cycle.every}
              onValue={(n) => up({ cycle: { unit: f.cycle.unit === 'lifetime' ? 'month' : f.cycle.unit, every: Math.max(1, Math.round(n ?? 1)) } })}
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
        {!state.subscriptions.some((s) => s.id === f.id) && (
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

      {/* 三、现在的状态 */}
      {!lt && (
        <Group title={t('editor.group.status')}>
          <div className="cell">
            <Seg<EditorStatus>
              value={stop ? 'stop' : (f.status as EditorStatus)}
              disabledKeys={f.stop?.kind === 'terminate' || f.status === 'terminated' ? ['active', 'trial', 'paused'] : undefined}
              onChange={(v) => {
                if (v === 'stop') {
                  setStop(stopForm(syncPhase(f, today), today));
                } else {
                  const next = reactivate(f, today);
                  up({ ...next, status: v as SubStatus, pausedAt: v === 'paused' ? (f.pausedAt ?? today) : undefined });
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
              <DatePicker value={f.pausedAt ?? today} onChange={(v) => up({ pausedAt: v ?? today })} />
            </Cell>
          )}
          {stop && <StopFields sub={syncPhase(f, today)} today={today} value={stop} onChange={setStop} />}
        </Group>
      )}

      {/* 四、谁在用 */}
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
                ? up({ share: undefined, proxy: { forName: f.proxy?.forName ?? '', entries: f.proxy?.entries ?? [] } })
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
                  value={f.proxy.personId}
                  onPick={(p) =>
                    p
                      ? up({ proxy: { ...f.proxy!, personId: p.id, forName: p.name, contactVia: p.contactVia, contact: p.contact } })
                      : f.proxy!.personId && up({ proxy: { ...f.proxy!, personId: undefined, forName: '', contact: undefined } })
                  }
                />
              </Cell>
            )}
            <Cell label={t('editor.proxy.for')}>
              <input value={f.proxy.forName} placeholder={t('editor.proxy.forPlaceholder')} onChange={(e) => up({ proxy: { ...f.proxy!, forName: val(e) } })} />
            </Cell>
            <Cell label={t('editor.proxy.contact')}>
              <ContactField
                via={f.proxy.contactVia ?? 'Telegram'}
                value={f.proxy.contact}
                onVia={(v) => up({ proxy: { ...f.proxy!, contactVia: v } })}
                onChange={(c) => up({ proxy: { ...f.proxy!, contactVia: f.proxy!.contactVia ?? 'Telegram', contact: c || undefined } })}
              />
            </Cell>
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
        {share?.role === 'owner' && (
          <>
            <Cell label={t('editor.share.seats')}>
              <input className="num" inputMode="numeric" value={share.seats} onChange={(e) => setShare({ seats: Math.max(1, Number(val(e)) || 1) })} />
            </Cell>
            {/* 这里只管名单：已有成员只显示摘要，收费方式、成员账号、收款在合租详情里维护 */}
            {share.members.map((m0, i) => {
              // 摘要按账本里最新保存的成员与订阅算，成员弹窗保存后立即更新
              const m = savedMembers.get(m0.id) ?? m0;
              const saved = savedMembers.has(m0.id);
              const due = saved && stored && !m.exempt ? memberCollection(stored, m, memberUnpaidFrom(stored, m)).from : undefined;
              const late = due && due < today ? diffDays(due, today) : 0;
              return (
                <div key={m.id} className="member-edit member-summary">
                  {saved ? (
                    <button type="button" className="member-summary-name tap" onClick={() => openMember(m)}>
                      <b className="text-ellipsis">{m.name || t('editor.share.memberN', { n: i + 1 })}</b>
                      <small className="muted">
                        {m.exempt ? t('family.pool.exempt') : followsCar(state, stored!, m, today) ? t('editor.share.follows') : t('editor.share.custom')}
                        {late > 0 && (
                          <span className="member-late">
                            {' '}
                            <span className="copy-gap" aria-hidden="true" /> {t('editor.share.overdue', { count: late })}
                          </span>
                        )}
                        {due && (
                          <>
                            {copyParts('\n')}
                            <span className="nowrap">{t(late > 0 ? 'editor.share.dueOn' : 'editor.share.nextDue', { date: cnDateFull(due) })}</span>
                          </>
                        )}
                      </small>
                    </button>
                  ) : (
                    <input value={m.name} placeholder={t('editor.share.memberN', { n: i + 1 })} onChange={(e) => setMember(i, { name: val(e) })} />
                  )}
                  <RowActions
                    onEdit={saved ? () => openMember(m) : undefined}
                    editLabel={t('editor.share.editMember')}
                    removeLabel={t('editor.share.remove')}
                    confirmLabel={t('editor.share.confirmRemove')}
                    onRemove={() => setShare({ members: share.members.filter((x) => x.id !== m0.id) })}
                  />
                </div>
              );
            })}
            {share.members.length < share.seats - 1 && (
              <button
                className="cell tap"
                style={{ color: 'var(--accent)' }}
                onClick={() => {
                  // 新成员按车的收款规则收费
                  const r = carRule(state, f, today);
                  setShare({
                    members: [
                      ...share.members,
                      {
                        id: uid(),
                        name: '',
                        share: shareFromFee(state, f, r.fee, r.currency, r.billEvery),
                        fee: r.fee,
                        feeCurrency: r.currency,
                        billEvery: r.billEvery,
                        joined: today,
                      },
                    ],
                  });
                }}
              >
                <Icon name="plus" /> {t('editor.share.addMember')}
              </button>
            )}
            {editMember && stored && createPortal(<MemberSheet state={state} s={stored} member={editMember} onClose={closeMember} />, document.body)}
          </>
        )}
      </Group>

      {/* 五、不常用的：折叠起来，标题上列出已设置的项 */}
      <button type="button" className={`ed-more ${more ? 'open' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}>
        <span>{t('editor.more.title')}</span>
        <small>{copyParts(extras.length ? extras.join('\n') : t(lt ? 'editor.more.summaryLt' : 'editor.more.summary'))}</small>
        <Icon name="down" size={14} />
      </button>
      {more && (
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
                {(['chargeLeadDays', 'cancelLeadDays'] as const).map((field) => (
                  <Cell key={field} label={t(`core.renewal.${field}`)}>
                    <DaysStepper label={t(`core.renewal.${field}`)} value={f[field] ?? 0} onChange={(n) => up({ [field]: n })} />
                  </Cell>
                ))}
              </Group>
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
                      { value: '', label: t('editor.remind.default', { count: state.settings.remindDays }) },
                      { value: '0', label: t('editor.remind.sameDay') },
                      ...[1, 2, 3, 5, 7, 14, 30].map((n) => ({ value: String(n), label: t('editor.remind.before', { count: n }) })),
                      { value: '-1', label: t('editor.remind.never') },
                    ]}
                    ariaLabel={t('editor.more.remind')}
                  />
                </Cell>
              </Group>
            </>
          )}
          <Group title={t('editor.group.links')}>
            <Cell label={t('editor.field.url')}>
              <input value={f.url ?? ''} placeholder="https://" onChange={(e) => up({ url: val(e) || undefined })} />
            </Cell>
            <Cell label={t('editor.field.manageUrl')}>
              <input value={f.manageUrl ?? ''} placeholder={t('editor.field.optional')} onChange={(e) => up({ manageUrl: val(e) || undefined })} />
            </Cell>
            <Cell label={t('editor.field.icon')}>
              <input value={f.icon ?? ''} placeholder={t('editor.field.auto')} onChange={(e) => up({ icon: val(e) || undefined })} />
            </Cell>
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
      )}
      {newCat && <CategorySheet state={state} onClose={() => setNewCat(false)} onSaved={(name) => up({ category: name })} />}
    </div>
  );
}

interface AppHit {
  /** App Store 数字 ID，用来读内购套餐 */
  id?: string;
  name: string;
  icon: string;
  url: string;
  seller: string;
  genre: string;
  /** 搜索用的商店地区，如 tr */
  country?: string;
  /** 地区是从粘贴的链接里读出来的 */
  fromLink?: boolean;
}

/** App Store 类别 → 账本分类（内置分类代码） */
const GENRE_CAT: Record<string, string> = {
  Music: 'music',
  Entertainment: 'media',
  'Photo & Video': 'media',
  Productivity: 'productivity',
  Utilities: 'tools',
  'Developer Tools': 'developer',
  'Graphics & Design': 'design',
  Business: 'productivity',
  'Social Networking': 'social',
  Games: 'games',
  Education: 'education',
  Shopping: 'shopping',
  Lifestyle: 'daily',
  Finance: 'finance',
  'Health & Fitness': 'health',
  Medical: 'health',
  Books: 'news',
  'Magazines & Newspapers': 'news',
  News: 'news',
  Reference: 'education',
};

/**
 * 名称输入：边输入边联想 App Store 里的 App（按订阅地区的商店搜），选中带出名称、图标和链接。
 * 也可以直接粘贴 App Store 链接，地区从链接里读（apps.apple.com/tr/app/…），不用另外选。
 */
function NameField({
  value,
  region,
  onChange: onInput,
  onPick,
  onPickCatalog,
}: {
  value: string;
  region: string;
  onChange: (v: string) => void;
  onPick: (h: AppHit) => void;
  onPickCatalog: (c: CatalogItem) => void;
}) {
  const [hits, setHits] = useState<AppHit[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const timer = useRef(0);
  const seq = useRef(0);
  // 常用服务（本地目录）马上出；App Store 的结果随后补在下面
  const local = /apps\.apple\.com\//i.test(value) ? [] : searchCatalog(value);
  const all: Array<{ c?: CatalogItem; h?: AppHit }> = [...local.map((c) => ({ c })), ...hits.map((h) => ({ h }))];
  const search = (q: string) => {
    window.clearTimeout(timer.current);
    const term = q.trim();
    setHi(0);
    setOpen(true);
    if (term.length < 2) return setHits([]);
    const fromLink = term.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1]?.toLowerCase();
    const country = fromLink ?? region;
    timer.current = window.setTimeout(async () => {
      const n = ++seq.current;
      try {
        const r = await api<{ results: AppHit[] }>(`/api/appstore/search?q=${encodeURIComponent(term)}&country=${country}`);
        if (n === seq.current) setHits(r.results.slice(0, 5).map((h) => ({ ...h, country, fromLink: !!fromLink })));
      } catch {
        /* 联想失败不影响手动输入 */
      }
    }, 350);
  };
  const pick = (x: { c?: CatalogItem; h?: AppHit }) => {
    if (x.c) onPickCatalog(x.c);
    else onPick(x.h!);
    setOpen(false);
    setHits([]);
  };
  return (
    <div className="ed-name">
      <input
        value={value}
        autoFocus={!value}
        placeholder={t('editor.name.placeholder')}
        onChange={(e) => {
          const v = (e.target as HTMLInputElement).value;
          onInput(v);
          search(v);
        }}
        onFocus={() => all.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !all.length) return;
          if (e.key === 'ArrowDown') setHi((i) => Math.min(all.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setHi((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter') pick(all[hi]);
          else if (e.key === 'Escape') setOpen(false);
          else return;
          // 只关联想框，不让 Esc 冒泡去关整个编辑器
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {open && all.length > 0 && (
        <div className="ed-suggest" role="listbox">
          {all.map((x, i) => (
            <div key={x.c ? `c-${x.c.name}` : `h-${x.h!.url}`}>
              {i === 0 && x.c && <div className="ed-suggest-h">{copyParts(t('editor.name.catalog'))}</div>}
              {x.h && (i === 0 || all[i - 1].c) && (
                <div className="ed-suggest-h">
                  App Store <span className="copy-gap" aria-hidden="true" /> <img className="pk-flag" src={base(`/flags/${x.h.country}.png`)} alt="" />
                </div>
              )}
              <button
                type="button"
                className={`hit ${i === hi ? 'hi' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setHi(i)}
                onClick={() => pick(x)}
              >
                {x.c ? (
                  <span className="ed-cat-ico">
                    <img src={base(x.c.icon)} alt="" />
                  </span>
                ) : (
                  <SubIcon sub={{ name: x.h!.name, icon: x.h!.icon, category: '' }} size={32} />
                )}
                <span style={{ minWidth: 0 }}>
                  <b>{x.c ? x.c.name : x.h!.name}</b>
                  <small>{copyParts(x.c ? `${x.c.category}\n${x.c.url.replace(/^https?:\/\//, '')}` : `${x.h!.seller}\n${x.h!.genre}`)}</small>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 天数步进器：0–3660 的整数，可直接输入，也可用两侧按钮加减；0 显示为「不需要」以外的数字 0 */
function DaysStepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(3660, Math.max(0, Math.round(n)));
  const commit = (raw: string) => {
    setDraft(null);
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(clamp(n));
  };
  return (
    <span className="days-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="−1" disabled={value <= 0} onClick={() => onChange(clamp(value - 1))}>
        <Minus size={14} />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={draft ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value.replace(/\D/g, '').slice(0, 4);
          setDraft(raw);
          if (raw) onChange(clamp(Number(raw)));
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1)));
            setDraft(null);
          }
        }}
      />
      <span className="days-unit">{t('editor.unit.day', { count: value })}</span>
      <button type="button" aria-label="+1" disabled={value >= 3660} onClick={() => onChange(clamp(value + 1))}>
        <Plus size={14} />
      </button>
    </span>
  );
}

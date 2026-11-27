import { useRef, useState, type ReactNode } from 'react';
import { editorMoreKeys, editorMoreOpen } from './more.ts';
import { effectiveLinkedChildren, parentHasAnyChild, type LinkedChildView, type LinkedPlan } from './linked.ts';

import { currencyDecimals } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Cycle, Subscription } from '../../../../shared/types.ts';

import { categories, isDomainCat, presetCat } from '../../derive.ts';

import { type StopForm } from '../../../../shared/stop-form.ts';

import { CYCLES as RENEW_CYCLES } from '../../components/ChangePanel.tsx';

import { api } from '../../store.ts';

import type { AppStorePlan } from '../../../../shared/appstore-plans.ts';

import type { AppHit } from './NameField.tsx';

export const CYCLES: Array<[string, Cycle]> = [...RENEW_CYCLES, ['lt', { unit: 'lifetime', every: 1 }]];
export type EditorStatus = 'active' | 'trial' | 'paused' | 'stop';
export const STATUS: EditorStatus[] = ['trial', 'active', 'paused', 'stop'];
export function useEditorFields({
  isNew,
  stop,
  setStop,
  f,
  setF,
  up,
  linked,
  setLinked,
  state,
  today,
  history,
}: {
  isNew: boolean;
  stop?: StopForm;
  setStop: (value: StopForm | undefined) => void;
  f: Subscription;
  setF: (s: Subscription) => void;
  up: (p: Partial<Subscription>) => void;
  linked: LinkedPlan;
  setLinked: (value: LinkedPlan | ((prev: LinkedPlan) => LinkedPlan)) => void;
  state: AppState;
  today: string;
  history?: ReactNode;
}) {
  // 代付对象已关联名册里的人：称呼、联系方式只读，改资料去人员详情
  const proxyLinked = !!f.proxy?.personId && !!state.people?.some((p) => p.id === f.proxy!.personId);
  const [proxyProfile, setProxyProfile] = useState(false);
  const phoneCat = f.category === presetCat('phone');
  const preset = CYCLES.find(([, c]) => c.unit === f.cycle.unit && c.every === f.cycle.every)?.[0];
  // 选了「自定义」就一直停在自定义，填到恰好等于某个预设（如每 1 个月）时也不跳回去
  const [custom, setCustom] = useState(!preset);
  const cycleKey = custom || !preset ? 'custom' : preset;
  const share = f.share;
  const setShare = (p: Partial<NonNullable<Subscription['share']>> | null) =>
    up({ share: p === null ? undefined : { role: 'owner', seats: 6, members: [], ...share, ...p } });
  const unit = 10 ** currencyDecimals(f.currency);
  const perHead = share && share.seats > 0 ? Math.round((f.price / share.seats) * unit) / unit : 0;
  const val = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;
  const method = state.methods.find((m) => m.id === f.methodId);
  // 「更多选项」里有内容时默认展开，并在标题上列出已设置的项
  // 买断是一次性的：没有续费、状态、到期、提醒、优惠期这些概念，表单里不显示
  const lt = f.cycle.unit === 'lifetime';
  const linkedItems = effectiveLinkedChildren(f, state.subscriptions, today, linked);
  const hasChildren = parentHasAnyChild(f.id, isNew, state.subscriptions, linked);
  const extras = editorMoreKeys(f, isDomainCat(f.category), linkedItems.length > 0).map((key) => t(key));
  const [transfer, setTransfer] = useState<{ index?: number } | null>(null);
  const [bundleSheet, setBundleSheet] = useState<{ edit?: LinkedChildView } | null>(null);
  // 不保存展开偏好；每次打开（包括恢复/清空表单）都按实际内容决定。
  const [more, setMore] = useState(() => editorMoreOpen(f, isNew, isDomainCat(f.category), linkedItems.length > 0));
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

  return {
    isNew,
    stop,
    setStop,
    f,
    setF,
    up,
    state,
    today,
    history,
    proxyLinked,
    proxyProfile,
    setProxyProfile,
    phoneCat,
    preset,
    custom,
    setCustom,
    cycleKey,
    share,
    setShare,
    unit,
    perHead,
    val,
    method,
    lt,
    extras,
    linked,
    setLinked,
    linkedItems,
    hasChildren,
    bundleSheet,
    setBundleSheet,
    transfer,
    setTransfer,
    more,
    setMore,
    catOptions,
    newCat,
    setNewCat,
    plans,
    setPlans,
    plansSeq,
    loadPlans,
  };
}

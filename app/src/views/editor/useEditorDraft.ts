import { useState } from 'react';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { contractFits, migrateRenewalRules } from '../../../../shared/billing.ts';
import { toEditForm } from '../../../../shared/phases.ts';
import { stopForm, type StopForm } from '../../../../shared/stop-form.ts';
import { newSub } from './new-sub.ts';
import { draftKey, sig, readDraft, writeDraft } from './draft.ts';
import { EMPTY_LINKED, hasLinkedChanges, type LinkedPlan } from './linked.ts';

export function useEditorDraft({ sub, state, today, onClose }: { sub: Subscription; state: AppState; today: string; onClose: () => void }) {
  const [isNew] = useState(() => !state.subscriptions.some((s) => s.id === sub.id));
  const key = draftKey(isNew, sub.id);
  // 有多个阶段时，表单显示今天所在的阶段
  const [initialForm] = useState(() => toEditForm(migrateRenewalRules(structuredClone(sub)), today));
  const [initial] = useState(() => sig(initialForm));
  // 新建的草稿不看 base（每次新建 id 都不同）；预填关联主订阅时不套无关的旧新建草稿；编辑的要求订阅没被别处改过
  const [draft] = useState(() => {
    const saved = readDraft(key, isNew ? 'new' : initial);
    if (isNew && initialForm.bundle?.parentId && saved?.form.bundle?.parentId !== initialForm.bundle.parentId) return undefined;
    return saved;
  });
  const [restored, setRestored] = useState(!!draft);
  const [priceValid, setPriceValid] = useState(true);
  const [historyReset, setHistoryReset] = useState(0);
  const [f, setFRaw] = useState<Subscription>(() => draft?.form ?? initialForm);
  const [stop, setStop] = useState<StopForm | undefined>(
    () => draft?.stop ?? (f.stop || f.end || ['cancelled', 'terminated'].includes(f.status) ? stopForm(f, today, state) : undefined),
  );
  const [linked, setLinked] = useState<LinkedPlan>(() => draft?.linked ?? EMPTY_LINKED);
  // 历程操作会改写价格；记录操作后的价格，用来判断表单里的价格是否又被手动改过
  const [basePrice, setBasePrice] = useState(draft?.basePrice ?? initialForm.price);
  const setF = (next: Subscription) => {
    const form = toEditForm(next, today);
    setFRaw(form);
    setBasePrice(form.price);
    // Existing history actions can resume or change an end date; keep the status draft aligned.
    if (form.end !== f.end || form.status !== f.status || JSON.stringify(form.stop) !== JSON.stringify(f.stop)) {
      setStop(form.stop || form.end || ['cancelled', 'terminated'].includes(form.status) ? stopForm(form, today, state) : undefined);
    }
  };
  // 改周期（如改成买断）后合同期不再成立时一并清掉，否则字段被隐藏却拦住保存
  const up = (patch: Partial<Subscription> | ((prev: Subscription) => Partial<Subscription>)) =>
    setFRaw((x) => {
      const p = typeof patch === 'function' ? patch(x) : patch;
      const next = { ...x, ...p };
      return p.cycle && !('contract' in p) && next.contract && !contractFits(next.contract.term, p.cycle) ? { ...next, contract: undefined } : next;
    });
  const dirty =
    sig(f) !== initial ||
    !priceValid ||
    hasLinkedChanges(linked) ||
    !!stop !== !!(initialForm.stop || initialForm.end || ['cancelled', 'terminated'].includes(initialForm.status)) ||
    (!!stop && JSON.stringify(stop) !== JSON.stringify(stopForm(initialForm, today, state)));
  // 关闭即存草稿；没改动就清掉
  const close = () => {
    writeDraft(key, dirty ? { form: f, basePrice, stop, ...(hasLinkedChanges(linked) ? { linked } : {}), base: isNew ? 'new' : initial } : undefined);
    onClose();
  };
  /** 新建：清空成一张新表（从主订阅入口新建时保留预填的主订阅关联）；编辑：回到保存过的样子 */
  const reset = () => {
    writeDraft(key, undefined);
    setRestored(false);
    setPriceValid(true);
    setHistoryReset((n) => n + 1);
    setLinked(EMPTY_LINKED);
    const fresh =
      isNew && !initialForm.bundle?.parentId ? toEditForm(newSub(today, state.settings.defaultMethodId, state.settings.baseCurrency), today) : initialForm;
    setFRaw(fresh);
    setBasePrice(fresh.price);
    setStop(fresh.stop || fresh.end || ['cancelled', 'terminated'].includes(fresh.status) ? stopForm(fresh, today, state) : undefined);
  };

  return {
    isNew,
    key,
    initialForm,
    initial,
    draft,
    restored,
    setRestored,
    priceValid,
    setPriceValid,
    historyReset,
    setHistoryReset,
    f,
    setF,
    up,
    stop,
    setStop,
    linked,
    setLinked,
    basePrice,
    dirty,
    close,
    reset,
  };
}

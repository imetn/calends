import type { Subscription } from '../../../../shared/types.ts';
import { preserveRenewalHistory } from '../../../../shared/billing.ts';
import { changePrice, syncPhase } from '../../../../shared/phases.ts';
import { applyStopForm, type StopForm } from '../../../../shared/stop-form.ts';
import { mergeEdits } from '../../../../shared/ledger-edit.ts';
export function prepareEditorSave(
  sub: Subscription,
  f: Subscription,
  today: string,
  isNew: boolean,
  basePrice: number,
  stop?: StopForm,
  subs?: readonly Subscription[],
): Subscription {
  let out: Subscription = { ...f, name: f.name.trim(), account: f.account?.trim() || undefined };
  if (!isNew) out = preserveRenewalHistory(sub, out, today);
  if (!isNew && basePrice !== out.price) out = changePrice(syncPhase({ ...out, price: basePrice }, today), today, out.price);
  else out = syncPhase(out, today);
  if (stop && out.cycle.unit !== 'lifetime') out = applyStopForm(out, stop, today, subs);
  return out;
}

export function mergeEditorSave(sub: Subscription, out: Subscription, latest: Subscription | undefined, isNew: boolean): Subscription {
  let final = isNew ? out : mergeEdits(sub, out, latest);
  // 合租：编辑器只管身份和付给谁；席位、收费标准、成员与收款都在合租详情里改，以账本里最新的为准
  if (!isNew && out.share && latest?.share && JSON.stringify(sub.share) !== JSON.stringify(out.share)) {
    final = { ...final, share: { ...latest.share, role: out.share.role, ownerName: out.share.ownerName } };
  }

  return final;
}

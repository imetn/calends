import type { Subscription } from '../../../../shared/types.ts';
import { preserveRenewalHistory } from '../../../../shared/billing.ts';
import { changePrice, syncPhase } from '../../../../shared/phases.ts';
import { applyStopForm, type StopForm } from '../../../../shared/stop-form.ts';
import { mergeEdits } from '../../../../shared/ledger-edit.ts';
export function prepareEditorSave(sub: Subscription, f: Subscription, today: string, isNew: boolean, basePrice: number, stop?: StopForm): Subscription {
  let out: Subscription = { ...f, name: f.name.trim(), account: f.account?.trim() || undefined };
  if (!isNew) out = preserveRenewalHistory(sub, out, today);
  if (!isNew && basePrice !== out.price) out = changePrice(syncPhase({ ...out, price: basePrice }, today), today, out.price);
  else out = syncPhase(out, today);
  if (stop && out.cycle.unit !== 'lifetime') out = applyStopForm(out, stop, today);
  return out;
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/**
 * 三方同字段冲突：本地与 latest 相对草稿依据 base 都改了同一字段且结果不同。
 * 合租只看编辑器管的身份字段（其余以 latest 为准，见下）；updatedAt 是版本本身，不算字段。
 */
export function editConflicts(base: Subscription, local: Subscription, latest: Subscription): string[] {
  const pick = (s: Subscription) => ({ ...s, updatedAt: undefined, share: s.share && { role: s.share.role, ownerName: s.share.ownerName } });
  const [b, l, r] = [pick(base), pick(local), pick(latest)] as Array<Record<string, unknown>>;
  return [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].filter((k) => !same(b[k], l[k]) && !same(b[k], r[k]) && !same(l[k], r[k]));
}

/**
 * 编辑器保存：与 latest 三方合并。无冲突时采用 latest 的版本（合并已明确完成）；
 * 有同字段冲突时保持草稿打开时冻结的版本作 If-Match，由服务器 409 并提示「数据已在别处更新」，不拿旧输入盖掉别处的改动。
 */
export function mergeEditorSave(sub: Subscription, out: Subscription, latest: Subscription | undefined, isNew: boolean): Subscription {
  let final = isNew ? out : mergeEdits(sub, out, latest);
  if (!isNew && latest && editConflicts(sub, out, latest).length) final = { ...final, updatedAt: sub.updatedAt };
  // 合租：编辑器只管身份和付给谁；席位、收费标准、成员与收款都在合租详情里改，以账本里最新的为准
  if (!isNew && out.share && latest?.share && JSON.stringify(sub.share) !== JSON.stringify(out.share)) {
    final = { ...final, share: { ...latest.share, role: out.share.role, ownerName: out.share.ownerName } };
  }

  return final;
}

// 编辑主订阅时对「包含的关联订阅」做的待保存变更：新建附赠/加购、挂上已有独立订阅、改周期模式、解除关联。
// 所有修改先暂存在编辑器草稿里，点「完成」时随主订阅一并落库。
import { currentPhase } from '../../../../shared/billing.ts';
import { allChildrenOf, bundleHistoryError, childrenOf, hasAnyBundleLink, isFreeBundlePhase } from '../../../../shared/bundle.ts';
import { syncPhase, toEditForm } from '../../../../shared/phases.ts';
import type { Cycle, Subscription } from '../../../../shared/types.ts';

export interface LinkedNewChild {
  kind: 'new';
  id: string;
  name: string;
  icon?: string;
  url?: string;
  category: string;
  price: number;
  currency: string;
  cycle: Cycle;
  start: string;
  follow: boolean;
}

export interface LinkedExistingChild {
  kind: 'existing';
  subId: string;
  follow: boolean;
}

export type LinkedChildChange = LinkedNewChild | LinkedExistingChild;

export interface LinkedPlan {
  upsert: LinkedChildChange[];
  unlink: string[];
}

export const EMPTY_LINKED: LinkedPlan = { upsert: [], unlink: [] };

export const hasLinkedChanges = (p: LinkedPlan): boolean => p.upsert.length > 0 || p.unlink.length > 0;

/** 表单里展示的一条关联子订阅（已有记录或本次新建草稿） */
export interface LinkedChildView {
  key: string;
  kind: 'saved' | 'existing' | 'new';
  id: string;
  name: string;
  sub: Subscription;
  follow: boolean;
  free: boolean;
  price: number;
  currency: string;
  cycle: Cycle;
  upcoming: boolean;
  draft?: LinkedNewChild;
}

/** 构造本次新建的附属订阅完整记录 */
export function buildLinkedChildSub(item: LinkedNewChild, parent: Subscription, today: string): Subscription {
  const pc = currentPhase(parent, today);
  const free = !(item.price > 0);
  return {
    id: item.id,
    name: item.name.trim(),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.url ? { url: item.url } : {}),
    category: item.category,
    tags: [],
    price: item.price,
    currency: item.currency,
    cycle: item.follow && free ? { ...pc.cycle } : { ...item.cycle },
    start: item.start,
    status: 'active',
    ...(!free && pc.methodId ? { methodId: pc.methodId } : {}),
    bundle: { parentId: parent.id, ...(item.follow ? {} : { follow: false }) },
  };
}

/** 把已有独立订阅的当前阶段挂到 parentId（或调整跟随模式），保留历史阶段 */
export function applyChildLink(child: Subscription, parentId: string, follow: boolean, today: string): Subscription {
  const form = toEditForm(structuredClone(child), today);
  form.bundle = { parentId, ...(follow ? {} : { follow: false }) };
  return syncPhase(form, today);
}

/** 解除已有子订阅与 parentId 在当前及未来计划阶段的关联，保留历史阶段记录 */
export function unlinkChildSub(child: Subscription, parentId: string, today: string): Subscription {
  if (!child.phases?.length) return child.bundle?.parentId === parentId ? { ...child, bundle: undefined } : child;
  const form = toEditForm(structuredClone(child), today);
  let next = form.bundle?.parentId === parentId ? syncPhase({ ...form, bundle: undefined }, today) : structuredClone(child);
  if (next.phases?.length) {
    const phases = next.phases.map((p) => (p.start > today && p.bundle?.parentId === parentId ? (({ bundle: _b, ...rest }) => rest)(p) : p));
    next = { ...next, phases };
    if (next.bundle?.parentId === parentId) next = { ...next, bundle: undefined };
  }
  return next;
}

/** 合并账本里已有的关联子订阅与本次草稿变更，得到表单里当前要展示的列表 */
export function effectiveLinkedChildren(parent: Subscription, subs: readonly Subscription[], today: string, linked: LinkedPlan): LinkedChildView[] {
  const out: LinkedChildView[] = [];
  const saved = childrenOf(parent.id, subs, today);
  const existingOverrides = new Map<string, LinkedExistingChild>();
  for (const item of linked.upsert) if (item.kind === 'existing') existingOverrides.set(item.subId, item);

  const seen = new Set<string>();
  for (const { sub, link, phase, upcoming } of saved) {
    if (linked.unlink.includes(sub.id)) continue;
    seen.add(sub.id);
    const ov = existingOverrides.get(sub.id);
    const follow = ov ? ov.follow : link.follow !== false;
    out.push({
      key: sub.id,
      kind: 'saved',
      id: sub.id,
      name: sub.name,
      sub,
      follow,
      free: isFreeBundlePhase(phase),
      price: phase.price,
      currency: phase.currency,
      cycle: phase.cycle,
      upcoming,
    });
  }

  for (const item of linked.upsert) {
    if (item.kind === 'existing') {
      if (seen.has(item.subId)) continue;
      const sub = subs.find((s) => s.id === item.subId);
      if (!sub) continue;
      const cur = currentPhase(sub, today);
      out.push({
        key: sub.id,
        kind: 'existing',
        id: sub.id,
        name: sub.name,
        sub,
        follow: item.follow,
        free: !(cur.price > 0) && !(cur.intro && cur.intro.price > 0) && !cur.priceHistory?.some((p) => p.amount > 0),
        price: cur.price,
        currency: cur.currency,
        cycle: cur.cycle,
        upcoming: cur.start > today,
      });
    } else {
      const preview = buildLinkedChildSub(item, parent, today);
      out.push({
        key: item.id,
        kind: 'new',
        id: item.id,
        name: item.name,
        sub: preview,
        follow: item.follow,
        free: !(item.price > 0),
        price: item.price,
        currency: item.currency,
        cycle: preview.cycle,
        upcoming: item.start > today,
        draft: item,
      });
    }
  }
  return out;
}

/** 哪些已有独立订阅可以新挂到 parentId 名下（排除自身、代付、已有关联或本身已是主订阅的，以及已在列表里的） */
export function linkableExistingChildren(parentId: string, subs: readonly Subscription[], today: string, linked: LinkedPlan): Subscription[] {
  const active = new Set(effectiveLinkedChildren({ id: parentId } as Subscription, subs, today, linked).map((x) => x.id));
  return subs.filter((s) => {
    if (s.id === parentId || s.proxy || active.has(s.id)) return false;
    if (allChildrenOf(s.id, subs).length > 0) return false;
    // 若刚才在本次编辑里把它从当前主订阅解绑了，仍允许重新挂回来
    if (hasAnyBundleLink(s) && !linked.unlink.includes(s.id)) return false;
    return true;
  });
}

/** 预检把已有订阅挂到 parent（或切换跟随模式）是否会回溯改写历史扣款或服务期 */
export function validateExistingChildLink(
  child: Subscription,
  parent: Subscription,
  follow: boolean,
  subs: readonly Subscription[],
  today: string,
): string | undefined {
  const updated = applyChildLink(child, parent.id, follow, today);
  const withParent = subs.some((s) => s.id === parent.id) ? subs.map((s) => (s.id === parent.id ? parent : s)) : [...subs, parent];
  const after = withParent.map((s) => (s.id === child.id ? updated : s));
  return bundleHistoryError(child, updated, subs, after, today);
}

/** 判断该主订阅当前（含草稿与历史阶段）是否仍有任意关联子订阅，用于禁用代付及反向选主订阅 */
export function parentHasAnyChild(parentId: string, isNew: boolean, subs: readonly Subscription[], linked: LinkedPlan): boolean {
  if (linked.upsert.length > 0) return true;
  if (isNew) return false;
  return allChildrenOf(parentId, subs).some((c) => !linked.unlink.includes(c.id));
}

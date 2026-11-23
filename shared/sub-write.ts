// 整条订阅写入（网页端 PUT /api/subscriptions/:id 与 MCP save_subscription 共用）：同一套归一化与校验
import { migrateLegacyRefunds, reconcileRenewalRules, subError, trackOf, trackingStart } from './billing.ts';
import { updateMemberLeave } from './carpool.ts';
import { t } from './i18n.ts';
import { subRefsError } from './ledger-edit.ts';
import { bundleHistoryError, bundleLinkError, bundleLinksOf } from './bundle.ts';
import { meterLinkError } from './meters.ts';
import { closePause, statusChangeError } from './phases.ts';
import type { AppState, Subscription } from './types.ts';

export function validSub(s: Subscription, subs?: readonly Subscription[]): string | undefined {
  if (!s || typeof s.id !== 'string' || !s.id) return t('server.missingId');
  return subError(s, subs);
}

/**
 * 改主订阅不能让关联它的子订阅变得无效（如补录暂停后子订阅已指定抵扣的账期消失）：子订阅改前有效、改后无效时拒绝，
 * 免得子订阅之后连改备注都保存不了。
 */
export function bundleChildrenError(parentId: string, before: readonly Subscription[], after: readonly Subscription[]): string | undefined {
  for (const c of after) {
    // 独立计费的关联不读主订阅可用期，主订阅怎么改都不影响它
    if (c.id === parentId || !bundleLinksOf(c).some((x) => x.link.parentId === parentId && x.link.follow !== false)) continue;
    if (validSub(before.find((x) => x.id === c.id) ?? c, before)) continue;
    const error = validSub(c, after);
    if (error) return t('server.invalidItem', { name: c.name, error });
  }
  return undefined;
}

/**
 * 以 previous（库里现有记录，新建时为空）为基准准备一条完整替换的订阅：
 * 暂停结束时记下暂停区间；续费规则改动按生效日记入历史；成员的退出日被清掉时一并清掉退款；最后做完整校验、引用校验（支付方式、币种，见 subRefsError）、状态迁移约束、指标关联校验（meterLinkError）、订阅关联校验（bundleLinkError）、关联不抹掉已发生扣款的校验（bundleHistoryError）和不让关联的子订阅失效的校验。
 */
export function prepareSubWrite(
  previous: Subscription | undefined,
  next: Subscription,
  today: string,
  refs: Pick<AppState, 'fx' | 'methods' | 'subscriptions'>,
): { sub: Subscription; error?: undefined } | { error: string } {
  let sub = reconcileRenewalRules(previous, closePause(previous, migrateLegacyRefunds(next), today), today);
  if (sub.tags == null) sub = { ...sub, tags: [] };
  // 分开记的追踪起点在写入时定下来存好，之后不随今天移动（网页、MCP 新建与整条保存都经过这里）
  // 已是分开记的旧记录存下读取时正在用的起点，保存不改变欠多少；新建或刚打开时按今天推
  if (sub.settlement === 'separate' && !sub.settledBefore)
    sub = { ...sub, settledBefore: previous?.settlement === 'separate' ? trackOf(previous) : trackingStart(sub, today) };
  // Clearing an existing exit also clears its settlement. New orphan refunds fail validation.
  if (sub.share)
    sub = {
      ...sub,
      share: {
        ...sub.share,
        members: sub.share.members.map((m) => (previous?.share?.members.some((old) => old.id === m.id && old.left) && !m.left ? updateMemberLeave(m, {}) : m)),
      },
    };
  const after = [...refs.subscriptions.filter((x) => x.id !== sub.id), sub];
  const error =
    validSub(sub, after) ??
    subRefsError(refs, previous, sub) ??
    statusChangeError(previous, sub, today, after) ??
    meterLinkError(refs.subscriptions, after) ??
    bundleLinkError(refs.subscriptions, after) ??
    bundleHistoryError(previous, sub, refs.subscriptions, after, today) ??
    bundleChildrenError(sub.id, refs.subscriptions, after);
  return error ? { error } : { sub };
}

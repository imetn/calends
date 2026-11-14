// 整条订阅写入（网页端 PUT /api/subscriptions/:id 与 MCP save_subscription 共用）：同一套归一化与校验
import { reconcileRenewalRules, subError, trackingStart } from './billing.ts';
import { updateMemberLeave } from './carpool.ts';
import { t } from './i18n.ts';
import { subRefsError } from './ledger-edit.ts';
import { meterLinkError } from './meters.ts';
import { closePause, statusChangeError } from './phases.ts';
import type { AppState, Subscription } from './types.ts';

export function validSub(s: Subscription): string | undefined {
  if (!s || typeof s.id !== 'string' || !s.id) return t('server.missingId');
  return subError(s);
}

/**
 * 以 previous（库里现有记录，新建时为空）为基准准备一条完整替换的订阅：
 * 暂停结束时记下暂停区间；续费规则改动按生效日记入历史；成员的退出日被清掉时一并清掉退款；最后做完整校验、引用校验（支付方式、币种，见 subRefsError）、状态迁移约束和指标关联校验（meterLinkError，看整个账本）。
 */
export function prepareSubWrite(
  previous: Subscription | undefined,
  next: Subscription,
  today: string,
  refs: Pick<AppState, 'fx' | 'methods' | 'subscriptions'>,
): { sub: Subscription; error?: undefined } | { error: string } {
  let sub = reconcileRenewalRules(previous, closePause(previous, next, today), today);
  if (sub.tags == null) sub = { ...sub, tags: [] };
  // 分开记的追踪起点在写入时定下来存好，之后不随今天移动（网页、MCP 新建与整条保存都经过这里）
  if (sub.settlement === 'separate' && !sub.settledBefore) sub = { ...sub, settledBefore: trackingStart(sub, today) };
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
  const error = validSub(sub) ?? subRefsError(refs, previous, sub) ?? statusChangeError(previous, sub, today) ?? meterLinkError(refs.subscriptions, after);
  return error ? { error } : { sub };
}

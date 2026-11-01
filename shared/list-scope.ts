import { currentPhase, effectiveStatus } from './billing.ts';
import type { AppState, Subscription } from './types.ts';

/** Status facet of the subscription list; `live` folds `active` and `ending` like the overview and public counts. */
export type ListStatus = 'live' | 'upcoming' | 'trial' | 'paused' | 'ended' | 'terminated' | 'lifetime' | 'all';
export const LIST_STATUSES: readonly ListStatus[] = ['all', 'live', 'upcoming', 'trial', 'paused', 'lifetime', 'ended', 'terminated'];

/**
 * One list selection. The web list sets status, category, method and words; MCP may also narrow by
 * tag, region and explicit subscription ids. Every set field must match.
 */
export interface ListScope {
  status?: ListStatus;
  /** Stored category name. */
  category?: string;
  /** Current-phase payment method id; `none` = unassigned. */
  method?: string;
  /** Lower-case search words; each must match the haystack. */
  words?: readonly string[];
  tag?: string;
  /** ISO region of the current phase. */
  region?: string;
  ids?: ReadonlySet<string>;
}

export type ListFacet = 'status' | 'cat' | 'pay';
export type WordMatch = (word: string, haystack: string) => boolean;

export const listStatus = (s: Subscription, today: string): ListStatus => {
  const st = effectiveStatus(s, today);
  return st === 'active' || st === 'ending' ? 'live' : (st as ListStatus);
};
export const listMethod = (s: Subscription, today: string) => currentPhase(s, today).methodId ?? 'none';
export const listWords = (q: string | undefined) => (q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Searchable text: name, category, tags, notes, region, URL and the current payment method name. */
export function listHaystack(state: Pick<AppState, 'methods'>, s: Subscription, today: string): string {
  const method = state.methods.find((m) => m.id === listMethod(s, today))?.name;
  return [s.name, s.category, ...s.tags, s.notes, s.region, s.url, method].filter(Boolean).join(' ').toLowerCase();
}

const literal: WordMatch = (word, text) => text.includes(word);

/** The list predicate; proxy payments never belong to the list. `skip` omits one facet for its option counts. */
export function inListScope(
  state: Pick<AppState, 'methods'>,
  s: Subscription,
  today: string,
  scope: ListScope,
  skip?: ListFacet,
  match: WordMatch = literal,
): boolean {
  if (s.proxy) return false;
  if (scope.ids && !scope.ids.has(s.id)) return false;
  if (scope.words?.length) {
    const text = listHaystack(state, s, today);
    if (!scope.words.every((w) => match(w, text))) return false;
  }
  if (skip !== 'status' && scope.status && scope.status !== 'all' && listStatus(s, today) !== scope.status) return false;
  if (skip !== 'cat' && scope.category != null && s.category !== scope.category) return false;
  if (skip !== 'pay' && scope.method != null && listMethod(s, today) !== scope.method) return false;
  if (scope.tag != null && !s.tags.some((x) => x.toLowerCase() === scope.tag!.toLowerCase())) return false;
  if (scope.region != null && (currentPhase(s, today).region ?? '').toUpperCase() !== scope.region.toUpperCase()) return false;
  return true;
}

/** Subscriptions the list shows for this selection, in ledger order. */
export const listScope = (state: AppState, today: string, scope: ListScope, match?: WordMatch) =>
  state.subscriptions.filter((s) => inListScope(state, s, today, scope, undefined, match));

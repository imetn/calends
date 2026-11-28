import type { AppState } from './types.ts';

export interface ToolFailure {
  id: string;
  name: string;
  args: Record<string, unknown>;
  error: string;
}
export interface AssistantOutcome {
  status: 'complete' | 'partial' | 'limit';
  drafts: number;
  failures: Array<Pick<ToolFailure, 'id' | 'name' | 'error'>>;
}
export interface WriteVerification {
  status: 'verified' | 'unverified';
  fields: string[];
}

/** Object key order and the forced preview flag do not change a draft's identity. */
export function draftSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify({ ...args, dry_run: undefined }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
  )}`;
}

function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k, x]) => x !== undefined && k !== 'updatedAt' && k !== 'createdAt')
              .sort(([a], [b]) => a.localeCompare(b)),
          )
        : v,
    ) ?? 'undefined'
  );
}

/** Only intended entity/setting changes are checked; unrelated concurrent edits are allowed. */
export function writeMismatches(before: AppState, expected: AppState, actual: AppState): string[] {
  const fields: string[] = [];
  for (const key of ['subscriptions', 'methods', 'people'] as const) {
    const a = new Map((before[key] ?? []).map((x) => [x.id, x]));
    const b = new Map((expected[key] ?? []).map((x) => [x.id, x]));
    const c = new Map((actual[key] ?? []).map((x) => [x.id, x]));
    for (const id of new Set([...a.keys(), ...b.keys()]))
      if (canonical(a.get(id)) !== canonical(b.get(id)) && canonical(b.get(id)) !== canonical(c.get(id))) fields.push(`${key}.${id}`);
  }
  for (const key of ['settings', 'prefs'] as const) {
    const a = (before[key] ?? {}) as Record<string, unknown>;
    const b = (expected[key] ?? {}) as Record<string, unknown>;
    const c = (actual[key] ?? {}) as Record<string, unknown>;
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (canonical(a[field]) !== canonical(b[field]) && canonical(b[field]) !== canonical(c[field])) fields.push(`${key}.${field}`);
  }
  return fields;
}

/** Recover a failed operation only when the same tool, target and dated operation succeeds. */
export function remainingFailures(failures: ToolFailure[], name: string, args: Record<string, unknown>, result: unknown): ToolFailure[] {
  const r = (result ?? {}) as {
    subscription?: { id?: string; name?: string };
    created?: { id?: string; name?: string };
    after?: { id?: string; name?: string };
    id?: string;
    name?: string;
  };
  const refs = (a: Record<string, unknown>): unknown[] => {
    const s = a.subscription;
    return typeof s === 'object' && s ? [(s as { id?: string }).id, (s as { name?: string }).name] : [s, a.method, a.person, a.name];
  };
  const identities = new Set(
    [...refs(args), r.subscription?.id, r.subscription?.name, r.created?.id, r.created?.name, r.after?.id, r.after?.name, r.id, r.name].filter(Boolean),
  );
  const selector = (a: Record<string, unknown>) =>
    Object.fromEntries([
      ...['action', 'member', 'at', 'from', 'original_from', 'date', 'replace', 'delete', 'charge', 'periods', 'top_up_index', 'top_up_action']
        .filter((k) => a[k] !== undefined)
        .map((k) => [k, a[k]]),
      ['fields', Object.keys((a.set ?? {}) as object).sort()],
    ]);
  return failures.filter((f) => {
    if (f.name !== name) return true;
    // Malformed JSON has no recoverable target/selector. A valid retry of that tool resolves it.
    if (!Object.keys(f.args).length) return false;
    if (canonical(selector(f.args)) !== canonical(selector(args))) return true;
    const targets = refs(f.args).filter(Boolean);
    return targets.length > 0 && !targets.some((target) => identities.has(target));
  });
}

/** Stop a dependent confirmation batch at the first failure or unverified write. */
export async function confirmInOrder<T>(items: T[], confirm: (item: T) => Promise<boolean>): Promise<void> {
  for (const item of items) if (!(await confirm(item))) break;
}

export interface ProposalLike {
  kind: 'proposal';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  preview?: { subscription?: { id?: string } };
  state: string;
}

function proposalSubId(p: ProposalLike): string | undefined {
  const fromPreview = p.preview?.subscription?.id;
  if (fromPreview) return fromPreview;
  const sub = p.args.subscription;
  if (typeof sub === 'string' && sub) return sub;
  if (sub && typeof sub === 'object' && typeof (sub as { id?: unknown }).id === 'string') return (sub as { id: string }).id;
  if (typeof p.args.id === 'string' && p.args.id) return p.args.id;
  return undefined;
}

function proposalEntityKey(p: ProposalLike): string | undefined {
  const subId = proposalSubId(p);
  if (subId) return `sub:${subId}`;
  if (typeof p.args.method === 'string' && p.args.method) return `method:${p.args.method}`;
  if (typeof p.args.person === 'string' && p.args.person) return `person:${p.args.person}`;
  if (typeof p.args.category === 'string' && p.args.category) return `cat:${p.args.category}`;
  if (typeof p.args.file === 'string' && p.args.file) return `file:${p.args.file}`;
  return undefined;
}

function proposalOpKey(p: ProposalLike): string {
  if (p.tool === 'set_status') return '';
  const keys = ['action', 'member', 'at', 'from', 'original_from', 'date', 'replace', 'delete', 'charge', 'periods', 'top_up_index', 'top_up_action'];
  return canonical(Object.fromEntries(keys.filter((k) => p.args[k] !== undefined).map((k) => [k, p.args[k]])));
}

/**
 * Mark earlier unapplied proposals as superseded when a newer draft replaces them:
 * - A newer `save_subscription` targeting subscription S supersedes any earlier pending/error draft on S
 *   (across earlier turns or earlier in the same turn, except a `create_subscription` that created S).
 * - Across different turns, a newer draft using the same tool on the same target (and same dated operation
 *   when applicable) supersedes the earlier unapplied draft so stale cards cannot be confirmed by mistake.
 */
export function shouldSupersede(earlier: ProposalLike, newer: ProposalLike, sameTurn: boolean): boolean {
  if (earlier.state !== 'pending' && earlier.state !== 'error') return false;
  if (earlier.id === newer.id) return false;
  const earlierSub = proposalSubId(earlier);
  const newerSub = proposalSubId(newer);
  if (newer.tool === 'save_subscription' && newerSub && earlierSub === newerSub) {
    if (sameTurn && earlier.tool === 'create_subscription') return false;
    return true;
  }
  if (sameTurn) return false;
  if (earlier.tool !== newer.tool) return false;
  const eKey = proposalEntityKey(earlier);
  const nKey = proposalEntityKey(newer);
  if (!eKey || eKey !== nKey) return false;
  return proposalOpKey(earlier) === proposalOpKey(newer);
}

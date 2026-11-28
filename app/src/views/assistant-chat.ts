import { shouldSupersede, type AssistantOutcome } from '../../../shared/assistant-result.ts';
import { base } from '../base.ts';
import { locale } from '../../../shared/i18n.ts';
import type { ApiMessage, ErrorKind } from '../../../shared/deepseek.ts';
import { dropOldImages } from '../../../shared/deepseek.ts';
import { ASSISTANT_KEY } from '../store.ts';
import { settleTurns } from './assistant-fields.ts';

// ---------- 会话数据 ----------
export type ToolStatus = 'running' | 'done' | 'error';

export type ProposalState = 'pending' | 'applying' | 'applied' | 'dismissed' | 'superseded' | 'error' | 'unverified';

export type Part =
  | { kind: 'reasoning'; text: string; start: number; ms?: number }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; status: ToolStatus; result?: unknown; error?: string }
  | {
      kind: 'proposal';
      id: string;
      tool: string;
      args: Record<string, unknown>;
      preview: Preview;
      filled?: string[];
      state: ProposalState;
      error?: string;
      subId?: string;
    };

export interface Preview {
  before?: unknown;
  after?: unknown;
  references?: unknown;
  created_category?: { name: string };
  created_person?: { name: string };
  subscription?: { id: string; name: string; category?: string; price?: number; currency?: string; cycle?: string; next_charge?: string | null };
  next_charges?: Array<{ date: string; amount: number; currency: string }>;
}

export type ChatTurn =
  | {
      id: string;
      role: 'user';
      text: string;
      images: string[];
      /** 发送时历史的长度：重试、重新生成时截回这里 */ at: number;
      /** 存到服务端时图片不保存，只记张数 */ imgs?: number;
    }
  | {
      id: string;
      role: 'assistant';
      parts: Part[];
      status: 'streaming' | 'done' | 'error' | 'stopped';
      outcome?: AssistantOutcome;
      error?: { kind: ErrorKind; message: string };
    };

export interface Saved {
  /** 对话 id：服务端按它存；「新对话」换一个新的 */
  id: string;
  createdAt: string;
  turns: ChatTurn[];
  history: ApiMessage[];
}

export const rid = () => Math.random().toString(36).slice(2, 10);

export const newChat = (): Saved => ({ id: rid(), createdAt: new Date().toISOString(), turns: [], history: [] });

/** 存到服务端的样子：图片换成张数，历史里的图片换成占位文字 */
export function forServer(s: Saved) {
  return {
    createdAt: s.createdAt,
    turns: s.turns.map((x) => (x.role === 'user' && x.images.length ? { ...x, images: [], imgs: x.images.length } : x)),
    history: dropOldImages(s.history, 0, '[image]'),
  };
}

/** 会话存在本机浏览器里（只是方便，不是账本数据）：较早的图片不存，免得撑爆存储 */
export function load(): Saved {
  try {
    const raw = localStorage.getItem(ASSISTANT_KEY);
    // 老版本没有 id：补上，之后照常存到服务端
    if (raw) {
      const saved = settleInterrupted({ ...newChat(), ...(JSON.parse(raw) as Partial<Saved>) } as Saved);
      // 还没说过话的对话：分割线上的时间按这次打开算
      return saved.turns.length ? saved : { ...saved, createdAt: new Date().toISOString() };
    }
  } catch {
    /* 隐私模式等读不到就当新会话 */
  }
  return newChat();
}

/** 上次关页时还在流式输出的回复不会再继续：记为中断，显示重试入口 */
export const settleInterrupted = (s: Saved): Saved => ({ ...s, turns: settleTurns(s.turns ?? []) });

export function persist(s: Saved) {
  try {
    let users = 0;
    const turns = s.turns
      .slice()
      .reverse()
      .map((x) => (x.role === 'user' && x.images.length && ++users > 2 ? { ...x, images: [] } : x))
      .reverse();
    localStorage.setItem(ASSISTANT_KEY, JSON.stringify({ id: s.id, createdAt: s.createdAt, turns, history: dropOldImages(s.history, 0, '[image]') }));
  } catch {
    /* 存不下就算了 */
  }
}

// ---------- 流式请求 ----------
export type ServerEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'step' }
  | { type: 'tool'; id: string; name: string; args: Record<string, unknown>; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'proposal'; id: string; tool: string; args: Record<string, unknown>; preview: Preview; filled?: string[] }
  | { type: 'usage' }
  | { type: 'error'; kind: ErrorKind; message: string }
  | { type: 'done'; messages: ApiMessage[]; aborted?: boolean; outcome?: AssistantOutcome };

export async function stream(body: unknown, signal: AbortSignal, on: (e: ServerEvent) => void) {
  // 带上界面语言：服务端按它给出分类名称和回复语言
  const res = await fetch(base('/api/assistant/chat'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-locale': locale() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(b.error ?? `HTTP ${res.status}`), { kind: res.status === 401 ? 'auth' : 'server' });
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) if (line.startsWith('data:')) on(JSON.parse(line.slice(5)) as ServerEvent);
    }
  }
}

/** 把服务端事件并进当前这条助手消息 */
export function reduce(turn: Extract<ChatTurn, { role: 'assistant' }>, e: ServerEvent): Extract<ChatTurn, { role: 'assistant' }> {
  const parts = turn.parts.slice();
  const last = parts[parts.length - 1];
  const closeReasoning = () => {
    const r = parts[parts.length - 1];
    if (r?.kind === 'reasoning' && r.ms == null) parts[parts.length - 1] = { ...r, ms: Date.now() - r.start };
  };
  switch (e.type) {
    case 'reasoning':
      if (last?.kind === 'reasoning' && last.ms == null) parts[parts.length - 1] = { ...last, text: last.text + e.delta };
      else parts.push({ kind: 'reasoning', text: e.delta, start: Date.now() });
      break;
    case 'text':
      closeReasoning();
      if (parts[parts.length - 1]?.kind === 'text') {
        const p = parts[parts.length - 1] as Extract<Part, { kind: 'text' }>;
        parts[parts.length - 1] = { ...p, text: p.text + e.delta };
      } else parts.push({ kind: 'text', text: e.delta });
      break;
    case 'step':
      closeReasoning();
      break;
    case 'tool': {
      closeReasoning();
      const i = parts.findIndex((p) => p.kind === 'tool' && p.id === e.id);
      const next: Part = { kind: 'tool', id: e.id, name: e.name, args: e.args, status: e.status, result: e.result, error: e.error };
      if (i >= 0) parts[i] = next;
      else parts.push(next);
      break;
    }
    case 'proposal': {
      const next: Extract<Part, { kind: 'proposal' }> = {
        kind: 'proposal',
        id: e.id,
        tool: e.tool,
        args: e.args,
        preview: e.preview,
        filled: e.filled,
        state: 'pending',
      };
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.kind === 'proposal' && shouldSupersede(p, next, true)) parts[i] = { ...p, state: 'superseded' };
      }
      parts.push(next);
      break;
    }
    case 'error':
      closeReasoning();
      return { ...turn, parts, status: 'error', error: { kind: e.kind, message: e.message } };
    case 'done':
      closeReasoning();
      return { ...turn, parts, outcome: e.outcome, status: e.aborted ? 'stopped' : 'done' };
  }
  return { ...turn, parts };
}

/** 新草稿到达后，将此前对话轮次或同轮中被替代的未确认草稿标为已替代，防止误点旧草稿。 */
export function supersedeTurns(turns: ChatTurn[], currentTurnId: string, newer: Extract<Part, { kind: 'proposal' }>): ChatTurn[] {
  return turns.map((turn) => {
    if (turn.role !== 'assistant') return turn;
    const sameTurn = turn.id === currentTurnId;
    let changed = false;
    const parts = turn.parts.map((p) => {
      if (p.kind === 'proposal' && shouldSupersede(p, newer, sameTurn)) {
        changed = true;
        return { ...p, state: 'superseded' as const };
      }
      return p;
    });
    return changed ? { ...turn, parts } : turn;
  });
}

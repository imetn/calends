// AI 助手消息格式与兼容辅助函数（历史兼容保留原模块路径）。
// 供应商注册表、配置规范化与错误分类统一由 shared/ai-providers.ts 维护。

import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, inferProvider, normProviderBaseUrl } from './ai-providers.ts';

export {
  AI_PROVIDERS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  configView,
  errorKind,
  getProvider,
  inferProvider,
  isConfigured,
  isProviderId,
  modelDisplayName,
  modelsRequest,
  normProviderBaseUrl,
  parseModelsResponse,
  resolveProvider,
  type AiProtocol,
  type AiProviderPreset,
  type AssistantConfig,
  type AssistantConfigView,
  type Effort,
  type ErrorKind,
  type ModelsRequest,
  type ProviderGroup,
  type ProviderId,
} from './ai-providers.ts';

/**
 * 兼容旧入口的 Base URL 规范化：不指定供应商时按 URL 推断协议后规范化。
 */
export function normBaseUrl(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
  if (!cleaned) return DEEPSEEK_BASE_URL;
  return normProviderBaseUrl(inferProvider(cleaned), cleaned);
}

const hostOf = (baseUrl: string | undefined) => {
  try {
    return new URL(normBaseUrl(baseUrl)).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** OpenAI、Azure OpenAI 与 Gemini 的兼容接口严格校验参数，遇到 thinking 这类未知字段直接 400 */
const isOpenAI = (host: string) => host === 'api.openai.com' || /\.(openai|cognitiveservices|services\.ai)\.azure\.com$/.test(host);
const isStrict = (host: string) => isOpenAI(host) || host === 'generativelanguage.googleapis.com';

/**
 * 兼容保留：思考相关的请求参数（供单测与兼容端点参考；实际模型请求现由 AI SDK 负责）。
 */
export function reasoningParams(effort: 'none' | 'low' | 'high', baseUrl: string | undefined, model: string | undefined): Record<string, unknown> {
  const on = effort !== 'none';
  const host = hostOf(baseUrl);
  if (!isStrict(host)) return { thinking: { type: on ? 'enabled' : 'disabled' }, ...(on ? { reasoning_effort: effort } : {}) };
  const reasons = !isOpenAI(host) || /^(o\d|gpt-5(?!.*-chat))/i.test(model ?? '');
  return on && reasons ? { reasoning_effort: effort } : {};
}

/** 严格校验的服务不认 assistant 消息里的 reasoning_content（换服务商后历史里可能还带着），发送前去掉 */
export function messagesFor(baseUrl: string | undefined, messages: ApiMessage[]): ApiMessage[] {
  if (!isStrict(hostOf(baseUrl))) return messages;
  return messages.map((m) => {
    if (m.role !== 'assistant' || m.reasoning_content === undefined) return m;
    const { reasoning_content: _, ...rest } = m;
    return rest;
  });
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 助手对话历史消息格式（服务端 D1 与浏览器本地持久化共用） */
export type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** 用户这一轮：文字 + 图片（data URL）；只有文字时用字符串，省 token */
export function userMessage(text: string, images: string[]): ApiMessage {
  const t = text.trim();
  if (!images.length) return { role: 'user', content: t };
  return {
    role: 'user',
    content: [...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })), ...(t ? [{ type: 'text' as const, text: t }] : [])],
  };
}

/** 历史里较早的图片换成占位文字：图片只在当轮最有用，一直带着既费 token 也占存储 */
export function dropOldImages(history: ApiMessage[], keepLast = 1, placeholder = '[image]'): ApiMessage[] {
  let seen = 0;
  return history
    .slice()
    .reverse()
    .map((m) => {
      if (m.role !== 'user' || typeof m.content === 'string') return m;
      if (++seen <= keepLast) return m;
      const text = m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [placeholder])).join('\n');
      return { role: 'user' as const, content: text };
    })
    .reverse();
}

/** 一次流式回复累积出来的结果 */
export interface Turn {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export const emptyTurn = (): Turn => ({ content: '', reasoning: '', toolCalls: [] });

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

/**
 * 处理 SSE 的一行（保留用于纯函数单测与兼容参考）。
 */
export function applyLine(turn: Turn, line: string): { text?: string; reasoning?: string } | null {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  let chunk: { choices?: Array<{ delta?: Delta; finish_reason?: string | null }>; usage?: Turn['usage'] };
  try {
    chunk = JSON.parse(data);
  } catch {
    return null;
  }
  if (chunk.usage) turn.usage = chunk.usage;
  const c = chunk.choices?.[0];
  if (!c) return null;
  if (c.finish_reason) turn.finish = c.finish_reason;
  const d = c.delta ?? {};
  const out: { text?: string; reasoning?: string } = {};
  if (d.reasoning_content) {
    turn.reasoning += d.reasoning_content;
    out.reasoning = d.reasoning_content;
  }
  if (d.content) {
    turn.content += d.content;
    out.text = d.content;
  }
  for (const tc of d.tool_calls ?? []) {
    const slot = (turn.toolCalls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.function.name += tc.function.name;
    if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
  }
  return out;
}

/** 这一轮回复写回历史：带上思考内容与工具调用，下一轮原样回传 */
export function assistantMessage(turn: Turn): ApiMessage {
  const calls = turn.toolCalls.filter(Boolean);
  return {
    role: 'assistant',
    content: turn.content || null,
    ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

/** 工具参数：模型偶尔给出空串或坏 JSON，按空对象处理并把原文交给调用方报错 */
export function parseArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  if (!raw.trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { args: v as Record<string, unknown> } : { args: {}, error: 'arguments must be an object' };
  } catch (e) {
    return { args: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export const DEFAULT_ASSISTANT_MODEL = DEEPSEEK_MODEL;

// DeepSeek（OpenAI 兼容的 Chat Completions）：请求体、流式响应的解析与累积。
// 只放纯函数，服务端发请求、前端显示都用它，单元测试也直接测这里。

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** DeepSeek-V4.1-Flash：支持图片输入、工具调用和思考模式 */
export const DEEPSEEK_MODEL = 'deepseek-flash';
export type Effort = 'none' | 'low' | 'high';

/** 服务端保存的配置；apiKey 只在服务端，绝不下发给浏览器 */
export interface AssistantConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  effort?: Effort;
}

/** 给浏览器看的配置：没有 Key 本身，只有末四位 */
export interface AssistantConfigView {
  configured: boolean;
  keyHint?: string;
  baseUrl: string;
  model: string;
  effort: Effort;
}

export function configView(c: AssistantConfig | undefined): AssistantConfigView {
  return {
    configured: !!c?.apiKey,
    keyHint: c?.apiKey ? `…${c.apiKey.slice(-4)}` : undefined,
    baseUrl: c?.baseUrl || DEEPSEEK_BASE_URL,
    model: c?.model || DEEPSEEK_MODEL,
    effort: c?.effort ?? 'low',
  };
}

/**
 * Base URL 规范化：去掉末尾的斜杠和误填的 /chat/completions。
 * /v1 这类版本路径原样保留：DeepSeek 带不带都行，OpenAI 等服务必须带，去掉就 404。
 * 旧版本保存时去掉过 /v1，存下的 https://api.openai.com 读出时补回。
 */
export function normBaseUrl(raw: string | undefined): string {
  const u = (raw ?? '').trim().replace(/\/+$/, '');
  const base = u.replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
  if (!base) return DEEPSEEK_BASE_URL;
  return /^https?:\/\/api\.openai\.com$/i.test(base) ? `${base}/v1` : base;
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
 * 思考相关的请求参数。thinking 开关 DeepSeek、智谱 GLM、火山方舟等都认，默认照发；
 * 严格校验的服务不发 thinking，关闭思考时什么都不带。OpenAI 的非推理模型（gpt-4.1、gpt-4o 等）
 * 不认 reasoning_effort，只给 o 系列与 gpt-5 系列。
 */
export function reasoningParams(effort: Effort, baseUrl: string | undefined, model: string | undefined): Record<string, unknown> {
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

/** 发给 DeepSeek 的消息；带工具时 assistant 的 reasoning_content 必须原样回传，否则 400 */
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
 * 处理 SSE 的一行。返回这一行带来的增量（文字、思考），并把它累积进 turn；
 * 工具调用按 index 拼接（名字、参数分多段到来）。不是 data 行、心跳或 [DONE] 返回 null。
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

/** DeepSeek 的 HTTP 错误码 → 错误类别（前端按类别给出提示与处理办法） */
export type ErrorKind = 'auth' | 'balance' | 'rate' | 'params' | 'server' | 'network' | 'config';
export function errorKind(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'balance';
  if (status === 429) return 'rate';
  if (status === 400 || status === 422) return 'params';
  return 'server';
}

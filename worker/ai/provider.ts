// 基于 Vercel AI SDK（Apache-2.0）的多供应商适配层：
// 用 5 个核心 @ai-sdk/* 协议包覆盖所有主流厂商与兼容端点，保留现有助手的流式事件与工具循环契约。

import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, jsonSchema, streamText, tool, type JSONSchema7, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import {
  errorKind,
  modelsRequest,
  normProviderBaseUrl,
  parseModelsResponse,
  resolveProvider,
  type AiProtocol,
  type AssistantConfig,
  type ErrorKind,
} from '../../shared/ai-providers.ts';
import { emptyTurn, parseArgs, type ApiMessage, type Turn } from '../../shared/deepseek.ts';
import type { Tool } from './tool-kit.ts';

export type StreamEmit = (event: Record<string, unknown>) => void;

export interface StreamTurnResult {
  turn: Turn;
  /** 本轮 AI SDK 原始响应消息（含 Anthropic thinking signature / Gemini thoughtSignature 等元数据），同轮后续工具循环直接回传 */
  responseMessages: ModelMessage[];
}

/** 按配置构造对应的 AI SDK LanguageModel */
export function createLanguageModel(cfg: AssistantConfig, customFetch?: typeof fetch): LanguageModel {
  const preset = resolveProvider(cfg);
  const baseURL = normProviderBaseUrl(preset.id, cfg.baseUrl);
  const modelId = cfg.model?.trim() || preset.defaultModel;
  const apiKey = cfg.apiKey?.trim() || undefined;
  const effort = cfg.effort ?? 'low';

  switch (preset.protocol) {
    case 'deepseek':
      return createDeepSeek({ apiKey, baseURL: baseURL || undefined, fetch: customFetch })(modelId);
    case 'openai':
      return createOpenAI({ apiKey, baseURL: baseURL || undefined, fetch: customFetch })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseURL || undefined, fetch: customFetch })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: baseURL || undefined, fetch: customFetch })(modelId);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: preset.id,
        baseURL,
        apiKey,
        includeUsage: true,
        fetch: customFetch,
        ...(preset.thinkingToggle
          ? {
              transformRequestBody: (body) => ({
                ...body,
                thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
              }),
            }
          : {}),
      })(modelId);
  }
}

/** 将 data:image/... URL 解析为各家 Provider 均支持的 ImagePart */
function toImagePart(url: string): { type: 'image'; image: string | URL; mediaType?: string } {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/i);
  if (m) return { type: 'image', mediaType: m[1], image: m[2] };
  try {
    return { type: 'image', image: new URL(url) };
  } catch {
    return { type: 'image', image: url };
  }
}

/**
 * 将持久化的 ApiMessage[]（含旧对话记录）转换为 AI SDK ModelMessage[]。
 * 连续的 tool 消息会合并进同一条 ToolModelMessage，符合 Anthropic / Gemini 对并行工具结果的要求。
 */
export function toModelMessages(messages: ApiMessage[], protocol: AiProtocol): ModelMessage[] {
  const out: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  // 跨轮持久化历史里只有文本版 reasoning_content（没有厂商签名）；仅 DeepSeek 与 OpenAI 兼容端点回传它，
  // 避免 Anthropic/OpenAI/Google 因缺少签名报错。同轮多步循环内由 responseMessages 保留完整签名。
  const replayReasoning = protocol === 'deepseek' || protocol === 'openai-compatible';

  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else {
        out.push({
          role: 'user',
          content: m.content.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : toImagePart(p.image_url.url))),
        });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const parts: Array<
        { type: 'reasoning'; text: string } | { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (replayReasoning && m.reasoning_content) {
        parts.push({ type: 'reasoning', text: m.reasoning_content });
      }
      if (m.content) {
        parts.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name);
        const { args } = parseArgs(tc.function.arguments);
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: args });
      }
      out.push({ role: 'assistant', content: parts.length ? parts : '' });
      continue;
    }
    if (m.role === 'tool') {
      const part = {
        type: 'tool-result' as const,
        toolCallId: m.tool_call_id,
        toolName: toolNames.get(m.tool_call_id) ?? 'tool',
        output: { type: 'text' as const, value: m.content },
      };
      const prev = out[out.length - 1];
      if (prev?.role === 'tool') {
        prev.content.push(part);
      } else {
        out.push({ role: 'tool', content: [part] });
      }
    }
  }
  return out;
}

/** 构造 AI SDK ToolSet（直接复用 37 个 MCP 工具的 JSON Schema，不挂 execute，由 assistant.ts 控制 dry_run） */
function toToolSet(tools: readonly Tool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
    });
  }
  return set;
}

/** 从 AI SDK 错误里提取可读消息与分类（兼容各家 HTTP 错误体） */
export function classifyError(err: unknown): Error & { kind: ErrorKind; status?: number } {
  if (APICallError.isInstance(err)) {
    let message = err.message;
    if (err.responseBody) {
      try {
        const parsed = JSON.parse(err.responseBody) as { error?: { message?: string }; message?: string };
        message = parsed.error?.message || parsed.message || message;
      } catch {
        /* 保持原始错误文案 */
      }
    }
    const status = err.statusCode;
    return Object.assign(new Error(message || (status ? `HTTP ${status}` : 'API error')), {
      kind: status ? errorKind(status) : ('network' as ErrorKind),
      status,
    });
  }
  const e = err instanceof Error ? err : new Error(String(err));
  const existing = e as Error & { kind?: ErrorKind; status?: number };
  return Object.assign(e, {
    kind: existing.kind ?? (existing.status ? errorKind(existing.status) : ('network' as ErrorKind)),
    status: existing.status,
  });
}

/** 调用一次模型（流式），边收边把思考与正文推给前端，结束时返回累积的 Turn 与原始响应消息 */
export async function streamTurn(
  cfg: AssistantConfig,
  system: string,
  messages: ModelMessage[],
  tools: readonly Tool[] | undefined,
  emit: StreamEmit,
  signal: AbortSignal,
  customFetch?: typeof fetch,
): Promise<StreamTurnResult> {
  const preset = resolveProvider(cfg);
  const effort = cfg.effort ?? 'low';
  const model = createLanguageModel(cfg, customFetch);
  // OpenAI 兼容端在「不思考」时不强发 reasoning_effort: 'none'，避免部分兼容接口（Ollama/Groq/Mistral 等）报 400
  const reasoning = preset.protocol === 'openai-compatible' && effort === 'none' ? undefined : effort;

  const result = streamText({
    model,
    system,
    messages,
    ...(tools?.length ? { tools: toToolSet(tools) } : {}),
    ...(reasoning ? { reasoning } : {}),
    abortSignal: signal,
    maxRetries: 0,
    onError: () => {},
  });

  const turn = emptyTurn();
  let streamError: unknown;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'reasoning-delta':
        if (part.text) {
          turn.reasoning += part.text;
          emit({ type: 'reasoning', delta: part.text });
        }
        break;
      case 'text-delta':
        if (part.text) {
          turn.content += part.text;
          emit({ type: 'text', delta: part.text });
        }
        break;
      case 'tool-call': {
        const rawArgs = typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {});
        turn.toolCalls.push({
          id: part.toolCallId,
          type: 'function',
          function: { name: part.toolName, arguments: rawArgs },
        });
        break;
      }
      case 'finish':
        turn.finish = part.finishReason;
        if (part.totalUsage.inputTokens !== undefined || part.totalUsage.outputTokens !== undefined) {
          turn.usage = {
            prompt_tokens: part.totalUsage.inputTokens,
            completion_tokens: part.totalUsage.outputTokens,
          };
        }
        break;
      case 'error':
        streamError = part.error;
        break;
    }
  }

  if (streamError) throw classifyError(streamError);

  let responseMessages: ModelMessage[] = [];
  try {
    const res = await result.response;
    responseMessages = res.messages;
  } catch {
    /* 中止或空响应时按当前 turn 回退 */
  }
  return { turn, responseMessages };
}

/** 按供应商协议拉取可用模型列表 */
export async function fetchProviderModels(
  cfg: AssistantConfig,
  customFetch: typeof fetch = fetch,
): Promise<{ ok: true; models: string[] } | { ok: false; kind: ErrorKind; message: string }> {
  const preset = resolveProvider(cfg);
  const apiKey = cfg.apiKey?.trim() || undefined;
  const baseUrl = normProviderBaseUrl(preset.id, cfg.baseUrl);
  if (!baseUrl) return { ok: false, kind: 'config', message: 'Base URL is required' };
  const req = modelsRequest(preset.protocol, baseUrl, apiKey);
  try {
    const res = await customFetch(req.url, { headers: req.headers });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
    if (!res.ok) {
      return { ok: false, kind: errorKind(res.status), message: body.error?.message ?? body.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, models: parseModelsResponse(preset.protocol, body) };
  } catch (e) {
    return { ok: false, kind: 'network', message: e instanceof Error ? e.message : String(e) };
  }
}

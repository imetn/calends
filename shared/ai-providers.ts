// AI 助手供应商预设、协议映射、Base URL 规范化与模型列表解析。
// 纯函数，浏览器、Worker 与单元测试共用，不引入任何平台或 SDK 依赖。

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** DeepSeek-V4.1-Flash：支持图片输入、工具调用和思考模式 */
export const DEEPSEEK_MODEL = 'deepseek-flash';

export type Effort = 'none' | 'low' | 'high';

/** 底层协议：由 5 个核心 @ai-sdk/* 包实现 */
export type AiProtocol = 'deepseek' | 'openai' | 'anthropic' | 'google' | 'openai-compatible';

export type ProviderGroup = 'major' | 'cn' | 'gateway' | 'custom';

export type ProviderId =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'zhipu'
  | 'ark'
  | 'dashscope'
  | 'moonshot'
  | 'minimax'
  | 'siliconflow'
  | 'ollama'
  | 'custom-openai'
  | 'custom-anthropic';

export interface AiProviderPreset {
  id: ProviderId;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  defaultModel: string;
  keyUrl?: string;
  keyHost?: string;
  /** 本地服务（如 Ollama）不需要 API Key */
  optionalKey?: boolean;
  /** 自定义服务商：Base URL 由用户填写 */
  custom?: boolean;
  /** 使用 OpenAI 兼容接口但以 thinking: { type } 显式开关思考的服务（智谱 GLM、火山方舟等） */
  thinkingToggle?: boolean;
  group: ProviderGroup;
}

export const AI_PROVIDERS: readonly AiProviderPreset[] = [
  // 主流模型
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    defaultModel: DEEPSEEK_MODEL,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHost: 'platform.deepseek.com',
    group: 'major',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHost: 'platform.openai.com',
    group: 'major',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHost: 'console.anthropic.com',
    group: 'major',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHost: 'aistudio.google.com',
    group: 'major',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
    keyUrl: 'https://console.x.ai',
    keyHost: 'console.x.ai',
    group: 'major',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-medium-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHost: 'console.mistral.ai',
    group: 'major',
  },
  // 国内模型平台
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-air',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyHost: 'open.bigmodel.cn',
    thinkingToggle: true,
    group: 'cn',
  },
  {
    id: 'ark',
    name: 'Volcengine Ark',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    keyUrl: 'https://console.volcengine.com/ark',
    keyHost: 'console.volcengine.com',
    thinkingToggle: true,
    group: 'cn',
  },
  {
    id: 'dashscope',
    name: 'Alibaba DashScope (Qwen)',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com',
    keyHost: 'bailian.console.aliyun.com',
    group: 'cn',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0711-preview',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyHost: 'platform.moonshot.cn',
    group: 'cn',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M1',
    keyUrl: 'https://platform.minimax.io',
    keyHost: 'platform.minimax.io',
    group: 'cn',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyHost: 'cloud.siliconflow.cn',
    group: 'cn',
  },
  // 聚合平台与本地模型
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4.1-mini',
    keyUrl: 'https://openrouter.ai/keys',
    keyHost: 'openrouter.ai',
    group: 'gateway',
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyHost: 'console.groq.com',
    group: 'gateway',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    optionalKey: true,
    group: 'gateway',
  },
  // 自定义
  {
    id: 'custom-openai',
    name: 'OpenAI-compatible',
    protocol: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    custom: true,
    group: 'custom',
  },
  {
    id: 'custom-anthropic',
    name: 'Anthropic-compatible',
    protocol: 'anthropic',
    baseUrl: '',
    defaultModel: '',
    custom: true,
    group: 'custom',
  },
];

const PROVIDER_MAP = new Map<string, AiProviderPreset>(AI_PROVIDERS.map((p) => [p.id, p]));

export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && PROVIDER_MAP.has(v);

export const getProvider = (id: string | undefined): AiProviderPreset | undefined => (id ? PROVIDER_MAP.get(id) : undefined);

/** 服务端保存的配置；apiKey 只在服务端，绝不下发给浏览器 */
export interface AssistantConfig {
  provider?: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  effort?: Effort;
}

/** 给浏览器看的配置：没有 Key 本身，只有末四位 */
export interface AssistantConfigView {
  configured: boolean;
  provider: ProviderId;
  keyHint?: string;
  baseUrl: string;
  model: string;
  effort: Effort;
}

/** 从旧配置（无 provider 字段）按 Base URL 自动推断供应商，保持无痛升级 */
export function inferProvider(baseUrl: string | undefined): ProviderId {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return 'deepseek';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'custom-openai';
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'generativelanguage.googleapis.com') {
    // 早期用户通过 Google 的 OpenAI 兼容端点配置时路径含 /openai，保留兼容协议避免破坏现有配置
    return /\/openai(\/|$)/.test(path) ? 'custom-openai' : 'google';
  }
  if ((host === 'localhost' || host === '127.0.0.1') && url.port === '11434') return 'ollama';
  for (const p of AI_PROVIDERS) {
    if (!p.baseUrl || p.custom) continue;
    try {
      if (new URL(p.baseUrl).hostname.toLowerCase() === host) return p.id;
    } catch {
      /* ignore */
    }
  }
  return 'custom-openai';
}

export function resolveProvider(c: { provider?: string; baseUrl?: string } | undefined): AiProviderPreset {
  return getProvider(c?.provider) ?? getProvider(inferProvider(c?.baseUrl)) ?? AI_PROVIDERS[0];
}

/**
 * Base URL 规范化：去掉末尾斜杠与误填的具体端点路径。
 * 保留版本路径（如 /v1、/v1beta、/api/v3）；为裸官方域名补全默认版本路径。
 */
export function normProviderBaseUrl(provider: ProviderId, raw: string | undefined): string {
  const preset = getProvider(provider) ?? AI_PROVIDERS[0];
  let base = (raw ?? '').trim().replace(/\/+$/, '');
  if (preset.protocol === 'anthropic') {
    base = base.replace(/\/messages$/i, '').replace(/\/+$/, '');
  } else if (preset.protocol === 'google') {
    base = base.replace(/\/models$/i, '').replace(/\/+$/, '');
  } else {
    base = base.replace(/\/(chat\/completions|responses)$/i, '').replace(/\/+$/, '');
  }
  if (!base) return preset.baseUrl;
  if (/^https?:\/\/api\.openai\.com$/i.test(base)) return `${base}/v1`;
  if (/^https?:\/\/api\.anthropic\.com$/i.test(base)) return `${base}/v1`;
  if (/^https?:\/\/generativelanguage\.googleapis\.com$/i.test(base)) return `${base}/v1beta`;
  return base;
}

export function isConfigured(c: AssistantConfig | undefined): boolean {
  if (!c) return false;
  if (c.apiKey?.trim()) return true;
  const preset = resolveProvider(c);
  return !!preset.optionalKey && c.provider === preset.id && !!c.model?.trim();
}

export function configView(c: AssistantConfig | undefined): AssistantConfigView {
  const preset = resolveProvider(c);
  return {
    configured: isConfigured(c),
    provider: preset.id,
    keyHint: c?.apiKey ? `…${c.apiKey.slice(-4)}` : undefined,
    baseUrl: normProviderBaseUrl(preset.id, c?.baseUrl),
    model: c?.model || preset.defaultModel,
    effort: c?.effort ?? 'low',
  };
}

export function modelDisplayName(provider: ProviderId | undefined, model: string | undefined): string {
  if (model === 'deepseek-flash') return 'DeepSeek V4.1 Flash';
  if (model?.trim()) return model.trim();
  return getProvider(provider)?.name ?? 'AI';
}

export interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/** 构造拉取模型列表的 HTTP 请求（不同协议路径与鉴权头不同） */
export function modelsRequest(protocol: AiProtocol, baseUrl: string, apiKey: string | undefined): ModelsRequest {
  const base = baseUrl.replace(/\/+$/, '');
  if (protocol === 'anthropic') {
    return {
      url: `${base}/models?limit=100`,
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'anthropic-version': '2023-06-01',
      },
    };
  }
  if (protocol === 'google') {
    return {
      url: `${base}/models?pageSize=200`,
      headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
    };
  }
  return {
    url: `${base}/models`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  };
}

/** 解析各协议的 /models 响应为模型 id 列表 */
export function parseModelsResponse(protocol: AiProtocol, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  if (protocol === 'google') {
    const models = (body as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }).models ?? [];
    return models
      .filter((m) => typeof m?.name === 'string' && (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')))
      .map((m) => m.name!.replace(/^models\//, ''))
      .filter(Boolean);
  }
  const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
  return data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean);
}

/** HTTP 错误码 → 错误类别（前端按类别给出提示与处理办法） */
export type ErrorKind = 'auth' | 'balance' | 'rate' | 'params' | 'server' | 'network' | 'config';

export function errorKind(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'balance';
  if (status === 429) return 'rate';
  if (status === 400 || status === 422) return 'params';
  return 'server';
}

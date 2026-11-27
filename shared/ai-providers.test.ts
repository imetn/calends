import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDERS,
  configView,
  getProvider,
  inferProvider,
  isConfigured,
  isOfficialProviderHost,
  isProviderId,
  modelDisplayName,
  modelsRequest,
  modelsRequestCandidates,
  normProviderBaseUrl,
  parseModelsResponse,
  resolveProvider,
} from './ai-providers.ts';

test('供应商注册表：每个预设具备合法协议与唯一 id', () => {
  const ids = new Set(AI_PROVIDERS.map((p) => p.id));
  assert.equal(ids.size, AI_PROVIDERS.length);
  assert.ok(isProviderId('deepseek'));
  assert.ok(isProviderId('openai'));
  assert.ok(isProviderId('anthropic'));
  assert.ok(isProviderId('google'));
  assert.ok(isProviderId('openrouter'));
  assert.ok(isProviderId('custom-openai'));
  assert.ok(isProviderId('custom-anthropic'));
  assert.equal(isProviderId('unknown-provider'), false);
  assert.equal(getProvider('anthropic')?.protocol, 'anthropic');
  assert.equal(getProvider('google')?.protocol, 'google');
  assert.equal(getProvider('openrouter')?.protocol, 'openai-compatible');
});

test('旧配置无 provider 字段时按 Base URL 自动推断供应商', () => {
  assert.equal(inferProvider(undefined), 'deepseek');
  assert.equal(inferProvider(''), 'deepseek');
  assert.equal(inferProvider('https://api.deepseek.com'), 'deepseek');
  assert.equal(inferProvider('https://api.openai.com/v1'), 'openai');
  assert.equal(inferProvider('https://api.openai.com'), 'openai');
  assert.equal(inferProvider('https://api.anthropic.com/v1'), 'anthropic');
  assert.equal(inferProvider('https://generativelanguage.googleapis.com/v1beta'), 'google');
  // 早期通过 Google OpenAI 兼容端点保存的配置必须保持兼容模式
  assert.equal(inferProvider('https://generativelanguage.googleapis.com/v1beta/openai'), 'custom-openai');
  assert.equal(inferProvider('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(inferProvider('https://open.bigmodel.cn/api/paas/v4'), 'zhipu');
  assert.equal(inferProvider('https://ark.cn-beijing.volces.com/api/v3'), 'ark');
  assert.equal(inferProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'dashscope');
  assert.equal(inferProvider('https://api.moonshot.cn/v1'), 'moonshot');
  assert.equal(inferProvider('http://localhost:11434/v1'), 'ollama');
  assert.equal(inferProvider('https://relay.example.com/v1'), 'custom-openai');

  // 显式 provider 优先于 baseUrl（方便给 OpenAI/Claude 填自定义代理地址）
  assert.equal(resolveProvider({ provider: 'anthropic', baseUrl: 'https://proxy.example.com/v1' }).id, 'anthropic');
  assert.equal(resolveProvider({ baseUrl: 'https://api.openai.com/v1' }).id, 'openai');
});

test('Base URL 规范化：按协议去掉误填端点并补齐官方裸域名版本路径', () => {
  assert.equal(normProviderBaseUrl('deepseek', ''), 'https://api.deepseek.com');
  assert.equal(normProviderBaseUrl('openai', 'https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(normProviderBaseUrl('openai', 'https://api.openai.com/v1/responses/'), 'https://api.openai.com/v1');
  assert.equal(normProviderBaseUrl('openai', 'https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
  assert.equal(normProviderBaseUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1');
  assert.equal(normProviderBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
  assert.equal(normProviderBaseUrl('google', 'https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(normProviderBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta/models'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(normProviderBaseUrl('custom-openai', ''), '');
  assert.equal(normProviderBaseUrl('custom-openai', 'https://my-gateway.local/v1/chat/completions'), 'https://my-gateway.local/v1');
});

test('配置视图：不泄露完整 Key，免 Key 本地服务（Ollama）按模型判为已配置', () => {
  const v = configView({ provider: 'anthropic', apiKey: 'sk-ant-secret9876', model: 'claude-sonnet-4-5' });
  assert.equal(v.configured, true);
  assert.equal(v.provider, 'anthropic');
  assert.equal(v.keyHint, '…9876');
  assert.equal(v.baseUrl, 'https://api.anthropic.com/v1');
  assert.ok(!JSON.stringify(v).includes('secret'));

  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured({ provider: 'openai', model: 'gpt-4.1-mini' }), false);
  assert.equal(isConfigured({ provider: 'ollama', model: 'qwen3:8b' }), true);
  assert.equal(isConfigured({ provider: 'ollama' }), false);

  assert.equal(modelDisplayName('deepseek', 'deepseek-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(modelDisplayName('anthropic', 'claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(modelDisplayName('openai', ''), 'OpenAI');
});

test('模型列表请求与响应解析：覆盖 OpenAI 兼容、Anthropic 与 Google Gemini', () => {
  const oai = modelsRequest('openai', 'https://api.openai.com/v1/', 'sk-1');
  assert.equal(oai.url, 'https://api.openai.com/v1/models');
  assert.equal(oai.headers.authorization, 'Bearer sk-1');
  assert.deepEqual(parseModelsResponse('openai', { data: [{ id: 'gpt-4.1-mini' }, { id: 'o4-mini' }] }), ['gpt-4.1-mini', 'o4-mini']);

  const ollama = modelsRequest('openai-compatible', 'http://localhost:11434/v1', undefined);
  assert.equal(ollama.url, 'http://localhost:11434/v1/models');
  assert.deepEqual(ollama.headers, {});

  const ant = modelsRequest('anthropic', 'https://api.anthropic.com/v1', 'sk-ant');
  assert.equal(ant.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(ant.headers['x-api-key'], 'sk-ant');
  assert.equal(ant.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(parseModelsResponse('anthropic', { data: [{ id: 'claude-sonnet-4-5' }] }), ['claude-sonnet-4-5']);

  const goo = modelsRequest('google', 'https://generativelanguage.googleapis.com/v1beta', 'AIza-key');
  assert.equal(goo.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200');
  assert.equal(goo.headers['x-goog-api-key'], 'AIza-key');
  assert.deepEqual(
    parseModelsResponse('google', {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
    ['gemini-2.5-flash'],
  );
});

test('反代探测候选与宽松模型响应解析：自动补 /v1、Anthropic Bearer 回退及数组/models 变体', () => {
  assert.equal(isOfficialProviderHost('openai', 'https://api.openai.com/v1'), true);
  assert.equal(isOfficialProviderHost('openai', 'https://proxy.example.com/v1'), false);
  assert.equal(isOfficialProviderHost('custom-openai', 'https://proxy.example.com/v1'), false);

  // 未写 /v1 的反代根地址会依次探测 /models 与 /v1/models
  const cands = modelsRequestCandidates('openai-compatible', 'https://proxy.example.com', 'sk-proxy');
  assert.deepEqual(
    cands.map((c) => [c.url, c.resolvedBaseUrl]),
    [
      ['https://proxy.example.com/models', 'https://proxy.example.com'],
      ['https://proxy.example.com/v1/models', 'https://proxy.example.com/v1'],
    ],
  );

  // 已带 /v1 时不再重复拼 /v1/v1
  const v1Cands = modelsRequestCandidates('openai-compatible', 'https://proxy.example.com/v1', 'sk-proxy');
  assert.deepEqual(
    v1Cands.map((c) => c.url),
    ['https://proxy.example.com/v1/models'],
  );

  // Anthropic 自定义反代同时生成 x-api-key、/v1 和 Bearer 回退
  const antCands = modelsRequestCandidates('anthropic', 'https://relay.example.com', 'sk-ant');
  assert.ok(antCands.some((c) => c.url === 'https://relay.example.com/v1/models?limit=100' && c.headers['x-api-key'] === 'sk-ant'));
  assert.ok(antCands.some((c) => c.url === 'https://relay.example.com/v1/models' && c.headers.authorization === 'Bearer sk-ant'));

  // 宽松解析顶层数组、字符串数组与 { models } 变体
  assert.deepEqual(parseModelsResponse('openai-compatible', [{ id: 'gpt-4o' }, { model: 'deepseek-chat' }, { id: 'gpt-4o' }]), [
    'gpt-4o',
    'deepseek-chat',
  ]);
  assert.deepEqual(parseModelsResponse('openai-compatible', ['auto/deepseek-v4.1-flash', 'claude-sonnet-4-5']), [
    'auto/deepseek-v4.1-flash',
    'claude-sonnet-4-5',
  ]);
  assert.deepEqual(parseModelsResponse('openai-compatible', { models: [{ name: 'models/qwen3:8b' }, { id: 'llama3.3' }] }), ['qwen3:8b', 'llama3.3']);
});

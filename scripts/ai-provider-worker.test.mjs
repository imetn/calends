import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, fetchProviderModels, probeProviderModel, streamTurn, toModelMessages } from '../worker/ai/provider.ts';
import { saveConfig, testConfig } from '../worker/ai/assistant.ts';

function sseResponse(events) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(enc.encode(ev));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('toModelMessages: 多模态图片、并行工具结果分组与跨供应商 reasoning 过滤', () => {
  const history = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        { type: 'text', text: '识别收据' },
      ],
    },
    {
      role: 'assistant',
      content: '先查分类',
      reasoning_content: '需要确认已有分类',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'list_categories', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'list_payment_methods', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '["Tools"]' },
    { role: 'tool', tool_call_id: 'c2', content: '[]' },
  ];

  // DeepSeek 回传 reasoning_content
  const ds = toModelMessages(history, 'deepseek');
  assert.equal(ds.length, 3);
  assert.equal(ds[0].role, 'user');
  assert.deepEqual(ds[0].content[0], { type: 'image', mediaType: 'image/png', image: 'iVBORw0KGgo=' });
  assert.equal(ds[1].content[0].type, 'reasoning');
  // 连续两个 tool 消息合并为一条 ToolModelMessage，并还原各自 toolName
  assert.equal(ds[2].role, 'tool');
  assert.equal(ds[2].content.length, 2);
  assert.equal(ds[2].content[0].toolName, 'list_categories');
  assert.equal(ds[2].content[1].toolName, 'list_payment_methods');

  // Anthropic / OpenAI / Google 跨轮历史不回传无签名的文本 reasoning
  const ant = toModelMessages(history, 'anthropic');
  assert.ok(ant[1].content.every((p) => p.type !== 'reasoning'));
});

test('streamTurn: 经 @ai-sdk/deepseek 流式输出思考、正文、工具调用与用量', async () => {
  const seen = [];
  let reqUrl = '';
  let reqBody = null;
  const mockFetch = async (url, init) => {
    reqUrl = String(url);
    reqBody = JSON.parse(String(init.body));
    return sseResponse([
      `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先核对价格' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { content: '已整理草稿' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_categories', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  };

  const tools = [{ name: 'list_categories', description: 'List categories', inputSchema: { type: 'object', properties: {} }, run: async () => ({}) }];
  const { turn, responseMessages } = await streamTurn(
    { provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-flash', effort: 'low' },
    'system prompt',
    [{ role: 'user', content: 'hi' }],
    tools,
    (ev) => seen.push(ev),
    new AbortController().signal,
    mockFetch,
  );

  assert.equal(reqUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(reqBody.model, 'deepseek-flash');
  assert.equal(turn.reasoning, '先核对价格');
  assert.equal(turn.content, '已整理草稿');
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].function.name, 'list_categories');
  assert.equal(turn.usage?.prompt_tokens, 12);
  assert.ok(seen.some((e) => e.type === 'reasoning' && e.delta === '先核对价格'));
  assert.ok(seen.some((e) => e.type === 'text' && e.delta === '已整理草稿'));
  assert.ok(responseMessages.length >= 1);
});

test('streamTurn: 经 @ai-sdk/anthropic 原生协议流式输出正文', async () => {
  let reqUrl = '';
  let reqHeaders = {};
  const mockFetch = async (url, init) => {
    reqUrl = String(url);
    reqHeaders = Object.fromEntries(new Headers(init.headers).entries());
    return sseResponse([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Claude' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]);
  };

  const events = [];
  const { turn } = await streamTurn(
    { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5', effort: 'none' },
    'sys',
    [{ role: 'user', content: 'hi' }],
    undefined,
    (ev) => events.push(ev),
    new AbortController().signal,
    mockFetch,
  );

  assert.equal(reqUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(reqHeaders['x-api-key'], 'sk-ant-test');
  assert.equal(turn.content, 'Hello from Claude');
  assert.deepEqual(events, [{ type: 'text', delta: 'Hello from Claude' }]);
});

test('streamTurn: 智谱 GLM 经 @ai-sdk/openai-compatible 透传 thinking 开关并正确分类 HTTP 错误', async () => {
  let reqBody = null;
  const mockFetch = async (_url, init) => {
    reqBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(
    () =>
      streamTurn(
        { provider: 'zhipu', apiKey: 'bad-key', model: 'glm-4.5-air', effort: 'none' },
        'sys',
        [{ role: 'user', content: 'hi' }],
        undefined,
        () => {},
        new AbortController().signal,
        mockFetch,
      ),
    (err) => {
      const c = classifyError(err);
      assert.equal(c.kind, 'auth');
      assert.equal(c.status, 401);
      assert.match(c.message, /Invalid API key/);
      return true;
    },
  );
  assert.deepEqual(reqBody.thinking, { type: 'disabled' });
});

test('fetchProviderModels: 按协议拉取模型并处理异常状态码', async () => {
  const okRes = await fetchProviderModels(
    { provider: 'google', apiKey: 'AIza-test', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    async (url, init) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200');
      assert.equal(init.headers['x-goog-api-key'], 'AIza-test');
      return Response.json({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    },
  );
  assert.deepEqual(okRes, { ok: true, models: ['gemini-2.5-flash'] });

  const errRes = await fetchProviderModels(
    { provider: 'openai', apiKey: 'bad' },
    async () => new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 }),
  );
  assert.equal(errRes.ok, false);
  if (!errRes.ok) assert.equal(errRes.kind, 'rate');
});

test('saveConfig 与 testConfig: 切供应商不复用旧 Key，清除后回到未配置', async () => {
  const store = new Map();
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                const value = store.get(args[0]);
                return value === undefined ? null : { value };
              },
              async run() {
                if (sql.includes('INSERT')) store.set(args[0], args[1]);
                return { success: true };
              },
            };
          },
        };
      },
    },
  };

  // 保存 DeepSeek 配置
  const saved = await saveConfig(env, { provider: 'deepseek', apiKey: 'sk-deepseek-1234', model: 'deepseek-flash', effort: 'low' });
  assert.equal(saved.configured, true);
  assert.equal(saved.provider, 'deepseek');
  assert.equal(saved.keyHint, '…1234');

  // 同供应商改模型不传 apiKey：保留原 Key
  const updated = await saveConfig(env, { provider: 'deepseek', apiKey: '', model: 'deepseek-chat' });
  assert.equal(updated.configured, true);
  assert.equal(updated.keyHint, '…1234');
  assert.equal(updated.model, 'deepseek-chat');

  // 切换到 Anthropic 但不传新 Key：不会拿 DeepSeek 的 Key 去测或保存
  const testSwitch = await testConfig(env, { provider: 'anthropic' });
  assert.equal(testSwitch.ok, false);
  assert.equal(testSwitch.kind, 'config');

  // 保存免 Key 的 Ollama，再清除
  const ollama = await saveConfig(env, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' });
  assert.equal(ollama.configured, true);
  assert.equal(ollama.provider, 'ollama');
  const cleared = await saveConfig(env, { apiKey: null });
  assert.equal(cleared.configured, false);
});

test('反代模型自动探测：裸域名回退 /v1 并返回 resolvedBaseUrl，Anthropic 兼容回退 Bearer，OpenAI 反代走 chat/completions', async () => {
  // 1) 未带 /v1 的反代根地址：/models 返回 404，自动命中 /v1/models
  const seenUrls = [];
  const res = await fetchProviderModels({ provider: 'custom-openai', apiKey: 'sk-proxy', baseUrl: 'https://relay.example.com' }, async (url) => {
    seenUrls.push(String(url));
    if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: 'my-deepseek' }] });
    return new Response('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'content-type': 'text/html' } });
  });
  assert.deepEqual(seenUrls, ['https://relay.example.com/models', 'https://relay.example.com/v1/models']);
  assert.deepEqual(res, { ok: true, models: ['my-deepseek'], resolvedBaseUrl: 'https://relay.example.com/v1' });

  // 2) Anthropic 反代拒绝 x-api-key 时自动回退 Authorization: Bearer
  const antRes = await fetchProviderModels(
    { provider: 'custom-anthropic', apiKey: 'sk-bearer', baseUrl: 'https://relay.example.com/v1' },
    async (_url, init) => {
      if (init.headers.authorization === 'Bearer sk-bearer') return Response.json({ data: [{ id: 'claude-sonnet-4-5' }] });
      return Response.json({ error: { message: 'missing bearer' } }, { status: 401 });
    },
  );
  assert.deepEqual(antRes, { ok: true, models: ['claude-sonnet-4-5'] });

  // 3) 选 OpenAI 预设但填反代域名时走 /chat/completions 而不是 /responses
  let probeUrl = '';
  const probe = await probeProviderModel(
    { provider: 'openai', apiKey: 'sk-proxy', baseUrl: 'https://relay.example.com/v1', model: 'deepseek-chat' },
    async (url) => {
      probeUrl = String(url);
      return Response.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
    },
  );
  assert.equal(probeUrl, 'https://relay.example.com/v1/chat/completions');
  assert.deepEqual(probe, { ok: true, model: 'deepseek-chat' });
});

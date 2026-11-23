import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLine,
  assistantMessage,
  configView,
  dropOldImages,
  emptyTurn,
  errorKind,
  messagesFor,
  normBaseUrl,
  parseArgs,
  reasoningParams,
  userMessage,
  type ApiMessage,
} from './deepseek.ts';

const line = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}`;

test('流式响应：思考、正文分开累积，工具调用按 index 拼接', () => {
  const turn = emptyTurn();
  assert.deepEqual(applyLine(turn, line({ reasoning_content: '先看' })), { reasoning: '先看' });
  applyLine(turn, line({ reasoning_content: '截图' }));
  applyLine(turn, line({ content: '找到' }));
  applyLine(turn, line({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'create_', arguments: '{"na' } }] }));
  applyLine(turn, line({ tool_calls: [{ index: 0, function: { name: 'subscription', arguments: 'me":"X"}' } }] }));
  applyLine(turn, line({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_categories', arguments: '' } }] }, 'tool_calls'));
  applyLine(turn, `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`);
  assert.equal(applyLine(turn, 'data: [DONE]'), null);
  assert.equal(applyLine(turn, ': keep-alive'), null);
  assert.equal(turn.reasoning, '先看截图');
  assert.equal(turn.content, '找到');
  assert.equal(turn.finish, 'tool_calls');
  assert.deepEqual(turn.usage, { prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(turn.toolCalls[0].function.name, 'create_subscription');
  assert.deepEqual(JSON.parse(turn.toolCalls[0].function.arguments), { name: 'X' });
  assert.equal(turn.toolCalls[1].id, 'c2');
  // 写回历史时必须带上 reasoning_content（带工具时 DeepSeek 要求原样回传）
  const m = assistantMessage(turn);
  assert.equal(m.role, 'assistant');
  assert.ok(m.role === 'assistant' && m.reasoning_content === '先看截图' && m.tool_calls?.length === 2);
});

test('坏的 SSE 行被忽略，不抛错', () => {
  const turn = emptyTurn();
  assert.equal(applyLine(turn, 'data: {not json'), null);
  assert.equal(turn.content, '');
});

test('用户消息：只有文字用字符串，带图片用内容数组（图片在前）', () => {
  assert.deepEqual(userMessage(' 你好 ', []), { role: 'user', content: '你好' });
  const m = userMessage('看看这张', ['data:image/png;base64,AAA']);
  assert.ok(m.role === 'user' && Array.isArray(m.content));
  assert.deepEqual(m.content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'text', text: '看看这张' },
  ]);
});

test('历史里较早的图片换成占位文字', () => {
  const h = [userMessage('a', ['data:image/png;base64,1']), { role: 'assistant' as const, content: 'ok' }, userMessage('b', ['data:image/png;base64,2'])];
  const out = dropOldImages(h, 1, '[图]');
  assert.deepEqual(out[0], { role: 'user', content: '[图]\na' });
  assert.ok(Array.isArray((out[2] as { content: unknown }).content));
  assert.deepEqual(dropOldImages(h, 0, '[图]')[2], { role: 'user', content: '[图]\nb' });
});

test('配置：不下发 Key，只给末四位；Base URL 规范化', () => {
  const v = configView({ apiKey: 'sk-abcdef1234' });
  assert.equal(v.configured, true);
  assert.equal(v.keyHint, '…1234');
  assert.ok(!JSON.stringify(v).includes('abcdef'));
  assert.equal(v.model, 'deepseek-flash');
  assert.equal(configView(undefined).configured, false);
  assert.equal(normBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normBaseUrl('https://x.example/chat/completions'), 'https://x.example');
  assert.equal(normBaseUrl(''), 'https://api.deepseek.com');
  assert.equal(normBaseUrl('/chat/completions'), 'https://api.deepseek.com');
});

test('Issue #26：OpenAI 的 Base URL 保留 /v1，请求不带 OpenAI 不认的参数', () => {
  // 去掉 /v1 后请求 https://api.openai.com/models 与 /chat/completions 都是 404
  assert.equal(normBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.equal(normBaseUrl(' https://api.openai.com/v1/ '), 'https://api.openai.com/v1');
  assert.equal(normBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
  // 旧版本存下的 https://api.openai.com 读出时补回 /v1
  assert.equal(normBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(normBaseUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  assert.equal(normBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');

  // OpenAI 对未知参数报 400：不发 thinking；非推理模型连 reasoning_effort 也不发
  const openai = 'https://api.openai.com/v1';
  assert.deepEqual(reasoningParams('none', openai, 'gpt-4.1-mini'), {});
  assert.deepEqual(reasoningParams('low', openai, 'gpt-4.1-mini'), {});
  assert.deepEqual(reasoningParams('low', 'https://api.openai.com', 'gpt-4o'), {});
  assert.deepEqual(reasoningParams('high', openai, 'o4-mini'), { reasoning_effort: 'high' });
  assert.deepEqual(reasoningParams('low', openai, 'gpt-5-mini'), { reasoning_effort: 'low' });
  assert.deepEqual(reasoningParams('low', openai, 'gpt-5-chat-latest'), {});
  assert.deepEqual(reasoningParams('none', 'https://x.cognitiveservices.azure.com/openai/v1', 'my-deploy'), {});
  assert.deepEqual(reasoningParams('none', 'https://x.openai.azure.com/openai/v1', 'o3'), {});
  assert.deepEqual(reasoningParams('low', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'), { reasoning_effort: 'low' });

  // DeepSeek、智谱 GLM、火山方舟等认 thinking 开关的服务照旧显式开关
  assert.deepEqual(reasoningParams('none', undefined, 'deepseek-flash'), { thinking: { type: 'disabled' } });
  assert.deepEqual(reasoningParams('low', 'https://api.deepseek.com/v1', 'custom'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.deepEqual(reasoningParams('none', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.6'), { thinking: { type: 'disabled' } });
  assert.deepEqual(reasoningParams('none', 'https://ark.cn-beijing.volces.com/api/v3', 'ep-2025'), { thinking: { type: 'disabled' } });

  // 换服务商后历史里的 reasoning_content 不发给严格校验的服务
  const history: ApiMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', reasoning_content: '想了想' },
  ];
  assert.deepEqual(messagesFor(openai, history), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.equal(messagesFor('https://api.deepseek.com', history), history);
});

test('工具参数与错误码', () => {
  assert.deepEqual(parseArgs(''), { args: {} });
  assert.deepEqual(parseArgs('{"a":1}'), { args: { a: 1 } });
  assert.ok(parseArgs('{oops').error);
  assert.ok(parseArgs('[1]').error);
  assert.equal(errorKind(401), 'auth');
  assert.equal(errorKind(402), 'balance');
  assert.equal(errorKind(429), 'rate');
  assert.equal(errorKind(422), 'params');
  assert.equal(errorKind(503), 'server');
});

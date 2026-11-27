// MCP 服务器：让 Codex、Claude、Cursor 等 AI 助手通过 /mcp 读写账本。
// 传输：Streamable HTTP 的无状态模式——每个 POST 是一条 JSON-RPC 请求，直接返回 JSON，不开 SSE、不保留会话。
// 鉴权：Authorization: Bearer <令牌>；令牌在后台「AI」页生成，库里只存 SHA-256，分只读 / 读写两种权限。
import { countServer } from '../telemetry.ts';
import { randomToken, sha256 } from '../auth.ts';
import type { Env } from '../env.ts';
import { getKv, getSettings, putKv } from '../store.ts';
import { TOOLS, toolTitle, connectionInfo } from './mcp-tools.ts';
import { listMcpAppResources, MCP_APP_EXTENSION_ID, MCP_APP_MIME, readMcpAppResource, toolUiMeta } from './mcp-apps.ts';
import { getPrompt, getSkill, listPrompts, listSkillResources, listSkills, PRIMARY_SKILL_URI, readSkillResource, SKILL_EXTENSION_ID } from './mcp-skills.ts';
import { MCP_CONTENT, state, type ToolCtx } from './tool-kit.ts';
import { t } from '../../shared/i18n.ts';

export interface McpToken {
  id: string;
  name: string;
  hash: string;
  /** 明文前 8 位，方便在列表里认出是哪个 */
  prefix: string;
  scope: 'read' | 'write';
  createdAt: string;
  lastUsedAt?: string;
}

const KEY = 'mcpTokens';
/** 最后使用时间单独存一个键（{令牌 id: ISO 时间}）：令牌列表只由管理接口写，鉴权时不读改写整张列表 */
const USE_KEY = 'mcpTokenUse';
const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const storedTokens = async (env: Env) => (await getKv<McpToken[]>(env, KEY)) ?? [];

/** 令牌列表（含最后使用时间）；旧版写在列表里的 lastUsedAt 作为回退 */
export async function listTokens(env: Env): Promise<McpToken[]> {
  const used = (await getKv<Record<string, string>>(env, USE_KEY)) ?? {};
  return (await storedTokens(env)).map((x) => (used[x.id] ? { ...x, lastUsedAt: used[x.id] } : x));
}

/** 新建令牌：明文只在这一次返回 */
export async function createToken(env: Env, name: string, scope: 'read' | 'write'): Promise<{ token: string; item: McpToken }> {
  const token = `sub_${randomToken(24)}`;
  const item: McpToken = {
    id: randomToken(6),
    name: name.trim().slice(0, 40) || t('mcp.defaultTokenName'),
    hash: await sha256(token),
    prefix: token.slice(0, 12),
    scope,
    createdAt: new Date().toISOString(),
  };
  await putKv(env, KEY, [...(await storedTokens(env)), item]);
  return { token, item };
}

export async function revokeToken(env: Env, id: string): Promise<void> {
  await putKv(
    env,
    KEY,
    (await storedTokens(env)).filter((x) => x.id !== id),
  );
}

/** 记下最后使用时间：单条语句只改这一个令牌的条目，不会覆盖同时发生的新建、吊销 */
const touchStmt = (env: Env, id: string, at: string) =>
  env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, json_object(?2, ?3), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = json_set(kv.value, '$.' || json_quote(?2), ?3), updated_at = excluded.updated_at",
  ).bind(USE_KEY, id, at);

/** 校验请求里的令牌；通过时顺手记下最后使用时间（同一小时内不重复写） */
async function authenticate(req: Request, env: Env): Promise<McpToken | undefined> {
  const raw = req.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!raw) return undefined;
  const hash = await sha256(raw);
  const tk = (await listTokens(env)).find((x) => x.hash === hash);
  if (!tk) return undefined;
  const now = new Date().toISOString();
  if (!tk.lastUsedAt || now.slice(0, 13) !== tk.lastUsedAt.slice(0, 13)) {
    await touchStmt(env, tk.id, now).run();
    tk.lastUsedAt = now;
  }
  return tk;
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const MCP_PLAYBOOK = [
  `Read the bundled Calends skill (${PRIMARY_SKILL_URI} via skills/list + resources/read) before complex writes or audits.`,
  'Key rules: (1) Reuse exact category names and payment method IDs from the connection JSON below (never invent unknown categories without create_category=true); (2) Search list_subscriptions before creating; preserve independent same-name accounts; (3) Record amounts in the original store currency and region; omit icon on create_subscription to auto-match common services, or call search_services/search_app_store; (4) Never do mental math on spending or carpool dues — use get_insights(section=month_report|scope_report), spending_stats, and get_carpool; (5) Preview writes with dry_run=true first; (6) For receipts/invoices, check files_enabled and use upload_file (kind=charge + date, or upload_link=true for local files).',
].join('\n');

async function handle(msg: Rpc, env: Env, token: McpToken): Promise<unknown | undefined> {
  // 通知（没有 id）只需确认收到
  if (msg.id === undefined) return undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? PROTOCOL);
      const ctx: ToolCtx = { env, access: { client: 'mcp', scope: token.scope } };
      const { st, today } = await state(ctx);
      return ok(msg.id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          extensions: {
            [SKILL_EXTENSION_ID]: {},
            [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] },
          },
        },
        serverInfo: { name: 'calends', title: t('mcp.serverTitle'), version: '1.0.0' },
        instructions: `${t('mcp.instructions')}\n${MCP_PLAYBOOK}\n${JSON.stringify(connectionInfo(ctx, st, today))}`,
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'skills/list':
      return ok(msg.id, await listSkills());
    case 'skills/get': {
      const uri = String(msg.params?.uri ?? '').trim();
      if (!uri) return fail(msg.id, -32602, t('mcp.error.invalidInput', { field: 'uri' }));
      const skill = await getSkill(uri);
      if (!skill) return fail(msg.id, -32602, t('mcp.error.invalidTarget'));
      return ok(msg.id, skill);
    }
    case 'resources/list':
      return ok(msg.id, { resources: [...listSkillResources(), ...listMcpAppResources()] });
    case 'resources/read': {
      const uri = String(msg.params?.uri ?? '').trim();
      if (!uri) return fail(msg.id, -32602, t('mcp.error.invalidInput', { field: 'uri' }));
      const res = readSkillResource(uri) ?? readMcpAppResource(uri);
      if (!res) return fail(msg.id, -32602, t('mcp.error.invalidTarget'));
      return ok(msg.id, res);
    }
    case 'prompts/list':
      return ok(msg.id, { prompts: listPrompts() });
    case 'prompts/get': {
      const name = String(msg.params?.name ?? '').trim();
      const ctx: ToolCtx = { env, access: { client: 'mcp', scope: token.scope } };
      const { st, today } = await state(ctx);
      const prompt = getPrompt(name, (msg.params?.arguments ?? {}) as Record<string, unknown>, ctx, st, today);
      if (!prompt) return fail(msg.id, -32602, t('mcp.error.invalidTarget'));
      return ok(msg.id, prompt);
    }
    case 'tools/list':
      return ok(msg.id, {
        tools: TOOLS.filter((x) => token.scope === 'write' || !x.write).map((x) => {
          const uiMeta = toolUiMeta(x.name);
          return {
            name: x.name,
            title: toolTitle(x.name),
            description: x.description,
            inputSchema: x.inputSchema,
            annotations: { readOnlyHint: !x.write, destructiveHint: !!x.destructive, idempotentHint: !x.write || !!x.idempotent, openWorldHint: false },
            ...(uiMeta ? { _meta: uiMeta } : {}),
          };
        }),
      });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = TOOLS.find((x) => x.name === name);
      if (!tool) return fail(msg.id, -32602, t('mcp.error.noTool', { name }));
      if (tool.write && token.scope !== 'write') return ok(msg.id, { isError: true, content: [{ type: 'text', text: t('mcp.error.readOnly') }] });
      await countServer(env, 'mcp.calls');
      const ctx: ToolCtx = { env, access: { client: 'mcp', scope: token.scope } };
      try {
        const out = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>, ctx);
        const blocks = (out as { [MCP_CONTENT]?: unknown[] } | null)?.[MCP_CONTENT] ?? [];
        return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }, ...blocks], structuredContent: out });
      } catch (e) {
        // 参数错误、找不到订阅这类问题作为工具结果返回，让 AI 能看到原因并改正
        return ok(msg.id, { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      return fail(msg.id, -32601, t('mcp.error.unsupportedMethod', { method: msg.method }));
  }
}

export async function mcp(req: Request, env: Env): Promise<Response> {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
    'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  // 无状态服务器不维护会话，客户端清理会话时直接返回 204
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: cors });
  // 无状态服务器不提供服务端推送流
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { ...cors, allow: 'POST, DELETE' } });
  if ((await getSettings(env)).aiEnabled === false) return Response.json(fail(null, -32002, t('mcp.error.aiDisabled')), { status: 403, headers: cors });
  const token = await authenticate(req, env);
  if (!token) return Response.json(fail(null, -32001, t('mcp.error.badToken')), { status: 401, headers: { ...cors, 'www-authenticate': 'Bearer' } });
  let body: Rpc | Rpc[];
  try {
    body = (await req.json()) as Rpc | Rpc[];
  } catch {
    return Response.json(fail(null, -32700, t('mcp.error.parse')), { status: 400, headers: cors });
  }
  const list = Array.isArray(body) ? body : [body];
  // 批量请求逐条执行：后面的写入要看到前面的结果，两个写入也不会同时读同一份旧账本
  const out: unknown[] = [];
  for (const m of list) {
    const r = await handle(m, env, token);
    if (r !== undefined) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { ...cors, 'cache-control': 'no-store' } });
}

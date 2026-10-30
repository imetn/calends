import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { copyParts } from '../components/copy.tsx';
import { base } from '../base.ts';
import { useEffect, useState } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { CardTitle, Toolbar } from '../components/ui.tsx';
import { LoadFailed, Sheet } from '../components/overlays.tsx';
import { Icon } from '../components/icons.tsx';
import { Toggle } from '../components/inputs.tsx';
import { ChartPie, Eye, KeyRound, Layers, PencilLine, ReceiptText, Settings2, Shapes, Tags, Users, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, saveSettings } from '../store.ts';
import { copyText, run } from '../toast.ts';
import { localTime } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';

interface Token {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  createdAt: string;
  lastUsedAt?: string;
}
interface ToolMeta {
  name: string;
  title?: string;
  description: string;
  write: boolean;
}

// 只调整展示顺序和分组，工具仍全部来自接口；未匹配的新工具归到「其他」
const TOOL_DOMAINS: Array<{ key: string; icon: LucideIcon; test: RegExp }> = [
  { key: 'overview', icon: ChartPie, test: /overview|stats|trends|insights/ },
  { key: 'subs', icon: Layers, test: /subscription|price|plan|status|events/ },
  { key: 'charges', icon: ReceiptText, test: /charges|payment$|transfer/ },
  { key: 'wallet', icon: Wallet, test: /payment_method/ },
  { key: 'people', icon: Users, test: /people|person|carpool|share|proxy|receivable/ },
  { key: 'categories', icon: Tags, test: /categor/ },
  { key: 'settings', icon: Settings2, test: /settings/ },
];
const OTHER = { key: 'other', icon: Shapes, test: /$^/ };
const toolDomain = (name: string) => TOOL_DOMAINS.find((d) => d.test.test(name)) ?? OTHER;

/** 一个接入客户端：标志、配置写在哪、配置内容；有官方一键安装链接的也给出来 */
interface Client {
  id: string;
  name: string;
  logo: string;
  /** 单色标志：跟随文字颜色（深色主题、主按钮上都看得清） */
  mono?: boolean;
  /** 标志本身是带底色的应用图标，按圆角方块显示 */
  tile?: boolean;
  /** 代码块的语言提示（只用来显示角标） */
  lang: 'shell' | 'json' | 'yaml' | 'http';
  /** 配置放在哪里（文件路径或操作位置） */
  where: () => string;
  snippet: (url: string, token: string) => string;
  /** 一键安装（深链），需要真实令牌 */
  install?: (url: string, token: string) => string;
  experimental?: boolean;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    logo: base('/ai/claude.svg'),
    lang: 'shell',
    where: () => t('ai.where.terminal'),
    snippet: (url, tk) => `claude mcp add --transport http calends ${url} \\\n  --header "Authorization: Bearer ${tk}"`,
  },
  {
    id: 'codex',
    name: 'Codex',
    logo: base('/ai/openai.svg'),
    mono: true,
    lang: 'shell',
    where: () => t('ai.where.codex'),
    snippet: (url, tk) => `export CALENDS_TOKEN=${tk}\ncodex mcp add calends --url ${url} --bearer-token-env-var CALENDS_TOKEN`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    logo: base('/ai/cursor.svg'),
    mono: true,
    lang: 'json',
    where: () => t('ai.where.file', { path: '~/.cursor/mcp.json' }),
    snippet: (url, tk) => json({ mcpServers: { calends: { url, headers: { Authorization: `Bearer ${tk}` } } } }),
    install: (url, tk) =>
      `cursor://anysphere.cursor-deeplink/mcp/install?name=calends&config=${encodeURIComponent(b64(JSON.stringify({ url, headers: { Authorization: `Bearer ${tk}` } })))}`,
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    logo: base('/ai/claude.svg'),
    lang: 'json',
    where: () => t('ai.where.file', { path: 'claude_desktop_config.json' }),
    snippet: (url, tk) => json({ mcpServers: { calends: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${tk}`] } } }),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    logo: base('/ai/gemini.svg'),
    lang: 'shell',
    where: () => t('ai.where.terminal'),
    snippet: (url, tk) => `gemini mcp add --transport http calends ${url} \\\n  --header "Authorization: Bearer ${tk}"`,
  },
  {
    id: 'grokbot',
    name: 'Grok Bot',
    logo: base('/ai/grokbot.png'),
    tile: true,
    lang: 'yaml',
    where: () => t('ai.where.grokbot'),
    snippet: (url, tk) => `name: calends\nurl: ${url}\nheaders:\n  Authorization: Bearer ${tk}`,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: base('/ai/deepseek.svg'),
    lang: 'yaml',
    experimental: true,
    where: () => t('ai.where.file', { path: '~/.dsh/profiles/web/cordis.patch.yml' }),
    snippet: (url, tk) =>
      `- insert:\n    - id: mcp-calends\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: calends\n        transport: streamable-http\n        url: ${url}\n        headers:\n          Authorization: 'Bearer ${tk}'`,
  },
  {
    id: 'http',
    name: '',
    logo: '',
    lang: 'http',
    where: () => t('ai.where.http'),
    snippet: (url, tk) => `POST ${url}\nAuthorization: Bearer ${tk}\nContent-Type: application/json\n\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
  },
];

const copy = (text: string, what = t('ai.copied')) => copyText(text, what);

function ClientLogo({ c, size = 28 }: { c: Client; size?: number }) {
  return (
    <span className="ai-logo" style={{ width: size, height: size }}>
      {!c.logo ? (
        <Icon name="link" size={size * 0.7} />
      ) : c.mono ? (
        <i style={{ maskImage: `url(${c.logo})`, WebkitMaskImage: `url(${c.logo})` }} />
      ) : (
        <img src={c.logo} alt="" className={c.tile ? 'tile' : undefined} />
      )}
    </span>
  );
}

/** 一段可复制的代码：右上角是复制按钮，左上角是语言角标 */
function CodeBlock({ code, lang, onCopy }: { code: string; lang: string; onCopy: () => void }) {
  return (
    <div className="ai-code">
      <div className="ai-code-bar">
        <span>{lang}</span>
        <button type="button" className="ai-copy" onClick={onCopy}>
          <Icon name="copy" size={14} /> {t('ai.copy')}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

/**
 * 接入面板：选客户端 → 看放在哪 → 一键复制（已有新令牌时代码里直接带上令牌）。
 * 令牌只在生成时出现一次，所以没有新令牌时代码里是占位符，并提供「为它生成令牌」。
 */
function Connect({
  url,
  token,
  client,
  setClient,
  onCreate,
}: {
  url: string;
  token?: { token: string; item: Token };
  client: string | null;
  setClient: (id: string | null) => void;
  onCreate?: (name: string) => void;
}) {
  const c = CLIENTS.find((x) => x.id === client);
  const stepsId = token ? 'ai-fresh-steps' : 'ai-steps';
  const name = c?.name || t('ai.clientOther');
  const code = c?.snippet(url, token?.token ?? t('ai.tokenPlaceholder')) ?? '';
  // 直接发给 AI 助手的一段话：说明要做什么、放在哪、具体配置，最后让它自己验证
  const prompt = t('ai.agentPrompt', { name, where: c?.where() ?? '', code, verify: 'get_overview' });
  return (
    <div className="ai-connect">
      <div className="ai-clients" role="group" aria-label={t('ai.pickClient')}>
        {CLIENTS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-expanded={x.id === c?.id}
            aria-controls={x.id === c?.id ? stepsId : undefined}
            className={`ai-client ${x.id === c?.id ? 'on' : ''}`}
            onClick={() => setClient(client === x.id ? null : x.id)}
          >
            <ClientLogo c={x} />
            <span>{x.name || t('ai.clientOther')}</span>
          </button>
        ))}
      </div>
      {c && (
        <ol id={stepsId} className="ai-steps">
          <li>
            <b>{t('ai.step.token')}</b>
            {token ? (
              <span className="ai-step-ok">
                <Icon name="check" size={14} /> {t('ai.step.tokenReady', { name: token.item.name })}
              </span>
            ) : onCreate ? (
              <span>
                {t('ai.step.tokenNeeded')}{' '}
                <button type="button" className="btn plain" onClick={() => onCreate(name)}>
                  {t('ai.step.createFor', { name })}
                </button>
              </span>
            ) : null}
          </li>
          <li className="ai-step-code">
            <b>
              {t('ai.step.send', { name })}
              {c.experimental && <span className="badge">{t('ai.experimental')}</span>}
            </b>
            <CodeBlock code={prompt} lang={t('ai.promptLabel')} onCopy={() => copy(prompt, token ? t('ai.copiedWithToken') : t('ai.copied'))} />
            <span className="ai-step-actions">
              {token && c.install && (
                <a className="btn primary ai-install" href={c.install(url, token.token)}>
                  <ClientLogo c={c} size={18} /> {t('ai.installIn', { name })}
                </a>
              )}
              <button type="button" className="btn plain" onClick={() => copy(code, t('ai.configCopied'))}>
                <Icon name="copy" size={14} /> {t('ai.copyConfigOnly')}
              </button>
            </span>
          </li>
        </ol>
      )}
    </div>
  );
}

/**
 * AI 接入：把账本以 MCP 服务的形式开放给 AI 助手。
 * 这里不做聊天，只负责开关、令牌和各家客户端的接入方式；AI 助手拿到令牌后，用自己的对话来查询、记账。
 */
export function Ai({ state }: { state: AppState }) {
  const url = `${location.origin}${base('/mcp')}`;
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [client, setClient] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  // 原始令牌只存在于首次展示的弹层中，关闭即丢弃。
  const [fresh, setFresh] = useState<{ token: string; item: Token } | null>(null);
  const [showTools, setShowTools] = useState(false);
  const ro = !!state.readonly;
  const enabled = state.settings.aiEnabled !== false;
  const [failed, setFailed] = useState({ tokens: false, tools: false });
  const load = () =>
    api<Token[]>('/api/mcp/tokens').then(
      (list) => {
        setTokens(list);
        setFailed((f) => ({ ...f, tokens: false }));
      },
      () => setFailed((f) => ({ ...f, tokens: true })),
    );
  const loadTools = () =>
    api<ToolMeta[]>('/api/mcp/tools').then(
      (list) => {
        setTools(list);
        setFailed((f) => ({ ...f, tools: false }));
      },
      () => setFailed((f) => ({ ...f, tools: true })),
    );
  useEffect(() => {
    void load();
    void loadTools();
  }, []);
  const when = (iso?: string) => (iso ? localTime(iso, state.settings.timezone) : t('ai.neverUsed'));
  // 按领域分组，组内先读后写；读写用图标区分（参考 GitHub 细粒度令牌的权限列表）
  const groups = [...TOOL_DOMAINS, OTHER]
    .map((d) => ({ ...d, list: tools.filter((x) => toolDomain(x.name) === d).sort((a, b) => Number(a.write) - Number(b.write)) }))
    .filter((g) => g.list.length);
  const readCount = tools.filter((x) => !x.write).length;

  return (
    <>
      <Toolbar title={t('ai.title')}>
        {!ro && (
          <button className="btn primary" onClick={() => setCreating(CLIENTS.find((x) => x.id === client)?.name || 'AI')}>
            <Icon name="plus" /> {t('ai.newToken')}
          </button>
        )}
      </Toolbar>
      <div className="page fade-in ai-page">
        {/* 状态与地址 */}
        <div className={`ai-status ${enabled ? 'on' : ''}`}>
          {/* 开关已表示正常启用状态，只额外提示停用。 */}
          <div className="ai-status-l">
            <b className="icon-text">
              {t('settings.open.ai')}
              {!enabled && <span className="ai-badge">{t('settings.open.off')}</span>}
            </b>
            <small className="m-hide">{enabled ? t('ai.status.onHint') : t('ai.status.offHint')}</small>
          </div>
          {!ro && <Toggle checked={enabled} label={t('ai.title')} onChange={(v) => run(() => saveSettings({ aiEnabled: v }))} />}
        </div>
        <button type="button" className="ai-endpoint" onClick={() => copy(url, t('ai.urlCopied'))} title={t('ai.copy')}>
          <span>{t('ai.mcpUrl')}</span>
          <code>{url}</code>
          <Icon name="copy" size={15} />
        </button>

        <section className="ai-card">
          <header>
            <CardTitle as="h2">{t('ai.setup')}</CardTitle>
          </header>
          <Connect url={url} client={client} setClient={setClient} onCreate={ro ? undefined : (name) => setCreating(name)} />
        </section>

        <section className="ai-card">
          <header>
            <CardTitle as="h2">{copyParts(t('ai.tokens', { count: tokens?.length ?? 0 }))}</CardTitle>
          </header>
          {failed.tokens && !tokens && <LoadFailed onRetry={() => void load()} />}
          {tokens?.length === 0 && <div className="ai-empty">{t('ai.noTokens')}</div>}
          {!!tokens?.length && (
            // 密钥列表参考 Stripe、OpenAI、Vercel 的 API Keys：名称与权限、遮蔽后的密钥、创建和最近使用分列对齐，操作收进行尾图标
            <div className="ai-tokens" role="table">
              <div className="ai-token ai-token-head m-hide" role="row">
                <span role="columnheader">{t('ai.col.name')}</span>
                <span role="columnheader">{t('ai.col.key')}</span>
                <span role="columnheader">{t('ai.col.created')}</span>
                <span role="columnheader">{t('ai.col.lastUsed')}</span>
                <span />
              </div>
              {tokens.map((tk) => (
                <div key={tk.id} className="ai-token" role="row">
                  <span className="ai-token-name" role="cell">
                    <span className="ai-token-ico" aria-hidden>
                      <KeyRound size={15} />
                    </span>
                    <b>{tk.name}</b>
                    <span className={`ai-scope ${tk.scope}`}>
                      {tk.scope === 'write' ? <PencilLine size={12} /> : <Eye size={12} />}
                      {tk.scope === 'write' ? t('ai.scope.write') : t('ai.scope.read')}
                    </span>
                  </span>
                  <code className="ai-token-key" role="cell">
                    {tk.prefix}
                    <span aria-hidden>••••••••</span>
                  </code>
                  <span className="ai-token-when created" role="cell">
                    <small>{t('ai.col.created')}</small>
                    {localTime(tk.createdAt, state.settings.timezone, true)}
                  </span>
                  <span className={`ai-token-when used ${tk.lastUsedAt ? '' : 'never'}`} role="cell">
                    <small>{t('ai.col.lastUsed')}</small>
                    {when(tk.lastUsedAt)}
                  </span>
                  <span className="ai-token-act" role="cell">
                    {!ro && (
                      <ConfirmButton
                        hint={t('ai.confirmRevoke', { name: tk.name })}
                        onConfirm={() =>
                          run(async () => {
                            await api(`/api/mcp/tokens/${tk.id}`, { method: 'DELETE' });
                            if (fresh?.item.id === tk.id) setFresh(null);
                            await load();
                          }, t('ai.revoked'))
                        }
                      >
                        {t('ai.revoke')}
                      </ConfirmButton>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="ai-card">
          <button type="button" className="ai-tools-toggle" onClick={() => setShowTools(!showTools)} aria-expanded={showTools}>
            <span className="row">
              {/* 读写数量紧跟在总数后面，不单独占一行 */}
              <span className="ai-tools-title">
                <CardTitle as="h2">{copyParts(t('ai.tools', { count: tools.length }))}</CardTitle>
                <span className="ai-tools-legend">
                  <span>
                    <Eye size={14} /> {t('ai.toolsRead')} <span className="copy-gap" aria-hidden="true" /> {readCount}
                  </span>
                  <span className="write">
                    <PencilLine size={14} /> {t('ai.toolsWrite')} <span className="copy-gap" aria-hidden="true" /> {tools.length - readCount}
                  </span>
                </span>
              </span>
              <Icon name="down" size={16} />
            </span>
          </button>
          {failed.tools && !tools.length && <LoadFailed onRetry={() => void loadTools()} />}
          {showTools && (
            <>
              <div className="ai-tools">
                {groups.map(({ key, icon: DomainIcon, list }) => (
                  <section key={key} className="ai-tool-group">
                    <h3>
                      <DomainIcon size={15} />
                      {t(`ai.domain.${key}`)}
                      <small>{list.length}</small>
                    </h3>
                    <div className="ai-tool-list">
                      {list.map((tool) => (
                        <div key={tool.name} className={`ai-tool ${tool.write ? 'write' : ''}`}>
                          <span className="ai-tool-ico" title={tool.write ? t('ai.toolsWrite') : t('ai.toolsRead')}>
                            {tool.write ? <PencilLine size={13} /> : <Eye size={13} />}
                          </span>
                          <b>{tool.title ?? tool.name}</b>
                          <code>{tool.name}</code>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {creating !== null && (
        <NewToken
          initialName={creating}
          onClose={() => setCreating(null)}
          onCreated={(r) => {
            setFresh(r);
            setCreating(null);
            load();
          }}
        />
      )}
      {fresh && (
        <Sheet
          title={t('ai.created.title')}
          onClose={() => setFresh(null)}
          foot={
            <>
              <span className="grow" />
              <button className="btn primary" onClick={() => setFresh(null)}>
                {t('ai.created.saved')}
              </button>
            </>
          }
        >
          <div className="stack">
            <div className="ai-fresh">
              <div className="ai-fresh-head">
                <b>{fresh.item.name}</b>
                <span className={`ai-scope ${fresh.item.scope}`}>{fresh.item.scope === 'write' ? t('ai.scope.write') : t('ai.scope.read')}</span>
              </div>
              <CodeBlock code={fresh.token} lang="token" onCopy={() => copy(fresh.token, t('ai.created.tokenCopied'))} />
              <p className="ai-warn">
                <Icon name="key" size={14} /> {t('ai.created.foot')}
              </p>
            </div>
            <Connect url={url} token={fresh} client={client} setClient={setClient} />
          </div>
        </Sheet>
      )}
    </>
  );
}

function NewToken({ initialName, onClose, onCreated }: { initialName: string; onClose: () => void; onCreated: (r: { token: string; item: Token }) => void }) {
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<'write' | 'read'>('write');
  const create = () =>
    run(async () => {
      onCreated(await api<{ token: string; item: Token }>('/api/mcp/tokens', { method: 'POST', body: JSON.stringify({ name, scope }) }));
    });
  return (
    <Sheet
      narrow
      title={t('ai.newToken')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('ai.cancel')}
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={create}>
            {t('ai.generate')}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="ai-field">
          <span>{t('ai.name')}</span>
          <input value={name} placeholder={t('ai.namePlaceholder')} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <div className="ai-scopes" role="radiogroup" aria-label={t('ai.scope.label')}>
          {(['write', 'read'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={`ai-scope-card ${scope === s ? 'on' : ''}`}
              onClick={() => setScope(s)}
            >
              <span className="ai-radio" />
              <span>
                <b>{s === 'write' ? t('ai.scope.write') : t('ai.scope.read')}</b>
                <small>{s === 'write' ? t('ai.scope.writeDesc') : t('ai.scope.readDesc')}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

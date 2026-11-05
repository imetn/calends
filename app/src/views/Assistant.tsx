import { base } from '../base.ts';
import type { ReactNode } from 'react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CircleCheck,
  CircleX,
  Clock,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  RotateCcw,
  Settings2,
  Square,
  SquarePen,
  Wrench,
  X,
} from 'lucide-react';
import { locale, t } from '../../../shared/i18n.ts';
import { confirmInOrder, type WriteVerification } from '../../../shared/assistant-result.ts';
import type { ApiMessage, AssistantConfigView, ErrorKind } from '../../../shared/deepseek.ts';
import { dropOldImages } from '../../../shared/deepseek.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { IconButton, Toolbar } from '../components/ui.tsx';
import { api, getState, refresh } from '../store.ts';
import { copyText, toast } from '../toast.ts';
import { newSub } from './editor/new-sub.ts';
import { interrupted } from './assistant-fields.ts';
import { compressImage as compress, takeHandoff } from '../handoff.ts';
import './assistant.css';
import { Streamdown, type Components } from 'streamdown';
import type { Part } from './assistant-chat.ts';
import type { ChatTurn } from './assistant-chat.ts';
import type { Saved } from './assistant-chat.ts';
import { rid } from './assistant-chat.ts';
import { newChat } from './assistant-chat.ts';
import { forServer } from './assistant-chat.ts';
import { load } from './assistant-chat.ts';
import { persist } from './assistant-chat.ts';
import type { ServerEvent } from './assistant-chat.ts';
import { stream } from './assistant-chat.ts';
import { reduce } from './assistant-chat.ts';
import { Proposal } from './AssistantProposal.tsx';
import { SetupSheet } from './AssistantSetup.tsx';

/** 对话分隔线上的时间：今年的不写年份 */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- 页面 ----------
export function Assistant({ state, today, onOpen, switcher }: { state: AppState; today: string; onOpen: (s: Subscription) => void; switcher?: ReactNode }) {
  const [cfg, setCfg] = useState<AssistantConfigView | null>(null);
  const [setup, setSetup] = useState(false);
  const [chat, setChat] = useState<Saved>(load);
  // 以前的对话（服务端）：显示在当前对话上面，往上翻就能看到；只读
  const [past, setPast] = useState<Saved[]>([]);
  // 历史记录加载完才显示欢迎语：加载前后滚动位置不同，提前显示会先出现在一处再跳到另一处
  const [pastLoaded, setPastLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => {
    void api<AssistantConfigView>('/api/assistant/config').then(setCfg, () => setCfg(null));
  }, []);
  useEffect(() => persist(chat), [chat]);
  // 离开助手页时中止进行中的回复，不在后台继续消耗
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    void api<Saved[]>('/api/assistant/chats')
      .then(
        (list) => setPast(list.filter((c) => c.turns?.length)),
        () => {},
      )
      .finally(() => setPastLoaded(true));
  }, []);
  // 每轮回复结束后存到服务端（流式过程中不存）；其他设备也能看到
  useEffect(() => {
    if (busy || !chat.turns.length) return;
    const h = setTimeout(() => void api(`/api/assistant/chats/${chat.id}`, { method: 'PUT', body: JSON.stringify(forServer(chat)) }).catch(() => {}), 600);
    return () => clearTimeout(h);
  }, [chat, busy]);
  const shownPast = past.filter((c) => c.id !== chat.id);
  // 别处（新建订阅表单）带着文字或图片跳过来：放进输入框
  useEffect(() => {
    const h = takeHandoff();
    if (h) composer.current?.prefill(h.text, h.images);
  }, []);

  // 有历史时，当前对话至少占满一屏（顶栏与输入框之间）：滚到底就是一段全新的对话，往上翻才看到历史
  const [fill, setFill] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      // 顶栏只在吸顶时（窄屏）占可视高度；分割线留在可视区最上方
      const tb = document.querySelector<HTMLElement>('.toolbar');
      const bar = tb && getComputedStyle(tb).position === 'sticky' ? tb.getBoundingClientRect().height : 0;
      const dock = document.querySelector('.as-composer')?.getBoundingClientRect().height ?? 0;
      setFill(Math.max(0, window.innerHeight - bar - dock - 24));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [chat.id, !chat.turns.length]);

  // 新内容到来时贴着底部滚；用户往上翻了就不打扰，显示「回到底部」
  useLayoutEffect(() => {
    if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [chat, atBottom, fill, past]);
  // 布局完成后直接校正滚动位置，不把受滚动影响的坐标反写为高度。
  // 浏览器缩放或滚动尚未完成时，反复 setFill 会形成同步更新循环。
  const session = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!atBottom) return;
    const frame = requestAnimationFrame(() => {
      const head = session.current?.querySelector('.as-past-head');
      if (!head) return;
      const tb = document.querySelector<HTMLElement>('.toolbar');
      const top = tb && getComputedStyle(tb).position === 'sticky' ? tb.getBoundingClientRect().bottom : 0;
      const d = head.getBoundingClientRect().top - (top + 12);
      if (Math.abs(d) > 1) window.scrollTo({ top: window.scrollY + d, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [fill, past, chat.id, atBottom]);
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      setAtBottom(el.scrollHeight - window.scrollY - window.innerHeight < 120);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const send = async (text: string, images: string[], history = chat.history, base = chat.turns) => {
    if (busy || (!text.trim() && !images.length)) return;
    const user: ChatTurn = { id: rid(), role: 'user', text, images, at: history.length };
    let bot: Extract<ChatTurn, { role: 'assistant' }> = { id: rid(), role: 'assistant', parts: [], status: 'streaming' };
    setChat((c) => ({ ...c, history, turns: [...base, user, bot] }));
    setAtBottom(true);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    let added: ApiMessage[] | null = null;
    try {
      const on = (e: ServerEvent) => {
        bot = reduce(bot, e);
        if (e.type === 'done') added = e.messages;
        setChat((c) => ({ ...c, turns: c.turns.map((x) => (x.id === bot.id ? bot : x)) }));
      };
      // 服务端只看最新一条的图片；旧图不再上传，否则连纯文字提问也可能超出请求体上限
      await stream({ history: dropOldImages(history, 0), text, images }, ctrl.signal, on);
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      bot = aborted
        ? { ...bot, status: 'stopped' }
        : { ...bot, status: 'error', error: { kind: ((err as { kind?: ErrorKind }).kind ?? 'network') as ErrorKind, message: (err as Error).message } };
      setChat((c) => ({ ...c, turns: c.turns.map((x) => (x.id === bot.id ? bot : x)) }));
    } finally {
      // 成功（或中途停止）才把这轮写进历史；出错的这轮不进历史，重试时原样再发
      const done = added as ApiMessage[] | null;
      if (done) setChat((c) => ({ ...c, history: [...history, ...done] }));
      // 连接结束却没收到 done（服务端或网络中途断开）：记为中断，可以重试，不当作已完成
      if (bot.status === 'streaming') {
        const cut = interrupted(bot);
        setChat((c) => ({ ...c, turns: c.turns.map((x) => (x.id === bot.id ? cut : x)) }));
      }
      setBusy(false);
      abort.current = null;
    }
  };

  /** 重试 / 重新生成：去掉最后一问一答，用原来的内容和当时的历史再发一次 */
  const retry = () => {
    const i = chat.turns.map((x) => x.role).lastIndexOf('user');
    const u = chat.turns[i];
    if (!u || u.role !== 'user') return;
    void send(u.text, u.images, chat.history.slice(0, u.at), chat.turns.slice(0, i));
  };

  const setPart = (turnId: string, partId: string, patch: Partial<Extract<Part, { kind: 'proposal' }>>) =>
    setChat((c) => ({
      ...c,
      turns: c.turns.map((x) =>
        x.id === turnId && x.role === 'assistant'
          ? { ...x, parts: x.parts.map((p) => (p.kind === 'proposal' && p.id === partId ? { ...p, ...patch } : p)) }
          : x,
      ),
    }));

  /** 确认草稿：同一个 MCP 工具真正执行；结果作为备注写进历史，模型下一轮就知道已经加上了 */
  const applyProposal = async (turnId: string, p: Extract<Part, { kind: 'proposal' }>) => {
    if (confirmingRef.current) return false;
    confirmingRef.current = true;
    setConfirming(true);
    const retrying = p.state === 'error';
    setPart(turnId, p.id, { state: 'applying', error: undefined });
    try {
      // Legacy failed creates may already have committed. Read first and require review, never create them twice.
      if (retrying) {
        await refresh();
        const id = p.tool === 'create_subscription' && typeof p.args.id === 'string' ? p.args.id : undefined;
        const existing = id ? getState().subscriptions.find((s) => s.id === id) : undefined;
        if (existing) {
          setPart(turnId, p.id, { state: 'unverified', subId: existing.id, error: t('assistant.savedUnverified') });
          return false;
        }
      }
      const r = await api<{ subscription?: { id: string; name: string }; verification?: WriteVerification }>('/api/assistant/apply', {
        method: 'POST',
        body: JSON.stringify({ tool: p.tool, args: p.args }),
      });
      const verified = r.verification?.status === 'verified';
      setPart(turnId, p.id, {
        state: verified ? 'applied' : 'unverified',
        subId: r.subscription?.id,
        error: verified ? undefined : t('assistant.savedUnverified'),
      });
      setChat((c) => ({
        ...c,
        history: [
          ...c.history,
          {
            role: 'user',
            content: `[note] The user confirmed ${p.tool} for "${String(p.args.name ?? r.subscription?.name ?? '')}". Saved; read-back ${verified ? 'verified' : 'not verified; check the ledger before retrying'}.`,
          },
        ],
      }));
      try {
        await refresh();
      } catch {
        toast(t('assistant.savedRefreshFailed'));
        return false;
      }
      if (verified) toast(t('assistant.applied'));
      return verified;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const uncertain = status == null || status >= 500;
      setPart(turnId, p.id, { state: uncertain ? 'unverified' : 'error', error: uncertain ? t('assistant.saveUnknown') : (e as Error).message });
      return false;
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  /** 全部确认：同一轮的草稿按出现顺序逐张执行（后面的可能依赖前面的，例如先建订阅再加成员） */
  const applyAll = async (turnId: string) => {
    const turn = chat.turns.find((x) => x.id === turnId);
    if (turn?.role !== 'assistant') return;
    if (turn.outcome && turn.outcome.status !== 'complete') return;
    if (turn.parts.some((p) => p.kind === 'proposal' && p.state === 'unverified')) return;
    await confirmInOrder(
      turn.parts.filter((p): p is Extract<Part, { kind: 'proposal' }> => p.kind === 'proposal' && (p.state === 'pending' || p.state === 'error')),
      (p) => applyProposal(turnId, p),
    );
  };

  /** 编辑后再添加：用草稿填好新建表单 */
  const editProposal = (p: Extract<Part, { kind: 'proposal' }>) => {
    const a = p.args;
    const cyc = (a.cycle ?? {}) as { unit?: Subscription['cycle']['unit']; every?: number };
    const draft: Subscription = {
      ...newSub(
        String(a.start ?? today),
        state.methods.find((m) => m.id === a.method || m.name === a.method)?.id ?? state.settings.defaultMethodId,
        String(a.currency ?? state.settings.baseCurrency),
      ),
      name: String(a.name ?? ''),
      price: Number(a.price ?? 0),
      cycle: { unit: cyc.unit ?? 'month', every: Number(cyc.every ?? 1) },
      ...(a.category ? { category: String(a.category) } : {}),
      ...(a.region ? { region: String(a.region).toUpperCase() } : {}),
      ...(a.url ? { url: String(a.url) } : {}),
      ...(a.icon ? { icon: String(a.icon) } : {}),
      ...(a.notes ? { notes: String(a.notes) } : {}),
      ...(a.account ? { account: String(a.account) } : {}),
      ...(a.status === 'trial' ? { status: 'trial' as const } : {}),
      ...(a.trial_end ? { trialEnd: String(a.trial_end) } : {}),
      ...(Array.isArray(a.payments) && a.payments.length
        ? { payments: (a.payments as Array<{ date: string; amount: number; note?: string }>).map((x) => ({ date: x.date, amount: x.amount, note: x.note })) }
        : {}),
    };
    window.dispatchEvent(new CustomEvent('ledger:add', { detail: draft }));
  };

  /** 新对话：只是开新的一段，之前的留在上面（服务端也还在）；真正清空在设置里 */
  const reset = () => {
    abort.current?.abort();
    if (chat.turns.length) setPast((p) => [...p.filter((c) => c.id !== chat.id), chat]);
    setChat(newChat());
    setAtBottom(true);
  };

  const empty = !chat.turns.length;
  const noop = () => {};
  const ready = !!cfg?.configured;
  return (
    <>
      <Toolbar title={t('assistant.title')} switcher={switcher}>
        <span className="as-tb">
          {!empty && (
            <IconButton onClick={reset} title={t('assistant.new')} aria-label={t('assistant.new')}>
              <SquarePen size={16} />
            </IconButton>
          )}
          <IconButton onClick={() => setSetup(true)} title={t('assistant.settings')} aria-label={t('assistant.settings')}>
            <Settings2 size={16} />
          </IconButton>
        </span>
      </Toolbar>
      <div className="as">
        <div className="as-scroll">
          <div className="as-col">
            {shownPast.map((c) => (
              <div key={c.id} className="as-past">
                <div className="as-past-head">{fmtWhen(c.createdAt)}</div>
                {c.turns.map((turn) =>
                  turn.role === 'user' ? (
                    <UserBubble key={turn.id} turn={turn} />
                  ) : (
                    <BotMessage
                      key={turn.id}
                      turn={turn.status === 'streaming' ? { ...turn, status: 'stopped' } : turn}
                      state={state}
                      last={false}
                      confirming={confirming}
                      onSetup={() => setSetup(true)}
                      onApply={noop}
                      onEdit={noop}
                      onDismiss={noop}
                      onApplyAll={noop}
                      onOpen={(id) => {
                        const s = state.subscriptions.find((x) => x.id === id);
                        if (s) onOpen(s);
                      }}
                    />
                  ),
                )}
              </div>
            ))}
            <section ref={session} className={`as-session ${shownPast.length ? 'fresh' : ''}`} style={shownPast.length ? { minHeight: fill } : undefined}>
              {shownPast.length > 0 && <div className="as-past-head">{fmtWhen(chat.createdAt)}</div>}
              {empty
                ? pastLoaded && <Welcome ready={ready} cfg={cfg} onSetup={() => setSetup(true)} />
                : chat.turns.map((turn, i) =>
                    turn.role === 'user' ? (
                      <UserBubble key={turn.id} turn={turn} />
                    ) : (
                      <BotMessage
                        key={turn.id}
                        turn={turn}
                        state={state}
                        last={i === chat.turns.length - 1}
                        confirming={confirming}
                        onRetry={retry}
                        onSetup={() => setSetup(true)}
                        onApply={(p) => void applyProposal(turn.id, p)}
                        onEdit={editProposal}
                        onDismiss={(p) => setPart(turn.id, p.id, { state: 'dismissed' })}
                        onApplyAll={() => void applyAll(turn.id)}
                        onOpen={(id) => {
                          const s = state.subscriptions.find((x) => x.id === id);
                          if (s) onOpen(s);
                        }}
                      />
                    ),
                  )}
            </section>
          </div>
        </div>
        {!atBottom && (
          <IconButton className="as-bottom" onClick={() => setAtBottom(true)} aria-label={t('assistant.toBottom')}>
            <ArrowDown size={16} />
          </IconButton>
        )}
        <Composer
          ref={composer}
          above={empty && ready ? <Suggestions onPick={(x) => (x.send ? void send(x.text, []) : composer.current?.prefill(x.text))} /> : undefined}
          busy={busy}
          disabled={!ready}
          model={cfg?.model}
          onSend={(text, imgs) => void send(text, imgs)}
          onStop={() => abort.current?.abort()}
          onSettings={() => setSetup(true)}
          onReset={empty ? undefined : reset}
        />
      </div>
      {setup && (
        <SetupSheet
          cfg={cfg}
          onClose={() => setSetup(false)}
          onSaved={setCfg}
          onClearChats={() => {
            abort.current?.abort();
            setPast([]);
            setChat(newChat());
          }}
        />
      )}
    </>
  );
}

// ---------- 空状态（对应 AI Elements 的 ConversationEmptyState）与建议（Suggestions） ----------
export const SUGGESTIONS: Array<{ key: string; send: boolean }> = [
  { key: 'receipt', send: false },
  { key: 'screenshot', send: false },
  { key: 'month', send: true },
  { key: 'hikes', send: true },
];

/** 欢迎语随机轮换一套场景示例；标题与描述都做轻，只作提示 */
export const WELCOME_COUNT = 20;

export function Welcome({ ready, cfg, onSetup }: { ready: boolean; cfg: AssistantConfigView | null; onSetup: () => void }) {
  const [n] = useState(() => Math.floor(Math.random() * WELCOME_COUNT) + 1);
  return (
    <div className="as-welcome">
      <img className="as-orb" src={base('/icons/logo.svg')} alt="" />
      <h2>{t(`assistant.welcome.variants.v${n}.title`)}</h2>
      <p>{t(`assistant.welcome.variants.v${n}.body`)}</p>
      {!ready && cfg && (
        <button className="as-setup-cta" onClick={onSetup}>
          <KeyRound size={16} />
          <span>
            <b>{t('assistant.setup.cta')}</b>
          </span>
        </button>
      )}
    </div>
  );
}

/** 输入框上方一排可横向滑动的建议（窄屏换行） */
export function Suggestions({ onPick }: { onPick: (s: { text: string; send: boolean }) => void }) {
  return (
    <div className="as-suggest">
      {SUGGESTIONS.map((s) => (
        <button key={s.key} title={t(`assistant.suggest.${s.key}.hint`)} onClick={() => onPick({ text: t(`assistant.suggest.${s.key}.text`), send: s.send })}>
          {t(`assistant.suggest.${s.key}.title`)}
        </button>
      ))}
    </div>
  );
}

// ---------- 消息 ----------
export function UserBubble({ turn }: { turn: Extract<ChatTurn, { role: 'user' }> }) {
  return (
    <div className="as-user">
      {turn.images.length > 0 && (
        <div className="as-user-imgs">
          {turn.images.map((src, i) => (
            <img key={i} src={base(src)} alt="" />
          ))}
        </div>
      )}
      {!turn.images.length && !!turn.imgs && (
        <div className="as-user-imgnote">
          <ImageIcon size={13} /> {t('assistant.imagesSent', { count: turn.imgs })}
        </div>
      )}
      {turn.text && <div className="as-bubble">{turn.text}</div>}
    </div>
  );
}

export function BotMessage(props: {
  turn: Extract<ChatTurn, { role: 'assistant' }>;
  state: AppState;
  last: boolean;
  confirming: boolean;
  onRetry?: () => void;
  onSetup: () => void;
  onApply: (p: Extract<Part, { kind: 'proposal' }>) => void;
  onEdit: (p: Extract<Part, { kind: 'proposal' }>) => void;
  onDismiss: (p: Extract<Part, { kind: 'proposal' }>) => void;
  onApplyAll: () => void;
  onOpen: (id: string) => void;
}) {
  const { turn } = props;
  const pending = turn.parts.filter((p) => p.kind === 'proposal' && (p.state === 'pending' || p.state === 'error')).length;
  const incomplete = turn.outcome && turn.outcome.status !== 'complete';
  const lastText = turn.parts.findLastIndex((p) => p.kind === 'text');
  const text = turn.parts.flatMap((p, i) => (p.kind === 'text' && (!incomplete || i !== lastText) ? [p.text] : [])).join('\n\n');
  const unverified = turn.parts.some((p) => p.kind === 'proposal' && p.state === 'unverified');
  const waiting = turn.status === 'streaming' && !turn.parts.length;
  return (
    <div className="as-bot">
      <div className="as-bot-body">
        {waiting && <Dots />}
        {turn.parts.map((p, i) => {
          if (p.kind === 'reasoning') return <Reasoning key={i} part={p} live={turn.status === 'streaming' && p.ms == null} />;
          if (p.kind === 'text') return incomplete && i === lastText ? null : <Markdown key={i} text={p.text} streaming={turn.status === 'streaming'} />;
          if (p.kind === 'tool') return <ToolCard key={`tool:${p.id}`} part={p} />;
          return (
            <Proposal
              key={`proposal:${p.id}`}
              part={p}
              siblings={turn.parts.flatMap((x) => (x.kind === 'proposal' ? [{ tool: x.tool, args: x.args }] : []))}
              state={props.state}
              disabled={props.confirming || turn.parts.slice(0, i).some((x) => x.kind === 'proposal' && (x.state === 'error' || x.state === 'unverified'))}
              onApply={() => props.onApply(p)}
              onEdit={() => props.onEdit(p)}
              onDismiss={() => props.onDismiss(p)}
              onOpen={props.onOpen}
            />
          );
        })}
        {incomplete && (
          <div className="as-incomplete" role="status">
            <b>{t(turn.outcome?.status === 'limit' ? 'assistant.outcome.limit' : 'assistant.outcome.partial')}</b>
            <p>{t('assistant.outcome.review')}</p>
            {turn.outcome?.failures.map((f) => (
              <div key={f.id}>
                {t(`mcp.tool.${f.name}`) === `mcp.tool.${f.name}` ? f.name : t(`mcp.tool.${f.name}`)}: {f.error}
              </div>
            ))}
          </div>
        )}
        {pending > 1 && turn.status !== 'streaming' && (
          <div className="as-applyall">
            <span>{t('assistant.card.pendingCount', { count: pending })}</span>
            <button className="btn primary" onClick={props.onApplyAll} disabled={props.confirming || !!incomplete || unverified}>
              <Check size={14} /> {t('assistant.card.applyAll')}
            </button>
          </div>
        )}
        {turn.status === 'error' && turn.error && <ErrorCard error={turn.error} onRetry={props.onRetry} onSetup={props.onSetup} />}
        {turn.status === 'stopped' && <div className="as-stopped">{t('assistant.stopped')}</div>}
        {props.last && turn.status !== 'streaming' && turn.status !== 'error' && (
          <div className="as-actions">
            {text && (
              <IconButton onClick={() => void copyText(text, t('assistant.copied'))} title={t('assistant.copy')} aria-label={t('assistant.copy')}>
                <Copy size={14} />
              </IconButton>
            )}
            <IconButton onClick={props.onRetry} title={t('assistant.regenerate')} aria-label={t('assistant.regenerate')}>
              <RotateCcw size={14} />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

export function Dots() {
  return (
    <div className="as-dots" aria-label={t('assistant.thinking')}>
      <i />
      <i />
      <i />
    </div>
  );
}

/** 思考过程（AI Elements Reasoning）：进行中展开并显示流光，结束 1 秒后自动收起成「思考了 N 秒」 */
export function Reasoning({ part, live }: { part: Extract<Part, { kind: 'reasoning' }>; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) return setOpen(true);
    const id = setTimeout(() => setOpen(false), 1000);
    return () => clearTimeout(id);
  }, [live]);
  const secs = Math.max(1, Math.round((part.ms ?? 0) / 1000));
  return (
    <div className={`as-reason ${open ? 'open' : ''}`}>
      <button className="as-reason-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={15} />
        <span className={live ? 'shimmer' : ''}>{live ? t('assistant.thinking') : t('assistant.thought', { count: secs })}</span>
        <ChevronDown size={15} className="chev" />
      </button>
      {open && <div className="as-reason-b">{part.text}</div>}
    </div>
  );
}

/** 工具调用：名称、状态，点开看参数与结果 */
export function ToolCard({ part }: { part: Extract<Part, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  // 没有本地化名称的工具（t 原样返回键名）显示工具名本身，不显示 mcp.tool.xxx
  const key = `mcp.tool.${part.name}`;
  const title = t(key) === key ? part.name : t(key);
  const json = (v: unknown) => {
    const s = JSON.stringify(v, null, 2);
    return s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s;
  };
  return (
    <div className={`as-tool ${part.status}`}>
      <button className="as-tool-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Wrench size={15} />
        <span className="as-tool-name">{title}</span>
        <span className={`as-pill ${part.status}`}>
          {part.status === 'running' ? <Clock size={13} className="pulse" /> : part.status === 'done' ? <CircleCheck size={13} /> : <CircleX size={13} />}
          {t(`assistant.tool.${part.status}`)}
        </span>
        <ChevronDown size={15} className="chev" />
      </button>
      {open && (
        <div className="as-tool-b">
          <small>{t('assistant.tool.input')}</small>
          <pre>{json(part.args)}</pre>
          {part.status !== 'running' && (
            <>
              <small>{part.error ? t('assistant.tool.error') : t('assistant.tool.output')}</small>
              <pre className={part.error ? 'err' : ''}>{part.error ?? json(part.result)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorCard({ error, onRetry, onSetup }: { error: { kind: ErrorKind; message: string }; onRetry?: () => void; onSetup: () => void }) {
  const fixable = error.kind === 'auth' || error.kind === 'config' || error.kind === 'balance';
  return (
    <div className="as-error row" role="alert">
      <CircleAlert size={16} />
      <div>
        <b>{t(`assistant.error.${error.kind}`)}</b>
        <small>{error.message}</small>
        <div className="as-error-acts">
          {onRetry && (
            <button className="btn" onClick={onRetry}>
              <RotateCcw size={14} /> {t('assistant.retry')}
            </button>
          )}
          {fixable && (
            <button className="btn plain" onClick={onSetup}>
              {t('assistant.settings')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 消息正文：Streamdown（AI Elements 用的渲染器），支持表格、标题、引用、代码块、删除线、任务列表等 GFM，
 * 流式输出时自动补全没写完的 Markdown（半张表、没闭合的粗体）。后台不用 Tailwind，样式写在 assistant.css；
 * 关掉它自带的复制 / 下载按钮和外链确认弹窗，外链直接新标签打开。
 */
export const MD_COMPONENTS: Components = {
  table: ({ children }) => (
    <div className="as-table">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="as-pre">{children}</pre>,
  code: ({ className, children }) => <code className={className}>{children}</code>,
};

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      className="as-md"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      parseIncompleteMarkdown
      controls={false}
      linkSafety={{ enabled: false }}
      components={MD_COMPONENTS}
    >
      {text}
    </Streamdown>
  );
}

// ---------- 输入框：文字 + 图片（粘贴、拖拽、选择） ----------
export interface ComposerHandle {
  prefill: (text: string, images?: string[]) => void;
}

export function Composer({
  ref,
  busy,
  disabled,
  model,
  onSend,
  onStop,
  onSettings,
  onReset,
  above,
}: {
  ref: React.Ref<ComposerHandle>;
  busy: boolean;
  disabled: boolean;
  model?: string;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onSettings: () => void;
  /** 有会话时才有：窄屏工具栏放不下，「新对话」放在输入框里 */
  onReset?: () => void;
  /** 输入框上方的内容（建议） */
  above?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({ prefill }));
  function prefill(s: string, imgs: string[] = []) {
    setText(s);
    if (imgs.length) setImages(imgs.slice(0, 8));
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(s.length, s.length);
    });
  }
  // 高度随内容增长，最多约 8 行
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 8 - images.length);
    if (!list.length) return;
    try {
      const urls = await Promise.all(list.map(compress));
      setImages((x) => [...x, ...urls].slice(0, 8));
    } catch {
      toast(t('assistant.imageFailed'), 'error');
    }
  };
  const submit = () => {
    if (busy || disabled || (!text.trim() && !images.length)) return;
    onSend(text, images);
    setText('');
    setImages([]);
  };

  return (
    <div
      className={`as-composer ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {above}
      <div className="as-input">
        {images.length > 0 && (
          <div className="as-atts">
            {images.map((src, i) => (
              <span key={i} className="as-att">
                <img src={base(src)} alt="" />
                <IconButton onClick={() => setImages((x) => x.filter((_, k) => k !== i))} aria-label={t('assistant.removeImage')}>
                  <X size={12} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? t('assistant.placeholderSetup') : t('assistant.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="as-input-bar">
          <IconButton
            className="as-icon"
            onClick={() => file.current?.click()}
            disabled={disabled}
            title={t('assistant.addImage')}
            aria-label={t('assistant.addImage')}
          >
            <ImagePlus size={17} />
          </IconButton>
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          <button className="as-model" onClick={onSettings} title={t('assistant.settings')}>
            {model === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : (model ?? 'DeepSeek')}
          </button>
          {onReset && (
            <IconButton className="as-icon m-only" onClick={onReset} title={t('assistant.new')} aria-label={t('assistant.new')}>
              <SquarePen size={16} />
            </IconButton>
          )}
          <span className="grow" />
          {busy ? (
            <IconButton className="as-send accent stop" onClick={onStop} title={t('assistant.stop')} aria-label={t('assistant.stop')}>
              <Square size={13} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              className="as-send accent"
              onClick={submit}
              disabled={disabled || (!text.trim() && !images.length)}
              title={t('assistant.send')}
              aria-label={t('assistant.send')}
            >
              <ArrowUp size={17} />
            </IconButton>
          )}
        </div>
      </div>
      <p className="as-foot">{t('assistant.disclaimer')}</p>
    </div>
  );
}

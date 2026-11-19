import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { copyParts } from '../components/copy.tsx';
import { FlagBox } from '../components/marks.tsx';
import { FLAGS } from '../display.ts';
import { deviceLocation } from '../region.ts';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';
import type { AppState } from '../../../shared/types.ts';
import { localTime } from '../../../shared/format.ts';
import { ask, LoadFailed, Sheet } from '../components/overlays.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { Picker } from '../components/Picker.tsx';
import { api, registerPasskey, saveSettings } from '../store.ts';
import { copyText, run, toast } from '../toast.ts';
import { base } from '../base.ts';
import { composing } from '../keyboard.ts';
import { t } from '../../../shared/i18n.ts';
import { renameStart } from '../name-edit.ts';

interface Device {
  id: string;
  current: boolean;
  userAgent: string;
  ip: string;
  location: string;
  method: string;
  createdAt: string;
  lastSeenAt: string | null;
  name: string;
}

interface Security {
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>;
  sessions: Device[];
}

const DEFAULT_MAX = 10;

/** 从 UA 认出浏览器和系统，例如「Chrome 141 · macOS」 */
function describeUA(ua: string): { browser: string; os: string } {
  const v = (re: RegExp) => ua.match(re)?.[1]?.split('.')[0];
  let browser = t('settings.security.unknownBrowser');
  if (/Edg\//.test(ua)) browser = `Edge ${v(/Edg\/([\d.]+)/) ?? ''}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${v(/OPR\/([\d.]+)/) ?? ''}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${v(/Firefox\/([\d.]+)/) ?? ''}`;
  else if (/CriOS\//.test(ua)) browser = `Chrome ${v(/CriOS\/([\d.]+)/) ?? ''}`;
  else if (/Chrome\//.test(ua)) browser = `Chrome ${v(/Chrome\/([\d.]+)/) ?? ''}`;
  else if (/Safari\//.test(ua)) browser = `Safari ${v(/Version\/([\d.]+)/) ?? ''}`;
  else if (/curl|wget|node|python/i.test(ua)) browser = ua.split('/')[0];
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = `Android ${v(/Android ([\d.]+)/) ?? ''}`;
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser: browser.trim(), os: os.trim() };
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 15) return t('settings.security.ago.justNow');
  if (m < 60) return t('settings.security.ago.minutes', { count: m });
  if (m < 1440) return t('settings.security.ago.hours', { count: Math.round(m / 60) });
  if (m < 43200) return t('settings.security.ago.days', { count: Math.round(m / 1440) });
  return iso.slice(0, 10);
}

/** 点名称即可改名：回车或失焦保存，Esc 取消；保存失败回到输入框。required 时清空等于取消（Passkey），否则交给 onSave（设备回到默认名） */
function NameEdit({ name, fallback, required, onSave }: { name: string; fallback?: string; required?: boolean; onSave: (name: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState<string>();
  // Esc 卸载输入框时 Chromium 仍会派发 blur，用它挡掉这次保存
  const cancelled = useRef(false);
  // 没起过名时按钮显示默认名（浏览器 · 系统），点开改名也从它开始，和 Passkey 一样带着原名
  const shown = renameStart(name, fallback);
  if (draft === undefined)
    return (
      <button type="button" className="name-edit" title={t('settings.security.rename')} disabled={saving !== undefined} onClick={() => setDraft(shown)}>
        {(saving ?? name) || copyParts(fallback)}
      </button>
    );
  const done = () => {
    if (cancelled.current) return void (cancelled.current = false);
    const v = draft.trim();
    setDraft(undefined);
    // 原样确认默认名不算改名，不把浏览器名写成自定义名
    if (v === name || v === shown || (required && !v)) return;
    setSaving(v);
    let ok = false;
    void run(() => onSave(v).then(() => (ok = true)), t('settings.toast.saved')).then(() => {
      setSaving(undefined);
      if (!ok) setDraft(v);
    });
  };
  return (
    <input
      className="name-edit"
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      value={draft}
      placeholder={fallback?.replaceAll('\n', ' ')}
      aria-label={t('settings.security.rename')}
      onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (composing(e.nativeEvent)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          setDraft(undefined);
        }
      }}
    />
  );
}

function DeviceCell({ d, tz, onRevoke, onRename }: { d: Device; tz: string; onRevoke: () => void; onRename: (name: string) => Promise<unknown> }) {
  const { browser, os } = describeUA(d.userAgent);
  const ua = [browser, os].filter(Boolean).join('\n');
  const seen = d.current ? '' : ago(d.lastSeenAt);
  const loc = deviceLocation(d.location, (cc) => FLAGS.has(cc));
  return (
    <Cell
      label={
        <span>
          <NameEdit name={d.name} fallback={ua} onSave={onRename} />
          {d.current && (
            <span className="pill" style={{ marginLeft: 8, color: 'var(--green)' }}>
              {t('settings.security.thisDevice')}
            </span>
          )}
        </span>
      }
      sub={
        <span className="copy-parts">
          {d.name && ua.split('\n').map((part) => <span key={part}>{part}</span>)}
          <span className="dev-loc">
            <FlagBox cc={loc.cc} />
            {loc.text}
          </span>
          {d.ip && <span>{d.ip}</span>}
          <span>
            {t(d.method === 'passkey' ? 'settings.security.signedInPasskey' : 'settings.security.signedInPassword', {
              time: localTime(d.createdAt, tz, { part: 'date' }),
            })}
          </span>
          {seen && <span>{seen}</span>}
        </span>
      }
    >
      {!d.current && (
        <button type="button" className="chip-btn" onClick={onRevoke}>
          {t('settings.security.revoke')}
        </button>
      )}
    </Cell>
  );
}

/** 根据浏览器 UA 给新 Passkey 起个默认名字 */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Passkey';
}

/** 设置页的「安全」：Passkey、修改密码、其他设备下线 */
export function SecurityGroup({ state }: { state: AppState }) {
  const [sec, setSec] = useState<Security>();
  const [pwSheet, setPwSheet] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api<Security>('/api/auth/security').then(
      (v) => {
        setSec(v);
        setFailed(false);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), []);
  const supported = typeof window.PublicKeyCredential === 'function';
  const max = state.settings.maxSessions ?? DEFAULT_MAX;
  const tz = state.settings.timezone;
  return (
    <>
      <Group title={t('settings.security.title')}>
        {failed && !sec && <LoadFailed onRetry={() => void load()} />}
        {sec?.passkeys.map((p) => (
          <Cell
            key={p.id}
            label={
              <NameEdit
                name={p.name}
                required
                onSave={(name) => api(`/api/auth/passkey/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then(load)}
              />
            }
            sub={
              p.lastUsedAt
                ? t('settings.security.lastUsed', { time: localTime(p.lastUsedAt, tz, { part: 'date' }) })
                : t('settings.security.addedAt', { time: localTime(p.createdAt, tz, { part: 'date' }) })
            }
          >
            <ConfirmButton
              onConfirm={() => run(() => api(`/api/auth/passkey/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).then(load), t('settings.security.removed'))}
            >
              {t('settings.security.remove')}
            </ConfirmButton>
          </Cell>
        ))}
        {supported && (
          <Cell
            label={
              <span className="icon-text" style={{ color: 'var(--accent)' }}>
                <Icon name="key" /> {t('settings.security.addPasskey')}
              </span>
            }
            onClick={() =>
              run(async () => {
                try {
                  await registerPasskey(deviceName());
                } catch (e) {
                  if (e instanceof Error && e.name === 'NotAllowedError') return;
                  if (e instanceof Error && e.name === 'InvalidStateError') throw new Error(t('settings.security.alreadyBound'));
                  throw e;
                }
                await load();
              })
            }
          />
        )}
        <Cell label={t('settings.security.changePassword')} onClick={() => setPwSheet(true)} />
      </Group>
      <Group title={sec ? t('settings.security.devicesCount', { count: sec.sessions.length }) : t('settings.security.devices')}>
        <Cell label={t('settings.security.maxSessions')}>
          <Picker
            value={max}
            onChange={(n) => run(() => saveSettings({ maxSessions: n }).then(load), t('settings.security.maxSessionsSaved', { count: n }))}
            options={[1, 2, 3, 5, 10, 20].map((n) => ({ value: n, label: t('settings.security.deviceCount', { count: n }) }))}
            ariaLabel={t('settings.security.maxSessions')}
          />
        </Cell>
        {sec?.sessions
          .slice()
          .sort((a, b) => Number(b.current) - Number(a.current))
          .map((d) => (
            <DeviceCell
              key={d.id}
              d={d}
              tz={tz}
              onRevoke={() => run(() => api(`/api/auth/sessions/${d.id}`, { method: 'DELETE' }).then(load), t('settings.security.revoked'))}
              onRename={(name) => api(`/api/auth/sessions/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then(load)}
            />
          ))}
        {sec && sec.sessions.length > 1 && (
          <button
            className="cell tap"
            style={{ justifyContent: 'center', color: 'var(--red)' }}
            onClick={async () =>
              (await ask(t('settings.security.confirmLogoutOthers'))) &&
              run(() => api('/api/auth/logout-others', { method: 'POST' }).then(load), t('settings.security.loggedOutOthers'))
            }
          >
            {t('settings.security.logoutOthers')}
          </button>
        )}
      </Group>
      <ConnectedApps tz={tz} />
      {pwSheet && <PasswordSheet onClose={() => setPwSheet(false)} onDone={load} />}
    </>
  );
}

interface SyncToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * 连接 Calends App：默认折叠成一行入口，不用 App 的自部署用户只看到这一行（docs/sync-api.md「Dormant until enabled」）。
 * 展开后是已连接设备（同步令牌，与 MCP 令牌分开）、扫码连接手机，以及高级的手动生成令牌。
 */
function ConnectedApps({ tz }: { tz: string }) {
  const [list, setList] = useState<SyncToken[]>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<'pair' | 'token'>();
  const load = () =>
    api<SyncToken[]>('/api/sync/tokens').then(
      (v) => {
        setList(v);
        setFailed(false);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), []);
  return (
    <>
      <Group foot={open ? t('settings.security.apps.foot') : undefined}>
        <button className="cell tap" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="cell-l">{t('settings.security.apps.entry')}</span>
          <span className="cell-r">{list?.length ? t('settings.security.deviceCount', { count: list.length }) : null}</span>
          <span className="disclose">
            <Icon name="down" />
          </span>
        </button>
        {open && (
          <>
            {failed && !list && <LoadFailed onRetry={() => void load()} />}
            {list?.map((k) => (
              <Cell
                key={k.id}
                label={k.name}
                sub={
                  k.lastUsedAt
                    ? t('settings.security.lastUsed', { time: localTime(k.lastUsedAt, tz, { part: 'date' }) })
                    : t('settings.security.addedAt', { time: localTime(k.createdAt, tz, { part: 'date' }) })
                }
              >
                <ConfirmButton
                  onConfirm={() =>
                    run(() => api(`/api/sync/tokens/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).then(load), t('settings.security.apps.removed'))
                  }
                >
                  {t('settings.security.remove')}
                </ConfirmButton>
              </Cell>
            ))}
            <Cell label={<span style={{ color: 'var(--accent)' }}>{t('settings.security.apps.pair')}</span>} onClick={() => setSheet('pair')} />
            <Cell label={t('settings.security.apps.advanced')} sub={t('settings.security.apps.advancedSub')} onClick={() => setSheet('token')} />
          </>
        )}
      </Group>
      {sheet === 'pair' && (
        <PairSheet
          onClose={() => setSheet(undefined)}
          onConnected={(device) => {
            void load();
            setSheet(undefined);
            toast(t('settings.security.apps.connected', { name: device.name }), 'success');
          }}
        />
      )}
      {sheet === 'token' && <ConnectAppSheet onClose={() => setSheet(undefined)} onCreated={() => void load()} />}
    </>
  );
}

/** 本服务器给 App 用的地址：站点根加部署前缀，不带结尾斜杠 */
const serverUrl = () => `${location.origin}${base('/')}`.replace(/\/$/, '');
/** App 不放行明文 HTTP（无 ATS 例外）；本机开发地址除外 */
const insecureOrigin = () => location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);

/** 本地生成的二维码（uqr，无网络请求）；始终白底黑块，深色模式下也能扫 */
function QrCode({ text, dim }: { text: string; dim?: boolean }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 4 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      className="pair-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t('settings.security.apps.scan')}
      style={{ opacity: dim ? 0.15 : 1 }}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

type PairStatus = { status: 'pending' | 'expired' | 'invalid' } | { status: 'connected'; device: { id: string; name: string } };

/**
 * 扫码连接手机：生成一次性配对码（5 分钟、用一次），二维码内容 calends://connect?server=…&code=…。
 * 倒计时按服务器给的 ttlMs 与本地单调时钟，不受两端时钟偏差影响；码有效期间每 3 秒凭码查一次兑换结果，
 * 只有这个码换出的令牌才算连上（别的标签页手动签发不算），过期或被新码覆盖即停查。
 */
function PairSheet({ onClose, onConnected }: { onClose: () => void; onConnected: (device: { id: string; name: string }) => void }) {
  const [pair, setPair] = useState<{ code: string; deadline: number; gone?: boolean }>();
  const [now, setNow] = useState(() => performance.now());
  const [manual, setManual] = useState(false);
  const server = serverUrl();
  // 连点「重新生成」时只认最后一次请求的结果，先回来的旧响应丢弃
  const seq = useRef(0);
  const generate = () => {
    const n = ++seq.current;
    setPair(undefined);
    return run(async () => {
      const r = await api<{ code: string; ttlMs: number }>('/api/sync/pair', { method: 'POST' });
      if (n === seq.current) {
        const at = performance.now();
        setNow(at);
        setPair({ code: r.code, deadline: at + r.ttlMs });
      }
    });
  };
  useEffect(() => void generate(), []);
  const left = pair && !pair.gone ? Math.max(0, pair.deadline - now) : 0;
  const expired = !!pair && left === 0;
  const live = !!pair && !expired;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  const connected = useEffectEvent(onConnected);
  const code = live ? pair.code : undefined;
  useEffect(() => {
    if (!code) return;
    let stop = false;
    const id = setInterval(() => {
      api<PairStatus>('/api/sync/pair/status', { method: 'POST', body: JSON.stringify({ code }) }).then(
        (v) => {
          if (stop) return;
          if (v.status === 'connected') {
            stop = true;
            connected(v.device);
          } else if (v.status !== 'pending') setPair((p) => (p?.code === code ? { ...p, gone: true } : p));
        },
        () => undefined,
      );
    }, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [code]);
  const secs = Math.ceil(left / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const url = pair ? `calends://connect?server=${encodeURIComponent(server)}&code=${encodeURIComponent(pair.code)}` : '';
  return (
    <Sheet
      narrow
      title={t('settings.security.apps.pair')}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={generate}>
            {t('settings.security.apps.regenerate')}
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            {t('settings.security.apps.done')}
          </button>
        </>
      }
    >
      <div className="stack">
        {insecureOrigin() && (
          <p className="pair-warn" role="alert">
            {t('settings.security.apps.httpsWarn')}
          </p>
        )}
        <div className="pair-box">
          <p className="pair-hint">{t('settings.security.apps.scan')}</p>
          {pair ? <QrCode text={url} dim={expired} /> : <div className="pair-qr" />}
          <p className="pair-hint" aria-live="polite" style={expired ? { color: 'var(--red)' } : undefined}>
            {!pair ? '\u00a0' : expired ? t('settings.security.apps.expired') : t('settings.security.apps.expiresIn', { time: clock })}
          </p>
          <button className="as-link pair-hint" aria-expanded={manual} onClick={() => setManual(!manual)}>
            {t('settings.security.apps.manual')}
          </button>
        </div>
        {manual && pair && (
          <Group foot={t('settings.security.apps.manualFoot')}>
            <Cell label={t('settings.security.apps.server')} sub={server} onClick={() => copyText(server, t('settings.security.apps.copied'))} />
            <Cell label={t('settings.security.apps.code')} sub={pair.code} onClick={() => copyText(pair.code, t('settings.security.apps.copied'))} />
          </Group>
        )}
      </div>
    </Sheet>
  );
}

function ConnectAppSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(deviceName());
  // 明文令牌只留在这个弹层里，关闭即丢弃
  const [token, setToken] = useState<string>();
  const server = serverUrl();
  const create = () =>
    run(async () => {
      const r = await api<{ token: string }>('/api/sync/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setToken(r.token);
      onCreated();
    });
  return (
    <Sheet
      narrow
      title={t('settings.security.apps.advanced')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          {token ? (
            <button className="btn primary" onClick={onClose}>
              {t('settings.security.apps.done')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {t('settings.security.apps.cancel')}
              </button>
              <button className="btn primary" disabled={!name.trim()} onClick={create}>
                {t('settings.security.apps.generate')}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="stack">
        {token ? (
          <Group foot={t('settings.security.apps.tokenOnce')}>
            <Cell label={t('settings.security.apps.server')} sub={server} onClick={() => copyText(server, t('settings.security.apps.copied'))} />
            <Cell label={t('settings.security.apps.token')} sub={token} onClick={() => copyText(token, t('settings.security.apps.copied'))} />
          </Group>
        ) : (
          <Group foot={t('settings.security.apps.nameFoot')}>
            <Cell label={t('settings.security.apps.name')}>
              <input value={name} maxLength={60} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
            </Cell>
          </Group>
        )}
      </div>
    </Sheet>
  );
}

function PasswordSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const ok = cur && next.length >= 8 && next === again;
  // 「至少 8 位」只写在下方说明里，三个输入框都不放占位提示
  const input = (value: string, set: (v: string) => void, auto: string) => (
    <input type="password" autoComplete={auto} value={value} onChange={(e) => set((e.target as HTMLInputElement).value)} />
  );
  return (
    <Sheet
      narrow
      title={t('settings.security.changePassword')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button
            className="btn primary"
            disabled={!ok}
            onClick={() =>
              run(async () => {
                await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current: cur, next }) });
                onDone();
                onClose();
              }, t('settings.security.passwordChanged'))
            }
          >
            {t('settings.security.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group foot={next && again && next !== again ? t('settings.security.mismatch') : t('settings.security.passwordFoot')}>
          <Cell label={t('settings.security.currentPassword')}>{input(cur, setCur, 'current-password')}</Cell>
          <Cell label={t('settings.security.newPassword')}>{input(next, setNext, 'new-password')}</Cell>
          <Cell label={t('settings.security.confirmPassword')}>{input(again, setAgain, 'new-password')}</Cell>
        </Group>
      </div>
    </Sheet>
  );
}

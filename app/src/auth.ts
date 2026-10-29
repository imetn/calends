import { browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
import { afterSelection, beginPasskeyAutofill } from './passkey-autofill.ts';
import { BASE_PATH, base, storageKey } from './base.ts';
import type { AppState } from '../../shared/types.ts';
export const CACHE_KEY = storageKey('ledger:state:v1');
/** 助手会话（本机副本）与新建表单交给助手的内容：都属于登录后的私有数据 */
export const ASSISTANT_KEY = storageKey('calends.assistant');
export const HANDOFF_KEY = storageKey('calends.assistant.handoff');
/** 编辑草稿的键 ledger:draft:<new|id>（经 storageKey）；只认本安装的 */
const isDraftKey = (k: string) => k.startsWith('ledger:draft:') && (BASE_PATH ? k.endsWith(`:${BASE_PATH}`) : !k.includes(':/'));

/** 账本不认这条凭据（已删除或注册时没存上）：告诉密码管理器隐藏或删除它；浏览器不支持时跳过 */
function signalUnknownPasskey(rpId: string, credentialId: string) {
  const pkc = window.PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> };
  pkc?.signalUnknownCredential?.({ rpId, credentialId }).catch(() => {});
}

export function createAuth(core: {
  api: typeof import('./store.ts').api;
  boot: typeof import('./store.ts').boot;
  set: typeof import('./store.ts').set;
  snapshot: () => { state?: AppState };
  saveSettings: typeof import('./store.ts').saveSettings;
  resetSessionRevision: () => void;
}) {
  const { api, boot, set, snapshot, saveSettings, resetSessionRevision } = core;
  async function login(password: string): Promise<void> {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    set({ phase: 'loading' });
    await boot();
  }

  const authStatus = () => api<{ needsSetup: boolean; passkeys: number; publicView: boolean }>('/api/auth/status');

  /** 首次设置密码（需要部署时配置的初始化令牌） */
  async function setupPassword(setupToken: string, password: string): Promise<void> {
    await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ setupToken, password }) });
    set({ phase: 'loading' });
    await boot();
    // 新部署：按浏览器的时区和地区猜好本位币，之后可在设置里改
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ccy = guessCurrency();
    if (snapshot().state) await saveSettings({ ...(tz ? { timezone: tz } : {}), ...(ccy ? { baseCurrency: ccy } : {}) }).catch(() => {});
  }

  /** 按浏览器语言里的地区猜本位币，例如 zh-CN → CNY、en-GB → GBP；猜不出时返回 undefined */
  function guessCurrency(): string | undefined {
    const MAP: Record<string, string> = {
      CN: 'CNY',
      US: 'USD',
      GB: 'GBP',
      HK: 'HKD',
      TW: 'TWD',
      JP: 'JPY',
      KR: 'KRW',
      SG: 'SGD',
      AU: 'AUD',
      CA: 'CAD',
      IN: 'INR',
      TR: 'TRY',
      RU: 'RUB',
      BR: 'BRL',
      ID: 'IDR',
      VN: 'VND',
      PH: 'PHP',
      TH: 'THB',
      MY: 'MYR',
      NG: 'NGN',
      CH: 'CHF',
      UA: 'UAH',
      KZ: 'KZT',
      PK: 'PKR',
      EG: 'EGP',
      AR: 'ARS',
      DE: 'EUR',
      FR: 'EUR',
      ES: 'EUR',
      IT: 'EUR',
      NL: 'EUR',
      PT: 'EUR',
      AT: 'EUR',
      BE: 'EUR',
      IE: 'EUR',
      FI: 'EUR',
      GR: 'EUR',
    };
    for (const l of navigator.languages ?? [navigator.language]) {
      try {
        const region = new Intl.Locale(l).maximize().region;
        if (region && MAP[region]) return MAP[region];
      } catch {
        /* 非法的语言标签 */
      }
    }
    return undefined;
  }

  async function loginPasskey(useBrowserAutofill = false, signal?: AbortSignal): Promise<void> {
    const { options, challengeId } = await api<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON']; challengeId: string }>(
      '/api/auth/passkey/login/options',
      { method: 'POST', signal },
    );
    signal?.throwIfAborted();
    const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill });
    signal?.throwIfAborted();
    await api('/api/auth/passkey/login', { method: 'POST', body: JSON.stringify({ challengeId, response }), signal }).catch((e: unknown) => {
      if ((e as { code?: string }).code === 'PASSKEY_NOT_BOUND') signalUnknownPasskey(options.rpId ?? location.hostname, response.id);
      throw afterSelection(e);
    });
    signal?.throwIfAborted();
    set({ phase: 'loading' });
    await boot();
  }

  /** 条件式登录与按钮登录各取独立挑战；停止时也取消尚未返回的网络请求。 */
  function startPasskeyAutofill(onError: (error: unknown) => void): () => void {
    return beginPasskeyAutofill({
      supports: browserSupportsWebAuthnAutofill,
      login: (signal) => loginPasskey(true, signal),
      cancel: () => WebAuthnAbortService.cancelCeremony(),
      onError,
    });
  }

  async function registerPasskey(name: string): Promise<void> {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const { options, challengeId } = await api<{ options: Parameters<typeof startRegistration>[0]['optionsJSON']; challengeId: string }>(
      '/api/auth/passkey/register/options',
      { method: 'POST' },
    );
    const response = await startRegistration({ optionsJSON: options });
    await api('/api/auth/passkey/register', { method: 'POST', body: JSON.stringify({ challengeId, response, name }) });
  }

  async function logout(): Promise<void> {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    await clearLocalSession();
  }

  /**
   * 退出登录或登录失效（401）：清掉本机的私有数据——账本缓存、离线缓存、助手会话、编辑草稿、交给助手的内容，
   * 回到登录页。界面偏好与语言不属于账本内容，保留。
   */
  async function clearLocalSession() {
    resetSessionRevision();
    try {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(ASSISTANT_KEY);
      for (let i = (localStorage.length ?? 0) - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && isDraftKey(k)) localStorage.removeItem(k);
      }
      sessionStorage.removeItem(HANDOFF_KEY);
    } catch {
      /* 隐私模式等 */
    }
    await globalThis.caches?.delete(`calends:${base('/')}:data-v5`).catch(() => false);
    set({ phase: 'login', state: undefined });
  }

  return { login, authStatus, setupPassword, loginPasskey, startPasskeyAutofill, registerPasskey, logout, clearLocalSession };
}

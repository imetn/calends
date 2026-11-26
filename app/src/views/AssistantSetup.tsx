import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { AI_PROVIDERS, getProvider, type AiProviderPreset, type AssistantConfigView, type Effort, type ProviderId } from '../../../shared/ai-providers.ts';
import { t } from '../../../shared/i18n.ts';
import { ask, Sheet } from '../components/overlays.tsx';
import { Picker } from '../components/Picker.tsx';
import { api, ASSISTANT_KEY } from '../store.ts';
import { toast } from '../toast.ts';
import './assistant.css';

function providerLabel(p: AiProviderPreset): string {
  if (p.id === 'custom-openai') return t('assistant.setup.customOpenai');
  if (p.id === 'custom-anthropic') return t('assistant.setup.customAnthropic');
  return p.name;
}

// ---------- 配置：AI 供应商、API Key、Base URL、模型、思考强度 ----------
export function SetupSheet({
  cfg,
  onClose,
  onSaved,
  onClearChats,
}: {
  cfg: AssistantConfigView | null;
  onClose: () => void;
  onSaved: (c: AssistantConfigView) => void;
  onClearChats: () => void;
}) {
  const initialProvider: ProviderId = cfg?.provider ?? 'deepseek';
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? getProvider(initialProvider)?.baseUrl ?? '');
  const [model, setModel] = useState(cfg?.model ?? getProvider(initialProvider)?.defaultModel ?? '');
  const [effort, setEffort] = useState<Effort>(cfg?.effort ?? 'low');
  const [saving, setSaving] = useState(false);
  // 模型列表：填好地址和 Key 后向服务商的 /models 取；取不到（有的服务没有这个接口）时可以手动填
  const [models, setModels] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  const preset = getProvider(provider) ?? AI_PROVIDERS[0];
  const sameSaved = !!cfg?.configured && provider === cfg.provider && !!cfg.keyHint;
  const canFetch = !!baseUrl.trim() && (!!key.trim() || sameSaved || !!preset.optionalKey);

  const selectProvider = (nextId: ProviderId) => {
    if (nextId === provider) return;
    const next = getProvider(nextId) ?? AI_PROVIDERS[0];
    setProvider(nextId);
    setKey('');
    setBaseUrl(nextId === cfg?.provider ? cfg.baseUrl : next.baseUrl);
    setModel(nextId === cfg?.provider ? cfg.model : next.defaultModel);
    setModels(null);
    setFetchErr(null);
    setManual(false);
  };

  const fetchModels = async () => {
    if (!canFetch) return;
    setFetching(true);
    setFetchErr(null);
    try {
      const r = await api<{ ok: boolean; message?: string; models?: string[] }>('/api/assistant/test', {
        method: 'POST',
        body: JSON.stringify({ provider, apiKey: key.trim() || undefined, baseUrl }),
      });
      if (!r.ok || !r.models?.length) {
        setModels(null);
        setFetchErr(r.ok ? t('assistant.setup.noModels') : (r.message ?? t('assistant.error.network')));
        return;
      }
      const list = [...new Set(r.models)].sort((a, b) => a.localeCompare(b));
      setModels(list);
      setManual(false);
      // 当前模型不在列表里：优先预设默认模型，其次带 flash/mini 的轻量模型，最后第一个
      setModel((m) => {
        if (m && list.includes(m)) return m;
        if (preset.defaultModel && list.includes(preset.defaultModel)) return preset.defaultModel;
        return list.find((x) => /(flash|mini|haiku)/i.test(x)) ?? list[0];
      });
    } catch (e) {
      setModels(null);
      setFetchErr((e as Error).message);
    } finally {
      setFetching(false);
    }
  };
  // 打开时（已保存 Key）以及切换服务商、改地址或 Key 后，停顿一下自动获取
  useEffect(() => {
    if (!canFetch) return;
    const changed = !!key || provider !== (cfg?.provider ?? 'deepseek') || baseUrl !== (cfg?.baseUrl ?? '');
    const h = setTimeout(() => void fetchModels(), changed ? 700 : 0);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key, baseUrl]);

  const save = async () => {
    setSaving(true);
    try {
      const v = await api<AssistantConfigView>('/api/assistant/config', {
        method: 'PUT',
        body: JSON.stringify({ provider, apiKey: key, baseUrl, model, effort }),
      });
      onSaved(v);
      toast(t('assistant.setup.saved'));
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    const v = await api<AssistantConfigView>('/api/assistant/config', { method: 'PUT', body: JSON.stringify({ apiKey: null }) });
    onSaved(v);
    toast(t('assistant.setup.cleared'));
  };

  return (
    <Sheet
      narrow
      title={t('assistant.setup.title')}
      onClose={onClose}
      foot={
        <>
          {cfg?.configured && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => void clear()}>
              {t('assistant.setup.clear')}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => void save()}
            disabled={saving || !baseUrl.trim() || (!key.trim() && !sameSaved && !preset.optionalKey) || !model.trim()}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="as-setup">
        {/* 清空聊天记录：服务端和本机都删掉，不可恢复，所以要确认 */}
        <div className="as-clear-chats">
          <span>{t('assistant.clearChatsHint')}</span>
          <button
            type="button"
            className="btn danger"
            onClick={async () =>
              (await ask(t('assistant.clearChatsConfirm'))) &&
              void api('/api/assistant/chats', { method: 'DELETE' }).then(() => {
                try {
                  localStorage.removeItem(ASSISTANT_KEY);
                } catch {
                  /* ignore */
                }
                onClearChats();
                toast(t('assistant.clearChatsDone'));
              })
            }
          >
            {t('assistant.clearChats')}
          </button>
        </div>
        <p className="as-setup-intro">
          {t('assistant.setup.intro')}
          {preset.keyUrl && preset.keyHost && (
            <>
              {/[。！？]$/.test(t('assistant.setup.intro')) ? '' : ' '}
              {t('assistant.setup.getKey')}
              {/[：:]$/.test(t('assistant.setup.getKey')) ? '' : ' '}
              <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                {preset.keyHost}
              </a>
            </>
          )}
        </p>
        <div className="as-field">
          <span>{t('assistant.setup.provider')}</span>
          <div className="as-model-pick">
            <Picker
              variant="btn"
              value={provider}
              ariaLabel={t('assistant.setup.provider')}
              search
              options={AI_PROVIDERS.map((p) => ({
                value: p.id,
                label: providerLabel(p),
                hint: p.custom ? undefined : p.protocol === 'openai-compatible' ? 'OpenAI API' : undefined,
                group: t(`assistant.setup.group_${p.group}`),
              }))}
              onChange={selectProvider}
            />
          </div>
        </div>
        <label className="as-field">
          <span>Base URL</span>
          <input spellCheck={false} value={baseUrl} placeholder={preset.baseUrl || 'https://api.example.com/v1'} onChange={(e) => setBaseUrl(e.target.value)} />
          <small>{t(preset.custom ? 'assistant.setup.baseHintCustom' : 'assistant.setup.baseHint')}</small>
        </label>
        <label className="as-field">
          <span>API Key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={
              sameSaved ? t('assistant.setup.keySaved', { hint: cfg.keyHint ?? '' }) : preset.optionalKey ? t('assistant.setup.keyOptional') : 'sk-…'
            }
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <div className="as-field">
          <span className="as-model-head">
            {t('assistant.setup.model')}
            {models && !manual && (
              <button type="button" className="as-link" onClick={() => void fetchModels()} disabled={fetching}>
                {fetching ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} {t('assistant.setup.refresh')}
              </button>
            )}
          </span>
          {models && !manual ? (
            <div className="as-model-pick">
              <Picker
                variant="btn"
                value={model}
                ariaLabel={t('assistant.setup.model')}
                search
                options={[
                  ...(model && !models.includes(model) ? [{ value: model, label: model, hint: t('assistant.setup.notInList') }] : []),
                  ...models.map((m) => ({
                    value: m,
                    label: m.includes('/') ? m.slice(m.indexOf('/') + 1) : m,
                    group: m.includes('/') ? m.slice(0, m.indexOf('/')) : undefined,
                  })),
                ]}
                onChange={setModel}
              />
            </div>
          ) : manual ? (
            <input spellCheck={false} value={model} placeholder={preset.defaultModel || 'model-id'} onChange={(e) => setModel(e.target.value)} />
          ) : (
            <div className="as-model-empty">
              {fetching ? (
                <>
                  <Loader2 size={14} className="spin" /> {t('assistant.setup.fetching')}
                </>
              ) : (
                (fetchErr ?? t('assistant.setup.fetchHint'))
              )}
            </div>
          )}
          <small className="as-model-foot">
            {models && !manual ? t('assistant.setup.fetched', { count: models.length }) : t('assistant.setup.modelHint')}
            {!manual ? (
              <>
                {fetchErr && !fetching && (
                  <button type="button" className="as-link" onClick={() => void fetchModels()}>
                    {t('assistant.setup.retry')}
                  </button>
                )}
                <button type="button" className="as-link" onClick={() => setManual(true)}>
                  {t('assistant.setup.manual')}
                </button>
              </>
            ) : (
              models && (
                <button type="button" className="as-link" onClick={() => setManual(false)}>
                  {t('assistant.setup.pickList')}
                </button>
              )
            )}
          </small>
        </div>
        <div className="as-field">
          <span>{t('assistant.setup.effort')}</span>
          <div className="as-effort">
            {(['none', 'low', 'high'] as Effort[]).map((e) => (
              <button key={e} type="button" className={effort === e ? 'on' : ''} onClick={() => setEffort(e)}>
                <b>{t(`assistant.setup.effort_${e}`)}</b>
                <small>{t(`assistant.setup.effort_${e}Hint`)}</small>
              </button>
            ))}
          </div>
        </div>
        <p className="as-setup-note">{t('assistant.setup.privacy')}</p>
      </div>
    </Sheet>
  );
}

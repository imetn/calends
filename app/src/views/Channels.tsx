import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { base } from '../base.ts';
import { useState } from 'react';
import { uid } from '../../../shared/billing.ts';
import { channelsOf, type AppState, type Channel, type ChannelKind } from '../../../shared/types.ts';
import { Sheet } from '../components/overlays.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { Toggle } from '../components/inputs.tsx';
import { Picker } from '../components/Picker.tsx';
import { api, saveSettings } from '../store.ts';
import { run } from '../toast.ts';
import { t } from '../../../shared/i18n.ts';

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
}

/** 每种渠道要填什么；logo 是白色标志，放在品牌色底上（mark 是品牌字标，不翻译）。文案在渲染时取 */
export const KINDS = (): Record<
  ChannelKind,
  { name: string; color: string; logo?: string; mark?: string; tile?: boolean; fields: Field[]; help?: string }
> => ({
  email: {
    name: t('settings.channels.kind.email.name'),
    color: 'var(--red-9)',
    logo: base('/channels/gmail.svg'),
    fields: [{ key: 'to', label: t('settings.channels.field.to'), placeholder: 'you@example.com' }],
    help: t('settings.channels.kind.email.help'),
  },
  telegram: {
    name: 'Telegram',
    color: 'var(--cyan-9)',
    logo: base('/channels/telegram.svg'),
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC…', secret: true },
      { key: 'chatId', label: 'Chat ID', placeholder: t('settings.channels.kind.telegram.chatIdPlaceholder') },
    ],
    help: t('settings.channels.kind.telegram.help'),
  },
  lark: {
    name: t('settings.channels.kind.lark.name'),
    color: 'var(--blue-9)',
    logo: base('/channels/lark.svg'),
    fields: [
      { key: 'webhook', label: t('settings.channels.field.webhook'), placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
      {
        key: 'secret',
        label: t('settings.channels.kind.lark.secret'),
        placeholder: t('settings.channels.kind.lark.secretPlaceholder'),
        secret: true,
        optional: true,
      },
    ],
    help: t('settings.channels.kind.lark.help'),
  },
  dingtalk: {
    name: t('settings.channels.kind.dingtalk.name'),
    color: 'var(--blue-9)',
    logo: base('/channels/dingtalk.svg'),
    fields: [
      { key: 'webhook', label: t('settings.channels.field.webhook'), placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      {
        key: 'secret',
        label: t('settings.channels.kind.dingtalk.secret'),
        placeholder: t('settings.channels.kind.dingtalk.secretPlaceholder'),
        secret: true,
        optional: true,
      },
    ],
    help: t('settings.channels.kind.dingtalk.help'),
  },
  wecom: {
    name: t('settings.channels.kind.wecom.name'),
    color: 'var(--green-9)',
    logo: base('/channels/wechat.svg'),
    fields: [{ key: 'webhook', label: t('settings.channels.field.webhook'), placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' }],
    help: t('settings.channels.kind.wecom.help'),
  },
  bark: {
    name: 'Bark',
    color: 'var(--red-9)',
    logo: base('/channels/bark.png'),
    tile: true,
    fields: [
      { key: 'key', label: 'Device Key', placeholder: t('settings.channels.kind.bark.keyPlaceholder'), secret: true },
      { key: 'server', label: t('settings.channels.field.server'), placeholder: 'https://api.day.app', optional: true },
    ],
    help: t('settings.channels.kind.bark.help'),
  },
  ntfy: {
    name: 'ntfy',
    color: 'var(--teal-9)',
    logo: base('/channels/ntfy.svg'),
    fields: [
      { key: 'topic', label: 'Topic', placeholder: t('settings.channels.kind.ntfy.topicPlaceholder') },
      { key: 'server', label: t('settings.channels.field.server'), placeholder: 'https://ntfy.sh', optional: true },
      { key: 'token', label: t('settings.channels.field.token'), secret: true, optional: true },
    ],
    help: t('settings.channels.kind.ntfy.help'),
  },
  serverchan: {
    name: t('settings.channels.kind.serverchan.name'),
    color: 'var(--blue-9)',
    logo: base('/channels/serverchan.png'),
    tile: true,
    fields: [{ key: 'key', label: 'SendKey', placeholder: t('settings.channels.kind.serverchan.keyPlaceholder'), secret: true }],
    help: t('settings.channels.kind.serverchan.help'),
  },
  discord: {
    name: 'Discord',
    color: 'var(--iris-9)',
    logo: base('/channels/discord.svg'),
    fields: [{ key: 'webhook', label: t('settings.channels.field.webhook'), placeholder: 'https://discord.com/api/webhooks/…' }],
    help: t('settings.channels.kind.discord.help'),
  },
  slack: {
    name: 'Slack',
    color: 'var(--purple-9)',
    logo: base('/channels/slack.svg'),
    fields: [{ key: 'webhook', label: t('settings.channels.field.webhook'), placeholder: 'https://hooks.slack.com/services/…' }],
    help: 'Slack App → Incoming Webhooks',
  },
  webhook: {
    name: t('settings.channels.kind.webhook.name'),
    color: 'var(--slate-9)',
    logo: base('/channels/webhook.svg'),
    fields: [
      { key: 'url', label: 'URL' },
      { key: 'header', label: t('settings.channels.kind.webhook.header'), placeholder: 'Authorization: Bearer …', secret: true, optional: true },
    ],
    help: t('settings.channels.kind.webhook.help'),
  },
});

function ChannelMark({ kind, size = 28 }: { kind: ChannelKind; size?: number }) {
  const k = KINDS()[kind];
  return (
    // tile：官方 App 图标本身就是完整的方块，铺满不留底色
    <span className={`ch-mark ${k.tile ? 'tile' : ''}`} style={{ background: k.color, width: size, height: size }}>
      {k.logo ? <img src={k.logo} alt="" /> : <b>{k.mark}</b>}
    </span>
  );
}

const test = (channel: Channel | string) =>
  run(async () => {
    const r = await api<{ sent: boolean; reason?: string }>('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel }) });
    if (!r.sent) throw new Error(r.reason ?? t('settings.channels.testFailed'));
  }, t('settings.channels.testSent'));

/** 设置页的「通知渠道」：列表、开关、测试、编辑、添加 */
export function ChannelsGroup({ state }: { state: AppState }) {
  const list = channelsOf(state.settings);
  const [edit, setEdit] = useState<Channel | null>(null);
  const save = (next: Channel[]) => saveSettings({ channels: next });
  const kinds = KINDS();
  return (
    <>
      <Group title={t('settings.channels.title', { count: list.filter((c) => c.enabled).length })}>
        {list.length === 0 && <div className="cell muted">{t('settings.channels.empty')}</div>}
        {list.map((c) => (
          <div key={c.id} className="cell ch-row">
            <button type="button" className="ch-main" onClick={() => setEdit(c)}>
              <ChannelMark kind={c.kind} />
              <span className="cell-l">
                {c.name}
                <small>{c.kind === 'email' && c.config.to ? c.config.to : kinds[c.kind].name}</small>
              </span>
            </button>
            <button type="button" className="chip-btn" onClick={() => test(c.id)}>
              {t('settings.channels.test')}
            </button>
            <Toggle checked={c.enabled} onChange={(v) => run(() => save(list.map((x) => (x.id === c.id ? { ...x, enabled: v } : x))))} />
          </div>
        ))}
        <div className="cell">
          <Picker
            value=""
            onChange={(k) => k && setEdit({ id: uid(), kind: k as ChannelKind, name: kinds[k as ChannelKind].name, enabled: true, config: {} })}
            options={(Object.keys(kinds) as ChannelKind[]).map((k) => ({ value: k, label: kinds[k].name, icon: <ChannelMark kind={k} size={20} /> }))}
            display={
              <>
                <Icon name="plus" /> {t('settings.channels.add')}
              </>
            }
            ariaLabel={t('settings.channels.add')}
          />
        </div>
      </Group>
      {edit && (
        <ChannelSheet
          c={edit}
          isNew={!list.some((x) => x.id === edit.id)}
          onClose={() => setEdit(null)}
          onSave={(c) =>
            run(async () => {
              await save(list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]);
              setEdit(null);
            }, t('settings.toast.saved'))
          }
          onDelete={() =>
            run(async () => {
              await save(list.filter((x) => x.id !== edit.id));
              setEdit(null);
            }, t('settings.toast.deleted'))
          }
        />
      )}
    </>
  );
}

function ChannelSheet({
  c,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  c: Channel;
  isNew: boolean;
  onClose: () => void;
  onSave: (c: Channel) => void;
  onDelete: () => void;
}) {
  const [f, setF] = useState<Channel>(c);
  const k = KINDS()[f.kind];
  const missing = k.fields.filter((x) => !x.optional && !f.config[x.key]?.trim());
  return (
    <Sheet
      narrow
      title={isNew ? t('settings.channels.addKind', { name: k.name }) : f.name}
      onClose={onClose}
      foot={
        <>
          {!isNew && <ConfirmButton onConfirm={onDelete}>{t('settings.channels.delete')}</ConfirmButton>}
          <span className="grow" />
          <button className="btn" disabled={missing.length > 0} onClick={() => test(f)}>
            {t('settings.channels.test')}
          </button>
          <button className="btn primary" disabled={missing.length > 0} onClick={() => onSave(f)}>
            {t('settings.channels.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Group foot={k.help}>
          <Cell label={t('settings.channels.name')}>
            <input value={f.name} onChange={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} />
          </Cell>
          {k.fields.map((x) => (
            <Cell key={x.key} label={x.label}>
              <input
                type={x.secret ? 'password' : 'text'}
                autoComplete="off"
                autoCapitalize="off"
                value={f.config[x.key] ?? ''}
                placeholder={x.placeholder ?? (x.optional ? t('settings.channels.optional') : '')}
                onChange={(e) => setF({ ...f, config: { ...f.config, [x.key]: (e.target as HTMLInputElement).value.trim() } })}
              />
            </Cell>
          ))}
          <Cell label={t('settings.channels.enabled')}>
            <Toggle label={t('settings.channels.enabled')} checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
          </Cell>
        </Group>
      </div>
    </Sheet>
  );
}

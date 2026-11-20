import { useEffect, useState } from 'react';
import { deriveBackupKey, openBackup, WrongPassphrase, type EncryptedBackup } from '../../../shared/backup-crypto.ts';
import { localTime } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { Seg, Stepper, Toggle } from '../components/inputs.tsx';
import { Sheet } from '../components/overlays.tsx';
import { Cell, Group } from '../components/ui.tsx';
import { api } from '../store.ts';
import { run, toast } from '../toast.ts';

interface Status {
  lastAt?: number;
  lastFile?: string;
  lastTryAt?: number;
  lastError?: string;
  failures?: number;
}
type Kind = 's3' | 'webdav';
interface View {
  configured: boolean;
  enabled: boolean;
  kind: Kind;
  s3: { endpoint: string; bucket: string; prefix: string; accessKeyId: string; saved: boolean };
  webdav: { url: string; folder: string; username: string; saved: boolean };
  keep: number;
  status: Status;
}

const KIND_NAME: Record<Kind, string> = { s3: 'S3', webdav: 'WebDAV' };
/** 与服务端一致的地址比对口径：主机名小写、去掉末尾斜杠 */
const sameUrl = (a: string, b: string) => {
  try {
    const u = new URL(a.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}` === b;
  } catch {
    return false;
  }
};
const field = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false } as const;

const at = (ms: number, tz: string) => localTime(new Date(ms).toISOString(), tz);

/** 数据分组里的「自动备份」一行：右侧是开关状态或上次备份时间，点开是设置面板 */
export function AutoBackupCell({ timezone }: { timezone: string }) {
  const [view, setView] = useState<View | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<View>('/api/autobackup')
      .then(setView)
      .catch(() => undefined);
  }, []);
  const s = view?.status;
  const value = !view
    ? ''
    : !view.enabled
      ? t('settings.autobackup.off')
      : s?.failures
        ? t('settings.autobackup.failed')
        : s?.lastAt
          ? at(s.lastAt, timezone)
          : '';
  return (
    <>
      <Cell label={t('settings.autobackup.title')} onClick={() => setOpen(true)}>
        {value}
      </Cell>
      {open && view && <AutoBackupSheet view={view} timezone={timezone} onChange={setView} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 保存或备份后按结果提示：开着且这次失败了就报错，否则报成功 */
function report(v: View, ok: string) {
  if (v.enabled && v.status.failures) toast(v.status.lastError ?? t('settings.autobackup.failed'), 'error');
  else toast(ok);
}

function AutoBackupSheet({ view, timezone, onChange, onClose }: { view: View; timezone: string; onChange: (v: View) => void; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(view.kind);
  const [s3, setS3] = useState({ ...view.s3, secretAccessKey: '' });
  const [dav, setDav] = useState({ ...view.webdav, password: '' });
  const [f, setF] = useState({ pass: '', confirm: '' });
  const [keep, setKeep] = useState(view.keep);
  type Input = { target: EventTarget | null };
  const val = (e: Input) => (e.target as HTMLInputElement).value;
  const onS3 = (k: keyof typeof s3) => (e: Input) => setS3({ ...s3, [k]: val(e) });
  const onDav = (k: keyof typeof dav) => (e: Input) => setDav({ ...dav, [k]: val(e) });
  const onF = (k: keyof typeof f) => (e: Input) => setF({ ...f, [k]: val(e) });
  const mismatch = f.pass !== f.confirm;
  // 没存过的那种存储要填密钥；改了服务地址或账号也要重填（服务端不会把旧密钥用到新地址上）
  const s3Secret = view.s3.saved && sameUrl(s3.endpoint, view.s3.endpoint) && s3.accessKeyId.trim() === view.s3.accessKeyId;
  const davSecret = view.webdav.saved && sameUrl(dav.url, view.webdav.url) && dav.username.trim() === view.webdav.username;
  const targetMissing =
    kind === 's3'
      ? !s3.endpoint.trim() || !s3.bucket.trim() || !s3.accessKeyId.trim() || (!s3Secret && !s3.secretAccessKey.trim())
      : !dav.url.trim() || !dav.username.trim() || (!davSecret && !dav.password);
  const missing = targetMissing || (!view.configured && !f.pass) || mismatch || (!!f.pass && !f.confirm);
  const s = view.status;
  const switching = view.configured && kind !== view.kind;

  const save = () =>
    run(async () => {
      // 口令只在浏览器里派生成密钥，服务端拿不到口令本身
      const key = f.pass ? await deriveBackupKey(f.pass) : undefined;
      const v = await api<View>('/api/autobackup', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: view.configured ? view.enabled : true,
          kind,
          [kind]: kind === 's3' ? s3 : dav,
          keep,
          ...(key ? { key } : {}),
        }),
      });
      onChange(v);
      setS3({ ...v.s3, secretAccessKey: '' });
      setDav({ ...v.webdav, password: '' });
      setF({ pass: '', confirm: '' });
      report(v, v.enabled ? t('settings.autobackup.done') : t('settings.toast.saved'));
    });
  // 开关只切换已保存的配置，不顺带提交面板里没保存的改动
  const toggle = (enabled: boolean) =>
    run(async () => {
      const v = await api<View>('/api/autobackup', { method: 'PUT', body: JSON.stringify({ enabled }) });
      onChange(v);
      report(v, enabled ? t('settings.autobackup.done') : t('settings.toast.saved'));
    });

  return (
    <Sheet
      narrow
      title={t('settings.autobackup.title')}
      onClose={onClose}
      foot={
        <>
          {view.configured && (
            <ConfirmButton
              onConfirm={() =>
                run(async () => {
                  onChange(await api<View>('/api/autobackup', { method: 'DELETE' }));
                  onClose();
                }, t('settings.autobackup.removed'))
              }
            >
              {t('settings.autobackup.remove')}
            </ConfirmButton>
          )}
          <span className="grow" />
          <button className="btn primary" disabled={missing} onClick={() => void save()}>
            {switching ? t('settings.autobackup.switchTo', { kind: KIND_NAME[kind] }) : t('settings.autobackup.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        {view.configured && (
          <Group>
            <Cell label={t('settings.autobackup.title')}>
              <Toggle label={t('settings.autobackup.title')} checked={view.enabled} onChange={(v) => void toggle(v)} />
            </Cell>
            <Cell label={t('settings.autobackup.last')} sub={s.failures ? s.lastError : undefined}>
              {s.lastAt ? at(s.lastAt, timezone) : t('settings.autobackup.never')}
            </Cell>
            <Cell
              label={t('settings.autobackup.runNow')}
              onClick={() =>
                run(async () => {
                  const v = await api<View>('/api/autobackup/run', { method: 'POST' });
                  onChange(v);
                  report({ ...v, enabled: true }, t('settings.autobackup.done'));
                })
              }
            />
          </Group>
        )}
        <Group title={t('settings.autobackup.storage')}>
          <Cell label={t('settings.autobackup.kind')}>
            <Seg
              small
              value={kind}
              onChange={setKind}
              options={[
                ['s3', KIND_NAME.s3],
                ['webdav', KIND_NAME.webdav],
              ]}
            />
          </Cell>
          {kind === 's3' ? (
            <>
              <Cell label={t('settings.autobackup.endpoint')}>
                <input {...field} value={s3.endpoint} onChange={onS3('endpoint')} />
              </Cell>
              <Cell label={t('settings.autobackup.bucket')}>
                <input {...field} value={s3.bucket} onChange={onS3('bucket')} />
              </Cell>
              <Cell label={t('settings.autobackup.folder')}>
                <input {...field} value={s3.prefix} placeholder={t('settings.channels.optional')} onChange={onS3('prefix')} />
              </Cell>
              <Cell label="Access Key ID">
                <input {...field} value={s3.accessKeyId} onChange={onS3('accessKeyId')} />
              </Cell>
              <Cell label="Secret Access Key">
                <input
                  type="password"
                  autoComplete="off"
                  value={s3.secretAccessKey}
                  placeholder={s3Secret ? t('settings.autobackup.kept') : ''}
                  onChange={onS3('secretAccessKey')}
                />
              </Cell>
            </>
          ) : (
            <>
              <Cell label={t('settings.autobackup.endpoint')}>
                <input {...field} value={dav.url} onChange={onDav('url')} />
              </Cell>
              <Cell label={t('settings.autobackup.folder')}>
                <input {...field} value={dav.folder} placeholder={t('settings.channels.optional')} onChange={onDav('folder')} />
              </Cell>
              <Cell label={t('app.login.username')}>
                <input {...field} value={dav.username} onChange={onDav('username')} />
              </Cell>
              <Cell label={t('app.login.password')}>
                <input
                  type="password"
                  autoComplete="off"
                  value={dav.password}
                  placeholder={davSecret ? t('settings.autobackup.kept') : ''}
                  onChange={onDav('password')}
                />
              </Cell>
            </>
          )}
        </Group>
        <Group title={t('settings.autobackup.encryption')}>
          <Cell label={t('settings.autobackup.passphrase')}>
            <input
              type="password"
              autoComplete="new-password"
              value={f.pass}
              placeholder={view.configured ? t('settings.autobackup.kept') : ''}
              onChange={onF('pass')}
            />
          </Cell>
          <Cell label={t('settings.autobackup.confirm')} sub={mismatch && f.confirm ? t('settings.autobackup.mismatch') : undefined}>
            <input type="password" autoComplete="new-password" value={f.confirm} onChange={onF('confirm')} />
          </Cell>
        </Group>
        <Group>
          <Cell label={t('settings.autobackup.keep')}>
            <Stepper
              value={keep}
              onChange={setKeep}
              min={1}
              max={365}
              label={t('settings.autobackup.keep')}
              unit={(n) => t('settings.autobackup.copies', { count: n })}
            />
          </Cell>
        </Group>
      </div>
    </Sheet>
  );
}

/** 恢复加密备份：在浏览器里用口令解开，再走原来的恢复流程；口令不离开浏览器 */
export function UnlockSheet({ file, onOpen, onClose }: { file: EncryptedBackup; onOpen: (json: string) => void; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const unlock = async () => {
    setBusy(true);
    try {
      onOpen(await openBackup(file, pass));
    } catch (e) {
      toast(e instanceof WrongPassphrase ? t('settings.restore.wrongPassphrase') : t('settings.toast.badBackup'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      narrow
      title={t('settings.data.restore')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('settings.restore.cancel')}
          </button>
          <button className="btn primary" disabled={!pass || busy} onClick={() => void unlock()}>
            {t('settings.restore.unlock')}
          </button>
        </>
      }
    >
      <Group>
        <Cell label={t('settings.autobackup.passphrase')}>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pass && !busy && void unlock()}
          />
        </Cell>
      </Group>
    </Sheet>
  );
}

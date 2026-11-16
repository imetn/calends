import { useEffect, useState } from 'react';
import { deriveBackupKey, openBackup, WrongPassphrase, type BackupKey, type EncryptedBackup } from '../../../shared/backup-crypto.ts';
import { localTime } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { Stepper, Toggle } from '../components/inputs.tsx';
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
interface View {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  keep: number;
  status: Status;
}

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
  const [f, setF] = useState({
    endpoint: view.endpoint,
    bucket: view.bucket,
    prefix: view.prefix,
    accessKeyId: view.accessKeyId,
    secret: '',
    pass: '',
    confirm: '',
  });
  const [keep, setKeep] = useState(view.keep);
  const set = (k: keyof typeof f) => (e: { target: EventTarget | null }) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const mismatch = f.pass !== f.confirm;
  const missing =
    !f.endpoint.trim() ||
    !f.bucket.trim() ||
    !f.accessKeyId.trim() ||
    (!view.configured && (!f.secret.trim() || !f.pass)) ||
    mismatch ||
    (!!f.pass && !f.confirm);
  const s = view.status;

  // 开关只切换已保存的配置，不顺带提交面板里没保存的改动
  const put = async (enabled: boolean, key?: BackupKey, src = { ...f, keep }) => {
    const v = await api<View>('/api/autobackup', {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        endpoint: src.endpoint,
        bucket: src.bucket,
        prefix: src.prefix,
        accessKeyId: src.accessKeyId,
        secretAccessKey: src.secret,
        keep: src.keep,
        ...(key ? { key } : {}),
      }),
    });
    onChange(v);
    return v;
  };
  const save = () =>
    run(async () => {
      // 口令只在浏览器里派生成密钥，服务端拿不到口令本身
      const key = f.pass ? await deriveBackupKey(f.pass) : undefined;
      const v = await put(view.configured ? view.enabled : true, key);
      setF({ ...f, secret: '', pass: '', confirm: '' });
      report(v, v.enabled ? t('settings.autobackup.done') : t('settings.toast.saved'));
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
            {t('settings.autobackup.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        {view.configured && (
          <Group>
            <Cell label={t('settings.autobackup.title')}>
              <Toggle
                label={t('settings.autobackup.title')}
                checked={view.enabled}
                onChange={(v) =>
                  run(async () =>
                    report(
                      await put(v, undefined, { ...view, secret: '', pass: '', confirm: '' }),
                      v ? t('settings.autobackup.done') : t('settings.toast.saved'),
                    ),
                  )
                }
              />
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
          <Cell label={t('settings.autobackup.endpoint')}>
            <input autoComplete="off" autoCapitalize="off" spellCheck={false} value={f.endpoint} placeholder="https://" onChange={set('endpoint')} />
          </Cell>
          <Cell label={t('settings.autobackup.bucket')}>
            <input autoComplete="off" autoCapitalize="off" spellCheck={false} value={f.bucket} onChange={set('bucket')} />
          </Cell>
          <Cell label={t('settings.autobackup.folder')}>
            <input
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={f.prefix}
              placeholder={t('settings.channels.optional')}
              onChange={set('prefix')}
            />
          </Cell>
          <Cell label="Access Key ID">
            <input autoComplete="off" autoCapitalize="off" spellCheck={false} value={f.accessKeyId} onChange={set('accessKeyId')} />
          </Cell>
          <Cell label="Secret Access Key">
            <input
              type="password"
              autoComplete="off"
              value={f.secret}
              placeholder={view.configured ? t('settings.autobackup.kept') : ''}
              onChange={set('secret')}
            />
          </Cell>
        </Group>
        <Group title={t('settings.autobackup.encryption')}>
          <Cell label={t('settings.autobackup.passphrase')}>
            <input
              type="password"
              autoComplete="new-password"
              value={f.pass}
              placeholder={view.configured ? t('settings.autobackup.kept') : ''}
              onChange={set('pass')}
            />
          </Cell>
          <Cell label={t('settings.autobackup.confirm')} sub={mismatch && f.confirm ? t('settings.autobackup.mismatch') : undefined}>
            <input type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} />
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

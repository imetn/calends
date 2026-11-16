// 自动备份：把完整备份（与「导出完整备份」同一份内容）加密后上传到 S3 兼容存储，按份数滚动删除最旧的。
// 触发：定时任务每刻钟检查一次——账本有改动（kv.rev 变了）且距上次备份满 1 小时，或距上次满 1 天；
// 内容与上一份完全相同时不再上传，免得相同的副本把有差别的旧版本挤出保留份数。
// 恢复备份、替换导入之前先备份一份当前账本，备份失败就不替换。
// 配置与状态存在 kv 的独立键里：不进完整备份、不推进 kv.rev，也不经 AI / MCP 工具。
import type { BackupKey } from '../shared/backup-crypto.ts';
import { sealBackup } from '../shared/backup-crypto.ts';
import { t } from '../shared/i18n.ts';
import { exportAll } from './backup.ts';
import type { Env } from './env.ts';
import { deleteObject, listObjects, normalizeEndpoint, putObject, type S3Config } from './s3.ts';
import { getKv, getRev, putKv } from './store.ts';

const CONFIG_KEY = 'autobackup';
const STATUS_KEY = 'autobackupStatus';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const KEEP_DEFAULT = 30;
export const KEEP_MAX = 365;

export interface AutoBackupConfig extends S3Config {
  enabled: boolean;
  /** 桶里的文件夹，可空 */
  prefix: string;
  key: BackupKey;
  keep: number;
}

export interface AutoBackupStatus {
  /** 上次成功（或确认内容未变）的时间 */
  lastAt?: number;
  lastFile?: string;
  lastHash?: string;
  lastRev?: number;
  lastTryAt?: number;
  lastError?: string;
  failures?: number;
}

/** 给浏览器看的配置：不回传密钥和派生后的加密密钥 */
export interface AutoBackupView {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  keep: number;
  status: AutoBackupStatus;
}

const getConfig = (env: Env) => getKv<AutoBackupConfig>(env, CONFIG_KEY);
const getStatus = async (env: Env) => (await getKv<AutoBackupStatus>(env, STATUS_KEY)) ?? {};

export async function viewAutoBackup(env: Env): Promise<AutoBackupView> {
  const [c, status] = await Promise.all([getConfig(env), getStatus(env)]);
  const { lastHash: _hash, ...shown } = status;
  return {
    configured: !!c,
    enabled: !!c?.enabled,
    endpoint: c?.endpoint ?? '',
    bucket: c?.bucket ?? '',
    prefix: c?.prefix ?? '',
    accessKeyId: c?.accessKeyId ?? '',
    keep: c?.keep ?? KEEP_DEFAULT,
    status: shown,
  };
}

const cleanPrefix = (p: unknown) =>
  String(p ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
const validKey = (k: unknown): k is BackupKey => {
  const v = k as BackupKey | null;
  return (
    !!v &&
    typeof v.key === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(v.key) &&
    typeof v.salt === 'string' &&
    Number.isInteger(v.iterations) &&
    v.iterations >= 100_000
  );
};

/**
 * 保存配置。secretAccessKey 留空表示沿用已存的；key 由浏览器按口令派生，不传表示沿用。
 * 换了加密密钥或存储位置时，清掉上次内容的指纹，下一次一定会上传一份新的。
 */
export async function saveAutoBackup(env: Env, b: Partial<AutoBackupConfig>): Promise<AutoBackupConfig | string> {
  const cur = await getConfig(env);
  const endpoint = normalizeEndpoint(String(b.endpoint ?? ''));
  const bucket = String(b.bucket ?? '').trim();
  const accessKeyId = String(b.accessKeyId ?? '').trim();
  // 换了服务地址或账号就不沿用旧密钥，免得拿旧凭据去签发给另一台主机的请求
  const sameTarget = !!cur && cur.endpoint === endpoint && cur.accessKeyId === accessKeyId;
  const secretAccessKey = String(b.secretAccessKey ?? '').trim() || (sameTarget ? cur.secretAccessKey : '');
  const key = b.key === undefined ? cur?.key : b.key;
  const keep = Number(b.keep ?? KEEP_DEFAULT);
  if (!endpoint) return t('server.autobackup.badEndpoint');
  if (!bucket || /[/\s]/.test(bucket)) return t('server.autobackup.badBucket');
  if (!accessKeyId || !secretAccessKey) return t('server.autobackup.noCredentials');
  if (!validKey(key)) return t('server.autobackup.noPassphrase');
  if (!Number.isInteger(keep) || keep < 1 || keep > KEEP_MAX) return t('server.autobackup.badKeep');
  const next: AutoBackupConfig = { enabled: b.enabled !== false, endpoint, bucket, prefix: cleanPrefix(b.prefix), accessKeyId, secretAccessKey, key, keep };
  await putKv(env, CONFIG_KEY, next);
  if (!cur || cur.key.key !== next.key.key || cur.endpoint !== next.endpoint || cur.bucket !== next.bucket || cur.prefix !== next.prefix) {
    const { lastHash: _hash, ...status } = await getStatus(env);
    await putKv(env, STATUS_KEY, status);
  }
  return next;
}

/** 关闭并删除配置（含密钥）；已上传的备份文件留在存储里 */
export async function removeAutoBackup(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM kv WHERE key IN (?1, ?2)').bind(CONFIG_KEY, STATUS_KEY).run();
}

const pad = (n: number) => String(n).padStart(2, '0');
export function backupFileName(now: number, reason?: 'before-restore'): string {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `calends-backup-${stamp}${reason ? `-${reason}` : ''}.json`;
}
const FILE_RE = /^calends-backup-\d{8}-\d{6}(?:-[a-z-]+)?\.json$/;
const folder = (prefix: string) => (prefix ? `${prefix}/` : '');

/** 滚动保留：只看这个文件夹下由自动备份生成的文件，按时间从新到旧留 keep 份，返回要删的；别的文件一概不动 */
export function filesToPrune(keys: string[], prefix: string, keep: number): string[] {
  const dir = folder(prefix);
  return keys
    .filter((k) => k.startsWith(dir) && FILE_RE.test(k.slice(dir.length)))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(Math.max(1, keep));
}

/** 连续失败后的等待：15 分钟起翻倍，最长 6 小时 */
const retryDelay = (failures: number) => Math.min(15 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * HOUR);

/** 定时任务这一刻是否该备份 */
export function backupDue(c: Pick<AutoBackupConfig, 'enabled'> | undefined, s: AutoBackupStatus, rev: number, now: number): boolean {
  if (!c?.enabled) return false;
  if (s.failures && s.lastTryAt && now - s.lastTryAt < retryDelay(s.failures)) return false;
  const since = now - (s.lastAt ?? 0);
  return rev !== s.lastRev ? since >= HOUR : since >= DAY;
}

async function digest(text: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 备份一次。force：内容没变也上传（「立即备份」）。成功后删掉超出保留份数的旧文件；删除失败不算备份失败。
 * 开始前先把这次记成失败（被平台中途掐断时状态里留得下痕迹，也会按失败退避），成功后再改回来。
 */
export async function runAutoBackup(env: Env, o: { force?: boolean; reason?: 'before-restore'; now?: number } = {}): Promise<AutoBackupStatus> {
  const c = await getConfig(env);
  if (!c) throw new Error(t('server.autobackup.notConfigured'));
  const now = o.now ?? Date.now();
  const prev = await getStatus(env);
  await putKv(env, STATUS_KEY, { ...prev, lastTryAt: now, failures: (prev.failures ?? 0) + 1, lastError: t('server.autobackup.interrupted') });
  try {
    const rev = await getRev(env);
    const backup = await exportAll(env);
    const hash = await digest(JSON.stringify({ ...backup, exportedAt: '' }));
    if (!o.force && hash === prev.lastHash) {
      const next = { ...prev, lastAt: now, lastRev: rev, lastTryAt: now, failures: 0, lastError: undefined };
      await putKv(env, STATUS_KEY, next);
      return next;
    }
    const file = folder(c.prefix) + backupFileName(now, o.reason);
    await putObject(c, file, await sealBackup(JSON.stringify(backup), c.key));
    const next: AutoBackupStatus = { lastAt: now, lastFile: file, lastHash: hash, lastRev: rev, lastTryAt: now, failures: 0 };
    await putKv(env, STATUS_KEY, next);
    try {
      const old = filesToPrune(
        (await listObjects(c, folder(c.prefix))).map((x) => x.key),
        c.prefix,
        c.keep,
      );
      for (const k of old) await deleteObject(c, k);
    } catch (e) {
      console.error('[autobackup] prune', e);
    }
    return next;
  } catch (e) {
    const next: AutoBackupStatus = {
      ...prev,
      lastTryAt: now,
      failures: (prev.failures ?? 0) + 1,
      lastError: e instanceof Error ? e.message : String(e),
    };
    await putKv(env, STATUS_KEY, next);
    throw e;
  }
}

/** 定时任务入口：到点才备份，失败只记日志与状态，不影响提醒和汇率 */
export async function scheduledAutoBackup(env: Env, now: number): Promise<void> {
  const c = await getConfig(env);
  if (!c?.enabled) return;
  if (!backupDue(c, await getStatus(env), await getRev(env), now)) return;
  try {
    await runAutoBackup(env, { now });
  } catch (e) {
    console.error('[autobackup]', e);
  }
}

/** 整体替换账本之前调用：开着自动备份就先备份一份，失败返回错误文案（调用方据此放弃替换） */
export async function backupBeforeReplace(env: Env): Promise<string | undefined> {
  const c = await getConfig(env);
  if (!c?.enabled) return undefined;
  try {
    // 一定上传一份：指纹相同的上一份可能已被手动删掉或滚动删除
    await runAutoBackup(env, { force: true, reason: 'before-restore' });
  } catch (e) {
    return t('server.autobackup.beforeRestoreFailed', { error: e instanceof Error ? e.message : String(e) });
  }
}

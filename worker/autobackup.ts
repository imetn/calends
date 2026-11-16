// 自动备份：把完整备份（与「导出完整备份」同一份内容）加密后上传到 S3 兼容存储或 WebDAV，按份数滚动删除最旧的。
// 触发：定时任务每刻钟检查一次——账本有改动（kv.rev 变了）且距上次备份满 1 小时，或距上次满 1 天；
// 内容与上一份完全相同时不再上传，免得相同的副本把有差别的旧版本挤出保留份数。
// 恢复备份、替换导入之前先备份一份当前账本，备份失败就不替换。
// 两种存储的设置各存一份，kind 指明正在用哪个；切换后另一份留着，切回来不用重填。
// 配置与状态存在 kv 的独立键里：不进完整备份、不推进 kv.rev，也不经 AI / MCP 工具。
import type { BackupKey } from '../shared/backup-crypto.ts';
import { sealBackup } from '../shared/backup-crypto.ts';
import { t } from '../shared/i18n.ts';
import { exportAll } from './backup.ts';
import type { Env } from './env.ts';
import { deleteObject, listObjects, normalizeEndpoint, putObject, type S3Config } from './s3.ts';
import { getKv, getRev, putKv } from './store.ts';
import { davDelete, davList, davPut, type DavConfig } from './webdav.ts';

const CONFIG_KEY = 'autobackup';
const STATUS_KEY = 'autobackupStatus';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const KEEP_DEFAULT = 30;
export const KEEP_MAX = 365;

export type BackupKind = 's3' | 'webdav';
export interface S3Target extends S3Config {
  /** 桶里的文件夹，可空 */
  prefix: string;
}
export interface DavTarget extends DavConfig {
  /** 服务地址下的文件夹，可空 */
  folder: string;
}

export interface AutoBackupConfig {
  enabled: boolean;
  kind: BackupKind;
  s3?: S3Target;
  webdav?: DavTarget;
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

/** 给浏览器看的配置：不回传密钥、密码和派生后的加密密钥，只说有没有存 */
export interface AutoBackupView {
  configured: boolean;
  enabled: boolean;
  kind: BackupKind;
  s3: { endpoint: string; bucket: string; prefix: string; accessKeyId: string; saved: boolean };
  webdav: { url: string; folder: string; username: string; saved: boolean };
  keep: number;
  status: AutoBackupStatus;
}

/** 保存请求：不带 kind 表示只切换开关 */
export interface AutoBackupInput {
  enabled?: boolean;
  kind?: BackupKind;
  s3?: Partial<S3Target>;
  webdav?: Partial<DavTarget>;
  key?: BackupKey;
  keep?: number;
}

const getConfig = (env: Env) => getKv<AutoBackupConfig>(env, CONFIG_KEY);
const getStatus = async (env: Env) => (await getKv<AutoBackupStatus>(env, STATUS_KEY)) ?? {};

export async function viewAutoBackup(env: Env): Promise<AutoBackupView> {
  const [c, status] = await Promise.all([getConfig(env), getStatus(env)]);
  const { lastHash: _hash, ...shown } = status;
  return {
    configured: !!c,
    enabled: !!c?.enabled,
    kind: c?.kind ?? 's3',
    s3: {
      endpoint: c?.s3?.endpoint ?? '',
      bucket: c?.s3?.bucket ?? '',
      prefix: c?.s3?.prefix ?? '',
      accessKeyId: c?.s3?.accessKeyId ?? '',
      saved: !!c?.s3?.secretAccessKey,
    },
    webdav: { url: c?.webdav?.url ?? '', folder: c?.webdav?.folder ?? '', username: c?.webdav?.username ?? '', saved: !!c?.webdav?.password },
    keep: c?.keep ?? KEEP_DEFAULT,
    status: shown,
  };
}

const cleanFolder = (p: unknown) =>
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

/** 校验并整理 S3 设置；Secret 留空时沿用已存的，但只在服务地址和 Access Key ID 都没变时 */
function s3Target(b: Partial<S3Target> | undefined, cur: S3Target | undefined): S3Target | string {
  const endpoint = normalizeEndpoint(String(b?.endpoint ?? ''));
  const bucket = String(b?.bucket ?? '').trim();
  const accessKeyId = String(b?.accessKeyId ?? '').trim();
  // 换了服务地址或账号就不沿用旧密钥，免得拿旧凭据去签发给另一台主机的请求
  const same = !!cur && cur.endpoint === endpoint && cur.accessKeyId === accessKeyId;
  const secretAccessKey = String(b?.secretAccessKey ?? '').trim() || (same ? cur.secretAccessKey : '');
  if (!endpoint) return t('server.autobackup.badEndpoint');
  if (!bucket || /[/\s]/.test(bucket)) return t('server.autobackup.badBucket');
  if (!accessKeyId || !secretAccessKey) return t('server.autobackup.noCredentials');
  return { endpoint, bucket, prefix: cleanFolder(b?.prefix), accessKeyId, secretAccessKey };
}

/** 校验并整理 WebDAV 设置；密码留空时沿用已存的，但只在服务地址和用户名都没变时 */
function davTarget(b: Partial<DavTarget> | undefined, cur: DavTarget | undefined): DavTarget | string {
  const url = normalizeEndpoint(String(b?.url ?? ''));
  const username = String(b?.username ?? '').trim();
  const same = !!cur && cur.url === url && cur.username === username;
  const password = String(b?.password ?? '') || (same ? cur.password : '');
  if (!url) return t('server.autobackup.badEndpoint');
  if (!username || !password) return t('server.autobackup.noLogin');
  return { url, username, password, folder: cleanFolder(b?.folder) };
}

/** 备份落在哪里：换了这个就清掉内容指纹，下一次一定上传 */
const placeOf = (c: AutoBackupConfig) =>
  c.kind === 's3' ? `s3 ${c.s3?.endpoint} ${c.s3?.bucket} ${c.s3?.prefix}` : `webdav ${c.webdav?.url} ${c.webdav?.folder}`;

/**
 * 保存配置。只校验、更新正在用的那种存储，另一种原样留着。key 由浏览器按口令派生，不传表示沿用。
 * 不带 kind 时只切换开关。换了存储位置时清空状态；只换加密密钥时清掉上次内容的指纹。
 */
export async function saveAutoBackup(env: Env, b: AutoBackupInput): Promise<AutoBackupConfig | string> {
  const cur = await getConfig(env);
  if (b.kind === undefined) {
    if (!cur) return t('server.autobackup.notConfigured');
    const next = { ...cur, enabled: b.enabled !== false };
    await putKv(env, CONFIG_KEY, next);
    return next;
  }
  const kind: BackupKind = b.kind === 'webdav' ? 'webdav' : 's3';
  const target = kind === 's3' ? s3Target(b.s3, cur?.s3) : davTarget(b.webdav, cur?.webdav);
  if (typeof target === 'string') return target;
  const key = b.key === undefined ? cur?.key : b.key;
  const keep = Number(b.keep ?? KEEP_DEFAULT);
  if (!validKey(key)) return t('server.autobackup.noPassphrase');
  if (!Number.isInteger(keep) || keep < 1 || keep > KEEP_MAX) return t('server.autobackup.badKeep');
  const next: AutoBackupConfig = { enabled: b.enabled !== false, kind, s3: cur?.s3, webdav: cur?.webdav, [kind]: target, key, keep };
  await putKv(env, CONFIG_KEY, next);
  if (!cur || placeOf(cur) !== placeOf(next)) {
    // 换了存储位置：旧位置的记录不再适用
    await putKv(env, STATUS_KEY, {});
  } else if (cur.key.key !== next.key.key) {
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
  return `calends-backup-${stamp}-${String(d.getUTCMilliseconds()).padStart(3, '0')}-${crypto.randomUUID().replaceAll('-', '')}${reason ? `-${reason}` : ''}.json`;
}
const FILE_RE = /^calends-backup-(\d{8}-\d{6})(?:-(\d{3})-[a-f0-9]{32})?(?:-[a-z-]+)?\.json$/;
const folder = (prefix: string) => (prefix ? `${prefix}/` : '');

/** 滚动保留：只看文件夹里由自动备份生成的文件，按时间从新到旧留 keep 份，返回要删的；别的文件一概不动 */
export function filesToPrune(names: string[], keep: number, current?: string): string[] {
  const time = (name: string) => {
    const match = FILE_RE.exec(name)!;
    return match[1] + (match[2] ?? '000');
  };
  return (
    names
      .filter((n) => FILE_RE.test(n))
      .sort((a, b) => time(b).localeCompare(time(a)) || b.localeCompare(a))
      .slice(Math.max(1, keep))
      // 并发上传可读到相同列表：只删严格早于本次的文件，避免两个请求互删。
      // 同毫秒的多份快照留到下一次较晚的备份再滚动。
      .filter((name) => !current || time(name) < time(current))
  );
}

/** 两种存储的统一操作：文件名都是文件夹下的直接子项 */
interface Store {
  /** 返回状态里显示的路径 */
  put(name: string, body: string): Promise<string>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}
function storeOf(c: AutoBackupConfig): Store {
  if (c.kind === 'webdav' && c.webdav) {
    const d = c.webdav;
    return {
      put: async (name, body) => (await davPut(d, d.folder, name, body), folder(d.folder) + name),
      list: () => davList(d, d.folder),
      remove: (name) => davDelete(d, d.folder, name),
    };
  }
  if (c.kind === 's3' && c.s3) {
    const s = c.s3;
    const dir = folder(s.prefix);
    return {
      put: async (name, body) => (await putObject(s, dir + name, body), dir + name),
      list: async () => (await listObjects(s, dir)).map((x) => x.key.slice(dir.length)).filter((n) => n && !n.includes('/')),
      remove: (name) => deleteObject(s, dir + name),
    };
  }
  throw new Error(t('server.autobackup.notConfigured'));
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
    const store = storeOf(c);
    const file = await store.put(backupFileName(now, o.reason), await sealBackup(JSON.stringify(backup), c.key));
    const next: AutoBackupStatus = { lastAt: now, lastFile: file, lastHash: hash, lastRev: rev, lastTryAt: now, failures: 0 };
    await putKv(env, STATUS_KEY, next);
    try {
      for (const name of filesToPrune(await store.list(), c.keep, file.split('/').pop())) await store.remove(name);
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

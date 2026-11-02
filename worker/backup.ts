import { validatePeopleAvatars } from '../shared/avatar.ts';
// 完整备份与恢复：导出的文件导入到一个全新的部署后，账本与原来完全一致。
// 包含：订阅、支付方式、人的名册、全部设置（含通知渠道、日历订阅令牌、分类表）、当前汇率、历史汇率。
// 不包含：登录会话、AI 接入令牌（属于凭据，新部署应重新生成）、提醒发送记录。
import { DEFAULT_SETTINGS, type FxTable, type PaymentMethod, type Person, type Settings, type Subscription } from '../shared/types.ts';
import type { Env } from './env.ts';
import { migrateRenewalRules } from '../shared/billing.ts';
import { t } from '../shared/i18n.ts';
import { validPublicPage } from '../shared/public-layout.ts';
import { getFx, getPeople, getSettings, restoreLedger } from './store.ts';

const BACKUP_FORMAT = 'calends-backup';
/** 改名前的备份格式名，照样能导入 */
const LEGACY_FORMATS = ['subscription-ledger-backup'];
// v3 起带上人的名册（people）
const BACKUP_VERSION = 3;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  subscriptions: Subscription[];
  methods: PaymentMethod[];
  people: Person[];
  settings: Settings;
  fx: FxTable;
  fxDaily: Array<{ date: string; rates: Record<string, number>; source: string }>;
}

export async function exportAll(env: Env): Promise<Backup> {
  const [subs, methods, fxDaily] = await Promise.all([
    env.DB.prepare('SELECT data FROM subscriptions ORDER BY id').all<{ data: string }>(),
    env.DB.prepare('SELECT data FROM methods ORDER BY id').all<{ data: string }>(),
    env.DB.prepare('SELECT date, rates, source FROM fx_daily ORDER BY date').all<{ date: string; rates: string; source: string }>(),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    subscriptions: subs.results.map((r) => JSON.parse(r.data) as Subscription),
    methods: methods.results.map((r) => JSON.parse(r.data) as PaymentMethod),
    people: await getPeople(env),
    settings: await getSettings(env),
    fx: await getFx(env),
    fxDaily: fxDaily.results.map((r) => ({ date: r.date, rates: JSON.parse(r.rates) as Record<string, number>, source: r.source })),
  };
}

/** 备份可能是手改或旧版本写的：公开页配置不合法就回到默认，否则恢复后公开页和编辑页打不开 */
function restorableSettings(raw: unknown): Settings {
  const settings = { ...((raw ?? {}) as Settings) };
  if (settings.publicPage != null && !validPublicPage(settings.publicPage)) delete settings.publicPage;
  if (settings.publicTitle != null && typeof settings.publicTitle !== 'string') delete settings.publicTitle;
  return settings;
}

/** 读取任意版本的备份：v3 带名册，v2 没有；早期导出只有 subscriptions / methods / settings */
export function parseBackup(raw: unknown): Backup {
  const b = raw as Partial<Backup>;
  if (!b || !Array.isArray(b.subscriptions)) throw new Error(t('server.backup.notBackup'));
  if (b.format && b.format !== BACKUP_FORMAT && !LEGACY_FORMATS.includes(b.format))
    throw new Error(t('server.backup.unknownFormat', { format: String(b.format) }));
  if ((b.version ?? 1) > BACKUP_VERSION) throw new Error(t('server.backup.newerVersion', { version: b.version }));
  const people = Array.isArray(b.people) ? b.people.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
  validatePeopleAvatars(people);
  return {
    format: BACKUP_FORMAT,
    version: b.version ?? 1,
    exportedAt: b.exportedAt ?? '',
    subscriptions: b.subscriptions.map(migrateRenewalRules),
    methods: b.methods ?? [],
    people,
    settings: restorableSettings(b.settings),
    fx: b.fx as FxTable,
    fxDaily: b.fxDaily ?? [],
  };
}

/** 整体替换为备份里的内容；历史汇率按日期合并（同一天以备份为准）。一个事务：失败时原账本不变 */
export async function restoreAll(env: Env, b: Backup): Promise<{ subscriptions: number; methods: number; people: number; fxDays: number }> {
  await restoreLedger(env, {
    subscriptions: b.subscriptions,
    methods: b.methods,
    // 名册整体替换；没有名册的旧备份清空后，下次读取时按成员、代付的称呼重新建档
    people: b.people,
    // 设置整体替换（备份里没有的项回到默认值），不和当前设置混在一起
    settings: b.settings && Object.keys(b.settings).length ? { ...DEFAULT_SETTINGS, ...b.settings } : undefined,
    fx: b.fx?.rates ? b.fx : undefined,
    fxDaily: b.fxDaily,
  });
  return { subscriptions: b.subscriptions.length, methods: b.methods.length, people: b.people.length, fxDays: b.fxDaily.length };
}

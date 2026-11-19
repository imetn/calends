// 由 scripts/migrations.mjs 生成，请勿手改
export const MIGRATIONS: Array<{ name: string; statements: string[] }> = [
  {
    "name": "0001_init.sql",
    "statements": [
      "-- 单用户账本：订阅与支付方式以 JSON 文档存储，便于前端模型演进\nCREATE TABLE subscriptions (\n  id TEXT PRIMARY KEY,\n  data TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
      "CREATE TABLE methods (\n  id TEXT PRIMARY KEY,\n  data TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
      "-- settings / fx 等单值\nCREATE TABLE kv (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
      "CREATE TABLE sessions (\n  token_hash TEXT PRIMARY KEY,\n  expires_at INTEGER NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  user_agent TEXT\n)",
      "-- 先占位后发信，dedupe_key 保证同一提醒只发一次\nCREATE TABLE notify_log (\n  dedupe_key TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  subject TEXT NOT NULL,\n  status TEXT NOT NULL,\n  error TEXT,\n  sent_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
      "CREATE TABLE login_attempts (\n  ip TEXT PRIMARY KEY,\n  fails INTEGER NOT NULL,\n  window_start INTEGER NOT NULL\n)"
    ]
  },
  {
    "name": "0002_fx_daily.sql",
    "statements": [
      "-- 历史汇率：每个扣款日一行，USD 为基准（rates JSON 中 1 USD = x 外币）\nCREATE TABLE fx_daily (\n  date TEXT PRIMARY KEY,\n  rates TEXT NOT NULL,\n  source TEXT NOT NULL,\n  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))\n);\n"
    ]
  },
  {
    "name": "0003_auth.sql",
    "statements": [
      "-- 登录：Passkey 凭据与一次性挑战（密码哈希存在 kv 的 auth 键里）\nCREATE TABLE passkeys (\n  id TEXT PRIMARY KEY,\n  public_key TEXT NOT NULL,\n  counter INTEGER NOT NULL DEFAULT 0,\n  transports TEXT,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  last_used_at TEXT\n)",
      "CREATE TABLE auth_challenges (\n  id TEXT PRIMARY KEY,\n  challenge TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  expires_at INTEGER NOT NULL\n)"
    ]
  },
  {
    "name": "0004_session_devices.sql",
    "statements": [
      "-- 登录设备：记录来源，供设置页列出并单独移出\nALTER TABLE sessions ADD COLUMN ip TEXT",
      "ALTER TABLE sessions ADD COLUMN location TEXT",
      "ALTER TABLE sessions ADD COLUMN method TEXT",
      "ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER"
    ]
  },
  {
    "name": "0005_chats.sql",
    "statements": [
      "-- AI 助手的聊天记录：一行一个对话，data 存 { createdAt, turns, history }（图片不存，只留占位）\nCREATE TABLE IF NOT EXISTS chats (\n  id TEXT PRIMARY KEY,\n  data TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n);\n"
    ]
  },
  {
    "name": "0006_notify_retry.sql",
    "statements": [
      "-- 保留失败提醒快照；首次发送后最多在之后整点补发三次。\nALTER TABLE notify_log ADD COLUMN digest TEXT",
      "ALTER TABLE notify_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE notify_log ADD COLUMN retry_at INTEGER",
      "CREATE INDEX notify_retry ON notify_log(status, retry_at)"
    ]
  },
  {
    "name": "0007_state_rev.sql",
    "statements": [
      "-- One ledger revision, shared by Cloudflare D1 and Docker SQLite.\nINSERT INTO kv (key, value) VALUES ('rev', '0') ON CONFLICT(key) DO NOTHING",
      "-- Triggers run inside the writer's transaction, including direct SQL and batch writes.\n-- The kv allow-list excludes rev, even when recursive_triggers is enabled.\nCREATE TRIGGER rev_subscriptions_insert AFTER INSERT ON subscriptions\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_subscriptions_update AFTER UPDATE ON subscriptions\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_subscriptions_delete AFTER DELETE ON subscriptions\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_methods_insert AFTER INSERT ON methods\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_methods_update AFTER UPDATE ON methods\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_methods_delete AFTER DELETE ON methods\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_fx_daily_insert AFTER INSERT ON fx_daily\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_fx_daily_update AFTER UPDATE ON fx_daily\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_fx_daily_delete AFTER DELETE ON fx_daily\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_kv_insert AFTER INSERT ON kv\nWHEN NEW.key IN ('settings', 'people', 'prefs', 'fx')\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_kv_update AFTER UPDATE ON kv\nWHEN NEW.key IN ('settings', 'people', 'prefs', 'fx') OR OLD.key IN ('settings', 'people', 'prefs', 'fx')\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND",
      "CREATE TRIGGER rev_kv_delete AFTER DELETE ON kv\nWHEN OLD.key IN ('settings', 'people', 'prefs', 'fx')\nBEGIN\n  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';\nEND"
    ]
  },
  {
    "name": "0008_session_name.sql",
    "statements": [
      "-- Owner-chosen device name; NULL falls back to the browser and OS parsed from user_agent.\nALTER TABLE sessions ADD COLUMN name TEXT"
    ]
  },
  {
    "name": "0009_sync.sql",
    "statements": [
      "-- App sync (protocol v1, docs/sync-api.md). Tables live beside the ledger but are not part of it:\n-- backup restore and replace import only rotate sync_meta.generation, never touch clients or rejections.\n-- Sync starts dormant: this migration only creates tables. The change-tracking triggers and the backfill of sync_objects\n-- are installed when sync is enabled (first sync token, or the hosting layer's enableSync), see worker/sync-mode.ts.\n-- Self-hosted users without the App only get these empty tables.\nCREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "-- Random generation: a counter would collide with values clients saw before a physical rollback.\nINSERT INTO sync_meta (key, value) VALUES ('generation', lower(hex(randomblob(8)))) ON CONFLICT(key) DO NOTHING",
      "-- Stable ledger identity, never changes.\nINSERT INTO sync_meta (key, value) VALUES ('ledgerId', lower(hex(randomblob(16)))) ON CONFLICT(key) DO NOTHING",
      "-- Disaster-recovery epoch, changes only in the physical rollback procedure.\nINSERT INTO sync_meta (key, value) VALUES ('drEpoch', lower(hex(randomblob(8)))) ON CONFLICT(key) DO NOTHING",
      "CREATE TABLE sync_head (seq INTEGER NOT NULL)",
      "CREATE TABLE sync_objects (\n  kind TEXT NOT NULL,\n  id TEXT NOT NULL,\n  seq INTEGER NOT NULL,\n  deleted INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (kind, id)\n) WITHOUT ROWID",
      "CREATE INDEX sync_objects_seq ON sync_objects (seq)",
      "-- One row per installation; rows are never deleted. gone = 1 only comes from the disaster-recovery procedure.\nCREATE TABLE sync_clients (\n  install_id TEXT PRIMARY KEY,\n  last_mutation_id INTEGER NOT NULL DEFAULT 0,\n  last_seen TEXT NOT NULL,\n  gone INTEGER NOT NULL DEFAULT 0\n) WITHOUT ROWID",
      "-- Kept for good; resent to the installation while mutation_id > ackedMid.\nCREATE TABLE sync_rejections (\n  install_id TEXT NOT NULL,\n  mutation_id INTEGER NOT NULL,\n  code TEXT NOT NULL,\n  detail TEXT NOT NULL,\n  PRIMARY KEY (install_id, mutation_id)\n) WITHOUT ROWID",
      "-- Commit guard for D1 / Docker batches: a false check aborts the whole batch.\nCREATE TABLE sync_cas (ok INTEGER NOT NULL CHECK (ok = 1))",
      "INSERT INTO sync_head (seq) VALUES (0)"
    ]
  },
  {
    "name": "0010_sync_tokens.sql",
    "statements": [
      "-- App 同步令牌：每个令牌一行，签发与吊销是单行 INSERT / DELETE，不再读改写整张列表（并发签发不会恢复刚吊销的令牌）。\n-- 只存 SHA-256；明文只在签发时返回一次。\nCREATE TABLE sync_tokens (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  hash TEXT NOT NULL UNIQUE,\n  prefix TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT\n)",
      "-- 迁入此前存放在 kv 的令牌（若有），随后删除旧键\nINSERT OR IGNORE INTO sync_tokens (id, name, hash, prefix, created_at, last_used_at)\nSELECT json_extract(t.value, '$.id'), json_extract(t.value, '$.name'), json_extract(t.value, '$.hash'), json_extract(t.value, '$.prefix'),\n  json_extract(t.value, '$.createdAt'),\n  (SELECT json_extract(u.value, '$.' || json_quote(json_extract(t.value, '$.id'))) FROM kv u WHERE u.key = 'syncTokenUse')\nFROM kv k, json_each(k.value) t\nWHERE k.key = 'syncTokens' AND json_valid(k.value)",
      "DELETE FROM kv WHERE key IN ('syncTokens', 'syncTokenUse')"
    ]
  },
  {
    "name": "0011_sync_owner.sql",
    "statements": [
      "-- 安装归属（官方托管）：首次写入安装行的已验证主体（设备／令牌家族）。自部署单用户不填，保持 NULL，行为不变。\nALTER TABLE sync_clients ADD COLUMN owner TEXT;\n"
    ]
  },
  {
    "name": "0012_write_cas.sql",
    "statements": [
      "-- 网页、MCP 读改写守卫（worker/write-guard.ts）的提交核对表：首条 INSERT 核对账本序号未变，否则 CHECK 失败、整批回滚。\n-- 与同步的 sync_cas 分开：写守卫是通用并发修复（多标签页、MCP 互相覆盖），不依赖 App 同步是否启用。\nCREATE TABLE write_cas (ok INTEGER NOT NULL CHECK (ok = 1));\n"
    ]
  },
  {
    "name": "0013_sync_mode.sql",
    "statements": [
      "-- App 同步改为默认休眠（worker/sync-mode.ts）：sync_meta.mode = off | tokens | hosted。\n-- 新库的 0009 只建表；此前按旧版 0009 装过触发器的库在这里定状态：\n-- 已有同步令牌或已有安装记录（自部署在用，或官方托管已连接过设备）→ tokens，触发器与 sync_objects 原样保留；\n-- 否则 → off，迁移之后 reconcileSync 卸掉触发器、清空对象表。托管外层随后调用 enableSync 置为 hosted。\nINSERT INTO sync_meta (key, value)\nSELECT 'mode', CASE WHEN EXISTS (SELECT 1 FROM sync_tokens) OR EXISTS (SELECT 1 FROM sync_clients) THEN 'tokens' ELSE 'off' END\nWHERE 1\nON CONFLICT(key) DO NOTHING;\n"
    ]
  },
  {
    "name": "0014_sync_pair.sql",
    "statements": [
      "-- 扫码连接 App 的一次性配对码（docs/sync-api.md「扫码配对」）：\n-- 至多一个码（id 固定为 1，新码覆盖旧码），只存 SHA-256，5 分钟过期，只能兑换一次。\n-- 兑换后保留这一行并记下换出的令牌（token_id、token_name），网页凭配对码查询结果，直到生成下一个码\nCREATE TABLE sync_pair (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  hash TEXT NOT NULL,\n  expires_at INTEGER NOT NULL,\n  token_id TEXT,\n  token_name TEXT\n);\n"
    ]
  }
];

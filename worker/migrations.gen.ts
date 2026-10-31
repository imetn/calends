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
  }
];

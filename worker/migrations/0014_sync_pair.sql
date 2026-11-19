-- 扫码连接 App 的一次性配对码（docs/sync-api.md「扫码配对」）：
-- 至多一个有效码（id 固定为 1，新码覆盖旧码），只存 SHA-256，5 分钟过期，用一次即删，错 5 次作废
CREATE TABLE sync_pair (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);

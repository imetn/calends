-- 扫码连接 App 的一次性配对码（docs/sync-api.md「扫码配对」）：
-- 至多一个码（id 固定为 1，新码覆盖旧码），只存 SHA-256，5 分钟过期，只能兑换一次。
-- 兑换后保留这一行并记下换出的令牌（token_id、token_name），网页凭配对码查询结果，直到生成下一个码
CREATE TABLE sync_pair (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  token_id TEXT,
  token_name TEXT
);

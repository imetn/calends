-- App 同步令牌：每个令牌一行，签发与吊销是单行 INSERT / DELETE，不再读改写整张列表（并发签发不会恢复刚吊销的令牌）。
-- 只存 SHA-256；明文只在签发时返回一次。
CREATE TABLE sync_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- 迁入此前存放在 kv 的令牌（若有），随后删除旧键
INSERT OR IGNORE INTO sync_tokens (id, name, hash, prefix, created_at, last_used_at)
SELECT json_extract(t.value, '$.id'), json_extract(t.value, '$.name'), json_extract(t.value, '$.hash'), json_extract(t.value, '$.prefix'),
  json_extract(t.value, '$.createdAt'),
  (SELECT json_extract(u.value, '$.' || json_quote(json_extract(t.value, '$.id'))) FROM kv u WHERE u.key = 'syncTokenUse')
FROM kv k, json_each(k.value) t
WHERE k.key = 'syncTokens' AND json_valid(k.value);

DELETE FROM kv WHERE key IN ('syncTokens', 'syncTokenUse');

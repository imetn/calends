-- File center metadata. Content lives in object storage (R2 on Cloudflare, the data directory in Docker), keyed by sha256.
-- A file is softly linked to a subscription by (sub_id, kind, date); sub_id NULL means unlinked.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sub_id TEXT,
  kind TEXT,
  date TEXT,
  -- JSON snapshot {name, kind, date} written when the linked subscription is deleted.
  orphan TEXT,
  thumb INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX files_sub ON files (sub_id);
CREATE INDEX files_sha ON files (sha256);

CREATE TRIGGER rev_files_insert AFTER INSERT ON files
BEGIN
  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';
END;

CREATE TRIGGER rev_files_update AFTER UPDATE ON files
BEGIN
  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';
END;

CREATE TRIGGER rev_files_delete AFTER DELETE ON files
BEGIN
  UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev';
END;

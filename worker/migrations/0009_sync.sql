-- App sync (protocol v1, docs/sync-api.md). Tables live beside the ledger but are not part of it:
-- backup restore and replace import only rotate sync_meta.generation, never touch clients or rejections.
-- Self-hosted users without the App only get these tables and one or two extra trigger statements per ledger write.
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Random generation: a counter would collide with values clients saw before a physical rollback.
INSERT INTO sync_meta (key, value) VALUES ('generation', lower(hex(randomblob(8)))) ON CONFLICT(key) DO NOTHING;
-- Stable ledger identity, never changes.
INSERT INTO sync_meta (key, value) VALUES ('ledgerId', lower(hex(randomblob(16)))) ON CONFLICT(key) DO NOTHING;
-- Disaster-recovery epoch, changes only in the physical rollback procedure.
INSERT INTO sync_meta (key, value) VALUES ('drEpoch', lower(hex(randomblob(8)))) ON CONFLICT(key) DO NOTHING;

CREATE TABLE sync_head (seq INTEGER NOT NULL);

CREATE TABLE sync_objects (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

CREATE INDEX sync_objects_seq ON sync_objects (seq);

-- One row per installation; rows are never deleted. gone = 1 only comes from the disaster-recovery procedure.
CREATE TABLE sync_clients (
  install_id TEXT PRIMARY KEY,
  last_mutation_id INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL,
  gone INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Kept for good; resent to the installation while mutation_id > ackedMid.
CREATE TABLE sync_rejections (
  install_id TEXT NOT NULL,
  mutation_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (install_id, mutation_id)
) WITHOUT ROWID;

-- Commit guard for D1 / Docker batches: a false check aborts the whole batch.
CREATE TABLE sync_cas (ok INTEGER NOT NULL CHECK (ok = 1));

-- Backfill existing objects, numbered one by one.
INSERT INTO sync_objects (kind, id, seq, deleted)
SELECT kind, id, ROW_NUMBER() OVER (ORDER BY ord, id), 0 FROM (
  SELECT 'sub' AS kind, id, 1 AS ord FROM subscriptions
  UNION ALL SELECT 'method', id, 2 FROM methods
  UNION ALL SELECT 'kv', key, 3 FROM kv WHERE key IN ('settings', 'people')
  UNION ALL SELECT 'fx', date, 4 FROM fx_daily
);

INSERT INTO sync_head (seq) SELECT count(*) FROM sync_objects;

-- Every writer (web REST, MCP, sync, cron) bumps the sequence inside its own transaction. Same-value writes do not.
CREATE TRIGGER sync_subscriptions_insert AFTER INSERT ON subscriptions
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_subscriptions_update AFTER UPDATE ON subscriptions
WHEN OLD.data IS NOT NEW.data OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_subscriptions_delete AFTER DELETE ON subscriptions
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('sub', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;

CREATE TRIGGER sync_methods_insert AFTER INSERT ON methods
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_methods_update AFTER UPDATE ON methods
WHEN OLD.data IS NOT NEW.data OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', NEW.id, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_methods_delete AFTER DELETE ON methods
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('method', OLD.id, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;

CREATE TRIGGER sync_fx_daily_insert AFTER INSERT ON fx_daily
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', NEW.date, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_fx_daily_update AFTER UPDATE ON fx_daily
WHEN OLD.rates IS NOT NEW.rates OR OLD.source IS NOT NEW.source OR OLD.date IS NOT NEW.date
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', OLD.date, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', NEW.date, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_fx_daily_delete AFTER DELETE ON fx_daily
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('fx', OLD.date, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;

CREATE TRIGGER sync_kv_insert AFTER INSERT ON kv
WHEN NEW.key IN ('settings', 'people')
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('kv', NEW.key, (SELECT seq FROM sync_head), 0)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_kv_update AFTER UPDATE ON kv
WHEN (NEW.key IN ('settings', 'people') OR OLD.key IN ('settings', 'people')) AND (OLD.value IS NOT NEW.value OR OLD.key IS NOT NEW.key)
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) SELECT 'kv', OLD.key, (SELECT seq FROM sync_head), 1 WHERE OLD.key IS NOT NEW.key AND OLD.key IN ('settings', 'people')
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) SELECT 'kv', NEW.key, (SELECT seq FROM sync_head), 0 WHERE NEW.key IN ('settings', 'people')
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 0;
END;

CREATE TRIGGER sync_kv_delete AFTER DELETE ON kv
WHEN OLD.key IN ('settings', 'people')
BEGIN
  UPDATE sync_head SET seq = seq + 1;
  INSERT INTO sync_objects (kind, id, seq, deleted) VALUES ('kv', OLD.key, (SELECT seq FROM sync_head), 1)
    ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, deleted = 1;
END;

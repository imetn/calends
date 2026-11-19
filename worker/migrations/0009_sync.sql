-- App sync (protocol v1, docs/sync-api.md). Tables live beside the ledger but are not part of it:
-- backup restore and replace import only rotate sync_meta.generation, never touch clients or rejections.
-- Sync starts dormant: this migration only creates tables. The change-tracking triggers and the backfill of sync_objects
-- are installed when sync is enabled (first sync token, or the hosting layer's enableSync), see worker/sync-mode.ts.
-- Self-hosted users without the App only get these empty tables.
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

INSERT INTO sync_head (seq) VALUES (0);

-- Link collection receipt attachments directly to a shared-plan member receipt or proxy receipt id.
ALTER TABLE files ADD COLUMN receipt_id TEXT;
CREATE INDEX files_receipt ON files (sub_id, receipt_id);

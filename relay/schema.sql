-- Relay buffer for watch batches awaiting drain into the local Akari Health service.
-- Rows are deleted only after the drain client confirms local ingest.
CREATE TABLE IF NOT EXISTS relay_batches (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,
  producer TEXT NOT NULL,
  sent_at INTEGER,
  received_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  target_path TEXT NOT NULL DEFAULT '/v1/health/batches'
);
CREATE INDEX IF NOT EXISTS idx_relay_batches_received_at ON relay_batches (received_at);
CREATE INDEX IF NOT EXISTS idx_relay_batches_target_path ON relay_batches (target_path, row_id);

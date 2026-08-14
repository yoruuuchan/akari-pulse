ALTER TABLE relay_batches
  ADD COLUMN target_path TEXT NOT NULL DEFAULT '/v1/health/batches';

CREATE INDEX IF NOT EXISTS idx_relay_batches_target_path
  ON relay_batches (target_path, row_id);

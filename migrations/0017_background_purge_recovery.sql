-- Add recovery state for idempotent background purge across D1 and R2
ALTER TABLE background_media ADD COLUMN purge_started_at INTEGER
  CHECK (purge_started_at IS NULL OR (
    typeof(purge_started_at) = 'integer' AND
    purge_started_at >= created_at AND
    status = 'archived'
  ));

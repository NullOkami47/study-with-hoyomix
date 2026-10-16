-- Add atomic finalisation recovery state for background purge
ALTER TABLE background_media ADD COLUMN purge_finalising_at INTEGER
  CHECK (purge_finalising_at IS NULL OR (
    typeof(purge_finalising_at) = 'integer' AND
    purge_finalising_at >= purge_started_at AND
    status = 'archived'
  ));

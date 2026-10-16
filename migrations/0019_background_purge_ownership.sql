-- Durable ownership for cross-isolate purge finalisation fencing
-- Resolves the ambiguity where purge_finalising_at alone cannot distinguish
-- an active owner still finalising from a dead owner requiring recovery.
ALTER TABLE background_media ADD COLUMN purge_finalising_token TEXT
  CHECK (purge_finalising_token IS NULL OR (
    typeof(purge_finalising_token) = 'text' AND
    length(purge_finalising_token) > 0 AND
    purge_finalising_at IS NOT NULL
  ));

ALTER TABLE background_media ADD COLUMN purge_lease_expires_at INTEGER
  CHECK (purge_lease_expires_at IS NULL OR (
    typeof(purge_lease_expires_at) = 'integer' AND
    purge_lease_expires_at > purge_finalising_at AND
    purge_finalising_token IS NOT NULL
  ));

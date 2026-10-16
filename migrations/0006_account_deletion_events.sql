CREATE TABLE account_deletion_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  event_type TEXT NOT NULL CHECK (event_type = 'avatar.delete'),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  processed_at INTEGER CHECK (processed_at IS NULL OR processed_at >= created_at)
) STRICT;

CREATE INDEX idx_account_deletion_events_pending
  ON account_deletion_events (processed_at, created_at);

CREATE TABLE library_sync_state (
  user_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

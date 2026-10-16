-- Add presentation metadata to background_media and create static_background_overrides
-- for administrative metadata edits, toggling, and tombstones of shipped static media.

ALTER TABLE background_media ADD COLUMN title TEXT
  CHECK (title IS NULL OR (length(trim(title)) > 0 AND length(title) <= 120));

ALTER TABLE background_media ADD COLUMN game TEXT
  CHECK (game IS NULL OR (length(trim(game)) > 0 AND length(game) <= 64));

ALTER TABLE background_media ADD COLUMN collection TEXT
  CHECK (collection IS NULL OR (length(trim(collection)) > 0 AND length(collection) <= 64));

ALTER TABLE background_media ADD COLUMN display_order INTEGER DEFAULT 0
  CHECK (display_order IS NULL OR (typeof(display_order) = 'integer' AND display_order >= 0));

CREATE TABLE static_background_overrides (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0 AND length(id) <= 64),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'archived', 'tombstoned')),
  title TEXT CHECK (title IS NULL OR (length(trim(title)) > 0 AND length(title) <= 120)),
  game TEXT CHECK (game IS NULL OR (length(trim(game)) > 0 AND length(game) <= 64)),
  collection TEXT CHECK (collection IS NULL OR (length(trim(collection)) > 0 AND length(collection) <= 64)),
  display_order INTEGER CHECK (display_order IS NULL OR (typeof(display_order) = 'integer' AND display_order >= 0)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_static_background_overrides_status
  ON static_background_overrides (status, updated_at DESC);

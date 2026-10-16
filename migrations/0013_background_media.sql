CREATE TABLE background_media (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0 AND length(id) <= 64),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  current_revision_id TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  published_at INTEGER CHECK (published_at IS NULL OR (
    typeof(published_at) = 'integer' AND published_at >= created_at
  )),
  archived_at INTEGER CHECK (archived_at IS NULL OR (
    typeof(archived_at) = 'integer' AND archived_at >= created_at
  )),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND archived_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL AND archived_at IS NULL) OR
    (status = 'archived' AND archived_at IS NOT NULL)
  ),
  FOREIGN KEY (current_revision_id)
    REFERENCES background_media_revisions(id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE background_media_revisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0 AND length(id) <= 64),
  background_id TEXT NOT NULL CHECK (length(background_id) > 0),
  revision_number INTEGER NOT NULL CHECK (
    typeof(revision_number) = 'integer' AND revision_number >= 1
  ),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  object_key TEXT NOT NULL UNIQUE CHECK (
    length(object_key) BETWEEN 40 AND 240 AND
    substr(object_key, 1, 12) = 'backgrounds/' AND
    instr(object_key, '/revisions/') > 12 AND
    instr(object_key, '..') = 0 AND
    instr(object_key, char(92)) = 0 AND
    instr(object_key, 'tracks/authorized/') = 0
  ),
  poster_object_key TEXT UNIQUE CHECK (poster_object_key IS NULL OR (
    length(poster_object_key) BETWEEN 40 AND 240 AND
    substr(poster_object_key, 1, 12) = 'backgrounds/' AND
    instr(poster_object_key, '/posters/') > 12 AND
    instr(poster_object_key, '..') = 0 AND
    instr(poster_object_key, char(92)) = 0 AND
    instr(poster_object_key, 'tracks/authorized/') = 0
  )),
  content_type TEXT NOT NULL CHECK (content_type IN (
    'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'
  )),
  byte_size INTEGER NOT NULL CHECK (typeof(byte_size) = 'integer' AND byte_size > 0),
  width INTEGER NOT NULL CHECK (
    typeof(width) = 'integer' AND width BETWEEN 1 AND 7680
  ),
  height INTEGER NOT NULL CHECK (
    typeof(height) = 'integer' AND height BETWEEN 1 AND 4320
  ),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (
    typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 1 AND 30000
  )),
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  FOREIGN KEY (background_id) REFERENCES background_media(id) ON DELETE CASCADE,
  UNIQUE (background_id, revision_number),
  CHECK (
    (kind = 'image' AND content_type IN ('image/jpeg', 'image/png', 'image/webp') AND
      byte_size <= 12582912 AND duration_ms IS NULL AND poster_object_key IS NULL) OR
    (kind = 'video' AND content_type IN ('video/mp4', 'video/webm') AND
      byte_size <= 26214400 AND duration_ms IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_background_media_status_updated
  ON background_media (status, updated_at DESC);

CREATE INDEX idx_background_media_revisions_background
  ON background_media_revisions (background_id, revision_number DESC);

CREATE TABLE user_background_selections (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selection_json TEXT NOT NULL CHECK (
    json_valid(selection_json) AND
    json_type(selection_json) = 'array' AND
    json_array_length(selection_json) BETWEEN 1 AND 8
  ),
  auto_rotate INTEGER NOT NULL DEFAULT 1 CHECK (auto_rotate IN (0, 1)),
  interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK (
    interval_seconds IN (15, 30, 60, 300)
  ),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_background_selections_updated
  ON user_background_selections (updated_at DESC);

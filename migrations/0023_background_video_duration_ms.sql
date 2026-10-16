-- Relax the background video duration bound from 30s to 120s.
--
-- The shipped native-quality background catalogue (public/backgrounds/zzz)
-- contains clips up to ~36.4s at 4K/60, so the registration table must accept
-- them: the 30s bound rejected the two longest clips. Size and dimension
-- bounds are untouched (25 MiB / 7680x4320), and images still carry
-- duration_ms = NULL.
--
-- SQLite cannot ALTER a CHECK constraint, so the revisions table is rebuilt.
-- background_media.current_revision_id references this table with ON DELETE
-- RESTRICT, so every pointer is parked in a helper table, cleared, and
-- re-attached against the rebuilt rows before the helper is dropped.
CREATE TABLE background_media_revision_pointers (
  media_id TEXT PRIMARY KEY NOT NULL,
  revision_id TEXT NOT NULL
);
INSERT INTO background_media_revision_pointers (media_id, revision_id)
  SELECT id, current_revision_id FROM background_media WHERE current_revision_id IS NOT NULL;
UPDATE background_media SET current_revision_id = NULL WHERE current_revision_id IS NOT NULL;

CREATE TABLE background_media_revisions_v2 (
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
    typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 1 AND 120000
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

INSERT INTO background_media_revisions_v2 (
  id, background_id, revision_number, kind, object_key, poster_object_key,
  content_type, byte_size, width, height, duration_ms, provenance_json,
  created_by, created_at
)
SELECT
  id, background_id, revision_number, kind, object_key, poster_object_key,
  content_type, byte_size, width, height, duration_ms, provenance_json,
  created_by, created_at
FROM background_media_revisions;

DROP TABLE background_media_revisions;
ALTER TABLE background_media_revisions_v2 RENAME TO background_media_revisions;
CREATE INDEX idx_background_media_revisions_background
  ON background_media_revisions (background_id, revision_number DESC);

UPDATE background_media SET current_revision_id = (
  SELECT revision_id FROM background_media_revision_pointers
  WHERE media_id = background_media.id
) WHERE EXISTS (
  SELECT 1 FROM background_media_revision_pointers WHERE media_id = background_media.id
);
DROP TABLE background_media_revision_pointers;

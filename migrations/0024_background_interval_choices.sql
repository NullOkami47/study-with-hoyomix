-- Rotation intervals move from the short second counts (15/30/60/300) to the
-- four user-facing choices of 10/20/30/60 minutes, defaulting to 20 minutes.
--
-- The legacy values stay in the CHECK constraint on purpose: rows written by
-- earlier builds keep their stored cadence, account sync may still re-save one
-- unchanged, and only an explicit user choice writes a canonical value.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt through a
-- helper copy and the existing rows are carried across verbatim.
CREATE TABLE user_background_selections_v2 (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selection_json TEXT NOT NULL CHECK (
    json_valid(selection_json) AND
    json_type(selection_json) = 'array' AND
    json_array_length(selection_json) BETWEEN 1 AND 8
  ),
  auto_rotate INTEGER NOT NULL DEFAULT 1 CHECK (auto_rotate IN (0, 1)),
  interval_seconds INTEGER NOT NULL DEFAULT 1200 CHECK (
    interval_seconds IN (15, 30, 60, 300, 600, 1200, 1800, 3600)
  ),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

INSERT INTO user_background_selections_v2 (
  user_id, selection_json, auto_rotate, interval_seconds, updated_at
)
SELECT user_id, selection_json, auto_rotate, interval_seconds, updated_at
FROM user_background_selections;

DROP TABLE user_background_selections;

ALTER TABLE user_background_selections_v2 RENAME TO user_background_selections;

CREATE INDEX idx_user_background_selections_updated
  ON user_background_selections (updated_at DESC);

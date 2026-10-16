-- Focus eligibility is explicitly classified and independent of historical vocal status.
-- Preserve every existing row and all child mappings in the same atomic migration.
-- Child foreign keys have no cascading delete actions and remain bound to catalogue_tracks.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE catalogue_tracks_focus_independent (
  track_id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500), album TEXT, release_date TEXT,
  vocal_status TEXT NOT NULL CHECK(vocal_status IN ('instrumental','vocal','uncertain')),
  focus INTEGER NOT NULL DEFAULT 0 CHECK(focus IN (0,1)), sleep INTEGER NOT NULL DEFAULT 0 CHECK(sleep IN (0,1)), chill INTEGER NOT NULL DEFAULT 0 CHECK(chill IN (0,1)),
  work_group_id TEXT NOT NULL, needs_classification INTEGER NOT NULL DEFAULT 1 CHECK(needs_classification IN (0,1)),
  metadata_confidence REAL CHECK(metadata_confidence BETWEEN 0 AND 1), evidence TEXT, notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER NOT NULL
) STRICT;
INSERT INTO catalogue_tracks_focus_independent SELECT * FROM catalogue_tracks;
DROP TABLE catalogue_tracks;
ALTER TABLE catalogue_tracks_focus_independent RENAME TO catalogue_tracks;
PRAGMA defer_foreign_keys = OFF;

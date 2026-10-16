-- Published catalogue and immutable staging proposals. No Sheet operation writes live rows.
CREATE TABLE catalogue_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
INSERT INTO catalogue_state VALUES (1, 1);
-- Focus classification is independent of vocal status.
CREATE TABLE catalogue_tracks (
  track_id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500), album TEXT, release_date TEXT,
  vocal_status TEXT NOT NULL CHECK(vocal_status IN ('instrumental','vocal','uncertain')),
  focus INTEGER NOT NULL DEFAULT 0 CHECK(focus IN (0,1)), sleep INTEGER NOT NULL DEFAULT 0 CHECK(sleep IN (0,1)), chill INTEGER NOT NULL DEFAULT 0 CHECK(chill IN (0,1)),
  work_group_id TEXT NOT NULL, needs_classification INTEGER NOT NULL DEFAULT 1 CHECK(needs_classification IN (0,1)),
  metadata_confidence REAL CHECK(metadata_confidence BETWEEN 0 AND 1), evidence TEXT, notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER NOT NULL
) STRICT;
CREATE TABLE catalogue_track_games (
  track_id TEXT NOT NULL REFERENCES catalogue_tracks(track_id), game TEXT NOT NULL CHECK(game IN ('genshin','hsr','zzz')), PRIMARY KEY(track_id,game)
) STRICT;
CREATE TABLE catalogue_track_relations (
  track_id TEXT NOT NULL REFERENCES catalogue_tracks(track_id), relation_id TEXT NOT NULL, PRIMARY KEY(track_id,relation_id)
) STRICT;
CREATE TABLE catalogue_sources (
  source_row_id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES catalogue_tracks(track_id), provider TEXT NOT NULL, external_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'audio', source_status TEXT NOT NULL DEFAULT 'active' CHECK(source_status IN ('active','disabled')),
  source_confidence REAL CHECK(source_confidence BETWEEN 0 AND 1), rights_status TEXT NOT NULL DEFAULT 'unverified',
  metadata_json TEXT NOT NULL DEFAULT '{}', evidence TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(provider,external_id), UNIQUE(track_id,provider)
) STRICT;
CREATE INDEX idx_catalogue_sources_track ON catalogue_sources(track_id);
CREATE TABLE catalogue_aliases (
  track_id TEXT NOT NULL REFERENCES catalogue_tracks(track_id), locale TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(track_id,locale,alias)
) STRICT;
CREATE TABLE catalogue_import_batches (
  batch_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('draft','validated','published','rejected')),
  snapshot_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, summary_json TEXT NOT NULL,
  base_revision INTEGER NOT NULL, review_revision INTEGER NOT NULL DEFAULT 1 CHECK(review_revision>=1),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, published_by TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX idx_catalogue_import_batches_active_snapshot ON catalogue_import_batches(snapshot_hash,base_revision) WHERE status IN ('draft','validated');
CREATE TABLE catalogue_import_changes (
  change_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES catalogue_import_batches(batch_id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('track','source','alias','validation')),
  entity_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('new_track','metadata_change','classification_change','new_source','source_change','new_alias','conflict','validation_error')),
  before_json TEXT, after_json TEXT, validation_state TEXT NOT NULL CHECK(validation_state IN ('valid','error','conflict')),
  validation_messages_json TEXT NOT NULL DEFAULT '[]', confidence REAL CHECK(confidence BETWEEN 0 AND 1),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected')),
  CHECK(decision != 'approved' OR validation_state='valid')
) STRICT;
CREATE INDEX idx_catalogue_import_changes_batch_decision ON catalogue_import_changes(batch_id,decision);

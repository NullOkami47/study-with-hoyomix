-- Candidate inbox only. Published catalogue and review authority are unchanged.
CREATE TABLE catalogue_discovery_runs (
 run_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, summary_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE catalogue_discovery_candidates (
 candidate_id TEXT PRIMARY KEY, video_id TEXT NOT NULL UNIQUE, track_id TEXT NOT NULL,
 discovery_json TEXT NOT NULL, suggestion_json TEXT NOT NULL,
 classification_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(classification_reviewed IN (0,1)),
 sources_json TEXT NOT NULL DEFAULT '[]', conflicts_json TEXT NOT NULL DEFAULT '[]',
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
 stage_state TEXT NOT NULL DEFAULT 'pending' CHECK(stage_state IN ('pending','staged','uncertain')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE catalogue_discovery_locks (
 lock_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_catalogue_discovery_updated ON catalogue_discovery_candidates(updated_at);
CREATE INDEX idx_catalogue_discovery_runs_created ON catalogue_discovery_runs(created_at);

-- A durable append intent allows reconciliation after a lost Google response.
CREATE TABLE catalogue_discovery_sheet_operations (
 candidate_id TEXT PRIMARY KEY REFERENCES catalogue_discovery_candidates(candidate_id),
 plan_json TEXT NOT NULL, base_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;

-- Dynamic catalogue-wide discovery cache for the ChKSz provider.
-- Persists verified provider IDs and negative cache entries with TTL.
-- Never stores API keys, credentials, or transient playback tokens.
CREATE TABLE chksz_dynamic_discoveries (
  canonical_track_id TEXT PRIMARY KEY NOT NULL CHECK (length(canonical_track_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL DEFAULT 'chksz' CHECK (provider = 'chksz'),
  provider_external_id TEXT CHECK (provider_external_id IS NULL OR length(provider_external_id) BETWEEN 1 AND 64),
  match_confidence TEXT NOT NULL CHECK (match_confidence IN ('EXACT', 'HIGH_CONFIDENCE', 'AMBIGUOUS', 'NO_MATCH', 'CONFLICT', 'UPSTREAM_ERROR')),
  matcher_version TEXT NOT NULL CHECK (length(matcher_version) BETWEEN 1 AND 64),
  canonical_metadata_fingerprint TEXT NOT NULL CHECK (length(canonical_metadata_fingerprint) BETWEEN 1 AND 128),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  discovered_at INTEGER NOT NULL CHECK (discovered_at >= 0),
  last_verified_at INTEGER NOT NULL CHECK (last_verified_at >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'rejected', 'error')),
  failure_reason TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0)
) STRICT;

CREATE INDEX idx_chksz_dynamic_discoveries_status
  ON chksz_dynamic_discoveries (status, expires_at);

-- Distributed lock table for coordinating cross-isolate search operations.
CREATE TABLE chksz_discovery_locks (
  lock_key TEXT PRIMARY KEY NOT NULL CHECK (length(lock_key) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0)
) STRICT;

-- Global rolling-window rate-limit events across all isolates.
CREATE TABLE chksz_discovery_rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX idx_chksz_discovery_rate_events_created
  ON chksz_discovery_rate_events (created_at);

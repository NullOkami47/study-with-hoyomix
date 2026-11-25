-- Global (server-owned) LX source registry.
--
-- The personal LX sources a user imports live in their own IndexedDB and are never touched here.
-- This registry holds the sources the Owner publishes for everybody: metadata in
-- `lx_global_sources`, and the immutable script snapshots in `lx_global_source_snapshots`.
--
-- Snapshots are append-only and content-addressed by SHA-256. The active script of a source is the
-- snapshot whose digest `lx_global_sources.active_sha256` names, so:
--   * an update never overwrites a script: it appends a new snapshot and moves the pointer
--   * a failed update leaves the pointer, and therefore playback, exactly where it was
--   * a rollback is a pointer move, not a data restore.
--
-- There is no R2 bucket binding in this deployment (`wrangler.toml` binds D1 only, and the R2 base
-- URL is a read-only public origin), so D1 is the only storage that can hold a snapshot *and* take
-- part in the same atomic statement as the metadata. Snapshots are bounded at 512 KiB, the same
-- limit the sandbox already enforces on a script.
--
-- `required_origins` records the network origins the script's static analysis found. They are
-- published so the client can check them against the *deployed* CSP — the build-time source list it
-- actually runs under — instead of the server guessing. A source whose origins are not all
-- permitted is not published, it stays `pending_network_approval` and never reaches a user.
CREATE TABLE lx_global_sources (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  version TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
  origin_url TEXT NOT NULL CHECK (length(origin_url) BETWEEN 8 AND 2048),
  active_sha256 TEXT NOT NULL CHECK (length(active_sha256) = 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'pending_network_approval', 'failed')),
  required_origins TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_origins)),
  pending_origins TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_origins)),
  origin_kind TEXT NOT NULL DEFAULT 'url' CHECK (origin_kind IN ('url', 'upload')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_checked_at INTEGER CHECK (last_checked_at IS NULL OR last_checked_at >= 0),
  last_check_note TEXT
) STRICT;

CREATE INDEX idx_lx_global_sources_order
  ON lx_global_sources (enabled, priority, id);

-- Immutable script snapshots. A row is written once and never updated: the same digest always
-- yields the same bytes, which is what makes "the client caches by SHA-256" sound.
CREATE TABLE lx_global_source_snapshots (
  source_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  script TEXT NOT NULL CHECK (length(script) BETWEEN 1 AND 524288),
  version TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  note TEXT,
  PRIMARY KEY (source_id, sha256),
  FOREIGN KEY (source_id) REFERENCES lx_global_sources (id) ON DELETE CASCADE
) STRICT;

-- A monotonic revision, bumped by every mutation of the registry. Clients cache the published list
-- by revision and the script bodies by digest, so a revision bump is the only thing that ever
-- invalidates the list.
CREATE TABLE lx_global_registry (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT OR IGNORE INTO lx_global_registry (id, revision, updated_at) VALUES (1, 1, 0);

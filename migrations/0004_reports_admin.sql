CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  actor_user_id TEXT,
  target_user_id TEXT,
  target_message_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'delete_message',
      'temporary_ban',
      'permanent_ban',
      'remove_avatar',
      'disable_avatar_upload',
      'resolve_report'
    )
  ),
  reason TEXT,
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_moderation_actions_target_created
  ON moderation_actions (target_user_id, created_at DESC);

CREATE TABLE catalog_reports (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  reporter_user_id TEXT,
  canonical_track_id TEXT NOT NULL CHECK (length(canonical_track_id) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'taxonomy',
      'metadata',
      'playback',
      'missing',
      'duplicate',
      'work_grouping'
    )
  ),
  current_value_json TEXT NOT NULL CHECK (json_valid(current_value_json)),
  proposed_value_json TEXT NOT NULL CHECK (json_valid(proposed_value_json)),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  reviewed_by TEXT,
  reviewed_at INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_catalog_reports_reporter_status
  ON catalog_reports (reporter_user_id, status, created_at DESC);

CREATE INDEX idx_catalog_reports_status_created
  ON catalog_reports (status, created_at);

CREATE UNIQUE INDEX idx_catalog_reports_pending_unique
  ON catalog_reports (reporter_user_id, canonical_track_id, kind)
  WHERE status = 'pending';

CREATE TABLE catalog_revisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  report_id TEXT NOT NULL,
  reviewer_user_id TEXT,
  canonical_track_id TEXT NOT NULL CHECK (length(canonical_track_id) BETWEEN 1 AND 256),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  reverted_at INTEGER CHECK (reverted_at IS NULL OR reverted_at >= 0),
  reverted_by TEXT,
  FOREIGN KEY (report_id) REFERENCES catalog_reports(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reverted_by) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_catalog_revisions_report
  ON catalog_revisions (report_id, created_at DESC);

CREATE TABLE provider_health (
  provider_key TEXT PRIMARY KEY NOT NULL CHECK (length(provider_key) > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL CHECK (priority >= 0),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  failure_class TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  checked_at INTEGER CHECK (checked_at IS NULL OR checked_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE INDEX idx_provider_health_priority
  ON provider_health (enabled DESC, priority);

CREATE TABLE filter_rules (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('literal', 'regex', 'url')),
  pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 500),
  replacement TEXT NOT NULL DEFAULT '***',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_filter_rules_enabled_kind
  ON filter_rules (enabled, kind, updated_at DESC);

CREATE TABLE chat_reports (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  reporter_user_id TEXT,
  message_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'rejected', 'withdrawn')),
  resolved_by TEXT,
  resolution_note TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= 0),
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX idx_chat_reports_pending_unique
  ON chat_reports (reporter_user_id, message_id)
  WHERE status = 'pending';

CREATE INDEX idx_chat_reports_status_created
  ON chat_reports (status, created_at);

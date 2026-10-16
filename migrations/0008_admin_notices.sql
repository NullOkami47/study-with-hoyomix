CREATE TABLE admin_notices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'critical')),
  targeting TEXT NOT NULL DEFAULT 'everyone'
    CHECK (targeting IN ('everyone', 'authenticated', 'anonymous', 'admin')),
  current_revision_id TEXT NOT NULL CHECK (length(current_revision_id) > 0),
  start_at INTEGER CHECK (start_at IS NULL OR start_at >= 0),
  end_at INTEGER CHECK (end_at IS NULL OR end_at >= 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  published_at INTEGER CHECK (published_at IS NULL OR published_at >= 0),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE admin_notice_revisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  notice_id TEXT NOT NULL CHECK (length(notice_id) > 0),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
  content_json TEXT NOT NULL CHECK (
    json_valid(content_json) AND json_type(content_json) = 'object'
  ),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  FOREIGN KEY (notice_id) REFERENCES admin_notices(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_admin_notices_status_start
  ON admin_notices (status, start_at);

CREATE INDEX idx_admin_notice_revisions_notice
  ON admin_notice_revisions (notice_id, revision_number DESC);

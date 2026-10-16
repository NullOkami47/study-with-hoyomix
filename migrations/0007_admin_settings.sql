CREATE TABLE admin_settings (
  setting_key TEXT PRIMARY KEY NOT NULL CHECK (length(setting_key) BETWEEN 1 AND 160),
  setting_json TEXT NOT NULL CHECK (
    json_valid(setting_json) AND json_type(setting_json) = 'object'
  ),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  target_key TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 160),
  detail_json TEXT NOT NULL CHECK (
    json_valid(detail_json) AND json_type(detail_json) = 'object'
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_admin_audit_log_created
  ON admin_audit_log (created_at DESC, id);

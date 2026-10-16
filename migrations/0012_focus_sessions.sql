CREATE TABLE focus_sessions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 36),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  planned_focus_seconds INTEGER NOT NULL CHECK (planned_focus_seconds > 0),
  actual_focus_seconds INTEGER NOT NULL
    CHECK (actual_focus_seconds BETWEEN 1 AND planned_focus_seconds),
  status TEXT NOT NULL CHECK (status IN ('completed', 'interrupted')),
  phase TEXT NOT NULL CHECK (phase = 'focus'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_focus_sessions_user_ended
  ON focus_sessions (user_id, ended_at, id);

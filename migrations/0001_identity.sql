CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin', 'owner')),
  avatar_upload_disabled INTEGER NOT NULL DEFAULT 0 CHECK (avatar_upload_disabled IN (0, 1)),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(settings_json) AND json_type(settings_json) = 'object'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
) STRICT;

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_auth_identities_user
  ON auth_identities (user_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 79
    AND substr(token_hash, 1, 15) = 'hmac-sha256:v1:'
    AND substr(token_hash, 16) NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_sessions_user_active
  ON sessions (user_id, revoked_at, expires_at);

CREATE INDEX idx_sessions_expiry
  ON sessions (expires_at);

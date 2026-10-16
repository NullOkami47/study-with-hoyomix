CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK (
    length(state_hash) = 79
    AND substr(state_hash, 1, 15) = 'hmac-sha256:v1:'
    AND substr(state_hash, 16) NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;

CREATE INDEX idx_oauth_flows_expiry
  ON oauth_flows (expires_at, consumed_at);

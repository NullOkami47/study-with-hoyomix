-- Allow LINUX DO as an authentication provider in auth_identities and oauth_flows.
--
-- Rebuilds auth_identities and oauth_flows to expand the provider CHECK
-- constraints from ('google', 'github') to ('google', 'github', 'linuxdo').
-- Preserves all existing rows, primary keys, unique constraints, foreign keys,
-- indices, timestamps, and STRICT table semantics.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE auth_identities_v2 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'linuxdo')),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

INSERT INTO auth_identities_v2 (id, user_id, provider, provider_subject, created_at, last_used_at)
SELECT id, user_id, provider, provider_subject, created_at, last_used_at
FROM auth_identities;

DROP TABLE auth_identities;

ALTER TABLE auth_identities_v2 RENAME TO auth_identities;

CREATE INDEX idx_auth_identities_user
  ON auth_identities (user_id, created_at);

CREATE TABLE oauth_flows_v2 (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK (
    length(state_hash) = 79
    AND substr(state_hash, 1, 15) = 'hmac-sha256:v1:'
    AND substr(state_hash, 16) NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'linuxdo')),
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;

INSERT INTO oauth_flows_v2 (state_hash, provider, intent, created_at, expires_at, consumed_at)
SELECT state_hash, provider, intent, created_at, expires_at, consumed_at
FROM oauth_flows;

DROP TABLE oauth_flows;

ALTER TABLE oauth_flows_v2 RENAME TO oauth_flows;

CREATE INDEX idx_oauth_flows_expiry
  ON oauth_flows (expires_at, consumed_at);

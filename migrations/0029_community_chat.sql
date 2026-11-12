CREATE TABLE chat_bans (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chat_send_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_request_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 100),
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, request_id)
) STRICT, WITHOUT ROWID;

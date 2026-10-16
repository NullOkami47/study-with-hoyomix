CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  room_id TEXT NOT NULL DEFAULT 'global' CHECK (length(room_id) BETWEEN 1 AND 64),
  user_id TEXT,
  author_display_name TEXT NOT NULL CHECK (length(author_display_name) BETWEEN 1 AND 80),
  content TEXT NOT NULL CHECK (length(content) <= 500),
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'sticker', 'track')),
  sticker_id TEXT,
  track_id TEXT CHECK (track_id IS NULL OR length(track_id) BETWEEN 1 AND 256),
  coarse_location TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER CHECK (updated_at IS NULL OR updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_chat_messages_room_created
  ON chat_messages (room_id, created_at DESC, id DESC);

CREATE INDEX idx_chat_messages_retention
  ON chat_messages (expires_at, created_at);

CREATE TABLE chat_message_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  message_id TEXT NOT NULL,
  editor_user_id TEXT,
  original_content TEXT NOT NULL CHECK (length(original_content) <= 500),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (editor_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_chat_message_versions_message_created
  ON chat_message_versions (message_id, created_at DESC);

CREATE TABLE user_blocks (
  blocking_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (blocking_user_id, blocked_user_id),
  CHECK (blocking_user_id <> blocked_user_id),
  FOREIGN KEY (blocking_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_user_blocks_blocked
  ON user_blocks (blocked_user_id, created_at DESC);

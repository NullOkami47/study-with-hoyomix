CREATE INDEX idx_chat_messages_room_expiry ON chat_messages(room_id, expires_at, id);
CREATE INDEX idx_chat_versions_expiry ON chat_message_versions(expires_at, id);
CREATE INDEX idx_chat_receipts_message ON chat_request_receipts(message_id);
CREATE INDEX idx_chat_reports_message ON chat_reports(message_id);
CREATE INDEX idx_chat_moderation_message ON moderation_actions(target_message_id);

CREATE TABLE chat_retention_pending (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_retention_state (
  room_id TEXT PRIMARY KEY NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count >= 0),
  floor_created_at INTEGER,
  floor_id TEXT,
  CHECK((floor_created_at IS NULL) = (floor_id IS NULL))
) STRICT, WITHOUT ROWID;

INSERT INTO chat_retention_state(room_id,message_count,floor_created_at,floor_id)
SELECT 'global',COUNT(*),
  (SELECT created_at FROM chat_messages WHERE room_id='global' ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 9999),
  (SELECT id FROM chat_messages WHERE room_id='global' ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 9999)
FROM chat_messages WHERE room_id='global';

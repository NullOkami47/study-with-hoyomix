CREATE TABLE user_provider_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  disabled_provider_ids_json TEXT NOT NULL CHECK (
    json_valid(disabled_provider_ids_json) AND
    json_type(disabled_provider_ids_json) = 'array' AND
    json_array_length(disabled_provider_ids_json) BETWEEN 0 AND 13
  ),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_provider_preferences_updated
  ON user_provider_preferences (updated_at DESC);

-- A separate, strictly scoped preference envelope. Legacy library favourites,
-- playlists, listening history and settings_json are untouched.
CREATE TABLE user_ui_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferences_json TEXT NOT NULL CHECK (
    json_valid(preferences_json) AND json_type(preferences_json) = 'object'
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT, WITHOUT ROWID;

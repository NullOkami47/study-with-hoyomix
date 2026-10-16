CREATE TABLE favourites (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_favourites_user_created
  ON favourites (user_id, created_at DESC);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'pending', 'published', 'rejected')),
  share_token_hash TEXT UNIQUE,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_playlists_user_updated
  ON playlists (user_id, updated_at DESC);

CREATE INDEX idx_playlists_gallery
  ON playlists (visibility, reviewed_at DESC, updated_at DESC);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 256),
  position INTEGER NOT NULL CHECK (position >= 0),
  added_at INTEGER NOT NULL CHECK (added_at >= 0),
  PRIMARY KEY (playlist_id, track_id),
  UNIQUE (playlist_id, position),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_playlist_tracks_playlist_position
  ON playlist_tracks (playlist_id, position);

CREATE TABLE listening_history (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 256),
  played_at INTEGER NOT NULL CHECK (played_at >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_listening_history_user_played
  ON listening_history (user_id, played_at DESC, id DESC);

-- Playback revisions must describe encoded media within the shared 1440p30 cap.
-- Originals remain in existing R2/static assets and this never rewrites media bytes.
ALTER TABLE background_media_revisions ADD COLUMN fps REAL
  CHECK (kind != 'video' OR (
    width <= 2560 AND height <= 1440 AND
    fps IS NOT NULL AND fps > 0 AND fps <= 30
  ));

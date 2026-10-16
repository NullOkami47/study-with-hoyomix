INSERT OR IGNORE INTO provider_health
  (provider_key, enabled, priority, status, updated_at)
VALUES
  ('lx-huibq', 0, 3, 'unknown', 0),
  ('lx-ikun', 0, 4, 'unknown', 0),
  ('lx-juhe', 0, 5, 'unknown', 0),
  ('lx-qdy', 0, 6, 'unknown', 0),
  ('lx-flower', 0, 7, 'unknown', 0),
  ('lx-lx', 0, 8, 'unknown', 0),
  ('lx-grass', 0, 9, 'unknown', 0),
  ('lx-sixyin', 0, 10, 'unknown', 0);

UPDATE provider_health SET enabled = 0, priority = 1
WHERE provider_key = 'r2' AND updated_at = 0;

UPDATE provider_health SET enabled = 0, priority = 2
WHERE provider_key = 'meting' AND updated_at = 0;

UPDATE provider_health SET enabled = 0, priority = 11
WHERE provider_key = 'chksz' AND updated_at = 0;

UPDATE provider_health SET enabled = 0, priority = 12
WHERE provider_key = 'piped' AND updated_at = 0;

UPDATE provider_health SET enabled = 0, priority = 13
WHERE provider_key = 'invidious' AND updated_at = 0;

UPDATE provider_health SET enabled = 0, priority = 90
WHERE provider_key = 'youtube' AND updated_at = 0;

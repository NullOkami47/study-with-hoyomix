UPDATE provider_health
SET enabled = 0, priority = 1
WHERE provider_key = 'r2' AND updated_at = 0;

UPDATE provider_health
SET enabled = 0, priority = 2
WHERE provider_key = 'meting' AND updated_at = 0;

UPDATE provider_health
SET enabled = 0, priority = 3
WHERE provider_key = 'chksz' AND updated_at = 0;

UPDATE provider_health
SET enabled = 0, priority = 4
WHERE provider_key = 'piped' AND updated_at = 0;

UPDATE provider_health
SET enabled = 0, priority = 5
WHERE provider_key = 'invidious' AND updated_at = 0;

UPDATE provider_health
SET enabled = 0, priority = 90
WHERE provider_key = 'youtube' AND updated_at = 0;

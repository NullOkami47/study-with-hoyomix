-- Normalize the seeded playback-provider rows to the simplified three-provider model.
--
-- Migrations 0009/0014/0015 seeded provider_health rows for the retired provider set and left
-- `chksz` at `enabled = 0, priority = 11`. `readProviderStates` prefers a persisted row over the
-- declared default, so without this normalization the advertised default chain
-- (ChKSz 10 -> LX 20 -> Jellyfin 30) is never reached on a migrated database: ChKSz stays
-- admin-disabled, `GET /api/providers/config` publishes it as unavailable, the client registry
-- skips it, and automatic playback actually runs LX -> Jellyfin. A user's own ChKSz key then
-- cannot register the provider at all.
--
-- The `updated_at = 0` guard means only rows that no administrator has ever touched are
-- rewritten. A deliberate admin change carries a real timestamp and is left alone, so this
-- migration cannot silently undo an operator decision.

UPDATE provider_health SET enabled = 1, priority = 10
WHERE provider_key = 'chksz' AND updated_at = 0;

-- LX and Jellyfin have no seeded rows, so they already resolve to their declared defaults.
-- Writing them explicitly makes the default order visible in the Admin console instead of
-- implicit, and keeps the three priorities normalized together.
INSERT OR IGNORE INTO provider_health
  (provider_key, enabled, priority, status, updated_at)
VALUES
  ('lx', 1, 20, 'unknown', 0);

INSERT OR IGNORE INTO provider_health
  (provider_key, enabled, priority, status, updated_at)
VALUES
  ('jellyfin', 1, 30, 'unknown', 0);

-- Retired identities must never remain automatic candidates. They stay in the table because the
-- audit log references them as historical targets.
UPDATE provider_health SET enabled = 0
WHERE provider_key IN (
  'r2', 'meting', 'piped', 'invidious', 'youtube', 'qijie', 'gd-studio',
  'lx-huibq', 'lx-ikun', 'lx-juhe', 'lx-qdy',
  'lx-flower', 'lx-lx', 'lx-grass', 'lx-sixyin', 'lx-huanyin'
) AND updated_at = 0;

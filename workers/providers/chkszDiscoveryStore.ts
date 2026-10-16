import type { D1Database } from '../env'
import type { ChkszDiscoveryRecord } from '../../src/shared/chkszDiscovery'

export interface StaticChkszSourceRow {
  externalId: string
  sourceStatus: 'active' | 'disabled'
}

/**
 * Check if a canonical track has an authoritative static verified binding
 * in `catalogue_sources`.
 */
export async function readStaticChkszSource(
  db: D1Database,
  trackId: string,
): Promise<StaticChkszSourceRow | null> {
  const row = await db
    .prepare(`
      SELECT external_id AS externalId, source_status AS sourceStatus
      FROM catalogue_sources
      WHERE track_id = ? AND provider = 'chksz'
      LIMIT 1
    `)
    .bind(trackId)
    .first<StaticChkszSourceRow>()

  return row ?? null
}

/**
 * Read an unexpired dynamic discovery record from D1.
 */
export async function getChkszDiscovery(
  db: D1Database,
  trackId: string,
  now: number,
): Promise<ChkszDiscoveryRecord | null> {
  const row = await db
    .prepare(`
      SELECT
        canonical_track_id AS canonicalTrackId,
        provider,
        provider_external_id AS providerExternalId,
        match_confidence AS matchConfidence,
        matcher_version AS matcherVersion,
        canonical_metadata_fingerprint AS canonicalMetadataFingerprint,
        evidence_json AS evidenceJson,
        discovered_at AS discoveredAt,
        last_verified_at AS lastVerifiedAt,
        status,
        failure_reason AS failureReason,
        expires_at AS expiresAt
      FROM chksz_dynamic_discoveries
      WHERE canonical_track_id = ? AND expires_at > ?
      LIMIT 1
    `)
    .bind(trackId, now)
    .first<ChkszDiscoveryRecord>()

  return row ?? null
}

/**
 * Insert or replace a dynamic discovery record in D1.
 */
export async function putChkszDiscovery(
  db: D1Database,
  record: ChkszDiscoveryRecord,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO chksz_dynamic_discoveries (
        canonical_track_id,
        provider,
        provider_external_id,
        match_confidence,
        matcher_version,
        canonical_metadata_fingerprint,
        evidence_json,
        discovered_at,
        last_verified_at,
        status,
        failure_reason,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_track_id) DO UPDATE SET
        provider = excluded.provider,
        provider_external_id = excluded.provider_external_id,
        match_confidence = excluded.match_confidence,
        matcher_version = excluded.matcher_version,
        canonical_metadata_fingerprint = excluded.canonical_metadata_fingerprint,
        evidence_json = excluded.evidence_json,
        discovered_at = excluded.discovered_at,
        last_verified_at = excluded.last_verified_at,
        status = excluded.status,
        failure_reason = excluded.failure_reason,
        expires_at = excluded.expires_at
    `)
    .bind(
      record.canonicalTrackId,
      record.provider,
      record.providerExternalId,
      record.matchConfidence,
      record.matcherVersion,
      record.canonicalMetadataFingerprint,
      record.evidenceJson,
      record.discoveredAt,
      record.lastVerifiedAt,
      record.status,
      record.failureReason,
      record.expiresAt,
    )
    .run()
}

/**
 * Update an existing discovery row without deleting it. Used to invalidate stale or
 * deny-listed cache identities while preserving the production row for audit.
 */
export async function updateChkszDiscovery(
  db: D1Database,
  record: ChkszDiscoveryRecord,
): Promise<void> {
  await db
    .prepare(`
      UPDATE chksz_dynamic_discoveries SET
        provider = ?,
        provider_external_id = ?,
        match_confidence = ?,
        matcher_version = ?,
        canonical_metadata_fingerprint = ?,
        evidence_json = ?,
        discovered_at = ?,
        last_verified_at = ?,
        status = ?,
        failure_reason = ?,
        expires_at = ?
      WHERE canonical_track_id = ?
    `)
    .bind(
      record.provider,
      record.providerExternalId,
      record.matchConfidence,
      record.matcherVersion,
      record.canonicalMetadataFingerprint,
      record.evidenceJson,
      record.discoveredAt,
      record.lastVerifiedAt,
      record.status,
      record.failureReason,
      record.expiresAt,
      record.canonicalTrackId,
    )
    .run()
}

/**
 * Delete a dynamic discovery record (e.g. for revalidation or admin purge).
 */
export async function deleteChkszDiscovery(
  db: D1Database,
  trackId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?')
    .bind(trackId)
    .run()
}

/**
 * Attempt to acquire an atomic distributed lock in D1.
 * Uses atomic CAS semantics: returns true if acquired, false if held by another owner and unexpired.
 */
export async function acquireChkszLock(
  db: D1Database,
  lockKey: string,
  ownerId: string,
  ttlMs: number,
  now: number,
): Promise<boolean> {
  const expiresAt = now + ttlMs
  const result = await db
    .prepare(`
      INSERT INTO chksz_discovery_locks (lock_key, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lock_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE chksz_discovery_locks.expires_at <= ?
    `)
    .bind(lockKey, ownerId, now, expiresAt, now)
    .run()

  return (result.meta?.changes ?? 0) > 0
}

/**
 * Release an atomic distributed lock in D1, only if owned by ownerId.
 */
export async function releaseChkszLock(
  db: D1Database,
  lockKey: string,
  ownerId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM chksz_discovery_locks WHERE lock_key = ? AND owner_id = ?')
    .bind(lockKey, ownerId)
    .run()
}

export interface ChkszRateSlotResult {
  allowed: boolean
  retryAfter?: number
}

/**
 * Coordinate and consume a global rate slot across all isolates in D1.
 * Uses atomic coordinator locking and rolling-window rate event counts.
 */
export async function checkAndConsumeChkszGlobalRateSlot(
  db: D1Database,
  now: number,
  maxPerMinute = 15,
  windowMs = 60_000,
  maxWaitMs = 1_000,
): Promise<ChkszRateSlotResult> {
  const coordinatorLockKey = 'coordinator:rate_limit'
  const ownerId = crypto.randomUUID()
  const lockTtlMs = 2_000

  // Spin with jittered backoff to acquire coordinator lock
  const startWait = now
  let lockAcquired = false
  while (!lockAcquired) {
    lockAcquired = await acquireChkszLock(db, coordinatorLockKey, ownerId, lockTtlMs, Date.now())
    if (lockAcquired) break
    const elapsed = Date.now() - startWait
    if (elapsed >= maxWaitMs) {
      // Contention timeout: fail closed towards rate safety
      return { allowed: false, retryAfter: 1 }
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30))
  }

  const currentNow = Date.now()
  const windowStart = currentNow - windowMs

  try {
    // Prune stale events older than 2 windows to keep table compact
    await db
      .prepare('DELETE FROM chksz_discovery_rate_events WHERE created_at < ?')
      .bind(currentNow - windowMs * 2)
      .run()

    // Query active events in rolling window
    const stat = await db
      .prepare(`
        SELECT COUNT(*) AS eventCount, MIN(created_at) AS oldestEvent
        FROM chksz_discovery_rate_events
        WHERE created_at >= ?
      `)
      .bind(windowStart)
      .first<{ eventCount: number; oldestEvent: number | null }>()

    const count = stat?.eventCount ?? 0
    if (count >= maxPerMinute) {
      const oldest = stat?.oldestEvent ?? windowStart
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - currentNow) / 1000))
      return { allowed: false, retryAfter }
    }

    // Record rate event
    await db
      .prepare('INSERT INTO chksz_discovery_rate_events (created_at) VALUES (?)')
      .bind(currentNow)
      .run()

    return { allowed: true }
  } finally {
    await releaseChkszLock(db, coordinatorLockKey, ownerId)
  }
}

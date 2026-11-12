import type { Database } from '../db'
import { parseRetentionPolicy } from './retentionPolicy'

/** One operation-scoped snapshot. Authentication and bans are checked by the
 * coordinator before this call; no authority is cached across requests. */
export async function readSendState(db: Database, userId: string, requestId: string) {
  const [receipt, sent, retention, limits, policy] = await db.batch<{
    id?: string; time?: number; count?: number; value?: string; policy?: string
  }>([
    db.prepare('SELECT message_id AS id FROM chat_request_receipts WHERE user_id=? AND request_id=?').bind(userId, requestId),
    db.prepare('SELECT last_sent_at AS time FROM chat_send_state WHERE user_id=?').bind(userId),
    db.prepare("SELECT message_count AS count FROM chat_retention_state WHERE room_id='global'"),
    db.prepare("SELECT setting_json AS value FROM admin_settings WHERE setting_key='chat.limits'"),
    db.prepare("SELECT setting_json AS policy FROM admin_settings WHERE setting_key='chat.retention'"),
  ])
  // Fail before the atomic mutation, rather than committing an invisible row
  // and only discovering the invalid policy when reading its acknowledgement.
  if (policy.results[0]) parseRetentionPolicy(policy.results[0].policy!)
  const count = retention.results[0]?.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw new Error('chat_retention_state_missing')
  let intervalMs = 1500
  try {
    const value = JSON.parse(limits.results[0]?.value ?? '{}').intervalMs
    if (Number.isSafeInteger(value) && value >= 250 && value <= 60000) intervalMs = value
  } catch { /* Invalid optional limits retain the existing conservative default. */ }
  return {
    priorId: receipt.results[0]?.id ?? null,
    lastSentAt: sent.results[0]?.time ?? null,
    messageCount: count,
    intervalMs,
  }
}

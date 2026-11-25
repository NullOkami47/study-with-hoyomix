import type { Database } from '../db'
import type { AuthProvider } from './types'
import { hashSessionToken } from './session'

export type OAuthProvider = AuthProvider
export type OAuthIntent = 'link' | 'login'

// Start-time registration, used by v73 and earlier. H-04 moved the only write to the callback
// (`claimOAuthFlow`); this helper and `consumeOAuthFlow` remain for the flow-layer tests and to
// document the rows an in-flight v73 login leaves behind during a deploy.
export const registerOAuthFlow = async (
  database: Database,
  flow: { state: string; provider: OAuthProvider; intent: OAuthIntent; createdAt: number; expiresAt: number },
  secret: string,
  cryptoApi: Crypto,
) => {
  const stateHash = await hashSessionToken(flow.state, secret, cryptoApi)
  await database.prepare(`
    INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(stateHash, flow.provider, flow.intent, flow.createdAt, flow.expiresAt).run()
}

export const consumeOAuthFlow = async (
  database: Database,
  flow: { state: string; provider: OAuthProvider; intent: OAuthIntent },
  secret: string,
  now: number,
  cryptoApi: Crypto,
) => {
  const stateHash = await hashSessionToken(flow.state, secret, cryptoApi)
  const result = await database.prepare(`
    UPDATE oauth_flows
    SET consumed_at = ?
    WHERE state_hash = ? AND provider = ? AND intent = ?
      AND consumed_at IS NULL AND expires_at > ?
  `).bind(now, stateHash, flow.provider, flow.intent, now).run()
  return result.meta.changes === 1
}

/**
 * Single-use claim at callback time (H-04). One statement records the flow as consumed:
 * - no row yet (normal case since H-04): the insert succeeds, changes = 1;
 * - an unconsumed, unexpired row with the same provider and intent (a login started on v73 and
 *   finished after the deploy): the upsert marks it consumed, changes = 1;
 * - any other existing row (a replay, or a provider/intent mismatch): no change, changes = 0.
 * The expiry comes from the sealed flow cookie; the boundary itself is refused, as before.
 */
export const claimOAuthFlow = async (
  database: Database,
  flow: { state: string; provider: OAuthProvider; intent: OAuthIntent; createdAt: number; expiresAt: number },
  secret: string,
  now: number,
  cryptoApi: Crypto,
) => {
  if (!(flow.createdAt >= 0 && flow.createdAt <= now && now < flow.expiresAt)) return false
  const stateHash = await hashSessionToken(flow.state, secret, cryptoApi)
  const result = await database.prepare(`
    INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(state_hash) DO UPDATE SET consumed_at = excluded.consumed_at
    WHERE oauth_flows.consumed_at IS NULL
      AND oauth_flows.provider = excluded.provider
      AND oauth_flows.intent = excluded.intent
      AND oauth_flows.expires_at > excluded.consumed_at
      AND oauth_flows.created_at <= excluded.consumed_at
  `).bind(stateHash, flow.provider, flow.intent, flow.createdAt, flow.expiresAt, now).run()
  return result.meta.changes === 1
}

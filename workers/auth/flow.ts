import type { Database } from '../db'
import type { AuthProvider } from './types'
import { hashSessionToken } from './session'

export type OAuthProvider = AuthProvider
export type OAuthIntent = 'link' | 'login'

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

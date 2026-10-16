import type { Database } from '../db'
import type { AuthProvider, ProviderIdentity } from './types'

export const findIdentityOwner = async (database: Database, identity: ProviderIdentity) =>
  database.prepare(`
    SELECT user_id AS userId
    FROM auth_identities
    WHERE provider = ? AND provider_subject = ?
  `).bind(identity.provider, identity.subject).first<{ userId: string }>()

export const linkIdentity = async (
  database: Database,
  userId: string,
  identity: ProviderIdentity,
  now: number,
  cryptoApi: Crypto,
) => {
  const owner = await findIdentityOwner(database, identity)
  if (owner && owner.userId !== userId) return 'collision' as const
  const sameProvider = await database.prepare(`
    SELECT provider_subject AS subject
    FROM auth_identities
    WHERE user_id = ? AND provider = ?
  `).bind(userId, identity.provider).first<{ subject: string }>()
  if (sameProvider && sameProvider.subject !== identity.subject) return 'provider_already_linked' as const
  if (!owner) {
    await database.prepare(`
      INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(cryptoApi.randomUUID(), userId, identity.provider, identity.subject, now, now).run()
  } else {
    await database.prepare('UPDATE auth_identities SET last_used_at = ? WHERE provider = ? AND provider_subject = ?')
      .bind(now, identity.provider, identity.subject).run()
  }
  return 'linked' as const
}

export const unlinkIdentity = async (database: Database, userId: string, provider: AuthProvider) => {
  const result = await database.prepare(`
    DELETE FROM auth_identities AS target
    WHERE target.user_id = ? AND target.provider = ?
      AND EXISTS (
        SELECT 1 FROM auth_identities AS other
        WHERE other.user_id = target.user_id AND other.id <> target.id
      )
  `).bind(userId, provider).run()
  if (result.meta.changes === 1) return 'unlinked' as const
  const requestedIdentity = await database.prepare('SELECT 1 AS present FROM auth_identities WHERE user_id = ? AND provider = ?')
    .bind(userId, provider).first<number>('present')
  return requestedIdentity === 1 ? 'last_identity' as const : 'not_linked' as const
}

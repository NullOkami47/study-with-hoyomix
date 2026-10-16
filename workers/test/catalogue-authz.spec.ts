import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { createAdminAuthorisation, adminMutationOriginGuard } from '../admin/authz'
import { createAuthHandler, type AuthEnv } from '../auth/routes'
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>, env: AuthEnv
const origin = 'https://study.example',
  now = 1788739200000
beforeAll(async () => {
  fixture = await catalogueDatabase()
  env = {
    DB: fixture.db,
    PUBLIC_ORIGIN: origin,
    SESSION_HMAC_SECRET: 'test-session-secret-32-characters-long',
    OAUTH_STATE_SECRET: 'test-oauth-secret',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
  }
})
afterAll(async () => {
  await fixture?.dispose()
})
describe('shared Admin authorisation', () => {
  it.each(['user', 'moderator', 'admin', 'owner'] as const)(
    'preserves %s role boundary',
    async (role) => {
      await fixture.db
        .prepare('INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?)')
        .bind(role, role, role, now, now)
        .run()
      const session = await createAuthHandler(env, { now: () => now }).issueSession(role)
      const result = await createAdminAuthorisation(env, { now: () => now }).currentAdmin(
        new Request(origin + '/api/admin/catalogue/status', {
          headers: { cookie: '__Host-session=' + session.token },
        }),
      )
      if (role === 'admin' || role === 'owner') expect(result).toEqual({ id: role, role })
      else expect((result as Response).status).toBe(403)
    },
  )
  it('rejects unauthenticated access', async () => {
    const result = await createAdminAuthorisation(env).currentAdmin(
      new Request(origin + '/api/admin/catalogue/status'),
    )
    expect((result as Response).status).toBe(401)
  })
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'preserves exact origin requirement for %s',
    (method) => {
      expect(
        adminMutationOriginGuard(
          new Request(origin + '/api/admin/catalogue/sync', { method }),
          origin,
        )?.status,
      ).toBe(403)
      expect(
        adminMutationOriginGuard(
          new Request(origin + '/api/admin/catalogue/sync', { method, headers: { origin } }),
          origin,
        ),
      ).toBeNull()
    },
  )
})

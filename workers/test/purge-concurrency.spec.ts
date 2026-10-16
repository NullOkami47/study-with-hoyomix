import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAdminHandler, type AdminEnv } from '../admin/routes'
import { createAuthHandler } from '../auth/routes'
import { BACKGROUND_IMAGE_MAX_BYTES } from '../backgrounds/mediaValidation'
import { PURGE_LEASE_DURATION_MS } from '../backgrounds/routes'
import type { BackgroundBucket, BackgroundStoredObject } from '../backgrounds/storage'
import { applyApiSecurityHeaders } from '../index'

const ORIGIN = 'https://study.example'
const NOW = 1_787_030_400_000

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => database.prepare(statement)),
    )
  }
}

const png = (width = 1920, height = 1080) => {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

const createBucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  const bucket: BackgroundBucket = {
    put: vi.fn(async (key, value, options) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
      objects.set(key, { bytes, contentType: options.httpMetadata.contentType })
      return { key, size: bytes.byteLength }
    }),
    head: vi.fn(async (key) => {
      const object = objects.get(key)
      return object ? { key, size: object.bytes.byteLength } : null
    }),
    get: vi.fn(async (key): Promise<BackgroundStoredObject | null> => {
      const object = objects.get(key)
      if (!object) return null
      return {
        key,
        size: object.bytes.byteLength,
        body: object.bytes,
        httpMetadata: { contentType: object.contentType },
      }
    }),
    delete: vi.fn(async (key) => { objects.delete(key) }),
  }
  return { bucket, objects }
}

describe('Admin background operations', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AdminEnv
  let bucket: ReturnType<typeof createBucket>

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `admin-background-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    bucket = createBucket()
    env = {
      DB: database,
      BACKGROUND_BUCKET: bucket.bucket,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
      OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
    }
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const request = (path: string, cookie?: string, init?: RequestInit) =>
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(cookie ? { cookie } : {}) },
    })

  const authenticatedCookie = async (role: 'user' | 'moderator' | 'admin' | 'owner', userId = `${role}-background-user`) => {
    await database.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, role, role, NOW, NOW).run()
    const issued = await createAuthHandler(env, { now: () => NOW }).issueSession(userId)
    return `__Host-session=${issued.token}`
  }

  const upload = async (cookie: string) => {
    const handler = createAdminHandler(env, { now: () => NOW })
    return handler.fetch(request('/api/admin/backgrounds/uploads', cookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: png(),
    }))
  }

  it('prevents concurrent stale purge from both winning with duplicate audit', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    if (!created.ok) {
      const error = await created.text()
      throw new Error(`Upload failed: ${created.status} ${error}`)
    }
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    const originalDelete = bucket.bucket.delete
    let deleteCallCount = 0
    let signalDeleteReached: (() => void) | null = null
    const deleteReached = new Promise<void>((resolve) => { signalDeleteReached = resolve })
    let resumeA: (() => void) | null = null
    const barrierA = new Promise<void>((resolve) => { resumeA = resolve })

    bucket.bucket.delete = vi.fn(async (key: string) => {
      deleteCallCount++
      await originalDelete.call(bucket.bucket, key)
      if (deleteCallCount === 1) {
        signalDeleteReached!()
        await barrierA
      }
    })

    const purgeAPromise = handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    await deleteReached

    bucket.bucket.delete = originalDelete

    const purgeB = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    resumeA!()
    const purgeA = await purgeAPromise

    bucket.bucket.delete = originalDelete

    const responses = [purgeA.status, purgeB.status].sort()

    expect(responses).not.toEqual([204, 204])
    expect(responses[0]).toBe(204)
    expect([404, 409]).toContain(responses[1])

    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')

    expect(auditCount).toBe(1)

    const finalRow = await database.prepare(`
      SELECT id FROM background_media WHERE id = ?
    `).bind(id).first()
    expect(finalRow).toBeNull()

    const r2Keys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(r2Keys.length).toBe(0)
  })

  it('prevents selection lost-update during concurrent purge', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const userCookie = await authenticatedCookie('user')

    const createdTarget = await upload(adminCookie)
    const { background: bgTarget } = await createdTarget.json() as { background: { id: string } }
    const targetId = bgTarget.id

    const createdOld = await upload(adminCookie)
    const { background: bgOld } = await createdOld.json() as { background: { id: string } }
    const oldOtherId = bgOld.id

    const createdNew = await upload(adminCookie)
    const { background: bgNew } = await createdNew.json() as { background: { id: string } }
    const newOtherId = bgNew.id

    const adminHandler = createAdminHandler(env, { now: () => NOW + 10 })
    await adminHandler.fetch(request(`/api/admin/backgrounds/${targetId}/publish`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await adminHandler.fetch(request(`/api/admin/backgrounds/${oldOtherId}/publish`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await adminHandler.fetch(request(`/api/admin/backgrounds/${newOtherId}/publish`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    // Initial user selection: [target, oldOther]
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, updated_at)
      VALUES (?, ?, ?)
    `).bind('user-background-user', JSON.stringify([targetId, oldOtherId]), NOW).run()

    await adminHandler.fetch(request(`/api/admin/backgrounds/${targetId}/archive`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    const originalDB = env.DB
    let signalFinalBatchReached: (() => void) | null = null
    const finalBatchReached = new Promise<void>((resolve) => { signalFinalBatchReached = resolve })
    let resumeFinalBatch: (() => void) | null = null
    const finalBatchBarrier = new Promise<void>((resolve) => { resumeFinalBatch = resolve })

    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            // The rejected implementation only enters this batch after its
            // application-level selection snapshot has been fully read.
            signalFinalBatchReached!()
            await finalBatchBarrier
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgePromise = adminHandler.fetch(request(`/api/admin/backgrounds/${targetId}/purge`, adminCookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    await finalBatchReached

    // User updates selection after the purge's selection SELECT has completed.
    await database.prepare(`
      UPDATE user_background_selections
      SET selection_json = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(JSON.stringify([targetId, newOtherId]), NOW + 5, 'user-background-user').run()

    const selectionBeforeFinalBatch = await database.prepare(`
      SELECT selection_json AS selectionJson
      FROM user_background_selections
      WHERE user_id = ?
    `).bind('user-background-user').first<{ selectionJson: string }>()
    expect(JSON.parse(selectionBeforeFinalBatch!.selectionJson)).toEqual([targetId, newOtherId])

    resumeFinalBatch!()
    const purgeResponse = await purgePromise
    expect(purgeResponse.status).toBe(204)

    env.DB = originalDB

    const finalSelection = await database.prepare(`
      SELECT selection_json AS selectionJson FROM user_background_selections WHERE user_id = ?
    `).bind('user-background-user').first<{ selectionJson: string }>()

    const selectionIds = JSON.parse(finalSelection!.selectionJson)

    // Final required selection: [newOther], NOT [oldOther], and NOT deleted entirely
    expect(selectionIds).toEqual([newOtherId])
    expect(selectionIds).not.toContain(targetId)
    expect(selectionIds).not.toContain(oldOtherId)
  })

  it('handles interleaving where winner acquires finalisation claim, pauses, loser runs, winner resumes', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    const originalDB = env.DB
    let signalFinalBatchReached: (() => void) | null = null
    const finalBatchReached = new Promise<void>((resolve) => { signalFinalBatchReached = resolve })
    let resumeA: (() => void) | null = null
    const barrierA = new Promise<void>((resolve) => { resumeA = resolve })

    // Pause A right after it enters finalisation batch (holding finalisation claim)
    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            signalFinalBatchReached!()
            await barrierA
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeAPromise = handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    await finalBatchReached

    // B runs while A is holding finalisation claim
    const purgeB = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    // B must lose with bounded 409
    expect(purgeB.status).toBe(409)

    // Resume A
    resumeA!()
    const purgeA = await purgeAPromise
    expect(purgeA.status).toBe(204)

    env.DB = originalDB

    // Exactly 1 audit entry
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)

    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(finalRow).toBeNull()
  })

  it('Boundary A: recovers when purge is interrupted after recovery marker is set before R2 delete', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const originalDelete = bucket.bucket.delete
    bucket.bucket.delete = vi.fn(async () => {
      throw new Error('R2 unavailable before any delete')
    })

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(503)

    const row = await database.prepare(
      'SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?',
    ).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()
    expect(row).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number) })

    // Retry works
    bucket.bucket.delete = originalDelete
    const retryResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(retryResponse.status).toBe(204)
    expect(await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('Boundary B: recovers from partial multi-object R2 failure (>=2 objects, first succeeds, second fails)', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    // Add second revision so background has 2 distinct R2 objects
    await handler.fetch(request(`/api/admin/backgrounds/${id}/replace`, cookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: png(1280, 720),
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const r2Keys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(r2Keys.length).toBeGreaterThanOrEqual(2)

    const originalDelete = bucket.bucket.delete
    let deleteCalls = 0
    bucket.bucket.delete = vi.fn(async (key: string) => {
      deleteCalls++
      if (deleteCalls === 1) {
        return originalDelete.call(bucket.bucket, key)
      }
      throw new Error('Partial R2 delete failure on second object')
    })

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(503)

    expect(deleteCalls).toBe(2)
    const remainingKeys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(remainingKeys.length).toBe(r2Keys.length - 1)

    // Row is still intact with purge_started_at set
    const row = await database.prepare(
      'SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?',
    ).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()
    expect(row).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number) })

    // Retry works and cleans remaining objects
    bucket.bucket.delete = originalDelete
    const retryResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(retryResponse.status).toBe(204)
    expect(Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`)).length).toBe(0)
    expect(await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('Boundary C: recovers when all R2 objects deleted before logical D1 finalisation', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const originalDB = env.DB
    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('UPDATE background_media SET purge_finalising_at')) {
              throw new Error('D1 failure before claiming finalisation')
            }
            return target.prepare(sql)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(500)

    // R2 objects already deleted
    expect(Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`)).length).toBe(0)

    // Durable state: row intact with purge_started_at set, purge_finalising_at null
    const row = await database.prepare(
      'SELECT id, status, purge_started_at AS purgeStartedAt, purge_finalising_at AS purgeFinalisingAt FROM background_media WHERE id = ?',
    ).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null; purgeFinalisingAt: number | null }>()
    expect(row).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number), purgeFinalisingAt: null })

    // Retry works
    env.DB = originalDB
    // Wait for lease to expire before retry
    const retryHandler = createAdminHandler(env, { now: () => NOW + 10 + PURGE_LEASE_DURATION_MS + 1 })
    const retryResponse = await retryHandler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(retryResponse.status).toBe(204)
    expect(await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('Boundary D/E: recovers when failure occurs post-winner before cleanup/audit completes', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const userCookie = await authenticatedCookie('user')

    const created = await upload(adminCookie)
    const { background } = await created.json() as { background: { id: string } }
    const targetId = background.id

    const created2 = await upload(adminCookie)
    const { background: bg2 } = await created2.json() as { background: { id: string } }
    const otherId = bg2.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${targetId}/publish`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${otherId}/publish`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, updated_at)
      VALUES (?, ?, ?)
    `).bind('user-background-user', JSON.stringify([targetId, otherId]), NOW).run()

    await handler.fetch(request(`/api/admin/backgrounds/${targetId}/archive`, adminCookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    // Inject failure into the cleanup/audit batch stage (AFTER winner selection/ownership succeeded)
    const originalDB = env.DB
    let batchCalls = 0
    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            batchCalls++
            if (batchCalls === 1) {
              throw new Error('Injected failure during cleanup/audit stage')
            }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${targetId}/purge`, adminCookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(500)

    // Durable state inspection:
    // Background must NOT be irreversibly destroyed with broken selections and missing audit
    const intermediateRow = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt, purge_finalising_at AS purgeFinalisingAt
      FROM background_media WHERE id = ?
    `).bind(targetId).first<{ id: string; status: string; purgeStartedAt: number | null; purgeFinalisingAt: number | null }>()

    expect(intermediateRow).toEqual({
      id: targetId,
      status: 'archived',
      purgeStartedAt: expect.any(Number),
      purgeFinalisingAt: expect.any(Number),
    })

    // Restore DB
    env.DB = originalDB

    // Retry the purge (after lease expires)
    const retryHandler = createAdminHandler(env, { now: () => NOW + 10 + PURGE_LEASE_DURATION_MS + 1 })
    const retryResponse = await retryHandler.fetch(request(`/api/admin/backgrounds/${targetId}/purge`, adminCookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    expect(retryResponse.status, 'Retry must complete successfully with 204').toBe(204)

    // Verify final state
    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(targetId).first()
    expect(finalRow).toBeNull()

    const revisionCount = await database.prepare(
      'SELECT COUNT(*) AS count FROM background_media_revisions WHERE background_id = ?',
    ).bind(targetId).first<number>('count')
    expect(revisionCount).toBe(0)

    const finalSelection = await database.prepare(
      'SELECT selection_json AS selectionJson FROM user_background_selections WHERE user_id = ?',
    ).bind('user-background-user').first<{ selectionJson: string }>()
    expect(JSON.parse(finalSelection!.selectionJson)).toEqual([otherId])

    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${targetId}`).first<number>('count')
    expect(auditCount).toBe(1)

    // Idempotent second retry: no duplicate audit
    const secondRetry = await handler.fetch(request(`/api/admin/backgrounds/${targetId}/purge`, adminCookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(secondRetry.status).toBe(404)

    const postRetryAuditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${targetId}`).first<number>('count')
    expect(postRetryAuditCount).toBe(1)
  })

  it('Boundary F: response-loss retry does not create another successful purge audit', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const firstPurge = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(firstPurge.status).toBe(204)

    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)

    // Retry after completion (client dropped 204)
    const secondPurge = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(secondPurge.status).toBe(404)

    const finalAuditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(finalAuditCount).toBe(1)
  })
})

describe('Cross-isolate distributed concurrency', () => {
  let miniflare: Miniflare
  let database: Awaited<ReturnType<Miniflare['getD1Database']>>
  let env: AdminEnv
  let bucket: ReturnType<typeof createBucketFn>
  type TestDatabase = typeof database
  type SelectionProjection = {
    userId: string
    selectionJson: string
    autoRotate: number
    intervalSeconds: number
  }

  // Local copy of createBucket for this describe block
  const createBucketFn = () => {
    const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
    const bkt: BackgroundBucket = {
      put: vi.fn(async (key, value, options) => {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
        objects.set(key, { bytes, contentType: options.httpMetadata.contentType })
        return { key, size: bytes.byteLength }
      }),
      head: vi.fn(async (key) => {
        const object = objects.get(key)
        return object ? { key, size: object.bytes.byteLength } : null
      }),
      get: vi.fn(async (key): Promise<BackgroundStoredObject | null> => {
        const object = objects.get(key)
        if (!object) return null
        return {
          key,
          size: object.bytes.byteLength,
          body: object.bytes,
          httpMetadata: { contentType: object.contentType },
        }
      }),
      delete: vi.fn(async (key) => { objects.delete(key) }),
    }
    return { bucket: bkt, objects }
  }

  const applyMigrationsFn = async (db: TestDatabase) => {
    const directory = resolve(process.cwd(), 'migrations')
    for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8')
      await db.batch(
        sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)),
      )
    }
  }

  const pngFn = (width = 1920, height = 1080) => {
    const bytes = new Uint8Array(33)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer)
    view.setUint32(8, 13)
    bytes.set([73, 72, 68, 82], 12)
    view.setUint32(16, width)
    view.setUint32(20, height)
    bytes.set([8, 6, 0, 0, 0], 24)
    return bytes
  }

  const ORIGIN = 'https://study.example'
  const NOW = 1_787_030_400_000

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `cross-isolate-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrationsFn(database)
    bucket = createBucketFn()
    env = {
      DB: database,
      BACKGROUND_BUCKET: bucket.bucket,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
      OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
    }
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const req = (path: string, cookie?: string, init?: RequestInit) =>
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(cookie ? { cookie } : {}) },
    })

  const authenticatedCookie = async (role: 'user' | 'moderator' | 'admin' | 'owner', userId = `${role}-xiso-user`) => {
    await database.prepare(`
      INSERT OR IGNORE INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, role, role, NOW, NOW).run()
    const issued = await createAuthHandler(env, { now: () => NOW }).issueSession(userId)
    return `__Host-session=${issued.token}`
  }

  const upload = async (cookie: string) => {
    const handler = createAdminHandler(env, { now: () => NOW })
    return handler.fetch(req('/api/admin/backgrounds/uploads', cookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: pngFn(),
    }))
  }

  /** Helper: create background, publish, archive — ready for purge */
  const prepareForPurge = async (cookie: string) => {
    const created = await upload(cookie)
    if (!created.ok) throw new Error(`Upload failed: ${created.status}`)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(req(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    await handler.fetch(req(`/api/admin/backgrounds/${id}/archive`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    return id
  }

  const preparePublished = async (cookie: string) => {
    const created = await upload(cookie)
    if (!created.ok) throw new Error(`Upload failed: ${created.status}`)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    const published = await handler.fetch(req(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    if (!published.ok) throw new Error(`Publish failed: ${published.status}`)
    return id
  }

  const purgeWithInjectedFinalBatchFailure = async (
    cookie: string,
    id: string,
    invalidStatement: (db: TestDatabase) => any,
  ) => {
    const originalDB = env.DB
    const failingDB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any[]) => target.batch([
            ...statements.slice(0, 3),
            invalidStatement(target),
            ...statements.slice(3),
          ])
        }
        return Reflect.get(target, prop)
      },
    }) as TestDatabase
    const handler = createAdminHandler({ ...env, DB: failingDB }, { now: () => NOW + 100 })
    return handler.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
  }

  it('Boundary G: cross-isolate concurrent purge — exactly one winner', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)

    // Isolate A: inFlight guard disabled, controlled clock at T
    let clockA = NOW + 100
    const handlerA = createAdminHandler(env, {
      now: () => clockA,
      __test_disableInFlightGuard: true,
    })

    // Isolate B: inFlight guard disabled, same clock
    let clockB = NOW + 100
    const handlerB = createAdminHandler(env, {
      now: () => clockB,
      __test_disableInFlightGuard: true,
    })

    // A begins purge. Use a DB proxy to pause A after it claims finalisation but before the final batch.
    const originalDB = env.DB
    let resumeA: (() => void) | null = null
    const barrierA = new Promise<void>((resolve) => { resumeA = resolve })
    let reachedBatchA: (() => void) | null = null
    const batchReachedA = new Promise<void>((resolve) => { reachedBatchA = resolve })
    let batchCallCount = 0

    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            batchCallCount++
            if (batchCallCount === 1) {
              reachedBatchA!()
              // A has claimed finalisation, now pause before final batch
              await barrierA
            }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    // Step 1-5: A begins purge and pauses before final batch
    const purgeAPromise = handlerA.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))

    // Wait for A to reach the barrier (it will have claimed finalisation)
    await batchReachedA

    // Step 6-8: B attempts purge with its own handler (separate "isolate")
    // B must use the original DB (not the proxied one that pauses)
    const envB = { ...env, DB: originalDB }
    const handlerBDirect = createAdminHandler(envB, {
      now: () => clockB,
      __test_disableInFlightGuard: true,
    })
    const purgeB = await handlerBDirect.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))

    // B must be rejected because A's lease is still active
    expect(purgeB.status).toBe(409)

    // Step 9: Resume A
    resumeA!()
    const purgeA = await purgeAPromise
    expect(purgeA.status).toBe(204)

    env.DB = originalDB

    // Verify final invariants
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)

    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(finalRow).toBeNull()

    const r2Keys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(r2Keys.length).toBe(0)
  })

  it('Boundary H: lease expiry takeover — stale owner A is fenced after B takes over', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)

    // A claims at time T
    const timeA = NOW + 100
    const handlerA = createAdminHandler(env, {
      now: () => timeA,
      __test_disableInFlightGuard: true,
    })

    // Pause A after finalisation claim, before final batch
    const originalDB = env.DB
    let resumeA: (() => void) | null = null
    const barrierA = new Promise<void>((resolve) => { resumeA = resolve })
    let reachedBatchA: (() => void) | null = null
    const batchReachedA = new Promise<void>((resolve) => { reachedBatchA = resolve })
    let batchCount = 0

    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            batchCount++
            if (batchCount === 1) {
              reachedBatchA!()
              await barrierA
            }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeAPromise = handlerA.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))

    await batchReachedA

    // B attempts at T + lease/2 — should be rejected (lease still active)
    const timeBEarly = timeA + Math.floor(PURGE_LEASE_DURATION_MS / 2)
    const envEarly = { ...env, DB: originalDB }
    const handlerBEarly = createAdminHandler(envEarly, {
      now: () => timeBEarly,
      __test_disableInFlightGuard: true,
    })
    const purgeBEarly = await handlerBEarly.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBEarly.status).toBe(409)

    // B attempts at T + lease + 1 — lease expired, takeover should succeed
    const timeBLate = timeA + PURGE_LEASE_DURATION_MS + 1
    const envLate = { ...env, DB: originalDB }
    const handlerBLate = createAdminHandler(envLate, {
      now: () => timeBLate,
      __test_disableInFlightGuard: true,
    })
    const purgeBLate = await handlerBLate.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBLate.status).toBe(204)

    // Resume stale A — it must be fenced out
    resumeA!()
    const purgeA = await purgeAPromise

    // A must get 409 (fenced by token mismatch — its DELETE affected 0 rows)
    expect(purgeA.status).toBe(409)
    expect(await purgeA.json()).toEqual({ error: 'background_purge_in_progress' })

    env.DB = originalDB

    // Exactly 1 audit entry (B's)
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)

    // Background is fully purged
    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(finalRow).toBeNull()

    // R2 is clean
    const r2Keys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(r2Keys.length).toBe(0)
  })

  it('Boundary I: crash recovery — fresh isolate recovers after owner crash', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)

    // A claims finalisation ownership and then "crashes" — promise is abandoned
    const timeA = NOW + 100
    const handlerA = createAdminHandler(env, {
      now: () => timeA,
      __test_disableInFlightGuard: true,
    })

    // Make A crash after claiming finalisation (before final batch)
    const originalDB = env.DB
    let batchAttempts = 0
    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async () => {
            batchAttempts++
            // Simulate crash — just throw and never complete
            throw new Error('Simulated isolate crash during final batch')
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeACrash = await handlerA.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    // A should get 500 from the crash
    expect(purgeACrash.status).toBe(500)

    env.DB = originalDB

    // Verify A's durable state: row exists with finalisation claimed
    const intermediateRow = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt,
        purge_finalising_at AS purgeFinalisingAt,
        purge_finalising_token AS purgeFinalisingToken,
        purge_lease_expires_at AS purgeLeaseExpiresAt
      FROM background_media WHERE id = ?
    `).bind(id).first<{
      id: string; status: string
      purgeStartedAt: number | null; purgeFinalisingAt: number | null
      purgeFinalisingToken: string | null; purgeLeaseExpiresAt: number | null
    }>()
    expect(intermediateRow).toBeTruthy()
    expect(intermediateRow!.purgeFinalisingAt).not.toBeNull()
    expect(intermediateRow!.purgeFinalisingToken).not.toBeNull()
    expect(intermediateRow!.purgeLeaseExpiresAt).not.toBeNull()

    // Before lease expiry: recovery attempt should be rejected
    const timeBBefore = timeA + Math.floor(PURGE_LEASE_DURATION_MS / 2)
    const handlerBBefore = createAdminHandler(env, {
      now: () => timeBBefore,
      __test_disableInFlightGuard: true,
    })
    const purgeBBefore = await handlerBBefore.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBBefore.status).toBe(409)

    // After lease expiry: fresh handler (new "isolate") recovers
    const timeBAfter = timeA + PURGE_LEASE_DURATION_MS + 1
    const handlerBAfter = createAdminHandler(env, {
      now: () => timeBAfter,
      __test_disableInFlightGuard: true,
    })
    const purgeBAfter = await handlerBAfter.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBAfter.status).toBe(204)

    // Final state verification
    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(finalRow).toBeNull()

    const revisionCount = await database.prepare(
      'SELECT COUNT(*) AS count FROM background_media_revisions WHERE background_id = ?',
    ).bind(id).first<number>('count')
    expect(revisionCount).toBe(0)

    const r2Keys = Array.from(bucket.objects.keys()).filter(k => k.startsWith(`backgrounds/${id}/`))
    expect(r2Keys.length).toBe(0)

    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)
  })

  it('selection cleanup fencing: stale owner commits zero selection writes', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const userCookie = await authenticatedCookie('user')

    const id = await prepareForPurge(adminCookie)

    // Create a second published background so selection isn't empty
    const created2 = await upload(adminCookie)
    const { background: bg2 } = await created2.json() as { background: { id: string } }
    const otherId = bg2.id
    const setupHandler = createAdminHandler(env, { now: () => NOW + 10 })
    await setupHandler.fetch(req(`/api/admin/backgrounds/${otherId}/publish`, adminCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))

    // Set up user selection: [target, other]
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, updated_at)
      VALUES (?, ?, ?)
    `).bind('user-xiso-user', JSON.stringify([id, otherId]), NOW).run()

    // A claims at time T, pauses before final batch
    const timeA = NOW + 100
    const originalDB = env.DB
    let resumeA: (() => void) | null = null
    const barrierA = new Promise<void>((resolve) => { resumeA = resolve })
    let reachedBatchA: (() => void) | null = null
    const batchReachedA = new Promise<void>((resolve) => { reachedBatchA = resolve })
    let batchCount = 0

    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            batchCount++
            if (batchCount === 1) {
              reachedBatchA!()
              await barrierA
            }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const handlerA = createAdminHandler(env, {
      now: () => timeA,
      __test_disableInFlightGuard: true,
    })

    const purgeAPromise = handlerA.fetch(req(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))

    await batchReachedA

    // B takes over after lease expires
    const timeB = timeA + PURGE_LEASE_DURATION_MS + 1
    const envB = { ...env, DB: originalDB }
    const handlerB = createAdminHandler(envB, {
      now: () => timeB,
      __test_disableInFlightGuard: true,
    })

    // User modifies selection to [target, other] -> just [other] during the interim
    // (or adds a new background — the point is to test that stale A doesn't clobber)
    const created3 = await upload(adminCookie)
    const { background: bg3 } = await created3.json() as { background: { id: string } }
    const newOtherId = bg3.id
    await createAdminHandler({ ...env, DB: originalDB }, { now: () => NOW + 10 }).fetch(
      req(`/api/admin/backgrounds/${newOtherId}/publish`, adminCookie, {
        method: 'POST', headers: { origin: ORIGIN },
      }),
    )

    // User updates selection to [target, newOther]
    await originalDB.prepare(`
      UPDATE user_background_selections
      SET selection_json = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(JSON.stringify([id, newOtherId]), NOW + 50, 'user-xiso-user').run()

    // B completes purge (takes over from expired A)
    const purgeB = await handlerB.fetch(req(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeB.status).toBe(204)

    // Resume stale A — must be fenced
    resumeA!()
    const purgeA = await purgeAPromise
    expect(purgeA.status).toBe(409)
    expect(await purgeA.json()).toEqual({ error: 'background_purge_in_progress' })

    env.DB = originalDB

    // Final selection must reflect B's cleanup (removing target) from the CURRENT user state
    // i.e. [newOther], not [otherId] (stale A's snapshot), and not empty
    const finalSelection = await database.prepare(
      'SELECT selection_json AS selectionJson FROM user_background_selections WHERE user_id = ?',
    ).bind('user-xiso-user').first<{ selectionJson: string }>()

    // Selection should contain newOther (what B cleaned) and NOT contain old target
    const selectionIds = JSON.parse(finalSelection!.selectionJson)
    expect(selectionIds).toContain(newOtherId)
    expect(selectionIds).not.toContain(id)

    // Exactly 1 audit (B's)
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)
  })

  it('Section 10: finalisation removes the target from each user current selection without cross-user overwrite', async () => {
    const adminCookie = await authenticatedCookie('admin')
    await authenticatedCookie('user', 'section10-user-a')
    await authenticatedCookie('user', 'section10-user-b')

    const targetId = await prepareForPurge(adminCookie)
    const oldAId = await preparePublished(adminCookie)
    const newAId = await preparePublished(adminCookie)
    const otherBId = await preparePublished(adminCookie)

    await database.batch([
      database.prepare(`
        INSERT INTO user_background_selections (
          user_id, selection_json, auto_rotate, interval_seconds, updated_at
        ) VALUES (?, ?, 0, 15, ?)
      `).bind('section10-user-a', JSON.stringify([targetId, oldAId]), NOW),
      database.prepare(`
        INSERT INTO user_background_selections (
          user_id, selection_json, auto_rotate, interval_seconds, updated_at
        ) VALUES (?, ?, 1, 300, ?)
      `).bind('section10-user-b', JSON.stringify([targetId, otherBId]), NOW),
    ])

    const originalDB = env.DB
    let signalFinalBatchReached: (() => void) | null = null
    const finalBatchReached = new Promise<void>((resolve) => { signalFinalBatchReached = resolve })
    let resumeFinalBatch: (() => void) | null = null
    const finalBatchBarrier = new Promise<void>((resolve) => { resumeFinalBatch = resolve })

    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any[]) => {
            signalFinalBatchReached!()
            await finalBatchBarrier
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const handler = createAdminHandler(env, { now: () => NOW + 100 })
    const purgePromise = handler.fetch(req(`/api/admin/backgrounds/${targetId}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))

    await finalBatchReached

    await originalDB.prepare(`
      UPDATE user_background_selections
      SET selection_json = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(JSON.stringify([targetId, newAId]), NOW + 50, 'section10-user-a').run()

    const beforeFinalisation = await originalDB.prepare(`
      SELECT user_id AS userId, selection_json AS selectionJson,
        auto_rotate AS autoRotate, interval_seconds AS intervalSeconds
      FROM user_background_selections
      WHERE user_id IN (?, ?)
      ORDER BY user_id
    `).bind('section10-user-a', 'section10-user-b').all<SelectionProjection>()
    expect(beforeFinalisation.results.map((row: SelectionProjection) => ({
      ...row,
      selectionJson: JSON.parse(row.selectionJson),
    }))).toEqual([
      {
        userId: 'section10-user-a',
        selectionJson: [targetId, newAId],
        autoRotate: 0,
        intervalSeconds: 15,
      },
      {
        userId: 'section10-user-b',
        selectionJson: [targetId, otherBId],
        autoRotate: 1,
        intervalSeconds: 300,
      },
    ])

    resumeFinalBatch!()
    const purgeResponse = await purgePromise
    env.DB = originalDB
    expect(purgeResponse.status).toBe(204)

    const finalSelections = await database.prepare(`
      SELECT user_id AS userId, selection_json AS selectionJson,
        auto_rotate AS autoRotate, interval_seconds AS intervalSeconds
      FROM user_background_selections
      WHERE user_id IN (?, ?)
      ORDER BY user_id
    `).bind('section10-user-a', 'section10-user-b').all<SelectionProjection>()
    expect(finalSelections.results.map((row: SelectionProjection) => ({
      ...row,
      selectionJson: JSON.parse(row.selectionJson),
    }))).toEqual([
      {
        userId: 'section10-user-a',
        selectionJson: [newAId],
        autoRotate: 0,
        intervalSeconds: 15,
      },
      {
        userId: 'section10-user-b',
        selectionJson: [otherBId],
        autoRotate: 1,
        intervalSeconds: 300,
      },
    ])
  })

  it('unexpected NOT NULL failure in final batch returns bounded 500', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)
    const otherId = crypto.randomUUID()
    const selectionUserId = 'section10-rollback-user'
    await authenticatedCookie('user', selectionUserId)
    await database.prepare(`
      INSERT INTO user_background_selections (
        user_id, selection_json, auto_rotate, interval_seconds, updated_at
      ) VALUES (?, ?, 0, 15, ?)
    `).bind(selectionUserId, JSON.stringify([id, otherId]), NOW).run()

    const response = await purgeWithInjectedFinalBatchFailure(cookie, id, (db) => db.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, NULL, 'user', ?, ?)
    `).bind(`unexpected-not-null-${crypto.randomUUID()}`, NOW, NOW))

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('{"error":"background_purge_failed"}')
    expect(await database.prepare(`
      SELECT selection_json AS selectionJson, auto_rotate AS autoRotate,
        interval_seconds AS intervalSeconds, updated_at AS updatedAt
      FROM user_background_selections
      WHERE user_id = ?
    `).bind(selectionUserId).first()).toEqual({
      selectionJson: JSON.stringify([id, otherId]),
      autoRotate: 0,
      intervalSeconds: 15,
      updatedAt: NOW,
    })
    expect(await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()).toEqual({ id })
    expect(await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')).toBe(0)
  })

  it('unexpected CHECK failure in final batch returns bounded 500', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)

    const response = await purgeWithInjectedFinalBatchFailure(cookie, id, (db) => db.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, 'constraint-probe', 'unexpected-role', ?, ?)
    `).bind(`unexpected-check-${crypto.randomUUID()}`, NOW, NOW))

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('{"error":"background_purge_failed"}')
    expect(await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()).toEqual({ id })
    expect(await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')).toBe(0)
  })

  it('selection cleanup removes the target by value and deletes a target-only row', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)
    const beforeId = crypto.randomUUID()
    const afterId = crypto.randomUUID()
    const middleUserId = 'section10-middle-user'
    const onlyUserId = 'section10-only-user'
    await authenticatedCookie('user', middleUserId)
    await authenticatedCookie('user', onlyUserId)

    await database.batch([
      database.prepare(`
        INSERT INTO user_background_selections (user_id, selection_json, updated_at)
        VALUES (?, ?, ?)
      `).bind(middleUserId, JSON.stringify([beforeId, id, afterId]), NOW),
      database.prepare(`
        INSERT INTO user_background_selections (user_id, selection_json, updated_at)
        VALUES (?, ?, ?)
      `).bind(onlyUserId, JSON.stringify([id]), NOW),
    ])

    const response = await createAdminHandler(env, { now: () => NOW + 100 }).fetch(
      req(`/api/admin/backgrounds/${id}/purge`, cookie, {
        method: 'DELETE', headers: { origin: ORIGIN },
      }),
    )
    expect(response.status).toBe(204)

    const middleSelection = await database.prepare(`
      SELECT selection_json AS selectionJson
      FROM user_background_selections
      WHERE user_id = ?
    `).bind(middleUserId).first<{ selectionJson: string }>()
    expect(JSON.parse(middleSelection!.selectionJson)).toEqual([beforeId, afterId])
    expect(await database.prepare(`
      SELECT user_id FROM user_background_selections WHERE user_id = ?
    `).bind(onlyUserId).first()).toBeNull()
  })

  it('lease half-life rejection: concurrent B is rejected before lease expiry', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = await prepareForPurge(cookie)

    // A claims at time T
    const timeA = NOW + 100
    const handlerA = createAdminHandler(env, {
      now: () => timeA,
      __test_disableInFlightGuard: true,
    })

    // A completes purge (sets finalisation state in D1, not crashing)
    // But we need A to claim without completing — manually set the D1 state
    // by running A's purge up to the point of finalisation claim

    // Run A to completion first for the happy path
    const purgeA = await handlerA.fetch(req(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeA.status).toBe(204)

    // Create another background for the second test
    const id2 = await prepareForPurge(cookie)

    // A claims at time T
    const handlerA2 = createAdminHandler(env, {
      now: () => timeA,
      __test_disableInFlightGuard: true,
    })

    // Manually set purge_started_at and purge_finalising_at with token and lease
    const tokenA = crypto.randomUUID()
    await database.prepare(`
      UPDATE background_media
      SET purge_started_at = ?, purge_finalising_at = ?, purge_finalising_token = ?, purge_lease_expires_at = ?
      WHERE id = ?
    `).bind(timeA, timeA, tokenA, timeA + PURGE_LEASE_DURATION_MS, id2).run()

    // B at T + lease/2 — should be rejected
    const timeBHalf = timeA + Math.floor(PURGE_LEASE_DURATION_MS / 2)
    const handlerBHalf = createAdminHandler(env, {
      now: () => timeBHalf,
      __test_disableInFlightGuard: true,
    })
    const purgeBHalf = await handlerBHalf.fetch(req(`/api/admin/backgrounds/${id2}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBHalf.status).toBe(409)

    // B at T + lease + 1 — takeover allowed
    const timeBExpired = timeA + PURGE_LEASE_DURATION_MS + 1
    const handlerBExpired = createAdminHandler(env, {
      now: () => timeBExpired,
      __test_disableInFlightGuard: true,
    })
    const purgeBExpired = await handlerBExpired.fetch(req(`/api/admin/backgrounds/${id2}/purge`, cookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purgeBExpired.status).toBe(204)

    const finalRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id2).first()
    expect(finalRow).toBeNull()

    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id2}`).first<number>('count')
    expect(auditCount).toBe(1)
  })
})

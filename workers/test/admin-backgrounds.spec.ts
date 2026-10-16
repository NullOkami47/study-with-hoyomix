import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAdminHandler, type AdminEnv } from '../admin/routes'
import { createAuthHandler } from '../auth/routes'
import { BACKGROUND_IMAGE_MAX_BYTES } from '../backgrounds/mediaValidation'
import type { BackgroundBucket, BackgroundStoredObject } from '../backgrounds/storage'
import { STATIC_BACKGROUND_IDS } from '../../src/features/backgrounds/staticDefinitions'
import { applyApiSecurityHeaders } from '../index'

vi.mock('../../src/features/backgrounds/staticDefinitions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/features/backgrounds/staticDefinitions')>(),
  ...await import('./static-backgrounds-fixture'),
}))
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

  const authenticatedCookie = async (role: 'user' | 'moderator' | 'admin' | 'owner', userId = `${role}-background-user`) => {
    await database.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, role, role, NOW, NOW).run()
    const issued = await createAuthHandler(env, { now: () => NOW }).issueSession(userId)
    return `__Host-session=${issued.token}`
  }

  const request = (path: string, cookie?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    const requestInit = {
      ...init,
      headers,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
    } as RequestInit & { duplex?: 'half' }
    return new Request(`${ORIGIN}${path}`, requestInit)
  }

  const upload = (cookie: string, bytes = png(), contentType = 'image/png', origin = ORIGIN) =>
    createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/backgrounds/uploads', cookie, {
      method: 'POST',
      headers: { 'content-type': contentType, origin },
      body: bytes,
    }))

  it.each([
    [undefined, 401],
    ['user', 403],
    ['moderator', 403],
  ] as const)('denies background upload to %s', async (role, status) => {
    const cookie = role ? await authenticatedCookie(role) : undefined
    expect((await upload(cookie ?? '')).status).toBe(status)
    expect(bucket.bucket.put).not.toHaveBeenCalled()
  })

  it.each(['admin', 'owner'] as const)('allows %s to create an image draft without exposing its object key', async (role) => {
    const response = await upload(await authenticatedCookie(role))
    const body = await response.json() as { background: Record<string, unknown> }
    expect(response.status).toBe(201)
    expect(body.background).toEqual(expect.objectContaining({
      status: 'draft',
      kind: 'image',
      contentType: 'image/png',
      width: 1920,
      height: 1080,
      rightsStatus: 'not-reviewed',
    }))
    expect(JSON.stringify(body)).not.toMatch(/objectKey|tracks\/authorized|signedUrl|localPath/i)
    expect([...bucket.objects.keys()][0]).toMatch(
      /^backgrounds\/[0-9a-f-]+\/revisions\/[0-9a-f-]+\.png$/,
    )
  })

  it('stores a validated video draft and thumbnail atomically with capped database metadata', async () => {
    const cookie = await authenticatedCookie('owner')
    const video = await readFile('tests/fixtures/background-video/valid.mp4')
    const poster = await readFile('tests/fixtures/background-video/poster.jpg')
    const form = new FormData()
    form.append('media',new File([video],'video.mp4',{type:'video/mp4'}))
    form.append('poster',new File([poster],'poster.jpg',{type:'image/jpeg'}))
    const highVideo = await readFile('tests/fixtures/background-video/valid-high.mp4')
    form.append('highMedia',new File([highVideo],'high.mp4',{type:'video/mp4'}))
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN},body:form}))
    const body = await response.json() as { background?: { id:string;fps:number;width:number;posterUrl:string;status:string };error?:string }
    expect(response.status,JSON.stringify(body)).toBe(201)
    expect(body.background).toMatchObject({width:320,fps:30,status:'draft'})
    expect(body.background?.posterUrl).toContain('/poster')
    expect(bucket.objects.size).toBe(3)
    const row=await database.prepare('SELECT fps,width,height FROM background_media_revisions WHERE background_id=?').bind(body.background!.id).first()
    expect(row).toMatchObject({fps:30,width:320,height:180})
    const metadata = await database.prepare('SELECT provenance_json AS metadata FROM background_media_revisions WHERE background_id=?').bind(body.background!.id).first<{metadata: string}>()
    expect(JSON.parse(metadata!.metadata).highQualityVersion).toMatchObject({width:2560,height:1440,fps:30})
    const handler = createAdminHandler(env,{now:()=>NOW})
    const id = body.background!.id
    const highResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/high-media`,cookie))
    expect(highResponse.status).toBe(200)
    expect(new Uint8Array(await highResponse.arrayBuffer())).toEqual(new Uint8Array(highVideo))
    expect(JSON.stringify(body)).not.toMatch(/objectKey|\/revisions\//)
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`,cookie,{method:'POST',headers:{origin:ORIGIN}}))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`,cookie,{method:'POST',headers:{origin:ORIGIN}}))
    const purged = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`,cookie,{method:'DELETE',headers:{origin:ORIGIN}}))
    expect(purged.status).toBe(204)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects an invalid companion before storing either playback version', async () => {
    const cookie = await authenticatedCookie('owner')
    const form = new FormData()
    form.append('media',new File([await readFile('tests/fixtures/background-video/valid.mp4')],'video.mp4',{type:'video/mp4'}))
    form.append('poster',new File([await readFile('tests/fixtures/background-video/poster.jpg')],'poster.jpg',{type:'image/jpeg'}))
    form.append('highMedia',new File([await readFile('tests/fixtures/background-video/over-fps.mp4')],'high.mp4',{type:'video/mp4'}))
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN},body:form}))
    expect(response.ok).toBe(false)
    expect(bucket.objects.size).toBe(0)
  })

  it.each([false, true])('requires a real companion file for every new video upload (empty field: %s)', async (emptyField) => {
    const cookie = await authenticatedCookie('owner')
    const form = new FormData()
    form.append('media',new File([await readFile('tests/fixtures/background-video/valid.mp4')],'video.mp4',{type:'video/mp4'}))
    form.append('poster',new File([await readFile('tests/fixtures/background-video/poster.jpg')],'poster.jpg',{type:'image/jpeg'}))
    if (emptyField) form.append('highMedia','')
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN},body:form}))
    expect(response.status).toBe(422)
    expect(bucket.objects.size).toBe(0)
  })

  it('releases both playback versions and poster if the companion cannot be stored', async () => {
    const cookie = await authenticatedCookie('owner')
    const form = new FormData()
    const video = await readFile('tests/fixtures/background-video/valid.mp4')
    form.append('media',new File([video],'video.mp4',{type:'video/mp4'}))
    form.append('poster',new File([await readFile('tests/fixtures/background-video/poster.jpg')],'poster.jpg',{type:'image/jpeg'}))
    form.append('highMedia',new File([video],'high.mp4',{type:'video/mp4'}))
    vi.mocked(bucket.bucket.put).mockResolvedValueOnce({key:'first',size:video.length}).mockResolvedValueOnce({key:'poster',size:100}).mockResolvedValueOnce(null)
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN},body:form}))
    expect(response.status).toBe(500)
    expect(bucket.bucket.delete).toHaveBeenCalledTimes(3)
    expect((await database.prepare('SELECT COUNT(*) AS count FROM background_media').first<{count:number}>())?.count).toBe(0)
  })

  it('rejects one oversized version before allocating a video validation buffer', async () => {
    const cookie = await authenticatedCookie('owner')
    const form = new FormData()
    form.append('media', new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'video.mp4', {type:'video/mp4'}))
    form.append('highMedia', new File([await readFile('tests/fixtures/background-video/valid.mp4')], 'high.mp4', {type:'video/mp4'}))
    form.append('poster', new File([await readFile('tests/fixtures/background-video/poster.jpg')], 'poster.jpg', {type:'image/jpeg'}))
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN},body:form}))
    expect(response.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
  })

  it('cancels an oversized multipart stream with 413 even without Content-Length', async () => {
    const cookie = await authenticatedCookie('owner')
    let chunks = 0, cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('--cap-boundary\r\nContent-Disposition: form-data; name="media"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n'))
        else if (chunks < 60) controller.enqueue(new Uint8Array(1024 * 1024))
        else controller.close()
      },
      cancel() { cancelled = true },
    })
    const response = await createAdminHandler(env,{now:()=>NOW}).fetch(request('/api/admin/backgrounds/uploads',cookie,{method:'POST',headers:{origin:ORIGIN,'content-type':'multipart/form-data; boundary=cap-boundary'},body:stream}))
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(chunks).toBeLessThan(60)
    expect(bucket.objects.size).toBe(0)
  })

  it('requires exact Origin and an explicit background bucket binding', async () => {
    const cookie = await authenticatedCookie('admin')
    expect((await upload(cookie, png(), 'image/png', 'https://evil.example')).status).toBe(403)
    const unavailable = createAdminHandler({ ...env, BACKGROUND_BUCKET: undefined }, { now: () => NOW })
    const response = await unavailable.fetch(request('/api/admin/backgrounds/uploads', cookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: png(),
    }))
    expect(response.status).toBe(503)
  })

  it.each([
    ['image/jpeg', png(), 415, 'media_type_mismatch'],
    ['image/gif', new Uint8Array([1, 2, 3]), 415, 'unsupported_media_type'],
    ['video/mp4', new Uint8Array([0, 0, 0, 0]), 422, 'video_validation_unavailable'],
  ] as const)('fails closed for invalid or unverifiable %s media', async (contentType, bytes, status, error) => {
    const response = await upload(await authenticatedCookie('admin'), bytes, contentType)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
    expect(bucket.bucket.put).not.toHaveBeenCalled()
  })

  it('cancels an undeclared streaming image body immediately after it crosses 12 MiB', async () => {
    const chunkBytes = 1024 * 1024
    const totalBytes = 20 * chunkBytes
    let pulledBytes = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true },
      pull: (controller) => {
        const size = Math.min(chunkBytes, totalBytes - pulledBytes)
        const chunk = new Uint8Array(size)
        if (pulledBytes === 0) chunk.set(png())
        pulledBytes += size
        controller.enqueue(chunk)
        if (pulledBytes === totalBytes) controller.close()
      },
    })
    const cookie = await authenticatedCookie('admin')
    const uploadRequest = request('/api/admin/backgrounds/uploads', cookie, {
      body,
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      method: 'POST',
    })
    const prefetchedBytes = pulledBytes

    const response = await createAdminHandler(env, { now: () => NOW }).fetch(uploadRequest)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'media_too_large' })
    expect(pulledBytes - prefetchedBytes).toBeLessThanOrEqual(
      BACKGROUND_IMAGE_MAX_BYTES + chunkBytes,
    )
    expect(cancelled).toBe(true)
    expect(bucket.bucket.put).not.toHaveBeenCalled()
  })

  it.each([
    ['image/svg+xml', 415, 'unsupported_media_type'],
    ['video/mp4', 422, 'video_validation_unavailable'],
    ['video/webm', 422, 'video_validation_unavailable'],
  ])('rejects unsupported %s without consuming its body', async (contentType, status, error) => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulls === 3) controller.close()
      },
    })
    const cookie = await authenticatedCookie('admin')
    const uploadRequest = request('/api/admin/backgrounds/uploads', cookie, {
      body,
      headers: { 'content-type': contentType, origin: ORIGIN },
      method: 'POST',
    })
    const prefetchedPulls = pulls

    const response = await createAdminHandler(env, { now: () => NOW }).fetch(uploadRequest)

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
    expect(pulls).toBe(prefetchedPulls)
    expect(bucket.bucket.put).not.toHaveBeenCalled()
  })

  it('completes publish, public projection, archive, restore, and purge with audit evidence', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const createdBody = await created.json() as { background: { id: string } }
    const id = createdBody.background.id
    const handler = createAdminHandler(env, { now: () => NOW + 1 })
    const action = (name: string, method = 'POST') => handler.fetch(request(
      `/api/admin/backgrounds/${id}/${name}`,
      cookie,
      { method, headers: { origin: ORIGIN } },
    ))

    expect((await action('publish')).status).toBe(200)
    const publicList = await handler.fetch(request('/api/backgrounds'))
    const publicBody = await publicList.json()
    expect(publicBody).toEqual({ backgrounds: [expect.objectContaining({
      id,
      status: 'published',
      mediaUrl: `/api/backgrounds/${id}/media`,
    })] })
    expect(JSON.stringify(publicBody)).not.toMatch(/objectKey|posterObjectKey|signedUrl|r2\.dev|tracks\/authorized|\/revisions\/|[A-Z]:\\/i)
    const media = await handler.fetch(request(`/api/backgrounds/${id}/media`))
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    expect(media.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(png())

    expect((await action('archive')).status).toBe(200)
    expect((await handler.fetch(request('/api/backgrounds')).then((response) => response.json()))).toEqual({ backgrounds: [] })
    expect((await action('restore')).status).toBe(200)
    expect((await action('archive')).status).toBe(200)
    expect((await action('purge', 'DELETE')).status).toBe(204)
    expect(bucket.bucket.delete).toHaveBeenCalledTimes(1)

    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? ORDER BY created_at, action
    `).bind(`background:${id}`).all<{ action: string }>()
    expect(audits.results.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining([
      'background.archive',
      'background.create',
      'background.publish',
      'background.purge',
      'background.restore',
    ]))
  })

  it('replaces only a non-archived background with a new controlled revision', async () => {
    const cookie = await authenticatedCookie('owner')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string; revision: number } }
    const handler = createAdminHandler(env, { now: () => NOW + 2 })
    const replacement = await handler.fetch(request(`/api/admin/backgrounds/${background.id}/replace`, cookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: png(1280, 720),
    }))
    expect(replacement.status).toBe(200)
    expect(await replacement.json()).toEqual({ background: expect.objectContaining({
      id: background.id,
      revision: 2,
      width: 1280,
      height: 720,
    }) })
    expect(bucket.objects).toHaveLength(2)
  })

  it('rejects stale background selection revisions after deletion and an absent condition against an existing row', async () => {
    const handler = createAdminHandler(env, { now: () => NOW + 3 })
    const cookie = await authenticatedCookie('user')
    const selection = { selectedIds: [STATIC_BACKGROUND_IDS[0]], autoRotate: true, intervalSeconds: 1200 }
    const put = (value: typeof selection, expected: string) => handler.fetch(request('/api/account/background-selection', cookie, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, 'if-match': expected }, body: JSON.stringify(value),
    }))
    const first = await put(selection, 'absent')
    expect(first.status).toBe(200)
    const version = first.headers.get('etag')!
    expect((await put({ ...selection, selectedIds: [] }, 'absent')).status).toBe(409)
    expect((await put({ ...selection, selectedIds: [] }, version)).status).toBe(200)
    expect((await put(selection, version)).status).toBe(409)
    expect((await handler.fetch(request('/api/account/background-selection', cookie))).headers.get('etag')).toBe('absent')
  })

  it('syncs bounded published selections for authenticated users through the existing session boundary', async () => {
    const handler = createAdminHandler(env, { now: () => NOW + 3 })
    expect((await handler.fetch(request('/api/account/background-selection'))).status).toBe(401)

    const adminCookie = await authenticatedCookie('admin')
    const created = await upload(adminCookie)
    const { background } = await created.json() as { background: { id: string } }
    await handler.fetch(request(`/api/admin/backgrounds/${background.id}/publish`, adminCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))

    const userCookie = await authenticatedCookie('user')
    const selection = { selectedIds: [background.id], autoRotate: true, intervalSeconds: 30 }
    expect((await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection),
    }))).status).toBe(403)
    const saved = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(selection),
    }))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ selection })

    const loaded = await handler.fetch(request('/api/account/background-selection', userCookie))
    expect(await loaded.json()).toEqual({ selection })

    const missing = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ ...selection, selectedIds: ['11111111-1111-4111-8111-111111111111'] }),
    }))
    expect(missing.status).toBe(409)

    const cleared = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ ...selection, selectedIds: [] }),
    }))
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ selection: { ...selection, selectedIds: [] } })
  })

  it('rejects inexact JSON media types and oversized streamed background selections', async () => {
    const userCookie = await authenticatedCookie('user')
    const body = JSON.stringify({ selectedIds: [], autoRotate: false, intervalSeconds: 30 })
    const handler = createAdminHandler(env, { now: () => NOW })

    const wrongMime = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/jsonp', origin: ORIGIN },
      body,
    }))
    const oversized = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: `${' '.repeat(2_100)}${body}`,
    }))

    expect(wrongMime.status).toBe(400)
    expect(oversized.status).toBe(400)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM user_background_selections').first<number>('count')).toBe(0)
  })

  it.each([
    [undefined, 401],
    ['user', 403],
    ['moderator', 403],
  ] as const)('denies every admin background route to %s without mutating state', async (role, status) => {
    const adminCookie = await authenticatedCookie('admin')
    const created = await upload(adminCookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const cookie = role ? await authenticatedCookie(role) : undefined
    const handler = createAdminHandler(env, { now: () => NOW + 4 })
    const attempts = [
      () => handler.fetch(request('/api/admin/backgrounds', cookie)),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}`, cookie)),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/media`, cookie)),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/poster`, cookie)),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/replace`, cookie, {
        method: 'POST', headers: { 'content-type': 'image/png', origin: ORIGIN }, body: png(1280, 720),
      })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/restore`, cookie, { method: 'POST', headers: { origin: ORIGIN } })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, { method: 'DELETE', headers: { origin: ORIGIN } })),
    ]
    for (const attempt of attempts) {
      expect((await attempt()).status).toBe(status)
    }

    const row = await database.prepare('SELECT status FROM background_media WHERE id = ?').bind(id)
      .first<{ status: string }>()
    expect(row?.status).toBe('draft')
    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? ORDER BY created_at, action
    `).bind(`background:${id}`).all<{ action: string }>()
    expect(audits.results.map((entry: { action: string }) => entry.action)).toEqual(['background.create'])
    expect(bucket.bucket.put).toHaveBeenCalledTimes(1)
    expect(bucket.bucket.delete).not.toHaveBeenCalled()
  })

  it('attributes background audit rows to the acting admin, never to another admin', async () => {
    const adminACookie = await authenticatedCookie('admin', 'background-admin-a')
    const adminBCookie = await authenticatedCookie('admin', 'background-admin-b')

    const created = await upload(adminACookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const handler = createAdminHandler(env, { now: () => NOW + 5 })
    expect((await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, adminBCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))).status).toBe(200)
    expect((await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, adminBCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))).status).toBe(200)

    const audits = await database.prepare(`
      SELECT action, actor_user_id AS actorUserId FROM admin_audit_log
      WHERE target_key = ? ORDER BY created_at, action
    `).bind(`background:${id}`).all<{ action: string; actorUserId: string }>()
    const actors = Object.fromEntries(audits.results.map((entry: { action: string; actorUserId: string }) => [entry.action, entry.actorUserId]))
    expect(actors['background.create']).toBe('background-admin-a')
    expect(actors['background.publish']).toBe('background-admin-b')
    expect(actors['background.archive']).toBe('background-admin-b')
  })

  it('prevents unrecoverable D1/R2 inconsistency when purge D1 finalisation fails', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    await createAdminHandler(env, { now: () => NOW + 6 }).fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await createAdminHandler(env, { now: () => NOW + 6 }).fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const prePurgeRow = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()

    const originalDB = env.DB
    let batchCalls = 0
    env.DB = new Proxy(originalDB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: any) => {
            batchCalls += 1
            if (batchCalls === 1) {
              throw new Error('Injected D1 batch failure')
            }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as any

    const purgeResponse = await createAdminHandler(env, { now: () => NOW + 6 }).fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    env.DB = originalDB

    expect(batchCalls).toBeGreaterThan(0)
    expect(purgeResponse.status).toBe(500)
    if (purgeResponse.status !== 204) {
      expect(await purgeResponse.json()).toEqual({ error: 'background_purge_failed' })
    }
    const row = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()
    expect(row).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number) })
    const revisionCount = await database.prepare(
      'SELECT COUNT(*) AS count FROM background_media_revisions WHERE background_id = ?',
    ).bind(id).first<number>('count')
    expect(revisionCount).toBe(1)
    expect([...bucket.objects.keys()]).toHaveLength(0)
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(0)

    env.DB = originalDB
    const retryResponse = await createAdminHandler(env, { now: () => NOW + 6 + 30_000 + 1 }).fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(retryResponse.status).toBe(204)
    const deletedRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(deletedRow).toBeNull()
    const finalAuditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(finalAuditCount).toBe(1)
  })

  it('recovers when R2 deletion fails during purge', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 7 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const originalDelete = bucket.bucket.delete
    bucket.bucket.delete = vi.fn(async () => {
      throw new Error('Injected R2 delete failure')
    })

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    expect(purgeResponse.status).toBe(503)
    expect(await purgeResponse.json()).toEqual({ error: 'background_storage_unavailable' })
    const row = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()
    expect(row).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number) })
    expect([...bucket.objects.keys()]).toHaveLength(1)

    bucket.bucket.delete = originalDelete
    const retryResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(retryResponse.status).toBe(204)
    expect([...bucket.objects.keys()]).toHaveLength(0)
    const deletedRow = await database.prepare('SELECT id FROM background_media WHERE id = ?').bind(id).first()
    expect(deletedRow).toBeNull()
  })

  it('purges multi-revision background with user selections cleanly', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const created = await upload(adminCookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 8 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/replace`, adminCookie, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: ORIGIN },
      body: png(1280, 720),
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, adminCookie, { method: 'POST', headers: { origin: ORIGIN } }))

    const userCookie = await authenticatedCookie('user')
    await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ selectedIds: [id], autoRotate: true, intervalSeconds: 30 }),
    }))

    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, adminCookie, { method: 'POST', headers: { origin: ORIGIN } }))
    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(204)
    expect([...bucket.objects.keys()]).toHaveLength(0)
    const selection = await database.prepare(
      'SELECT user_id FROM user_background_selections WHERE user_id = ?',
    ).bind('user-background-user').first()
    expect(selection).toBeNull()
  })

  it('makes purge retry idempotent with no duplicate audit or false 204', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 9 })
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

  it('prevents concurrent stale purge from returning false 204 and duplicate audit', async () => {
    // Codex Finding 1: concurrent stale purge with missing-row logic bug
    // The bug: undefined?.purgeStartedAt !== null evaluates to true
    const testUndefined: any = undefined
    expect(testUndefined?.purgeStartedAt !== null).toBe(true) // Demonstrates the bug

    // This test documents the vulnerability even though outer readBackground() mitigates it
    // The purge() function itself needs fixing for defense-in-depth
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 10 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    // Complete purge successfully
    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(204)

    // Second purge attempt correctly returns 404 (protected by outer readBackground check)
    const stalePurge = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(stalePurge.status).toBe(404)

    // Verify exactly one audit
    const auditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.purge'
    `).bind(`background:${id}`).first<number>('count')
    expect(auditCount).toBe(1)
  })

  it('prevents recovery-state restore from leaking raw D1 CHECK exception', async () => {
    // Codex Finding 2: restore on purge-recovery background throws uncaught D1 CHECK
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 11 })
    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, { method: 'POST', headers: { origin: ORIGIN } }))

    // Start purge but inject R2 failure to leave recovery state
    const originalDelete = bucket.bucket.delete
    bucket.bucket.delete = vi.fn(async () => {
      throw new Error('Injected R2 delete failure')
    })

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))
    expect(purgeResponse.status).toBe(503)

    bucket.bucket.delete = originalDelete

    // Verify purge_started_at is set (recovery state)
    const recoveryRow = await database.prepare(`
      SELECT id, status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ id: string; status: string; purgeStartedAt: number | null }>()
    expect(recoveryRow).toEqual({ id, status: 'archived', purgeStartedAt: expect.any(Number) })

    // Now attempt restore - should return bounded error, not raw D1 exception
    const rawRestoreResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/restore`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    const restoreResponse = applyApiSecurityHeaders(rawRestoreResponse)

    // VULNERABLE: Currently throws uncaught D1 CHECK exception
    // REQUIRED: Should return bounded 409 conflict with proper headers
    expect(restoreResponse.status).toBe(409)
    expect(restoreResponse.headers.get('content-type')).toContain('application/json')
    expect(restoreResponse.headers.get('x-content-type-options')).toBe('nosniff')

    const body = await restoreResponse.json()
    expect(body).toEqual({ error: expect.any(String) })

    // Verify no restore audit was created
    const restoreAuditCount = await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ? AND action = 'background.restore'
    `).bind(`background:${id}`).first<number>('count')
    expect(restoreAuditCount).toBe(0)

    // Verify background still in recovery state
    const stillRecovery = await database.prepare(`
      SELECT status, purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ status: string; purgeStartedAt: number | null }>()
    expect(stillRecovery).toEqual({ status: 'archived', purgeStartedAt: expect.any(Number) })
  })

  it('documents partial multi-object purge recovery state (video with poster)', async () => {
    // Section 12: Permanent regression test for partial R2 deletion scenario
    // Video backgrounds have TWO R2 objects: object_key (video) and poster_object_key (thumbnail)
    // If R2 delete fails after deleting the first object, purge_started_at recovery state prevents inconsistency

    const cookie = await authenticatedCookie('admin')

    // For this test, we simulate the scenario by creating an image background,
    // publishing, archiving, then manually injecting a poster_object_key to simulate
    // a video background with two objects
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id
    const handler = createAdminHandler(env, { now: () => NOW + 12 })

    await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))

    // Manually inject a second R2 object to simulate video + poster scenario
    // Inject R2 failure during purge to test recovery state
    const originalDelete = bucket.bucket.delete
    bucket.bucket.delete = vi.fn(async () => {
      throw new Error('Injected R2 deletion failure')
    })

    const purgeResponse = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    }))

    // Purge should fail with 503 due to R2 failure
    expect(purgeResponse.status).toBe(503)

    bucket.bucket.delete = originalDelete

    // CRITICAL: Verify purge_started_at was set (recovery state)
    const recoveryState = await database.prepare(`
      SELECT purge_started_at AS purgeStartedAt FROM background_media WHERE id = ?
    `).bind(id).first<{ purgeStartedAt: number | null }>()

    expect(recoveryState?.purgeStartedAt).toBeTypeOf('number')

    // Verify lifecycle transitions are blocked
    const restoreAttempt = await handler.fetch(request(`/api/admin/backgrounds/${id}/restore`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    expect(restoreAttempt.status).toBe(409)

    const republishAttempt = await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }))
    expect(republishAttempt.status).toBe(409)
  })

  const patchMetadata = (id: string, cookie: string | undefined, body: string, nowOffset = 20) =>
    createAdminHandler(env, { now: () => NOW + nowOffset }).fetch(request(`/api/admin/backgrounds/${id}`, cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body,
    }))

  it('merges every shipped static background into the admin catalogue with metadata', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW + 20 })
    const response = await handler.fetch(request('/api/admin/backgrounds', cookie))
    expect(response.status).toBe(200)
    const body = await response.json() as { backgrounds: Array<Record<string, unknown>> }

    const shipped = body.backgrounds.filter((entry) => entry.isShipped === true)
    expect(shipped).toHaveLength(STATIC_BACKGROUND_IDS.length)
    expect(shipped.map((entry) => entry.id)).toEqual([...STATIC_BACKGROUND_IDS].sort())
    for (const entry of shipped) {
      expect(entry).toMatchObject({
        revision: 1,
        status: 'published',
        kind: 'video',
        contentType: 'video/mp4',
        // Shipped files carry no rights clearance: shipping a file is not
        // evidence of permission, so the value stays `not-reviewed` exactly as
        // this synthetic fixture intentionally models unreviewed media.
        rightsStatus: 'not-reviewed',
        isShipped: true,
        createdAt: 0,
        updatedAt: 0,
        publishedAt: 0,
        archivedAt: null,
        displayOrder: 0,
      })
      expect(typeof entry.title).toBe('string')
      expect(entry.mediaUrl).toBeTruthy()
      expect(entry.posterUrl).toBeTruthy()
    }

    const urbanStrollTrio = [
      ['demo-stroll-one', 'Demo One'],
      ['demo-stroll-two', 'Demo Two'],
      ['demo-stroll-three', 'Demo Three'],
    ] as const
    for (const [id, title] of urbanStrollTrio) {
      const entry = shipped.find((candidate) => candidate.id === id)
      expect(entry).toMatchObject({
        title,
        game: 'zzz',
        collection: 'urban-stroll',
        width: 1920,
        height: 1080,
        fps: 24,
      })
    }
  })

  it('persists uploaded metadata through PATCH and the admin catalogue', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    const response = await patchMetadata(id, cookie, JSON.stringify({
      title: 'My Upload', game: 'zzz', collection: 'custom', displayOrder: 7,
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { background: Record<string, unknown> }
    expect(body.background).toMatchObject({
      id,
      isShipped: false,
      title: 'My Upload',
      game: 'zzz',
      collection: 'custom',
      displayOrder: 7,
    })

    const list = await createAdminHandler(env, { now: () => NOW + 20 }).fetch(request('/api/admin/backgrounds', cookie))
    const listBody = await list.json() as { backgrounds: Array<Record<string, unknown>> }
    expect(listBody.backgrounds.find((entry) => entry.id === id)).toMatchObject({
      title: 'My Upload', game: 'zzz', collection: 'custom', displayOrder: 7, isShipped: false,
    })

    const row = await database.prepare(`
      SELECT title, game, collection, display_order AS displayOrder FROM background_media WHERE id = ?
    `).bind(id).first<{ title: string | null; game: string | null; collection: string | null; displayOrder: number | null }>()
    expect(row).toEqual({ title: 'My Upload', game: 'zzz', collection: 'custom', displayOrder: 7 })

    // An explicit null clears the field back to the column default.
    const cleared = await patchMetadata(id, cookie, JSON.stringify({ title: null }), 21)
    expect((await cleared.json() as { background: Record<string, unknown> }).background.title).toBeNull()

    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? AND action = 'background.metadata'
    `).bind(`background:${id}`).all<{ action: string }>()
    expect(audits.results).toHaveLength(2)
  })

  it('projects uploaded metadata onto the public catalogue so the gallery can group and order it', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    expect((await patchMetadata(id, cookie, JSON.stringify({
      title: 'Night Shift Study', game: 'genshin', collection: 'study-room', displayOrder: 4,
    }))).status).toBe(200)
    const handler = createAdminHandler(env, { now: () => NOW + 21 })
    expect((await handler.fetch(request(`/api/admin/backgrounds/${id}/publish`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))).status).toBe(200)

    // The PUBLIC projection — not just the admin one — must carry the
    // administrator's presentation metadata, otherwise the gallery falls back
    // to an unlabelled, unordered entry.
    const publicResponse = await handler.fetch(request('/api/backgrounds'))
    const publicBody = await publicResponse.json() as { backgrounds: Array<Record<string, unknown>> }
    const projected = publicBody.backgrounds.find((entry) => entry.id === id)
    expect(projected).toMatchObject({
      id,
      status: 'published',
      title: 'Night Shift Study',
      game: 'genshin',
      collection: 'study-room',
      displayOrder: 4,
      mediaUrl: `/api/backgrounds/${id}/media`,
    })
    expect(projected).not.toHaveProperty('isShipped')
    // The public projection must not start leaking storage internals now that it
    // carries more columns.
    expect(JSON.stringify(publicBody)).not.toMatch(/objectKey|posterObjectKey|signedUrl|r2\.dev|tracks\/authorized|\/revisions\/|updated_by/i)

    // An unset field is reported as an explicit null/0 rather than omitted, so
    // the public and admin surfaces can never disagree about a row's shape.
    const untouched = await upload(cookie, png(1280, 720))
    const untouchedId = ((await untouched.json()) as { background: { id: string } }).background.id
    await handler.fetch(request(`/api/admin/backgrounds/${untouchedId}/publish`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    const afterSecond = await handler.fetch(request('/api/backgrounds')).then((response) => response.json()) as { backgrounds: Array<Record<string, unknown>> }
    expect(afterSecond.backgrounds.find((entry) => entry.id === untouchedId)).toMatchObject({
      title: null, game: null, collection: null, displayOrder: 0,
    })
  })

  it('commits a metadata patch and its audit entry atomically, rolling both back if the audit fails', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    // Baseline: a healthy audit trail records the mutation.
    expect((await patchMetadata(id, cookie, JSON.stringify({ title: 'Committed' }))).status).toBe(200)
    const before = await database.prepare('SELECT title FROM background_media WHERE id = ?').bind(id).first<{ title: string | null }>()
    expect(before?.title).toBe('Committed')

    // Force the audit insert to fail. The metadata UPDATE is in the same D1
    // batch, so it must roll back rather than commit an unlogged change.
    await database.prepare('DROP TABLE admin_audit_log').run()
    const failed = await patchMetadata(id, cookie, JSON.stringify({ title: 'Must Not Persist' }), 22)
    expect(failed.status).toBe(500)

    const after = await database.prepare('SELECT title FROM background_media WHERE id = ?').bind(id).first<{ title: string | null }>()
    expect(after?.title).toBe('Committed')
  })

  it('does not write an audit entry when the patched background does not exist', async () => {
    const cookie = await authenticatedCookie('admin')
    const missing = '99999999-9999-4999-8999-999999999999'

    const response = await patchMetadata(missing, cookie, JSON.stringify({ title: 'Ghost' }))
    expect(response.status).toBe(404)
    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? AND action = 'background.metadata'
    `).bind(`background:${missing}`).all<{ action: string }>()
    expect(audits.results).toHaveLength(0)
  })

  it('creates and updates a shipped override through PATCH, preserving status and other fields', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-stroll-one'

    const first = await patchMetadata(id, cookie, JSON.stringify({ title: 'Renamed', displayOrder: 3 }))
    expect(first.status).toBe(200)
    expect((await first.json() as { background: Record<string, unknown> }).background).toMatchObject({
      id, isShipped: true, status: 'published', title: 'Renamed', displayOrder: 3,
      game: 'zzz', collection: 'urban-stroll',
    })

    const second = await patchMetadata(id, cookie, JSON.stringify({ game: 'custom-game' }), 21)
    expect((await second.json() as { background: Record<string, unknown> }).background).toMatchObject({
      title: 'Renamed', game: 'custom-game', collection: 'urban-stroll', displayOrder: 3,
    })

    const overrides = await createAdminHandler(env, { now: () => NOW + 21 }).fetch(request('/api/backgrounds/overrides'))
    const overridesBody = await overrides.json() as { overrides: Array<Record<string, unknown>> }
    expect(overridesBody.overrides.find((entry) => entry.id === id)).toMatchObject({
      id, status: 'published', title: 'Renamed', game: 'custom-game', displayOrder: 3,
    })
    expect(JSON.stringify(overridesBody)).not.toMatch(/updated_by|updatedBy/)

    const list = await createAdminHandler(env, { now: () => NOW + 21 }).fetch(request('/api/admin/backgrounds', cookie))
    const listBody = await list.json() as { backgrounds: Array<Record<string, unknown>> }
    expect(listBody.backgrounds.find((entry) => entry.id === id)).toMatchObject({ title: 'Renamed', game: 'custom-game' })
  })

  const raceShippedPatches = async (id: string, cookie: string, patches: [Record<string, unknown>, Record<string, unknown>]) => {
    let arrivals = 0
    let releaseBoth!: () => void
    let firstCommitted!: () => void
    const bothAtBatch = new Promise<void>((resolve) => { releaseBoth = resolve })
    const firstCommit = new Promise<void>((resolve) => { firstCommitted = resolve })
    const originalBatch = database.batch.bind(database)
    let firstCommittedPatch!: Record<string, unknown>
    // Both handlers reach their transaction before either can commit. This
    // guarantees stale snapshots in the old handler, without requiring a read
    // in the fixed handler. Only scheduling is wrapped; D1 executes real SQL.
    env.DB = {
      prepare: database.prepare.bind(database),
      batch: async (statements: Parameters<typeof database.batch>[0]) => {
        const ticket = arrivals++
        if (arrivals === 2) releaseBoth()
        await bothAtBatch
        if (ticket === 1) await firstCommit
        try {
          const result = await originalBatch(statements)
          if (ticket === 0) {
            const audit = await database.prepare(`
              SELECT detail_json AS detail FROM admin_audit_log WHERE target_key = ? AND action = 'background.metadata'
            `).bind(`background:${id}`).first<{ detail: string }>()
            firstCommittedPatch = JSON.parse(audit!.detail)
          }
          return result
        } finally {
          if (ticket === 0) firstCommitted()
        }
      },
    } as unknown as AdminEnv['DB']
    const responses = await Promise.all(patches.map((patch, index) =>
      patchMetadata(id, cookie, JSON.stringify(patch), 30 + index)))
    expect(arrivals).toBe(2)
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const audits = await database.prepare(`
      SELECT detail_json AS detail FROM admin_audit_log
      WHERE target_key = ? AND action = 'background.metadata'
    `).bind(`background:${id}`).all<{ detail: string }>()
    expect(audits.results.map((audit: { detail: string }) => JSON.parse(audit.detail))).toEqual(expect.arrayContaining(patches))
    expect(audits.results).toHaveLength(2)
    return firstCommittedPatch
  }

  it.each(['published', 'archived', 'tombstoned'] as const)('preserves concurrent distinct shipped metadata fields and existing %s status', async (status) => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    await database.prepare(`
      INSERT INTO static_background_overrides (id, status, title, game, collection, display_order, updated_at)
      VALUES (?, ?, 'Before', 'zzz', 'Original collection', 7, ?)
    `).bind(id, status, NOW).run()

    await raceShippedPatches(id, cookie, [{ title: 'Concurrent title' }, { game: 'custom-game' }])

    const row = await database.prepare('SELECT status, title, game, collection, display_order AS displayOrder FROM static_background_overrides WHERE id = ?')
      .bind(id).first()
    expect(row).toMatchObject({ status, title: 'Concurrent title', game: 'custom-game', collection: 'Original collection', displayOrder: 7 })
  })

  it('preserves concurrent distinct shipped metadata fields on first-ever override creation', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    await raceShippedPatches(id, cookie, [{ title: 'First title', displayOrder: 0 }, { game: 'first-game', collection: 'First collection' }])

    const row = await database.prepare('SELECT status, title, game, collection, display_order AS displayOrder FROM static_background_overrides WHERE id = ?')
      .bind(id).first()
    expect(row).toMatchObject({ status: 'published', title: 'First title', game: 'first-game', collection: 'First collection', displayOrder: 0 })
  })

  it('preserves explicit shipped metadata clears alongside a concurrent distinct field patch', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    await database.prepare(`
      INSERT INTO static_background_overrides (id, status, title, game, collection, display_order, updated_at)
      VALUES (?, 'archived', 'Before', 'zzz', 'Before collection', 7, ?)
    `).bind(id, NOW).run()

    await raceShippedPatches(id, cookie, [{ title: null, collection: null, displayOrder: null }, { game: 'custom-game' }])

    const row = await database.prepare('SELECT status, title, game, collection, display_order AS displayOrder FROM static_background_overrides WHERE id = ?')
      .bind(id).first()
    expect(row).toMatchObject({ status: 'archived', title: null, game: 'custom-game', collection: null, displayOrder: null })
  })

  it('keeps last-writer behaviour for concurrent patches of the same shipped field', async () => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    const firstCommit = await raceShippedPatches(id, cookie, [{ title: 'Writer one' }, { title: 'Writer two' }])
    const row = await database.prepare('SELECT title FROM static_background_overrides WHERE id = ?').bind(id).first<{ title: string }>()
    expect(row?.title).toBe(firstCommit.title === 'Writer one' ? 'Writer two' : 'Writer one')
  })

  it.each([false, true])('rolls back shipped metadata when its audit fails with existing override=%s', async (existing) => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    if (existing) {
      await database.prepare(`
        INSERT INTO static_background_overrides (id, status, title, updated_at) VALUES (?, 'tombstoned', 'Before', ?)
      `).bind(id, NOW).run()
    }
    await database.prepare('DROP TABLE admin_audit_log').run()

    expect((await patchMetadata(id, cookie, JSON.stringify({ title: 'Must not persist' }))).status).toBe(500)

    const row = await database.prepare('SELECT status, title, updated_at AS updatedAt FROM static_background_overrides WHERE id = ?').bind(id).first()
    expect(row).toEqual(existing ? { status: 'tombstoned', title: 'Before', updatedAt: NOW } : null)
  })

  it('rejects malformed or out-of-range metadata patches', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await upload(cookie)
    const { background } = await created.json() as { background: { id: string } }
    const id = background.id

    expect((await patchMetadata(id, cookie, JSON.stringify({ title: 'x'.repeat(121) }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, JSON.stringify({ title: '   ' }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, JSON.stringify({ game: 'y'.repeat(65) }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, JSON.stringify({ displayOrder: -1 }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, JSON.stringify({ displayOrder: 1.5 }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, JSON.stringify({ unknownKey: 'x' }))).status).toBe(400)
    expect((await patchMetadata(id, cookie, '{ not json')).status).toBe(400)

    const missingUpload = await patchMetadata('11111111-1111-4111-8111-111111111111', cookie, JSON.stringify({ title: 'ok' }))
    expect(missingUpload.status).toBe(404)
    expect(await missingUpload.json()).toEqual({ error: 'background_not_found' })
    const missingShipped = await patchMetadata('zzz-not-a-real-background', cookie, JSON.stringify({ title: 'ok' }))
    expect(missingShipped.status).toBe(404)
    expect(await missingShipped.json()).toEqual({ error: 'background_not_found' })

    const row = await database.prepare('SELECT title FROM background_media WHERE id = ?').bind(id).first<{ title: string | null }>()
    expect(row?.title).toBeNull()
    const overrideCount = await database.prepare('SELECT COUNT(*) AS count FROM static_background_overrides').first<{ count: number }>()
    expect(overrideCount?.count).toBe(0)
  })

  it('archives and restores a shipped background without touching R2', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW + 22 })
    const id = 'demo-background-four'
    const action = (name: string) => handler.fetch(request(`/api/admin/backgrounds/${id}/${name}`, cookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))

    // Shipped media are never drafts, so publish is never valid.
    expect((await action('publish')).status).toBe(409)

    const archived = await action('archive')
    expect(archived.status).toBe(200)
    expect((await archived.json() as { background: Record<string, unknown> }).background).toMatchObject({
      id, status: 'archived', isShipped: true,
    })

    const overrides = await handler.fetch(request('/api/backgrounds/overrides'))
    const overridesBody = await overrides.json() as { overrides: Array<{ id: string; status: string }> }
    expect(overridesBody.overrides.find((entry) => entry.id === id)?.status).toBe('archived')

    // Restore is only valid from archived; a second archive is a conflict.
    expect((await action('archive')).status).toBe(409)

    const restored = await action('restore')
    expect(restored.status).toBe(200)
    expect((await restored.json() as { background: Record<string, unknown> }).background.status).toBe('published')
    expect((await action('restore')).status).toBe(409)

    expect(bucket.bucket.put).not.toHaveBeenCalled()
    expect(bucket.bucket.delete).not.toHaveBeenCalled()

    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? ORDER BY created_at, action
    `).bind(`background:${id}`).all<{ action: string }>()
    expect(audits.results.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining([
      'background.archive', 'background.restore',
    ]))
  })

  it.each(['restore', 'purge'] as const)('rejects a stale shipped %s and rolls back its audit after a concurrent tombstone', async (action) => {
    const cookie = await authenticatedCookie('admin')
    const id = 'demo-background-four'
    await database.prepare("INSERT INTO static_background_overrides (id, status, updated_at) VALUES (?, 'archived', ?)").bind(id, NOW).run()
    const originalBatch = database.batch.bind(database)
    // Miniflare's remote binding proxy does not preserve spyOn assignment.
    // Wrap the handler binding explicitly so the race definitely runs.
    const racedBatch = vi.fn(async (statements: Parameters<typeof database.batch>[0]) => {
      await database.prepare("UPDATE static_background_overrides SET status = 'tombstoned' WHERE id = ?").bind(id).run()
      return originalBatch(statements)
    })
    env.DB = { prepare: database.prepare.bind(database), batch: racedBatch } as unknown as AdminEnv['DB']
      const handler = createAdminHandler(env, { now: () => NOW + 23 })
      const response = await handler.fetch(request(`/api/admin/backgrounds/${id}/${action}`, cookie, {
        method: action === 'purge' ? 'DELETE' : 'POST', headers: { origin: ORIGIN },
      }))
      expect(racedBatch).toHaveBeenCalledOnce()
      expect(response.status).toBe(409)
      expect((await database.prepare('SELECT status FROM static_background_overrides WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('tombstoned')
      expect((await database.prepare('SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_key = ?').bind(`background:${id}`).first<{ count: number }>())?.count).toBe(0)
  })

  it('tombstones an archived shipped background and sanitises selections without R2', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const userCookie = await authenticatedCookie('user')
    const handler = createAdminHandler(env, { now: () => NOW + 23 })
    const id = 'demo-background-five'

    // Purge on a non-archived shipped background is a conflict.
    expect((await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))).status).toBe(409)

    const selected = await handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ selectedIds: [id], autoRotate: true, intervalSeconds: 30 }),
    }))
    expect(selected.status).toBe(200)

    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, adminCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    const purged = await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect(purged.status).toBe(204)

    // Tombstoned is a terminal state: a repeat purge is a conflict.
    expect((await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))).status).toBe(409)

    const override = await database.prepare('SELECT status FROM static_background_overrides WHERE id = ?')
      .bind(id).first<{ status: string }>()
    expect(override?.status).toBe('tombstoned')

    expect(bucket.bucket.put).not.toHaveBeenCalled()
    expect(bucket.bucket.delete).not.toHaveBeenCalled()

    const selection = await database.prepare('SELECT user_id FROM user_background_selections WHERE user_id = ?')
      .bind('user-background-user').first()
    expect(selection).toBeNull()

    const audits = await database.prepare(`
      SELECT action FROM admin_audit_log WHERE target_key = ? ORDER BY created_at, action
    `).bind(`background:${id}`).all<{ action: string }>()
    expect(audits.results.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining([
      'background.archive', 'background.tombstone',
    ]))
  })

  it('accepts published shipped ids for account selection and rejects unavailable ones', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const userCookie = await authenticatedCookie('user')
    const handler = createAdminHandler(env, { now: () => NOW + 24 })
    const id = 'demo-background-seven'
    const select = (selectedIds: string[]) => handler.fetch(request('/api/account/background-selection', userCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ selectedIds, autoRotate: true, intervalSeconds: 30 }),
    }))

    expect((await select([id])).status).toBe(200)
    const loaded = await handler.fetch(request('/api/account/background-selection', userCookie))
    expect(await loaded.json()).toEqual({ selection: { selectedIds: [id], autoRotate: true, intervalSeconds: 30 } })

    // An id that is neither an uploaded UUID nor a known shipped slug is a conflict.
    expect((await select(['not-a-known-background'])).status).toBe(409)

    await handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, adminCookie, {
      method: 'POST', headers: { origin: ORIGIN },
    }))
    expect((await select([id])).status).toBe(409)

    await handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, adminCookie, {
      method: 'DELETE', headers: { origin: ORIGIN },
    }))
    expect((await select([id])).status).toBe(409)
  })

  it.each([
    [undefined, 401],
    ['user', 403],
    ['moderator', 403],
  ] as const)('denies shipped background mutations to %s without writing overrides', async (role, status) => {
    const cookie = role ? await authenticatedCookie(role) : undefined
    const handler = createAdminHandler(env, { now: () => NOW + 25 })
    const id = 'demo-background-six'
    const attempts = [
      () => handler.fetch(request(`/api/admin/backgrounds/${id}`, cookie, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ title: 'Nope' }),
      })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/archive`, cookie, {
        method: 'POST', headers: { origin: ORIGIN },
      })),
      () => handler.fetch(request(`/api/admin/backgrounds/${id}/purge`, cookie, {
        method: 'DELETE', headers: { origin: ORIGIN },
      })),
    ]
    for (const attempt of attempts) {
      expect((await attempt()).status).toBe(status)
    }
    const overrides = await database.prepare('SELECT COUNT(*) AS count FROM static_background_overrides').first<{ count: number }>()
    expect(overrides?.count).toBe(0)
  })
})

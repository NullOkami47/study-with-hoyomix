// Wave E preservation (task 18, design Property 2, requirements 3.1 and 3.3). Observation-first:
// every expectation below was observed on the unfixed tree (ee34b3b) through the real Worker and
// ChatRoom Durable Object in Miniflare, and must still hold after H-02 replaces the room-wide
// `reset` with targeted deltas and moves /revalidate into ctx.waitUntil.
//
// Not asserted, because H-02 changes it on purpose: WHICH frame tells a revoked socket that it lost
// its privileged view. Both the old `reset` and a new `viewer` delta with a non-privileged viewer
// count as "lost the moderator view"; what must not happen is that it keeps it.
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import fc from 'fast-check'
import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import { Miniflare } from './miniflare-compat'

const origin = 'https://study.example'
const secret = 'community-test-secret-at-least-thirty-two-characters'

let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
let users = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const createUser = async (role: 'user' | 'moderator' | 'admin' | 'owner' = 'user') => {
  const id = `p-${role}-${++users}`
  const now = Date.now()
  await db.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, id, role, now, now).run()
  await db.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)').bind(id).run()
  return { id, token: (await issueSession(db as never, id, secret, now, crypto)).token }
}

const call = (path: string, token = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  runtime.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(token ? { cookie: `__Host-session=${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Early body rejection can close workerd's HTTP connection after the response.
// Miniflare forces pooled connections, even when a Connection header is supplied.
// Give this rejected upload a real one-use socket; do not retry any operation.
async function anonymousSend(body: unknown): Promise<{ status: number; body: unknown }> {
  const url = new URL('/api/chat/messages', await runtime.ready)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('local_fixture_required')
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', agent: false, headers: {
      origin, 'MF-Original-URL': origin + url.pathname, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.end(data)
  })
}

type Frame = { type?: string; viewer?: { userId?: string; role?: string } | null }

const openSocket = async (token: string) => {
  const response = await runtime.dispatchFetch(`${origin}/api/chat/socket`, {
    headers: { origin, upgrade: 'websocket', ...(token ? { cookie: `__Host-session=${token}` } : {}) },
  })
  if (response.status !== 101) return { status: response.status, socket: null, frames: [] as Frame[] }
  const socket = response.webSocket! as unknown as WebSocket
  const frames: Frame[] = []
  socket.addEventListener('message', (event) => {
    if (event.data !== 'pong') frames.push(JSON.parse(String(event.data)))
  })
  ;(socket as unknown as { accept(): void }).accept()
  for (let wait = 0; wait < 100 && !frames.some((frame) => frame.type === 'snapshot'); wait++) await sleep(20)
  return { status: 101, socket, frames }
}

const history = async (token = '') =>
  (await (await call('/api/chat', token)).json()) as { messages: { id: string; content: string; userId?: string | null }[] }

/** A whole-database fingerprint, as in security-csrf-origin.spec.ts. */
const snapshot = async () => {
  const tables = await db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\'
    ORDER BY name
  `).all<{ name: string }>()
  const parts: string[] = []
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all()
    parts.push(`${name}:${JSON.stringify((rows.results as Record<string, unknown>[]).map((row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort())}`)
  }
  return parts.join('\n')
}

let messageCounter = 0
const messageText = fc.stringMatching(/^[a-z][a-z0-9 ]{0,60}[a-z0-9]$/u).map((value) => `${value} [${++messageCounter}]`)

beforeAll(async () => {
  const bundle = await build({ entryPoints: ['workers/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-12-01',
    durableObjects: { CHAT: { className: 'ChatRoom', useSQLite: true } },
    d1Databases: { DB: 'chat-preservation' },
    bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret },
  })
  db = await runtime.getD1Database('DB')
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.batch((await readFile(`migrations/${file}`, 'utf8')).split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)))
  }
})

afterAll(async () => {
  await runtime?.dispose()
})

describe('chat and session mutations keep their rules (requirements 3.1, 3.3)', () => {
  // Runs first, before any socket or message exists, so no alarm can touch D1 between snapshots.
  it('refuses every state-changing chat and session route from a foreign or missing Origin without changing any row', async () => {
    const member = await createUser('user')
    const owner = await createUser('owner')
    const routes: { method: string; path: string; actor: 'member' | 'owner'; body?: unknown; socket?: boolean }[] = [
      { method: 'POST', path: '/api/chat/messages', actor: 'member', body: { requestId: 'origin-probe', text: 'hello', type: 'text' } },
      { method: 'PATCH', path: '/api/chat/messages/origin-probe', actor: 'member', body: { text: 'edited' } },
      { method: 'DELETE', path: '/api/chat/messages/origin-probe', actor: 'member' },
      { method: 'POST', path: '/api/chat/blocks', actor: 'member', body: { userId: owner.id } },
      { method: 'DELETE', path: `/api/chat/blocks/${owner.id}`, actor: 'member' },
      { method: 'POST', path: '/api/chat/reports', actor: 'member', body: { messageId: 'origin-probe', reason: 'spam' } },
      { method: 'POST', path: '/api/chat/moderation', actor: 'owner', body: { action: 'settings', intervalMs: 2000 } },
      { method: 'PATCH', path: '/api/chat/moderation/retention-policy', actor: 'owner', body: {} },
      { method: 'POST', path: '/api/chat/moderation/retention', actor: 'owner', body: {} },
      { method: 'GET', path: '/api/chat/socket', actor: 'member', socket: true },
      { method: 'POST', path: '/api/logout', actor: 'member' },
      { method: 'POST', path: '/api/logout-all', actor: 'member' },
      { method: 'POST', path: '/api/auth/github/unlink', actor: 'member' },
      { method: 'POST', path: '/api/account/delete', actor: 'member', body: { confirmation: 'DELETE' } },
    ]
    const hostileOrigin = fc.oneof(
      fc.constantFrom<string | null>(null, '', 'null', 'https://evil.example', 'http://study.example', 'https://study.example:8443',
        'https://STUDY.example', 'https://study.example/', 'https://study.example.evil.example', 'https://study.example@evil.example'),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u).map((label) => `https://${label}.study.example`),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u).map((label) => `https://${label}.example`),
    )
    const before = await snapshot()
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...routes), hostileOrigin, async (route, foreign) => {
        const headers = new Headers({ accept: 'application/json', cookie: `__Host-session=${route.actor === 'owner' ? owner.token : member.token}` })
        if (foreign !== null) headers.set('origin', foreign)
        if (route.socket) headers.set('upgrade', 'websocket')
        if (route.body !== undefined) headers.set('content-type', 'application/json')
        const response = await runtime.dispatchFetch(`${origin}${route.path}`, {
          method: route.method,
          headers,
          ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
        })
        expect(response.status, `${route.method} ${route.path} Origin=${String(foreign)}`).toBe(403)
        expect(await response.json()).toEqual({ error: 'forbidden_origin' })
      }),
      { numRuns: 60, endOnFailure: true },
    )
    expect(await snapshot()).toBe(before)
  })

  it('commits a send once per requestId, returns the same message on retry, and enforces the send interval', async () => {
    await fc.assert(
      fc.asyncProperty(messageText, fc.integer({ min: 1, max: 3 }), async (text, retries) => {
        const author = await createUser()
        const body = { requestId: `send-${users}`, text, type: 'text' }
        const first = await call('/api/chat/messages', author.token, 'POST', body)
        expect(first.status).toBe(201)
        const sent = (await first.json()) as { message: { id: string; content: string; role: string } }
        expect(sent.message).toMatchObject({ content: text, role: 'user' })
        for (let retry = 0; retry < retries; retry++) {
          const again = await call('/api/chat/messages', author.token, 'POST', body)
          expect(again.status).toBeLessThan(300)
          expect(((await again.json()) as { message: { id: string } }).message.id).toBe(sent.message.id)
        }
        const throttled = await call('/api/chat/messages', author.token, 'POST', { ...body, requestId: `${body.requestId}-next` })
        expect(throttled.status).toBe(429)
        expect(await throttled.json()).toEqual({ error: 'rate_limited' })
        expect((await db.prepare('SELECT COUNT(*) AS total FROM chat_messages WHERE user_id = ?').bind(author.id).first<{ total: number }>())!.total).toBe(1)
        // Anonymous writes are refused; anonymous reads still see the message.
        const anonymous = await anonymousSend({ ...body, requestId: `${body.requestId}-anon` })
        expect(anonymous.status).toBe(401)
        expect(anonymous.body).toEqual({ error: 'authentication_required' })
        expect((await history()).messages.some((message) => message.id === sent.message.id)).toBe(true)
      }),
      { numRuns: 8, endOnFailure: true },
    )
  })

  it('lets only the author edit, keeps the original private, and serves only the edited text publicly', async () => {
    await fc.assert(
      fc.asyncProperty(messageText, messageText, fc.constantFrom<'user' | 'moderator' | 'owner'>('user', 'moderator', 'owner'), async (original, edited, otherRole) => {
        const author = await createUser()
        const other = await createUser(otherRole)
        const sent = (await (await call('/api/chat/messages', author.token, 'POST', { requestId: `edit-${users}`, text: original, type: 'text' })).json()) as { message: { id: string } }
        const foreign = await call(`/api/chat/messages/${sent.message.id}`, other.token, 'PATCH', { text: 'stolen edit' })
        expect(foreign.status).toBe(403)
        const own = await call(`/api/chat/messages/${sent.message.id}`, author.token, 'PATCH', { text: edited })
        expect(own.status).toBe(200)
        const publicView = JSON.stringify(await history())
        expect(publicView).toContain(edited)
        expect(publicView).not.toContain(original)
        expect(publicView).not.toContain('stolen edit')
        const versions = await db.prepare('SELECT original_content FROM chat_message_versions WHERE message_id = ?').bind(sent.message.id).all<{ original_content: string }>()
        expect(versions.results.map((row: { original_content: string }) => row.original_content)).toEqual([original])
      }),
      { numRuns: 6, endOnFailure: true },
    )
  })

  it('hides a blocked author from the blocker only, and shows them again after unblocking', async () => {
    await fc.assert(
      fc.asyncProperty(messageText, fc.boolean(), async (text, unblock) => {
        const author = await createUser()
        const blocker = await createUser()
        const bystander = await createUser()
        const sent = (await (await call('/api/chat/messages', author.token, 'POST', { requestId: `block-${users}`, text, type: 'text' })).json()) as { message: { id: string } }
        expect((await call('/api/chat/blocks', blocker.token, 'POST', { userId: author.id })).status).toBe(200)
        expect(await (await call('/api/chat/blocks', blocker.token)).json()).toEqual({ blockedUserIds: [author.id] })
        expect((await history(blocker.token)).messages.map((message) => message.id)).not.toContain(sent.message.id)
        expect((await history(bystander.token)).messages.map((message) => message.id)).toContain(sent.message.id)
        expect((await history()).messages.map((message) => message.id)).toContain(sent.message.id)
        if (unblock) {
          expect((await call(`/api/chat/blocks/${author.id}`, blocker.token, 'DELETE')).status).toBe(200)
          expect((await history(blocker.token)).messages.map((message) => message.id)).toContain(sent.message.id)
        }
      }),
      { numRuns: 6, endOnFailure: true },
    )
  })

  it('masks filtered words in every public view while moderators still see the original', async () => {
    const owner = await createUser('owner')
    const moderator = await createUser('moderator')
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z]{4,10}$/u), messageText, async (word, text) => {
        const pattern = `${word}q${users}`
        const filterId = `pf-${users}`
        const content = `${text} ${pattern}`
        const author = await createUser()
        const added = await call('/api/chat/moderation', owner.token, 'POST', { action: 'filter', filter: { id: filterId, kind: 'literal', pattern, replacement: '***', enabled: true } })
        expect(added.status).toBe(200)
        try {
          const sent = await call('/api/chat/messages', author.token, 'POST', { requestId: `mask-${users}`, text: content, type: 'text' })
          expect(sent.status).toBe(201)
          const message = ((await sent.json()) as { message: { id: string; content: string } }).message
          expect(message.content).not.toContain(pattern)
          expect(message.content).toContain('***')
          for (const viewer of ['', author.token, owner.token]) {
            const view = JSON.stringify(await history(viewer))
            expect(view).toContain(message.id)
            expect(view).not.toContain(pattern)
          }
          const detail = await call(`/api/chat/moderation/messages/${message.id}`, moderator.token)
          expect(detail.status).toBe(200)
          expect(JSON.stringify(await detail.json())).toContain(pattern)
          expect((await call(`/api/chat/moderation/messages/${message.id}`, author.token)).status).toBe(403)
        } finally {
          expect((await call('/api/chat/moderation', owner.token, 'POST', { action: 'remove_filter', filterId })).status).toBe(200)
        }
      }),
      { numRuns: 5, endOnFailure: true },
    )
  })

  it('admits at most 5 sockets per session and refuses the next with 429', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 7 }), async (attempts) => {
        const member = await createUser()
        const opened: { status: number; socket: WebSocket | null }[] = []
        try {
          for (let index = 0; index < attempts; index++) opened.push(await openSocket(member.token))
          expect(opened.map((entry) => entry.status)).toEqual(Array.from({ length: attempts }, (_, index) => index < 5 ? 101 : 429))
        } finally {
          for (const entry of opened) entry.socket?.close()
        }
        await sleep(100)
      }),
      { numRuns: 4, endOnFailure: true },
    )
  })

  it('drops the moderator view of a revoked, deleted or demoted moderator on HTTP and on the open socket', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('logout', 'logout-all', 'delete', 'demote'), async (revocation) => {
        const moderator = await createUser('moderator')
        expect((await call('/api/chat/moderation', moderator.token)).status).toBe(200)
        const live = await openSocket(moderator.token)
        expect(live.status).toBe(101)
        const snapshotFrame = live.frames.find((frame) => frame.type === 'snapshot')!
        expect(snapshotFrame.viewer).toEqual({ userId: moderator.id, role: 'moderator' })
        const mark = live.frames.length
        try {
          if (revocation === 'logout') expect((await call('/api/logout', moderator.token, 'POST')).status).toBe(204)
          if (revocation === 'logout-all') expect((await call('/api/logout-all', moderator.token, 'POST')).status).toBe(204)
          if (revocation === 'delete') expect((await call('/api/account/delete', moderator.token, 'POST', { confirmation: 'DELETE' })).status).toBe(204)
          if (revocation === 'demote') await db.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(moderator.id).run()

          // HTTP: checked inside the serial coordinator on every request.
          const moderation = await call('/api/chat/moderation', moderator.token)
          expect([401, 403], `${revocation}: moderation status`).toContain(moderation.status)
          // A fresh socket on the old cookie never gets the moderator viewer back.
          const fresh = await openSocket(moderator.token)
          if (fresh.socket) {
            const viewer = fresh.frames.find((frame) => frame.type === 'snapshot')?.viewer ?? null
            expect(viewer?.role ?? null).not.toBe('moderator')
            fresh.socket.close()
          }
          // The socket that was open: a revocation (not a plain role edit, which sends no
          // revalidation) tells it, by `reset` or by a non-privileged `viewer` delta.
          if (revocation !== 'demote') {
            const lostView = () => live.frames.slice(mark).some((frame) =>
              frame.type === 'reset' || (frame.type === 'viewer' && (frame.viewer ?? null)?.role !== 'moderator'))
            for (let wait = 0; wait < 150 && !lostView(); wait++) await sleep(20)
            expect(lostView(), `${revocation}: frames ${JSON.stringify(live.frames.slice(mark).map((frame) => frame.type))}`).toBe(true)
          }
          expect(live.frames.slice(mark).some((frame) => frame.type === 'viewer' && frame.viewer?.role === 'moderator')).toBe(false)
        } finally {
          live.socket?.close()
        }
      }),
      { numRuns: 6, endOnFailure: true },
    )
  })
})

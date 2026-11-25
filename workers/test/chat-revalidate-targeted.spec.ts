// Wave E exploration (task 17, H-02 / design Property 6). Encodes the expected behaviour, so it
// FAILS on the unfixed tree: one logout makes the Worker wait for the ChatRoom /revalidate call
// and the room broadcasts a reconnect-forcing `reset` to every connected socket.
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import { Miniflare } from './miniflare-compat'

const origin = 'https://study.example'
const secret = 'community-test-secret-at-least-thirty-two-characters'
// The ChatRoom below holds every /revalidate call this long before doing the real work, so a
// logout response that waits for the DO cannot return sooner than this.
const SLOW_REVALIDATE_MS = 2000
const USERS = 5
const SOCKETS_PER_USER = 2

let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import worker, { ChatRoom as ProductionChatRoom } from './workers/index'
export default worker
export class ChatRoom extends ProductionChatRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === '/revalidate') await new Promise((resolve) => setTimeout(resolve, ${SLOW_REVALIDATE_MS}))
    return super.fetch(request)
  }
}`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  })
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-12-01',
    durableObjects: { CHAT: { className: 'ChatRoom', useSQLite: true } },
    d1Databases: { DB: 'chat-revalidate-targeted' },
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('chat revocation is targeted and does not block logout (Property 6)', () => {
  it('after one logout, only that user\'s sockets change viewer; no other socket gets reset; logout does not wait for the DO', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: USERS - 1 }), async (loggedOut) => {
        run++
        const now = Date.now()
        const tokens: string[] = []
        for (let index = 0; index < USERS; index++) {
          const id = `r${run}-u${index}`
          await db.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .bind(id, id, 'user', now, now).run()
          tokens.push((await issueSession(db as never, id, secret, now, crypto)).token)
        }
        const sockets: { user: number; socket: WebSocket; events: { type?: string; viewer?: unknown }[] }[] = []
        for (let user = 0; user < USERS; user++) {
          for (let copy = 0; copy < SOCKETS_PER_USER; copy++) {
            const response = await runtime.dispatchFetch(`${origin}/api/chat/socket`, {
              headers: { origin, upgrade: 'websocket', cookie: `__Host-session=${tokens[user]}` },
            })
            expect(response.status).toBe(101)
            const socket = response.webSocket! as unknown as WebSocket
            const entry = { user, socket, events: [] as { type?: string; viewer?: unknown }[] }
            socket.addEventListener('message', (event) => {
              if (event.data !== 'pong') entry.events.push(JSON.parse(String(event.data)))
            })
            ;(socket as unknown as { accept(): void }).accept()
            sockets.push(entry)
          }
        }
        // Every socket has its initial snapshot before the logout under test.
        for (let wait = 0; wait < 100 && !sockets.every((entry) => entry.events.some((event) => event.type === 'snapshot')); wait++) await sleep(50)
        expect(sockets.every((entry) => entry.events.some((event) => event.type === 'snapshot'))).toBe(true)
        const mark = sockets.map((entry) => entry.events.length)

        const started = Date.now()
        const logout = await runtime.dispatchFetch(`${origin}/api/logout`, {
          method: 'POST',
          headers: { origin, cookie: `__Host-session=${tokens[loggedOut]}` },
        })
        const logoutMs = Date.now() - started
        expect(logout.status).toBe(204)
        // Leave the (slow) revalidation time to finish and deliver whatever it sends.
        await sleep(SLOW_REVALIDATE_MS + 2000)

        const after = sockets.map((entry, index) => ({ user: entry.user, events: entry.events.slice(mark[index]) }))
        const others = after.filter((entry) => entry.user !== loggedOut)
        const revoked = after.filter((entry) => entry.user === loggedOut)
        const summary = {
          logoutWaitedForDo: logoutMs >= SLOW_REVALIDATE_MS,
          otherSocketsReset: others.filter((entry) => entry.events.some((event) => event.type === 'reset')).length,
          revokedSocketsWithAnonymousViewer: revoked.filter((entry) =>
            entry.events.some((event) => event.type === 'viewer' && event.viewer === null)).length,
        }
        for (const entry of sockets) entry.socket.close()
        expect(summary, `logout took ${logoutMs} ms`).toEqual({
          logoutWaitedForDo: false,
          otherSocketsReset: 0,
          revokedSocketsWithAnonymousViewer: SOCKETS_PER_USER,
        })
      }),
      { numRuns: 2, endOnFailure: true },
    )
  })
})

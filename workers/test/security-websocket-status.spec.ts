import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import worker from '../index'

const ORIGIN = 'https://study.example'

const env = {
  DB: null,
  PUBLIC_ORIGIN: ORIGIN,
  SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
  OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-thirty-two-characters',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
}

describe('WebSocket security status', () => {
  it.each(['/api/community/chat', '/api/ws'])('does not upgrade an unsupported route %s', async (path) => {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      headers: { connection: 'Upgrade', origin: ORIGIN, upgrade: 'websocket' },
    }), env as never)

    expect(response.status).not.toBe(101)
    expect(response.status).toBe(404)
    expect((response as Response & { webSocket?: unknown }).webSocket).toBeUndefined()
  })

  it('fails closed when chat has no explicitly bound coordinator', async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/chat/socket`, {
      headers: { connection: 'Upgrade', origin: ORIGIN, upgrade: 'websocket' },
    }), env as never)
    expect(response.status).toBe(503)
    expect((response as Response & { webSocket?: unknown }).webSocket).toBeUndefined()
  })

  it('preserves site presence and adds chat through a separate SQLite namespace', async () => {
    const config = await readFile(resolve(process.cwd(), 'wrangler.toml'), 'utf8')
    expect(config).toContain('class_name = "OnlinePresence"')
    expect(config).toContain('class_name = "ChatRoom"')
    expect(config).toContain('new_sqlite_classes = ["ChatRoom"]')
    expect(config).toContain('tag = "presence-v1"')
  })
})

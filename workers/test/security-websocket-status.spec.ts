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
  it.each(['/api/chat', '/api/community/chat', '/api/ws'])('does not upgrade the deferred route %s', async (path) => {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      headers: { connection: 'Upgrade', origin: ORIGIN, upgrade: 'websocket' },
    }), env as never)

    expect(response.status).not.toBe(101)
    expect(response.status).toBe(404)
    expect((response as Response & { webSocket?: unknown }).webSocket).toBeUndefined()
  })

  it('binds only the own-site presence Durable Object, without enabling chat', async () => {
    const config = await readFile(resolve(process.cwd(), 'wrangler.toml'), 'utf8')
    expect(config).toContain('class_name = "OnlinePresence"')
    expect(config).not.toMatch(/class_name\s*=\s*".*chat/i)
  })
})

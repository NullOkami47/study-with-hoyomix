// H-04 (Wave E): the callback-time single-use claim (design H-04 step 1 and its rollout risk).
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { claimOAuthFlow, registerOAuthFlow } from '../auth/flow'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const NOW = 1_786_480_000_000
const LIFETIME = 10 * 60 * 1000
const SECRET = 'oauth-claim-state-secret'
const flow = (state: string, overrides: Partial<{ provider: 'github' | 'google' | 'linuxdo'; intent: 'login' | 'link'; createdAt: number }> = {}) => {
  const createdAt = overrides.createdAt ?? NOW
  return { state, provider: overrides.provider ?? 'github', intent: overrides.intent ?? 'login', createdAt, expiresAt: createdAt + LIFETIME }
}

let miniflare: Miniflare
let database: TestDatabase
const claim = (value: ReturnType<typeof flow>, at: number) => claimOAuthFlow(database as never, value, SECRET, at, crypto)
const rows = async () => (await database.prepare('SELECT provider, intent, created_at, expires_at, consumed_at FROM oauth_flows').all()).results

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `oauth-claim-${crypto.randomUUID()}` },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  database = await miniflare.getD1Database('DB')
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => database.prepare(statement)))
  }
})

afterAll(async () => {
  await miniflare?.dispose()
})

beforeEach(async () => {
  await database.prepare('DELETE FROM oauth_flows').run()
})

describe('claimOAuthFlow', () => {
  it('records a consumed row on first use and refuses every replay', async () => {
    expect(await claim(flow('first-use'), NOW + 1000)).toBe(true)
    expect(await rows()).toEqual([{ provider: 'github', intent: 'login', created_at: NOW, expires_at: NOW + LIFETIME, consumed_at: NOW + 1000 }])
    expect(await claim(flow('first-use'), NOW + 2000)).toBe(false)
    expect(await claim(flow('first-use', { provider: 'google' }), NOW + 2000)).toBe(false)
    expect((await rows())[0]).toMatchObject({ consumed_at: NOW + 1000 })
  })

  it('lets exactly one of two parallel claims win', async () => {
    const results = await Promise.all([claim(flow('parallel'), NOW + 1), claim(flow('parallel'), NOW + 1)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('accepts LINUX DO under the migrated provider constraint', async () => {
    expect(await claim(flow('linuxdo-state', { provider: 'linuxdo', intent: 'link' }), NOW + 1)).toBe(true)
  })

  it('refuses the expiry boundary and a creation time in the future without writing', async () => {
    expect(await claim(flow('boundary'), NOW + LIFETIME)).toBe(false)
    expect(await claim(flow('late'), NOW + LIFETIME + 1)).toBe(false)
    expect(await claim(flow('future', { createdAt: NOW + 5000 }), NOW)).toBe(false)
    expect(await rows()).toEqual([])
    expect(await claim(flow('just-in-time'), NOW + LIFETIME - 1)).toBe(true)
  })

  // Rollout: a login started on v73 left an unconsumed row; finishing it on the new version
  // consumes that row once, and a provider/intent mismatch never consumes it.
  it('consumes a start-time row from the previous version exactly once', async () => {
    await registerOAuthFlow(database as never, flow('v73-flow'), SECRET, crypto)
    expect(await claim(flow('v73-flow', { intent: 'link' }), NOW + 1000)).toBe(false)
    expect(await claim(flow('v73-flow', { provider: 'google' }), NOW + 1000)).toBe(false)
    expect(await claim(flow('v73-flow'), NOW + 1000)).toBe(true)
    expect(await claim(flow('v73-flow'), NOW + 2000)).toBe(false)
    expect(await rows()).toEqual([{ provider: 'github', intent: 'login', created_at: NOW, expires_at: NOW + LIFETIME, consumed_at: NOW + 1000 }])
  })
})

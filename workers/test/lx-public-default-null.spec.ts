import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGlobalLxSourceRepository } from '../../src/features/player/lx/globalSourceRepository'
import { createLxSourcesHandler } from '../admin/lxSources'
import { configuredDefaultSource } from '../lx/defaultSource'
import { sha256Hex } from '../lx/globalSources'
import { createLxPublicHandler } from '../lx/publicRoutes'

const NOW = 1_787_030_400_000
const OWNER_ID = 'user-lx-public-owner'
const PUBLIC_ORIGIN = 'https://study.example'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => database.prepare(statement)),
    )
  }
}

const CUSTOM_SCRIPT = `/**
 * @name Custom Community Source
 * @version 1.2.0
 */
const API = 'https://api.example.com/lx';
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => API);
`

describe('public global LX publication without a bundled default source', () => {
  let miniflare: Miniflare
  let database: TestDatabase

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `lx-public-null-${crypto.randomUUID()}` },
      d1Persist: false,
      resourceTmpPath: resolve(process.cwd(), '.wrangler/test-temp/lx-public-default-null'),
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    await database
      .prepare(
        `INSERT INTO users (id, display_name, role, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      )
      .bind(OWNER_ID, 'Public Owner', NOW, NOW)
      .run()
  })

  afterEach(async () => {
    try {
      await miniflare.dispose()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')) throw error
    }
  })

  it('omits managedSource when configuredDefaultSource() is null and loads Owner-published custom sources cleanly', async () => {
    expect(configuredDefaultSource()).toBeNull()

    const publicHandler = createLxPublicHandler({ DB: database })
    const emptyResponse = await publicHandler.fetch(new Request(`${PUBLIC_ORIGIN}/api/lx/sources`))
    expect(emptyResponse.status).toBe(200)
    const emptyPayload = (await emptyResponse.json()) as Record<string, unknown>
    expect(emptyPayload).toEqual({ revision: 1, sources: [] })
    expect('managedSource' in emptyPayload).toBe(false)

    const adminHandler = createLxSourcesHandler(
      { DB: database, PUBLIC_ORIGIN, LX_ALLOWED_ORIGINS: 'https://api.example.com' } as never,
      {
        now: () => NOW,
        requireOwner: async () => ({ id: OWNER_ID }),
      },
    )
    const createResponse = await adminHandler.fetch(
      new Request(`${PUBLIC_ORIGIN}/api/admin/lx/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: CUSTOM_SCRIPT }),
      }),
    )
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { source: { id: string; sha256: string } }
    expect(created.source.sha256).toBe(await sha256Hex(CUSTOM_SCRIPT))

    const populatedResponse = await publicHandler.fetch(new Request(`${PUBLIC_ORIGIN}/api/lx/sources`))
    expect(populatedResponse.status).toBe(200)
    const populatedPayload = (await populatedResponse.json()) as {
      revision: number
      sources: Array<{ id: string; sha256: string }>
      managedSource?: unknown
    }
    expect('managedSource' in populatedPayload).toBe(false)
    expect(populatedPayload.sources).toHaveLength(1)
    expect(populatedPayload.sources[0]?.id).toBe(created.source.id)

    const repo = createGlobalLxSourceRepository({
      baseUrl: `${PUBLIC_ORIGIN}/api/lx/sources`,
      selfOrigin: PUBLIC_ORIGIN,
      cspSources: {
        connect: ["'self'", 'https://api.example.com'],
        media: ["'self'"],
      },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        publicHandler.fetch(new Request(input, init))) as typeof fetch,
    })

    const records = await repo.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: `global:${created.source.id}`,
      name: 'Custom Community Source',
      version: '1.2.0',
      sha256: created.source.sha256,
      script: CUSTOM_SCRIPT,
    })
    expect(repo.managedSource?.()).toBeUndefined()
  })
})

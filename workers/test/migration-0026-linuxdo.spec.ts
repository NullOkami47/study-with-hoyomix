import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')

const applyMigrationsUpTo = async (database: TestDatabase, targetMigration: string) => {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()

  for (const name of names) {
    if (name > targetMigration) break
    const sql = await readFile(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')
    await database.batch(
      sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => database.prepare(s)),
    )
  }
}

const applySingleMigration = async (database: TestDatabase, migrationName: string) => {
  const sql = await readFile(resolve(MIGRATIONS_DIRECTORY, migrationName), 'utf8')
  await database.batch(
    sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => database.prepare(s)),
  )
}

describe('migration 0026: auth_provider_linuxdo data preservation and contract', () => {
  let miniflare: Miniflare
  let database: TestDatabase

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `migration-0026-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  it('preserves existing Owner, GitHub/Google identities, sessions, and OAuth flows across migration', async () => {
    // 1. Build schema up to 0025 (pre-linuxdo schema)
    await applyMigrationsUpTo(database, '0025_background_video_playback_cap.sql')

    const now = 1_786_480_000_000
    const validHash1 = `hmac-sha256:v1:${'a'.repeat(64)}`
    const validHash2 = `hmac-sha256:v1:${'b'.repeat(64)}`
    const validStateHash1 = `hmac-sha256:v1:${'c'.repeat(64)}`
    const validStateHash2 = `hmac-sha256:v1:${'d'.repeat(64)}`

    // 2. Insert representative production data:
    //    - existing GitHub Owner
    //    - normal GitHub user
    //    - Google identity on normal user
    //    - session rows
    //    - oauth_flows rows
    await database.batch([
      database.prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `).bind('owner-user', 'Owner User', 'owner', now, now),
      database.prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `).bind('normal-user', 'Normal User', 'user', now, now),

      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind('ident-owner-github', 'owner-user', 'github', '777', now, now + 100),
      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind('ident-normal-github', 'normal-user', 'github', '888', now, now + 200),
      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind('ident-normal-google', 'normal-user', 'google', 'google-sub-456', now, now + 300),

      database.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind('session-owner', 'owner-user', validHash1, now + 86400000, now, now),
      database.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind('session-normal', 'normal-user', validHash2, now + 86400000, now, now),

      database.prepare(`
        INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(validStateHash1, 'github', 'login', now, now + 600000, null),
      database.prepare(`
        INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(validStateHash2, 'google', 'link', now, now + 600000, now + 50000),
    ])

    // Pre-migration snapshot
    const preUsers = await database.prepare('SELECT * FROM users ORDER BY id').all()
    const preIdentities = await database.prepare('SELECT * FROM auth_identities ORDER BY id').all()
    const preSessions = await database.prepare('SELECT * FROM sessions ORDER BY id').all()
    const preFlows = await database.prepare('SELECT * FROM oauth_flows ORDER BY state_hash').all()

    // 3. Apply migration 0026
    await applySingleMigration(database, '0026_auth_provider_linuxdo.sql')

    // 4. Verify exact row preservation
    const postUsers = await database.prepare('SELECT * FROM users ORDER BY id').all()
    const postIdentities = await database.prepare('SELECT * FROM auth_identities ORDER BY id').all()
    const postSessions = await database.prepare('SELECT * FROM sessions ORDER BY id').all()
    const postFlows = await database.prepare('SELECT * FROM oauth_flows ORDER BY state_hash').all()

    expect(postUsers.results).toEqual(preUsers.results)
    expect(postIdentities.results).toEqual(preIdentities.results)
    expect(postSessions.results).toEqual(preSessions.results)
    expect(postFlows.results).toEqual(preFlows.results)

    // Check foreign key integrity
    const fkCheck = await database.prepare('PRAGMA foreign_key_check').all()
    expect(fkCheck.results).toEqual([])

    // 5. Prove linuxdo identities can now be inserted
    const linuxDoId = crypto.randomUUID()
    await database.prepare(`
      INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(linuxDoId, 'owner-user', 'linuxdo', 'linuxdo-sub-1001', now, now).run()

    const postLinuxDo = await database.prepare('SELECT * FROM auth_identities WHERE id = ?').bind(linuxDoId).first()
    expect(postLinuxDo).toMatchObject({
      id: linuxDoId,
      user_id: 'owner-user',
      provider: 'linuxdo',
      provider_subject: 'linuxdo-sub-1001',
    })

    // 6. Prove linuxdo oauth_flows can now be inserted
    const linuxDoStateHash = `hmac-sha256:v1:${'e'.repeat(64)}`
    await database.prepare(`
      INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(linuxDoStateHash, 'linuxdo', 'login', now, now + 600000, null).run()

    const postLinuxDoFlow = await database.prepare('SELECT * FROM oauth_flows WHERE state_hash = ?').bind(linuxDoStateHash).first()
    expect(postLinuxDoFlow).toMatchObject({
      state_hash: linuxDoStateHash,
      provider: 'linuxdo',
      intent: 'login',
    })

    // 7. Verify CHECK constraints still reject invalid providers
    await expect(
      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), 'owner-user', 'unsupported', 'sub-1', now, now).run(),
    ).rejects.toThrow()

    await expect(
      database.prepare(`
        INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(`hmac-sha256:v1:${'f'.repeat(64)}`, 'unsupported', 'login', now, now + 600000, null).run(),
    ).rejects.toThrow()

    // 8. Verify UNIQUE constraints
    // Cannot bind same linuxdo (provider, provider_subject) twice
    await expect(
      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), 'normal-user', 'linuxdo', 'linuxdo-sub-1001', now, now).run(),
    ).rejects.toThrow()

    // Cannot bind second linuxdo identity to owner-user (user_id, provider unique)
    await expect(
      database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), 'owner-user', 'linuxdo', 'linuxdo-sub-2002', now, now).run(),
    ).rejects.toThrow()
  })
})

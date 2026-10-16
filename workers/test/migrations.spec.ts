import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')
const REQUIRED_MIGRATIONS = [
  '0001_identity.sql',
  '0002_library.sql',
  '0003_chat.sql',
  '0004_reports_admin.sql',
  '0005_auth_flows.sql',
  '0006_account_deletion_events.sql',
  '0007_admin_settings.sql',
  '0008_admin_notices.sql',
  '0009_playback_provider_defaults.sql',
  '0010_audio_resolver_provider_defaults.sql',
  '0011_meting_provider_defaults.sql',
  '0012_focus_sessions.sql',
  '0013_background_media.sql',
  '0014_direct_audio_provider_policy.sql',
  '0015_lx_provider_defaults.sql',
  '0016_user_provider_preferences.sql',
  '0017_background_purge_recovery.sql',
  '0018_background_purge_atomic_finalisation.sql',
  '0019_background_purge_ownership.sql',
  '0020_catalogue_staging.sql',
  '0021_playback_provider_defaults_v2.sql',
  '0022_chksz_dynamic_discoveries.sql',
  '0023_background_video_duration_ms.sql',
  '0023_focus_classification_independent.sql',
  '0024_background_interval_choices.sql',
  '0025_background_video_playback_cap.sql',
  '0026_auth_provider_linuxdo.sql',
  '0027_background_metadata_and_overrides.sql',
  '0028_user_ui_preferences.sql',
]
const REQUIRED_TABLES = [
  'account_deletion_events',
  'admin_audit_log',
  'admin_notice_revisions',
  'admin_notices',
  'admin_settings',
  'auth_identities',
  'background_media',
  'background_media_revisions',
  'catalog_reports',
  'catalog_revisions',
  'catalogue_aliases',
  'catalogue_import_batches',
  'catalogue_import_changes',
  'catalogue_sources',
  'catalogue_state',
  'catalogue_track_games',
  'catalogue_track_relations',
  'catalogue_tracks',
  'chat_message_versions',
  'chat_messages',
  'chat_reports',
  'chksz_discovery_locks',
  'chksz_discovery_rate_events',
  'chksz_dynamic_discoveries',
  'favourites',
  'filter_rules',
  'focus_sessions',
  'library_sync_state',
  'listening_history',
  'moderation_actions',
  'oauth_flows',
  'playlist_tracks',
  'playlists',
  'provider_health',
  'sessions',
  'static_background_overrides',
  'user_background_selections',
  'user_blocks',
  'user_provider_preferences',
  'user_ui_preferences',
  'users',
]
const REQUIRED_EXPLICIT_INDEXES = [
  'idx_account_deletion_events_pending',
  'idx_admin_audit_log_created',
  'idx_admin_notice_revisions_notice',
  'idx_admin_notices_status_start',
  'idx_auth_identities_user',
  'idx_background_media_revisions_background',
  'idx_background_media_status_updated',
  'idx_catalog_reports_pending_unique',
  'idx_catalog_reports_reporter_status',
  'idx_catalog_reports_status_created',
  'idx_catalog_revisions_report',
  'idx_catalogue_import_batches_active_snapshot',
  'idx_catalogue_import_changes_batch_decision',
  'idx_catalogue_sources_track',
  'idx_chat_message_versions_message_created',
  'idx_chat_messages_retention',
  'idx_chat_messages_room_created',
  'idx_chat_reports_pending_unique',
  'idx_chat_reports_status_created',
  'idx_chksz_discovery_rate_events_created',
  'idx_chksz_dynamic_discoveries_status',
  'idx_favourites_user_created',
  'idx_filter_rules_enabled_kind',
  'idx_focus_sessions_user_ended',
  'idx_listening_history_user_played',
  'idx_moderation_actions_target_created',
  'idx_oauth_flows_expiry',
  'idx_playlist_tracks_playlist_position',
  'idx_playlists_gallery',
  'idx_playlists_user_updated',
  'idx_provider_health_priority',
  'idx_sessions_expiry',
  'idx_sessions_user_active',
  'idx_static_background_overrides_status',
  'idx_user_background_selections_updated',
  'idx_user_blocks_blocked',
  'idx_user_provider_preferences_updated',
]
const REQUIRED_FOREIGN_KEYS: Record<string, string[]> = {
  catalogue_tracks: [],
  catalogue_track_games: ['catalogue_tracks'],
  catalogue_track_relations: ['catalogue_tracks'],
  catalogue_sources: ['catalogue_tracks'],
  catalogue_aliases: ['catalogue_tracks'],
  catalogue_import_batches: ['users', 'users'],
  catalogue_import_changes: ['catalogue_import_batches'],
  catalogue_state: [],
  chksz_discovery_locks: [],
  chksz_discovery_rate_events: [],
  chksz_dynamic_discoveries: [],
  admin_audit_log: ['users'],
  admin_notice_revisions: ['admin_notices', 'users'],
  admin_notices: ['users'],
  admin_settings: ['users'],
  auth_identities: ['users'],
  background_media: ['background_media_revisions', 'users'],
  background_media_revisions: ['background_media', 'users'],
  catalog_reports: ['users', 'users'],
  catalog_revisions: ['catalog_reports', 'users', 'users'],
  chat_message_versions: ['chat_messages', 'users'],
  chat_messages: ['users'],
  chat_reports: ['chat_messages', 'users', 'users'],
  favourites: ['users'],
  filter_rules: ['users', 'users'],
  focus_sessions: ['users'],
  listening_history: ['users'],
  library_sync_state: ['users'],
  moderation_actions: ['chat_messages', 'users', 'users'],
  playlist_tracks: ['playlists'],
  playlists: ['users', 'users'],
  sessions: ['users'],
  static_background_overrides: ['users'],
  user_blocks: ['users', 'users'],
  user_background_selections: ['users'],
  user_provider_preferences: ['users'],
  user_ui_preferences: ['users'],
}

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

interface SchemaRow {
  name: string
}

interface TableInfoRow {
  name: string
  type: string
}

interface IndexListRow {
  name: string
  origin: string
}

interface ForeignKeyRow {
  table: string
}

interface TableListRow {
  name: string
  strict: number
}

interface ProviderDefaultRow {
  providerKey: string
  enabled: number
  priority: number
}

const listMigrationFiles = async () => {
  try {
    return (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort()
  } catch {
    return []
  }
}

const applyPendingMigrations = async (database: TestDatabase, names: string[]) => {
  await database
    .prepare(`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      )
    `)
    .run()

  for (const name of names) {
    const applied = await database
      .prepare('SELECT name FROM d1_migrations WHERE name = ?')
      .bind(name)
      .first<{ name: string }>()

    if (applied) continue

    const sql = await readFile(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => database.prepare(statement))
    await database.batch([
      ...statements,
      database
        .prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)')
        .bind(name, Date.now()),
    ])
  }
}

const expectD1ConstraintFailure = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toThrow()
}

describe('D1 migrations', () => {
  const miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'study-with-hoyomix-test' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })

  let database: TestDatabase

  beforeAll(async () => {
    const migrationFiles = await listMigrationFiles()
    expect(migrationFiles).toEqual(REQUIRED_MIGRATIONS)

    database = await miniflare.getD1Database('DB')
    await applyPendingMigrations(database, migrationFiles)
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  it('applies every migration to an empty D1 database exactly once', async () => {
    const migrations = await database
      .prepare('SELECT name FROM d1_migrations ORDER BY name')
      .all<SchemaRow>()
    expect(migrations.results.map(({ name }: SchemaRow) => name)).toEqual(REQUIRED_MIGRATIONS)

    const tables = await database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
          AND name != 'd1_migrations'
        ORDER BY name
      `)
      .all<SchemaRow>()
    expect(tables.results.map(({ name }: SchemaRow) => name)).toEqual(REQUIRED_TABLES)

    const tableModes = await database.prepare('PRAGMA table_list').all<TableListRow>()
    const strictApplicationTables = tableModes.results
      .filter(({ name }: TableListRow) => REQUIRED_TABLES.includes(name))
      .filter(({ strict }: TableListRow) => strict === 1)
      .map(({ name }: TableListRow) => name)
      .sort()
    expect(strictApplicationTables).toEqual(REQUIRED_TABLES)

    const providerDefaults = await database
      .prepare('SELECT provider_key AS providerKey, enabled, priority FROM provider_health ORDER BY priority, provider_key')
      .all<ProviderDefaultRow>()
    // 0021 normalizes the seeded rows onto the simplified three-provider model: `chksz` moves from
    // the legacy `(enabled 0, priority 11)` to `(1, 10)`, and `lx`/`jellyfin` gain explicit rows at
    // 20 and 30. Without it a migrated database never reaches the advertised default order, because
    // `readProviderStates` prefers a persisted row over the declared default.
    expect(providerDefaults.results.map(({ providerKey, enabled, priority }: ProviderDefaultRow) => [providerKey, enabled, priority]))
      .toEqual([
        ['r2', 0, 1],
        ['meting', 0, 2],
        ['lx-huibq', 0, 3],
        ['qijie', 0, 3],
        ['lx-ikun', 0, 4],
        ['meting-agent', 0, 4],
        ['gd-studio', 0, 5],
        ['lx-juhe', 0, 5],
        ['lx-qdy', 0, 6],
        ['public-meting', 0, 6],
        ['lx-flower', 0, 7],
        ['lx-lx', 0, 8],
        ['lx-grass', 0, 9],
        ['chksz', 1, 10],
        ['lx-sixyin', 0, 10],
        ['piped', 0, 12],
        ['invidious', 0, 13],
        ['lx', 1, 20],
        ['jellyfin', 1, 30],
        ['youtube', 0, 90],
      ])
  })

  it('treats reapplying already-applied migrations as a no-op', async () => {
    const appliedBefore = (
      await database
        .prepare('SELECT name, applied_at AS appliedAt FROM d1_migrations ORDER BY name')
        .all()
    ).results
    const tablesBefore = (
      await database
        .prepare(`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '_cf_%'
          ORDER BY name
        `)
        .all()
    ).results

    await applyPendingMigrations(database, REQUIRED_MIGRATIONS)

    expect(
      (
        await database
          .prepare('SELECT name, applied_at AS appliedAt FROM d1_migrations ORDER BY name')
          .all()
      ).results,
    ).toEqual(appliedBefore)
    expect(
      (
        await database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE '_cf_%'
            ORDER BY name
          `)
          .all()
      ).results,
    ).toEqual(tablesBefore)
  })

  it('applies 0014 and LX defaults without overwriting a persisted Admin override', async () => {
    const isolatedMiniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'lx-provider-default-preservation-test' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })

    try {
      const isolatedDatabase = await isolatedMiniflare.getD1Database('DB')
      const through0013 = REQUIRED_MIGRATIONS.filter((name) => name <= '0013_background_media.sql')
      await applyPendingMigrations(isolatedDatabase, through0013)
      await isolatedDatabase.prepare(`
        UPDATE provider_health
        SET enabled = 1, priority = 77, updated_at = 123
        WHERE provider_key = 'r2'
      `).run()

      await applyPendingMigrations(isolatedDatabase, [
        '0014_direct_audio_provider_policy.sql',
        '0015_lx_provider_defaults.sql',
      ])

      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority, updated_at AS updatedAt
        FROM provider_health WHERE provider_key = 'r2'
      `).first()).toEqual({ enabled: 1, priority: 77, updatedAt: 123 })
      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority FROM provider_health WHERE provider_key = 'chksz'
      `).first()).toEqual({ enabled: 0, priority: 11 })
      expect((await isolatedDatabase.prepare(`
        SELECT provider_key AS providerKey, enabled, priority
        FROM provider_health WHERE provider_key LIKE 'lx-%'
        ORDER BY priority
      `).all()).results).toEqual([
        { providerKey: 'lx-huibq', enabled: 0, priority: 3 },
        { providerKey: 'lx-ikun', enabled: 0, priority: 4 },
        { providerKey: 'lx-juhe', enabled: 0, priority: 5 },
        { providerKey: 'lx-qdy', enabled: 0, priority: 6 },
        { providerKey: 'lx-flower', enabled: 0, priority: 7 },
        { providerKey: 'lx-lx', enabled: 0, priority: 8 },
        { providerKey: 'lx-grass', enabled: 0, priority: 9 },
        { providerKey: 'lx-sixyin', enabled: 0, priority: 10 },
      ])
    } finally {
      await isolatedMiniflare.dispose()
    }
  })

  it('preserves an existing Admin provider choice when playback defaults are migrated', async () => {
    const isolatedMiniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'provider-default-preservation-test' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })

    try {
      const isolatedDatabase = await isolatedMiniflare.getD1Database('DB')
      const priorMigrations = REQUIRED_MIGRATIONS.filter((name) => name < '0009_playback_provider_defaults.sql')
      await applyPendingMigrations(isolatedDatabase, priorMigrations)
      await isolatedDatabase.prepare(`
        INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
        VALUES ('youtube', 0, 77, 'unknown', 0)
      `).run()
      await applyPendingMigrations(isolatedDatabase, ['0009_playback_provider_defaults.sql'])

      expect(await isolatedDatabase
        .prepare('SELECT enabled, priority FROM provider_health WHERE provider_key = ?')
        .bind('youtube')
        .first<{ enabled: number; priority: number }>()
      ).toEqual({ enabled: 0, priority: 77 })
    } finally {
      await isolatedMiniflare.dispose()
    }
  })

  it('adds audio resolvers without changing existing provider choices', async () => {
    const isolatedMiniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'audio-resolver-default-preservation-test' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })

    try {
      const isolatedDatabase = await isolatedMiniflare.getD1Database('DB')
      const priorMigrations = REQUIRED_MIGRATIONS.filter(
        (name) => name < '0010_audio_resolver_provider_defaults.sql',
      )
      await applyPendingMigrations(isolatedDatabase, priorMigrations)
      await isolatedDatabase.prepare(`
        UPDATE provider_health SET enabled = 1, priority = 77 WHERE provider_key = 'r2'
      `).run()
      await isolatedDatabase.prepare(`
        INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
        VALUES ('piped', 1, 88, 'healthy', 123)
      `).run()
      await isolatedDatabase.prepare(`
        INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
        VALUES ('invidious', 1, 89, 'degraded', 124)
      `).run()

      await applyPendingMigrations(isolatedDatabase, ['0010_audio_resolver_provider_defaults.sql'])

      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority FROM provider_health WHERE provider_key = 'r2'
      `).first()).toEqual({ enabled: 1, priority: 77 })
      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority, status, updated_at FROM provider_health WHERE provider_key = 'piped'
      `).first()).toEqual({ enabled: 1, priority: 88, status: 'healthy', updated_at: 123 })
      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority, status, updated_at FROM provider_health WHERE provider_key = 'invidious'
      `).first()).toEqual({ enabled: 1, priority: 89, status: 'degraded', updated_at: 124 })
    } finally {
      await isolatedMiniflare.dispose()
    }
  })

  it('adds inert canonical Meting defaults without mutating legacy Meting rows', async () => {
    const isolatedMiniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'meting-default-preservation-test' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })

    try {
      const isolatedDatabase = await isolatedMiniflare.getD1Database('DB')
      const priorMigrations = REQUIRED_MIGRATIONS.filter(
        (name) => name < '0011_meting_provider_defaults.sql',
      )
      await applyPendingMigrations(isolatedDatabase, priorMigrations)
      await isolatedDatabase.prepare(`
        UPDATE provider_health SET enabled = 1, priority = 66 WHERE provider_key = 'public-meting'
      `).run()
      await isolatedDatabase.prepare(`
        UPDATE provider_health SET enabled = 1, priority = 67 WHERE provider_key = 'meting-agent'
      `).run()

      await applyPendingMigrations(isolatedDatabase, ['0011_meting_provider_defaults.sql'])

      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority FROM provider_health WHERE provider_key = 'meting'
      `).first()).toEqual({ enabled: 0, priority: 9 })
      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority FROM provider_health WHERE provider_key = 'public-meting'
      `).first()).toEqual({ enabled: 1, priority: 66 })
      expect(await isolatedDatabase.prepare(`
        SELECT enabled, priority FROM provider_health WHERE provider_key = 'meting-agent'
      `).first()).toEqual({ enabled: 1, priority: 67 })
    } finally {
      await isolatedMiniflare.dispose()
    }
  })

  it('enforces identity, session, playlist, and ownership constraints in D1', async () => {
    const now = 1_786_480_000_000
    await database
      .prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('user-a', 'A', 'user', 0, now, now)
      .run()
    await database
      .prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('user-b', 'B', 'user', 0, now, now)
      .run()

    await database
      .prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind('identity-a', 'user-a', 'github', '12345', now)
      .run()
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind('identity-b', 'user-b', 'github', '12345', now)
        .run(),
    )

    await database
      .prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('session-a', 'user-a', `hmac-sha256:v1:${'a'.repeat(64)}`, now + 1_000, now, now)
      .run()
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('session-b', 'user-b', `hmac-sha256:v1:${'a'.repeat(64)}`, now + 1_000, now, now)
        .run(),
    )

    await database
      .prepare(`
        INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('playlist-a', 'user-a', 'Focus', 'private', now, now)
      .run()
    await database
      .prepare(`
        INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
      `)
      .bind('playlist-a', 'track-a', 0, now)
      .run()
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
          VALUES (?, ?, ?, ?)
        `)
        .bind('playlist-a', 'track-b', 0, now)
        .run(),
    )
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO favourites (user_id, track_id, created_at)
          VALUES (?, ?, ?)
        `)
        .bind('missing-user', 'track-a', now)
        .run(),
    )
  })

  it.each([
    ['null', null],
    ['empty', ''],
  ])('rejects a %s row identifier', async (_label, id) => {
    const now = 1_786_480_100_000
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(id, 'Invalid', 'user', 0, now, now)
        .run(),
    )
  })

  it.each([
    ['text', 'not-a-timestamp'],
    ['real', 1.5],
  ])('rejects a %s UTC timestamp', async (_label, createdAt) => {
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(`invalid-time-${String(createdAt)}`, 'Invalid', 'user', 0, createdAt, 1_786_480_100_000)
        .run(),
    )
  })

  it.each([
    ['raw token', 'this-is-a-raw-session-token-secret-123456'],
    ['unkeyed hash label', `sha256:${'a'.repeat(64)}`],
    ['missing version', `hmac-sha256:${'a'.repeat(64)}`],
    ['malformed length', `hmac-sha256:v1:${'a'.repeat(63)}`],
    ['non-lowercase-hex digest', `hmac-sha256:v1:${'G'.repeat(64)}`],
  ])('rejects a session %s representation', async (label, tokenHash) => {
    const now = 1_786_480_100_000
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(`invalid-session-${label}`, 'user-a', tokenHash, now + 1_000, now, now)
        .run(),
    )
  })

  it('stores only JSON-object settings and durable chat reports', async () => {
    const columns = await database.prepare('PRAGMA table_info(users)').all<TableInfoRow>()
    expect(columns.results.map(({ name }: TableInfoRow) => name)).toContain('settings_json')
    expect(
      await database.prepare('SELECT settings_json FROM users WHERE id = ?').bind('user-a').first('settings_json'),
    ).toBe('{}')

    await database
      .prepare('UPDATE users SET settings_json = ? WHERE id = ?')
      .bind('{"locale":"zh-Hant"}', 'user-a')
      .run()
    await expectD1ConstraintFailure(
      database.prepare('UPDATE users SET settings_json = ? WHERE id = ?').bind('[]', 'user-a').run(),
    )

    const now = 1_786_480_100_000
    await database
      .prepare(`
        INSERT INTO chat_messages (
          id, room_id, user_id, author_display_name, content, message_type, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind('message-for-report', 'global', 'user-b', 'B', 'report me', 'text', now, now + 1_000)
      .run()
    await database
      .prepare(`
        INSERT INTO chat_reports (id, reporter_user_id, message_id, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('chat-report-a', 'user-a', 'message-for-report', 'spam', 'pending', now)
      .run()
    await expectD1ConstraintFailure(
      database
        .prepare(`
          INSERT INTO chat_reports (id, reporter_user_id, message_id, reason, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('chat-report-b', 'user-a', 'message-for-report', 'duplicate', 'pending', now + 1)
        .run(),
    )
  })

  it('rejects duplicate pending catalogue reports in D1', async () => {
    const now = 1_786_480_100_000
    const insert = (id: string) => database
      .prepare(`
        INSERT INTO catalog_reports (
          id, reporter_user_id, canonical_track_id, kind,
          current_value_json, proposed_value_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(id, 'user-a', 'track-a', 'metadata', '{}', '{}', 'pending', now, now)
      .run()

    await insert('catalog-report-a')
    await expectD1ConstraintFailure(insert('catalog-report-b'))
  })

  it('enforces background revision, lifecycle, key, and selection bounds in D1', async () => {
    const now = 1_786_480_100_000
    await database.prepare(`
      INSERT INTO background_media (
        id, status, current_revision_id, created_by, created_at, updated_at
      ) VALUES (?, 'draft', NULL, ?, ?, ?)
    `).bind('background-a', 'user-a', now, now).run()
    await database.prepare(`
      INSERT INTO background_media_revisions (
        id, background_id, revision_number, kind, object_key, poster_object_key,
        content_type, byte_size, width, height, duration_ms, provenance_json,
        created_by, created_at
      ) VALUES (?, ?, 1, 'image', ?, NULL, 'image/png', 100, 1920, 1080, NULL, '{}', ?, ?)
    `).bind(
      'background-revision-a',
      'background-a',
      'backgrounds/11111111-1111-4111-8111-111111111111/revisions/22222222-2222-4222-8222-222222222222.png',
      'user-a',
      now,
    ).run()
    await database.prepare(`
      UPDATE background_media SET current_revision_id = ? WHERE id = ?
    `).bind('background-revision-a', 'background-a').run()

    await expectD1ConstraintFailure(database.prepare(`
      INSERT INTO background_media_revisions (
        id, background_id, revision_number, kind, object_key, poster_object_key,
        content_type, byte_size, width, height, duration_ms, provenance_json,
        created_by, created_at
      ) VALUES (?, ?, 2, 'image', ?, NULL, 'image/png', 100, 1920, 1080, NULL, '{}', ?, ?)
    `).bind(
      'background-revision-unsafe',
      'background-a',
      'tracks/authorized/not-a-background.mp3',
      'user-a',
      now,
    ).run())

    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET status = 'published', published_at = NULL WHERE id = ?
    `).bind('background-a').run())

    await expectD1ConstraintFailure(database.prepare(`
      INSERT INTO user_background_selections (
        user_id, selection_json, auto_rotate, interval_seconds, updated_at
      ) VALUES (?, ?, 1, 30, ?)
    `).bind('user-a', JSON.stringify(Array.from({ length: 9 }, (_, index) => `background-${index}`)), now).run())
  })

  it('stores the four minute-long rotation intervals, keeps older values, and defaults to twenty minutes', async () => {
    const now = 1_786_480_100_000
    const createUser = (userId: string) =>
      database.prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, 'user', 0, ?, ?)
      `).bind(userId, userId, now, now).run()
    const insert = (userId: string, intervalSeconds: number) =>
      database.prepare(`
        INSERT INTO user_background_selections (
          user_id, selection_json, auto_rotate, interval_seconds, updated_at
        ) VALUES (?, ?, 1, ?, ?)
      `).bind(userId, JSON.stringify(['background-a']), intervalSeconds, now).run()

    const storable = [600, 1_200, 1_800, 3_600, 15, 30, 60, 300]
    for (const intervalSeconds of storable) {
      const userId = `user-interval-${intervalSeconds}`
      await createUser(userId)
      await insert(userId, intervalSeconds)
    }
    // Anything outside the union is still rejected.
    for (const intervalSeconds of [45, 700]) {
      const userId = `user-interval-${intervalSeconds}`
      await createUser(userId)
      await expectD1ConstraintFailure(insert(userId, intervalSeconds))
    }

    // Omitting the column must land on the twenty-minute first-use default.
    await createUser('user-interval-default')
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, updated_at)
      VALUES (?, ?, ?)
    `).bind('user-interval-default', JSON.stringify(['background-a']), now).run()
    expect(
      (await database.prepare(`
        SELECT interval_seconds AS intervalSeconds FROM user_background_selections WHERE user_id = ?
      `).bind('user-interval-default').first<{ intervalSeconds: number }>())?.intervalSeconds,
    ).toBe(1_200)
  })

  it('accepts capped background clip durations up to two minutes and no further', async () => {
    const now = 1_786_480_100_000
    await database.prepare(`
      INSERT INTO background_media (
        id, status, current_revision_id, created_by, created_at, updated_at
      ) VALUES ('background-native', 'draft', NULL, NULL, ?, ?)
    `).bind(now, now).run()

    const insertClip = (revisionId: string, revisionNumber: number, durationMs: number | null) =>
      database.prepare(`
        INSERT INTO background_media_revisions (
          id, background_id, revision_number, kind, object_key, poster_object_key,
          content_type, byte_size, width, height, duration_ms, fps, provenance_json,
          created_by, created_at
        ) VALUES (?, 'background-native', ?, 'video', ?, NULL, 'video/mp4', 10485760, 2560, 1440, ?, 30, '{}', NULL, ?)
      `).bind(
        revisionId,
        revisionNumber,
        `backgrounds/55555555-5555-4555-8555-555555555555/revisions/${revisionId}.mp4`,
        durationMs,
        now,
      ).run()

    // The longest shipped clip is 36.3s; the former 30s bound rejected it.
    await insertClip('66666666-6666-4666-8666-666666666666', 1, 36_300)
    await insertClip('77777777-7777-4777-8777-777777777777', 2, 120_000)
    await expectD1ConstraintFailure(database.prepare("UPDATE background_media_revisions SET width = 3840 WHERE background_id = 'background-native'").run())
    await expectD1ConstraintFailure(database.prepare("UPDATE background_media_revisions SET fps = 60 WHERE background_id = 'background-native'").run())
    await expectD1ConstraintFailure(database.prepare("UPDATE background_media_revisions SET fps = NULL WHERE background_id = 'background-native'").run())
    await expectD1ConstraintFailure(insertClip('88888888-8888-4888-8888-888888888888', 3, 120_001))
    // Images keep carrying no duration at all.
    await expectD1ConstraintFailure(database.prepare(`
      INSERT INTO background_media_revisions (
        id, background_id, revision_number, kind, object_key, poster_object_key,
        content_type, byte_size, width, height, duration_ms, provenance_json,
        created_by, created_at
      ) VALUES ('99999999-9999-4999-8999-999999999999', 'background-native', 4, 'image', ?, NULL, 'image/png', 100, 1920, 1080, 1000, '{}', NULL, ?)
    `).bind(
      'backgrounds/aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revisions/bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png',
      now,
    ).run())
  })

  it('enforces metadata constraints on background_media and static_background_overrides', async () => {
    const now = 1_786_480_100_000

    // 1. Verify valid metadata update on background_media
    await database.prepare(`
      INSERT INTO background_media (
        id, status, current_revision_id, title, game, collection, display_order, created_by, created_at, updated_at
      ) VALUES ('bg-meta-valid', 'draft', NULL, 'Sixth Street', 'ZZZ', 'Urban Stroll', 1, 'user-a', ?, ?)
    `).bind(now, now).run()

    // 2. Reject empty or whitespace-only title
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET title = '' WHERE id = 'bg-meta-valid'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET title = '   ' WHERE id = 'bg-meta-valid'
    `).run())

    // 3. Reject title exceeding 120 characters
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET title = ? WHERE id = 'bg-meta-valid'
    `).bind('x'.repeat(121)).run())

    // 4. Reject empty, whitespace-only, or overly long game / collection
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET game = '' WHERE id = 'bg-meta-valid'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET game = '   ' WHERE id = 'bg-meta-valid'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET game = ? WHERE id = 'bg-meta-valid'
    `).bind('x'.repeat(65)).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET collection = '' WHERE id = 'bg-meta-valid'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET collection = '   ' WHERE id = 'bg-meta-valid'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET collection = ? WHERE id = 'bg-meta-valid'
    `).bind('x'.repeat(65)).run())

    // 5. Reject negative or non-integer display_order
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE background_media SET display_order = -1 WHERE id = 'bg-meta-valid'
    `).run())

    // 6. Verify valid static_background_overrides insertion
    await database.prepare(`
      INSERT INTO static_background_overrides (
        id, status, title, game, collection, display_order, updated_by, updated_at
      ) VALUES ('zzz-street', 'published', 'Sixth Street', 'ZZZ', 'Urban Stroll', 0, 'user-a', ?)
    `).bind(now).run()

    // 7. Verify default status is 'published'
    await database.prepare(`
      INSERT INTO static_background_overrides (id, updated_at)
      VALUES ('zzz-lumina', ?)
    `).bind(now).run()
    const lumina = await database.prepare(`
      SELECT status FROM static_background_overrides WHERE id = 'zzz-lumina'
    `).first<{ status: string }>()
    expect(lumina?.status).toBe('published')

    // 8. Reject invalid status (e.g. 'draft', 'deleted')
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE static_background_overrides SET status = 'draft' WHERE id = 'zzz-lumina'
    `).run())
    await expectD1ConstraintFailure(database.prepare(`
      UPDATE static_background_overrides SET status = 'deleted' WHERE id = 'zzz-lumina'
    `).run())

    // 9. Reject invalid ID length (> 64 or empty)
    await expectD1ConstraintFailure(database.prepare(`
      INSERT INTO static_background_overrides (id, updated_at) VALUES ('', ?)
    `).bind(now).run())
    await expectD1ConstraintFailure(database.prepare(`
      INSERT INTO static_background_overrides (id, updated_at) VALUES (?, ?)
    `).bind('x'.repeat(65), now).run())

    // 10. Verify ON DELETE SET NULL on updated_by
    await database.prepare(`
      INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
      VALUES ('user-temp-override', 'Temp', 'admin', 0, ?, ?)
    `).bind(now, now).run()
    await database.prepare(`
      INSERT INTO static_background_overrides (id, updated_by, updated_at)
      VALUES ('zzz-temp', 'user-temp-override', ?)
    `).bind(now).run()
    await database.prepare('DELETE FROM users WHERE id = ?').bind('user-temp-override').run()
    const override = await database.prepare(`
      SELECT updated_by AS updatedBy FROM static_background_overrides WHERE id = 'zzz-temp'
    `).first<{ updatedBy: string | null }>()
    expect(override?.updatedBy).toBeNull()
  })

  it('enforces CASCADE, SET NULL, and RESTRICT actions through D1 writes', async () => {
    const now = 1_786_480_100_000
    await database
      .prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind('fk-user', 'FK', 'user', 0, now, now)
      .run()
    await database.prepare('INSERT INTO favourites VALUES (?, ?, ?)').bind('fk-user', 'fk-track', now).run()
    await database
      .prepare(`
        INSERT INTO catalog_reports (
          id, reporter_user_id, canonical_track_id, kind,
          current_value_json, proposed_value_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind('fk-report', 'fk-user', 'fk-track', 'metadata', '{}', '{}', 'accepted', now, now)
      .run()
    await database
      .prepare(`
        INSERT INTO catalog_revisions (
          id, report_id, reviewer_user_id, canonical_track_id, before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind('fk-revision', 'fk-report', 'fk-user', 'fk-track', '{}', '{}', now)
      .run()

    await expectD1ConstraintFailure(
      database.prepare('DELETE FROM catalog_reports WHERE id = ?').bind('fk-report').run(),
    )
    await database.prepare('DELETE FROM users WHERE id = ?').bind('fk-user').run()

    expect(await database.prepare('SELECT user_id FROM favourites WHERE track_id = ?').bind('fk-track').first()).toBeNull()
    expect(
      (await database.prepare('SELECT reporter_user_id FROM catalog_reports WHERE id = ?').bind('fk-report').first<{ reporter_user_id: string | null }>())?.reporter_user_id,
    ).toBeNull()
    expect(
      (await database.prepare('SELECT reviewer_user_id FROM catalog_revisions WHERE id = ?').bind('fk-revision').first<{ reviewer_user_id: string | null }>())?.reviewer_user_id,
    ).toBeNull()
  })

  it('uses integer UTC timestamps, explicit query indexes, and token hashes only', async () => {
    for (const table of REQUIRED_TABLES) {
      const columns = await database.prepare(`PRAGMA table_info(${table})`).all<TableInfoRow>()
      const timestampColumns = columns.results.filter(({ name }: TableInfoRow) => name.endsWith('_at'))

      for (const column of timestampColumns) {
        expect(column.type, `${table}.${column.name}`).toBe('INTEGER')
      }
    }

    const sessionColumns = await database.prepare('PRAGMA table_info(sessions)').all<TableInfoRow>()
    const sessionColumnNames = sessionColumns.results.map(({ name }: TableInfoRow) => name)
    expect(sessionColumnNames).toContain('token_hash')
    expect(sessionColumnNames).not.toContain('token')
    expect(sessionColumnNames).not.toContain('access_token')
    expect(sessionColumnNames).not.toContain('refresh_token')

    const indexes = await database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY name
      `)
      .all<SchemaRow>()
    expect(indexes.results.map(({ name }: SchemaRow) => name)).toEqual(REQUIRED_EXPLICIT_INDEXES)

    const identityIndexes = await database
      .prepare('PRAGMA index_list(auth_identities)')
      .all<IndexListRow>()
    expect(identityIndexes.results.filter(({ origin }: IndexListRow) => origin === 'u')).toHaveLength(2)

    for (const [table, expectedTargets] of Object.entries(REQUIRED_FOREIGN_KEYS)) {
      const foreignKeys = await database
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all<ForeignKeyRow>()
      expect(
        foreignKeys.results.map(({ table: target }: ForeignKeyRow) => target).sort(),
        table,
      ).toEqual([...expectedTargets].sort())
    }
  })
})

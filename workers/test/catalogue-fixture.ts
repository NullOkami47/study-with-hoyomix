import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import seed from './catalogue-seed.json'

export async function catalogueDatabase(beforeMigration?: string) {
  const runtime = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'catalogue-' + crypto.randomUUID() },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  try {
    const db = await runtime.getD1Database('DB')
    for (const name of (await readdir(resolve('migrations')))
      .filter((n) => n.endsWith('.sql') && (!beforeMigration || n < beforeMigration))
      .sort()) {
      const sql = await readFile(resolve('migrations', name), 'utf8')
      await db.batch(
        sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      )
    }
    // Synthetic records belong to test setup, never to application migrations.
    const timestamp = 1_700_000_000_000
    for (const track of seed) {
      await db.prepare('INSERT INTO catalogue_tracks (track_id,title,vocal_status,work_group_id,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?)')
        .bind(track.id, track.title, track.vocalStatus, track.workGroupId, timestamp, timestamp, timestamp).run()
      for (const game of track.games) {
        await db.prepare('INSERT INTO catalogue_track_games VALUES (?,?)').bind(track.id, game).run()
      }
      for (const source of track.sources) {
        await db.prepare('INSERT INTO catalogue_sources (source_row_id,track_id,provider,external_id,rights_status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(`seed-${track.id}-${source.provider}`, track.id, source.provider, source.externalId, source.metadata.rightsStatus, JSON.stringify(source.metadata), timestamp, timestamp).run()
      }
    }
    return { db, dispose: () => runtime.dispose() }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

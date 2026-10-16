import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { readFileSync } from 'node:fs'
import type { Track } from '../../src/features/catalog/types'
const seed = JSON.parse(
  readFileSync('workers/test/catalogue-seed.json', 'utf8'),
) as Track[]
describe('catalogue migration', () => {
  let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
  beforeAll(async () => {
    fixture = await catalogueDatabase()
  })
  afterAll(async () => {
    await fixture?.dispose()
  })
  it('loads three synthetic test identities and R2 metadata', async () => {
    const tracks = await fixture.db
      .prepare('SELECT * FROM catalogue_tracks ORDER BY track_id')
      .all<any>()
    expect(tracks.results.map((t: { track_id: string }) => t.track_id)).toEqual(
      seed.map((t) => t.id).sort(),
    )
    for (const track of seed) {
      const row = tracks.results.find((t: { track_id: string }) => t.track_id === track.id)
      expect(row).toMatchObject({
        title: track.title,
        work_group_id: track.workGroupId,
        vocal_status: 'uncertain',
        focus: 0,
        sleep: 0,
        chill: 0,
        needs_classification: 1,
      })
      const sources = await fixture.db
        .prepare(
          'SELECT provider, external_id, metadata_json FROM catalogue_sources WHERE track_id=?',
        )
        .bind(track.id)
        .all<any>()
      expect(
        sources.results.map(
          (s: { provider: string; external_id: string; metadata_json: string }) => ({
            provider: s.provider,
            externalId: s.external_id,
            metadata: JSON.parse(s.metadata_json),
          }),
        ),
      ).toEqual(track.sources)
    }
  })
  it('persists explicit Focus with vocal/uncertain as independent dimensions in real D1', async () => {
    for (const vocal of ['vocal', 'uncertain'])
      await expect(
        fixture.db
          .prepare('UPDATE catalogue_tracks SET focus=1,vocal_status=? WHERE track_id=?')
          .bind(vocal, seed[0].id)
          .run(),
      ).resolves.toMatchObject({ success: true })
    const row = await fixture.db.prepare('SELECT focus,vocal_status FROM catalogue_tracks WHERE track_id=?').bind(seed[0].id).first()
    expect(row).toEqual({ focus: 1, vocal_status: 'uncertain' })
  })
  it('rejects invalid booleans, confidence and revision', async () => {
    for (const assignment of ['sleep=2', 'metadata_confidence=1.1', 'revision=0'])
      await expect(
        fixture.db
          .prepare('UPDATE catalogue_tracks SET ' + assignment + ' WHERE track_id=?')
          .bind(seed[0].id)
          .run(),
      ).rejects.toThrow()
  })
  it('enforces canonical provider mapping ownership and foreign keys', async () => {
    await expect(
      fixture.db
        .prepare(
          'INSERT INTO catalogue_sources SELECT ?, ?, provider, external_id, source_type, source_status, source_confidence, rights_status, metadata_json, evidence, notes, created_at, updated_at FROM catalogue_sources LIMIT 1',
        )
        .bind('duplicate', seed[1].id)
        .run(),
    ).rejects.toThrow()
    await expect(
      fixture.db.prepare("INSERT INTO catalogue_track_games VALUES ('missing','zzz')").run(),
    ).rejects.toThrow()
  })
})

describe('Focus contract migration preserves populated catalogue', () => {
  it('preserves complete rows, child mappings and foreign keys atomically', async () => {
    const fixture = await catalogueDatabase('0023_focus_classification_independent.sql')
    try {
      const id = seed[0].id
      await fixture.db.batch([
        fixture.db.prepare("INSERT INTO catalogue_aliases VALUES (?, 'zh-Hant', '測試別名')").bind(id),
        fixture.db.prepare("INSERT INTO catalogue_track_relations VALUES (?, 'place:mondstadt')").bind(id),
      ])
      const tables = ['catalogue_tracks', 'catalogue_track_games', 'catalogue_track_relations', 'catalogue_sources', 'catalogue_aliases', 'catalogue_state']
      const snapshot = async () => Promise.all(tables.map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()))
      const before = (await snapshot()).map((result: { results: unknown[] }) => result.results)
      const sql = readFileSync('migrations/0023_focus_classification_independent.sql', 'utf8')
      await fixture.db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => fixture.db.prepare(s)))
      expect((await snapshot()).map((result: { results: unknown[] }) => result.results)).toEqual(before)
      expect((await fixture.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
      await expect(fixture.db.prepare("UPDATE catalogue_tracks SET focus=1,vocal_status='vocal' WHERE track_id=?").bind(id).run()).resolves.toMatchObject({ success: true })
      await expect(fixture.db.prepare("INSERT INTO catalogue_aliases VALUES ('missing', 'en', 'Missing')").run()).rejects.toThrow()
      await expect(fixture.db.prepare('UPDATE catalogue_tracks SET focus=2 WHERE track_id=?').bind(id).run()).rejects.toThrow()
    } finally {
      await fixture.dispose()
    }
  })
})

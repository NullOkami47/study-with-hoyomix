import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { exportWorkbook, parseStaging } from '../catalogue/staging'
import { diffStaging, saveImportBatch, readImportBatch } from '../catalogue/diff'
import type { CatalogueSnapshot } from '../catalogue/types'
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>, snapshot: CatalogueSnapshot
beforeAll(async () => {
  fixture = await catalogueDatabase()
  snapshot = await readCatalogueSnapshot(fixture.db)
  await fixture.db
    .prepare(
      "INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('catalogue-admin','Admin','admin',1,1)",
    )
    .run()
})
afterAll(async () => {
  await fixture?.dispose()
})
describe('deterministic catalogue proposals', () => {
  it('equivalent export and omitted published rows are no-ops, never deletions', () => {
    const book = exportWorkbook(snapshot)
    expect(diffStaging(parseStaging(book, snapshot), snapshot)).toEqual([])
    book.Tracks.splice(1)
    book.Sources.splice(1)
    book.Aliases.splice(1)
    expect(diffStaging(parseStaging(book, snapshot), snapshot)).toEqual([])
  })
  it('separates metadata/classification without allowing an unapproved sibling payload through', () => {
    const book = exportWorkbook(snapshot)
    book.Tracks[1][1] = 'Changed title'
    book.Tracks[1][7] = 'instrumental'
    book.Tracks[1][8] = 'TRUE'
    const changes = diffStaging(parseStaging(book, snapshot), snapshot)
    expect(changes.map((c) => c.kind)).toEqual(['metadata_change', 'classification_change'])
    expect(changes[0].after).not.toHaveProperty('focus')
    expect(changes[1].after).not.toHaveProperty('title')
  })
  it('identifies a provider source claimed by another canonical ID as a conflict', () => {
    const book = exportWorkbook(snapshot)
    book.Tracks.push([
      'new-canonical',
      'New recording',
      'zzz',
      '',
      '',
      'work-new',
      '',
      'uncertain',
      'FALSE',
      'FALSE',
      'FALSE',
      '0.95',
      'pending',
      'evidence',
      '',
    ])
    book.Sources[1][1] = 'new-canonical'
    const changes = diffStaging(parseStaging(book, snapshot), snapshot)
    expect(changes.some((c) => c.kind === 'conflict')).toBe(true)
  })
  it('persists immutable proposals, deduplicates concurrent snapshots and never writes live tracks', async () => {
    const book = exportWorkbook(snapshot)
    book.Tracks[1][1] = 'Staged only'
    const [a, b] = await Promise.all([
      saveImportBatch(fixture.db, book, 'catalogue-admin', 1),
      saveImportBatch(fixture.db, book, 'catalogue-admin', 1),
    ])
    expect(a.batchId).toBe(b.batchId)
    expect(a.changes[0].decision).toBe('pending')
    expect((await readCatalogueSnapshot(fixture.db)).tracks).toEqual(snapshot.tracks)
    expect(await readImportBatch(fixture.db, a.batchId)).toEqual(a)
  })
})

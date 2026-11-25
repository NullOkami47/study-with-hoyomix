import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { isReviewStatus } from '../../src/shared/reviewStatus'
import { catalogueDatabase } from './catalogue-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { exportWorkbook, parseStaging, SHEET_HEADERS } from '../catalogue/staging'
import { diffStaging } from '../catalogue/diff'
import type { CatalogueSnapshot } from '../catalogue/types'
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>, snapshot: CatalogueSnapshot
beforeAll(async () => {
  fixture = await catalogueDatabase()
  snapshot = await readCatalogueSnapshot(fixture.db)
})
afterAll(async () => {
  await fixture?.dispose()
})
const edit = (tab: 'Tracks' | 'Sources' | 'Aliases', field: string, value: string) => {
  const book = exportWorkbook(snapshot)
  book[tab][1][book[tab][0].indexOf(field)] = value
  return book
}

describe('published stream rows', () => {
  function legacy() {
    const original = structuredClone(snapshot)
    const source = {
      ...original.sources[0],
      source_row_id: 'synthetic-stream',
      provider: 'chksz',
      external_id: '12345678901234567890',
      source_type: 'stream',
      source_confidence: 1,
      rights_status: 'public',
      metadata_json: '{"contentType":"audio/mpeg","rightsStatus":"public"}',
      evidence: 'Synthetic public evidence',
      notes: null as string | null,
    }
    original.sources = [source]
    return { original, source, otherTrack: original.tracks.find((t) => t.track_id !== source.track_id)!.track_id }
  }

  function change(row: string[], changes: Record<string, string>) {
    for (const [field, value] of Object.entries(changes))
      row[SHEET_HEADERS.Sources.indexOf(field)] = value
  }

  it('preserves source fields and D1 metadata with zero proposals after trailing blank truncation', () => {
    const { original, source } = legacy()
    const book = exportWorkbook(original)
    book.Sources[1].pop()
    const staged = parseStaging(book, original)
    const { created_at: _created, updated_at: _updated, ...fields } = source
    expect(staged.errors).toEqual([])
    expect(staged.sources).toEqual([fields])
    expect(diffStaging(staged, original)).toEqual([])
  })

  it('preserves literal whitespace and rejects changing it', () => {
    const { original, source } = legacy()
    source.notes = '  published note  '
    const book = exportWorkbook(original)
    const staged = parseStaging(book, original)
    expect(staged.errors).toEqual([])
    expect(diffStaging(staged, original)).toEqual([])
    change(book.Sources[1], { notes: 'published note' })
    expect(parseStaging(book, original).errors).not.toHaveLength(0)
  })

  it.each([
    ['source_row_id', 'another-source'],
    ['track_id', ''],
    ['provider', 'gd-studio'],
    ['external_id', '1234567890'],
    ['source_type', 'audio'],
    ['source_status', 'disabled'],
    ['source_confidence', '1.0'],
    ['source_confidence', '0.9'],
    ['rights_status', 'unverified'],
    ['evidence', 'Replacement evidence'],
    ['notes', 'Replacement note'],
    ['notes', ' '],
  ])('rejects editing %s (%s)', (field, value) => {
    const { original, otherTrack } = legacy()
    const book = exportWorkbook(original)
    change(book.Sources[1], { [field]: field === 'track_id' ? otherTrack : value })
    const staged = parseStaging(book, original)
    expect(staged.errors.some((error) => error.entityType === 'source')).toBe(true)
    expect(diffStaging(staged, original).filter((p) => p.validationState === 'valid')).toEqual([])
  })

  it('rejects replacing an omitted stream with audio for the same track and provider', () => {
    const { original } = legacy()
    const book = exportWorkbook(original)
    change(book.Sources[1], {
      source_row_id: 'replacement-source', external_id: '2345678901', source_type: 'audio',
    })
    const staged = parseStaging(book, original)
    expect(staged.errors).not.toHaveLength(0)
    expect(diffStaging(staged, original).some((p) => p.kind === 'new_source')).toBe(false)
  })

  it('rejects duplicate rows and an audio alias of the same binding on another known track', () => {
    const { original, otherTrack } = legacy()
    const book = exportWorkbook(original)
    const alias = [...book.Sources[1]]
    book.Sources.push(alias)
    expect(parseStaging(book, original).errors).toContainEqual({
      entityType: 'source', key: 'synthetic-stream', code: 'duplicate_or_invalid_source_identity',
    })
    change(alias, { source_row_id: 'alias-source', track_id: otherTrack, source_type: 'audio' })
    const staged = parseStaging(book, original)
    expect(staged.errors.some((error) => error.key === 'alias-source' && error.conflict)).toBe(true)
    expect(diffStaging(staged, original).some((p) => p.kind === 'new_source')).toBe(false)
  })

  it('rejects new stream rows and still accepts evidenced audio on another track', () => {
    const { original, otherTrack } = legacy()
    const book = exportWorkbook(original)
    const row = [...book.Sources[1]]
    change(row, { source_row_id: 'new-source', track_id: otherTrack, external_id: '3456789012' })
    book.Sources.push(row)
    expect(parseStaging(book, original).errors).toContainEqual({
      entityType: 'source', key: 'new-source', code: 'invalid_source',
    })
    change(row, { source_type: 'audio' })
    const staged = parseStaging(book, original)
    expect(staged.errors).toEqual([])
    expect(diffStaging(staged, original).map(({ kind }) => kind)).toEqual(['new_source'])
  })
})
describe('bounded untrusted Sheet staging', () => {
  it('roundtrips the three authorised tracks without inventing classification', () => {
    const parsed = parseStaging(exportWorkbook(snapshot), snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks).toHaveLength(3)
    expect(parsed.tracks.every((t) => !t.focus && t.vocal_status === 'uncertain')).toBe(true)
  })
  it('accepts a focus track whose vocal status is vocal', () => {
    // Regression guard: `focus` and `vocal_status` are independent dimensions, so an admin may
    // save a focus track with a vocal vocal_status (389 published rows already look like this).
    const book = exportWorkbook(snapshot)
    const headers = book.Tracks[0]
    book.Tracks[1][headers.indexOf('focus')] = 'TRUE'
    book.Tracks[1][headers.indexOf('vocal_status')] = 'vocal'
    const parsed = parseStaging(book, snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks[0].focus).toBe(1)
    expect(parsed.tracks[0].vocal_status).toBe('vocal')
  })
  it.each([
    ['track_id', ''],
    ['track_id', '../rename'],
    ['title', ''],
    ['game', 'unknown'],
    ['focus', 'yes'],
    ['vocal_status', 'guessed'],
    ['relation_ids', 'not-a-relation'],
    ['metadata_confidence', '1.1'],
    ['metadata_confidence', 'NaN'],
    ['release_date', '2026-02-31'],
    ['work_group_id', ''],
  ])('rejects invalid Tracks %s=%s', (field, value) => {
    expect(parseStaging(edit('Tracks', field, value), snapshot).errors.length).toBeGreaterThan(0)
  })
  it.each(['instrumental', 'vocal', 'uncertain'])('stages explicit Focus independently of %s vocal status', (vocal) => {
    const book = edit('Tracks', 'focus', 'TRUE')
    book.Tracks[1][book.Tracks[0].indexOf('vocal_status')] = vocal
    const parsed = parseStaging(book, snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks[0]).toMatchObject({ focus: 1, vocal_status: vocal })
  })

  it('rejects duplicate track IDs and provider bindings', () => {
    const book = exportWorkbook(snapshot)
    book.Tracks.push([...book.Tracks[1]])
    book.Sources.push([...book.Sources[1]])
    expect(parseStaging(book, snapshot).errors.length).toBeGreaterThanOrEqual(2)
  })
  it.each([
    ['source_row_id', ''],
    ['provider', 'unknown'],
    ['track_id', 'missing'],
    ['external_id', '../escape.mp3'],
    ['source_confidence', '-1'],
  ])('rejects invalid Sources %s=%s', (field, value) => {
    expect(parseStaging(edit('Sources', field, value), snapshot).errors.length).toBeGreaterThan(0)
  })
  it('never authorises a new R2 path or moves trusted owner rights', () => {
    const book = edit('Sources', 'external_id', 'tracks/authorized/invented.mp3')
    expect(
      parseStaging(book, snapshot).errors.some((e) => e.code === 'r2_owner_verification_required'),
    ).toBe(true)
  })
  it('requires evidence and confidence for a valid new non-R2 source', () => {
    const book = exportWorkbook(snapshot)
    book.Sources.push([
      'new-source',
      snapshot.tracks[0].track_id,
      'youtube',
      'abcdefghijk',
      'audio',
      'active',
      '',
      'unverified',
      '',
      '',
    ])
    expect(
      parseStaging(book, snapshot).errors.some((e) => e.code === 'source_evidence_required'),
    ).toBe(true)
    book.Sources[book.Sources.length - 1][6] = '0.95'
    book.Sources[book.Sources.length - 1][8] = 'Owner supplied recording evidence'
    expect(parseStaging(book, snapshot).errors).toEqual([])
  })
  it('rejects oversized cells/rows and unknown columns rather than truncating silently', () => {
    const book = edit('Tracks', 'notes', 'x'.repeat(4001))
    expect(() => parseStaging(book, snapshot)).toThrow('staging_invalid')
    const big = exportWorkbook(snapshot)
    big.Tracks = Array.from({ length: 2002 }, () => [])
    expect(() => parseStaging(big, snapshot)).toThrow('staging_invalid')
    const extra = exportWorkbook(snapshot)
    extra.Tracks[0].push('delete')
    expect(() => parseStaging(extra, snapshot)).toThrow('staging_invalid')
  })
})

describe('review status round-trip', () => {
  /** Set two Tracks columns on the first data row of a freshly exported workbook. */
  const editTrack = (fields: Record<string, string>) => {
    const book = exportWorkbook(snapshot)
    for (const [field, value] of Object.entries(fields)) {
      book.Tracks[1][book.Tracks[0].indexOf(field)] = value
    }
    return book
  }

  it('exports only contract review statuses', () => {
    const book = exportWorkbook(snapshot)
    const column = book.Tracks[0].indexOf('review_status')
    expect(column).toBeGreaterThanOrEqual(0)
    for (const row of book.Tracks.slice(1)) {
      expect(isReviewStatus(row[column])).toBe(true)
    }
  })

  it.each(['reviewed', 'approved'])('accepts %s and clears needs_classification', (status) => {
    const parsed = parseStaging(editTrack({ vocal_status: 'instrumental', review_status: status }), snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks[0].needs_classification).toBe(0)
  })

  it.each(['pending', ''])('accepts %s but keeps needs_classification set', (status) => {
    const parsed = parseStaging(editTrack({ vocal_status: 'instrumental', review_status: status }), snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks[0].needs_classification).toBe(1)
  })

  it('still marks an uncertain vocal status as needing classification when reviewed', () => {
    const parsed = parseStaging(editTrack({ review_status: 'approved' }), snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks[0].vocal_status).toBe('uncertain')
    expect(parsed.tracks[0].needs_classification).toBe(1)
  })

  it('rejects the leaked generator value instead of silently unclassifying the row', () => {
    // Regression: the canonical dataset used to carry `review_status: "verified"`. It is not a
    // contract value, so the Sheets round-trip must refuse it loudly rather than accept it and
    // then report the row as reviewed (or, as happened, as needing classification).
    const parsed = parseStaging(editTrack({ review_status: 'verified' }), snapshot)
    expect(parsed.errors.some((e) => e.code === 'invalid_review_metadata')).toBe(true)
  })

  it('round-trips an exported workbook unchanged', () => {
    const first = parseStaging(exportWorkbook(snapshot), snapshot)
    expect(first.errors).toEqual([])
    const second = parseStaging(exportWorkbook(snapshot), snapshot)
    expect(second.errors).toEqual([])
    expect(second.tracks).toEqual(first.tracks)
  })
})

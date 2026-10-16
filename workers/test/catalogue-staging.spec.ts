import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { isReviewStatus } from '../../src/shared/reviewStatus'
import { catalogueDatabase } from './catalogue-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { exportWorkbook, parseStaging } from '../catalogue/staging'
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
describe('bounded untrusted Sheet staging', () => {
  it('roundtrips three synthetic trusted-source fixtures without inventing classification', () => {
    const parsed = parseStaging(exportWorkbook(snapshot), snapshot)
    expect(parsed.errors).toEqual([])
    expect(parsed.tracks).toHaveLength(3)
    expect(parsed.tracks.every((t) => !t.focus && t.vocal_status === 'uncertain')).toBe(true)
  })
  it('accepts a focus track whose vocal status is vocal', () => {
    // Regression guard: `focus` and `vocal_status` are independent dimensions, so an admin may
    // save a focus track with a vocal vocal_status.
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

import { describe, expect, it } from 'vitest'
import { BACKGROUND_OVERRIDES_STORAGE_KEY, parseOverrides, readCachedOverrides } from './overrides'

const row = { id: 'zzz-astra-yao', status: 'archived' }

describe('atomic background override validation', () => {
  it.each(['published', 'archived', 'tombstoned'])('accepts %s with nullable Worker metadata', (status) => {
    expect(parseOverrides({ overrides: [{ ...row, status, title: null, game: null, collection: null, displayOrder: null, updatedAt: 0 }] })?.get(row.id))
      .toMatchObject({ ...row, status, updatedAt: 0 })
  })

  it('accepts empty snapshots and populated metadata without requiring optional fields', () => {
    expect(parseOverrides({ overrides: [] })).toEqual(new Map())
    expect(parseOverrides({ overrides: [{ ...row, title: 'Study', game: 'zzz', collection: 'room', displayOrder: 3 }] })?.get(row.id))
      .toMatchObject({ title: 'Study', game: 'zzz', collection: 'room', displayOrder: 3 })
  })

  it('retains well-formed historical slugs alongside currently disabled IDs', () => {
    const parsed = parseOverrides({ overrides: [row, { id: 'retired-scene-2025', status: 'tombstoned' }] })
    expect(parsed?.size).toBe(2)
    expect(parsed?.get(row.id)?.status).toBe('archived')
    expect(parsed?.get('retired-scene-2025')?.status).toBe('tombstoned')
  })

  it('accepts Worker metadata boundaries and discards unknown additive fields', () => {
    const parsed = parseOverrides({ overrides: [{ ...row, title: 'a'.repeat(120), game: 'b'.repeat(64), collection: 'c'.repeat(64), displayOrder: 0, futureField: { arbitrary: true } }] })
    expect(parsed?.get(row.id)).toEqual({ ...row, title: 'a'.repeat(120), game: 'b'.repeat(64), collection: 'c'.repeat(64), displayOrder: 0 })
  })

  it.each([null, [], {}, { overrides: null }, { overrides: {} }, { overrides: 'invalid' }])('rejects malformed envelopes: %j', (payload) => {
    expect(parseOverrides(payload)).toBeNull()
  })

  it.each([
    null, [], {}, { status: 'archived' }, { ...row, id: 12 },
    ...['', ' ', '../scene', 'zzz scene', 'ZZZ-scene', '-scene', 'scene-', 'a'.repeat(65)].map(id => ({ ...row, id })),
    { ...row, status: 'draft' }, { ...row, status: 1 }, { ...row, status: null },
    { ...row, title: 1 }, { ...row, title: '' }, { ...row, title: ' ' }, { ...row, title: 'a'.repeat(121) },
    { ...row, game: [] }, { ...row, game: 'a'.repeat(65) },
    { ...row, collection: false }, { ...row, collection: 'a'.repeat(65) },
    ...[-1, 1.5, '1', Infinity, NaN].map(displayOrder => ({ ...row, displayOrder })),
    ...[-1, 1.5, '1', null, Infinity, NaN].map(updatedAt => ({ ...row, updatedAt })),
  ])('rejects the entire snapshot for malformed row %j', (invalid) => {
    expect(parseOverrides({ overrides: [{ id: 'zzz-ellen-joe', status: 'published' }, invalid] })).toBeNull()
  })

  it.each(['published', 'archived'])('rejects duplicate IDs even with %s status', (status) => {
    expect(parseOverrides({ overrides: [row, { ...row, status }] })).toBeNull()
  })
})

describe('versioned override cache', () => {
  const read = (value: string) => readCachedOverrides({
    getItem: key => key === BACKGROUND_OVERRIDES_STORAGE_KEY ? value : null,
    setItem: () => {},
  })

  it.each([undefined, 0, 2, '1', null])('rejects unsupported cache version %j', (version) => {
    expect(read(JSON.stringify({ version, overrides: [row] }))).toBeNull()
  })

  it('rejects malformed JSON, malformed cached rows and duplicates', () => {
    expect(read('{')).toBeNull()
    expect(read(JSON.stringify({ version: 1, overrides: [row, { id: 'bad', status: 'oops' }] }))).toBeNull()
    expect(read(JSON.stringify({ version: 1, overrides: [row, row] }))).toBeNull()
  })

  it('accepts only fully validated version 1 snapshots, including empty ones', () => {
    expect(read(JSON.stringify({ version: 1, overrides: [row] }))?.get(row.id)).toEqual(row)
    expect(read(JSON.stringify({ version: 1, overrides: [] }))).toEqual(new Map())
  })
})

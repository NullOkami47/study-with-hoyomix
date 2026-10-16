import { describe, expect, it } from 'vitest'

import {
  CHKSZ_SEARCH_DEFAULT_LIMIT,
  CHKSZ_SEARCH_ENDPOINT,
  CHKSZ_SEARCH_MAX_LIMIT,
  buildChkszSearchUrl,
  classifyChkszSearchFailure,
  interpretChkszSearchResponse,
  parseChkszSearchResponse,
} from './chkszSearch'

/** The exact gate bodies observed live on 2026-09-20. */
const GATE_ABSENT = { code: 401, msg: '缺少 apikey 参数，请先登录并查看个人密钥' }
const GATE_INVALID = { code: 401, msg: 'apikey 无效或已失效' }

const searchBody = (overrides: Record<string, unknown> = {}) => ({
  code: 200,
  msg: 'success',
  data: {
    songs: [
      {
        id: 1315196858,
        name: '海底',
        artists: '一支榴莲',
        album: '独',
        picUrl: 'https://p1.music.126.net/cover.jpg',
        duration: 234000,
      },
    ],
    total: 100,
    ...overrides,
  },
})

describe('ChKSz search constants', () => {
  it('targets the documented endpoint', () => {
    expect(CHKSZ_SEARCH_ENDPOINT).toBe('https://api.chksz.com/api/163_search')
  })

  it('caps a single request at the documented default page size', () => {
    expect(CHKSZ_SEARCH_MAX_LIMIT).toBe(CHKSZ_SEARCH_DEFAULT_LIMIT)
  })
})

describe('buildChkszSearchUrl', () => {
  it('builds the documented request shape', () => {
    const url = buildChkszSearchUrl('陈奕迅')!
    expect(url.pathname).toBe('/api/163_search')
    expect(url.searchParams.get('keyword')).toBe('陈奕迅')
    expect(url.searchParams.get('limit')).toBe(String(CHKSZ_SEARCH_DEFAULT_LIMIT))
  })

  it('omits offset when it is zero, keeping the canonical URL stable', () => {
    expect(buildChkszSearchUrl('x', { offset: 0 })!.searchParams.has('offset')).toBe(false)
  })

  it('includes offset when it is positive', () => {
    expect(buildChkszSearchUrl('x', { offset: 100 })!.searchParams.get('offset')).toBe('100')
  })

  it('clamps an oversized limit instead of rejecting it', () => {
    const url = buildChkszSearchUrl('x', { limit: 5000 })!
    expect(url.searchParams.get('limit')).toBe(String(CHKSZ_SEARCH_MAX_LIMIT))
  })

  it('never appends an apikey, because this module owns no credential', () => {
    expect(buildChkszSearchUrl('x')!.searchParams.has('apikey')).toBe(false)
  })

  it('trims the keyword', () => {
    expect(buildChkszSearchUrl('  x  ')!.searchParams.get('keyword')).toBe('x')
  })

  it('refuses an empty or whitespace-only keyword', () => {
    expect(buildChkszSearchUrl('')).toBeNull()
    expect(buildChkszSearchUrl('   ')).toBeNull()
    expect(buildChkszSearchUrl(undefined as unknown as string)).toBeNull()
  })

  it('refuses a non-integer or non-positive limit rather than coercing it', () => {
    expect(buildChkszSearchUrl('x', { limit: 1.5 })).toBeNull()
    expect(buildChkszSearchUrl('x', { limit: 0 })).toBeNull()
    expect(buildChkszSearchUrl('x', { limit: -1 })).toBeNull()
    expect(buildChkszSearchUrl('x', { limit: Number.NaN })).toBeNull()
  })

  it('refuses a negative or non-integer offset rather than coercing it', () => {
    expect(buildChkszSearchUrl('x', { offset: -1 })).toBeNull()
    expect(buildChkszSearchUrl('x', { offset: 2.5 })).toBeNull()
  })

  it('percent-encodes a keyword containing reserved characters', () => {
    const url = buildChkszSearchUrl('a&b=c')!
    expect(url.searchParams.get('keyword')).toBe('a&b=c')
    expect(url.search.split('keyword=')[1]!.split('&')[0]).not.toBe('a')
  })
})

describe('classifyChkszSearchFailure', () => {
  it('distinguishes an absent credential from a rejected one', () => {
    // Both are 401 — only the msg separates them, so the msg must be authoritative.
    expect(classifyChkszSearchFailure(401, GATE_ABSENT)).toBe('credential_absent')
    expect(classifyChkszSearchFailure(401, GATE_INVALID)).toBe('credential_invalid')
  })

  it('reports an unrecognised 401 as invalid rather than absent', () => {
    // Reporting "absent" would send an operator to configure a key that may already exist.
    expect(classifyChkszSearchFailure(401, { code: 401, msg: 'unexpected' })).toBe(
      'credential_invalid',
    )
    expect(classifyChkszSearchFailure(401, 'not json')).toBe('credential_invalid')
  })

  it('maps transport statuses truthfully', () => {
    expect(classifyChkszSearchFailure(429, {})).toBe('rate_limited')
    expect(classifyChkszSearchFailure(403, {})).toBe('forbidden')
    expect(classifyChkszSearchFailure(503, {})).toBe('unavailable')
    expect(classifyChkszSearchFailure(500, {})).toBe('unavailable')
    expect(classifyChkszSearchFailure(400, {})).toBe('invalid_response')
  })
})

describe('parseChkszSearchResponse', () => {
  it('parses the documented envelope', () => {
    const parsed = parseChkszSearchResponse(searchBody())!
    expect(parsed.total).toBe(100)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toEqual({
      id: '1315196858',
      name: '海底',
      artists: '一支榴莲',
      album: '独',
      durationMs: 234000,
      picUrl: 'https://p1.music.126.net/cover.jpg',
    })
  })

  it('stringifies the numeric id, because 163_music consumes a string id', () => {
    const parsed = parseChkszSearchResponse(searchBody())!
    expect(typeof parsed.candidates[0]!.id).toBe('string')
  })

  it('accepts an artists array of strings', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({ songs: [{ id: 1, name: 'A', artists: ['X', 'Y'] }] }),
    )!
    expect(parsed.candidates[0]!.artists).toBe('X, Y')
  })

  it('accepts an artists array of { name } objects, the shape the same vendor documents elsewhere', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({ songs: [{ id: 1, name: 'A', artists: [{ name: 'X' }, { name: 'Y' }] }] }),
    )!
    expect(parsed.candidates[0]!.artists).toBe('X, Y')
  })

  it('never stringifies an unrecognised artist entry into a plausible token', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({ songs: [{ id: 1, name: 'A', artists: [{ nope: 1 }, null, 'Z'] }] }),
    )!
    expect(parsed.candidates[0]!.artists).toBe('Z')
    expect(parsed.candidates[0]!.artists).not.toContain('object')
  })

  it('returns null durationMs rather than guessing a unit', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({ songs: [{ id: 1, name: 'A', duration: '234000' }] }),
    )!
    expect(parsed.candidates[0]!.durationMs).toBeNull()
  })

  it('rejects a non-positive or non-finite duration', () => {
    for (const duration of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = parseChkszSearchResponse(
        searchBody({ songs: [{ id: 1, name: 'A', duration }] }),
      )!
      expect(parsed.candidates[0]!.durationMs).toBeNull()
    }
  })

  it('drops a candidate with an unusable id instead of failing the page', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({
        songs: [
          { id: '1315196858', name: 'bad id type' },
          { id: 0, name: 'zero id' },
          { id: -1, name: 'negative id' },
          { id: 2.5, name: 'fractional id' },
          { id: 42, name: 'good' },
        ],
      }),
    )!
    expect(parsed.candidates.map((c) => c.id)).toEqual(['42'])
  })

  it('drops a candidate with an empty name', () => {
    const parsed = parseChkszSearchResponse(
      searchBody({ songs: [{ id: 1, name: '   ' }, { id: 2, name: 'ok' }] }),
    )!
    expect(parsed.candidates.map((c) => c.id)).toEqual(['2'])
  })

  it('defaults absent optional fields without inventing values', () => {
    const parsed = parseChkszSearchResponse(searchBody({ songs: [{ id: 7, name: 'A' }] }))!
    expect(parsed.candidates[0]).toEqual({
      id: '7',
      name: 'A',
      artists: '',
      album: '',
      durationMs: null,
      picUrl: '',
    })
  })

  it('reports total as null when it is absent or malformed', () => {
    expect(parseChkszSearchResponse(searchBody({ total: 'lots' }))!.total).toBeNull()
    expect(parseChkszSearchResponse(searchBody({ total: -1 }))!.total).toBeNull()
    const withoutTotal = searchBody()
    delete (withoutTotal.data as Record<string, unknown>).total
    expect(parseChkszSearchResponse(withoutTotal)!.total).toBeNull()
  })

  it('rejects envelopes that are not a successful search', () => {
    expect(parseChkszSearchResponse(null)).toBeNull()
    expect(parseChkszSearchResponse('nope')).toBeNull()
    expect(parseChkszSearchResponse([])).toBeNull()
    expect(parseChkszSearchResponse({ code: 401, data: { songs: [] } })).toBeNull()
    expect(parseChkszSearchResponse({ code: 200, data: {} })).toBeNull()
    expect(parseChkszSearchResponse({ code: 200, data: { songs: 'nope' } })).toBeNull()
  })

  it('accepts an empty song list as a valid zero-result search', () => {
    const parsed = parseChkszSearchResponse(searchBody({ songs: [], total: 0 }))!
    expect(parsed.candidates).toEqual([])
    expect(parsed.total).toBe(0)
  })
})

describe('interpretChkszSearchResponse', () => {
  it('returns candidates on 200', () => {
    const result = interpretChkszSearchResponse(200, searchBody())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates).toHaveLength(1)
    expect(result.total).toBe(100)
  })

  it('reports an unrecognised 200 body as invalid_response rather than as zero results', () => {
    // A malformed body must never read as "the catalogue has no such track".
    const result = interpretChkszSearchResponse(200, { code: 200, data: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_response')
  })

  it('carries the upstream gate message through on failure', () => {
    const result = interpretChkszSearchResponse(401, GATE_ABSENT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('credential_absent')
    expect(result.message).toContain('apikey')
  })

  it('synthesises a message when the body carries none', () => {
    const result = interpretChkszSearchResponse(429, '<html>')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('rate_limited')
    expect(result.message).toBe('HTTP 429')
  })
})

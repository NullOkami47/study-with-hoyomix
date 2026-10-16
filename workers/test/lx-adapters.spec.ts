import { describe, expect, it, vi } from 'vitest'

import {
  classifyHuibqResponseError,
  createHuibqDescriptor,
} from '../providers/lx/huibq'
import {
  classifyIkunResponseError,
  createIkunDescriptor,
} from '../providers/lx/ikun'
import { resolveLxMetadata } from '../providers/lx/shared'
import { createExactMediaUrlValidator } from '../providers/resolverMediaUrl'

const REQUEST_KEY = 'LX_ADAPTER_REQUEST_KEY_SENTINEL'
const MEDIA_URL = 'https://media.example/audio?token=temporary'

const resolveWith = (
  descriptor: ReturnType<typeof createHuibqDescriptor> | ReturnType<typeof createIkunDescriptor>,
  externalId: string,
  fetchImpl: typeof fetch,
) => resolveLxMetadata({
  descriptor,
  configuredOrigin: 'https://resolver.example',
  externalId,
  fetch: fetchImpl,
  validateMediaUrl: createExactMediaUrlValidator(['media.example']),
})

describe('Huibq LX adapter', () => {
  it('accepts only a bounded canonical source:id:quality binding', () => {
    const descriptor = createHuibqDescriptor(REQUEST_KEY)

    expect(descriptor.parseExternalId('kw:ABC_def-123:320k')).toEqual({
      source: 'kw',
      id: 'ABC_def-123',
      quality: '320k',
    })
    expect(descriptor.parseExternalId('mg:123456:128k')).toEqual({
      source: 'mg',
      id: '123456',
      quality: '128k',
    })
    expect(descriptor.parseExternalId('git:ABC:320k')).toBeNull()
    expect(descriptor.parseExternalId('kw:ABC:flac')).toBeNull()
    expect(descriptor.parseExternalId(`kw:${'a'.repeat(97)}:320k`)).toBeNull()
    expect(descriptor.parseExternalId('kw:../ABC:320k')).toBeNull()
    expect(descriptor.parseExternalId('kw:ABC:320k:extra')).toBeNull()
  })

  it('builds the finite GET path and puts the closure key only in the request header', async () => {
    const descriptor = createHuibqDescriptor(REQUEST_KEY)
    const fetchImpl = vi.fn(async () => Response.json({ code: 0, url: MEDIA_URL })) as unknown as typeof fetch

    await expect(resolveWith(descriptor, 'kg:ABC_def-123:320k', fetchImpl)).resolves.toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toBe('https://resolver.example/url/kg/ABC_def-123/320k')
    expect(String(url)).not.toContain(REQUEST_KEY)
    expect(new Headers(init?.headers).get('x-request-key')).toBe(REQUEST_KEY)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
  })

  it.each([
    [{ code: '0', url: MEDIA_URL }],
    [{ code: 0 }],
    [{ code: 0, url: MEDIA_URL, message: 'extra' }],
    [{ code: 0, url: 123 }],
    [[{ code: 0, url: MEDIA_URL }]],
  ])('rejects a non-exact success response %#', async (body) => {
    const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch

    await expect(resolveWith(
      createHuibqDescriptor(REQUEST_KEY),
      'wy:123456:128k',
      fetchImpl,
    )).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it.each([
    [{ code: 5 }, 'rate_limited'],
    [{ code: 1 }, 'unavailable'],
    [{ code: 2 }, 'unavailable'],
    [{ code: 4 }, 'unavailable'],
    [{ code: 6 }, 'invalid_response'],
    [{ code: 999 }, 'invalid_response'],
    [{ code: '5' }, 'invalid_response'],
    [{ code: 0, url: MEDIA_URL }, null],
  ] as const)('classifies application response %# without exposing its URL', (body, error) => {
    expect(classifyHuibqResponseError(body)).toBe(error)
  })

  it.each([
    [{ code: 5, msg: 'too many requests' }, 'rate_limited'],
    [{ code: 5 }, 'rate_limited'],
    [{ code: 1, msg: 'unsupported' }, 'unavailable'],
    [{ code: 2 }, 'unavailable'],
    [{ code: 4, msg: 'no permission' }, 'unavailable'],
    [{ code: 6 }, 'invalid_response'],
    [{ code: 999, msg: 'unknown' }, 'invalid_response'],
    [{ code: '5' }, 'invalid_response'],
    [{ nope: true }, 'invalid_response'],
  ] as const)(
    'propagates application failure %# through the real resolver without retry',
    async (body, error) => {
      const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch

      await expect(resolveWith(
        createHuibqDescriptor(REQUEST_KEY),
        'wy:123456:128k',
        fetchImpl,
      )).resolves.toEqual({ ok: false, error })
      expect(fetchImpl).toHaveBeenCalledOnce()
    },
  )

  it('never leaks the request key or resolver origin in a propagated failure', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      code: 5,
      msg: `private detail ${MEDIA_URL}`,
    })) as unknown as typeof fetch

    const result = await resolveWith(
      createHuibqDescriptor(REQUEST_KEY),
      'wy:123456:128k',
      fetchImpl,
    )

    expect(result).toEqual({ ok: false, error: 'rate_limited' })
    expect(JSON.stringify(result)).not.toContain(REQUEST_KEY)
    expect(JSON.stringify(result)).not.toContain('media.example')
    expect(JSON.stringify(result)).not.toContain('resolver.example')
  })
})

describe('ikun LX adapter', () => {
  it('accepts only supported source:id:quality combinations', () => {
    const descriptor = createIkunDescriptor(REQUEST_KEY)

    expect(descriptor.parseExternalId('kw:ABC_def-123:hires')).toEqual({
      source: 'kw',
      id: 'ABC_def-123',
      quality: 'hires',
    })
    expect(descriptor.parseExternalId('wy:123456:master')).toEqual({
      source: 'wy',
      id: '123456',
      quality: 'master',
    })
    expect(descriptor.parseExternalId('git:ABC123:flac')).toEqual({
      source: 'git',
      id: 'ABC123',
      quality: 'flac',
    })
    expect(descriptor.parseExternalId('git:ABC123:hires')).toBeNull()
    expect(descriptor.parseExternalId('kg:ABC123:320k')).toBeNull()
    expect(descriptor.parseExternalId(`wy:${'a'.repeat(97)}:320k`)).toBeNull()
    expect(descriptor.parseExternalId('wy:https://attacker.example:320k')).toBeNull()
  })

  it('builds the finite GET query and puts the closure key only in the request header', async () => {
    const descriptor = createIkunDescriptor(REQUEST_KEY)
    const fetchImpl = vi.fn(async () => Response.json({ code: 200, url: MEDIA_URL })) as unknown as typeof fetch

    await expect(resolveWith(descriptor, 'wy:ABC_def-123:flac24bit', fetchImpl)).resolves.toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/flac',
    })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toBe(
      'https://resolver.example/url?source=wy&songId=ABC_def-123&quality=flac24bit',
    )
    expect(String(url)).not.toContain(REQUEST_KEY)
    expect(new Headers(init?.headers).get('x-request-key')).toBe(REQUEST_KEY)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
  })

  it.each([
    [{ code: '200', url: MEDIA_URL }],
    [{ code: 200 }],
    [{ code: 200, url: MEDIA_URL, message: 'extra' }],
    [{ code: 200, url: false }],
    [[{ code: 200, url: MEDIA_URL }]],
  ])('rejects a non-exact success response %#', async (body) => {
    const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch

    await expect(resolveWith(
      createIkunDescriptor(REQUEST_KEY),
      'kw:ABC123:320k',
      fetchImpl,
    )).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it.each([
    [{ code: 429 }, 'rate_limited'],
    [{ code: 403 }, 'unavailable'],
    [{ code: 500 }, 'unavailable'],
    [{ code: 999 }, 'invalid_response'],
    [{ code: '403' }, 'invalid_response'],
    [{ code: 200, url: MEDIA_URL }, null],
  ] as const)('classifies application response %# without exposing its URL', (body, error) => {
    expect(classifyIkunResponseError(body)).toBe(error)
  })

  it.each([
    [{ code: 429, message: 'slow down' }, 'rate_limited'],
    [{ code: 429 }, 'rate_limited'],
    [{ code: 403, message: 'forbidden' }, 'unavailable'],
    [{ code: 500 }, 'unavailable'],
    [{ code: 999 }, 'invalid_response'],
    [{ code: '403' }, 'invalid_response'],
    [{ nope: true }, 'invalid_response'],
  ] as const)(
    'propagates application failure %# through the real resolver without retry',
    async (body, error) => {
      const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch

      await expect(resolveWith(
        createIkunDescriptor(REQUEST_KEY),
        'kw:ABC123:320k',
        fetchImpl,
      )).resolves.toEqual({ ok: false, error })
      expect(fetchImpl).toHaveBeenCalledOnce()
    },
  )

  it('never leaks the request key or resolver origin in a propagated failure', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      code: 429,
      message: `private detail ${MEDIA_URL}`,
    })) as unknown as typeof fetch

    const result = await resolveWith(
      createIkunDescriptor(REQUEST_KEY),
      'kw:ABC123:320k',
      fetchImpl,
    )

    expect(result).toEqual({ ok: false, error: 'rate_limited' })
    expect(JSON.stringify(result)).not.toContain(REQUEST_KEY)
    expect(JSON.stringify(result)).not.toContain('media.example')
    expect(JSON.stringify(result)).not.toContain('resolver.example')
  })
})

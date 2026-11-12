import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import { GdStudioBudget, getSharedGdStudioBudget, resetSharedGdStudioBudget } from '../gdStudio/budget'
import { createPlaybackQualityPreferencesStore } from '../qualityPreferences'
import { createGdStudioProvider } from './gdStudio'

const ORIGIN = window.location.origin
const NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const track = (sources: Track['sources']): Track => ({ id: 'canonical', title: 'Exact track', sources }) as Track
const at = (response: Response): Response => {
  Object.defineProperty(response, 'url', { value: ORIGIN + '/api/providers/gd-studio/resolve' })
  return response
}
const playableResponse = (externalId: string) => at(Response.json({
  url: '/api/providers/gd-studio/media/' + encodeURIComponent(externalId) + '/' + NONCE,
  mimeType: 'audio/mpeg',
}))
const budget = () => new GdStudioBudget({ channelName: null, storage: null })

afterEach(() => resetSharedGdStudioBudget())

describe('standalone official GD Studio provider', () => {
  it('derives an exact NetEase binding without changing the canonical track or executing LX', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse('netease:9000000002:320'))
    const sourceTrack = track([{ provider: 'chksz', externalId: '9000000002' }])
    const snapshot = JSON.stringify(sourceTrack)
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    expect(provider.canResolve?.(sourceTrack)).toBe(true)
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(fetchImpl).toHaveBeenCalledWith(ORIGIN + '/api/providers/gd-studio/resolve', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ externalId: 'netease:9000000002:320' }), redirect: 'error',
    }))
    expect(result?.kind).toBe('audio')
    expect(JSON.stringify(sourceTrack)).toBe(snapshot)
  })

  it('keeps an explicit GD Studio mapping ahead of a derived NetEase mapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse('netease:42:128'))
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    await provider.resolve(track([
      { provider: 'chksz', externalId: '9000000002' },
      { provider: 'gd-studio', externalId: 'netease:42:128' },
    ]), new AbortController().signal)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ externalId: 'netease:42:128' })
  })

  it.each(['', 'not-a-number', '9000000002/trick', 'https://private.invalid/track'])('does not guess an invalid canonical NetEase binding: %s', async (id) => {
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    const invalid = track([{ provider: 'chksz', externalId: id }])
    expect(provider.canResolve?.(invalid)).toBe(false)
    expect(await provider.resolve(invalid, new AbortController().signal)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses the shared GD Studio request window, including requests already spent by LX', async () => {
    const shared = budget()
    for (let index = 0; index < 40; index++) expect(shared.tryAcquire().ok).toBe(true)
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: shared })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('defaults to the same page-wide budget used by LX network admissions', async () => {
    const shared = getSharedGdStudioBudget()
    for (let index = 0; index < 40; index++) expect(shared.tryAcquire().ok).toBe(true)
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('honours upstream 429 Retry-After for later standalone or LX admissions', async () => {
    const shared = budget()
    const fetchImpl = vi.fn().mockResolvedValue(at(new Response('', { status: 429, headers: { 'retry-after': '60' } })))
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: shared })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(shared.tryAcquire()).toMatchObject({ ok: false, reason: 'backing_off' })
  })
})


it('sends each newly selected GD quality without rebuilding the provider or changing the track', async () => {
  const qualityStore = createPlaybackQualityPreferencesStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const fetchImpl = vi.fn(async (_input, init) => playableResponse(JSON.parse(String(init?.body)).externalId))
  const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget(), qualityStore })
  const sourceTrack = track([{ provider: 'gd-studio', externalId: 'tencent:42:128' }])
  for (const quality of ['999', '740', '320', '192', '128', 'auto'] as const) {
    qualityStore.setGdStudioQuality(quality)
    await provider.resolve(sourceTrack, new AbortController().signal)
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))).toEqual({ externalId: `tencent:42:${quality === 'auto' ? '128' : quality}` })
  }
  expect(sourceTrack.sources[0]?.externalId).toBe('tencent:42:128')
})

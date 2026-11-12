import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChkszDenied, RUNTIME_DENYLIST } from '../../src/shared/chkszDiscovery'
import { discoverChkszTrack } from '../providers/chkszDiscoveryService'
import * as discoveryStore from '../providers/chkszDiscoveryStore'
import type { D1Database } from '../env'

// Policy already distributed in public commit 14cb87df; changing it requires a policy review.
const APPROVED_POLICY_SHA256 = '766f28f3c55882425462d9839cabc6e0447f17d73cefc002647a14986f124516'

afterEach(() => vi.restoreAllMocks())

describe('published Chksz denial protection', () => {
  it('preserves the reviewed runtime policy rather than a demonstration replacement', () => {
    expect(createHash('sha256').update(JSON.stringify(RUNTIME_DENYLIST)).digest('hex'))
      .toBe(APPROVED_POLICY_SHA256)
  })

  it('rejects every denied static pair before accepting catalogue truth or contacting upstream', async () => {
    const readStatic = vi.spyOn(discoveryStore, 'readStaticChkszSource')
    const fetchMock = vi.fn(async () => { throw new Error('Denied bindings must not contact upstream') })
    for (const pair of RUNTIME_DENYLIST.entries) {
      expect(isChkszDenied(pair.canonical_track_id, pair.provider_external_id).blocked).toBe(true)
      readStatic.mockResolvedValue({ externalId: pair.provider_external_id, sourceStatus: 'active' })
      await expect(discoverChkszTrack(pair.canonical_track_id, { title: 'Synthetic metadata' },
        'synthetic-test-key', {} as D1Database, { fetch: fetchMock }))
        .resolves.toEqual({ ok: false, error: 'denylisted', source: 'static' })
    }
    expect(readStatic).toHaveBeenCalledTimes(RUNTIME_DENYLIST.entries.length)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves access to ordinary static bindings', async () => {
    vi.spyOn(discoveryStore, 'readStaticChkszSource')
      .mockResolvedValue({ externalId: 'synthetic-unlisted-external', sourceStatus: 'active' })
    const fetchMock = vi.fn(async () => { throw new Error('Static bindings need no upstream lookup') })
    await expect(discoverChkszTrack('synthetic-unlisted-track', { title: 'Synthetic metadata' },
      'synthetic-test-key', {} as D1Database, { fetch: fetchMock }))
      .resolves.toEqual({ ok: true, externalId: 'synthetic-unlisted-external', confidence: 'EXACT', source: 'static' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// Wave E exploration (task 17, H-01 / design Property 14, D1 = B). Encodes the expected behaviour,
// so it FAILS on the unfixed tree: an LX request or returned media URL whose origin the CSP does
// not list is handed to the browser, which refuses it, and the user sees a generic code instead of
// `csp_blocked`. No LX_ALLOWED_ORIGINS is configured here, so every generated origin is non-listed.
// The browser half of the same finding is tests/e2e-policy/h01-lx-csp-blocked.spec.ts.
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../../catalog/types'
import type { LxRuntimeClient } from '../lx/runtime/client'
import { QuickJsLxHost } from '../lx/runtime/quickjsHost'
import type { LxSourceRecord, LxSourceRepository } from '../lx/types'
import { createLxUserProvider } from './lxUser'
import type { ProviderAttempt } from './types'

// Hosts outside every origin the production CSP lists ('self', R2, api.chksz.com, *.music.126.net).
const nonListedUrl = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9]{1,12}$/u), fc.constantFrom('api/url?id=1315196858', 'media/track.mp3', 'x'))
  .map(([label, rest]) => `https://${label}.lx-fixture.invalid/${rest}`)

const track: Track = {
  id: 'track-h01',
  title: 'H01 Fixture',
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'wg-h01',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [{ provider: 'chksz', externalId: '1315196858' }],
}

const source: LxSourceRecord = {
  id: 'builtin-h01-fixture',
  name: 'H01 Fixture',
  sha256: 'sha256-h01',
  enabled: true,
  priority: 0,
  script: '// fixture',
  builtIn: true,
  importedAt: 1,
  updatedAt: 1,
}

const repository: LxSourceRepository = {
  list: async () => [source],
  get: async () => source,
  setEnabled: async () => undefined,
  reorder: async () => undefined,
  delete: async () => undefined,
  importScript: vi.fn(),
  importRemote: vi.fn(),
  refreshRemote: vi.fn(),
} as unknown as LxSourceRepository

describe('LX traffic outside the CSP fails early with csp_blocked (Property 14)', () => {
  let host: QuickJsLxHost | null = null
  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('refuses a returned media URL on a non-listed origin with csp_blocked instead of handing it to the media element', async () => {
    await fc.assert(
      fc.asyncProperty(nonListedUrl, async (url) => {
        const attempts: ProviderAttempt[] = []
        const provider = createLxUserProvider({
          sourceRepository: repository,
          qualityStore: { lxQuality: () => 'standard' },
          onSubAttempt: (attempt) => attempts.push(attempt),
          runtimeClientFactory: () => ({
            loadSource: async () => ({ initedMeta: undefined }),
            callMusicUrl: async () => ({ url }),
            dispose: async () => undefined,
          }) as unknown as LxRuntimeClient,
        })
        const playable = await provider.resolve(track, new AbortController().signal)
        expect({ playable, codes: attempts.map((attempt) => attempt.code ?? 'ok') }, url).toEqual({ playable: null, codes: ['csp_blocked'] })
      }),
      { numRuns: 20, endOnFailure: true },
    )
  })

  it('refuses lx.request to a non-listed origin before any network use, reporting csp_blocked', async () => {
    const fetch = vi.fn(async () => Response.json({ url: 'https://unused.invalid/' }))
    host = await QuickJsLxHost.create({ fetch: fetch as unknown as typeof globalThis.fetch })
    await fc.assert(
      fc.asyncProperty(nonListedUrl, async (url) => {
        fetch.mockClear()
        await host!.evalCode(`globalThis.__h01 = null; lx.request(${JSON.stringify(url)}, { method: 'get' }, (err) => { globalThis.__h01 = err ? String(err.message) : 'no-error' })`)
        for (let wait = 0; wait < 50 && (await host!.evalCode('globalThis.__h01')) === null; wait++) await new Promise((resolve) => setTimeout(resolve, 10))
        const error = await host!.evalCode('globalThis.__h01')
        expect({ fetched: fetch.mock.calls.length, error }, url).toEqual({ fetched: 0, error: expect.stringContaining('csp_blocked') })
      }),
      { numRuns: 10, endOnFailure: true },
    )
  })
})

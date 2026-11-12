import type { Track, TrackSource } from '../../catalog/types'
import { isChkszExternalId } from '../../../shared/chksz'
import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import { ProviderResolveError, type AudioProvider, type Playable } from './types'

const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

function isCanonicalTrackId(value: string): boolean {
  // Require the entire match: JavaScript's $ also accepts a trailing line break.
  return TRACK_ID_PATTERN.exec(value)?.[0] === value
}

function mappedSource(track: Track): TrackSource | undefined {
  if (!isCanonicalTrackId(track.id)) return undefined
  const eligible = track.sources.some((source) =>
    (source.provider === 'vkeys' && source.externalId === track.id) ||
    (source.provider === 'chksz' && isChkszExternalId(source.externalId) &&
      source.externalId === source.externalId.trim()),
  )
  return eligible ? { provider: 'vkeys', externalId: track.id } : undefined
}

/** Same-origin resolution; the server's trusted catalogue index decides the exact binding. */
export function createVkeysProvider(options: Pick<ServerProxyProviderOptions, 'fetch'> = {}): AudioProvider {
  const proxy = createServerProxyProvider('vkeys', 'vkeys', {
    fetch: options.fetch,
    validateExternalId: isCanonicalTrackId,
    includeExpiry: true,
  })
  return {
    id: 'vkeys',
    canResolve: (track) => Boolean(mappedSource(track)),
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw signal.reason ?? new DOMException('Vkeys resolution aborted', 'AbortError')
      if (!isCanonicalTrackId(track.id)) throw new ProviderResolveError('invalid_response')
      const source = mappedSource(track)
      if (!source) return null
      // Only this request gains a Vkeys source; canonical catalogue sources stay intact.
      return proxy.resolve({
        ...track,
        sources: [source, ...track.sources.filter((candidate) => candidate.provider !== 'vkeys')],
      }, signal)
    },
  }
}

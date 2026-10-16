import type { Track } from '../../catalog/types'
import { isChkszExternalId } from '../../../shared/chksz'

export interface LxTrackCandidate {
  source: string
  id: string
}

/**
 * Derives candidate playback targets (platform source + track ID) from a Track's sources.
 *
 * Precedence:
 * 1. Valid numeric ChKSz external ID binding -> { source: 'wy', id: source.externalId }
 *    (ChKSz uses NetEase / wy IDs).
 * 2. Legacy lx-ikun / lx-huibq bindings -> parse source and ID, stripping quality suffixes.
 * 3. Deduplicate identical (source, id) pairs while preserving precedence order.
 */
export function deriveLxCandidates(track: Track): LxTrackCandidate[] {
  if (!track || !Array.isArray(track.sources)) {
    return []
  }

  const candidates: LxTrackCandidate[] = []
  const seen = new Set<string>()

  const addCandidate = (source: string, id: string): void => {
    const key = `${source}:${id}`
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push({ source, id })
    }
  }

  // Precedence 1: ChKSz bindings (NetEase wy)
  for (const source of track.sources) {
    if (source.provider === 'chksz' && isChkszExternalId(source.externalId)) {
      addCandidate('wy', source.externalId)
    }
  }

  // Precedence 2: Legacy LX bindings (lx-ikun, lx-huibq, lx-*, lx)
  for (const source of track.sources) {
    if (
      source.provider === 'lx' ||
      source.provider === 'lx-ikun' ||
      source.provider === 'lx-huibq' ||
      source.provider.startsWith('lx-')
    ) {
      if (typeof source.externalId !== 'string') continue
      const parts = source.externalId.split(':')
      if (parts.length >= 2) {
        const platform = parts[0].trim().toLowerCase()
        const id = parts[1].trim()
        if (platform.length > 0 && id.length > 0) {
          addCandidate(platform, id)
        }
      }
    }
  }

  return candidates
}

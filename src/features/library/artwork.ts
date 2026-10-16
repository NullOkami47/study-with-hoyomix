/**
 * Decorative and real album artwork for catalogue entities.
 *
 * ## Architecture & Resolution Pipeline
 *
 * Each album card and track row resolves a real cover image whenever available:
 * 1. Primary candidate: `/api/providers/jellyfin/artwork/:itemId` (proxied by the Worker
 *    with upstream authorization, strict CSP, and `Cache-Control: public, max-age=3600`).
 * 2. Fallback candidate: If Jellyfin is absent or returns an error, fallback to ChKSz via
 *    `POST /api/providers/chksz/resolve`, which returns `/api/providers/chksz/artwork?url=...`
 *    (proxied with strict CSP and `Cache-Control: public, max-age=86400`).
 * 3. Graceful fallback: If neither is available or both fail, render the deterministic
 *    FNV-1a gradient fallback. No broken-image icons are ever displayed.
 *
 * ## Quota, Concurrency & Caching Guardrails
 *
 * - Artwork resolution is visual enhancement only and never blocks `/api/catalogue`.
 * - Zero Cloudflare D1 writes or reads.
 * - In-memory cache deduplicates requests across cards and track rows sharing the same album.
 * - Bounded concurrency queue (max 4 concurrent ChKSz resolve requests) avoids request storms.
 * - Browser native `loading="lazy"` and `decoding="async"` ensure only visible/near-visible
 *   cards fetch images.
 */

import {
  computed,
  ref,
  shallowReactive,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'

import type { Track, TrackSource } from '../catalog/types'
import type { AlbumEntry } from './catalogueIndex'

/** FNV-1a, 32-bit. Small, dependency-free, and stable across engines. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * A CSS gradient for `seed`, to be applied as the `--artwork` custom property.
 * Used as the deterministic fallback whenever real artwork is unavailable or loading.
 */
export function placeholderArtwork(seed: string): string {
  const hash = hashSeed(seed)
  const hue = hash % 360
  const secondary = (hue + 48) % 360
  return `linear-gradient(145deg, hsl(${hue}, 58%, 42%), hsl(${secondary}, 52%, 22%))`
}

const MAX_CONCURRENT_RESOLVES = 4
let activeResolves = 0
const queue: (() => void)[] = []

/** In-memory cache mapping artwork key (e.g. `album:${title}` or `track:${id}`) to resolved URL or null (failed). */
const artworkCache = shallowReactive(new Map<string, string | null>())
const inFlightResolves = new Map<string, Promise<string | null>>()

export function clearArtworkCache(): void {
  artworkCache.clear()
  inFlightResolves.clear()
  queue.length = 0
  activeResolves = 0
}

function enqueueResolve<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      activeResolves++
      try {
        const result = await task()
        resolve(result)
      } catch (err) {
        reject(err)
      } finally {
        activeResolves--
        if (queue.length > 0) {
          const next = queue.shift()!
          next()
        }
      }
    }

    if (activeResolves < MAX_CONCURRENT_RESOLVES) {
      void run()
    } else {
      queue.push(run)
    }
  })
}

function findSource(track: Track | undefined, provider: string): TrackSource | undefined {
  return track?.sources?.find((s) => s.provider === provider)
}

export function getJellyfinArtworkUrl(externalId: string): string {
  return `/api/providers/jellyfin/artwork/${encodeURIComponent(externalId)}`
}

export function isValidArtworkUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false
  if (
    url.startsWith('/api/providers/chksz/artwork?url=') ||
    url.startsWith('/api/providers/jellyfin/artwork/')
  ) {
    return true
  }
  try {
    const origin =
      typeof globalThis.location?.origin === 'string'
        ? globalThis.location.origin
        : 'http://localhost'
    const parsed = new URL(url, origin)
    return (
      (parsed.pathname.startsWith('/api/providers/chksz/artwork') ||
        parsed.pathname.startsWith('/api/providers/jellyfin/artwork')) &&
      parsed.origin === origin
    )
  } catch {
    return false
  }
}

export async function fetchChkszArtwork(externalId: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch('/api/providers/chksz/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalId, level: 'standard' }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = (await response.json()) as { metadata?: { artworkUrl?: string } }
    const url = data?.metadata?.artworkUrl
    if (typeof url === 'string' && isValidArtworkUrl(url)) {
      return url
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveChkszArtwork(key: string, externalId: string): Promise<string | null> {
  const cached = artworkCache.get(key)
  if (cached !== undefined) return cached

  const existing = inFlightResolves.get(key)
  if (existing) return existing

  const promise = enqueueResolve(() => fetchChkszArtwork(externalId))
  inFlightResolves.set(key, promise)

  try {
    const result = await promise
    artworkCache.set(key, result)
    return result
  } catch {
    artworkCache.set(key, null)
    return null
  } finally {
    inFlightResolves.delete(key)
  }
}

export interface UseArtworkResult {
  artworkUrl: Ref<string | undefined>
  isLoaded: Ref<boolean>
  hasFailed: Ref<boolean>
  onLoad: () => void
  onError: () => void
}

export function useArtwork(
  keyRef: MaybeRefOrGetter<string>,
  trackRef: MaybeRefOrGetter<Track | undefined>,
): UseArtworkResult {
  const artworkUrl = ref<string>()
  const isLoaded = ref(false)
  const hasFailed = ref(false)
  let currentKey = ''
  let currentCandidatePhase: 'jellyfin' | 'chksz' | 'none' = 'none'

  const update = () => {
    const key = toValue(keyRef)
    const track = toValue(trackRef)
    currentKey = key
    isLoaded.value = false
    hasFailed.value = false

    // Check cache first
    const cached = artworkCache.get(key)
    if (cached !== undefined) {
      if (cached === null) {
        hasFailed.value = true
        artworkUrl.value = undefined
        currentCandidatePhase = 'none'
      } else {
        artworkUrl.value = cached
        currentCandidatePhase = cached.includes('/jellyfin/') ? 'jellyfin' : 'chksz'
      }
      return
    }

    if (!track) {
      hasFailed.value = true
      artworkUrl.value = undefined
      currentCandidatePhase = 'none'
      return
    }

    const jellyfin = findSource(track, 'jellyfin')
    const chksz = findSource(track, 'chksz')

    if (jellyfin) {
      currentCandidatePhase = 'jellyfin'
      artworkUrl.value = getJellyfinArtworkUrl(jellyfin.externalId)
    } else if (chksz) {
      currentCandidatePhase = 'chksz'
      artworkUrl.value = undefined
      void resolveChkszArtwork(key, chksz.externalId).then((url) => {
        if (currentKey !== key) return
        if (url) {
          artworkUrl.value = url
        } else {
          hasFailed.value = true
          artworkUrl.value = undefined
        }
      })
    } else {
      currentCandidatePhase = 'none'
      hasFailed.value = true
      artworkUrl.value = undefined
      artworkCache.set(key, null)
    }
  }

  watch(() => [toValue(keyRef), toValue(trackRef)], update, { immediate: true })

  const onLoad = () => {
    isLoaded.value = true
    if (artworkUrl.value) {
      artworkCache.set(currentKey, artworkUrl.value)
    }
  }

  const onError = () => {
    const key = currentKey
    const track = toValue(trackRef)

    if (currentCandidatePhase === 'jellyfin') {
      const chksz = findSource(track, 'chksz')
      if (chksz) {
        currentCandidatePhase = 'chksz'
        isLoaded.value = false
        artworkUrl.value = undefined
        void resolveChkszArtwork(key, chksz.externalId).then((url) => {
          if (currentKey !== key) return
          if (url) {
            artworkUrl.value = url
          } else {
            hasFailed.value = true
            artworkUrl.value = undefined
            artworkCache.set(key, null)
          }
        })
        return
      }
    }

    hasFailed.value = true
    artworkUrl.value = undefined
    currentCandidatePhase = 'none'
    artworkCache.set(key, null)
  }

  return {
    artworkUrl,
    isLoaded,
    hasFailed,
    onLoad,
    onError,
  }
}

export function useAlbumArtwork(
  albumRef: MaybeRefOrGetter<AlbumEntry>,
): UseArtworkResult {
  const album = computed(() => toValue(albumRef))
  const key = computed(() => `album:${album.value.title}`)
  const track = computed(() => album.value.representativeTrack)
  return useArtwork(key, track)
}

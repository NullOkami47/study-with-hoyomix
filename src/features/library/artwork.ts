/**
 * Decorative and real album artwork for catalogue entities.
 *
 * ## Architecture & Resolution Pipeline
 *
 * Each album card and track row resolves a real cover image whenever available:
 * 1. Canonical NetEase bindings use the existing LX/GD artwork GET routes, without audio
 *    resolution or a ChKSz key. Both retain their server-side provider enablement guards.
 * 2. Legacy fallback: If those candidates are unavailable, fallback to ChKSz via
 *    `POST /api/providers/chksz/resolve`, which returns `/api/providers/chksz/artwork?url=...`
 *    (proxied with strict CSP and `Cache-Control: public, max-age=86400`).
 * 3. Graceful fallback: If every candidate fails, render the deterministic
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
  getCurrentInstance,
  getCurrentScope,
  inject,
  nextTick,
  onMounted,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'

import type { Track, TrackSource } from '../catalog/types'
import type { AlbumEntry } from './catalogueIndex'
import { isChkszExternalId } from '../../shared/chksz'
import { deriveLxCandidates } from '../player/lx/candidates'
import { publicArtworkUrl, sharedArtworkCache, type ArtworkLease } from './artworkCache'
import { artworkPermissionsKey } from './artworkPermissions'

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

// Bounded metadata-resolution memo only. Displayed bytes belong exclusively to sharedArtworkCache.
const artworkCache = new Map<string, { url: string | null; until: number }>()
const inFlightResolves = new Map<string, Promise<string | null>>()
const resolutionControllers = new Set<AbortController>()
let cacheEpoch = 0
function readCachedArtwork(key: string): string | null | undefined {
  const entry = artworkCache.get(key)
  if (entry && entry.until > Date.now()) return entry.url
  artworkCache.delete(key)
}
function cacheArtwork(key: string, url: string | null): void {
  if (url && !publicArtworkUrl(url)) return
  artworkCache.delete(key)
  artworkCache.set(key, { url, until: Date.now() + 30000 })
  while (artworkCache.size > 64) artworkCache.delete(artworkCache.keys().next().value!)
}
export function clearArtworkCache(): void {
  cacheEpoch++
  for (const controller of resolutionControllers) controller.abort()
  resolutionControllers.clear()
  sharedArtworkCache.clear()
  artworkCache.clear()
  inFlightResolves.clear()
}

function findSource(track: Track | undefined, provider: string): TrackSource | undefined {
  return track?.sources?.find((s) => s.provider === provider)
}

function neteaseArtworkCandidates(track: Track | undefined): string[] {
  if (!track) return []
  const binding = deriveLxCandidates(track).find(candidate => candidate.source === 'wy' && isChkszExternalId(candidate.id))
  const explicit = findSource(track, 'gd-studio')?.externalId.match(/^netease:([0-9]{1,20})(?::(?:128|192|320|740|999))?$/u)?.[1]
  const id = binding?.id ?? explicit
  if (!id) return []
  const providers = binding ? ['lx','gd-studio'] : ['gd-studio','lx']
  return providers.map(provider => `/api/providers/${provider}/artwork/${id}`)
}

/** Uses the same candidates as image loading; never resolves audio to choose a cover. */
export function hasArtworkSource(track: Track | undefined): boolean {
  return Boolean(findSource(track, 'chksz') || neteaseArtworkCandidates(track).length)
}

export function isValidArtworkUrl(url: string): boolean {
  return Boolean(publicArtworkUrl(url))
}

export async function fetchChkszArtwork(externalId: string, signal?: AbortSignal): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  let onAbort = () => {}
  try {
    if (controller.signal.aborted) return null
    return await Promise.race([
      (async () => {
        const response = await fetch('/api/providers/chksz/resolve', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ externalId, level: 'standard' }), signal: controller.signal,
        })
        if (!response.ok || controller.signal.aborted) return null
        const data = (await response.json()) as { metadata?: { artworkUrl?: string } }
        const url = data?.metadata?.artworkUrl
        return !controller.signal.aborted && typeof url === 'string' && isValidArtworkUrl(url) ? url : null
      })(),
      new Promise<null>(resolve => {
        onAbort = () => resolve(null)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

export async function resolveChkszArtwork(key: string, externalId: string): Promise<string | null> {
  const cached = readCachedArtwork(key)
  if (cached !== undefined) return cached
  const identity = 'chksz:' + externalId
  const existing = inFlightResolves.get(identity)
  if (existing) return existing
  const epoch = cacheEpoch
  const controller = new AbortController()
  resolutionControllers.add(controller)
  // Every observer receives the epoch-checked promise, including callers that join it.
  // Check again at execution time: clearing a queue must not start old provider requests.
  const promise = sharedArtworkCache.schedule(() => epoch === cacheEpoch && !controller.signal.aborted
    ? fetchChkszArtwork(externalId, controller.signal) : Promise.resolve(null))
    .then(result => epoch === cacheEpoch ? result : null, () => null)
    .finally(() => resolutionControllers.delete(controller))
  inFlightResolves.set(identity, promise)
  try {
    const result = await promise
    if (epoch === cacheEpoch) cacheArtwork(key, result)
    return epoch === cacheEpoch ? result : null
  } catch {
    if (epoch === cacheEpoch) cacheArtwork(key, null)
    return null
  } finally {
    if (inFlightResolves.get(identity) === promise) inFlightResolves.delete(identity)
  }
}

export interface UseArtworkResult {
  artworkUrl: Ref<string | undefined>
  sourceUrl: Ref<string | undefined>
  element: Ref<HTMLElement | undefined>
  identity: Readonly<Ref<string>>
  isLoaded: Ref<boolean>
  hasFailed: Ref<boolean>
  onLoad: (event?: Event) => void
  onError: (event?: Event) => void
}

export function useArtwork(
  keyRef: MaybeRefOrGetter<string>,
  trackRef: MaybeRefOrGetter<Track | undefined>,
  options: { candidates?: MaybeRefOrGetter<readonly string[]>; player?: boolean; waiting?: MaybeRefOrGetter<boolean>;
    retainedSource?: MaybeRefOrGetter<string | undefined>;
    retainedDisplaySource?: MaybeRefOrGetter<string | undefined> } = {},
): UseArtworkResult {
  const artworkUrl = ref<string>()
  const sourceUrl = ref<string>()
  const element = ref<HTMLElement>()
  const isLoaded = ref(false)
  const hasFailed = ref(false)
  const component = getCurrentInstance()
  const permissions = component ? inject(artworkPermissionsKey, undefined) : undefined
  const permitted = (url: string) => !permissions || permissions.allows(url)
  let visible = !component || options.player === true || typeof IntersectionObserver === 'undefined'
  let disposed = false, revision = 0, retryCount = 0
  let displaySource: string | undefined
  let displayed: ArtworkLease | undefined, pending: ArtworkLease | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stopCapacity: (() => void) | undefined
  let observer: IntersectionObserver | undefined
  const selectedCandidates = () => (options.candidates ? [...toValue(options.candidates)] : neteaseArtworkCandidates(toValue(trackRef)))
    .flatMap(value => { const url = publicArtworkUrl(value); return url && permitted(url) ? [url] : [] })
  const identity = computed(() => JSON.stringify([toValue(keyRef), selectedCandidates()]))
  // Vue consumers (including CompactPlayback) must finish replacing their DOM src before
  // the last old lease can revoke it. A pending request never owns the displayed cover.
  const releaseAfterRender = (lease?: ArtworkLease) => { if (lease) void nextTick(() => lease.release()) }
  const stopRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined }
  const clearDisplay = () => {
    const old = displayed; displayed = undefined; displaySource = undefined
    artworkUrl.value = undefined; sourceUrl.value = undefined; isLoaded.value = false
    releaseAfterRender(old)
  }
  const cancelPending = () => { pending?.release(); pending = undefined; stopRetry(); stopCapacity?.(); stopCapacity = undefined }
  const acquire = async (token: number) => {
    if (!visible || disposed || token !== revision) return
    const candidates = selectedCandidates()
    let capacityVersion: number | undefined
    const tryCandidate = async (candidate: string) => {
      if (token !== revision || disposed || !visible || !permitted(candidate)) return false
      const next = sharedArtworkCache.acquire(candidate, { pin: options.player === true })
      pending = next
      const result = await next.ready
      if (token !== revision || disposed || !visible || !permitted(candidate)) { next.release(); return false }
      if (pending === next) pending = undefined
      if (!result) {
        if (next.capacityLimited) capacityVersion = next.capacityVersion
        next.release(); return false
      }
      const old = displayed
      displayed = next; displaySource = result.sourceUrl
      artworkUrl.value = result.url; sourceUrl.value = result.sourceUrl
      isLoaded.value = true; hasFailed.value = false
      releaseAfterRender(old)
      return true
    }
    for (const candidate of candidates) if (await tryCandidate(candidate)) return
    if (token !== revision || disposed || !visible) return
    const waitForCapacity = () => {
      if (capacityVersion === undefined) return false
      // A crowded viewport waits for an actual release, with no network retry loop.
      stopCapacity?.()
      stopCapacity = sharedArtworkCache.onCapacityAvailable(() => {
        stopCapacity = undefined
        if (token === revision && visible && !disposed) void acquire(token)
      }, capacityVersion)
      return true
    }
    if (waitForCapacity()) return
    // Keep the existing Library-only metadata fallback; Player never resolves audio for artwork.
    if (!options.candidates) {
      const source = findSource(toValue(trackRef), 'chksz')
      if (source && permitted('/api/providers/chksz/artwork?url=')) {
        const fallback = await resolveChkszArtwork(toValue(keyRef), source.externalId)
        if (token !== revision || disposed || !visible) return
        if (fallback && !candidates.includes(fallback) && await tryCandidate(fallback)) return
      }
    }
    if (token !== revision || disposed || !visible) return
    if (waitForCapacity()) return
    const retained = publicArtworkUrl(toValue(options.retainedSource) || '')
    if (retained && permitted(retained) && retained === displaySource && displayed) {
      sourceUrl.value = displaySource; hasFailed.value = false
    } else {
      clearDisplay(); hasFailed.value = true
    }
    // One automatic retry per visible identity, only for a short transient cooldown.
    // Security refusals and a server's longer Retry-After are never polled in a loop.
    const retryAt = candidates.map(value => sharedArtworkCache.retryAt(value)).filter((value): value is number => value !== undefined)
    const delay = Math.min(...retryAt) - Date.now()
    if (retryCount < 1 && delay > 0 && delay <= 90000) {
      retryCount++
      retryTimer = setTimeout(() => { retryTimer = undefined; void acquire(token) }, delay)
    }
  }
  const update = () => {
    revision++; cancelPending(); retryCount = 0; hasFailed.value = false
    const candidates = selectedCandidates()
    if (displaySource && !permitted(displaySource)) clearDisplay()
    // Same validated binding survives track changes, equivalent objects and audio renewals.
    if (displayed && displaySource && candidates.includes(displaySource)) {
      sourceUrl.value = displaySource
      return
    }
    sourceUrl.value = undefined
    if (!candidates.length && toValue(options.waiting)) return
    if (!candidates.length && (options.candidates || !findSource(toValue(trackRef), 'chksz'))) {
      clearDisplay(); hasFailed.value = true; return
    }
    if (visible && (!component || component.isMounted)) void acquire(revision)
  }
  watch(() => JSON.stringify([toValue(keyRef), selectedCandidates(), findSource(toValue(trackRef), 'chksz')?.externalId, permissions?.revision.value]), update, { immediate: true })
  watch(() => toValue(options.waiting), () => { if (!selectedCandidates().length) update() })
  watch(() => toValue(options.retainedDisplaySource ?? options.retainedSource), (retained, previous) => {
    const old = publicArtworkUrl(previous || '')
    if (!old || old === publicArtworkUrl(retained || '') || displaySource !== old || selectedCandidates().includes(old)) return
    clearDisplay(); hasFailed.value = !pending
  })
  if (component) onMounted(() => {
    if (options.player || typeof IntersectionObserver === 'undefined') { visible = true; void acquire(revision); return }
    observer = new IntersectionObserver(entries => {
      const next = entries.some(entry => entry.isIntersecting)
      if (visible === next) return
      visible = next
      if (visible) void acquire(revision)
      else { revision++; cancelPending(); clearDisplay() }
    }, { rootMargin: '160px' })
    if (element.value) observer.observe(element.value)
  })
  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true; revision++; observer?.disconnect(); cancelPending(); clearDisplay()
  })
  const currentEvent = (event?: Event) => {
    const image = event?.target as HTMLImageElement | undefined
    if (!image) return Boolean(sourceUrl.value)
    if (!sourceUrl.value || !artworkUrl.value) return false
    if (image.dataset.artworkIdentity && image.dataset.artworkIdentity !== identity.value) return false
    return image.src === new URL(artworkUrl.value, globalThis.location.origin).href
  }
  const onLoad = (event?: Event) => {
    if (!disposed && currentEvent(event)) isLoaded.value = true
  }
  const onError = (event?: Event) => {
    if (disposed || !currentEvent(event)) return
    const failed = displaySource
    if (failed) sharedArtworkCache.invalidate(failed)
    clearDisplay(); hasFailed.value = true
    revision++; cancelPending(); void acquire(revision)
  }
  return { artworkUrl, sourceUrl, element, identity, isLoaded, hasFailed, onLoad, onError }
}

export function useAlbumArtwork(
  albumRef: MaybeRefOrGetter<AlbumEntry>,
): UseArtworkResult {
  const album = computed(() => toValue(albumRef))
  const key = computed(() => `album:${album.value.id}`)
  const track = computed(() => album.value.representativeTrack)
  return useArtwork(key, track)
}

import { validateChkszArtworkUrl } from '../../shared/chksz'
import { artworkDimensions } from './artworkImage'

/** Ten played covers, two transition owners, and eight Library covers. No persistent storage. */
export const ARTWORK_LIMITS = Object.freeze({
  tracks: 10, assets: 20, libraryAssets: 8, concurrent: 4, fileBytes: 5 * 1024 * 1024,
  bytes: 100 * 1024 * 1024, pixels: 20 * 1024 * 1024, imagePixels: 1024 * 1024,
  timeoutMs: 8000, cooldownMs: 30000, retryWindowMs: 300000, failures: 64,
})

/** Only public identity routes and unsigned, approved NetEase image URLs can be acquired. */
export function publicArtworkUrl(value: string): string | undefined {
  try {
    const origin = globalThis.location?.origin || 'http://localhost'
    const u = new URL(value, origin)
    if (u.origin !== origin || u.username || u.password || u.hash || /[\u0000-\u0020\u007f\\]/u.test(value)) return
    const binding = /^\/api\/providers\/(lx|gd-studio)\/artwork\/([0-9]{1,20}|netease(?::|%3A)([0-9]{1,20})(?:(?::|%3A)(?:128|192|320|740|999))?)$/iu.exec(u.pathname)
    if (binding && !u.search) return `/api/providers/${binding[1]!.toLowerCase()}/artwork/${binding[3] || binding[2]}`
    if (u.pathname !== '/api/providers/chksz/artwork' || [...u.searchParams.keys()].join() !== 'url') return
    const nested = validateChkszArtworkUrl(u.searchParams.get('url'))
    if (!nested || [...nested.searchParams].some(([key, val]) => key !== 'param' || !/^[0-9]{1,4}y[0-9]{1,4}$/u.test(val))) return
    // The approved Worker always requests its fixed 512x512 rendition.
    nested.searchParams.delete('param')
    return u.pathname + '?url=' + encodeURIComponent(nested.href)
  } catch { return }
}

export interface ArtworkResource { url: string; sourceUrl: string; shared: boolean }
export interface ArtworkLease {
  ready: Promise<ArtworkResource | null>; release(): void
  readonly capacityLimited?: boolean
  readonly capacityVersion?: number
}
interface DecodedImage { naturalWidth: number; naturalHeight: number }
interface Dependencies {
  fetch?: typeof fetch
  now?: () => number
  releaseImage?: (image: DecodedImage) => void
  decode?: (url: string, signal: AbortSignal) => Promise<DecodedImage>
  digest?: (bytes: Uint8Array) => Promise<string>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  maxBytes?: number
}
interface Asset {
  hash: string; url: string; image?: DecodedImage; bytes: number; pixels: number
  entries: Set<Entry>; externalRefs: number; touched: number
}
interface Entry {
  key: string; refs: number; pins: number; browse: boolean; touched: number; controller: AbortController
  asset?: Asset; ready: Promise<ArtworkResource | null>; capacityVersion?: number
}
interface TrackBinding { candidates: readonly string[]; selected?: string }
interface Failure { start: number; attempts: number; retryAt: number }

function decodeImage(url: string, signal: AbortSignal): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', fail) }
    const fail = () => { cleanup(); image.removeAttribute('src'); reject(new Error('artwork-decode')) }
    signal.addEventListener('abort', fail, { once: true })
    image.onerror = fail
    image.onload = () => {
      // Image.onload is a validated-Blob-only fallback on engines without decode().
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
      void decoded.then(() => {
        if (signal.aborted || image.naturalWidth <= 0 || image.naturalHeight <= 0) { fail(); return }
        cleanup(); resolve(image)
      }, fail)
    }
    if (signal.aborted) { fail(); return }
    image.referrerPolicy = 'no-referrer'
    image.src = url
  })
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > ARTWORK_LIMITS.fileBytes)) throw new Error('artwork-size')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('artwork-body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > ARTWORK_LIMITS.fileBytes) throw new Error('artwork-size')
      chunks.push(value)
    }
    if (!size || length !== null && Number(length) !== size) throw new Error('artwork-size')
    const all = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length }
    return all
  } finally { await reader.cancel().catch(() => {}) }
}

export function createArtworkCache(deps: Dependencies = {}) {
  const clock = deps.now || Date.now
  const releaseImage = deps.releaseImage || ((image: DecodedImage) => {
    if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) image.removeAttribute('src')
  })
  const decode = deps.decode || decodeImage
  const createObjectURL = deps.createObjectURL || ((blob: Blob) => URL.createObjectURL(blob))
  const revokeObjectURL = deps.revokeObjectURL || ((url: string) => URL.revokeObjectURL(url))
  const digest = deps.digest || (async (bytes: Uint8Array) => {
    const result = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
    return [...new Uint8Array(result)].map(n => n.toString(16).padStart(2, '0')).join('')
  })
  const entries = new Map<string, Entry>(), allEntries = new Set<Entry>()
  const assets = new Map<string, Asset>(), urls = new Map<string, Asset>()
  const assetLoads = new Map<string, Promise<Asset | undefined>>()
  const reservations = new Map<Entry, { bytes: number; pixels: number; library: boolean }>()
  const failures = new Map<string, Failure>(), tracks = new Map<string, TrackBinding>()
  const capacityListeners = new Set<{ callback: () => void; active: boolean }>()
  let capacityVersion = 0, capacityNoticePending = false
  const capacityChanged = () => {
    capacityVersion++
    if (capacityNoticePending) return
    capacityNoticePending = true
    queueMicrotask(() => {
      capacityNoticePending = false
      const listeners = [...capacityListeners]
      capacityListeners.clear()
      for (const listener of listeners) if (listener.active) { listener.active = false; listener.callback() }
    })
  }
  let epoch = 0, active = 0, sequence = 0
  const queue: (() => void)[] = []
  const totals = () => [...assets.values(), ...reservations.values()].reduce((n, a) => ({ bytes: n.bytes + a.bytes, pixels: n.pixels + a.pixels }), { bytes: 0, pixels: 0 })
  const retained = (entry: Entry) => entries.get(entry.key) === entry && [...tracks.values()].some(t => t.selected === entry.key || !t.selected && t.candidates.includes(entry.key))
  const playing = (asset: Asset) => asset.externalRefs > 0 || [...asset.entries].some(e => e.pins > 0 || retained(e))
  const referenced = (asset: Asset) => asset.externalRefs > 0 || [...asset.entries].some(e => e.refs > 0)
  const removeEntry = (entry: Entry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    entry.controller.abort()
    if (!entry.refs) { allEntries.delete(entry); entry.asset?.entries.delete(entry) }
  }
  const destroy = (asset: Asset) => {
    assets.delete(asset.hash); urls.delete(asset.url)
    if (asset.image) releaseImage(asset.image)
    revokeObjectURL(asset.url)
    capacityChanged()
  }
  const collect = () => {
    for (const entry of allEntries) if (!entry.refs && (!retained(entry) && (!entry.browse || entries.get(entry.key) !== entry))) removeEntry(entry)
    // Bound aliases as well as image bytes: many song bindings can share one album.
    for (const entry of [...entries.values()].sort((a, b) => a.touched - b.touched)) {
      if (entries.size <= 64) break
      if (!entry.refs && !retained(entry)) removeEntry(entry)
    }
    const library = [...assets.values()].filter(a => !playing(a)).sort((a, b) => a.touched - b.touched)
    let excess = library.length - ARTWORK_LIMITS.libraryAssets
    for (const asset of library) if (excess > 0 && !referenced(asset)) {
      for (const entry of asset.entries) removeEntry(entry)
      excess--
    }
    for (const asset of assets.values()) {
      for (const entry of asset.entries) if (!entry.refs && entries.get(entry.key) !== entry) { asset.entries.delete(entry); allEntries.delete(entry) }
      if (!asset.entries.size && !asset.externalRefs) destroy(asset)
    }
  }
  const schedule = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const run = () => {
      active++
      void Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; queue.shift()?.() })
    }
    if (active < ARTWORK_LIMITS.concurrent) run()
    else if (queue.length < 64) queue.push(run)
    else reject(new Error('artwork-queue-capacity'))
  })
  const resource = (entry: Entry): ArtworkResource | undefined => entry.asset?.image
    ? { url: entry.asset.url, sourceUrl: entry.key, shared: true } : undefined
  const fail = (key: string, retryMs: number = ARTWORK_LIMITS.cooldownMs) => {
    const time = clock(), previous = failures.get(key)
    const f = previous && time - previous.start < ARTWORK_LIMITS.retryWindowMs ? previous : { start: time, attempts: 0, retryAt: 0 }
    f.attempts++
    f.retryAt = Math.max(time + retryMs, f.attempts >= 2 ? f.start + ARTWORK_LIMITS.retryWindowMs : 0)
    failures.delete(key); failures.set(key, f)
    while (failures.size > ARTWORK_LIMITS.failures) failures.delete(failures.keys().next().value!)
  }
  const selectForTracks = (entry: Entry) => {
    for (const binding of tracks.values()) if (binding.candidates.includes(entry.key) &&
      (!binding.selected || !binding.candidates.includes(binding.selected) || !entries.get(binding.selected)?.asset)) binding.selected = entry.key
  }
  const makeRoom = (entry: Entry, byteCount: number, pixels: number) => {
    collect()
    const fits = () => {
      const total = totals(), own = reservations.get(entry)
      const libraryCount = [...assets.values()].filter(a => !playing(a)).length + [...reservations.values()].filter(r => r.library).length
      return assets.size + reservations.size - Number(Boolean(own)) < ARTWORK_LIMITS.assets &&
        total.bytes - (own?.bytes || 0) + byteCount <= (deps.maxBytes ?? ARTWORK_LIMITS.bytes) &&
        total.pixels - (own?.pixels || 0) + pixels <= ARTWORK_LIMITS.pixels &&
        (entry.pins > 0 || retained(entry) || libraryCount - Number(own?.library || false) < ARTWORK_LIMITS.libraryAssets)
    }
    for (const asset of [...assets.values()].sort((a, b) => a.touched - b.touched)) {
      if (fits()) break
      if (playing(asset) || referenced(asset)) continue
      for (const item of asset.entries) removeEntry(item)
      collect()
    }
    return fits()
  }
  const load = async (entry: Entry, version: number): Promise<ArtworkResource | null> => {
    const { key, controller } = entry
    let decoded: DecodedImage | undefined, objectUrl: string | undefined
    let retryMs: number = ARTWORK_LIMITS.cooldownMs
    const current = () => !controller.signal.aborted && epoch === version
    const discardProvisional = () => {
      if (reservations.delete(entry)) capacityChanged()
      if (decoded) { releaseImage(decoded); decoded = undefined }
      if (objectUrl) { revokeObjectURL(objectUrl); objectUrl = undefined }
    }
    controller.signal.addEventListener('abort', discardProvisional, { once: true })
    const timer = setTimeout(() => { if (current()) fail(key); controller.abort() }, ARTWORK_LIMITS.timeoutMs)
    const operation = async (): Promise<ArtworkResource | null> => {
      if (!current()) return null
      // Reserve the maximum admitted response before networking; crowded libraries do
      // not acquire and discard bytes only to acquire them again when a slot opens.
      const maxBytes = Math.min(ARTWORK_LIMITS.fileBytes, deps.maxBytes ?? ARTWORK_LIMITS.fileBytes)
      if (!makeRoom(entry, maxBytes, ARTWORK_LIMITS.imagePixels)) throw new Error('artwork-capacity')
      reservations.set(entry, { bytes: maxBytes, pixels: ARTWORK_LIMITS.imagePixels, library: entry.pins === 0 && !retained(entry) })
      const response = await (deps.fetch || globalThis.fetch)(key, {
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      if (!current()) { void response.body?.cancel(); return null }
      try {
        const origin = globalThis.location?.origin || 'http://localhost'
        if (response.redirected || response.url && new URL(response.url, origin).href !== new URL(key, origin).href) throw new Error('artwork-policy')
        if (response.status === 429) {
          const raw = response.headers.get('retry-after') || ''
          const delay = /^[0-9]+$/u.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - clock()
          if (Number.isFinite(delay)) retryMs = Math.max(retryMs, Math.min(delay, 24 * 3600000))
        }
        if (response.status !== 200) throw new Error(response.status === 429 || response.status >= 500 ? 'artwork-transient' : 'artwork-policy')
        const policy = response.headers.get('cache-control')?.toLowerCase() || ''
        const directives = policy.split(',').map(s => s.trim())
        const age = Number(response.headers.get('age') || 0)
        const maxAges = [...policy.matchAll(/(?:^|,)\s*max-age\s*=\s*([0-9]+)(?=\s*,|$)/gu)]
        const maxAge = Number(maxAges[0]?.[1] || 0)
        const vary = response.headers.get('vary')?.toLowerCase()
        if (!directives.includes('public') || directives.some(d => /^(?:private|no-store|no-cache)(?:\s*=|$)/u.test(d)) ||
          maxAges.length !== 1 || !(Number.isSafeInteger(maxAge) && maxAge > age && Number.isSafeInteger(age) && age >= 0) ||
          response.headers.has('set-cookie') || response.headers.has('set-cookie2') || vary && vary.split(',').some(s => s.trim() !== 'accept-encoding')) throw new Error('artwork-policy')
        const validUntil = clock() + Math.min(maxAge - age, 3600) * 1000
        const mime = /^\s*(image\/(?:png|jpeg|webp|gif))(?:\s*;\s*charset\s*=\s*[a-z0-9_-]+)?\s*$/iu.exec(response.headers.get('content-type') || '')?.[1]?.toLowerCase()
        if (!mime) throw new Error('artwork-policy')
        let bytes: Uint8Array | undefined = await boundedBytes(response)
        const dimensions = artworkDimensions(bytes, mime)
        if (!dimensions) throw new Error('artwork-policy')
        if (!current()) return null
        const content = mime + ':' + await digest(bytes)
        if (!current()) return null
        if (clock() >= validUntil) throw new Error('artwork-policy')
        // Different authorised bindings may contain one album. Join its decode too.
        while (assetLoads.has(content)) {
          await assetLoads.get(content)
          if (!current()) return null
        }
        if (clock() >= validUntil) throw new Error('artwork-policy')
        const existing = assets.get(content)
        if (existing?.image) {
          entry.asset = existing; existing.entries.add(entry); existing.touched = ++sequence
        } else {
          let finish!: (asset: Asset | undefined) => void
          const work = new Promise<Asset | undefined>(resolve => { finish = resolve })
          assetLoads.set(content, work)
          const abandon = () => {
            if (assetLoads.get(content) === work) assetLoads.delete(content)
            finish(undefined)
          }
          controller.signal.addEventListener('abort', abandon, { once: true })
          try {
          const pixels = dimensions.width * dimensions.height
          if (!makeRoom(entry, bytes.byteLength, pixels)) throw new Error('artwork-capacity')
          const byteCount = bytes.byteLength
          reservations.set(entry, { bytes: byteCount, pixels, library: entry.pins === 0 && !retained(entry) })
          objectUrl = createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          bytes = undefined
          decoded = await decode(objectUrl, controller.signal)
          if (!current()) return null
          // JPEG EXIF orientation may exchange width and height, but never their pixel budget.
          if (decoded.naturalWidth * decoded.naturalHeight !== pixels ||
            !((decoded.naturalWidth === dimensions.width && decoded.naturalHeight === dimensions.height) ||
              (mime === 'image/jpeg' && decoded.naturalWidth === dimensions.height && decoded.naturalHeight === dimensions.width))) throw new Error('artwork-policy')
          if (clock() >= validUntil) throw new Error('artwork-policy')
          const raced = assets.get(content)
          if (raced?.image) { entry.asset = raced; raced.entries.add(entry); raced.touched = ++sequence }
          else {
            if (!makeRoom(entry, byteCount, pixels)) throw new Error('artwork-capacity')
            const asset: Asset = { hash: content, url: objectUrl!, image: decoded, bytes: byteCount, pixels,
              entries: new Set([entry]), externalRefs: 0, touched: ++sequence }
            reservations.delete(entry)
            assets.set(content, asset); urls.set(objectUrl!, asset); entry.asset = asset
            objectUrl = undefined; decoded = undefined
          }
          } finally {
            controller.signal.removeEventListener('abort', abandon)
            if (assetLoads.get(content) === work) assetLoads.delete(content)
            finish(assets.get(content))
          }
        }
        selectForTracks(entry)
        // A paused/current cover is useful across PlayerBar remounts but does not
        // change listening recency. It shares the same eight-entry browse LRU.
        if (![...tracks.values()].some(binding => binding.selected === entry.key || binding.candidates.includes(entry.key))) entry.browse = true
        failures.delete(key)
        return resource(entry)!
      } finally { void response.body?.cancel().catch(() => {}) }
    }
    try {
      return await new Promise<ArtworkResource | null>((resolve, reject) => {
        const abort = () => resolve(null)
        controller.signal.addEventListener('abort', abort, { once: true })
        void operation().then(resolve, reject).finally(() => {
          controller.signal.removeEventListener('abort', abort)
          controller.signal.removeEventListener('abort', discardProvisional)
          discardProvisional()
          collect()
        })
      })
    } catch (error) {
      if (current()) {
        if (error instanceof Error && error.message === 'artwork-capacity') entry.capacityVersion = capacityVersion
        else fail(key, error instanceof Error && ['artwork-policy','artwork-size','artwork-body','artwork-decode'].includes(error.message)
          ? ARTWORK_LIMITS.retryWindowMs : retryMs)
      }
      return null
    } finally { clearTimeout(timer) }
  }
  const empty = (): ArtworkLease => ({ ready: Promise.resolve(null), release() {} })
  const acquire = (value: string, options: { pin?: boolean } = {}): ArtworkLease => {
    const key = publicArtworkUrl(value)
    if (!key) return empty()
    collect()
    const failure = failures.get(key)
    if (failure && clock() < failure.retryAt) return empty()
    let entry = entries.get(key)
    if (!entry && (queue.length >= 64 || allEntries.size >= 128)) return empty()
    if (!entry) {
      const version = epoch
      entry = { key, refs: 0, pins: 0, browse: options.pin === false, touched: ++sequence, controller: new AbortController(), ready: Promise.resolve(null) }
      entries.set(key, entry); allEntries.add(entry)
      const selected = entry
      entry.ready = schedule(() => load(selected, version)).then(result => {
        if (!result) removeEntry(selected)
        return result
      }, () => { removeEntry(selected); return null })
    }
    entry.refs++; entry.browse ||= options.pin === false; entry.touched = ++sequence
    if (options.pin !== false) entry.pins++
    if (entry.asset) entry.asset.touched = ++sequence
    const held = entry
    let released = false
    return { ready: entry.ready, get capacityLimited() { return held.capacityVersion !== undefined },
      get capacityVersion() { return held.capacityVersion }, release() {
      if (released) return
      released = true; held.refs--
      if (options.pin !== false) held.pins--
      if (!held.refs && !held.asset && !retained(held)) held.controller.abort()
      collect()
      if (held.asset && !referenced(held.asset)) capacityChanged()
    } }
  }
  const bind = (trackId: string, values: readonly string[]) => {
    const candidates = [...new Set(values.flatMap(v => { const key = publicArtworkUrl(v); return key ? [key] : [] }))].slice(0, 4)
    const previous = tracks.get(trackId)?.selected
    // Candidate changes do not discard a recent track's last successful image.
    // Replace it only when a currently authorised candidate has validated bytes.
    const selected = candidates.find(key => entries.get(key)?.asset) ?? previous
    tracks.set(trackId, { candidates, selected })
  }
  return {
    acquire, schedule,
    /** One-shot wakeup after a real release. Callers cancel when no longer visible. */
    onCapacityAvailable(callback: () => void, since = capacityVersion): () => void {
      const listener = { callback, active: true }
      if (capacityListeners.size >= 128) return () => {}
      capacityListeners.add(listener)
      if (since < capacityVersion) {
        queueMicrotask(() => {
          if (!listener.active) return
          listener.active = false; capacityListeners.delete(listener); callback()
        })
      }
      return () => { listener.active = false; capacityListeners.delete(listener) }
    },
    /** The native Media Session owns the same Blob independently of the current DOM node. */
    retain(url: string): (() => void) | undefined {
      const asset = urls.get(url)
      if (!asset?.image) return
      asset.externalRefs++
      let released = false
      return () => { if (!released) { released = true; asset.externalRefs--; collect(); if (!referenced(asset)) capacityChanged() } }
    },
    retryAt(value: string) { const key = publicArtworkUrl(value); return key ? failures.get(key)?.retryAt : undefined },
    peek(value: string) { const key = publicArtworkUrl(value), entry = key ? entries.get(key) : undefined; return entry ? resource(entry) : undefined },
    played(trackId: string, values: readonly string[]) {
      if (!trackId) return
      const previous = tracks.get(trackId)
      tracks.delete(trackId)
      if (previous) tracks.set(trackId, previous)
      bind(trackId, values)
      while (tracks.size > ARTWORK_LIMITS.tracks) tracks.delete(tracks.keys().next().value!)
      collect()
    },
    updateBinding(trackId: string, values: readonly string[]) { if (tracks.has(trackId)) { bind(trackId, values); collect() } },
    invalidate(value: string) {
      const key = publicArtworkUrl(value)
      if (!key) return
      const entry = entries.get(key)
      if (entry) removeEntry(entry)
      fail(key); collect()
    },
    clear() {
      epoch++
      for (const entry of allEntries) removeEntry(entry)
      entries.clear(); tracks.clear(); failures.clear(); assetLoads.clear(); collect()
      capacityChanged()
    },
    snapshot() { return { tracks: [...tracks.keys()], assets: assets.size, ...totals(), preparing: reservations.size, pending: active, queued: queue.length } },
  }
}

export const sharedArtworkCache = createArtworkCache()

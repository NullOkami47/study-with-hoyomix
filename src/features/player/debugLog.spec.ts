import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { ProviderAttempt } from './providers/types'
import { createPlaybackStore } from './store'
import {
  DEBUG_LOG_FORMAT,
  debugLog,
  SLOW_API_CALL_MS,
  clearDebugLog,
  createPlaybackLog,
  debugLogFile,
  describeApiCall,
  describeDebugEnvironment,
  formatConsoleArguments,
  installDebugCapture,
  sanitizeLogString,
  summarizePlayer,
  type DebugCaptureTargets,
  type PlaybackLog,
} from './debugLog'

const ORIGIN = 'https://app.example'

interface Harness {
  log: PlaybackLog
  win: EventTarget & { fetch: typeof fetch; location: { origin: string; href: string } }
  /** The console object the capture wraps, and the functions it held before. */
  console: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  originals: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  clock: { now: number }
  uninstall: () => void
  types: () => string[]
  of: (type: string) => ReturnType<PlaybackLog['snapshot']>
}

let active: Harness | undefined
afterEach(() => { active?.uninstall(); active = undefined; vi.restoreAllMocks() })

function install(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, extra: Partial<DebugCaptureTargets> = {}): Harness {
  const log = createPlaybackLog()
  const win = Object.assign(new EventTarget(), {
    fetch: fetchImpl as typeof fetch,
    location: { origin: ORIGIN, href: `${ORIGIN}/player` },
  })
  const originals = { error: vi.fn(), warn: vi.fn() }
  const fakeConsole: Harness['console'] = { ...originals }
  const clock = { now: 0 }
  const uninstall = installDebugCapture({
    log, mono: () => clock.now,
    targets: { window: win, console: fakeConsole, serviceWorker: null, ...extra },
  })
  active = {
    log, win, console: fakeConsole, originals, clock, uninstall,
    types: () => log.snapshot().map((entry) => entry.type),
    of: (type) => log.snapshot().filter((entry) => entry.type === type),
  }
  return active
}

/** A fetch that takes `delayMs` on the harness clock and answers `status`. */
function respondingFetch(harness: () => Harness, status: number, delayMs = 10) {
  return vi.fn(async () => {
    harness().clock.now += delayMs
    return new Response(null, { status })
  })
}

describe('debug log capture: window errors', () => {
  it('records window error with a redacted file name and the unhandled rejection reason', () => {
    const harness = install(async () => new Response(null))
    harness.win.dispatchEvent(new ErrorEvent('error', {
      message: 'TypeError: x is undefined',
      filename: `${ORIGIN}/assets/index-abc.js?v=SECRET-QUERY`,
      lineno: 12, colno: 34, error: new TypeError('x is undefined'),
    }))
    harness.win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new DOMException('denied', 'NotAllowedError') }))
    harness.win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain string reason' }))

    const [error] = harness.of('error.window')
    expect(error).toMatchObject({ message: 'TypeError: x is undefined', lineno: 12, colno: 34, name: 'TypeError' })
    expect(String(error.filename)).toMatch(/^https:\/\/app\.example#[0-9a-f]{8}$/u)
    expect(JSON.stringify(error)).not.toContain('SECRET-QUERY')
    const rejections = harness.of('error.unhandledRejection')
    expect(rejections[0]).toMatchObject({ name: 'NotAllowedError', message: 'denied' })
    expect(rejections[1]).toMatchObject({ name: 'string', message: 'plain string reason' })
  })
})

describe('debug log capture: console', () => {
  it('records a sanitised message and still calls the original with the same arguments', () => {
    const harness = install(async () => new Response(null))
    const { originals, console: target } = harness
    // The wrapper replaced the functions on the target object.
    expect(target.error).not.toBe(originals.error)
    const failure = new Error('load failed https://cdn.example/a.mp3?ticket=T-123')
    target.error('[player]', failure, { nested: 'object' })
    target.warn('slow', 42)
    expect(originals.error).toHaveBeenCalledWith('[player]', failure, { nested: 'object' })
    expect(originals.warn).toHaveBeenCalledWith('slow', 42)
    expect(harness.of('console.error')[0].message)
      .toMatch(/^\[player\] Error: load failed https:\/\/cdn\.example#[0-9a-f]{8} \[object Object\]$/u)
    expect(harness.of('console.warn')[0].message).toBe('slow 42')
  })

  it('bounds the message to about 200 characters', () => {
    expect(formatConsoleArguments(['x'.repeat(1_000)])).toHaveLength(200)
  })

  it('installs once, and the uninstall restores the originals', () => {
    const harness = install(async () => new Response(null))
    const { originals, console: target } = harness
    const wrapped = target.error
    const second = installDebugCapture({ log: harness.log, targets: { window: harness.win, console: target } })
    expect(second).toBe(harness.uninstall)
    expect(target.error).toBe(wrapped)
    target.error('once')
    expect(harness.of('console.error')).toHaveLength(1)
    harness.uninstall()
    expect(target.error).toBe(originals.error)
    expect(target.warn).toBe(originals.warn)
    target.error('after uninstall')
    expect(harness.of('console.error')).toHaveLength(1)
  })
})

describe('debug log capture: app API calls', () => {
  const harness = (): Harness => active!

  it('records a network failure, a 4xx and a 5xx, and passes the original outcome through', async () => {
    const network = new TypeError('Failed to fetch')
    let next: () => Promise<Response> = async () => { throw network }
    install(vi.fn(() => next()))
    const { win } = harness()
    await expect(win.fetch('/api/providers/chksz/resolve?key=SECRET-KEY', { method: 'post' })).rejects.toBe(network)
    const notFound = new Response(null, { status: 404 })
    next = async () => notFound
    await expect(win.fetch(`${ORIGIN}/api/session`)).resolves.toBe(notFound)
    next = async () => new Response(null, { status: 503 })
    await win.fetch(new Request(`${ORIGIN}/api/catalogue?page=2`, { method: 'GET' }))

    expect(harness().of('api.error')[0]).toMatchObject({ method: 'POST', path: '/api/providers/chksz/resolve', status: null, name: 'TypeError' })
    expect(harness().of('api.status').map((entry) => [entry.method, entry.path, entry.status])).toEqual([
      ['GET', '/api/session', 404], ['GET', '/api/catalogue', 503],
    ])
    expect(JSON.stringify(harness().log.snapshot())).not.toMatch(/SECRET-KEY|page=2|\?/u)
  })

  it('records a slow success and ignores a fast success, other origins and non-API paths', async () => {
    let delay = SLOW_API_CALL_MS + 500
    install(vi.fn(async () => { harness().clock.now += delay; return new Response(null, { status: 200 }) }))
    const { win } = harness()
    await win.fetch('/api/library')
    delay = 20
    await win.fetch('/api/library')
    delay = SLOW_API_CALL_MS + 500
    await win.fetch('https://other.example/api/library')
    await win.fetch('/assets/app.js')

    expect(harness().of('api.slow')).toEqual([expect.objectContaining({ method: 'GET', path: '/api/library', status: 200, durationMs: SLOW_API_CALL_MS + 500 })])
    expect(harness().types().filter((type) => type.startsWith('api.'))).toEqual(['api.slow'])
  })

  it('never reads the body or changes the request', async () => {
    const body = JSON.stringify({ password: 'P-SECRET' })
    const fetchImpl = respondingFetch(harness, 500)
    install(fetchImpl)
    const init = { method: 'POST', body, headers: { authorization: 'Bearer B-SECRET' } }
    await harness().win.fetch('/api/library/merge', init)
    expect(fetchImpl).toHaveBeenCalledWith('/api/library/merge', init)
    expect(JSON.stringify(harness().log.snapshot())).not.toMatch(/P-SECRET|B-SECRET|password|authorization/u)
  })

  it('hashes long or address-like path segments', () => {
    const location = { origin: ORIGIN, href: `${ORIGIN}/` }
    const described = describeApiCall(`/api/admin/backgrounds/11111111-1111-4111-8111-111111111111/media`, undefined, location)
    expect(described?.path).toMatch(/^\/api\/admin\/backgrounds\/:[0-9a-f]{8}\/media$/u)
    expect(describeApiCall('/api/users/someone@example.com', undefined, location)?.path).not.toContain('example.com')
    expect(describeApiCall('/not-api', undefined, location)).toBeUndefined()
  })
})

describe('debug log capture: Service Worker', () => {
  it('records the controller, registration state, controllerchange and updatefound', async () => {
    const registration = Object.assign(new EventTarget(), {
      active: { state: 'activated' }, waiting: null, installing: null as null | (EventTarget & { state: string }),
    })
    const container = Object.assign(new EventTarget(), {
      controller: { state: 'activated' } as { state: string } | null,
      getRegistration: async () => registration,
    })
    const harness = install(async () => new Response(null), { serviceWorker: container })
    await new Promise((resolve) => setTimeout(resolve, 0))
    container.controller = null
    container.dispatchEvent(new Event('controllerchange'))
    registration.installing = Object.assign(new EventTarget(), { state: 'installing' })
    registration.dispatchEvent(new Event('updatefound'))
    registration.installing.state = 'installed'
    registration.installing.dispatchEvent(new Event('statechange'))

    expect(harness.of('sw.state')[0]).toMatchObject({ controller: true, controllerState: 'activated' })
    expect(harness.of('sw.registration')[0]).toMatchObject({ registered: true, active: 'activated', waiting: false, installing: false })
    expect(harness.of('sw.controllerchange')[0]).toMatchObject({ controller: false })
    expect(harness.of('sw.updatefound')[0]).toMatchObject({ installing: 'installing' })
    expect(harness.of('sw.statechange')[0]).toMatchObject({ state: 'installed' })
  })
})

describe('debug log: provider resolve attempts', () => {
  it('records every attempt the store observes with code, latency, transient flag and sub-source', async () => {
    debugLog.clear()
    const failed: ProviderAttempt = { providerId: 'lx', sourceId: 'src-1', sourceName: 'Name', ok: false, code: 'timeout', latencyMs: 4_000, transient: true }
    const served: ProviderAttempt = { providerId: 'jellyfin', ok: true, latencyMs: 120 }
    const store = createPlaybackStore({
      registry: new ProviderRegistry([]),
      storage: { getItem: () => null, setItem: () => {} },
      resolve: async (_track, _registry, options) => {
        options?.onAttempt?.(failed)
        options?.onAttempt?.(served)
        return {
          ok: true, providerId: 'jellyfin', attempts: [failed, served],
          playable: { kind: 'audio', url: 'https://media.invalid/a.mp3?ticket=Q-SECRET', mimeType: 'audio/mpeg' },
        } as never
      },
    })
    store.reconcileUpcomingQueue([{
      id: 'a', title: 'a', aliases: {}, games: [], relationIds: [], tabs: [], workGroupId: 'wg',
      vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'jellyfin', externalId: 'x' }],
    } as unknown as Track])
    await store.playQueueIndex(0)
    for (let index = 0; index < 20; index += 1) await Promise.resolve()

    const attempts = debugLog.snapshot().filter((entry) => entry.type === 'resolve.attempt')
    expect(attempts).toEqual([
      expect.objectContaining({ trackId: 'a', providerId: 'lx', sourceId: 'src-1', ok: false, code: 'timeout', latencyMs: 4_000, transient: true }),
      expect.objectContaining({ trackId: 'a', providerId: 'jellyfin', sourceId: null, ok: true, code: null, latencyMs: 120, transient: false }),
    ])
    expect(JSON.stringify(attempts)).not.toContain('Name')
    store.dispose()
  })
})

describe('debug log redaction', () => {
  it('removes URL queries, tickets, api keys, bearer tokens, cookies, JWTs, ChKSz keys and emails', () => {
    const cases: Array<[string, RegExp]> = [
      ['GET https://media.example/a.flac?ticket=TK-1&apikey=AK-1', /TK-1|AK-1|ticket|apikey/u],
      ['resolve failed ticket=TK-2 apikey: AK-2', /TK-2|AK-2/u],
      ['Authorization: Bearer abc.DEF-ghi_123', /abc\.DEF-ghi_123/u],
      ['cookie: hoyomix_session=CK-1; other=CK-2', /CK-1|CK-2/u],
      ['document.cookie was sid=CK-3; theme=dark', /CK-3/u],
      ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', /eyJhbGciOiJIUzI1NiJ9/u],
      ['key chksz_9f8e7d6c5b4a3210 rejected', /9f8e7d6c5b4a3210/u],
      ['signed in as listener.name+tag@mail.example.org', /listener|mail\.example\.org/u],
    ]
    for (const [input, secret] of cases) expect(sanitizeLogString(input), input).not.toMatch(secret)
    expect(sanitizeLogString('signed in as a@b.co')).toBe('signed in as [email]')
    // Error codes are kept.
    expect(sanitizeLogString('chksz_key_required')).toBe('chksz_key_required')
  })

  it('drops the value of a secret-named field', () => {
    const log = createPlaybackLog()
    log.record('x', { token: 'T-1', email: 'e@x.io', cookie: 'a=b', providerId: 'chksz' })
    expect(log.snapshot()[0]).toMatchObject({ token: '[redacted]', email: '[redacted]', cookie: '[redacted]', providerId: 'chksz' })
  })

  it('never lets an email address through, whatever its parts', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z0-9._-]{1,16}$/u), fc.stringMatching(/^[a-z0-9-]{1,12}$/u), fc.constantFrom('com', 'org', 'io', 'tw'),
      (local, domain, tld) => {
        const address = `${local}@${domain}.${tld}`
        expect(sanitizeLogString(`user ${address} failed`)).not.toContain(`@${domain}.${tld}`)
      },
    ))
  })
})

describe('debug log export document', () => {
  it('carries the environment snapshot and the player summary', async () => {
    const nav = navigator as Navigator & { connection?: unknown; deviceMemory?: unknown }
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '3g', downlink: 1.45, saveData: true } })
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 })
    try {
      const log = createPlaybackLog({ now: () => Date.UTC(2026, 9, 28, 12, 0, 0) })
      log.record('media.pause', { gen: 3 })
      const player = {
        currentTrack: ref({ id: 'track-7', title: 'Secret Title' }),
        status: ref('paused'), playbackIntent: ref('playing'), activeProviderId: ref('jellyfin'),
        sourceOverride: ref(undefined), playbackGeneration: ref(3), currentIndex: ref(2),
        queue: ref([{}, {}, {}]), attempts: ref([{}]),
        playbackNotices: shallowRef([{ kind: 'tapToResume' }, { kind: 'skipped' }, { kind: 'skipped' }]),
      }
      const { name, blob } = debugLogFile({ player: player as never, locale: 'zh-Hant' }, log)
      expect(name).toMatch(/^hoyomix-debug-log-.+Z\.json$/u)
      const json = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(blob)
      })
      const parsed = JSON.parse(json)
      expect(parsed).toMatchObject({
        format: DEBUG_LOG_FORMAT, version: 1, exportedAt: '2026-10-28T12:00:00.000Z',
        locale: 'zh-Hant', online: navigator.onLine, visibilityState: document.visibilityState,
        connection: { effectiveType: '3g', downlink: 1.45, saveData: true },
        deviceMemory: 4,
        displayMode: expect.stringMatching(/^(standalone|browser|unknown)$/u),
        standalone: expect.any(Boolean),
        serviceWorker: expect.objectContaining({ supported: expect.any(Boolean), controller: false }),
        player: {
          trackId: 'track-7', status: 'paused', intent: 'playing', providerId: 'jellyfin', sourceOverride: null,
          generation: 3, currentIndex: 2, queueLength: 3, attempts: 1, notices: ['tapToResume', 'skipped'],
        },
      })
      expect(parsed.entries).toEqual([expect.objectContaining({ type: 'media.pause', gen: 3 })])
      expect(json).not.toContain('Secret Title')
      expect(nav.connection).toBeDefined()
    } finally {
      Reflect.deleteProperty(navigator, 'connection')
      Reflect.deleteProperty(navigator, 'deviceMemory')
    }
  })

  it('summarises a missing player as null', () => {
    expect(summarizePlayer(undefined)).toBeNull()
    expect(describeDebugEnvironment().player).toBeNull()
  })
})

describe('clearDebugLog', () => {
  afterEach(() => { window.sessionStorage.clear() })

  it('empties the buffer and removes the persisted current and legacy sessionStorage copies', () => {
    const log = createPlaybackLog()
    log.record('player.play', { trackId: 't1' })
    window.sessionStorage.setItem('hoyomix.debugLog.v1', JSON.stringify(log.snapshot()))
    window.sessionStorage.setItem('hoyomix.playbackLog.v1', '[]')
    window.sessionStorage.setItem('unrelated', 'kept')
    clearDebugLog(log)
    expect(log.snapshot()).toEqual([])
    expect(window.sessionStorage.getItem('hoyomix.debugLog.v1')).toBeNull()
    expect(window.sessionStorage.getItem('hoyomix.playbackLog.v1')).toBeNull()
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept')
  })

  it('still clears the buffer when the store refuses removal', () => {
    const log = createPlaybackLog()
    log.record('player.play')
    expect(() => clearDebugLog(log, { removeItem: () => { throw new DOMException('denied', 'SecurityError') } })).not.toThrow()
    expect(log.snapshot()).toEqual([])
  })
})

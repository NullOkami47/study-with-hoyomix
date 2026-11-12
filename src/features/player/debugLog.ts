/**
 * Debug log (task 41.8): the export the listener hands to the developer when something goes wrong.
 *
 * The ring buffer, redaction and page lifecycle live in `playbackLog.ts` (task 41.1) and are
 * re-exported here under the debug-log names. This module adds the global capture that must run
 * before the player mounts (window errors, unhandled rejections, `console.error`/`console.warn`,
 * failed or slow `/api/*` calls, Service Worker state) and the export/share helpers both the
 * playback diagnostics panel and the Settings sheet use.
 *
 * Every capture only observes. Nothing reads a request or response body, a header or a cookie,
 * and the wrapped functions always call through to the original with the original arguments.
 */
import type { PlaybackStore } from './store'
import {
  LEGACY_PLAYBACK_LOG_SESSION_KEY,
  PLAYBACK_LOG_SESSION_KEY,
  describePlaybackEnvironment,
  playbackLog,
  playbackLogFileName,
  redactMediaUrl,
  sanitizeLogString,
  shortHash,
  type PlaybackLog,
  type PlaybackLogEnvironment,
} from './playbackLog'

export * from './playbackLog'
export {
  playbackLog as debugLog,
  recordPlayback as recordDebug,
  playbackLogFileName as debugLogFileName,
  describePlaybackEnvironment as describeDebugEnvironment,
  installPlaybackLogLifecycle as installDebugLogLifecycle,
} from './playbackLog'

/** An `/api/*` call that takes longer than this is logged even when it succeeds. */
export const SLOW_API_CALL_MS = 3_000
const CONSOLE_MESSAGE_LENGTH = 200
/** Endpoints of the account sync pipeline whose successful calls are worth a log entry. */
const SYNC_API_PATH = /^\/api\/(?:session$|account\/|backgrounds|focus-sessions)/u
const WRAPPED = Symbol.for('hoyomix.debugLog.wrapped')

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
type Wrappable = { [WRAPPED]?: true }
type FetchFunction = typeof fetch

interface ServiceWorkerLike {
  state?: string
}
interface ServiceWorkerRegistrationLike extends Listenable {
  active?: ServiceWorkerLike | null
  waiting?: ServiceWorkerLike | null
  installing?: (ServiceWorkerLike & Partial<Listenable>) | null
}
interface ServiceWorkerContainerLike extends Listenable {
  controller?: ServiceWorkerLike | null
  getRegistration?: () => Promise<ServiceWorkerRegistrationLike | undefined>
}

export interface DebugCaptureTargets {
  window: Listenable & { fetch?: FetchFunction; location?: { origin: string; href: string } }
  console?: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } | null
  serviceWorker?: ServiceWorkerContainerLike | null
}

export interface DebugCaptureOptions {
  log?: PlaybackLog
  targets?: DebugCaptureTargets
  /** Monotonic clock for API call durations; `performance.now()` by default. */
  mono?: () => number
}

function defaultMono(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function defaultCaptureTargets(): DebugCaptureTargets | undefined {
  if (typeof window === 'undefined') return undefined
  let serviceWorker: ServiceWorkerContainerLike | null = null
  try {
    serviceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker as unknown as ServiceWorkerContainerLike
      : null
  } catch { serviceWorker = null }
  return { window, console: typeof console !== 'undefined' ? console : null, serviceWorker }
}

/** `Error` → `Name: message`; primitives as text; other objects by constructor name only. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Error || (typeof value === 'object' && typeof (value as Error).message === 'string' && typeof (value as Error).name === 'string')) {
    const error = value as Error
    return `${error.name}: ${error.message}`
  }
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  try {
    const name = (value as object).constructor?.name
    return `[object ${typeof name === 'string' && name ? name : 'Object'}]`
  } catch {
    return '[object]'
  }
}

/** The joined, sanitised first part of a console call's arguments. */
export function formatConsoleArguments(args: readonly unknown[]): string {
  let joined = ''
  for (const arg of args) {
    joined += (joined ? ' ' : '') + describeValue(arg)
    if (joined.length > CONSOLE_MESSAGE_LENGTH * 4) break
  }
  return sanitizeLogString(joined).slice(0, CONSOLE_MESSAGE_LENGTH)
}

/**
 * `{ method, path }` for a same-origin `/api/*` request, otherwise undefined. The path keeps no
 * query or fragment, and a long or address-like segment is reduced to a hash.
 */
export function describeApiCall(
  input: unknown,
  init: { method?: string } | undefined,
  location: { origin: string; href: string } | undefined,
): { method: string; path: string } | undefined {
  if (!location) return undefined
  let raw: string | undefined
  let requestMethod: string | undefined
  if (typeof input === 'string') raw = input
  else if (input instanceof URL) raw = input.href
  else if (input && typeof input === 'object' && typeof (input as Request).url === 'string') {
    raw = (input as Request).url
    requestMethod = typeof (input as Request).method === 'string' ? (input as Request).method : undefined
  }
  if (!raw) return undefined
  let url: URL
  try { url = new URL(raw, location.href) } catch { return undefined }
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return undefined
  const path = url.pathname
    .split('/')
    .map((segment) => (segment.length >= 24 || segment.includes('@') || segment.includes('%40') ? `:${shortHash(segment)}` : segment))
    .join('/')
  const method = String(init?.method ?? requestMethod ?? 'GET').toUpperCase().slice(0, 10)
  return { method: sanitizeLogString(method), path: sanitizeLogString(path) }
}

interface ActiveCapture {
  uninstall: () => void
}
let activeCapture: ActiveCapture | undefined

/**
 * Install the global debug capture once. A second call while installed returns the same
 * uninstall without wrapping anything again. The uninstall restores every original it replaced,
 * unless something else replaced it since, in which case that newer value is left alone.
 */
export function installDebugCapture(options: DebugCaptureOptions = {}): () => void {
  if (activeCapture) return activeCapture.uninstall
  const targets = options.targets ?? defaultCaptureTargets()
  if (!targets) return () => {}
  const log = options.log ?? playbackLog
  const mono = options.mono ?? defaultMono
  const cleanups: Array<() => void> = []
  const { window: win } = targets

  // Window errors and unhandled rejections.
  const onError = (event: Event): void => {
    const error = event as ErrorEvent
    log.record('error.window', {
      message: typeof error.message === 'string' ? error.message : null,
      filename: typeof error.filename === 'string' && error.filename ? redactMediaUrl(error.filename) : null,
      lineno: typeof error.lineno === 'number' ? error.lineno : null,
      colno: typeof error.colno === 'number' ? error.colno : null,
      name: error.error instanceof Error ? error.error.name : null,
    })
  }
  const onRejection = (event: Event): void => {
    const reason: unknown = (event as PromiseRejectionEvent).reason
    const isErrorLike = reason instanceof Error ||
      (reason !== null && typeof reason === 'object' && typeof (reason as Error).message === 'string')
    log.record('error.unhandledRejection', {
      name: isErrorLike ? String((reason as Error).name ?? 'Error') : typeof reason,
      message: isErrorLike ? String((reason as Error).message) : describeValue(reason),
    })
  }
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)
  cleanups.push(() => {
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
  })

  // console.error / console.warn: record, then always call the original.
  const target = targets.console
  if (target) {
    for (const level of ['error', 'warn'] as const) {
      const original = target[level]
      if (typeof original !== 'function' || (original as Wrappable)[WRAPPED]) continue
      let recording = false
      const wrapper = function (this: unknown, ...args: unknown[]): void {
        if (!recording) {
          recording = true
          try { log.record(`console.${level}`, { message: formatConsoleArguments(args) }) } catch { /* Never block the console. */ } finally { recording = false }
        }
        return original.apply(this ?? target, args)
      }
      ;(wrapper as Wrappable)[WRAPPED] = true
      target[level] = wrapper
      cleanups.push(() => { if (target[level] === wrapper) target[level] = original })
    }
  }

  // fetch: log same-origin /api/* calls that fail, answer >= 400, or are slow. Bodies, headers
  // and cookies are never read; the Response the caller receives is the original object. The
  // debug-log export itself is a local Blob download and never goes through fetch.
  const originalFetch = win.fetch
  if (typeof originalFetch === 'function' && !(originalFetch as Wrappable)[WRAPPED]) {
    const wrappedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let call: { method: string; path: string } | undefined
      try { call = describeApiCall(input, init, win.location) } catch { call = undefined }
      if (!call) return originalFetch.call(win, input, init)
      const started = mono()
      const elapsed = (): number => Math.round(mono() - started)
      let pending: Promise<Response>
      try {
        pending = originalFetch.call(win, input, init)
      } catch (error) {
        log.record('api.error', { ...call, status: null, durationMs: elapsed(), name: error instanceof Error ? error.name : typeof error })
        throw error
      }
      return Promise.resolve(pending).then((response) => {
        const durationMs = elapsed()
        const status = typeof response?.status === 'number' ? response.status : null
        if (status !== null && status >= 400) log.record('api.status', { ...call, status, durationMs, slow: durationMs > SLOW_API_CALL_MS })
        else if (durationMs > SLOW_API_CALL_MS) log.record('api.slow', { ...call, status, durationMs })
        // Successful sync calls are logged too, so a 200 that the client then rejects is visible.
        else if (SYNC_API_PATH.test(call.path)) log.record('api.ok', { ...call, status, durationMs })
        return response
      }, (error: unknown) => {
        log.record('api.error', { ...call, status: null, durationMs: elapsed(), name: error instanceof Error ? error.name : typeof error })
        throw error
      })
    } as FetchFunction
    ;(wrappedFetch as Wrappable)[WRAPPED] = true
    win.fetch = wrappedFetch
    cleanups.push(() => { if (win.fetch === wrappedFetch) win.fetch = originalFetch })
  }

  // Service Worker: controller, registration state, controllerchange and updatefound.
  const container = targets.serviceWorker
  if (container) {
    let alive = true
    const workerState = (worker: ServiceWorkerLike | null | undefined): string | null =>
      worker && typeof worker.state === 'string' ? worker.state : null
    log.record('sw.state', { controller: Boolean(container.controller), controllerState: workerState(container.controller) })
    const onControllerChange = (): void => {
      log.record('sw.controllerchange', { controller: Boolean(container.controller), controllerState: workerState(container.controller) })
    }
    container.addEventListener('controllerchange', onControllerChange)
    cleanups.push(() => {
      alive = false
      container.removeEventListener('controllerchange', onControllerChange)
    })
    try {
      void container.getRegistration?.().then((registration) => {
        if (!alive) return
        if (!registration) { log.record('sw.registration', { registered: false }); return }
        log.record('sw.registration', {
          registered: true,
          active: workerState(registration.active),
          waiting: Boolean(registration.waiting),
          installing: Boolean(registration.installing),
        })
        const onUpdateFound = (): void => {
          const installing = registration.installing
          log.record('sw.updatefound', { installing: workerState(installing) })
          const onStateChange = (): void => { log.record('sw.statechange', { state: workerState(installing) }) }
          installing?.addEventListener?.('statechange', onStateChange)
        }
        registration.addEventListener('updatefound', onUpdateFound)
        cleanups.push(() => registration.removeEventListener('updatefound', onUpdateFound))
      }, () => { if (alive) log.record('sw.registration', { registered: null, failed: true }) })
    } catch { /* No registration API. */ }
  }

  log.record('log.captureInstalled', {
    console: Boolean(target),
    fetch: typeof originalFetch === 'function',
    serviceWorker: Boolean(container),
  })

  const capture: ActiveCapture = {
    uninstall: () => {
      if (activeCapture !== capture) return
      activeCapture = undefined
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { cleanup() } catch { /* Best effort. */ }
      }
    },
  }
  activeCapture = capture
  return capture.uninstall
}

type PlayerSummarySource = Partial<Pick<PlaybackStore,
  'currentTrack' | 'status' | 'playbackIntent' | 'activeProviderId' | 'sourceOverride' |
  'playbackGeneration' | 'currentIndex' | 'queue' | 'attempts' | 'playbackNotices'>>

/** The player state at export time. Reads only identifiers and states, never titles or URLs. */
export function summarizePlayer(player: PlayerSummarySource | undefined): PlaybackLogEnvironment['player'] {
  if (!player) return null
  try {
    return {
      trackId: player.currentTrack?.value?.id ?? null,
      status: player.status?.value ?? null,
      intent: player.playbackIntent?.value ?? null,
      providerId: player.activeProviderId?.value ?? null,
      sourceOverride: player.sourceOverride?.value ?? null,
      generation: player.playbackGeneration?.value ?? null,
      currentIndex: player.currentIndex?.value ?? null,
      queueLength: player.queue?.value.length ?? null,
      attempts: player.attempts?.value.length ?? null,
      notices: [...new Set((player.playbackNotices?.value ?? []).map((notice) => sanitizeLogString(notice.kind)))],
    }
  } catch {
    return null
  }
}

export interface DebugLogExportContext {
  player?: PlayerSummarySource
  locale?: string
  /**
   * Where the temporary download link is mounted. It must be inside the control that was clicked:
   * a modal sheet (OverlaySheet) treats a click on any element outside itself as an outside click,
   * cancels it (so the browser never starts the download) and closes the sheet.
   */
  host?: Element | null
}

/** The export file, built from the redacted buffer plus the environment snapshot. */
export function debugLogFile(context: DebugLogExportContext = {}, log: PlaybackLog = playbackLog): { name: string; blob: Blob } {
  const environment = describePlaybackEnvironment({ locale: context.locale, player: summarizePlayer(context.player) })
  return {
    name: playbackLogFileName(),
    blob: new Blob([log.exportJson(environment)], { type: 'application/json' }),
  }
}

const OBJECT_URL_LIFETIME_MS = 30_000

/** Blob + object URL + a temporary `download` link: works in an installed Android Chrome PWA. */
export function downloadDebugLog(context: DebugLogExportContext = {}): void {
  const { name, blob } = debugLogFile(context)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  link.style.display = 'none'
  const active = document.activeElement
  const host = context.host ?? (active instanceof HTMLElement && active !== document.body ? active.parentElement : null) ?? document.body
  host.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS)
}

type ShareNavigator = Navigator & {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { files: File[]; title?: string }) => Promise<void>
}

/** Whether the Web Share API can be offered at all; the file itself is checked when sharing. */
export function canShareDebugLog(): boolean {
  return typeof navigator !== 'undefined' && typeof (navigator as ShareNavigator).canShare === 'function' &&
    typeof (navigator as ShareNavigator).share === 'function' && typeof File !== 'undefined'
}

/** Share the file through the Web Share API; any failure other than a cancel falls back to download. */
export async function shareDebugLog(context: DebugLogExportContext = {}): Promise<void> {
  let file: File | undefined
  if (canShareDebugLog()) {
    const { name, blob } = debugLogFile(context)
    const candidate = new File([blob], name, { type: 'application/json' })
    try {
      if ((navigator as ShareNavigator).canShare?.({ files: [candidate] })) file = candidate
    } catch { file = undefined }
  }
  if (!file) { downloadDebugLog(context); return }
  try {
    await (navigator as ShareNavigator).share!({ files: [file], title: file.name })
  } catch (error) {
    // A cancelled share is the listener's choice; any other failure falls back to the download.
    if (!(error instanceof DOMException && error.name === 'AbortError')) downloadDebugLog(context)
  }
}

export type DebugLogExportKind = 'download' | 'share' | 'copy'
export type DebugLogExportResult =
  | { ok: true; method: 'download' | 'share' | 'copy' | 'cancelled' }
  | { ok: false; reason: 'manual_copy' | 'unavailable'; text: string }
/** Copy through a hidden, readonly textarea; the last scripted route when the async clipboard is absent. */
function copyThroughSelection(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.append(area)
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
  } catch { /* Fall through to the selection route. */ }
  return copyThroughSelection(text)
}
/**
 * Export the log by download, share or copy. Never throws and never fails silently: the result
 * says which route worked, or carries the text for manual copying when none did. A failed download
 * or share falls back (share → download → copy); a cancelled share is the listener's choice and
 * does not.
 */
export async function runDebugLogExport(
  kind: DebugLogExportKind,
  context: DebugLogExportContext = {},
  log: PlaybackLog = playbackLog,
): Promise<DebugLogExportResult> {
  let result: DebugLogExportResult
  try {
    result = await exportByKind(kind, context, log)
  } catch {
    result = { ok: false, reason: 'unavailable', text: '' }
  }
  try {
    log.record('log.export', {
      kind,
      ok: result.ok,
      method: result.ok ? result.method : null,
      reason: result.ok ? null : result.reason,
    })
  } catch { /* The status shown to the listener matters more than this entry. */ }
  return result
}
async function exportByKind(kind: DebugLogExportKind, context: DebugLogExportContext, log: PlaybackLog): Promise<DebugLogExportResult> {
  const copy = async (): Promise<DebugLogExportResult> => {
    const text = log.exportJson(describePlaybackEnvironment({ locale: context.locale, player: summarizePlayer(context.player) }))
    return await copyText(text) ? { ok: true, method: 'copy' } : { ok: false, reason: 'manual_copy', text }
  }
  const download = async (): Promise<DebugLogExportResult> => {
    try {
      downloadDebugLog(context)
      return { ok: true, method: 'download' }
    } catch {
      return copy()
    }
  }
  if (kind === 'copy') return copy()
  if (kind === 'download') return download()
  if (!canShareDebugLog()) return copy()
  let file: File | undefined
  try {
    const { name, blob } = debugLogFile(context, log)
    const candidate = new File([blob], name, { type: 'application/json' })
    if ((navigator as ShareNavigator).canShare?.({ files: [candidate] })) file = candidate
  } catch { file = undefined }
  if (!file) return copy()
  try {
    await (navigator as ShareNavigator).share!({ files: [file], title: file.name })
    return { ok: true, method: 'share' }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { ok: true, method: 'cancelled' }
    return download()
  }
}
function defaultSessionStorage(): Pick<Storage, 'removeItem'> | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

/**
 * Empty the buffer and drop the copy persisted for the next page (current and 41.1 keys), so a
 * reload after Clear does not restore the entries the listener just cleared.
 */
export function clearDebugLog(
  log: PlaybackLog = playbackLog,
  storage: Pick<Storage, 'removeItem'> | null = defaultSessionStorage(),
): void {
  log.clear()
  for (const key of [PLAYBACK_LOG_SESSION_KEY, LEGACY_PLAYBACK_LOG_SESSION_KEY]) {
    try { storage?.removeItem(key) } catch { /* A denied store has nothing we can remove. */ }
  }
}

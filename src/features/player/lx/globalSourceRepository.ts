// Client-side access to the published global LX source registry.
//
// The registry is read-only from here: a user's browser never mutates it, and it never fetches a
// source from its original URL. Scripts are downloaded from our own origin, addressed by digest.
//
// Three properties matter, and each has a concrete mechanism:
//
//   * **A script is the one the Owner approved.** The published list names the SHA-256 of the
//     approved snapshot, and the body is verified against it after download. A body that does not
//     match is discarded, not used.
//   * **A script may not reach an origin this deployment does not allow.** Every published source
//     carries the origins its static analysis found. The client checks them against the *deployed*
//     document policy — the same source list the sandbox uses — and skips a source whose origins
//     are not all permitted. The CSP is never widened from here.
//   * **Nothing is re-downloaded for nothing.** The list is cached by registry revision; a script
//     body is cached by digest and served with an immutable cache header, so the browser keeps it.

import { BUILD_LX_CSP_SOURCES, isLxTargetAllowed, type LxCspSources } from './cspAllowList'
import type { LxSourceRecord } from './types'

export interface PublishedLxSource {
  id: string
  name: string
  version: string | null
  sha256: string
  priority: number
  requiredOrigins: string[]
}

export interface PublishedManagedLxSource extends PublishedLxSource {
  deleted?: boolean
  enabled: boolean
  status: 'active' | 'disabled' | 'pending_network_approval' | 'failed'
}

export interface LxGlobalSourceRepositoryOptions {
  fetch?: typeof fetch
  /** Base path of the public registry endpoints. */
  baseUrl?: string
  /** CSP source lists the published origins are checked against. */
  cspSources?: LxCspSources
  /** The origin `'self'` stands for. */
  selfOrigin?: string
  now?: () => number
}

export interface LxGlobalSourceRepository {
  /** This repository is authoritative for the release-provided Kulao source, including revocation. */
  readonly managesBundledSource?: true
  managedSource?(): PublishedManagedLxSource | undefined
  /** The published sources, in the Owner's order, ready to join the LX chain. */
  list(): Promise<LxSourceRecord[]>
  /** The registry revision the last successful read observed. */
  revision(): number
  /** A source that was skipped because an origin it needs is not permitted by the CSP. */
  pendingApproval(): PublishedLxSource[]
  /** Forget the cached list and bodies. */
  invalidate(): void
}

const DEFAULT_BASE_URL = '/api/lx/sources'

function isPublishedSource(value: unknown): value is PublishedLxSource {
  if (value === null || typeof value !== 'object') return false
  const source = value as Partial<PublishedLxSource>
  return typeof source.id === 'string' && /^[A-Za-z0-9._-]+$/u.test(source.id)
    && typeof source.name === 'string' && source.name.length > 0
    && (source.version === null || typeof source.version === 'string')
    && typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(source.sha256)
    && typeof source.priority === 'number' && Number.isSafeInteger(source.priority)
    && Array.isArray(source.requiredOrigins) && source.requiredOrigins.every((origin) => typeof origin === 'string')
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createGlobalLxSourceRepository(
  options: LxGlobalSourceRepositoryOptions = {},
): LxGlobalSourceRepository {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const cspSources = options.cspSources ?? BUILD_LX_CSP_SOURCES
  const now = options.now ?? Date.now

  /** Script bodies, keyed by digest: a body is immutable for a given digest. */
  const bodies = new Map<string, string>()
  let cachedRevision = -1
  let cachedPublication: string | null = null
  let downloadsComplete = false
  let cachedRecords: LxSourceRecord[] = []
  let pending: PublishedLxSource[] = []
  let inFlight: Promise<LxSourceRecord[]> | null = null
  let generation = 0
  let managed: PublishedManagedLxSource | undefined

  const originAllowed = (origin: string): boolean => {
    try {
      return isLxTargetAllowed('connect', new URL(origin), cspSources, options.selfOrigin)
    } catch {
      return false
    }
  }

  const readList = async (): Promise<{ revision: number; sources: PublishedLxSource[]; managedSource?: PublishedManagedLxSource }> => {
    const response = await fetchImpl(`${baseUrl}`, { credentials: 'omit' })
    if (!response.ok) throw new Error(`The source registry responded with HTTP ${response.status}`)
    const body = (await response.json()) as { revision?: unknown; sources?: unknown; managedSource?: unknown }
    if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1
      || !Array.isArray(body.sources) || !body.sources.every(isPublishedSource)) {
      throw new Error('The source registry returned invalid publication data')
    }
    const managed = body.managedSource
    if (managed !== undefined && (
      !isPublishedSource(managed)
      || managed.id !== 'builtin-kulao-svip'
      || typeof (managed as PublishedManagedLxSource).enabled !== 'boolean'
      || ((managed as PublishedManagedLxSource).deleted !== undefined && typeof (managed as PublishedManagedLxSource).deleted !== 'boolean')
      || ((managed as PublishedManagedLxSource).deleted === true && ((managed as PublishedManagedLxSource).enabled || (managed as PublishedManagedLxSource).status !== 'disabled'))
      || !['active', 'disabled', 'pending_network_approval', 'failed'].includes((managed as PublishedManagedLxSource).status)
      || body.sources.some((source) => source.id === managed.id)
    )) {
      throw new Error('The managed source policy is invalid')
    }
    if (new Set(body.sources.map((source) => source.id)).size !== body.sources.length) {
      throw new Error('The source registry contains duplicate identities')
    }
    return { revision: body.revision, sources: body.sources, managedSource: managed as PublishedManagedLxSource | undefined }
  }

  const readBody = async (source: PublishedLxSource, requestGeneration: number): Promise<string> => {
    const cached = bodies.get(source.sha256)
    if (cached !== undefined) return cached
    const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(source.id)}/script?sha256=${source.sha256}`, {
      credentials: 'omit',
    })
    if (!response.ok) throw new Error(`The source script responded with HTTP ${response.status}`)
    const script = await response.text()
    // The digest is the contract: a body that does not hash to what the Owner approved is not
    // that script, and must not be run.
    const digest = await sha256Hex(script)
    if (digest !== source.sha256) {
      throw new Error(`The downloaded source does not match its published digest`)
    }
    if (requestGeneration === generation) bodies.set(source.sha256, script)
    return script
  }

  const load = async (requestGeneration: number): Promise<LxSourceRecord[]> => {
    const { revision, sources, managedSource } = await readList()
    if (requestGeneration !== generation) return []
    if (revision < cachedRevision) return []
    const publication = JSON.stringify({ sources, managedSource })
    managed = managedSource
    if (revision === cachedRevision && downloadsComplete && publication === cachedPublication) return cachedRecords
    // A revision alone cannot retain grants after the publication policy changes.
    // Revoke old authorisation before any asynchronous body downloads; verified bytes
    // remain cached, but only the current publication may authorise their use.
    cachedPublication = publication
    cachedRecords = []
    pending = []
    downloadsComplete = false
    const publications = managedSource?.enabled && managedSource.status === 'active'
      ? [managedSource, ...sources] : sources

    let complete = true
    const approved: LxSourceRecord[] = []
    const waiting: PublishedLxSource[] = []

    for (const source of publications.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
      const blocked = (source.requiredOrigins ?? []).filter((origin) => !originAllowed(origin))
      if (blocked.length > 0) {
        // The source needs an origin this deployment does not allow. It is skipped, not
        // attempted: the CSP is not widened to accommodate it.
        waiting.push(source)
        continue
      }
      let script: string
      try {
        script = await readBody(source, requestGeneration)
      } catch {
        // Retry an incomplete revision next time; verified bodies stay cached.
        complete = false
        continue
      }
      if (requestGeneration !== generation) return []
      approved.push({
        id: `global:${source.id}`,
        name: source.name,
        version: source.version ?? undefined,
        sha256: source.sha256,
        enabled: true,
        priority: source.priority,
        script,
        builtIn: false,
        importedAt: now(),
        updatedAt: now(),
      })
    }

    if (requestGeneration !== generation) return []
    pending = waiting
    downloadsComplete = complete
    cachedRevision = revision
    cachedRecords = approved
    return approved
  }

  return {
    managesBundledSource: true,
    managedSource: () => managed,
    async list(): Promise<LxSourceRecord[]> {
      if (!inFlight) {
        // A successful registry read authorises this resolution. On failure, verified script
        // bodies remain cached for recovery, but do not authorise using an old global source.
        const request = load(generation).catch(() => []).finally(() => {
          if (inFlight === request) inFlight = null
        })
        inFlight = request
      }
      return inFlight
    },
    revision: () => cachedRevision,
    pendingApproval: () => pending,
    invalidate: () => {
      generation++
      inFlight = null
      downloadsComplete = false
      cachedRevision = -1
      cachedPublication = null
      cachedRecords = []
      managed = undefined
      pending = []
      bodies.clear()
    },
  }
}

/**
 * The one repository this page uses.
 *
 * It is a singleton because the list it caches is per-deployment, not per-track: constructing a new
 * one per resolution would re-download the published list (and re-verify every script digest) on
 * every track change, which is exactly the cost the revision-based cache exists to avoid.
 */
let sharedRepository: LxGlobalSourceRepository | null = null

export function getDefaultGlobalSourceRepository(): LxGlobalSourceRepository {
  if (!sharedRepository) sharedRepository = createGlobalLxSourceRepository()
  return sharedRepository
}

/** Test seam: forget the shared repository so the next call starts with an empty cache. */
export function resetDefaultGlobalSourceRepository(): void {
  sharedRepository?.invalidate()
  sharedRepository = null
}

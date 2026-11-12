import { readProviderStates, deploymentAvailable } from '../../providers/config'
import { readChkszOwnerFallbackEnabled } from '../../providers/chkszCredentials'
import type { CatalogueEnv, CatalogueOptions } from '../adminRoutes'
import {
  createAdminAuthorisation,
  adminMutationOriginGuard,
} from '../../admin/authz'
import { readBoundedJsonRequest } from '../../providers/boundedJson'
import {
  sheetsConfigured,
  createGoogleSheetsClient,
  workbookFingerprint,
  type Workbook,
} from '../googleSheets'
import { readCatalogueSnapshot, readCatalogueRevision } from '../repository'
import {
  parseDiscoveryManifest,
  validateSuggestion,
  candidateIdentity,
} from './model'
import {
  readCandidate,
  readDiscoveryInbox,
  ingestManifest,
  updateCandidate,
  updateCandidatesAtomically,
  acquireDiscoveryLease,
  releaseDiscoveryLease,
} from './repository'
import { scanOfficialFeeds } from './scanner'
import { checkDiscoverySources } from './sources'
import { canonicalId } from '../validation'
import { assertSafeDiscovery, platformIdentity } from './model'
import { normalizeTitle } from '../../../src/shared/chkszMatcher'
import { sameVersionFamily } from '../../../src/shared/versionSignature'
import { stageCandidate } from './stageService'
import {
  automationEnabled,
  autoPublishEnabled,
  readAutomationCycles,
  runDiscoveryAutomationCycle,
} from './automationCycle'
import type { DiscoveryCandidate, DiscoveryManifest } from './types'

export interface DiscoveryOptions extends CatalogueOptions {
  fetch?: typeof fetch
  discovery?: { fetch?: typeof fetch; cache?: Pick<Cache, 'match' | 'put'> }
  sheets?: Pick<ReturnType<typeof createGoogleSheetsClient>, 'read' | 'write'> &
    Partial<
      Pick<
        ReturnType<typeof createGoogleSheetsClient>,
        'append' | 'readAutomation' | 'appendAutomation'
      >
    >
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const method = (allowed: string) =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: {
      allow: allowed,
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const body = async (
  request: Request,
  maxBytes = 128 * 1024,
): Promise<Record<string, unknown> | null> => {
  try {
    const value = await readBoundedJsonRequest(request, maxBytes)
    return record(value) ? value : null
  } catch {
    return null
  }
}
const channelIds = (env: CatalogueEnv): string[] => {
  const ids = [
    ...new Set(
      (env.CATALOGUE_DISCOVERY_CHANNEL_IDS ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]
  return ids.length <= 4 && ids.every((id) => /^UC[A-Za-z0-9_-]{22}$/.test(id))
    ? ids
    : []
}
const tokenEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length || a.length === 0) return false
  let value = 0
  for (let i = 0; i < a.length; i += 1)
    value |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return value === 0
}
const configuredAdapters = (env: CatalogueEnv) =>
  [
    { id: 'deterministic', available: true, mode: 'fallback' },
    { id: 'gemini-spark', available: false, mode: 'manual-import-only' },
    { id: 'meta-muse', available: false, mode: 'manual-import-only' },
  ].map((v) => ({
    ...v,
    available: v.id === 'deterministic' ? true : v.available,
  }))
const safeManifest = (value: unknown, env: CatalogueEnv): DiscoveryManifest => {
  const manifest = parseDiscoveryManifest(value)
  const allowed = new Set(channelIds(env))
  if (
    !allowed.size ||
    manifest.discoveries.some((d) => !allowed.has(d.artistChannelId))
  )
    throw new Error('discovery_channel_not_allowed')
  return manifest
}
const candidateOutput = (candidate: DiscoveryCandidate) => candidate

export function createDiscoveryIngestHandler(
  env: CatalogueEnv,
  options: DiscoveryOptions = {},
) {
  const now = options.now ?? Date.now
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') return method('POST')
      const configured = env.CATALOGUE_DISCOVERY_INGEST_TOKEN?.trim()
      const supplied =
        request.headers
          .get('authorization')
          ?.replace(/^Bearer\s+/i, '')
          .trim() ?? ''
      if (
        !configured ||
        configured.length < 32 ||
        configured.length > 512 ||
        !request.headers.get('authorization')?.startsWith('Bearer ') ||
        !tokenEqual(configured, supplied)
      )
        return json({ error: 'unauthorised' }, 401)
      const value = await body(request)
      if (!value) return json({ error: 'invalid_request' }, 400)
      try {
        const manifest = safeManifest(value, env)
        const snapshot = await readCatalogueSnapshot(env.DB)
        return json(await ingestManifest(env.DB, manifest, snapshot, now()))
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === 'sheet_rate_limited')
          return json({ error: message }, 429)
        if (message === 'run_id_conflict') return json({ error: message }, 409)
        if (
          message === 'discovery_channel_not_allowed' ||
          message === 'invalid_manifest'
        )
          return json({ error: message }, 400)
        return json({ error: 'discovery_ingest_unavailable' }, 503)
      }
    },
  }
}

export function createDiscoveryAdminHandler(
  env: CatalogueEnv,
  options: DiscoveryOptions = {},
) {
  const now = options.now ?? Date.now
  const auth = createAdminAuthorisation(env, options)
  const sheets = options.sheets ?? createGoogleSheetsClient(env)
  const fetcher = options.discovery?.fetch ?? options.fetch ?? globalThis.fetch
  const routePath = (request: Request) =>
    new URL(request.url).pathname.replace(
      '/api/admin/catalogue/discovery',
      '',
    ) || '/'
  const ingestAsAdmin = async (value: unknown) => {
    const manifest = safeManifest(value, env)
    return ingestManifest(
      env.DB,
      manifest,
      await readCatalogueSnapshot(env.DB),
      now(),
    )
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const denied = adminMutationOriginGuard(
        request,
        new URL(env.PUBLIC_ORIGIN).origin,
      )
      if (denied && request.method !== 'GET') return denied
      const admin = await auth.currentAdmin(request)
      if (admin instanceof Response) return admin
      const path = routePath(request)
      try {
        if (path === '/' && request.method === 'GET') {
          const inbox = await readDiscoveryInbox(
            env.DB,
            new URL(request.url).searchParams.get('cursor') ?? undefined,
          )
          return json({
            ...inbox,
            configured: channelIds(env).length > 0,
            sheetsConfigured: sheetsConfigured(env),
            ingestionConfigured: Boolean(env.CATALOGUE_DISCOVERY_INGEST_TOKEN),
            channelIds: channelIds(env),
            adapters: configuredAdapters(env),
            catalogueRevision: await readCatalogueRevision(env.DB),
            automation: {
              enabled: automationEnabled(env),
              autoPublish: autoPublishEnabled(env),
              cycles: automationEnabled(env)
                ? await readAutomationCycles(env.DB, 10)
                : [],
            },
          })
        }
        if (path === '/import' && request.method === 'POST') {
          const value = await body(request)
          if (!value) return json({ error: 'invalid_request' }, 400)
          return json(await ingestAsAdmin(value))
        }
        if (path === '/suggestions' && request.method === 'POST') {
          const value = await body(request, 512 * 1024)
          if (
            !value ||
            value.schemaVersion !== 1 ||
            typeof value.adapter !== 'string' ||
            ![
              'deterministic',
              'imported-json',
              'gemini-spark',
              'meta-muse',
            ].includes(value.adapter) ||
            !Array.isArray(value.suggestions) ||
            value.suggestions.length > 100
          )
            return json({ error: 'invalid_request' }, 400)
          const changes: Array<{
            candidate: DiscoveryCandidate
            suggestion: ReturnType<typeof validateSuggestion>
          }> = []
          const seen = new Set<string>()
          for (const item of value.suggestions) {
            if (
              !record(item) ||
              typeof item.videoId !== 'string' ||
              !/^[-_a-zA-Z0-9]{11}$/.test(item.videoId) ||
              seen.has(item.videoId)
            )
              return json({ error: 'invalid_classification' }, 400)
            seen.add(item.videoId)
            const { videoId, revision, ...fields } = item
            const candidate = await readCandidate(
              env.DB,
              await candidateIdentity(videoId),
            )
            if (!candidate) return json({ error: 'unknown_candidate' }, 400)
            if (
              !Number.isSafeInteger(revision) ||
              revision !== candidate.revision ||
              candidate.stageState === 'uncertain'
            )
              return json({ error: 'stale_candidate' }, 409)
            const suggestion = validateSuggestion({
              ...fields,
              work_group_id:
                fields.work_group_id ?? candidate.suggestion.work_group_id,
              adapter:
                value.adapter === 'imported-json' ? 'manual' : value.adapter,
            })
            changes.push({ candidate, suggestion })
          }
          // All inputs validate before the first write; importing AI output never records human review.
          try {
            await updateCandidatesAtomically(
              env.DB,
              changes.map((change) => ({
                candidate: {
                  ...change.candidate,
                  suggestion: change.suggestion,
                  classificationReviewed: false,
                  sources: [],
                  stageState: 'pending',
                },
                expected: change.candidate.revision,
              })),
              now(),
            )
          } catch {
            return json({ error: 'stale_candidate' }, 409)
          }
          return json({ imported: changes.length })
        }
        if (path === '/scan' && request.method === 'POST') {
          const ids = channelIds(env)
          if (!ids.length)
            return json({ error: 'discovery_not_configured' }, 503)
          try {
            const manifest = await scanOfficialFeeds(ids, {
              fetch: fetcher,
              now,
            })
            return json(await ingestAsAdmin(manifest))
          } catch (error) {
            const code =
              error instanceof Error &&
              [
                'discovery_rate_limited',
                'discovery_response_too_large',
                'discovery_upstream_unavailable',
              ].includes(error.message)
                ? error.message
                : 'discovery_upstream_unavailable'
            await env.DB.prepare(
              'INSERT INTO catalogue_discovery_runs(run_id,manifest_hash,summary_json,created_at)VALUES(?,?,?,?)',
            )
              .bind(
                'failed-' + crypto.randomUUID(),
                'failed',
                JSON.stringify({
                  discovered: 0,
                  added: 0,
                  repeated: 0,
                  outcome: code,
                }),
                now(),
              )
              .run()
            throw new Error(code)
          }
        }
        // Runs one cycle now, ignoring the weekly cadence. This is the operator's way to see
        // the loop work without waiting for the trigger; it changes no setting, so the cycle
        // still refuses to publish unless auto-publication is separately enabled.
        if (path === '/automation/run' && request.method === 'POST') {
          if (!automationEnabled(env))
            return json({ error: 'automation_disabled' }, 503)
          if (admin.role !== 'owner') return json({ error: 'forbidden' }, 403)
          const { readAutomation, appendAutomation } = sheets
          if (
            typeof readAutomation !== 'function' ||
            typeof appendAutomation !== 'function'
          )
            return json({ error: 'sheets_unavailable' }, 503)
          return json(
            await runDiscoveryAutomationCycle(env, {
              now,
              sheets: { ...sheets, readAutomation, appendAutomation },
              fetch: fetcher,
              cache: options.discovery?.cache,
              force: true,
            }),
          )
        }
        const match = /^\/([^/]+)(?:\/(check|stage|reconcile|resolve))?$/.exec(
          path,
        )
        if (match) {
          const candidateId = decodeURIComponent(match[1])
          const candidate = await readCandidate(env.DB, candidateId)
          if (!candidate) return json({ error: 'not_found' }, 404)
          if (!match[2] && request.method === 'GET') return json(candidate)
          if (match[2] === 'resolve') {
            if (request.method !== 'POST') return method('POST')
            const value = await body(request, 8192)
            if (
              !value ||
              value.revision !== candidate.revision ||
              candidate.stageState === 'uncertain'
            )
              return json({ error: 'stale_candidate' }, 409)
            if (
              typeof value.trackId !== 'string' ||
              !canonicalId(value.trackId) ||
              typeof value.reason !== 'string' ||
              !value.reason.trim() ||
              value.reason.length > 1000
            )
              return json({ error: 'invalid_request' }, 400)
            assertSafeDiscovery(value.reason)
            const snapshot = await readCatalogueSnapshot(env.DB)
            const target = snapshot.tracks.find(
              (t) => t.track_id === value.trackId,
            )
            if (target) {
              const identities = [
                target.title,
                ...snapshot.aliases
                  .filter((a) => a.track_id === target.track_id)
                  .map((a) => a.alias),
              ]
              if (
                !identities.some(
                  (title) =>
                    normalizeTitle(title) ===
                      normalizeTitle(candidate.discovery.title) &&
                    sameVersionFamily(title, candidate.discovery.title),
                )
              )
                return json({ error: 'recording_identity_mismatch' }, 409)
            }
            if (
              value.trackId !== candidate.id &&
              !snapshot.tracks.some((t) => t.track_id === value.trackId)
            )
              return json({ error: 'unknown_track' }, 400)
            return json(
              await updateCandidate(
                env.DB,
                {
                  ...candidate,
                  trackId: value.trackId,
                  conflicts: [],
                  sources: [],
                  classificationReviewed: false,
                  suggestion: {
                    ...candidate.suggestion,
                    reasons: [
                      ...candidate.suggestion.reasons.slice(0, 18),
                      'Admin identity review: ' + value.reason,
                    ],
                  },
                  stageState: 'pending',
                },
                candidate.revision,
                now(),
              ),
            )
          }
          if (match[2] === 'check') {
            if (request.method !== 'POST') return method('POST')
            const value = await body(request, 4096)
            if (
              !value ||
              Object.keys(value).length !== 1 ||
              !Number.isSafeInteger(value.revision)
            )
              return json({ error: 'invalid_request' }, 400)
            if (
              value.revision !== candidate.revision ||
              candidate.stageState === 'uncertain'
            )
              return json({ error: 'stale_candidate' }, 409)
            const checked = await checkDiscoverySources(
              candidate,
              env,
              request,
              admin.id,
              { fetch: fetcher, now, cache: options.discovery?.cache },
            )
            const snapshot = await readCatalogueSnapshot(env.DB)
            const conflicts = checked
              .filter((s) => s.status === 'valid')
              .flatMap((s) => {
                const owner = snapshot.sources.find(
                  (p) =>
                    platformIdentity(p.provider, p.external_id) !== null &&
                    platformIdentity(p.provider, p.external_id) ===
                      platformIdentity(s.provider, s.externalId),
                )
                return owner && owner.track_id !== candidate.trackId
                  ? ['source_owned_by:' + owner.track_id]
                  : []
              })
            return json(
              candidateOutput(
                await updateCandidate(
                  env.DB,
                  {
                    ...candidate,
                    conflicts: [
                      ...new Set([...candidate.conflicts, ...conflicts]),
                    ],
                    sources: checked,
                    stageState: 'pending',
                  },
                  candidate.revision,
                  now(),
                ),
              ),
            )
          }
          if (match[2] === 'stage' || match[2] === 'reconcile') {
            if (request.method !== 'POST') return method('POST')
            const value = await body(request, 16 * 1024)
            if (
              !value ||
              !Number.isSafeInteger(value.revision) ||
              !Number.isSafeInteger(value.expectedCatalogueRevision)
            )
              return json({ error: 'invalid_request' }, 400)
            if (value.revision !== candidate.revision)
              return json({ error: 'stale_candidate' }, 409)
            if (!sheetsConfigured(env))
              return json({ error: 'sheets_unavailable' }, 503)
            if (match[2] === 'stage') {
              const states = await readProviderStates(env.DB, env)
              const enabled = (id: string) =>
                states.some((s) => s.id === id && s.effectiveEnabled)
              let playable = candidate.sources.some(
                (s) =>
                  s.status === 'valid' &&
                  s.provider === 'gd-studio' &&
                  enabled('gd-studio'),
              )
              if (
                !playable &&
                candidate.sources.some(
                  (s) => s.status === 'valid' && s.provider === 'chksz',
                ) &&
                enabled('chksz') &&
                env.CHKSZ_API_KEY
              )
                playable = await readChkszOwnerFallbackEnabled(env.DB)
              if (!playable && enabled('lx')) {
                const children = await env.DB.prepare(
                  "SELECT provider_key FROM provider_health WHERE provider_key IN ('lx-huibq','lx-ikun') AND enabled=1",
                ).all<{ provider_key: string }>()
                const enabledChildren = new Set(children.results.map((s) => s.provider_key))
                playable = candidate.sources.some(
                  (s) =>
                    s.status === 'valid' &&
                    ['lx-huibq', 'lx-ikun'].includes(s.provider) &&
                    enabledChildren.has(s.provider) &&
                    deploymentAvailable(
                      s.provider as 'lx-huibq' | 'lx-ikun',
                      env,
                    ),
                )
              }
              if (!playable)
                return json({ error: 'runtime_source_required' }, 409)
            }
            return json(
              await stageCandidate(
                env.DB,
                sheets,
                candidate,
                Number(value.expectedCatalogueRevision),
                now,
                match[2] === 'reconcile',
              ),
            )
          }
        }
        const single = await readCandidate(
          env.DB,
          decodeURIComponent(path.slice(1)),
        )
        if (single && request.method === 'PATCH') {
          const value = await body(request, 64 * 1024)
          if (
            !value ||
            !Number.isSafeInteger(value.revision) ||
            value.reviewed !== true ||
            !('suggestion' in value)
          )
            return json({ error: 'invalid_request' }, 400)
          if (
            value.revision !== single.revision ||
            single.stageState === 'uncertain'
          )
            return json({ error: 'stale_candidate' }, 409)
          const suggestion = validateSuggestion(value.suggestion)
          // Source matches depend on title/album/vocal/version metadata. Editing a suggestion invalidates prior checks.
          return json(
            await updateCandidate(
              env.DB,
              {
                ...single,
                suggestion,
                classificationReviewed: true,
                sources: [],
                stageState: 'pending',
              },
              single.revision,
              now(),
            ),
          )
        }
        return method('GET, PATCH, POST')
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (
          [
            'invalid_manifest',
            'invalid_cursor',
            'discovery_channel_not_allowed',
            'invalid_classification',
            'source_identity_conflict',
            'source_disabled_in_staging',
            'staging_invalid',
            'staging_too_many_changes',
            'unsafe_discovery',
            'discovery_identity_conflict',
          ].includes(message)
        )
          return json({ error: message }, 400)
        if (
          [
            'stale_candidate',
            'stale_catalogue',
            'run_id_conflict',
            'discovery_busy',
            'sheet_append_uncertain',
            'candidate_not_ready',
            'runtime_source_required',
            'stale_sheet',
            'sheet_append_rejected',
            'staging_identity_conflict',
            'sheet_reconciliation_required',
            'candidate_not_uncertain',
          ].includes(message)
        )
          return json({ error: message }, 409)
        if (message === 'discovery_busy') return json({ error: message }, 409)
        if (
          message === 'sheets_unavailable' ||
          message === 'discovery_not_configured'
        )
          return json({ error: message }, 503)
        return json({ error: 'discovery_unavailable' }, 503)
      }
    },
  }
}

import type { D1Database, D1PreparedStatement } from '../env'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import {
  BACKGROUND_IMAGE_MAX_BYTES,
  BACKGROUND_VIDEO_MAX_BYTES,
  buildBackgroundObjectKey,
  inspectBackgroundMedia,
  isControlledBackgroundObjectKey,
} from './mediaValidation'
import type { BackgroundBucket } from './storage'
import { inspectBackgroundVideo } from './videoValidation'
import { BACKGROUND_VIDEO_PLAYBACK_WIDTH, BACKGROUND_VIDEO_PLAYBACK_HEIGHT } from '../../src/features/backgrounds/videoPolicy'
import {
  STATIC_BACKGROUND_CONTENT_TYPE,
  STATIC_BACKGROUND_DEFINITIONS,
  STATIC_BACKGROUND_RIGHTS_STATUS,
  isStaticBackgroundId,
  staticBackgroundDefinition,
  staticPlaybackMediaUrl,
  type StaticBackgroundDefinition,
} from '../../src/features/backgrounds/staticDefinitions'

export interface BackgroundEnv {
  DB: D1Database
  BACKGROUND_BUCKET?: BackgroundBucket
}

export interface BackgroundActor {
  id: string
  role: 'admin' | 'owner'
}

export interface BackgroundUser {
  id: string
}

/** Purge finalisation lease duration in milliseconds. */
export const PURGE_LEASE_DURATION_MS = 30_000

interface BackgroundRoutesOptions {
  auditStatement: (
    actorUserId: string,
    action: string,
    targetKey: string,
    detail: Record<string, unknown>,
    createdAt: number,
  ) => D1PreparedStatement
  crypto: Crypto
  now: () => number
  /** @internal Test-only: when true, inFlightPurges guard is bypassed to model separate isolates. */
  __test_disableInFlightGuard?: boolean
}

type BackgroundStatus = 'draft' | 'published' | 'archived'
type BackgroundKind = 'image' | 'video'
type StaticOverrideStatus = 'published' | 'archived' | 'tombstoned'

interface BackgroundRow {
  id: string
  status: BackgroundStatus
  currentRevisionId: string
  revisionNumber: number
  kind: BackgroundKind
  objectKey: string
  posterObjectKey: string | null
  contentType: string
  byteSize: number
  width: number
  height: number
  durationMs: number | null
  fps: number | null
  provenanceJson: string
  title: string | null
  game: string | null
  collection: string | null
  displayOrder: number | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  archivedAt: number | null
  purgeStartedAt: number | null
  purgeFinalisingAt: number | null
  purgeFinalisingToken: string | null
  purgeLeaseExpiresAt: number | null
}

interface StaticOverrideRow {
  id: string
  status: StaticOverrideStatus
  title: string | null
  game: string | null
  collection: string | null
  displayOrder: number | null
  updatedAt: number
}

const json = (body: unknown, status = 200, etag?: string) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', ...(etag ? { etag } : {}) },
})

const BACKGROUND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A "known background id" is either an uploaded media UUID or one of the nine
 * shipped static backgrounds. Uploaded media routes keep the UUID-only
 * `BACKGROUND_ID` matcher so a static slug can never reach the R2-backed
 * handlers; only the metadata/lifecycle entry points accept the wider set.
 */
const isKnownBackgroundId = (value: string): boolean =>
  BACKGROUND_ID.test(value) || isStaticBackgroundId(value)

/** Bounded body size for the metadata PATCH; the payload is a handful of scalars. */
const MAX_BACKGROUND_METADATA_BYTES = 4_096

const METADATA_KEYS = ['title', 'game', 'collection', 'displayOrder'] as const
type MetadataKey = (typeof METADATA_KEYS)[number]

interface MetadataPatch {
  title?: string | null
  game?: string | null
  collection?: string | null
  displayOrder?: number | null
}

/**
 * Parse the plain (unwrapped) metadata patch body. Returns `null` for any shape
 * or value the admin contract rejects, so callers can answer `invalid_payload`.
 */
const parseMetadataPatch = (body: unknown): MetadataPatch | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return null
  if (keys.some((key) => !(METADATA_KEYS as readonly string[]).includes(key))) return null
  const patch: MetadataPatch = {}
  for (const key of keys as MetadataKey[]) {
    const value = record[key]
    if (value === null) {
      if (key === 'displayOrder') patch.displayOrder = null
      else patch[key] = null
      continue
    }
    if (key === 'displayOrder') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
      patch.displayOrder = value
      continue
    }
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    const maximum = key === 'title' ? 120 : 64
    if (trimmed.length < 1 || trimmed.length > maximum) return null
    patch[key] = trimmed
  }
  return patch
}

const selectStaticOverrides = `
  SELECT id, status, title, game, collection,
    display_order AS displayOrder, updated_at AS updatedAt
  FROM static_background_overrides
`

/** Admin catalogue view for a shipped definition, with any override applied. */
const shippedAdminView = (
  definition: StaticBackgroundDefinition,
  override: StaticOverrideRow | null,
) => {
  const playback = definition.playbackVersion
  return {
    id: definition.id,
    revision: 1,
    status: override?.status ?? 'published',
    kind: 'video' as const,
    contentType: STATIC_BACKGROUND_CONTENT_TYPE,
    byteSize: playback?.byteSize ?? definition.byteSize,
    width: playback?.width ?? definition.width,
    height: playback?.height ?? definition.height,
    durationMs: definition.durationMs,
    fps: playback?.fps ?? definition.fps,
    mediaUrl: staticPlaybackMediaUrl(definition),
    posterUrl: definition.posterUrl,
    rightsStatus: STATIC_BACKGROUND_RIGHTS_STATUS,
    title: override?.title ?? definition.title,
    game: override?.game ?? definition.game,
    collection: override?.collection ?? definition.collection,
    displayOrder: override?.displayOrder ?? 0,
    isShipped: true,
    createdAt: 0,
    updatedAt: override?.updatedAt ?? 0,
    publishedAt: 0,
    archivedAt: null,
  }
}

/**
 * Admin catalogue view for an uploaded row. `responseFor` already carries the
 * presentation metadata, so this only adds the `isShipped` discriminator that
 * the merged catalogue sorts and the UI badges on.
 */
const uploadedAdminView = (row: BackgroundRow) => ({
  ...responseFor(row, true),
  isShipped: false,
})

/**
 * Deterministic merged ordering: display order ascending, then shipped before
 * uploaded, then id ascending.
 */
const compareAdminCatalogue = (
  left: { displayOrder: number; isShipped: boolean; id: string },
  right: { displayOrder: number; isShipped: boolean; id: string },
): number =>
  left.displayOrder - right.displayOrder ||
  (left.isShipped === right.isShipped ? 0 : left.isShipped ? -1 : 1) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/**
 * Rotation intervals the account endpoint accepts: the four minute-long
 * choices the selector now offers (10/20/30/60 minutes) plus the short values
 * earlier builds stored, so an existing row can be re-saved without being
 * rewritten to a cadence the user never chose.
 */
const BACKGROUND_INTERVAL_VALUES = [15, 30, 60, 300, 600, 1_200, 1_800, 3_600]

const inFlightPurges = new Set<string>()

/**
 * Recognises the deliberate `INSERT INTO users (id) SELECT NULL` fence used to
 * abort a D1 batch. A statement that inserts NULL into `users.id` trips the
 * NOT NULL constraint, which rolls the whole batch back; both the purge
 * ownership check and the metadata existence check rely on that signal.
 */
const isRowFenceViolation = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('NOT NULL constraint failed: users.id')

const readProvenance = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const readHighVariant = (value: string): Record<string, unknown> | null => {
  const high = readProvenance(value).highQualityVersion
  return high && typeof high === 'object' && !Array.isArray(high) ? high as Record<string, unknown> : null
}

const responseFor = (row: BackgroundRow, admin = false) => ({
  id: row.id,
  revision: row.revisionNumber,
  status: row.status,
  kind: row.kind,
  contentType: row.contentType,
  byteSize: row.byteSize,
  width: row.width,
  height: row.height,
  durationMs: row.durationMs,
  ...(row.kind === 'video' ? { fps: row.fps } : {}),
  ...(readHighVariant(row.provenanceJson) ? { highQualityVersion: {
    ...Object.fromEntries(Object.entries(readHighVariant(row.provenanceJson)!).filter(([key]) => ['width', 'height', 'fps', 'byteSize'].includes(key))),
    mediaUrl: `${admin ? '/api/admin/backgrounds' : '/api/backgrounds'}/${row.id}/high-media`,
  } } : {}),
  mediaUrl: admin
    ? `/api/admin/backgrounds/${row.id}/media`
    : `/api/backgrounds/${row.id}/media`,
  posterUrl: row.posterObjectKey
    ? (admin ? `/api/admin/backgrounds/${row.id}/poster` : `/api/backgrounds/${row.id}/poster`)
    : null,
  rightsStatus: typeof readProvenance(row.provenanceJson).rightsStatus === 'string'
    ? readProvenance(row.provenanceJson).rightsStatus
    : 'not-reviewed',
  // Presentation metadata is part of the public contract too: the gallery has to
  // render the administrator's title, group and ordering for uploaded rows, not
  // only in the admin catalogue. Both surfaces therefore emit the same four
  // keys with the same `null`/`0` defaults, so a row can never describe itself
  // differently depending on which endpoint read it.
  title: row.title ?? null,
  game: row.game ?? null,
  collection: row.collection ?? null,
  displayOrder: row.displayOrder ?? 0,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  publishedAt: row.publishedAt,
  archivedAt: row.archivedAt,
})

const selectBackground = `
  SELECT b.id, b.status, b.current_revision_id AS currentRevisionId,
    r.revision_number AS revisionNumber, r.kind, r.object_key AS objectKey,
    r.poster_object_key AS posterObjectKey, r.content_type AS contentType,
    r.byte_size AS byteSize, r.width, r.height, r.duration_ms AS durationMs, r.fps,
    r.provenance_json AS provenanceJson,
    b.title, b.game, b.collection, b.display_order AS displayOrder,
    b.created_at AS createdAt, b.updated_at AS updatedAt,
    b.published_at AS publishedAt, b.archived_at AS archivedAt,
    b.purge_started_at AS purgeStartedAt,
    b.purge_finalising_at AS purgeFinalisingAt,
    b.purge_finalising_token AS purgeFinalisingToken,
    b.purge_lease_expires_at AS purgeLeaseExpiresAt
  FROM background_media b
  JOIN background_media_revisions r ON r.id = b.current_revision_id
`

const bodyLengthLimit = (request: Request): number | null => {
  const contentType = request.headers.get('content-type')?.trim().toLowerCase() ?? ''
  if (contentType === 'video/mp4' || contentType === 'video/webm') return BACKGROUND_VIDEO_MAX_BYTES
  if (contentType.startsWith('image/')) return BACKGROUND_IMAGE_MAX_BYTES
  return null
}

const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const validationStatus = (error: string) => {
  if (error === 'unsupported_media_type' || error === 'media_type_mismatch') return 415
  if (error === 'video_validation_unavailable' || error === 'invalid_dimensions') return 422
  if (error === 'media_too_large') return 413
  return 400
}

export function createBackgroundRoutes(env: BackgroundEnv, options: BackgroundRoutesOptions) {
  const readBackground = (id: string) => env.DB.prepare(`${selectBackground} WHERE b.id = ?`).bind(id).first<BackgroundRow>()

  const readOverride = (id: string) =>
    env.DB.prepare(`${selectStaticOverrides} WHERE id = ?`).bind(id).first<StaticOverrideRow>()

  const readUpload = async (request: Request): Promise<
    | { response: Response; bytes?: never; media?: never }
    | { response?: never; bytes: Uint8Array; media: Extract<ReturnType<typeof inspectBackgroundMedia>, { ok: true }>['media']; poster?: Uint8Array; high?: { bytes: Uint8Array; media: Extract<ReturnType<typeof inspectBackgroundMedia>, { ok: true }>['media'] } }
  > => {
    const contentType = request.headers.get('content-type')?.trim().toLowerCase() ?? ''
    const declaredLength = request.headers.get('content-length')
    const multipart = contentType.startsWith('multipart/form-data;')
    const limit = multipart ? 2 * BACKGROUND_VIDEO_MAX_BYTES + 512 * 1024 + 8192 : bodyLengthLimit(request)
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > (limit ?? BACKGROUND_VIDEO_MAX_BYTES))) {
      return { response: json({ error: 'media_too_large' }, 413) } as const
    }
    if (multipart) {
      let tooLarge = false
      try {
        if (!request.body) throw new Error()
        let received = 0
        const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength
            if (received > limit!) { tooLarge = true; controller.error(new Error('media_too_large')); return }
            controller.enqueue(chunk)
          },
        }))
        // Avoid retaining both all input chunks and another joined upload body.
        const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body, duplex: 'half' } as RequestInit & { duplex: 'half' }).formData()
        let highFile = form.get('highMedia')
        if ([...form.keys()].length !== 3 || form.getAll('media').length !== 1 || form.getAll('poster').length !== 1 || form.getAll('highMedia').length !== 1) throw new Error()
        if (!(highFile instanceof File) || highFile.type !== 'video/mp4') throw new Error()
        let media = form.get('media'), poster = form.get('poster')
        if (!(media instanceof File) || !(poster instanceof File) || media.type !== 'video/mp4' || poster.type !== 'image/jpeg' || poster.size > 512 * 1024) throw new Error()
        if (media.size > BACKGROUND_VIDEO_MAX_BYTES || highFile.size > BACKGROUND_VIDEO_MAX_BYTES) return { response: json({ error: 'media_too_large' }, 413) }
        form.delete('media'); form.delete('highMedia'); form.delete('poster')
        const bytes = new Uint8Array(await media.arrayBuffer()); media = null
        const posterBytes = new Uint8Array(await poster.arrayBuffer()); poster = null
        const inspected = await inspectBackgroundVideo(bytes, { maxWidth: BACKGROUND_VIDEO_PLAYBACK_WIDTH, maxHeight: BACKGROUND_VIDEO_PLAYBACK_HEIGHT }), thumbnail = inspectBackgroundMedia(posterBytes, 'image/jpeg')
        if (!inspected.ok) return { response: json({ error: inspected.error }, validationStatus(inspected.error)) }
        if (!thumbnail.ok || thumbnail.media.width > 640 || thumbnail.media.height > 360) throw new Error()
        const highBytes = new Uint8Array(await highFile.arrayBuffer())
        highFile = null
        const high = await inspectBackgroundVideo(highBytes)
        if (!high.ok) return { response: json({ error: high.error }, validationStatus(high.error)) }
        if (high.media.width < inspected.media.width || high.media.height < inspected.media.height ||
            Math.abs(high.media.durationMs! - inspected.media.durationMs!) > 250 ||
            Math.abs(high.media.fps! - inspected.media.fps!) > 0.1 ||
            Math.abs(high.media.width / high.media.height - inspected.media.width / inspected.media.height) > 0.01) throw new Error()
        return { bytes, media: inspected.media, poster: posterBytes, high: { bytes: highBytes, media: high.media } }
      } catch { return { response: json({ error: tooLarge ? 'media_too_large' : 'invalid_media' }, tooLarge ? 413 : 422) } }
    }
    if (contentType === 'video/mp4' || contentType === 'video/webm') {
      return { response: json({ error: 'video_validation_unavailable' }, 422) } as const
    }
    if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') {
      return { response: json({ error: 'unsupported_media_type' }, 415) } as const
    }
    const bytes = await readBoundedBody(request, BACKGROUND_IMAGE_MAX_BYTES)
    if (!bytes) return { response: json({ error: 'media_too_large' }, 413) } as const
    const inspection = inspectBackgroundMedia(bytes, contentType)
    if (!inspection.ok) return { response: json({ error: inspection.error }, validationStatus(inspection.error)) } as const
    return { bytes, media: inspection.media } as const
  }

  const storeRevision = async (
    actor: BackgroundActor,
    request: Request,
    existing?: BackgroundRow,
  ): Promise<Response> => {
    if (!env.BACKGROUND_BUCKET) return json({ error: 'background_storage_unavailable' }, 503)
    if (existing?.status === 'archived') return json({ error: 'invalid_background_transition' }, 409)
    const upload = await readUpload(request)
    if (upload.response) return upload.response
    const backgroundId = existing?.id ?? options.crypto.randomUUID()
    const revisionId = options.crypto.randomUUID()
    const revisionNumber = (existing?.revisionNumber ?? 0) + 1
    const objectKey = buildBackgroundObjectKey(backgroundId, revisionId, upload.media.extension)
    const posterKey = upload.poster ? buildBackgroundObjectKey(backgroundId, revisionId, 'jpg', true) : null
    const highKey = upload.high ? buildBackgroundObjectKey(backgroundId, options.crypto.randomUUID(), 'mp4') : null
    const highJson = upload.high && highKey ? JSON.stringify({ objectKey: highKey, width: upload.high.media.width, height: upload.high.media.height, fps: upload.high.media.fps, byteSize: upload.high.media.bytes }) : null
    const changedAt = options.now()
    let stored = false
    let posterStored = false
    let highStored = false
    try {
      stored = (await env.BACKGROUND_BUCKET.put(objectKey, upload.bytes, {
        httpMetadata: {
          contentType: upload.media.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
        customMetadata: { backgroundId, revisionId },
      })) !== null
      if (!stored) return json({ error: 'background_storage_unavailable' }, 503)
      if (posterKey && upload.poster) {
        posterStored = (await env.BACKGROUND_BUCKET.put(posterKey, upload.poster, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { backgroundId, revisionId } })) !== null
        if (!posterStored) throw new Error('poster_write_failed')
      }
      if (highKey && upload.high) {
        highStored = (await env.BACKGROUND_BUCKET.put(highKey, upload.high.bytes, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { backgroundId, revisionId, quality: 'high' } })) !== null
        if (!highStored) throw new Error('high_video_write_failed')
      }
      const provenance = JSON.stringify({ rightsStatus: 'not-reviewed', ...(highJson ? { highQualityVersion: JSON.parse(highJson) } : {}), ...(upload.media.fps ? { fps: upload.media.fps, codec: 'avc', audioTracks: 0 } : {}) })
      if (!existing) {
        await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO background_media (
              id, status, current_revision_id, created_by, created_at, updated_at
            ) VALUES (?, 'draft', NULL, ?, ?, ?)
          `).bind(backgroundId, actor.id, changedAt, changedAt),
          env.DB.prepare(`
            INSERT INTO background_media_revisions (
              id, background_id, revision_number, kind, object_key, poster_object_key,
              content_type, byte_size, width, height, duration_ms, fps, provenance_json,
              created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            revisionId, backgroundId, revisionNumber, upload.media.kind, objectKey, posterKey,
            upload.media.contentType, upload.media.bytes, upload.media.width, upload.media.height,
            upload.media.durationMs, upload.media.fps ?? null, provenance, actor.id, changedAt,
          ),
          env.DB.prepare(`
            UPDATE background_media SET current_revision_id = ? WHERE id = ? AND current_revision_id IS NULL
          `).bind(revisionId, backgroundId),
          options.auditStatement(actor.id, 'background.create', `background:${backgroundId}`, {
            kind: upload.media.kind,
            contentType: upload.media.contentType,
            revision: revisionNumber,
            rightsStatus: 'not-reviewed',
          }, changedAt),
        ])
      } else {
        await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO background_media_revisions (
              id, background_id, revision_number, kind, object_key, poster_object_key,
              content_type, byte_size, width, height, duration_ms, fps, provenance_json,
              created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            revisionId, backgroundId, revisionNumber, upload.media.kind, objectKey, posterKey,
            upload.media.contentType, upload.media.bytes, upload.media.width, upload.media.height,
            upload.media.durationMs, upload.media.fps ?? null, provenance, actor.id, changedAt,
          ),
          env.DB.prepare(`
            UPDATE background_media
            SET current_revision_id = ?, updated_at = ?
            WHERE id = ? AND current_revision_id = ? AND status != 'archived'
          `).bind(revisionId, changedAt, backgroundId, existing.currentRevisionId),
          options.auditStatement(actor.id, 'background.replace', `background:${backgroundId}`, {
            revision: revisionNumber,
            previousRevision: existing.revisionNumber,
          }, changedAt),
        ])
      }
    } catch {
      if (stored) await env.BACKGROUND_BUCKET.delete(objectKey).catch(() => undefined)
      if (posterStored && posterKey) await env.BACKGROUND_BUCKET.delete(posterKey).catch(() => undefined)
      if (highKey) await env.BACKGROUND_BUCKET.delete(highKey).catch(() => undefined)
      return json({ error: 'background_write_failed' }, 500)
    }
    const row = await readBackground(backgroundId)
    if (!row || row.currentRevisionId !== revisionId) {
      await env.BACKGROUND_BUCKET.delete(objectKey).catch(() => undefined)
      if (posterStored && posterKey) await env.BACKGROUND_BUCKET.delete(posterKey).catch(() => undefined)
      if (highKey) await env.BACKGROUND_BUCKET.delete(highKey).catch(() => undefined)
      return json({ error: 'background_update_conflict' }, 409)
    }
    return json({ background: responseFor(row, true) }, existing ? 200 : 201)
  }

  const serveMedia = async (row: BackgroundRow, poster = false, high = false) => {
    if (!env.BACKGROUND_BUCKET) return json({ error: 'background_storage_unavailable' }, 503)
    const highKey = readHighVariant(row.provenanceJson) ? readHighVariant(row.provenanceJson)!.objectKey : null
    const key = poster ? row.posterObjectKey : high ? (typeof highKey === 'string' ? highKey : null) : row.objectKey
    if (!key || !isControlledBackgroundObjectKey(row.id, key)) return json({ error: 'background_media_unavailable' }, 404)
    const object = await env.BACKGROUND_BUCKET.get(key)
    if (!object) return json({ error: 'background_media_unavailable' }, 404)
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? (poster ? 'image/jpeg' : row.contentType),
        'content-length': String(object.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  const transition = async (
    row: BackgroundRow,
    actor: BackgroundActor,
    action: 'publish' | 'archive' | 'restore',
  ) => {
    const expected: BackgroundStatus = action === 'publish' ? 'draft' : action === 'archive' ? 'published' : 'archived'
    const next: BackgroundStatus = action === 'archive' ? 'archived' : 'published'
    if (row.status !== expected) return json({ error: 'invalid_background_transition' }, 409)

    // FINDING 2 FIX: Prevent lifecycle transitions when purge recovery is active
    if (row.purgeStartedAt !== null || row.purgeFinalisingAt !== null) {
      // Background is in purge recovery state - no ordinary transitions allowed
      return json({ error: 'background_purge_in_progress' }, 409)
    }
    if (action === 'publish') {
      if (!env.BACKGROUND_BUCKET) return json({ error: 'background_storage_unavailable' }, 503)
      if (!isControlledBackgroundObjectKey(row.id, row.objectKey) || !(await env.BACKGROUND_BUCKET.head(row.objectKey))) {
        return json({ error: 'background_media_unavailable' }, 409)
      }
      if (readHighVariant(row.provenanceJson)) {
        const highKey = readHighVariant(row.provenanceJson)!.objectKey
        if (typeof highKey !== 'string' || !isControlledBackgroundObjectKey(row.id, highKey) || !(await env.BACKGROUND_BUCKET.head(highKey))) return json({ error: 'background_media_unavailable' }, 409)
      }
    }
    const changedAt = options.now()
    const publishedAt = next === 'published' ? changedAt : row.publishedAt
    const archivedAt = next === 'archived' ? changedAt : null

    // Wrap batch in try-catch for defensive error handling
    let results
    try {
      results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE background_media
          SET status = ?, updated_at = ?, published_at = ?, archived_at = ?
          WHERE id = ? AND status = ? AND current_revision_id = ?
        `).bind(next, changedAt, publishedAt, archivedAt, row.id, expected, row.currentRevisionId),
        options.auditStatement(actor.id, `background.${action}`, `background:${row.id}`, {
          from: expected,
          to: next,
        }, changedAt),
      ])
    } catch {
      // Catch any unexpected database errors (e.g., CHECK constraint violations)
      return json({ error: 'background_transition_failed' }, 500)
    }
    if (results[0].meta.changes !== 1) return json({ error: 'background_update_conflict' }, 409)
    const updated = await readBackground(row.id)
    return updated ? json({ background: responseFor(updated, true) }) : json({ error: 'background_not_found' }, 404)
  }

  const purge = async (row: BackgroundRow, actor: BackgroundActor) => {
    if (row.status !== 'archived') return json({ error: 'invalid_background_transition' }, 409)
    if (!env.BACKGROUND_BUCKET) return json({ error: 'background_storage_unavailable' }, 503)

    // Same-isolate fast-path only; not load-bearing for correctness
    if (!options.__test_disableInFlightGuard && inFlightPurges.has(row.id)) {
      return json({ error: 'background_purge_in_progress' }, 409)
    }
    if (!options.__test_disableInFlightGuard) inFlightPurges.add(row.id)

    try {
      const revisions = await env.DB.prepare(`
        SELECT object_key AS objectKey, poster_object_key AS posterObjectKey, provenance_json AS provenanceJson
        FROM background_media_revisions WHERE background_id = ?
        ORDER BY revision_number
      `).bind(row.id).all<{ objectKey: string; posterObjectKey: string | null; provenanceJson: string }>()
      const keys = revisions.results.flatMap((revision) => [revision.objectKey, revision.posterObjectKey, readHighVariant(revision.provenanceJson)?.objectKey as string ?? null])
        .filter((key): key is string => key !== null)
      if (keys.some((key) => !isControlledBackgroundObjectKey(row.id, key))) {
        return json({ error: 'unsafe_background_object_key' }, 409)
      }
      const purgeState = await env.DB.prepare(`
        SELECT purge_started_at AS purgeStartedAt, purge_finalising_at AS purgeFinalisingAt,
          purge_finalising_token AS purgeFinalisingToken, purge_lease_expires_at AS purgeLeaseExpiresAt
        FROM background_media WHERE id = ?
      `).bind(row.id).first<{
        purgeStartedAt: number | null
        purgeFinalisingAt: number | null
        purgeFinalisingToken: string | null
        purgeLeaseExpiresAt: number | null
      }>()

      if (!purgeState) {
        return json({ error: 'background_not_found' }, 404)
      }

      const alreadyStarted = purgeState.purgeStartedAt !== null
      if (!alreadyStarted) {
        const changedAt = options.now()
        try {
          const marked = await env.DB.prepare(`
            UPDATE background_media SET purge_started_at = ?
            WHERE id = ? AND status = 'archived' AND current_revision_id = ? AND purge_started_at IS NULL
          `).bind(changedAt, row.id, row.currentRevisionId).run()
          if (marked.meta.changes !== 1) return json({ error: 'background_update_conflict' }, 409)
        } catch {
          return json({ error: 'background_purge_failed' }, 500)
        }
      }
      try {
        for (const key of keys) await env.BACKGROUND_BUCKET.delete(key)
      } catch {
        return json({ error: 'background_storage_unavailable' }, 503)
      }

      const changedAt = options.now()
      const myToken = options.crypto.randomUUID()
      const leaseExpiresAt = changedAt + PURGE_LEASE_DURATION_MS
      let ownershipToken = myToken

      if (purgeState.purgeFinalisingAt !== null) {
        // Finalisation was previously claimed — check lease
        if (purgeState.purgeLeaseExpiresAt !== null && purgeState.purgeLeaseExpiresAt > changedAt) {
          // Lease still active — another owner is alive; reject
          return json({ error: 'background_purge_in_progress' }, 409)
        }
        // Lease expired or missing — attempt durable takeover
        try {
          const takeover = await env.DB.prepare(`
            UPDATE background_media SET purge_finalising_at = ?, purge_finalising_token = ?, purge_lease_expires_at = ?
            WHERE id = ? AND status = 'archived' AND current_revision_id = ?
              AND (purge_finalising_token IS NULL OR purge_lease_expires_at <= ?)
          `).bind(changedAt, myToken, leaseExpiresAt, row.id, row.currentRevisionId, changedAt).run()
          if (takeover.meta.changes !== 1) {
            return json({ error: 'background_purge_in_progress' }, 409)
          }
        } catch {
          return json({ error: 'background_purge_failed' }, 500)
        }
      } else {
        // Fresh claim — no prior finalisation
        try {
          const claimed = await env.DB.prepare(`
            UPDATE background_media SET purge_finalising_at = ?, purge_finalising_token = ?, purge_lease_expires_at = ?
            WHERE id = ? AND status = 'archived' AND current_revision_id = ?
              AND purge_finalising_token IS NULL
          `).bind(changedAt, myToken, leaseExpiresAt, row.id, row.currentRevisionId).run()
          if (claimed.meta.changes !== 1) {
            return json({ error: 'background_purge_in_progress' }, 409)
          }
        } catch {
          return json({ error: 'background_purge_failed' }, 500)
        }
      }

      try {
        await env.DB.batch([
          // Fence: if the row was deleted or token doesn't match, this inserts NULL into users.id,
          // triggering a NOT NULL constraint violation and rolling back the entire batch.
          env.DB.prepare(`
            INSERT INTO users (id)
            SELECT NULL WHERE NOT EXISTS (
              SELECT 1 FROM background_media WHERE id = ? AND purge_finalising_token = ?
            )
          `).bind(row.id, ownershipToken),
          env.DB.prepare(`
            DELETE FROM user_background_selections
            WHERE json_array_length(selection_json) = 1
              AND EXISTS (
                SELECT 1 FROM json_each(user_background_selections.selection_json)
                WHERE type = 'text' AND value = ?
              )
          `).bind(row.id),
          env.DB.prepare(`
            UPDATE user_background_selections
            SET selection_json = json_remove(
              selection_json,
              '$[' || (
                SELECT key FROM json_each(user_background_selections.selection_json)
                WHERE type = 'text' AND value = ?
                LIMIT 1
              ) || ']'
            ), updated_at = ?
            WHERE json_array_length(selection_json) > 1
              AND EXISTS (
                SELECT 1 FROM json_each(user_background_selections.selection_json)
                WHERE type = 'text' AND value = ?
              )
          `).bind(row.id, changedAt, row.id),
          env.DB.prepare(`
            DELETE FROM background_media
            WHERE id = ? AND status = 'archived' AND current_revision_id = ?
          `).bind(row.id, row.currentRevisionId),
          options.auditStatement(actor.id, 'background.purge', `background:${row.id}`, {
            revisionCount: revisions.results.length,
          }, changedAt),
        ])
      } catch (error: unknown) {
        if (isRowFenceViolation(error)) {
          try {
            const ownership = await env.DB.prepare(`
              SELECT 1 AS owned FROM background_media
              WHERE id = ? AND purge_finalising_token = ?
            `).bind(row.id, ownershipToken).first<{ owned: number }>()
            if (!ownership) return json({ error: 'background_purge_in_progress' }, 409)
          } catch {
            // Failure to verify the durable owner is an internal purge failure.
          }
        }
        return json({ error: 'background_purge_failed' }, 500)
      }

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    } finally {
      if (!options.__test_disableInFlightGuard) inFlightPurges.delete(row.id)
    }
  }

  const writeOverrideStatus = (
    id: string,
    status: StaticOverrideStatus,
    actor: BackgroundActor,
    changedAt: number,
  ) => env.DB.prepare(`
    INSERT INTO static_background_overrides (id, status, updated_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).bind(id, status, actor.id, changedAt)

  // Batch statements execute atomically. A stale lifecycle request must abort
  // the whole batch, including selection sanitisation and the audit entry.
  const fenceOverrideStatus = (id: string, expected: StaticOverrideStatus) => env.DB.prepare(`
    INSERT INTO users (id)
    SELECT NULL WHERE COALESCE(
      (SELECT status FROM static_background_overrides WHERE id = ?), 'published'
    ) <> ?
  `).bind(id, expected)

  /** Lifecycle for a shipped static background; effective status defaults to `published`. */
  const transitionShipped = async (
    definition: StaticBackgroundDefinition,
    actor: BackgroundActor,
    action: 'publish' | 'archive' | 'restore',
  ) => {
    const existing = await readOverride(definition.id)
    const current: StaticOverrideStatus = existing?.status ?? 'published'
    // Shipped media are never drafts, so `publish` has no valid source state.
    const expected: StaticOverrideStatus = action === 'archive' ? 'published' : 'archived'
    if (action === 'publish' || current !== expected) {
      return json({ error: 'invalid_background_transition' }, 409)
    }
    const next: StaticOverrideStatus = action === 'archive' ? 'archived' : 'published'
    const changedAt = options.now()
    try {
      await env.DB.batch([
        fenceOverrideStatus(definition.id, expected),
        writeOverrideStatus(definition.id, next, actor, changedAt),
        options.auditStatement(actor.id, `background.${action}`, `background:${definition.id}`, {
          from: current,
          to: next,
        }, changedAt),
      ])
    } catch (error: unknown) {
      if (isRowFenceViolation(error)) return json({ error: 'invalid_background_transition' }, 409)
      return json({ error: 'background_transition_failed' }, 500)
    }
    const override = await readOverride(definition.id)
    return json({ background: shippedAdminView(definition, override) })
  }

  /**
   * Tombstone a shipped static background. This deliberately never touches R2 or
   * any file on disk: shipped assets are immutable build output, so the purge
   * contract is a D1 status flip plus selection sanitisation.
   */
  const purgeShipped = async (definition: StaticBackgroundDefinition, actor: BackgroundActor) => {
    const existing = await readOverride(definition.id)
    const current: StaticOverrideStatus = existing?.status ?? 'published'
    if (current !== 'archived') return json({ error: 'invalid_background_transition' }, 409)
    const changedAt = options.now()
    try {
      await env.DB.batch([
        fenceOverrideStatus(definition.id, 'archived'),
        writeOverrideStatus(definition.id, 'tombstoned', actor, changedAt),
        env.DB.prepare(`
          DELETE FROM user_background_selections
          WHERE json_array_length(selection_json) = 1
            AND EXISTS (
              SELECT 1 FROM json_each(user_background_selections.selection_json)
              WHERE type = 'text' AND value = ?
            )
        `).bind(definition.id),
        env.DB.prepare(`
          UPDATE user_background_selections
          SET selection_json = json_remove(
            selection_json,
            '$[' || (
              SELECT key FROM json_each(user_background_selections.selection_json)
              WHERE type = 'text' AND value = ?
              LIMIT 1
            ) || ']'
          ), updated_at = ?
          WHERE json_array_length(selection_json) > 1
            AND EXISTS (
              SELECT 1 FROM json_each(user_background_selections.selection_json)
              WHERE type = 'text' AND value = ?
            )
        `).bind(definition.id, changedAt, definition.id),
        options.auditStatement(actor.id, 'background.tombstone', `background:${definition.id}`, {
          from: current,
          to: 'tombstoned',
        }, changedAt),
      ])
    } catch (error: unknown) {
      if (isRowFenceViolation(error)) return json({ error: 'invalid_background_transition' }, 409)
      return json({ error: 'background_purge_failed' }, 500)
    }
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }

  /**
   * Apply a metadata patch to an uploaded row and return its merged admin view.
   *
   * The mutation and its audit entry are committed as ONE D1 batch, which D1
   * executes in a single transaction: if the audit insert fails, the metadata
   * update is rolled back rather than leaving an unlogged change behind. The
   * leading fence makes the pair all-or-nothing for a vanished row as well — a
   * missing row aborts the batch before the audit entry can be written, so the
   * log never records a mutation that did not happen.
   */
  const patchUploadedMetadata = async (
    row: BackgroundRow,
    patch: MetadataPatch,
    actor: BackgroundActor,
  ) => {
    const assignments: string[] = []
    const binds: (string | number | null)[] = []
    const detail: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as MetadataKey[]) {
      const value = patch[key] ?? null
      assignments.push(`${key === 'displayOrder' ? 'display_order' : key} = ?`)
      binds.push(value)
      detail[key] = value
    }
    const changedAt = options.now()
    let results
    try {
      results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO users (id)
          SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM background_media WHERE id = ?)
        `).bind(row.id),
        env.DB.prepare(`
          UPDATE background_media SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?
        `).bind(...binds, changedAt, row.id),
        options.auditStatement(actor.id, 'background.metadata', `background:${row.id}`, detail, changedAt),
      ])
    } catch (error: unknown) {
      if (isRowFenceViolation(error)) return json({ error: 'background_not_found' }, 404)
      return json({ error: 'background_write_failed' }, 500)
    }
    if (results[1]?.meta.changes !== 1) return json({ error: 'background_not_found' }, 404)
    const updated = await readBackground(row.id)
    return updated ? json({ background: uploadedAdminView(updated) }) : json({ error: 'background_not_found' }, 404)
  }

  /** Apply a metadata patch to a shipped background's override, preserving its status. */
  const patchShippedMetadata = async (
    definition: StaticBackgroundDefinition,
    patch: MetadataPatch,
    actor: BackgroundActor,
  ) => {
    // Update only provided columns inside the transaction, so an omitted field
    // cannot overwrite another patch with a value from a stale read snapshot.
    const assignments: string[] = []
    const detail: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as MetadataKey[]) {
      const column = key === 'displayOrder' ? 'display_order' : key
      assignments.push(`${column} = excluded.${column}`)
      detail[key] = patch[key] ?? null
    }
    const changedAt = options.now()
    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO static_background_overrides (
            id, status, title, game, collection, display_order, updated_by, updated_at
          ) VALUES (?, 'published', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ${assignments.join(', ')},
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `).bind(definition.id, patch.title ?? null, patch.game ?? null, patch.collection ?? null, patch.displayOrder ?? null, actor.id, changedAt),
        options.auditStatement(actor.id, 'background.metadata', `background:${definition.id}`, detail, changedAt),
      ])
    } catch {
      return json({ error: 'background_write_failed' }, 500)
    }
    const override = await readOverride(definition.id)
    return json({ background: shippedAdminView(definition, override) })
  }

  return {
    async handlePublic(request: Request, url: URL): Promise<Response | null> {
      // Matched explicitly (and before the `:id` shapes below) so `/overrides`
      // is never mistaken for a background id.
      if (request.method === 'GET' && url.pathname === '/api/backgrounds/overrides' && !url.search) {
        const rows = await env.DB.prepare(`${selectStaticOverrides} ORDER BY id`).all<StaticOverrideRow>()
        return json({
          overrides: rows.results.map((row) => ({
            id: row.id,
            status: row.status,
            title: row.title,
            game: row.game,
            collection: row.collection,
            displayOrder: row.displayOrder,
            updatedAt: row.updatedAt,
          })),
        })
      }
      if (request.method === 'GET' && url.pathname === '/api/backgrounds' && !url.search) {
        const rows = await env.DB.prepare(`${selectBackground}
          WHERE b.status = 'published'
          ORDER BY b.published_at DESC, b.id
        `).all<BackgroundRow>()
        return json({ backgrounds: rows.results.map((row) => responseFor(row)) })
      }
      const mediaMatch = url.pathname.match(/^\/api\/backgrounds\/([0-9a-f-]{36})\/(media|poster|high-media)$/)
      if (request.method === 'GET' && mediaMatch && BACKGROUND_ID.test(mediaMatch[1]) && !url.search) {
        const row = await readBackground(mediaMatch[1])
        if (!row || row.status !== 'published') return json({ error: 'background_not_found' }, 404)
        return serveMedia(row, mediaMatch[2] === 'poster', mediaMatch[2] === 'high-media')
      }
      return null
    },

    async handleAdmin(request: Request, url: URL, actor: BackgroundActor): Promise<Response | null> {
      if (request.method === 'GET' && url.pathname === '/api/admin/backgrounds' && !url.search) {
        const rows = await env.DB.prepare(selectBackground).all<BackgroundRow>()
        const overrides = await env.DB.prepare(selectStaticOverrides).all<StaticOverrideRow>()
        const overridesById = new Map(overrides.results.map((row) => [row.id, row]))
        const backgrounds = [
          ...STATIC_BACKGROUND_DEFINITIONS.map((definition) =>
            shippedAdminView(definition, overridesById.get(definition.id) ?? null)),
          ...rows.results.map((row) => uploadedAdminView(row)),
        ].sort(compareAdminCatalogue)
        return json({ backgrounds })
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/backgrounds/uploads' && !url.search) {
        return storeRevision(actor, request)
      }
      const metadataMatch = url.pathname.match(/^\/api\/admin\/backgrounds\/([^/]+)$/)
      if (request.method === 'PATCH' && metadataMatch && !url.search) {
        const id = metadataMatch[1]
        let body: unknown
        try { body = await readBoundedJsonRequest(request, MAX_BACKGROUND_METADATA_BYTES) } catch { body = null }
        const patch = parseMetadataPatch(body)
        if (!patch) return json({ error: 'invalid_payload' }, 400)
        if (BACKGROUND_ID.test(id)) {
          const row = await readBackground(id)
          if (!row) return json({ error: 'background_not_found' }, 404)
          return patchUploadedMetadata(row, patch, actor)
        }
        const definition = staticBackgroundDefinition(id)
        if (!definition) return json({ error: 'background_not_found' }, 404)
        return patchShippedMetadata(definition, patch, actor)
      }
      const itemMatch = url.pathname.match(/^\/api\/admin\/backgrounds\/([0-9a-f-]{36})$/)
      if (request.method === 'GET' && itemMatch && BACKGROUND_ID.test(itemMatch[1]) && !url.search) {
        const row = await readBackground(itemMatch[1])
        return row ? json({ background: responseFor(row, true) }) : json({ error: 'background_not_found' }, 404)
      }
      const mediaMatch = url.pathname.match(/^\/api\/admin\/backgrounds\/([0-9a-f-]{36})\/(media|poster|high-media)$/)
      if (request.method === 'GET' && mediaMatch && BACKGROUND_ID.test(mediaMatch[1]) && !url.search) {
        const row = await readBackground(mediaMatch[1])
        return row ? serveMedia(row, mediaMatch[2] === 'poster', mediaMatch[2] === 'high-media') : json({ error: 'background_not_found' }, 404)
      }
      const replaceMatch = url.pathname.match(/^\/api\/admin\/backgrounds\/([0-9a-f-]{36})\/replace$/)
      if (request.method === 'POST' && replaceMatch && BACKGROUND_ID.test(replaceMatch[1]) && !url.search) {
        const row = await readBackground(replaceMatch[1])
        return row ? storeRevision(actor, request, row) : json({ error: 'background_not_found' }, 404)
      }
      const actionMatch = url.pathname.match(/^\/api\/admin\/backgrounds\/([^/]+)\/(publish|archive|restore|purge)$/)
      if (actionMatch && isKnownBackgroundId(actionMatch[1]) && !url.search) {
        const id = actionMatch[1]
        const action = actionMatch[2] as 'publish' | 'archive' | 'restore' | 'purge'
        if (BACKGROUND_ID.test(id)) {
          const row = await readBackground(id)
          if (!row) return json({ error: 'background_not_found' }, 404)
          if (action === 'purge') return request.method === 'DELETE' ? purge(row, actor) : null
          return request.method === 'POST' ? transition(row, actor, action) : null
        }
        const definition = staticBackgroundDefinition(id)
        if (!definition) return json({ error: 'background_not_found' }, 404)
        if (action === 'purge') return request.method === 'DELETE' ? purgeShipped(definition, actor) : null
        return request.method === 'POST' ? transitionShipped(definition, actor, action) : null
      }
      return null
    },

    async handleAccount(request: Request, url: URL, user: BackgroundUser): Promise<Response | null> {
      if (url.pathname !== '/api/account/background-selection' || url.search) return null
      const expectedUser = request.headers.get('x-account-user-id')
      if (expectedUser !== null && expectedUser !== user.id) return json({ error: 'account_session_changed' }, 409)
      // A user with no stored row has no preference yet, so the first-use
      // default applies: twenty minutes.
      const defaultSelection = { selectedIds: [], autoRotate: true, intervalSeconds: 1_200 }
      if (request.method === 'GET') {
        const row = await env.DB.prepare(`
          SELECT selection_json AS selectionJson, auto_rotate AS autoRotate,
            interval_seconds AS intervalSeconds, updated_at AS updatedAt
          FROM user_background_selections WHERE user_id = ?
        `).bind(user.id).first<{ selectionJson: string; autoRotate: number; intervalSeconds: number; updatedAt: number }>()
        if (!row) return json({ selection: defaultSelection }, 200, "absent")
        let selectedIds: unknown = []
        try { selectedIds = JSON.parse(row.selectionJson) } catch { selectedIds = [] }
        return json({
          selection: {
            selectedIds: Array.isArray(selectedIds)
              ? selectedIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
              : [],
            autoRotate: row.autoRotate === 1,
            intervalSeconds: row.intervalSeconds,
          },
        }, 200, String(row.updatedAt))
      }
      if (request.method !== 'PUT') return null
      let body: unknown
      try { body = await readBoundedJsonRequest(request, 2_048) } catch { body = null }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'invalid_background_selection' }, 400)
      }
      const candidate = body as Record<string, unknown>
      if (Object.keys(candidate).some((key) => !['selectedIds', 'autoRotate', 'intervalSeconds'].includes(key)) ||
        !Array.isArray(candidate.selectedIds) || candidate.selectedIds.length > 8 ||
        !candidate.selectedIds.every((id) => typeof id === 'string') ||
        new Set(candidate.selectedIds).size !== candidate.selectedIds.length ||
        typeof candidate.autoRotate !== 'boolean' ||
        !BACKGROUND_INTERVAL_VALUES.includes(Number(candidate.intervalSeconds))) {
        return json({ error: 'invalid_background_selection' }, 400)
      }
      const selectedIds = candidate.selectedIds as string[]
      if (selectedIds.length > 0) {
        // A selection may name an uploaded published UUID or a shipped static id.
        // Anything that is neither — or that is unavailable — is a conflict.
        const uploadedIds = selectedIds.filter((id) => BACKGROUND_ID.test(id))
        const staticIds = selectedIds.filter((id) => isStaticBackgroundId(id))
        if (uploadedIds.length + staticIds.length !== selectedIds.length) {
          return json({ error: 'background_selection_conflict' }, 409)
        }
        if (uploadedIds.length > 0) {
          const placeholders = uploadedIds.map(() => '?').join(', ')
          const count = await env.DB.prepare(`
            SELECT COUNT(*) AS count FROM background_media
            WHERE status = 'published' AND id IN (${placeholders})
          `).bind(...uploadedIds).first<{ count: number }>()
          if (count?.count !== uploadedIds.length) return json({ error: 'background_selection_conflict' }, 409)
        }
        if (staticIds.length > 0) {
          const placeholders = staticIds.map(() => '?').join(', ')
          const blocked = await env.DB.prepare(`
            SELECT COUNT(*) AS count FROM static_background_overrides
            WHERE status IN ('archived', 'tombstoned') AND id IN (${placeholders})
          `).bind(...staticIds).first<{ count: number }>()
          if ((blocked?.count ?? 0) > 0) return json({ error: 'background_selection_conflict' }, 409)
        }
      }
      const selection = {
        selectedIds,
        autoRotate: candidate.autoRotate,
        intervalSeconds: Number(candidate.intervalSeconds),
      }
      const expected = request.headers.get('if-match')
      if (expected !== null && expected !== 'absent' && !/^\d{1,16}$/.test(expected)) return json({ error: 'invalid_revision' }, 400)
      const nextRevision = Math.max(options.now(), Number(expected === 'absent' ? 0 : expected) + 1)
      if (selectedIds.length === 0) {
        const result = await env.DB.prepare("DELETE FROM user_background_selections WHERE user_id = ? AND (? IS NULL OR (? <> 'absent' AND updated_at = CAST(? AS INTEGER)))").bind(user.id, expected, expected, expected).run()
        if (expected !== null && result.meta.changes === 0 && (expected !== 'absent' || await env.DB.prepare('SELECT 1 AS present FROM user_background_selections WHERE user_id = ?').bind(user.id).first() !== null)) return json({ error: 'background_selection_conflict' }, 409)
      } else {
        const result = await env.DB.prepare(`
          INSERT INTO user_background_selections (
            user_id, selection_json, auto_rotate, interval_seconds, updated_at
          ) SELECT ?, ?, ?, ?, ?
          WHERE ? IS NULL OR ? = 'absent' OR EXISTS (
            SELECT 1 FROM user_background_selections WHERE user_id = ? AND updated_at = CAST(? AS INTEGER)
          )
          ON CONFLICT(user_id) DO UPDATE SET
            selection_json = excluded.selection_json,
            auto_rotate = excluded.auto_rotate,
            interval_seconds = excluded.interval_seconds,
            updated_at = excluded.updated_at
          WHERE ? IS NULL OR (? <> 'absent' AND user_background_selections.updated_at = CAST(? AS INTEGER))
        `).bind(
          user.id,
          JSON.stringify(selectedIds),
          candidate.autoRotate ? 1 : 0,
          Number(candidate.intervalSeconds),
          nextRevision, expected, expected, user.id, expected, expected, expected, expected,
        ).run()
        if (result.meta.changes === 0) return json({ error: 'background_selection_conflict' }, 409)
      }
      return json({ selection }, 200, selectedIds.length === 0 ? 'absent' : String(nextRevision))
    },
  }
}

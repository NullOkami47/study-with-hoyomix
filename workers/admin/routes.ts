import {createAdminAuthorisation,adminMutationOriginGuard} from './authz'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'
import { createBackgroundRoutes, type BackgroundEnv } from '../backgrounds/routes'
import type { D1Database, D1PreparedStatement, D1WriteValue } from '../env'
import {
  PLAYBACK_PROVIDER_IDS,
  type PlaybackProviderId,
  deploymentAvailableProviderIds,
  readProviderStates,
  type ProviderEnv,
  type ProviderState,
} from '../providers/config'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import {
  CHKSZ_OWNER_FALLBACK_SETTING,
  readChkszOwnerFallbackEnabled,
} from '../providers/chkszCredentials'
import {
  ChkszAdminSearchRateLimiter,
  executeChkszAdminSearch,
  validateChkszAdminSearchBody,
} from '../providers/chkszSearchProxy'

export interface AdminEnv extends ProviderEnv, BackgroundEnv {}

export interface AdminOptions {
  crypto?: Crypto
  now?: () => number
  fetch?: typeof fetch
  chkszSearchLimiter?: ChkszAdminSearchRateLimiter
  /** @internal Test-only: bypass in-memory inFlightPurges guard to model separate isolates. */
  __test_disableInFlightGuard?: boolean
}

type AdminRole = 'admin' | 'owner'
type NoticeSeverity = 'info' | 'warning' | 'critical'
type NoticeStatus = 'draft' | 'published' | 'archived'
type NoticeTargeting = 'everyone' | 'authenticated' | 'anonymous' | 'admin'
type Locale = 'zh-Hant' | 'zh-Hans' | 'en'
const LOCALES: readonly Locale[] = ['zh-Hant', 'zh-Hans', 'en']

const encoder = new TextEncoder()

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
})

interface ChkszOwnerFallbackProjection {
  ownerKeyConfigured: boolean
  ownerFallbackEnabled: boolean
  ownerFallbackUsable: boolean
}

const providerResponse = (state: ProviderState, chkszOwnerFallback?: ChkszOwnerFallbackProjection) => ({
  key: state.id,
  adminEnabled: state.adminEnabled,
  deploymentAvailable: state.deploymentAvailable,
  effectiveEnabled: state.effectiveEnabled,
  automaticPolicy: state.automaticPolicy,
  priority: state.priority,
  status: state.status,
  failureClass: state.failureClass,
  latencyMs: state.latencyMs,
  checkedAt: state.checkedAt,
  updatedAt: state.updatedAt,
  ...(state.id === 'chksz' && chkszOwnerFallback ? chkszOwnerFallback : {}),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MAX_ADMIN_JSON_BYTES = 64 * 1024

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await readBoundedJsonRequest(request, MAX_ADMIN_JSON_BYTES)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

const NOTICE_CONTENT_MAX = 1_000
const DISABLE_ALL_CONFIRMATION = 'DISABLE ALL PLAYBACK'
const INTERNAL_REASON_MAX = 500
const SEVERITIES: readonly NoticeSeverity[] = ['info', 'warning', 'critical']
const TARGETINGS: readonly NoticeTargeting[] = ['everyone', 'authenticated', 'anonymous', 'admin']
interface NoticeRow {
  id: string
  status: NoticeStatus
  severity: NoticeSeverity
  targeting: NoticeTargeting
  currentRevisionId: string
  startAt: number | null
  endAt: number | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  archivedAt: number | null
}

interface NoticeRevisionRow {
  id: string
  noticeId: string
  revisionNumber: number
  contentJson: string
  createdBy: string | null
  createdAt: number
}

type NoticeContent = Partial<Record<Locale, string>>

const isSeverity = (value: unknown): value is NoticeSeverity =>
  typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)

const isTargeting = (value: unknown): value is NoticeTargeting =>
  typeof value === 'string' && (TARGETINGS as readonly string[]).includes(value)

function parseContent(value: unknown): NoticeContent | null {
  if (!isRecord(value)) return null
  const content: NoticeContent = {}
  for (const locale of LOCALES) {
    const entry = value[locale]
    if (entry === undefined) continue
    if (typeof entry !== 'string') return null
    const trimmed = entry.trim()
    if (trimmed.length > NOTICE_CONTENT_MAX) return null
    if (trimmed.length > 0) content[locale] = trimmed
  }
  return content
}

const sameNoticeContent = (left: NoticeContent, right: NoticeContent) =>
  JSON.stringify(left) === JSON.stringify(right)

function noticeResponse(notice: NoticeRow, content: NoticeContent) {
  return {
    id: notice.id,
    revisionId: notice.currentRevisionId,
    status: notice.status,
    severity: notice.severity,
    targeting: notice.targeting,
    content,
    startAt: notice.startAt,
    endAt: notice.endAt,
    createdAt: notice.createdAt,
    updatedAt: notice.updatedAt,
    publishedAt: notice.publishedAt,
    archivedAt: notice.archivedAt,
  }
}

const readNoticeContent = async (database: D1Database, revisionId: string): Promise<NoticeContent> => {
  const row = await database.prepare(`
    SELECT content_json AS contentJson
    FROM admin_notice_revisions
    WHERE id = ?
  `).bind(revisionId).first<{ contentJson: string }>()
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.contentJson) as unknown
    return parseContent(parsed) ?? {}
  } catch {
    return {}
  }
}

export function createAdminHandler(env: AdminEnv, options: AdminOptions = {}) {
  const now = options.now ?? Date.now
  const cryptoApi = options.crypto ?? globalThis.crypto
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const searchLimiter = options.chkszSearchLimiter ?? new ChkszAdminSearchRateLimiter(now)
  const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin

  const {currentUser,currentAdmin}=createAdminAuthorisation(env,{now,crypto:cryptoApi})

  const auditStatement = (
    actorUserId: string,
    action: string,
    targetKey: string,
    detail: Record<string, unknown>,
    createdAt: number,
  ) => env.DB.prepare(`
    INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(cryptoApi.randomUUID(), actorUserId, action, targetKey, JSON.stringify(detail), createdAt)

  const backgroundRoutes = createBackgroundRoutes(env, {
    auditStatement,
    crypto: cryptoApi,
    now,
    __test_disableInFlightGuard: options.__test_disableInFlightGuard,
  })

  const readNoticeRow = (noticeId: string) => env.DB.prepare(`
    SELECT id, status, severity, targeting, current_revision_id AS currentRevisionId,
      start_at AS startAt, end_at AS endAt, created_by AS createdBy,
      created_at AS createdAt, updated_at AS updatedAt,
      published_at AS publishedAt, archived_at AS archivedAt
    FROM admin_notices
    WHERE id = ?
  `).bind(noticeId).first<NoticeRow>()

  const nextRevisionNumber = async (noticeId: string): Promise<number> => {
    const row = await env.DB.prepare(`
      SELECT COALESCE(MAX(revision_number), -1) + 1 AS nextNumber
      FROM admin_notice_revisions
      WHERE notice_id = ?
    `).bind(noticeId).first<{ nextNumber: number }>()
    return row?.nextNumber ?? 0
  }

  const createRevision = (
    noticeId: string,
    revisionId: string,
    revisionNumber: number,
    content: NoticeContent,
    actorId: string,
    createdAt: number,
  ) => env.DB.prepare(`
    INSERT INTO admin_notice_revisions (id, notice_id, revision_number, content_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(revisionId, noticeId, revisionNumber, JSON.stringify(content), actorId, createdAt)

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const isProviderOrderRoute = url.pathname === '/api/admin/providers/order'
    const providerMatch = !isProviderOrderRoute && url.pathname.match(/^\/api\/admin\/providers\/([a-z0-9-]+)$/)
    const isChkszOwnerFallbackRoute = url.pathname === '/api/admin/providers/chksz/owner-fallback'
    const noticeMatch = url.pathname.match(/^\/api\/admin\/notices\/([a-z0-9-]+)$/)
    const noticeActionMatch = url.pathname.match(/^\/api\/admin\/notices\/([a-z0-9-]+)\/(publish|archive)$/)

    const publicBackgroundResponse = await backgroundRoutes.handlePublic(request, url)
    if (publicBackgroundResponse) return publicBackgroundResponse

    const originError=adminMutationOriginGuard(request,publicOrigin)
    if(originError)return originError

    // Public notice endpoint - no admin required
    if (request.method === 'GET' && url.pathname === '/api/notices') {
      const nowMs = now()
      let viewer: 'anonymous' | 'authenticated' | 'admin' = 'anonymous'
      try {
        const session = await findSession(
          env.DB,
          readCookie(request, SESSION_COOKIE),
          env.SESSION_HMAC_SECRET,
          nowMs,
          cryptoApi,
        )
        if (session?.role === 'admin' || session?.role === 'owner') viewer = 'admin'
        else if (session) viewer = 'authenticated'
      } catch {
        // Optional session resolution must fail closed without making the public endpoint unavailable.
        viewer = 'anonymous'
      }
      const rows = await env.DB.prepare(`
        SELECT n.id, n.severity, n.targeting, n.start_at AS startAt, n.end_at AS endAt,
          n.published_at AS publishedAt, n.current_revision_id AS currentRevisionId,
          r.content_json AS contentJson
        FROM admin_notices n
        JOIN admin_notice_revisions r ON r.id = n.current_revision_id
        WHERE n.status = 'published'
          AND (n.start_at IS NULL OR n.start_at <= ?)
          AND (n.end_at IS NULL OR n.end_at >= ?)
        ORDER BY CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          n.published_at DESC
      `).bind(nowMs, nowMs).all<{
        id: string
        severity: NoticeSeverity
        targeting: NoticeTargeting
        startAt: number | null
        endAt: number | null
        publishedAt: number
        currentRevisionId: string
        contentJson: string
      }>()
      const visibleRows = rows.results.filter((row) => {
        if (row.targeting === 'everyone') return true
        if (row.targeting === 'anonymous') return viewer === 'anonymous'
        if (row.targeting === 'authenticated') return viewer !== 'anonymous'
        return viewer === 'admin'
      })
      const notices = visibleRows.map((row) => {
        let content: NoticeContent = {}
        try {
          content = parseContent(JSON.parse(row.contentJson)) ?? {}
        } catch {
          content = {}
        }
        return {
          id: row.id,
          revisionId: row.currentRevisionId,
          severity: row.severity,
          targeting: row.targeting,
          content,
          startAt: row.startAt,
          endAt: row.endAt,
          publishedAt: row.publishedAt,
        }
      })
      return json({ notices })
    }

    if (url.pathname === '/api/account/background-selection') {
      const user = await currentUser(request)
      if (user instanceof Response) return user
      return await backgroundRoutes.handleAccount(request, url, user) ?? json({ error: 'not_found' }, 404)
    }

    const admin = await currentAdmin(request)
    if (admin instanceof Response) return admin

    const adminBackgroundResponse = await backgroundRoutes.handleAdmin(request, url, admin)
    if (adminBackgroundResponse) return adminBackgroundResponse

    if (request.method === 'PUT' && isChkszOwnerFallbackRoute) {
      const body = await readJson(request)
      if (!body || !exactKeys(body, ['enabled']) || Object.keys(body).length !== 1 ||
        typeof body.enabled !== 'boolean') {
        return json({ error: 'invalid_chksz_owner_fallback_update' }, 400)
      }
      const enabled = body.enabled
      const changedAt = now()
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_json = excluded.setting_json,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `).bind(CHKSZ_OWNER_FALLBACK_SETTING, JSON.stringify({ enabled }), admin.id, changedAt),
        auditStatement(
          admin.id,
          'provider.chksz.owner-fallback.update',
          'provider:chksz',
          { enabled },
          changedAt,
        ),
      ])
      const ownerKeyConfigured = Boolean(env.CHKSZ_API_KEY?.trim())
      return json({
        ownerKeyConfigured,
        ownerFallbackEnabled: enabled,
        ownerFallbackUsable: enabled && ownerKeyConfigured,
      })
    }

    if (request.method === 'PUT' && isProviderOrderRoute) {
      const body = await readJson(request)
      if (
        !body ||
        !exactKeys(body, ['providerIds']) ||
        !Array.isArray(body.providerIds) ||
        body.providerIds.length !== PLAYBACK_PROVIDER_IDS.length ||
        new Set(body.providerIds).size !== PLAYBACK_PROVIDER_IDS.length ||
        !body.providerIds.every((id): id is PlaybackProviderId =>
          typeof id === 'string' && (PLAYBACK_PROVIDER_IDS as readonly string[]).includes(id))
      ) {
        return json({ error: 'invalid_provider_order' }, 400)
      }

      const providerIds = body.providerIds as PlaybackProviderId[]
      const changedAt = now()
      const normalized = providerIds.map((id, index) => ({ id, priority: (index + 1) * 10 }))

      await env.DB.batch([
        ...normalized.map(({ id, priority }) =>
          env.DB.prepare(`
            INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
            VALUES (?, 1, ?, 'unknown', ?)
            ON CONFLICT(provider_key) DO UPDATE SET
              priority = excluded.priority,
              updated_at = excluded.updated_at
          `).bind(id, priority, changedAt),
        ),
        auditStatement(
          admin.id,
          'provider.order.update',
          'providers',
          { providerIds },
          changedAt,
        ),
      ])

      const updatedStates = await readProviderStates(env.DB, env)
      const ownerFallbackEnabled = await readChkszOwnerFallbackEnabled(env.DB)
      const ownerKeyConfigured = Boolean(env.CHKSZ_API_KEY?.trim())
      const chkszOwnerFallback = {
        ownerKeyConfigured,
        ownerFallbackEnabled,
        ownerFallbackUsable: ownerFallbackEnabled && ownerKeyConfigured,
      }

      return json({
        providers: updatedStates
          .map((state) => providerResponse(state, chkszOwnerFallback))
          .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key)),
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/overview') {
      const providers = await readProviderStates(env.DB, env)
      const ownerFallbackEnabled = await readChkszOwnerFallbackEnabled(env.DB)
      const ownerKeyConfigured = Boolean(env.CHKSZ_API_KEY?.trim())
      const chkszOwnerFallback = {
        ownerKeyConfigured,
        ownerFallbackEnabled,
        ownerFallbackUsable: ownerFallbackEnabled && ownerKeyConfigured,
      }
      const noticeCount = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM admin_notices
        WHERE status = 'published'
          AND (start_at IS NULL OR start_at <= ?)
          AND (end_at IS NULL OR end_at >= ?)
      `).bind(now(), now()).first<{ count: number }>()
      return json({
        providers: providers
          .map((state) => providerResponse(state, chkszOwnerFallback))
          .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key)),
        activeNoticeCount: noticeCount?.count ?? 0,
      })
    }

    if (request.method === 'PATCH' && providerMatch) {
      const providerKey = providerMatch[1]
      const providerStates = await readProviderStates(env.DB, env)
      const existingState = providerStates.find((state) => state.id === providerKey)
      if (!existingState) return json({ error: 'provider_not_found' }, 404)
      const body = await readJson(request)
      if (!body || !exactKeys(body, ['enabled', 'priority', 'confirmation', 'reason']) || Object.keys(body).length === 0) {
        return json({ error: 'invalid_provider_update' }, 400)
      }
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return json({ error: 'invalid_provider_update' }, 400)
      }
      if (body.priority !== undefined && (
        !Number.isInteger(body.priority) || Number(body.priority) < 0 || Number(body.priority) > 1_000
      )) return json({ error: 'invalid_provider_update' }, 400)
      if ((body.confirmation !== undefined && typeof body.confirmation !== 'string') ||
        (body.reason !== undefined && typeof body.reason !== 'string')) {
        return json({ error: 'invalid_provider_update' }, 400)
      }
      const internalReason = body.reason === undefined ? '' : body.reason.trim()
      if (body.reason !== undefined && (internalReason.length === 0 || internalReason.length > INTERNAL_REASON_MAX)) {
        return json({ error: 'invalid_provider_update' }, 400)
      }
      if (body.enabled === true && !existingState.deploymentAvailable) {
        return json({ error: 'provider_unavailable' }, 409)
      }

      const persisted = await env.DB.prepare(`
        SELECT provider_key AS providerKey
        FROM provider_health
        WHERE provider_key = ?
      `).bind(providerKey).first<{ providerKey: string }>()
      const persistProviderBatch = async (statements: D1PreparedStatement[]): Promise<Response | null> => {
        try {
          await env.DB.batch(statements)
          return null
        } catch {
          return json({ error: 'provider_update_unavailable' }, 503)
        }
      }
      const enabled = body.enabled === undefined ? existingState.adminEnabled : body.enabled
      const priority = body.priority === undefined ? existingState.priority : Number(body.priority)
      const changedAt = now()
      const enabledValue = enabled ? 1 : 0
      const hasConfirmedGlobalShutdown = body.confirmation === DISABLE_ALL_CONFIRMATION && internalReason.length > 0
      const availableProviderIds = deploymentAvailableProviderIds(env)
      const availableProviderPlaceholders = availableProviderIds.map(() => '?').join(', ')
      const shutdownDetail = JSON.stringify({
        enabled,
        priority,
        globalPlaybackShutdown: true,
        reason: internalReason,
      })
      const updateDetail = JSON.stringify({ enabled, priority })
      if (body.enabled === undefined) {
        if (!persisted) return json({ error: 'provider_update_failed' }, 500)
        const priorityDetail = JSON.stringify({ priority })
        const persistenceFailure = await persistProviderBatch([
          env.DB.prepare(`
            UPDATE provider_health
            SET priority = ?, updated_at = ?
            WHERE provider_key = ? AND priority != ?
          `).bind(priority, changedAt, providerKey, priority),
          env.DB.prepare(`
            INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
            SELECT ?, ?, 'provider.update', ?, ?, ?
            FROM provider_health target
            WHERE changes() = 1 AND target.provider_key = ? AND target.priority = ?
          `).bind(
            cryptoApi.randomUUID(),
            admin.id,
            `provider:${providerKey}`,
            priorityDetail,
            changedAt,
            providerKey,
            priority,
          ),
        ])
        if (persistenceFailure) return persistenceFailure
      } else if (persisted) {
        // The transition UPDATE is a write-time compare-and-set. Its immediately
        // following audit uses SQLite changes() so only that actual transition is audited.
        const priorityAssignment = body.priority === undefined ? '' : ', priority = ?'
        const transitionBindings = body.priority === undefined ? [] : [priority]
        const transition = enabled
          ? env.DB.prepare(`
              UPDATE provider_health
              SET enabled = 1${priorityAssignment}, updated_at = ?
              WHERE provider_key = ? AND enabled = 0
            `).bind(...transitionBindings, changedAt, providerKey)
          : env.DB.prepare(`
              UPDATE provider_health
              SET enabled = 0${priorityAssignment}, updated_at = ?
              WHERE provider_key = ?
                AND enabled = 1
                AND (
                  ? = 0
                  OR EXISTS (
                    SELECT 1 FROM provider_health other
                    WHERE other.provider_key IN (${availableProviderPlaceholders})
                      AND other.provider_key != provider_health.provider_key
                      AND other.enabled = 1
                  )
                  OR ? = 1
                )
            `).bind(
              ...transitionBindings,
              changedAt,
              providerKey,
              existingState.deploymentAvailable ? 1 : 0,
              ...availableProviderIds,
              hasConfirmedGlobalShutdown ? 1 : 0,
            )
        const statements: D1PreparedStatement[] = [
          transition,
          env.DB.prepare(`
            INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
            SELECT ?, ?,
              CASE WHEN ? = 0 AND ? = 1 AND NOT EXISTS (
                SELECT 1 FROM provider_health other
                WHERE other.provider_key IN (${availableProviderPlaceholders})
                  AND other.provider_key != target.provider_key
                  AND other.enabled = 1
              ) THEN 'provider.disable_all' ELSE 'provider.update' END,
              ?,
              CASE WHEN ? = 0 AND ? = 1 AND NOT EXISTS (
                SELECT 1 FROM provider_health other
                WHERE other.provider_key IN (${availableProviderPlaceholders})
                  AND other.provider_key != target.provider_key
                  AND other.enabled = 1
              ) THEN ? ELSE ? END,
              ?
            FROM provider_health target
            WHERE changes() = 1 AND target.provider_key = ? AND target.enabled = ?
          `).bind(
            cryptoApi.randomUUID(),
            admin.id,
            enabledValue,
            existingState.deploymentAvailable ? 1 : 0,
            ...availableProviderIds,
            `provider:${providerKey}`,
            enabledValue,
            existingState.deploymentAvailable ? 1 : 0,
            ...availableProviderIds,
            shutdownDetail,
            updateDetail,
            changedAt,
            providerKey,
            enabledValue,
          ),
        ]
        if (body.priority !== undefined) {
          statements.push(
            env.DB.prepare(`
              UPDATE provider_health
              SET priority = ?, updated_at = ?
              WHERE provider_key = ? AND enabled = ? AND priority != ?
            `).bind(priority, changedAt, providerKey, enabledValue, priority),
            env.DB.prepare(`
              INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
              SELECT ?, ?, 'provider.update', ?, ?, ?
              FROM provider_health target
              WHERE changes() = 1 AND target.provider_key = ? AND target.enabled = ? AND target.priority = ?
            `).bind(
              cryptoApi.randomUUID(),
              admin.id,
              `provider:${providerKey}`,
              updateDetail,
              changedAt,
              providerKey,
              enabledValue,
              priority,
            ),
          )
        }
        const persistenceFailure = await persistProviderBatch(statements)
        if (persistenceFailure) return persistenceFailure
      } else {
        const logicalDisableTransition = existingState.effectiveEnabled && !enabled ? 1 : 0
        const persistenceFailure = await persistProviderBatch([
          env.DB.prepare(`
            INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
            SELECT ?, ?, ?, 'unknown', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM provider_health WHERE provider_key = ?
            )
              AND (
                ? = 0
                OR ? = 1
                OR EXISTS (
                  SELECT 1 FROM provider_health other
                  WHERE other.provider_key IN (${availableProviderPlaceholders})
                    AND other.provider_key != ?
                    AND other.enabled = 1
                )
                OR ? = 1
              )
          `).bind(
            providerKey,
            enabledValue,
            priority,
            changedAt,
            providerKey,
            logicalDisableTransition,
            enabledValue,
            ...availableProviderIds,
            providerKey,
            hasConfirmedGlobalShutdown ? 1 : 0,
          ),
          env.DB.prepare(`
            INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
            SELECT ?, ?,
              CASE WHEN ? = 1 AND NOT EXISTS (
                SELECT 1 FROM provider_health other
                WHERE other.provider_key IN (${availableProviderPlaceholders})
                  AND other.provider_key != target.provider_key
                  AND other.enabled = 1
              ) THEN 'provider.disable_all' ELSE 'provider.update' END,
              ?,
              CASE WHEN ? = 1 AND NOT EXISTS (
                SELECT 1 FROM provider_health other
                WHERE other.provider_key IN (${availableProviderPlaceholders})
                  AND other.provider_key != target.provider_key
                  AND other.enabled = 1
              ) THEN ? ELSE ? END,
              ?
            FROM provider_health target
            WHERE changes() = 1 AND target.provider_key = ? AND target.enabled = ? AND target.updated_at = ?
          `).bind(
            cryptoApi.randomUUID(),
            admin.id,
            logicalDisableTransition,
            ...availableProviderIds,
            `provider:${providerKey}`,
            logicalDisableTransition,
            ...availableProviderIds,
            shutdownDetail,
            updateDetail,
            changedAt,
            providerKey,
            enabledValue,
            changedAt,
          ),
        ])
        if (persistenceFailure) return persistenceFailure
      }
      const updated = (await readProviderStates(env.DB, env)).find((state) => state.id === providerKey)
      if (body.enabled !== undefined && updated?.adminEnabled !== enabled) {
        return json({ error: enabled ? 'provider_update_conflict' : 'global_playback_shutdown_confirmation_required' }, enabled ? 409 : 400)
      }
      if (!updated) return json({ error: 'provider_update_failed' }, 500)
      const ownerFallbackEnabled = updated.id === 'chksz'
        ? await readChkszOwnerFallbackEnabled(env.DB)
        : false
      const ownerKeyConfigured = Boolean(env.CHKSZ_API_KEY?.trim())
      return json({
        provider: providerResponse(updated, {
          ownerKeyConfigured,
          ownerFallbackEnabled,
          ownerFallbackUsable: ownerFallbackEnabled && ownerKeyConfigured,
        }),
      })
    }

    // Multi-notice CRUD
    if (request.method === 'GET' && url.pathname === '/api/admin/notices') {
      const rows = await env.DB.prepare(`
        SELECT id, status, severity, targeting, current_revision_id AS currentRevisionId,
          start_at AS startAt, end_at AS endAt, created_by AS createdBy,
          created_at AS createdAt, updated_at AS updatedAt,
          published_at AS publishedAt, archived_at AS archivedAt
        FROM admin_notices
        ORDER BY updated_at DESC
      `).all<NoticeRow>()
      const notices = []
      for (const row of rows.results) {
        const content = await readNoticeContent(env.DB, row.currentRevisionId)
        notices.push(noticeResponse(row, content))
      }
      return json({ notices })
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/notices') {
      const body = await readJson(request)
      if (!body || !exactKeys(body, ['severity', 'targeting', 'content', 'startAt', 'endAt'])) {
        return json({ error: 'invalid_notice' }, 400)
      }
      if (!isSeverity(body.severity) || !isTargeting(body.targeting)) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const content = parseContent(body.content)
      if (!content || Object.keys(content).length === 0) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const startAt = body.startAt === undefined || body.startAt === null
        ? null
        : (Number.isInteger(body.startAt) && Number(body.startAt) >= 0 ? Number(body.startAt) : null)
      if (body.startAt !== undefined && body.startAt !== null && startAt === null) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const endAt = body.endAt === undefined || body.endAt === null
        ? null
        : (Number.isInteger(body.endAt) && Number(body.endAt) >= 0 ? Number(body.endAt) : null)
      if (body.endAt !== undefined && body.endAt !== null && endAt === null) {
        return json({ error: 'invalid_notice' }, 400)
      }
      if (startAt !== null && endAt !== null && endAt < startAt) {
        return json({ error: 'invalid_notice' }, 400)
      }

      const noticeId = cryptoApi.randomUUID()
      const revisionId = cryptoApi.randomUUID()
      const changedAt = now()
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO admin_notices (id, status, severity, targeting, current_revision_id,
            start_at, end_at, created_by, created_at, updated_at)
          VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(noticeId, body.severity, body.targeting, revisionId, startAt, endAt, admin.id, changedAt, changedAt),
        createRevision(noticeId, revisionId, 0, content, admin.id, changedAt),
        auditStatement(admin.id, 'notice.create', `notice:${noticeId}`, {
          severity: body.severity,
          targeting: body.targeting,
          revision: 0,
        }, changedAt),
      ])
      const row = await readNoticeRow(noticeId)
      return row ? json({ notice: noticeResponse(row, content) }, 201) : json({ error: 'notice_create_failed' }, 500)
    }

    if (request.method === 'GET' && noticeMatch) {
      const noticeId = noticeMatch[1]
      const row = await readNoticeRow(noticeId)
      if (!row) return json({ error: 'notice_not_found' }, 404)
      const content = await readNoticeContent(env.DB, row.currentRevisionId)
      return json({ notice: noticeResponse(row, content) })
    }

    if (request.method === 'PATCH' && noticeMatch) {
      const noticeId = noticeMatch[1]
      const row = await readNoticeRow(noticeId)
      if (!row) return json({ error: 'notice_not_found' }, 404)
      if (row.status === 'archived') return json({ error: 'notice_archived' }, 409)

      const body = await readJson(request)
      if (!body || !exactKeys(body, ['severity', 'targeting', 'content', 'startAt', 'endAt']) || Object.keys(body).length === 0) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const severity = body.severity === undefined ? row.severity : (isSeverity(body.severity) ? body.severity : null)
      if (body.severity !== undefined && severity === null) return json({ error: 'invalid_notice' }, 400)
      const targeting = body.targeting === undefined ? row.targeting : (isTargeting(body.targeting) ? body.targeting : null)
      if (body.targeting !== undefined && targeting === null) return json({ error: 'invalid_notice' }, 400)
      const content = body.content === undefined ? null : parseContent(body.content)
      if (body.content !== undefined && (!content || Object.keys(content).length === 0)) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const currentContent = await readNoticeContent(env.DB, row.currentRevisionId)
      const startAt = body.startAt === undefined ? row.startAt
        : (body.startAt === undefined || body.startAt === null ? null
          : (Number.isInteger(body.startAt) && Number(body.startAt) >= 0 ? Number(body.startAt) : null))
      if (body.startAt !== undefined && body.startAt !== null && startAt === null) {
        return json({ error: 'invalid_notice' }, 400)
      }
      const endAt = body.endAt === undefined ? row.endAt
        : (body.endAt === undefined || body.endAt === null ? null
          : (Number.isInteger(body.endAt) && Number(body.endAt) >= 0 ? Number(body.endAt) : null))
      if (body.endAt !== undefined && body.endAt !== null && endAt === null) {
        return json({ error: 'invalid_notice' }, 400)
      }
      if (startAt !== null && endAt !== null && endAt < startAt) {
        return json({ error: 'invalid_notice' }, 400)
      }

      const changedAt = now()
      const materialChange = severity !== row.severity
        || targeting !== row.targeting
        || startAt !== row.startAt
        || endAt !== row.endAt
        || (content !== null && !sameNoticeContent(content, currentContent))
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`
          UPDATE admin_notices
          SET severity = ?, targeting = ?, start_at = ?, end_at = ?, updated_at = ?
          WHERE id = ?
        `).bind(severity, targeting, startAt, endAt, changedAt, noticeId),
      ]
      if (materialChange) {
        const revisionId = cryptoApi.randomUUID()
        const revisionNumber = await nextRevisionNumber(noticeId)
        const revisionContent = content && !sameNoticeContent(content, currentContent)
          ? content
          : currentContent
        statements.push(
          createRevision(noticeId, revisionId, revisionNumber, revisionContent, admin.id, changedAt),
          env.DB.prepare(`UPDATE admin_notices SET current_revision_id = ?, updated_at = ? WHERE id = ?`)
            .bind(revisionId, changedAt, noticeId),
        )
        statements.push(
          auditStatement(admin.id, 'notice.update', `notice:${noticeId}`, {
            severity, targeting, revision: revisionNumber,
          }, changedAt),
        )
      } else {
        statements.push(
          auditStatement(admin.id, 'notice.update', `notice:${noticeId}`, {
            severity, targeting,
          }, changedAt),
        )
      }
      await env.DB.batch(statements)
      const updated = await readNoticeRow(noticeId)
      const finalContent = updated ? await readNoticeContent(env.DB, updated.currentRevisionId) : {}
      return updated ? json({ notice: noticeResponse(updated, finalContent) }) : json({ error: 'notice_update_failed' }, 500)
    }

    if (request.method === 'POST' && noticeActionMatch) {
      const noticeId = noticeActionMatch[1]
      const action = noticeActionMatch[2] as 'publish' | 'archive'
      const row = await readNoticeRow(noticeId)
      if (!row) return json({ error: 'notice_not_found' }, 404)

      const changedAt = now()
      if (action === 'publish') {
        if (row.status === 'archived') return json({ error: 'notice_archived' }, 409)
        if (row.status === 'published') return json({ error: 'notice_already_published' }, 409)
        const results = await env.DB.batch([
          env.DB.prepare(`
            UPDATE admin_notices
            SET status = 'published', published_at = ?, archived_at = NULL, updated_at = ?
            WHERE id = ?
              AND status = 'draft'
          `).bind(changedAt, changedAt, noticeId),
          env.DB.prepare(`
            INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
            SELECT ?, ?, 'notice.publish', ?, '{}', ?
            WHERE changes() = 1
          `).bind(cryptoApi.randomUUID(), admin.id, `notice:${noticeId}`, changedAt),
        ])
        if ((results[0]?.meta.changes ?? 0) === 0) return json({ error: 'notice_already_published' }, 409)
      } else {
        if (row.status === 'archived') return json({ error: 'notice_archived' }, 409)
        const results = await env.DB.batch([
          env.DB.prepare(`
            UPDATE admin_notices
            SET status = 'archived', archived_at = ?, updated_at = ?
            WHERE id = ?
              AND status != 'archived'
          `).bind(changedAt, changedAt, noticeId),
          env.DB.prepare(`
            INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
            SELECT ?, ?, 'notice.archive', ?, '{}', ?
            WHERE changes() = 1
          `).bind(cryptoApi.randomUUID(), admin.id, `notice:${noticeId}`, changedAt),
        ])
        if ((results[0]?.meta.changes ?? 0) === 0) return json({ error: 'notice_archived' }, 409)
      }
      const updated = await readNoticeRow(noticeId)
      const content = updated ? await readNoticeContent(env.DB, updated.currentRevisionId) : {}
    return updated ? json({ notice: noticeResponse(updated, content) }) : json({ error: 'notice_action_failed' }, 500)
    }

    if (request.method === 'GET' && (url.pathname === '/api/admin/audit' || url.pathname === '/api/admin/audit/export')) {
      const isExport = url.pathname === '/api/admin/audit/export'
      if (isExport && admin.role !== 'owner') return json({ error: 'forbidden' }, 403)
      const params = url.searchParams
      const conditions: string[] = []
      const binds: D1WriteValue[] = []
      const actor = params.get('actor')
      if (actor) { conditions.push('actor_user_id = ?'); binds.push(actor) }
      const action = params.get('action')
      if (action) { conditions.push('action = ?'); binds.push(action) }
      const target = params.get('target')
      if (target) { conditions.push('target_key = ?'); binds.push(target) }
      const module = params.get('module')
      if (module) { conditions.push('action LIKE ?'); binds.push(`${module}.%`) }
      const from = params.get('from')
      if (from !== null) {
        const n = Number(from)
        if (Number.isInteger(n) && n >= 0) { conditions.push('created_at >= ?'); binds.push(n) }
      }
      const to = params.get('to')
      if (to !== null) {
        const n = Number(to)
        if (Number.isInteger(n) && n >= 0) { conditions.push('created_at <= ?'); binds.push(n) }
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const limit = isExport ? 1_000 : Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200)
      const offset = isExport ? 0 : Math.max(Number(params.get('offset') ?? 0) || 0, 0)
      const rows = await env.DB.prepare(`
        SELECT id, actor_user_id AS actorUserId, action, target_key AS targetKey,
          detail_json AS detailJson, created_at AS createdAt
        FROM admin_audit_log
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(...binds, limit, offset).all<{
        id: string
        actorUserId: string | null
        action: string
        targetKey: string
        detailJson: string
        createdAt: number
      }>()
      const countRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_audit_log ${where}`)
        .bind(...binds).first<{ count: number }>()
      const mapAuditEntry = (row: {
        id: string
        actorUserId: string | null
        action: string
        targetKey: string
        detailJson: string
        createdAt: number
      }) => {
        let detail: Record<string, unknown> = {}
        try { const parsed = JSON.parse(row.detailJson) ?? {}; detail = isRecord(parsed) ? parsed : {} } catch { detail = {} }
        return {
          id: row.id,
          actorUserId: row.actorUserId,
          action: row.action,
          targetKey: row.targetKey,
          detail,
          createdAt: row.createdAt,
        }
      }
      const entries = rows.results.map(mapAuditEntry)
      const total = countRow?.count ?? 0
      if (isExport) {
        type AuditRow = {
          id: string
          actorUserId: string | null
          action: string
          targetKey: string
          detailJson: string
          createdAt: number
        }
        let cursor = rows.results.at(-1)
        let lastPageSize = rows.results.length
        while (cursor && lastPageSize === limit) {
          const pageConditions = [
            ...conditions,
            '(created_at < ? OR (created_at = ? AND id < ?))',
          ]
          const pageWhere = pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : ''
          const page = await env.DB.prepare(`
            SELECT id, actor_user_id AS actorUserId, action, target_key AS targetKey,
              detail_json AS detailJson, created_at AS createdAt
            FROM admin_audit_log
            ${pageWhere}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).bind(...binds, cursor.createdAt, cursor.createdAt, cursor.id, limit).all<AuditRow>()
          entries.push(...page.results.map(mapAuditEntry))
          cursor = page.results.at(-1)
          lastPageSize = page.results.length
          if (page.results.length < limit) break
        }
        return new Response(JSON.stringify({
          entries,
          total,
          exportedCount: entries.length,
          complete: false,
          snapshotComplete: false,
          consistency: 'append-aware-keyset',
        }, null, 2), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="audit-export.json"',
            'cache-control': 'no-store',
          },
        })
      }
      return json({ entries, total, limit, offset })
    }

    // Task 15 — admin-only owner-key ChKSz search. Narrow discovery proxy: fixed
    // upstream destination, bounded keyword/limit/offset, per-admin rate limit,
    // bounded upstream body, timeout, no key reflection. Requires an
    // authenticated admin/owner (checked above), a configured owner key, and the
    // owner-fallback setting enabled (explicit operator opt-in to owner-key use).
    if (url.pathname === '/api/admin/providers/chksz/search') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
      const body = await readJson(request)
      if (!body) return json({ error: 'invalid_search_body' }, 400)
      const validated = validateChkszAdminSearchBody(body)
      if (!validated.ok) return json({ error: validated.error }, 400)
      const ownerKey = env.CHKSZ_API_KEY?.trim()
      if (!ownerKey) return json({ error: 'owner_search_unavailable' }, 503)
      let fallbackEnabled = false
      try {
        fallbackEnabled = await readChkszOwnerFallbackEnabled(env.DB)
      } catch {
        return json({ error: 'owner_search_unavailable' }, 503)
      }
      if (!fallbackEnabled) return json({ error: 'owner_search_disabled' }, 503)
      const result = await executeChkszAdminSearch(
        admin.id,
        { keyword: validated.keyword, limit: validated.limit, offset: validated.offset },
        ownerKey,
        { fetch: fetchImpl, limiter: searchLimiter },
      )
      const changedAt = now()
      try {
        await env.DB.batch([
          auditStatement(admin.id, 'provider.chksz.search', 'provider:chksz', result.auditDetail, changedAt),
        ])
      } catch {
        // Audit failure must not leak the key or break the response contract; the
        // search result itself carries no secret material.
      }
      const headers: Record<string, string> = { 'cache-control': 'no-store' }
      if (result.headers?.['retry-after']) headers['retry-after'] = result.headers['retry-after']
      return Response.json(result.body, { status: result.status, headers })
    }

    return json({ error: 'not_found' }, 404)
 }

  return { fetch: fetchHandler }
}

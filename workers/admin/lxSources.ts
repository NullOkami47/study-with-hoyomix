// Admin endpoints for the global LX source registry.
//
// Mutation rules, enforced here rather than in the UI:
//   * only an Owner may create, change, reorder, delete or adopt a source;
//   * an origin URL must be HTTPS and point at a `.js` file;
//   * a candidate is screened before storage; embedded credentials require explicit Owner
//     disclosure confirmation for the exact script digest, and HTTP branches remain blocked;
//   * a script is never executed here — it is stored and later executed only in the user's
//     browser, inside the QuickJS Web Worker sandbox;
//   * nothing is adopted automatically: an update is fetched, its digest is shown, and a separate
//     explicit call moves the pointer;
//   * a failed update leaves the active pointer, and therefore playback, untouched;
//   * every mutation writes an audit record.

import { cspSourceAllows, parseLxAllowedOrigins } from '../../src/shared/lxCspPolicy'
import type { D1Database } from '../env'
import {
  analyseLxScript,
  fetchRemoteScript,
  readManagedSnapshots,
  materializeManagedLxSource,
  MANAGED_LX_SOURCE_ID,
  MANAGED_LX_DELETION_SETTING,
  readManagedLxSource,
  readManagedLxSources,
  readRegistryRevision,
  readManagedSnapshotScript,
  screenLxScript,
  sha256Hex,
  snapshotStatement,
  bumpRevisionStatement,
  validateOriginUrl,
  type LxGlobalSourceRow,
  type LxGlobalSourceStatus,
} from '../lx/globalSources'

export interface LxSourcesEnv {
  DB: D1Database
  /**
   * The deployment's approved LX origins, in the same syntax as the build-time
   * `LX_ALLOWED_ORIGINS`. It must name the same origins as the build, otherwise the server and the
   * document policy disagree; the client always checks the real policy too, so a mismatch can only
   * cause a source to be refused at runtime, never to widen access.
   */
  LX_ALLOWED_ORIGINS?: string
  PUBLIC_ORIGIN?: string
}

export interface LxSourcesOptions {
  now?: () => number
  crypto?: Crypto
  fetch?: typeof fetch
  /**
   * Owner check. Returns the acting Owner's id when the caller may mutate, or the Response to send
   * when they may not. The id is required because every mutation writes an audit record.
   */
  requireOwner?: (request: Request) => Promise<Response | { id: string }>
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** Stable ids so a source keeps its identity and its snapshots across renames. */
const makeSourceId = (cryptoApi: Crypto): string => `lxg_${cryptoApi.randomUUID().replace(/-/gu, '').slice(0, 24)}`

const isHttpsOriginAllowed = (origin: string, allowed: readonly string[]): boolean => {
  let target: URL
  try {
    target = new URL(origin)
  } catch {
    return false
  }
  return allowed.some((source) => cspSourceAllows(source, target))
}

/**
 * Decides the publication status of a source from the origins it needs.
 *
 * An origin that the deployment has not approved leaves the source in `pending_network_approval`,
 * and a source in that state is not published to anonymous clients. The CSP is never widened
 * automatically: an operator has to add the origin to `LX_ALLOWED_ORIGINS` and rebuild.
 */
const publicationStatus = (
  requiredOrigins: readonly string[],
  allowed: readonly string[],
  enabled: boolean,
): { status: LxGlobalSourceStatus; pendingOrigins: string[] } => {
  const pending = requiredOrigins.filter((origin) => !isHttpsOriginAllowed(origin, allowed))
  if (pending.length > 0) return { status: 'pending_network_approval', pendingOrigins: pending }
  return { status: enabled ? 'active' : 'disabled', pendingOrigins: [] }
}

export function createLxSourcesHandler(env: LxSourcesEnv, options: LxSourcesOptions = {}) {
  const now = options.now ?? Date.now
  const cryptoApi = options.crypto ?? globalThis.crypto
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  const allowedOrigins = (): string[] => {
    try {
      return parseLxAllowedOrigins(env.LX_ALLOWED_ORIGINS)
    } catch {
      // An invalid allow-list must not silently widen access: treat it as "nothing is approved".
      return []
    }
  }

  /**
   * What this Worker is actually enforcing, for the Admin console.
   *
   * The build and the Worker read `LX_ALLOWED_ORIGINS` independently — the build turns it into
   * `connect-src`/`media-src`, the Worker turns it into a publication decision — so an operator who
   * sets the two differently gets a registry that publishes sources the document policy will refuse.
   * Neither side can read the other's value, so this cannot be detected automatically; what it can
   * do is state the list plainly, which is what makes the deployment check a diff rather than a
   * guess. `valid: false` means the value did not parse, and then nothing with a detected origin is
   * published at all.
   */
  const policyView = (): { allowedOrigins: string[]; valid: boolean } => {
    try {
      return { allowedOrigins: parseLxAllowedOrigins(env.LX_ALLOWED_ORIGINS), valid: true }
    } catch {
      return { allowedOrigins: [], valid: false }
    }
  }

  const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
    try {
      const body = (await request.json()) as unknown
      return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  const auditStatement = (
    actorId: string,
    action: string,
    targetKey: string,
    detail: Record<string, unknown>,
  ) => env.DB.prepare(
      `INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(cryptoApi.randomUUID(), actorId, action, targetKey, JSON.stringify(detail), now())

  const recordCheck = async (
    actorId: string, id: string, stamp: number, note: string,
    action: string, detail: Record<string, unknown>,
  ): Promise<void> => {
    await env.DB.batch([
      ...materializeManagedLxSource(env.DB, id, stamp),
      env.DB.prepare('UPDATE lx_global_sources SET last_checked_at = ?, last_check_note = ? WHERE id = ?')
        .bind(stamp, note, id),
      bumpRevisionStatement(env.DB, stamp),
      auditStatement(actorId, action, id, detail),
    ])
  }

  /**
   * Authorises a mutation and yields the acting Owner's id.
   *
   * The id comes from the same check as the authorisation on purpose: an audit record whose actor
   * is not a real user cannot be written (the audit table has a foreign key), so a guard that
   * returned only "allowed" would let every mutation fail at the audit step.
   */
  const ownerGuard = async (request: Request): Promise<Response | { id: string }> => {
    if (!options.requireOwner) {
      return json({ error: 'owner_guard_not_configured' }, 500)
    }
    return options.requireOwner(request)
  }

  const disclosure = (script: string, sha256: string, approvedDigest: unknown) => {
    const keys = analyseLxScript(script).credentialKeys
    return keys.length && approvedDigest === sha256 ? { sha256, keys } : undefined
  }

  /** Builds the response body for a source, including its snapshot history. */
  const describe = async (row: LxGlobalSourceRow) => ({
    id: row.id,
    managed: row.id === MANAGED_LX_SOURCE_ID,
    name: row.name,
    version: row.version,
    originUrl: row.originUrl,
    originKind: row.originKind,
    sha256: row.activeSha256,
    enabled: row.enabled,
    priority: row.priority,
    status: row.status,
    requiredOrigins: row.requiredOrigins,
    pendingOrigins: row.pendingOrigins,
    // Importing a multi-backend script does not grant its HTTP branches network access.
    plaintextOrigins: analyseLxScript((await readManagedSnapshotScript(env.DB, row.id, row.activeSha256))?.script ?? '').plaintextOrigins,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckNote: row.lastCheckNote,
    snapshots: await Promise.all((await readManagedSnapshots(env.DB, row.id)).map(async (snapshot) => ({
      sha256: snapshot.sha256,
      version: snapshot.version,
      createdAt: snapshot.createdAt,
      note: snapshot.note,
      active: snapshot.sha256 === row.activeSha256,
      credentialKeys: analyseLxScript((await readManagedSnapshotScript(env.DB, row.id, snapshot.sha256))?.script ?? '').credentialKeys,
    }))),
  })

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const path = url.pathname

      if (path === '/api/admin/lx/sources' && request.method === 'GET') {
        // Reads are Owner-only too. The rest of the Admin API enforces this with a single guard
        // before its routing table (workers/admin/routes.ts), and this handler is mounted outside
        // that table — without this call, the list would hand an anonymous caller the sources the
        // Owner has *not* published: their import URLs, snapshot history and failure notes.
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const revision = await readRegistryRevision(env.DB)
        const rows = await readManagedLxSources(env.DB)
        return json({ revision, policy: policyView(), sources: await Promise.all(rows.map(describe)) })
      }

      if (path === '/api/admin/lx/sources' && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id

        const body = await readJson(request)
        if (!body) return json({ error: 'invalid_body' }, 400)

        const rawScript = typeof body.script === 'string' ? body.script : null
        const rawUrl = typeof body.url === 'string' ? body.url : null

        let script: string
        let originUrl: string
        let originKind: 'url' | 'upload'

        if (rawScript !== null) {
          originKind = 'upload'
          const uploadOrigin = typeof body.originUrl === 'string' ? body.originUrl : null
          let uploadUrl: string | null = null
          if (uploadOrigin !== null) {
            const validated = validateOriginUrl(uploadOrigin)
            if (!validated.ok) return json({ error: 'invalid_origin_url', message: validated.reason }, 400)
            uploadUrl = validated.url
          }
          // An uploaded script has no origin of its own; it is attributed to the deployment so the
          // audit trail says where it came from without inventing a URL that does not exist.
          originUrl = uploadUrl ?? `upload:${env.PUBLIC_ORIGIN ?? 'self'}`
          script = rawScript
        } else if (rawUrl !== null) {
          originKind = 'url'
          const validated = validateOriginUrl(rawUrl)
          if (!validated.ok) return json({ error: 'invalid_origin_url', message: validated.reason }, 400)
          originUrl = validated.url
          const fetched = await fetchRemoteScript(originUrl, fetchImpl)
          if (!fetched.ok) return json({ error: fetched.rejection.code, message: fetched.rejection.message }, 422)
          script = fetched.script
        } else {
          return json({ error: 'invalid_body', message: 'Provide either a source URL or an uploaded script' }, 400)
        }

        const sha256 = await sha256Hex(script)
        const credentialDisclosure = disclosure(script, sha256, body.credentialDisclosureSha256)
        const rejection = screenLxScript(script, { allowPlaintextOrigins: true, allowEmbeddedCredentials: Boolean(credentialDisclosure) })
        if (rejection) {
          return json({ error: rejection.code, message: rejection.message }, 422)
        }

        const analysis = analyseLxScript(script)
        const name =
          (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null) ?? analysis.name ?? originUrl
        const version =
          (typeof body.version === 'string' && body.version.trim() ? body.version.trim() : null) ?? analysis.version ?? null
        const priority = typeof body.priority === 'number' && Number.isFinite(body.priority)
          ? Math.min(1000, Math.max(0, Math.trunc(body.priority)))
          : 100

        const id = makeSourceId(cryptoApi)
        const stamp = now()
        const { status, pendingOrigins } = publicationStatus(analysis.httpsOrigins, allowedOrigins(), true)

        // One atomic batch: the source row, its first snapshot and the registry revision. The
        // snapshot references the source, so the two cannot be written separately — D1 checks the
        // foreign key, and a half-applied create would leave a source with no script.
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO lx_global_sources
              (id, name, version, origin_url, active_sha256, enabled, priority, status,
               required_origins, pending_origins, origin_kind, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id,
            name.slice(0, 128),
            version,
            originUrl.slice(0, LX_ORIGIN_URL_MAX),
            sha256,
            priority,
            status,
            JSON.stringify(analysis.httpsOrigins),
            JSON.stringify(pendingOrigins),
            originKind,
            stamp,
            stamp,
          ),
          snapshotStatement(env.DB, { sourceId: id, sha256, script, version, now: stamp, note: 'initial import' }),
          bumpRevisionStatement(env.DB, stamp),
          auditStatement(ownerId, 'lx_source.create', id, {
          name,
          sha256,
          originUrl,
          status,
          requiredOrigins: analysis.httpsOrigins,
          pendingOrigins,
          credentialDisclosure,
        }),
        ])
        const revision = await readRegistryRevision(env.DB)



        const created = await readManagedLxSource(env.DB, id)
        return json({ revision, source: created ? await describe(created) : null }, 201)
      }

      if (path === '/api/admin/lx/sources/preview' && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id
        const body = await readJson(request)
        if (!body) return json({ error: 'invalid_body' }, 400)

        // A preview is never stored. It exists so the Owner can test a candidate in their own
        // browser sandbox *before* deciding to publish it.
        let script: string
        if (typeof body.script === 'string') {
          script = body.script
        } else if (typeof body.url === 'string') {
          const validated = validateOriginUrl(body.url)
          if (!validated.ok) return json({ error: 'invalid_origin_url', message: validated.reason }, 400)
          const fetched = await fetchRemoteScript(validated.url, fetchImpl)
          if (!fetched.ok) return json({ error: fetched.rejection.code, message: fetched.rejection.message }, 422)
          script = fetched.script
        } else {
          return json({ error: 'invalid_body', message: 'Provide either a source URL or a script' }, 400)
        }

        const rejection = screenLxScript(script, { allowPlaintextOrigins: true, allowEmbeddedCredentials: true })
        if (rejection) return json({ error: rejection.code, message: rejection.message }, 422)
        const analysis = analyseLxScript(script)
        const sha256 = await sha256Hex(script)
        return json({
          sha256,
          name: analysis.name,
          version: analysis.version,
          requiredOrigins: analysis.httpsOrigins,
          headerOrigins: analysis.headerOrigins,
          plaintextOrigins: analysis.plaintextOrigins,
          credentialKeys: analysis.credentialKeys,
          byteLength: analysis.byteLength,
          script,
        })
      }

      const orderMatch = path.match(/^\/api\/admin\/lx\/sources\/order$/u)
      if (orderMatch && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id
        const body = await readJson(request)
        const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
        if (ids.length === 0) return json({ error: 'invalid_body', message: 'ids must be a non-empty array' }, 400)

        const existing = await readManagedLxSources(env.DB)
        const known = new Set(existing.map((row) => row.id))
        if (ids.some((id) => !known.has(id))) {
          return json({ error: 'unknown_source', message: 'ids must name existing sources' }, 400)
        }
        const stamp = now()
        const statements = ids.map((id, index) => env.DB.prepare('UPDATE lx_global_sources SET priority = ?, updated_at = ? WHERE id = ?')
          .bind((index + 1) * 10, stamp, id))
        await env.DB.batch([
          ...ids.flatMap((id) => materializeManagedLxSource(env.DB, id, stamp)),
          ...statements,
          bumpRevisionStatement(env.DB, stamp),
          auditStatement(ownerId, 'lx_source.reorder', 'registry', { ids }),
        ])
        const revision = await readRegistryRevision(env.DB)
        return json({ revision })
      }

      const sourceMatch = path.match(/^\/api\/admin\/lx\/sources\/([A-Za-z0-9._-]+)$/u)
      if (sourceMatch) {
        const id = sourceMatch[1]!
        if (!LABEL.test(id)) return json({ error: 'invalid_id' }, 400)

        if (request.method === 'GET') {
          // Same reason as the list above: an unpublished source's detail is not public.
          const guard = await ownerGuard(request)
          if (guard instanceof Response) return guard
          const row = await readManagedLxSource(env.DB, id)
          if (!row) return json({ error: 'not_found' }, 404)
          return json({ source: await describe(row) })
        }

        if (request.method === 'PATCH') {
          const guard = await ownerGuard(request)
          if (guard instanceof Response) return guard
          const ownerId = guard.id
          const row = await readManagedLxSource(env.DB, id)
          if (!row) return json({ error: 'not_found' }, 404)
          const body = await readJson(request)
          if (!body) return json({ error: 'invalid_body' }, 400)

          const enabled = typeof body.enabled === 'boolean' ? body.enabled : row.enabled
          const priority =
            typeof body.priority === 'number' && Number.isFinite(body.priority)
              ? Math.min(1000, Math.max(0, Math.trunc(body.priority)))
              : row.priority
          const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 128) : row.name

          // The required origins are derived from the stored script, never taken from the request.
          // A client that could name its own required origins could publish a source whose
          // destinations the deployment cannot serve, and the published metadata would then be a
          // claim rather than an observation.
          const activeSnapshot = await readManagedSnapshotScript(env.DB, id, row.activeSha256)
          const requiredOrigins = activeSnapshot
            ? analyseLxScript(activeSnapshot.script).httpsOrigins
            : row.requiredOrigins
          const { status, pendingOrigins } = publicationStatus(requiredOrigins, allowedOrigins(), enabled)

          const stamp = now()
          const statement = env.DB.prepare(
            `UPDATE lx_global_sources
             SET name = ?, enabled = ?, priority = ?, status = ?, required_origins = ?, pending_origins = ?, updated_at = ?
             WHERE id = ?`,
          )
            .bind(name, enabled ? 1 : 0, priority, status, JSON.stringify(requiredOrigins), JSON.stringify(pendingOrigins), stamp, id)
          await env.DB.batch([
            ...materializeManagedLxSource(env.DB, id, stamp), statement,
            bumpRevisionStatement(env.DB, stamp),
            auditStatement(ownerId, 'lx_source.update', id, { name, enabled, priority, status }),
          ])
          const revision = await readRegistryRevision(env.DB)
          const updated = await readManagedLxSource(env.DB, id)
          return json({ revision, source: updated ? await describe(updated) : null })
        }

        if (request.method === 'DELETE') {
          const guard = await ownerGuard(request)
          if (guard instanceof Response) return guard
          const ownerId = guard.id
          const row = await readManagedLxSource(env.DB, id)
          if (!row) return json({ error: 'not_found' }, 404)
          await env.DB.batch([
            ...(id === MANAGED_LX_SOURCE_ID ? [env.DB.prepare(
              `INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
               VALUES (?, ?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET
               setting_json = excluded.setting_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            ).bind(MANAGED_LX_DELETION_SETTING, JSON.stringify({ deleted: true }), ownerId, now())] : []),
            env.DB.prepare('DELETE FROM lx_global_sources WHERE id = ?').bind(id),
            bumpRevisionStatement(env.DB, now()),
            auditStatement(ownerId, 'lx_source.delete', id, { name: row.name, sha256: row.activeSha256 }),
          ])
          const revision = await readRegistryRevision(env.DB)
          return json({ revision })
        }
      }

      const checkMatch = path.match(/^\/api\/admin\/lx\/sources\/([A-Za-z0-9._-]+)\/check-update$/u)
      if (checkMatch && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id
        const id = checkMatch[1]!
        const row = await readManagedLxSource(env.DB, id)
        if (!row) return json({ error: 'not_found' }, 404)
        if (row.originKind !== 'url') {
          return json({ error: 'not_applicable', message: 'An uploaded source has no origin to check' }, 409)
        }

        const fetched = await fetchRemoteScript(row.originUrl, fetchImpl)
        const stamp = now()
        if (!fetched.ok) {
          // The known-good snapshot stays active: a failed check must not disturb playback.
          await recordCheck(ownerId, id, stamp, `check failed: ${fetched.rejection.message}`.slice(0, 500),
            'lx_source.check_update', { outcome: 'fetch_failed', code: fetched.rejection.code })
          return json({ error: fetched.rejection.code, message: fetched.rejection.message, activeSha256: row.activeSha256 }, 422)
        }

        const rejection = screenLxScript(fetched.script, { allowPlaintextOrigins: true, allowEmbeddedCredentials: true })
        if (rejection) {
          await recordCheck(ownerId, id, stamp, `update refused: ${rejection.message}`.slice(0, 500),
            'lx_source.check_update', { outcome: 'refused', code: rejection.code })
          return json({ error: rejection.code, message: rejection.message, activeSha256: row.activeSha256 }, 422)
        }

        const candidateSha = await sha256Hex(fetched.script)
        const analysis = analyseLxScript(fetched.script)
        const hasUpdate = candidateSha !== row.activeSha256
        await recordCheck(ownerId, id, stamp, hasUpdate ? 'update available' : 'up to date',
          'lx_source.check_update', { candidateSha256: candidateSha, hasUpdate })

        return json({
          activeSha256: row.activeSha256,
          candidateSha256: candidateSha,
          hasUpdate,
          candidateVersion: analysis.version,
          requiredOrigins: analysis.httpsOrigins,
          credentialKeys: analysis.credentialKeys,
          // The candidate is offered for adoption; it is not stored until it is explicitly adopted.
          candidateScript: hasUpdate ? fetched.script : undefined,
        })
      }

      const adoptMatch = path.match(/^\/api\/admin\/lx\/sources\/([A-Za-z0-9._-]+)\/adopt$/u)
      if (adoptMatch && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id
        const id = adoptMatch[1]!
        const row = await readManagedLxSource(env.DB, id)
        if (!row) return json({ error: 'not_found' }, 404)
        const body = await readJson(request)
        const sha256 = typeof body?.sha256 === 'string' ? body.sha256 : ''
        if (!/^[0-9a-f]{64}$/u.test(sha256)) return json({ error: 'invalid_body', message: 'sha256 is required' }, 400)

        // Adopting a snapshot that is already stored is a rollback; adopting one that was fetched
        // but never stored stores it first, so the snapshot table stays the single source of truth.
        let snapshot = await readManagedSnapshotScript(env.DB, id, sha256)
        const statements = materializeManagedLxSource(env.DB, id, now())
        if (!snapshot) {
          const script = typeof body?.script === 'string' ? body.script : null
          if (!script) {
            return json({ error: 'unknown_snapshot', message: 'No stored snapshot with that digest' }, 404)
          }
          const rejection = screenLxScript(script, { allowPlaintextOrigins: true, allowEmbeddedCredentials: true })
          if (rejection) return json({ error: rejection.code, message: rejection.message }, 422)
          const computed = await sha256Hex(script)
          if (computed !== sha256) {
            return json({ error: 'digest_mismatch', message: 'The script does not match the digest you asked for' }, 422)
          }
          const adoptStamp = now()
          const candidateVersion = analyseLxScript(script).version
          statements.push(snapshotStatement(env.DB, {
              sourceId: id,
              sha256,
              script,
              version: candidateVersion,
              now: adoptStamp,
              note: 'adopted after review',
            }))
          snapshot = { script, version: candidateVersion }
        }

        const analysis = analyseLxScript(snapshot.script)
        const credentialDisclosure = disclosure(snapshot.script, sha256, body?.credentialDisclosureSha256)
        const rejection = screenLxScript(snapshot.script, { allowPlaintextOrigins: true, allowEmbeddedCredentials: Boolean(credentialDisclosure) })
        if (rejection) return json({ error: rejection.code, message: rejection.message }, 422)
        const { status, pendingOrigins } = publicationStatus(analysis.httpsOrigins, allowedOrigins(), row.enabled)
        const stamp = now()
        statements.push(env.DB.prepare(
          `UPDATE lx_global_sources
           SET active_sha256 = ?, version = ?, status = ?, required_origins = ?, pending_origins = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(sha256, snapshot.version, status, JSON.stringify(analysis.httpsOrigins), JSON.stringify(pendingOrigins), stamp, id))
        // The snapshot, active pointer and invalidation revision commit together. A rollback
        // is the same publication transaction, with no new snapshot to insert.
        statements.push(bumpRevisionStatement(env.DB, stamp), auditStatement(ownerId, 'lx_source.adopt', id, { sha256, status, pendingOrigins, credentialDisclosure }))
        await env.DB.batch(statements)
        const revision = await readRegistryRevision(env.DB)
        const updated = await readManagedLxSource(env.DB, id)
        return json({ revision, source: updated ? await describe(updated) : null })
      }

      const verifyMatch = path.match(/^\/api\/admin\/lx\/sources\/([A-Za-z0-9._-]+)\/verify$/u)
      if (verifyMatch && request.method === 'POST') {
        const guard = await ownerGuard(request)
        if (guard instanceof Response) return guard
        const ownerId = guard.id
        const id = verifyMatch[1]!
        const row = await readManagedLxSource(env.DB, id)
        if (!row) return json({ error: 'not_found' }, 404)
        const body = await readJson(request)
        const ok = body?.ok === true
        const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : ok ? 'verified' : 'failed'
        const stamp = now()
        await recordCheck(ownerId, id, stamp, note, 'lx_source.verify', { ok, note })
        const updated = await readManagedLxSource(env.DB, id)
        return json({ source: updated ? await describe(updated) : null })
      }

      return json({ error: 'not_found' }, 404)
    },
  }
}

const LX_ORIGIN_URL_MAX = 2048

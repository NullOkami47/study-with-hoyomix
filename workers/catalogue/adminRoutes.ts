import type { AuthEnv } from '../auth/routes'
import type { D1PreparedStatement } from '../env'
import { createAdminAuthorisation, adminMutationOriginGuard } from '../admin/authz'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import { createGoogleSheetsClient, sheetsConfigured, type GoogleSheetsEnv } from './googleSheets'
import { readImportBatch, saveImportBatch } from './diff'
import { readCatalogueSnapshot } from './repository'
import { exportWorkbook } from './staging'
import { publishImportBatch } from './publish'
import { validateProposalEdit } from './edit'
import {
  applyAdminTrackEdit,
  readAdminCatalogueIndex,
  readAdminCatalogueRevision,
  readAdminTrackDetail,
  validateAdminTrackEdit,
} from './adminTracks'
import type { ImportBatch, Decision } from './types'
export interface CatalogueEnv extends AuthEnv, GoogleSheetsEnv {}
export interface CatalogueOptions {
  now?: () => number
  crypto?: Crypto
  sheets?: Pick<ReturnType<typeof createGoogleSheetsClient>, 'read' | 'write'>
  /** @internal Test-only transaction boundary for real D1 failure/interleaving tests. */
  beforePublishBatch?: (
    statements: D1PreparedStatement[],
  ) => D1PreparedStatement[] | Promise<D1PreparedStatement[]>
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const method = (allowed: string) =>
  Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { allow: allowed, 'cache-control': 'no-store' } },
  )
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isOwnerR2Proposal = (proposal: ImportBatch['changes'][number]) => {
  const after = proposal.after
  return proposal.entityType === 'source' &&
    proposal.decision === 'pending' &&
    proposal.validationState === 'error' &&
    proposal.messages.length === 1 &&
    proposal.messages[0] === 'r2_owner_verification_required' &&
    record(after) &&
    after.provider === 'r2' &&
    typeof after.evidence === 'string' &&
    after.evidence.trim().length > 0 &&
    after.evidence.length <= 4000 &&
    typeof after.source_confidence === 'number' &&
    Number.isFinite(after.source_confidence) &&
    after.source_confidence >= 0 &&
    after.source_confidence <= 1
}
async function body(request: Request, keys: string[], maxBytes = 4096): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await readBoundedJsonRequest(request, maxBytes)
    return record(parsed) && Object.keys(parsed).every((k) => keys.includes(k)) ? parsed : null
  } catch {
    return null
  }
}
export function createCatalogueAdminHandler(env: CatalogueEnv, options: CatalogueOptions = {}) {
  const now = options.now ?? Date.now,
    auth = createAdminAuthorisation(env, options),
    sheets = options.sheets ?? createGoogleSheetsClient(env)
  async function decision(
    batch: ImportBatch,
    changes: { id: string; decision: Decision }[],
    actor: string,
    reviewRevision: number,
  ): Promise<ImportBatch> {
    if (!['draft', 'validated'].includes(batch.status)) throw new Error('terminal_batch')
    const statements = [
      env.DB.prepare(
        "UPDATE catalogue_import_batches SET review_revision=CASE WHEN status IN ('draft','validated') AND review_revision=? AND EXISTS(SELECT 1 FROM catalogue_state WHERE id=1 AND revision=?) THEN review_revision+1 ELSE 0 END,updated_at=? WHERE batch_id=?",
      ).bind(reviewRevision, batch.baseRevision, now(), batch.batchId),
      ...changes.map((c) =>
        env.DB.prepare(
          'UPDATE catalogue_import_changes SET decision=? WHERE batch_id=? AND change_id=?',
        ).bind(c.decision, batch.batchId, c.id),
      ),
      env.DB.prepare(
        "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.review',?,?,?)",
      ).bind(
        crypto.randomUUID(),
        actor,
        batch.batchId,
        JSON.stringify({ decisions: changes }),
        now(),
      ),
    ]
    await env.DB.batch(statements)
    return (await readImportBatch(env.DB, batch.batchId))!
  }
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const denied = adminMutationOriginGuard(request, new URL(env.PUBLIC_ORIGIN).origin)
        if (denied) return denied
        const admin = await auth.currentAdmin(request)
        if (admin instanceof Response) return admin
        const path = new URL(request.url).pathname.slice('/api/admin/catalogue'.length)
        if (path === '/status') {
          if (request.method !== 'GET') return method('GET')
          const last = await env.DB.prepare(
            'SELECT batch_id FROM catalogue_import_batches ORDER BY created_at DESC,rowid DESC LIMIT 1',
          ).first<{ batch_id: string }>()
          const lastBatch = last ? await readImportBatch(env.DB, last.batch_id) : null
          const configured = sheetsConfigured(env)
          return json({
            configured,
            role: admin.role,
            sheetUrl: configured
              ? 'https://docs.google.com/spreadsheets/d/' + env.CATALOGUE_SHEET_ID + '/edit'
              : null,
            serviceAccountEmail: configured ? env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL : null,
            lastBatch,
          })
        }
        if (path === '/sync' || path === '/export-sheet') {
          if (request.method !== 'POST') return method('POST')
          const value = await body(request, path === '/sync' ? ['resync'] : [])
          if (!value || ('resync' in value && typeof value.resync !== 'boolean'))
            return json({ error: 'invalid_request' }, 400)
          if (!sheetsConfigured(env)) return json({ error: 'sheets_unavailable' }, 503)
          try {
            if (path === '/sync') {
              const batch = await saveImportBatch(env.DB, await sheets.read(), admin.id, now(), {
                resync: value.resync === true,
              })
              return json(batch)
            }
            await sheets.write(exportWorkbook(await readCatalogueSnapshot(env.DB)))
            await env.DB.prepare(
              "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.export',?,?,?)",
            )
              .bind(crypto.randomUUID(), admin.id, 'staging-sheet', '{}', now())
              .run()
            return json({ exported: true })
          } catch {
            return json({ error: 'staging_or_sheets_unavailable' }, 503)
          }
        }
        // Direct catalogue browsing/editing. Deliberately separate from the workbook proposal
        // pipeline below: that pipeline reviews deltas, so it can never show or correct the
        // published catalogue itself.
        if (path === '/tracks') {
          if (request.method !== 'GET') return method('GET')
          return json(await readAdminCatalogueIndex(env.DB))
        }
        const trackMatch = /^\/tracks\/([a-z0-9][a-z0-9_-]{0,119})$/.exec(path)
        if (trackMatch) {
          const trackId = trackMatch[1]
          if (request.method === 'GET') {
            const detail = await readAdminTrackDetail(env.DB, trackId)
            return detail ? json(detail) : json({ error: 'not_found' }, 404)
          }
          if (request.method !== 'PATCH') return method('GET, PATCH')
          const value = await body(request, ['changes', 'expectedRevision'], 32 * 1024)
          if (
            !value ||
            Object.keys(value).length !== 2 ||
            !record(value.changes) ||
            !Number.isSafeInteger(value.expectedRevision) ||
            Number(value.expectedRevision) < 1
          )
            return json({ error: 'invalid_request' }, 400)
          const edit = validateAdminTrackEdit(value.changes)
          if (!edit.ok) return json({ error: 'invalid_edit', errors: edit.errors }, 400)
          if (!(await readAdminTrackDetail(env.DB, trackId)))
            return json({ error: 'not_found' }, 404)
          const expectedRevision = Number(value.expectedRevision)
          if ((await readAdminCatalogueRevision(env.DB)) !== expectedRevision)
            return json({ error: 'stale_catalogue' }, 409)
          const applied = await applyAdminTrackEdit(
            env.DB,
            trackId,
            edit.changes,
            expectedRevision,
            admin.id,
            now(),
          )
          if (applied.status !== 'ok') return json({ error: 'stale_catalogue' }, 409)
          const track = await readAdminTrackDetail(env.DB, trackId)
          return json({ revision: await readAdminCatalogueRevision(env.DB), track })
        }
        const match =
          /^\/batches\/([a-zA-Z0-9-]{1,80})(?:\/(publish|approve-high-confidence)|\/changes\/([a-zA-Z0-9-]{1,80})(?:\/(approve-r2-owner))?)?$/.exec(
            path,
          )
        if (!match) return json({ error: 'not_found' }, 404)
        const batch = await readImportBatch(env.DB, match[1])
        if (!batch) return json({ error: 'not_found' }, 404)
        if (!match[2] && !match[3]) return request.method === 'GET' ? json(batch) : method('GET')
        if (match[3]) {
          const proposal = batch.changes.find((c) => c.changeId === match[3])
          if (!proposal) return json({ error: 'not_found' }, 404)
          if (match[4]) {
            if (request.method !== 'POST') return method('POST')
            const value = await body(request, ['reviewRevision'])
            if (
              !value ||
              Object.keys(value).length !== 1 ||
              !Number.isSafeInteger(value.reviewRevision) ||
              Number(value.reviewRevision) < 1
            ) return json({ error: 'invalid_request' }, 400)
            if (admin.role !== 'owner') return json({ error: 'forbidden' }, 403)
            if (
              !['draft', 'validated'].includes(batch.status) ||
              value.reviewRevision !== batch.reviewRevision
            ) return json({ error: 'stale_or_terminal_batch' }, 409)
            if (!isOwnerR2Proposal(proposal)) return json({ error: 'invalid_proposal' }, 409)
            const after = proposal.after!
            try {
              await env.DB.batch([
                env.DB.prepare(
                  "UPDATE catalogue_import_batches SET review_revision=CASE WHEN status IN ('draft','validated') AND review_revision=? AND EXISTS(SELECT 1 FROM catalogue_state WHERE id=1 AND revision=?) THEN review_revision+1 ELSE 0 END,updated_at=? WHERE batch_id=?",
                ).bind(Number(value.reviewRevision), batch.baseRevision, now(), batch.batchId),
                env.DB.prepare(
                  "UPDATE catalogue_import_changes SET validation_state='valid',decision='approved' WHERE batch_id=? AND change_id=? AND validation_state='error' AND decision='pending'",
                ).bind(batch.batchId, proposal.changeId),
                env.DB.prepare(
                  "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.review.r2-owner-approve',?,?,?)",
                ).bind(crypto.randomUUID(), admin.id, batch.batchId, JSON.stringify({
                  batchId: batch.batchId,
                  changeId: proposal.changeId,
                  sourceRowId: proposal.entityKey,
                  evidence: after.evidence,
                }), now()),
              ])
              return json(await readImportBatch(env.DB, batch.batchId))
            } catch {
              return json({ error: 'stale_or_terminal_batch' }, 409)
            }
          }
          if (request.method !== 'PATCH') return method('PATCH')
          const value = await body(request, ['decision', 'after', 'reviewRevision'], 64 * 1024)
          if (!value) return json({ error: 'invalid_request' }, 400)
          if ('after' in value) {
            if ('decision' in value || !record(value.after)
              || !Number.isSafeInteger(value.reviewRevision) || Number(value.reviewRevision) < 1)
              return json({ error: 'invalid_request' }, 400)
            if (!['draft', 'validated'].includes(batch.status) || value.reviewRevision !== batch.reviewRevision)
              return json({ error: 'stale_or_terminal_batch' }, 409)
            const original = await readCatalogueSnapshot(env.DB)
            if (original.revision !== batch.baseRevision)
              return json({ error: 'stale_or_terminal_batch' }, 409)
            let edited
            try {
              edited = validateProposalEdit(batch, proposal, value.after, original, now())
            } catch {
              return json({ error: 'invalid_proposal_edit' }, 400)
            }
            try {
              // Failed CAS violates CHECK(review_revision>=1), rolling back edit AND audit.
              await env.DB.batch([
                env.DB.prepare(
                  "UPDATE catalogue_import_batches SET review_revision=CASE WHEN status IN ('draft','validated') AND review_revision=? AND EXISTS(SELECT 1 FROM catalogue_state WHERE id=1 AND revision=?) THEN review_revision+1 ELSE 0 END,updated_at=? WHERE batch_id=?",
                ).bind(batch.reviewRevision, batch.baseRevision, now(), batch.batchId),
                env.DB.prepare(
                  "UPDATE catalogue_import_changes SET after_json=?,entity_key=?,validation_state=?,validation_messages_json=?,confidence=?,decision='pending' WHERE batch_id=? AND change_id=?",
                ).bind(JSON.stringify(edited.after), edited.entityKey, edited.validationState,
                  JSON.stringify(edited.messages), edited.confidence, batch.batchId, proposal.changeId),
                env.DB.prepare(
                  "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.edit',?,?,?)",
                ).bind(crypto.randomUUID(), admin.id, batch.batchId, JSON.stringify({
                  batchId: batch.batchId, changeId: proposal.changeId,
                  before: proposal.after, after: edited.after,
                }), now()),
              ])
              return json(await readImportBatch(env.DB, batch.batchId))
            } catch {
              return json({ error: 'stale_or_terminal_batch' }, 409)
            }
          }
          if (
            Object.keys(value).length !== 2 ||
            !['approved', 'rejected'].includes(String(value.decision)) ||
            !Number.isSafeInteger(value.reviewRevision) ||
            Number(value.reviewRevision) < 1
          ) return json({ error: 'invalid_request' }, 400)
          if (!['draft', 'validated'].includes(batch.status) || value.reviewRevision !== batch.reviewRevision)
            return json({ error: 'stale_or_terminal_batch' }, 409)
          if (value.decision === 'approved' && proposal.validationState !== 'valid')
            return json({ error: 'invalid_proposal' }, 409)
          try {
            return json(
              await decision(
                batch,
                [{ id: proposal.changeId, decision: value.decision as Decision }],
                admin.id,
                Number(value.reviewRevision),
              ),
            )
          } catch {
            return json({ error: 'stale_or_terminal_batch' }, 409)
          }
        }
        if (request.method !== 'POST') return method('POST')
        const value = await body(
          request,
          match[2] === 'publish' ? ['reviewRevision'] : ['threshold', 'reviewRevision'],
        )
        if (
          !value ||
          !Number.isSafeInteger(value.reviewRevision) ||
          Number(value.reviewRevision) < 1
        ) return json({ error: 'invalid_request' }, 400)
        if (!['draft', 'validated'].includes(batch.status) || value.reviewRevision !== batch.reviewRevision)
          return json({ error: 'stale_or_terminal_batch' }, 409)
        if (match[2] === 'approve-high-confidence') {
          const threshold = value.threshold ?? 0.9
          if (
            typeof threshold !== 'number' ||
            !Number.isFinite(threshold) ||
            threshold < 0.9 ||
            threshold > 1
          )
            return json({ error: 'invalid_threshold' }, 400)
          const changes = batch.changes
            .filter(
              (c) =>
                c.validationState === 'valid' &&
                c.decision === 'pending' &&
                c.confidence !== null &&
                c.confidence >= threshold,
            )
            .map((c) => ({ id: c.changeId, decision: 'approved' as const }))
          try {
            return json(await decision(batch, changes, admin.id, Number(value.reviewRevision)))
          } catch {
            return json({ error: 'stale_or_terminal_batch' }, 409)
          }
        }
        try {
          return json(
            await publishImportBatch(env.DB, batch, admin.id, now(), options.beforePublishBatch),
          )
        } catch {
          return json({ error: 'publish_rejected' }, 409)
        }
      } catch {
        return json({ error: 'catalogue_admin_unavailable' }, 503)
      }
    },
  }
}

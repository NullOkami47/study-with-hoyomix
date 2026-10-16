import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { createAuthHandler } from '../auth/routes'
import { createCatalogueAdminHandler, type CatalogueEnv } from '../catalogue/adminRoutes'
import { readCatalogueSnapshot, readPublishedCatalogue } from '../catalogue/repository'
import { exportWorkbook } from '../catalogue/staging'
import { readImportBatch } from '../catalogue/diff'
import type { ImportBatch } from '../catalogue/types'
import type { D1PreparedStatement } from '../env'
const origin = 'https://study.example',
  now = 1788739200000
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>,
  env: CatalogueEnv,
  cookie: string,
  book: ReturnType<typeof exportWorkbook>
const sheets = { read: vi.fn(), write: vi.fn(async () => {}) }
beforeEach(async () => {
  fixture = await catalogueDatabase()
  env = {
    DB: fixture.db,
    PUBLIC_ORIGIN: origin,
    SESSION_HMAC_SECRET: 'catalogue-test-session-secret-long-enough',
    OAUTH_STATE_SECRET: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    CATALOGUE_SHEET_ID: 'test-workbook',
    GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'test@project.iam.gserviceaccount.com',
    GOOGLE_SHEETS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY----- secret-never-public',
  }
  await fixture.db
    .prepare(
      "INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('admin','Admin','admin',1,1)",
    )
    .run()
  cookie =
    '__Host-session=' +
    (await createAuthHandler(env, { now: () => now }).issueSession('admin')).token
  book = exportWorkbook(await readCatalogueSnapshot(fixture.db))
  sheets.read.mockReset().mockImplementation(async () => book)
  sheets.write.mockClear()
})
afterEach(async () => {
  await fixture?.dispose()
})
function request(path: string, method = 'GET', body?: unknown, withCookie: boolean | string = true) {
  const requestCookie = typeof withCookie === 'string' ? withCookie : withCookie ? cookie : undefined
  return new Request(origin + '/api/admin/catalogue' + path, {
    method,
    headers: { origin, 'content-type': 'application/json', ...(requestCookie ? { cookie: requestCookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
const handler = () => createCatalogueAdminHandler(env, { now: () => now, sheets })
async function ownerCookie() {
  await fixture.db.prepare(
    "INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('owner','Owner','owner',1,1)",
  ).run()
  return '__Host-session=' + (await createAuthHandler(env, { now: () => now }).issueSession('owner')).token
}
async function sync(): Promise<ImportBatch> {
  const r = await handler().fetch(request('/sync', 'POST', {}))
  expect(r.status).toBe(200)
  return r.json()
}
async function decide(b: ImportBatch, id: string, decision = 'approved') {
  const r = await handler().fetch(
    request('/batches/' + b.batchId + '/changes/' + id, 'PATCH', {
      decision,
      reviewRevision: b.reviewRevision,
    }),
  )
  expect(r.status).toBe(200)
  return r.json() as Promise<ImportBatch>
}
async function approve(b: ImportBatch) {
  for (const c of b.changes.filter((c) => c.validationState === 'valid'))
    b = await decide(b, c.changeId)
  return b
}
const publish = (b: ImportBatch) =>
  handler().fetch(
    request('/batches/' + b.batchId + '/publish', 'POST', {
      reviewRevision: b.reviewRevision,
    }),
  )
const editProposal = (b: ImportBatch, index: number, patch: Record<string, unknown>) =>
  handler().fetch(
    request('/batches/' + b.batchId + '/changes/' + b.changes[index].changeId, 'PATCH', {
      after: { ...b.changes[index].after, ...patch },
      reviewRevision: b.reviewRevision,
    }),
  )
describe('Admin catalogue review and atomic publication', () => {
  it('authenticates before any Sheet calls and never leaks credentials', async () => {
    expect((await handler().fetch(request('/status', 'GET', undefined, false))).status).toBe(401)
    expect(sheets.read).not.toHaveBeenCalled()
    const r = await handler().fetch(request('/status'))
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('test-workbook')
    expect(text).not.toMatch(/secret-never-public|PRIVATE KEY|access_token/)
  })
  it('preserves origin and method boundaries', async () => {
    const r = await handler().fetch(
      new Request(origin + '/api/admin/catalogue/sync', { method: 'POST', headers: { cookie } }),
    )
    expect(r.status).toBe(403)
    expect((await handler().fetch(request('/status', 'POST', {}))).status).toBe(405)
    expect(sheets.read).not.toHaveBeenCalled()
  })
  it('rolls back a newly created sync batch and proposals when its audit insert fails', async () => {
    book.Tracks[1][1] = 'Must roll back'
    await fixture.db.prepare(
      "CREATE TRIGGER fail_sync_audit BEFORE INSERT ON admin_audit_log WHEN NEW.action='catalogue.sync' BEGIN SELECT RAISE(ABORT, 'sync audit failed'); END",
    ).run()
    const response = await handler().fetch(request('/sync', 'POST', {}))
    expect(response.status).toBe(503)
    expect(await fixture.db.prepare('SELECT COUNT(*) AS n FROM catalogue_import_batches').first<number>('n')).toBe(0)
    expect(await fixture.db.prepare('SELECT COUNT(*) AS n FROM catalogue_import_changes').first<number>('n')).toBe(0)
  })
  it('audits every pull when reusing an existing batch without creating new state', async () => {
    book.Tracks[1][1] = 'Reusable snapshot'
    const first = await sync()
    const second = await sync()
    expect(second.batchId).toBe(first.batchId)
    expect(await fixture.db.prepare('SELECT COUNT(*) AS n FROM catalogue_import_batches').first<number>('n')).toBe(1)
    expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='catalogue.sync'").first<number>('n')).toBe(2)
  })
  it('sync is staging-only; explicit approval and publish changes public data', async () => {
    const before = await readPublishedCatalogue(fixture.db)
    book.Tracks[1][1] = 'Reviewed title'
    let batch = await sync()
    expect(await readPublishedCatalogue(fixture.db)).toEqual(before)
    expect((await publish(batch)).status).toBe(409)
    batch = await approve(batch)
    expect((await publish(batch)).status).toBe(200)
    expect((await readPublishedCatalogue(fixture.db)).tracks[0].title).toBe('Reviewed title')
    expect((await publish(batch)).status).toBe(409)
    expect(
      (await fixture.db
        .prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'")
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })
  it('requires the client-observed revision for decide, bulk approval and publish', async () => {
    book.Tracks[1][1] = 'Observed revision'
    const b = await sync()
    const changePath = '/batches/' + b.batchId + '/changes/' + b.changes[0].changeId
    expect((await handler().fetch(request(changePath, 'PATCH', { decision: 'approved' }))).status).toBe(400)
    expect((await handler().fetch(request(changePath, 'PATCH', {
      decision: 'approved', reviewRevision: b.reviewRevision + 1,
    }))).status).toBe(409)
    expect((await handler().fetch(request('/batches/' + b.batchId + '/approve-high-confidence', 'POST', {}))).status).toBe(400)
    expect((await handler().fetch(request('/batches/' + b.batchId + '/approve-high-confidence', 'POST', {
      reviewRevision: b.reviewRevision + 1,
    }))).status).toBe(409)
    expect((await handler().fetch(request('/batches/' + b.batchId + '/publish', 'POST', {}))).status).toBe(400)
    expect((await handler().fetch(request('/batches/' + b.batchId + '/publish', 'POST', {
      reviewRevision: b.reviewRevision + 1,
    }))).status).toBe(409)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(b)
  })
  it('atomically rejects stale decision, bulk and Owner R2 approval batches', async () => {
    book.Tracks[1][1] = 'Published batch A'
    const publishedBatch = await approve(await sync())

    book.Tracks[2][1] = 'Stale decision batch'
    const staleDecision = await sync()
    const decisionChange = staleDecision.changes.find(
      (change) => change.entityKey === book.Tracks[2][0] && change.kind === 'metadata_change',
    )!

    book.Tracks[3][1] = 'Stale bulk batch'
    book.Tracks[3][11] = '0.95'
    const staleBulk = await sync()

    book.Tracks.push([
      'stale-owner-track', 'Stale Owner Track', 'zzz', '', '', 'work-stale-owner', '',
      'uncertain', 'FALSE', 'FALSE', 'FALSE', '0.95', 'pending', 'track evidence', '',
    ])
    book.Sources.push([
      'stale-owner-r2', 'stale-owner-track', 'r2',
      'tracks/authorized/' + 'b'.repeat(64) + '.mp3', 'audio', 'active', '0.98',
      'owner-authorised', 'Owner-controlled object verification', '',
    ])
    const staleOwner = await sync()
    const ownerChange = staleOwner.changes.find((change) => change.entityKey === 'stale-owner-r2')!
    const owner = await ownerCookie()

    expect((await publish(publishedBatch)).status).toBe(200)
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(2)
    const auditCount = await fixture.db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').first<number>('n')

    const responses = await Promise.all([
      handler().fetch(request(
        '/batches/' + staleDecision.batchId + '/changes/' + decisionChange.changeId,
        'PATCH', { decision: 'approved', reviewRevision: staleDecision.reviewRevision },
      )),
      handler().fetch(request(
        '/batches/' + staleBulk.batchId + '/approve-high-confidence',
        'POST', { reviewRevision: staleBulk.reviewRevision },
      )),
      handler().fetch(request(
        '/batches/' + staleOwner.batchId + '/changes/' + ownerChange.changeId + '/approve-r2-owner',
        'POST', { reviewRevision: staleOwner.reviewRevision }, owner,
      )),
    ])

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409])
    expect(await readImportBatch(fixture.db, staleDecision.batchId)).toEqual(staleDecision)
    expect(await readImportBatch(fixture.db, staleBulk.batchId)).toEqual(staleBulk)
    expect(await readImportBatch(fixture.db, staleOwner.batchId)).toEqual(staleOwner)
    expect(await fixture.db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').first<number>('n')).toBe(auditCount)
  })
  it('accepts decisions only, not edited proposal JSON', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    expect(
      (
        await handler().fetch(
          request('/batches/' + b.batchId + '/changes/' + b.changes[0].changeId, 'PATCH', {
            decision: 'approved',
            after: { title: 'injected' },
            reviewRevision: b.reviewRevision,
          }),
        )
      ).status,
    ).toBe(400)
  })
  it('persists a manually edited proposal, resets approval and audits without publishing', async () => {
    const original = await readPublishedCatalogue(fixture.db)
    book.Tracks[1][1] = 'Staged'
    const b = await approve(await sync())
    const r = await editProposal(b, 0, { title: 'Manually reviewed', metadata_confidence: 0.92 })
    expect(r.status).toBe(200)
    const edited: ImportBatch = await r.json()
    expect(edited.reviewRevision).toBe(b.reviewRevision + 1)
    expect(edited.changes[0]).toMatchObject({
      after: { title: 'Manually reviewed', metadata_confidence: 0.92 },
      before: b.changes[0].before,
      decision: 'pending',
      confidence: 0.92,
      validationState: 'valid',
      messages: [],
    })
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(edited)
    expect(await readPublishedCatalogue(fixture.db)).toEqual(original)
    expect((await publish(edited)).status).toBe(409)
    const audit = await fixture.db
      .prepare("SELECT * FROM admin_audit_log WHERE action='catalogue.edit'")
      .first<{ actor_user_id: string; target_key: string; detail_json: string }>()
    expect(audit).toMatchObject({ actor_user_id: 'admin', target_key: b.batchId })
    expect(JSON.parse(audit!.detail_json)).toMatchObject({
      batchId: b.batchId,
      changeId: b.changes[0].changeId,
      before: b.changes[0].after,
      after: edited.changes[0].after,
    })
    expect(audit!.detail_json).not.toMatch(/secret-never-public|PRIVATE KEY|access_token/)
    expect((await publish(await approve(edited))).status).toBe(200)
    expect((await readPublishedCatalogue(fixture.db)).tracks[0].title).toBe('Manually reviewed')
  })
  it.each([
    { title: '' },
    { title: ['not a string'] },
    { metadata_confidence: '0.95' },
    { games: ['unknown'] },
    { release_date: '2026-02-31' },
    { title: 'x'.repeat(501) },
    { unexpected: 'injected' },
  ])('rejects invalid or out-of-projection metadata edits: %j', async (patch) => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    expect((await editProposal(b, 0, patch)).status).toBe(400)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(b)
    expect((await publish(b)).status).toBe(409)
  })
  it('reuses classification validation instead of coercing malformed flags or guessing vocals', async () => {
    book.Tracks[1][7] = 'instrumental'
    book.Tracks[1][8] = 'TRUE'
    const b = await sync()
    // Malformed flags are still rejected rather than coerced into 0/1, and an unknown vocal
    // status is still rejected rather than guessed.
    for (const patch of [{ vocal_status: 'invalid' }, { focus: 'false' }, { focus: 2 }]) {
      expect((await editProposal(b, 0, patch)).status).toBe(400)
    }
    // `focus` and `vocal_status` are independent dimensions, so changing the vocal status of a
    // focus track is a valid edit (389 published rows are focus + vocal).
    const vocalResponse = await editProposal(b, 0, { vocal_status: 'vocal' })
    expect(vocalResponse.status).toBe(200)
    const vocal = (await vocalResponse.json()) as ImportBatch
    expect(vocal.changes[0].after).toMatchObject({ focus: 1, vocal_status: 'vocal' })
    expect(vocal.changes[0].validationState).toBe('valid')
    expect((await editProposal(vocal, 0, { focus: 0, vocal_status: 'uncertain', needs_classification: 1 })).status).toBe(200)
    const edited = (await readImportBatch(fixture.db, b.batchId))!
    expect(edited.changes[0].after).toMatchObject({ focus: 0, vocal_status: 'uncertain' })
    expect(edited.changes[0].decision).toBe('pending')
  })
  it.each(['vocal', 'uncertain'])('reviews Focus independently of %s vocal status', async (vocal) => {
    book.Tracks[1][7] = 'instrumental'
    book.Tracks[1][8] = 'TRUE'
    const b = await sync()
    const response = await editProposal(b, 0, {
      vocal_status: vocal,
      needs_classification: Number(vocal === 'uncertain'),
    })
    expect(response.status).toBe(200)
    const edited = (await readImportBatch(fixture.db, b.batchId))!
    expect(edited.changes[0].after).toMatchObject({ focus: 1, vocal_status: vocal })
    expect(edited.changes[0].decision).toBe('pending')
  })
  it('rejects canonical identity mutation', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    expect((await editProposal(b, 0, { track_id: 'another-track' })).status).toBe(400)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(b)
  })
  it('supports bounded full proposals larger than a decision while rejecting oversized edit bodies', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    const r = await editProposal(b, 0, { evidence: 'e'.repeat(4000), notes: 'n'.repeat(4000) })
    expect(r.status).toBe(200)
    const edited: ImportBatch = await r.json()
    expect(edited.changes[0].after!.notes).toHaveLength(4000)
    expect((await editProposal(edited, 0, { notes: 'x'.repeat(65536) })).status).toBe(400)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(edited)
  })
  it('allows source notes but never edits trusted R2 identity, rights or metadata', async () => {
    book.Sources[1][9] = 'Staged notes'
    const b = await sync()
    for (const patch of [
      { source_row_id: 'other-source' },
      { track_id: book.Tracks[2][0] },
      { provider: 'youtube', external_id: 'abcdefghijk' },
      { external_id: 'tracks/authorized/' + 'a'.repeat(64) + '.mp3' },
      { rights_status: 'licensed' },
      { metadata_json: '{"ownerMappingConfirmedAt":"invented","rightsStatus":"owner-authorised"}' },
    ]) {
      expect((await editProposal(b, 0, patch)).status).toBe(400)
    }
    expect((await editProposal(b, 0, { notes: 'Manual source notes' })).status).toBe(200)
    expect((await readImportBatch(fixture.db, b.batchId))!.changes[0].after).toMatchObject({
      notes: 'Manual source notes',
      metadata_json: b.changes[0].after!.metadata_json,
      external_id: b.changes[0].after!.external_id,
    })
  })
  it('edits metadata while another proposal has only the expected pending R2 blocker', async () => {
    book.Tracks[1][1] = 'Staged metadata'
    book.Tracks.push([
      'pending-r2-track', 'Pending R2 Track', 'zzz', '', '', 'work-pending-r2', '',
      'uncertain', 'FALSE', 'FALSE', 'FALSE', '0.95', 'pending', 'track evidence', '',
    ])
    book.Sources.push([
      'pending-r2-source', 'pending-r2-track', 'r2',
      'tracks/authorized/' + 'c'.repeat(64) + '.mp3', 'audio', 'active', '0.98',
      'owner-authorised', 'Owner-controlled object verification', '',
    ])
    const batch = await sync()
    const metadataIndex = batch.changes.findIndex((change) => change.kind === 'metadata_change')
    const response = await editProposal(batch, metadataIndex, { title: 'Reviewed metadata' })

    expect(response.status).toBe(200)
    const edited: ImportBatch = await response.json()
    expect(edited.changes[metadataIndex]).toMatchObject({
      after: { title: 'Reviewed metadata' }, validationState: 'valid', messages: [],
    })
    expect(edited.changes.find((change) => change.entityKey === 'pending-r2-source')).toMatchObject({
      decision: 'pending',
      validationState: 'error',
      messages: ['r2_owner_verification_required'],
    })
  })
  it('edits allowed R2 notes but rejects any additional source validation error', async () => {
    book.Tracks.push([
      'editable-r2-track', 'Editable R2 Track', 'zzz', '', '', 'work-editable-r2', '',
      'uncertain', 'FALSE', 'FALSE', 'FALSE', '0.95', 'pending', 'track evidence', '',
    ])
    book.Sources.push([
      'editable-r2-source', 'editable-r2-track', 'r2',
      'tracks/authorized/' + 'd'.repeat(64) + '.mp3', 'audio', 'active', '0.98',
      'owner-authorised', 'Owner-controlled object verification', '',
    ])
    let batch = await sync()
    const sourceIndex = batch.changes.findIndex((change) => change.entityKey === 'editable-r2-source')
    const response = await editProposal(batch, sourceIndex, { notes: 'Reviewed source notes' })

    expect(response.status).toBe(200)
    batch = await response.json()
    expect(batch.changes[sourceIndex]).toMatchObject({
      after: { notes: 'Reviewed source notes' },
      decision: 'pending',
      validationState: 'error',
      messages: ['r2_owner_verification_required'],
    })
    const beforeInvalidEdit = batch
    const auditCount = await fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='catalogue.edit'",
    ).first<number>('n')
    expect((await editProposal(batch, sourceIndex, { evidence: null })).status).toBe(400)
    expect(await readImportBatch(fixture.db, batch.batchId)).toEqual(beforeInvalidEdit)
    expect(await fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='catalogue.edit'",
    ).first<number>('n')).toBe(auditCount)
  })
  it('validates edited provider bindings and evidence against other staged and published sources', async () => {
    for (const [index, id] of [[1, 'abcdefghijk'], [2, 'lmnopqrstuv']] as const) {
      book.Sources.push([
        'youtube-' + index, book.Tracks[index][0], 'youtube', id, 'audio', 'active',
        '0.95', 'unverified', 'recording evidence', '',
      ])
    }
    const b = await sync()
    for (const patch of [
      { external_id: 'https://untrusted.example/video' },
      { external_id: 'lmnopqrstuv' },
      { external_id: 'zyxwvutsrqp', evidence: null },
    ]) expect((await editProposal(b, 0, patch)).status).toBe(400)
    expect((await editProposal(b, 0, { external_id: 'zyxwvutsrqp' })).status).toBe(200)
  })
  it('edits a new track and alias using the existing staged data model', async () => {
    book.Tracks.push([
      'new-track', 'New Track', 'zzz', '', '', 'work-new', '', 'instrumental',
      'TRUE', 'FALSE', 'FALSE', '0.95', 'reviewed', 'evidence', '',
    ])
    book.Aliases.push(['new-track', 'en', 'Original alias'])
    let b = await sync()
    const edited = await editProposal(b, 0, { title: 'Corrected new track' })
    expect(edited.status).toBe(200)
    b = await edited.json()
    expect((await editProposal(b, 1, { track_id: book.Tracks[1][0] })).status).toBe(400)
    expect((await editProposal(b, 1, { alias: 'Corrected alias' })).status).toBe(200)
    const saved = (await readImportBatch(fixture.db, b.batchId))!
    expect(saved.changes[1].after).toEqual({ track_id: 'new-track', locale: 'en', alias: 'Corrected alias' })
    expect(saved.changes[1].entityKey).toBe('new-track:en:Corrected alias')
  })
  it.each(['published', 'rejected'] as const)('rejects edits to a %s batch', async (status) => {
    book.Tracks[1][1] = 'Staged'
    const b = await approve(await sync())
    if (status === 'published') expect((await publish(b)).status).toBe(200)
    else await fixture.db.prepare("UPDATE catalogue_import_batches SET status='rejected' WHERE batch_id=?").bind(b.batchId).run()
    const before = await readImportBatch(fixture.db, b.batchId)
    expect((await editProposal(b, 0, { title: 'Too late' })).status).toBe(409)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(before)
  })
  it('rejects missing/stale review revisions and two same-revision edits have exactly one winner', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    expect((await handler().fetch(request('/batches/' + b.batchId + '/changes/' + b.changes[0].changeId, 'PATCH', {
      after: b.changes[0].after,
    }))).status).toBe(400)
    const results = await Promise.all([
      editProposal(b, 0, { title: 'Editor A' }),
      editProposal(b, 0, { title: 'Editor B' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const winner = await results.find((r) => r.status === 200)!.json()
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(winner)
    expect((await editProposal(b, 0, { title: 'Stale overwrite' })).status).toBe(409)
    expect((await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.edit'").first<{ n: number }>())!.n).toBe(1)
  })
  it('rolls back an edit if a competing decision wins after the edit pre-read', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    const db = env.DB
    let competing: ImportBatch | undefined
    let interleaved = false
    env.DB = {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      async batch<T>(statements: D1PreparedStatement[]) {
        // The edit owns three writes; consistent snapshot reads have two or six statements.
        if (!interleaved && statements.length === 3) {
          interleaved = true
          competing = await decide(b, b.changes[0].changeId, 'rejected')
        }
        return db.batch<T>(statements)
      },
    }
    expect((await editProposal(b, 0, { title: 'Losing edit' })).status).toBe(409)
    expect(competing).toBeDefined()
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(competing)
    expect((await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.edit'").first<{ n: number }>())!.n).toBe(0)
  })
  it('invalidates an in-flight publish when a manual edit resets its approval', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await approve(await sync())
    const h = createCatalogueAdminHandler(env, {
      now: () => now, sheets,
      beforePublishBatch: async (statements) => {
        expect((await editProposal(b, 0, { title: 'Needs new approval' })).status).toBe(200)
        return statements
      },
    })
    expect((await h.fetch(request('/batches/' + b.batchId + '/publish', 'POST', {
      reviewRevision: b.reviewRevision,
    }))).status).toBe(409)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
    expect((await readImportBatch(fixture.db, b.batchId))!.changes[0].decision).toBe('pending')
  })
  it('rolls back the edit and revision when audit fails and never returns server secrets', async () => {
    book.Tracks[1][1] = 'Staged'
    const b = await sync()
    await fixture.db.prepare(
      "CREATE TRIGGER fail_edit_audit BEFORE INSERT ON admin_audit_log WHEN NEW.action='catalogue.edit' BEGIN SELECT RAISE(ABORT, 'secret_never_public_private_key'); END",
    ).run()
    const response = await editProposal(b, 0, { title: 'Rollback' })
    expect(response.status).toBe(409)
    expect(await response.text()).not.toMatch(/secret_never_public|private_key|SELECT|D1_ERROR/)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(b)
    expect((await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.edit'").first<{ n: number }>())!.n).toBe(0)
  })
  it('allows only an Owner to explicitly approve an evidenced R2-only blocker and audits publication', async () => {
    const originalSources = (await readCatalogueSnapshot(fixture.db)).sources
    book.Tracks.push([
      'owner-verified-track', 'Owner Verified Track', 'zzz', '', '', 'work-owner-verified', '',
      'uncertain', 'FALSE', 'FALSE', 'FALSE', '0.95', 'pending', 'track evidence', '',
    ])
    book.Sources.push([
      'owner-verified-r2', 'owner-verified-track', 'r2',
      'tracks/authorized/' + 'a'.repeat(64) + '.mp3', 'audio', 'active', '0.98',
      'owner-authorised', 'Owner-controlled object verification', '',
    ])
    let b = await sync()
    const source = b.changes.find((change) => change.entityKey === 'owner-verified-r2')!
    expect(source).toMatchObject({
      entityType: 'source',
      after: { provider: 'r2', evidence: 'Owner-controlled object verification' },
      validationState: 'error',
      messages: ['r2_owner_verification_required'],
      decision: 'pending',
    })
    const path = '/batches/' + b.batchId + '/changes/' + source.changeId + '/approve-r2-owner'
    expect((await handler().fetch(request(path, 'POST', { reviewRevision: b.reviewRevision }))).status).toBe(403)
    const owner = await ownerCookie()
    const approvedResponse = await handler().fetch(
      request(path, 'POST', { reviewRevision: b.reviewRevision }, owner),
    )
    expect(approvedResponse.status).toBe(200)
    b = await approvedResponse.json()
    expect(b.changes.find((change) => change.changeId === source.changeId)).toMatchObject({
      validationState: 'valid',
      messages: ['r2_owner_verification_required'],
      decision: 'approved',
    })
    await fixture.db.batch(Array.from({ length: 20 }, (_, index) => fixture.db.prepare(
      "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.review.r2-owner-approve',?,?,?)",
    ).bind(
      'zzzz-decoy-' + index,
      'owner',
      b.batchId,
      JSON.stringify({ batchId: b.batchId, changeId: 'decoy-' + index }),
      now,
    )))
    b = await decide(b, b.changes.find((change) => change.kind === 'new_track')!.changeId)
    expect((await publish(b)).status).toBe(200)
    const published = await readCatalogueSnapshot(fixture.db)
    expect(published.sources.filter((source) =>
      originalSources.some((original) => original.source_row_id === source.source_row_id),
    )).toEqual(originalSources)
    expect(published.tracks.find((track) => track.track_id === 'owner-verified-track')).toMatchObject({
      vocal_status: 'uncertain', focus: 0, sleep: 0, chill: 0, needs_classification: 1,
    })
    const audit = await fixture.db.prepare(
      "SELECT actor_user_id AS actorUserId, detail_json AS detailJson FROM admin_audit_log WHERE action='catalogue.review.r2-owner-approve'",
    ).first<{ actorUserId: string; detailJson: string }>()
    expect(audit?.actorUserId).toBe('owner')
    expect(JSON.parse(audit!.detailJson)).toMatchObject({
      batchId: b.batchId,
      changeId: source.changeId,
      sourceRowId: 'owner-verified-r2',
      evidence: 'Owner-controlled object verification',
    })
  })
  it('rejects privileged R2 approval without trustworthy evidence or with any additional blocker', async () => {
    book.Tracks.push([
      'blocked-r2-track', 'Blocked R2 Track', 'zzz', '', '', 'work-blocked-r2', '',
      'uncertain', 'FALSE', 'FALSE', 'FALSE', '0.95', 'pending', 'track evidence', '',
    ])
    book.Sources.push([
      'blocked-r2', 'blocked-r2-track', 'r2', 'invalid-r2-path', 'audio', 'active', '',
      'owner-authorised', '', '',
    ])
    const b = await sync()
    const source = b.changes.find((change) => change.entityKey === 'blocked-r2')!
    const response = await handler().fetch(request(
      '/batches/' + b.batchId + '/changes/' + source.changeId + '/approve-r2-owner',
      'POST', { reviewRevision: b.reviewRevision }, await ownerCookie(),
    ))
    expect(response.status).toBe(409)
    expect(await readImportBatch(fixture.db, b.batchId)).toEqual(b)
    expect(await fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='catalogue.review.r2-owner-approve'",
    ).first<number>('n')).toBe(0)
  })
  it('blocks errors/R2 ownership and bulk approval skips them', async () => {
    book.Tracks[1][8] = 'TRUE'
    book.Sources[1][3] = 'tracks/authorized/invented.mp3'
    book.Tracks[2][1] = 'Valid title'
    book.Tracks[2][11] = '0.95'
    let b = await sync()
    const invalid = b.changes.find((c) => c.validationState !== 'valid')!
    expect(
      (
        await handler().fetch(
          request('/batches/' + b.batchId + '/changes/' + invalid.changeId, 'PATCH', {
            decision: 'approved',
            reviewRevision: b.reviewRevision,
          }),
        )
      ).status,
    ).toBe(409)
    const r = await handler().fetch(
      request('/batches/' + b.batchId + '/approve-high-confidence', 'POST', {
        reviewRevision: b.reviewRevision,
      }),
    )
    expect(r.status).toBe(200)
    b = await r.json()
    expect(b.changes.filter((c) => c.decision === 'approved')).toHaveLength(1)
    expect((await publish(b)).status).toBe(409)
    for (const c of b.changes.filter((c) => c.validationState !== 'valid'))
      b = await decide(b, c.changeId, 'rejected')
    expect((await publish(b)).status).toBe(200)
  })
  it('applies only approved classification, not pending metadata', async () => {
    book.Tracks[1][1] = 'Must stay staged'
    book.Tracks[1][7] = 'instrumental'
    book.Tracks[1][8] = 'TRUE'
    const initial = await readPublishedCatalogue(fixture.db)
    let b = await sync()
    b = await decide(b, b.changes.find((c) => c.kind === 'classification_change')!.changeId)
    expect((await publish(b)).status).toBe(200)
    const track = (await readPublishedCatalogue(fixture.db)).tracks[0]
    expect(track.title).toBe(initial.tracks[0].title)
    expect(track.tabs).toContain('focus')
  })
  it('refuses a stale batch after another publication', async () => {
    book.Tracks[1][1] = 'Batch A'
    const a = await approve(await sync())
    book.Tracks[1][1] = 'Batch B'
    const b = await approve(await sync())
    expect((await publish(a)).status).toBe(200)
    expect((await publish(b)).status).toBe(409)
    expect((await readPublishedCatalogue(fixture.db)).tracks[0].title).toBe('Batch A')
  })
  it('two simultaneous publishes commit once, with one audit/revision', async () => {
    book.Tracks[1][1] = 'Once'
    const b = await approve(await sync())
    const responses = await Promise.all([publish(b), publish(b)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('2')
    expect(
      (await fixture.db
        .prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'")
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })
  it('rolls back catalogue, status and audit if a statement fails', async () => {
    book.Tracks[1][1] = 'Rollback'
    const b = await approve(await sync())
    const original = env.DB
    const h = createCatalogueAdminHandler(env, {
      now: () => now,
      sheets,
      beforePublishBatch: (statements) => [
        ...statements,
        original.prepare('SELECT no_such_column FROM catalogue_tracks'),
      ],
    })
    expect((await h.fetch(request('/batches/' + b.batchId + '/publish', 'POST', {
      reviewRevision: b.reviewRevision,
    }))).status).toBe(409)
    expect((await readPublishedCatalogue(original)).revision).toBe('1')
    expect(
      (await original
        .prepare('SELECT status FROM catalogue_import_batches WHERE batch_id=?')
        .bind(b.batchId)
        .first<{ status: string }>())!.status,
    ).toBe('validated')
  })
  it('rejects a publication whose approval changed after its pre-read', async () => {
    book.Tracks[1][1] = 'Old approval'
    const b = await approve(await sync())
    const h = createCatalogueAdminHandler(env, {
      now: () => now,
      sheets,
      beforePublishBatch: async (statements) => {
        await decide(b, b.changes[0].changeId, 'rejected')
        return statements
      },
    })
    expect((await h.fetch(request('/batches/' + b.batchId + '/publish', 'POST', {
      reviewRevision: b.reviewRevision,
    }))).status).toBe(409)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
    expect(
      (await fixture.db
        .prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'")
        .first<{ n: number }>())!.n,
    ).toBe(0)
  })
  it('requires a reviewed source for a new track and never deletes omitted tracks', async () => {
    book.Tracks.push([
      'new-track',
      'New Track',
      'zzz',
      '',
      '',
      'work-new',
      '',
      'instrumental',
      'TRUE',
      'FALSE',
      'FALSE',
      '0.95',
      'reviewed',
      'evidence',
      '',
    ])
    book.Sources.push([
      'new-source',
      'new-track',
      'youtube',
      'abcdefghijk',
      'audio',
      'active',
      '0.95',
      'unverified',
      'recording-evidence',
      '',
    ])
    let b = await sync()
    b = await decide(b, b.changes.find((c) => c.kind === 'new_track')!.changeId)
    expect((await publish(b)).status).toBe(409)
    b = await decide(b, b.changes.find((c) => c.kind === 'new_source')!.changeId)
    expect((await publish(b)).status).toBe(200)
    expect((await readPublishedCatalogue(fixture.db)).tracks).toHaveLength(4)
  })
  it('exports only after explicit authenticated action; Google failure leaves public catalogue untouched', async () => {
    expect((await handler().fetch(request('/export-sheet', 'POST', {}))).status).toBe(200)
    expect(sheets.write).toHaveBeenCalledOnce()
    sheets.read.mockRejectedValueOnce(new Error('secret google token'))
    expect((await handler().fetch(request('/sync', 'POST', {}))).status).toBe(503)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })
})

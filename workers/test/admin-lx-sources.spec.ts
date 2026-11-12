vi.mock('../lx/defaultSource', async () => {
  const { syntheticManagedSource } = await import('./fixtures/synthetic-managed-source')
  return { configuredDefaultSource: () => syntheticManagedSource }
})

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLxSourcesHandler } from '../admin/lxSources'
import { createLxPublicHandler } from '../lx/publicRoutes'
import { analyseLxScript, screenLxScript, sha256Hex } from '../lx/globalSources'

const NOW = 1_787_030_400_000
/** A real user row, because the audit table has a foreign key on the actor. */
const OWNER_ID = 'user-lx-owner'
const PUBLIC_ORIGIN = 'https://study.example'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => database.prepare(statement)),
    )
  }
}

/** A script that looks like a real LX source and needs one HTTPS origin. */
const GOOD_SCRIPT = `/**
 * @name Test Source
 * @version 1.0.0
 */
const API = 'https://api.example.com/lx';
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => API);
`

const SECOND_SCRIPT = GOOD_SCRIPT.replace('Test Source', 'Second Source').replace('1.0.0', '2.0.0')

/** A script with an embedded credential: it must be refused. */
const CREDENTIAL_SCRIPT = `const apiKey = 'super-secret-key-value';
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => 'https://api.example.com/lx');
`

/** A script that reaches a plaintext origin: it must be refused. */
const PLAINTEXT_SCRIPT = `const API = 'http://api.example.com/lx';
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => API);
`

describe('global LX source registry', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let owner: boolean
  let lxOrigins = 'https://api.example.com'

  const adminEnv = () => ({
    DB: database,
    PUBLIC_ORIGIN,
    LX_ALLOWED_ORIGINS: lxOrigins,
  })

  const createHandler = () =>
    createLxSourcesHandler(adminEnv() as never, {
      now: () => NOW,
      requireOwner: async () => {
        if (owner) return { id: OWNER_ID }
        return Response.json({ error: 'forbidden' }, { status: 403 })
      },
    })

  const request = (path: string, init: RequestInit = {}): Request =>
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  beforeEach(async () => {
    lxOrigins = 'https://api.example.com'
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `lx-sources-${crypto.randomUUID()}` },
      d1Persist: false,
      // One scratch directory for the whole file. Without this the wrapper creates a fresh
      // temporary directory per test and then has to delete it, which this host's filesystem guard
      // refuses above a per-turn threshold.
      resourceTmpPath: resolve(process.cwd(), '.wrangler/test-temp/lx-sources-shared'),
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    // The audit table references the acting user, so the Owner has to exist as a real row.
    await database
      .prepare(
        `INSERT INTO users (id, display_name, role, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      )
      .bind(OWNER_ID, 'LX Owner', NOW, NOW)
      .run()
    owner = true
  })

  afterEach(async () => {
    try {
      await miniflare.dispose()
    } catch (error: unknown) {
      // This host's filesystem shim refuses a recursive delete above a per-turn threshold, and
      // Miniflare's temp storage directory holds more files than that. Cleanup failing is not a
      // statement about the code under test, so only that specific refusal is tolerated.
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')) throw error
    }
  })

  describe('the policy screen', () => {
    it('accepts an ordinary source', () => {
      expect(screenLxScript(GOOD_SCRIPT)).toBeNull()
    })

    it('refuses a script that embeds a credential', () => {
      const rejection = screenLxScript(CREDENTIAL_SCRIPT)
      expect(rejection?.code).toBe('embedded_credentials')
      // The message names the kind of finding, never the value.
      expect(rejection?.message).not.toContain('super-secret-key-value')
    })

    it('refuses a script that references a plaintext origin', () => {
      expect(screenLxScript(PLAINTEXT_SCRIPT)?.code).toBe('plaintext_origin')
    })

    it('refuses an oversized script', () => {
      expect(screenLxScript('x'.repeat(600 * 1024))?.code).toBe('too_large')
    })

    it('reports the origins a script needs', () => {
      const analysis = analyseLxScript(GOOD_SCRIPT)
      expect(analysis.httpsOrigins).toEqual(['https://api.example.com'])
      expect(analysis.name).toBe('Test Source')
      expect(analysis.version).toBe('1.0.0')
    })
  })

  describe('owner-only mutations', () => {
    it('imports a mixed-backend script while reporting HTTP branches that the sandbox still refuses', async () => {
      const script = GOOD_SCRIPT + `\nconst legacy = 'http://nmobi.kuwo.cn/api';`
      const response = await createHandler().fetch(request('/api/admin/lx/sources', {method:'POST',body:JSON.stringify({script})}))
      expect(response.status).toBe(201)
      expect((await response.json() as any).source).toMatchObject({status:'active',plaintextOrigins:['http://nmobi.kuwo.cn']})
      const preview = await createHandler().fetch(request('/api/admin/lx/sources/preview', {method:'POST',body:JSON.stringify({script})}))
      expect(preview.status).toBe(200)
      expect((await preview.json() as any).plaintextOrigins).toEqual(['http://nmobi.kuwo.cn'])
    })
    // The registry is mounted outside the routing table that guards the rest of the Admin API, so
    // its reads need their own check. Without it an anonymous caller could list the sources the
    // Owner has not published — import URLs, snapshot history, failure notes — which the public
    // endpoint deliberately never exposes.
    it('refuses the source list without an owner session', async () => {
      owner = false
      const response = await createHandler().fetch(request('/api/admin/lx/sources'))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
    })

    it('refuses a source detail without an owner session', async () => {
      const created = await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )
      const { source } = (await created.json()) as { source: { id: string } }
      owner = false
      const response = await createHandler().fetch(request(`/api/admin/lx/sources/${source.id}`))
      expect(response.status).toBe(403)
    })

    it('refuses a creation from a non-owner', async () => {
      owner = false
      const response = await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )
      expect(response.status).toBe(403)
    })

    it('creates a source and publishes it', async () => {
      const response = await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )
      expect(response.status).toBe(201)
      const body = (await response.json()) as { source: { id: string; sha256: string; status: string; name: string } }
      expect(body.source.name).toBe('Test Source')
      expect(body.source.status).toBe('active')
      expect(body.source.sha256).toBe(await sha256Hex(GOOD_SCRIPT))
    })

    it('refuses a source whose origin is not approved by the deployment', async () => {
      const response = await createHandler().fetch(
        request('/api/admin/lx/sources', {
          method: 'POST',
          body: JSON.stringify({ script: GOOD_SCRIPT.replace('api.example.com', 'other.example.org') }),
        }),
      )
      expect(response.status).toBe(201)
      const body = (await response.json()) as { source: { status: string; pendingOrigins: string[] } }
      expect(body.source.status).toBe('pending_network_approval')
      expect(body.source.pendingOrigins).toEqual(['https://other.example.org'])
    })

    it('publishes a source with an arbitrary or IP-literal origin as active when the deployment allows https: (Owner: allow all)', async () => {
      lxOrigins = 'https:'
      for (const origin of ['https://other.example.org', 'https://103.79.184.97:8443']) {
        const response = await createHandler().fetch(
          request('/api/admin/lx/sources', {
            method: 'POST',
            body: JSON.stringify({ script: GOOD_SCRIPT.replace('https://api.example.com', origin) }),
          }),
        )
        expect(response.status, origin).toBe(201)
        const body = (await response.json()) as { source: { status: string; pendingOrigins: string[] } }
        expect(body.source.status, origin).toBe('active')
        expect(body.source.pendingOrigins, origin).toEqual([])
      }
    })
    it('refuses to publish a source with an embedded credential', async () => {
      const response = await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: CREDENTIAL_SCRIPT }) }),
      )
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe('embedded_credentials')
    })

    it('previews credential keys without publishing, then requires disclosure consent for the exact digest', async () => {
      const preview=await createHandler().fetch(request('/api/admin/lx/sources/preview',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT})}))
      expect(preview.status).toBe(200)
      const candidate=await preview.json() as any
      expect(candidate.credentialKeys).toEqual(['apikey'])
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
      for(const consent of [true,'a'.repeat(64)]) {
        const response=await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT,credentialDisclosureSha256:consent})}))
        expect(response.status).toBe(422)
      }
      const response=await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT,credentialDisclosureSha256:candidate.sha256})}))
      expect(response.status).toBe(201)
      const audit=await database.prepare("SELECT detail_json AS detail FROM admin_audit_log WHERE action='lx_source.create'").first<any>()
      expect(JSON.parse(audit.detail).credentialDisclosure).toEqual({sha256:candidate.sha256,keys:['apikey']})
      expect(audit.detail).not.toContain('super-secret-key-value')
      const changed=await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT+'\n// changed',credentialDisclosureSha256:candidate.sha256})}))
      expect(changed.status).toBe(422)
    })

    it('requires a fresh disclosure acknowledgement for credential snapshot adoption and rollback', async()=>{
      const sha256=await sha256Hex(CREDENTIAL_SCRIPT)
      const created=await (await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:GOOD_SCRIPT})}))).json() as any
      const path=`/api/admin/lx/sources/${created.source.id}/adopt`
      expect((await createHandler().fetch(request(path,{method:'POST',body:JSON.stringify({sha256,script:CREDENTIAL_SCRIPT})}))).status).toBe(422)
      expect((await createHandler().fetch(request(path,{method:'POST',body:JSON.stringify({sha256,script:CREDENTIAL_SCRIPT,credentialDisclosureSha256:sha256})}))).status).toBe(200)
      expect((await createHandler().fetch(request(path,{method:'POST',body:JSON.stringify({sha256:created.source.sha256})}))).status).toBe(200)
      expect((await createHandler().fetch(request(path,{method:'POST',body:JSON.stringify({sha256})}))).status).toBe(422)
      expect((await createHandler().fetch(request(path,{method:'POST',body:JSON.stringify({sha256,credentialDisclosureSha256:sha256})}))).status).toBe(200)
    })

    it('never treats disclosure consent as Owner authorisation or permission for malformed scripts', async()=>{
      const sha256=await sha256Hex(CREDENTIAL_SCRIPT)
      owner=false
      expect((await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT,credentialDisclosureSha256:sha256})}))).status).toBe(403)
      owner=true
      for(const script of ['const token = "unterminated', 'const a=1;\u0000', 'x'.repeat(600*1024)]) {
        const response=await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script,credentialDisclosureSha256:await sha256Hex(script)})}))
        expect(response.status).toBe(422)
      }
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
    })

    it('refuses a remote script that changes between preview and disclosure-confirmed create',async()=>{
      let script=CREDENTIAL_SCRIPT
      const handler=createLxSourcesHandler(adminEnv() as never,{now:()=>NOW,requireOwner:async()=>({id:OWNER_ID}),fetch:async()=>new Response(script,{headers:{'content-type':'application/javascript'}})})
      const url='https://example.com/source.js'
      const preview=await (await handler.fetch(request('/api/admin/lx/sources/preview',{method:'POST',body:JSON.stringify({url})}))).json() as any
      script+='\n// upstream changed'
      const response=await handler.fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({url,credentialDisclosureSha256:preview.sha256})}))
      expect(response.status).toBe(422)
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
    })

    it('rolls back a disclosure-confirmed import when its audit record cannot be stored',async()=>{
      await database.prepare("CREATE TRIGGER refuse_disclosure_audit BEFORE INSERT ON admin_audit_log BEGIN SELECT RAISE(ABORT,'audit failed'); END").run()
      await expect(createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:CREDENTIAL_SCRIPT,credentialDisclosureSha256:await sha256Hex(CREDENTIAL_SCRIPT)})}))).rejects.toThrow()
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
      expect((await database.prepare('SELECT revision FROM lx_global_registry WHERE id=1').first<any>())?.revision).toBe(1)
    })

    it('disables and re-enables a source', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string } }

      const disabled = (await (await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        }),
      )).json()) as { source: { enabled: boolean; status: string } }
      expect(disabled.source.enabled).toBe(false)
      expect(disabled.source.status).toBe('disabled')

      const enabled = (await (await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: true }),
        }),
      )).json()) as { source: { enabled: boolean; status: string } }
      expect(enabled.source.enabled).toBe(true)
      expect(enabled.source.status).toBe('active')
    })

    it('reorders sources and bumps the registry revision', async () => {
      const first = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string } }
      const second = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: SECOND_SCRIPT }) }),
      )).json()) as { source: { id: string } }

      const before = (await (await createHandler().fetch(request('/api/admin/lx/sources'))).json()) as { revision: number }
      const reordered = (await (await createHandler().fetch(
        request('/api/admin/lx/sources/order', {
          method: 'POST',
          body: JSON.stringify({ ids: [second.source.id, first.source.id] }),
        }),
      )).json()) as { revision: number }
      expect(reordered.revision).toBeGreaterThan(before.revision)

      const list = (await (await createHandler().fetch(request('/api/admin/lx/sources'))).json()) as {
        sources: Array<{ id: string; priority: number }>
      }
      expect(list.sources.map((source) => source.id)).toEqual(['builtin-kulao-svip', second.source.id, first.source.id])
    })

    it('deletes a source', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string } }
      const response = await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}`, { method: 'DELETE' }),
      )
      expect(response.status).toBe(200)
      const list = (await (await createHandler().fetch(request('/api/admin/lx/sources'))).json()) as {
        sources: unknown[]
      }
      expect(list.sources).toEqual([expect.objectContaining({ id: 'builtin-kulao-svip', managed: true })])
    })
  })

  describe('snapshots', () => {
    it('stores the script by digest and can roll back to it', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string; sha256: string; snapshots: Array<{ sha256: string; active: boolean }> } }

      expect(created.source.snapshots).toHaveLength(1)
      expect(created.source.snapshots[0]?.active).toBe(true)

      const initialRevision = await database.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first<{ revision: number }>()
      // Adopt a second body, then roll back to the first.
      const adopted = (await (await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}/adopt`, {
          method: 'POST',
          body: JSON.stringify({ sha256: await sha256Hex(SECOND_SCRIPT), script: SECOND_SCRIPT }),
        }),
      )).json()) as { source: { sha256: string; snapshots: Array<{ sha256: string; active: boolean }> } }
      expect(adopted.source.sha256).toBe(await sha256Hex(SECOND_SCRIPT))
      expect(adopted.source.snapshots).toHaveLength(2)
      const adoptedRevision = await database.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first<{ revision: number }>()
      expect(adoptedRevision?.revision).toBe(initialRevision!.revision + 1)

      const rolledBack = (await (await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}/adopt`, {
          method: 'POST',
          body: JSON.stringify({ sha256: created.source.sha256 }),
        }),
      )).json()) as { source: { sha256: string } }
      expect(rolledBack.source.sha256).toBe(created.source.sha256)
      const rollbackRevision = await database.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first<{ revision: number }>()
      expect(rollbackRevision?.revision).toBe(initialRevision!.revision + 2)
    })

    it('rolls back the candidate snapshot and revision if the active pointer update fails', async () => {
      const created = await (await createHandler().fetch(request('/api/admin/lx/sources', {
        method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }),
      }))).json() as { source: { id: string; sha256: string } }
      const before = await database.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first<{ revision: number }>()
      await database.prepare(`CREATE TRIGGER refuse_lx_pointer BEFORE UPDATE OF active_sha256 ON lx_global_sources
        BEGIN SELECT RAISE(ABORT, 'fixture refuses pointer update'); END`).run()
      await expect(createHandler().fetch(request(`/api/admin/lx/sources/${created.source.id}/adopt`, {
        method: 'POST', body: JSON.stringify({ sha256: await sha256Hex(SECOND_SCRIPT), script: SECOND_SCRIPT }),
      }))).rejects.toThrow('fixture refuses pointer update')
      expect(await database.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first()).toEqual(before)
      expect(await database.prepare('SELECT active_sha256 FROM lx_global_sources WHERE id = ?').bind(created.source.id).first())
        .toEqual({ active_sha256: created.source.sha256 })
      expect(await database.prepare('SELECT COUNT(*) AS n FROM lx_global_source_snapshots').first()).toEqual({ n: 1 })
    })

    it.each(['create', 'update', 'delete', 'reorder', 'adopt'])('keeps the published registry unchanged when %s audit insertion fails', async (operation) => {
      const created = await (await createHandler().fetch(request('/api/admin/lx/sources', {
        method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }),
      }))).json() as { source: { id: string } }
      const dump = async () => Promise.all(['lx_global_sources', 'lx_global_source_snapshots', 'lx_global_registry'].map(async table =>
        (await database.prepare(`SELECT * FROM ${table}`).all()).results))
      const before = await dump()
      await database.prepare(`CREATE TRIGGER refuse_lx_audit BEFORE INSERT ON admin_audit_log
        BEGIN SELECT RAISE(ABORT, 'fixture refuses audit insertion'); END`).run()
      const id = created.source.id
      const operations: Record<string, [string, RequestInit]> = {
        create: ['/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: SECOND_SCRIPT }) }],
        update: [`/api/admin/lx/sources/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }],
        delete: [`/api/admin/lx/sources/${id}`, { method: 'DELETE' }],
        reorder: ['/api/admin/lx/sources/order', { method: 'POST', body: JSON.stringify({ ids: [id] }) }],
        adopt: [`/api/admin/lx/sources/${id}/adopt`, { method: 'POST', body: JSON.stringify({ sha256: await sha256Hex(SECOND_SCRIPT), script: SECOND_SCRIPT }) }],
      }
      const [path, init] = operations[operation]!
      await expect(createHandler().fetch(request(path, init))).rejects.toThrow('fixture refuses audit insertion')
      expect(await dump()).toEqual(before)
    })

    it('refuses to adopt a body that does not match the digest', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string } }
      const response = await createHandler().fetch(
        request(`/api/admin/lx/sources/${created.source.id}/adopt`, {
          method: 'POST',
          body: JSON.stringify({ sha256: 'a'.repeat(64), script: SECOND_SCRIPT }),
        }),
      )
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe('digest_mismatch')
    })

    it('leaves the active script alone when an update check fails', async () => {
      // A source imported from a URL, so it has an origin that can be re-fetched.
      const importing = createLxSourcesHandler(adminEnv() as never, {
        now: () => NOW,
        fetch: (async () => new Response(GOOD_SCRIPT, { status: 200 })) as unknown as typeof fetch,
        requireOwner: async () => ({ id: OWNER_ID }),
      })
      const created = (await (await importing.fetch(
        request('/api/admin/lx/sources', {
          method: 'POST',
          body: JSON.stringify({ url: 'https://example.com/source.js' }),
        }),
      )).json()) as { source: { id: string; sha256: string } }

      const failing = createLxSourcesHandler(adminEnv() as never, {
        now: () => NOW,
        fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
        requireOwner: async () => ({ id: OWNER_ID }),
      })
      const response = await failing.fetch(
        request(`/api/admin/lx/sources/${created.source.id}/check-update`, { method: 'POST', body: '{}' }),
      )
      expect(response.status).toBe(422)
      const body = (await response.json()) as { activeSha256: string }
      // The published script is still the one that worked: a failed check changes nothing.
      expect(body.activeSha256).toBe(created.source.sha256)
    })

    it('reports an update as a candidate without adopting it', async () => {
      const importing = createLxSourcesHandler(adminEnv() as never, {
        now: () => NOW,
        fetch: (async () => new Response(GOOD_SCRIPT, { status: 200 })) as unknown as typeof fetch,
        requireOwner: async () => ({ id: OWNER_ID }),
      })
      const created = (await (await importing.fetch(
        request('/api/admin/lx/sources', {
          method: 'POST',
          body: JSON.stringify({ url: 'https://example.com/source.js' }),
        }),
      )).json()) as { source: { id: string; sha256: string } }

      const updated = createLxSourcesHandler(adminEnv() as never, {
        now: () => NOW,
        fetch: (async () => new Response(SECOND_SCRIPT, { status: 200 })) as unknown as typeof fetch,
        requireOwner: async () => ({ id: OWNER_ID }),
      })
      const response = await updated.fetch(
        request(`/api/admin/lx/sources/${created.source.id}/check-update`, { method: 'POST', body: '{}' }),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        hasUpdate: boolean
        candidateSha256: string
        activeSha256: string
      }
      expect(body.hasUpdate).toBe(true)
      expect(body.candidateSha256).toBe(await sha256Hex(SECOND_SCRIPT))
      // Checking is not adopting: the active digest is untouched until the Owner says so.
      expect(body.activeSha256).toBe(created.source.sha256)

      const publicHandler = createLxPublicHandler({ DB: database })
      const published = (await (await publicHandler.fetch(request('/api/lx/sources'))).json()) as {
        sources: Array<{ sha256: string }>
      }
      expect(published.sources[0]?.sha256).toBe(created.source.sha256)
    })
  })

  describe('the anonymous publication endpoints', () => {
    it('lists only published sources and serves their script by digest', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string; sha256: string } }

      const publicHandler = createLxPublicHandler({ DB: database })
      const listResponse = await publicHandler.fetch(request('/api/lx/sources'))
      expect(listResponse.status).toBe(200)
      const list = (await listResponse.json()) as { revision: number; sources: Array<{ id: string; sha256: string }> }
      expect(list.sources).toHaveLength(1)
      expect(list.sources[0]?.id).toBe(created.source.id)

      const scriptResponse = await publicHandler.fetch(
        request(`/api/lx/sources/${created.source.id}/script?sha256=${created.source.sha256}`),
      )
      expect(scriptResponse.status).toBe(200)
      expect(await scriptResponse.text()).toBe(GOOD_SCRIPT)
      // The body is addressed by digest, so it can be cached immutably.
      expect(scriptResponse.headers.get('cache-control')).toContain('immutable')
    })

    it('does not publish a source that is disabled or awaiting approval', async () => {
      const pending = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', {
          method: 'POST',
          body: JSON.stringify({ script: GOOD_SCRIPT.replace('api.example.com', 'other.example.org') }),
        }),
      )).json()) as { source: { id: string; sha256: string } }

      const publicHandler = createLxPublicHandler({ DB: database })
      const list = (await (await publicHandler.fetch(request('/api/lx/sources'))).json()) as { sources: unknown[] }
      expect(list.sources).toHaveLength(0)

      const scriptResponse = await publicHandler.fetch(
        request(`/api/lx/sources/${pending.source.id}/script?sha256=${pending.source.sha256}`),
      )
      expect(scriptResponse.status).toBe(404)
    })

    it('refuses to serve a body for a digest that is not the published one', async () => {
      const created = (await (await createHandler().fetch(
        request('/api/admin/lx/sources', { method: 'POST', body: JSON.stringify({ script: GOOD_SCRIPT }) }),
      )).json()) as { source: { id: string } }

      const publicHandler = createLxPublicHandler({ DB: database })
      const response = await publicHandler.fetch(
        request(`/api/lx/sources/${created.source.id}/script?sha256=${'b'.repeat(64)}`),
      )
      expect(response.status).toBe(409)
    })

    it('needs no authentication to read the published list', async () => {
      const publicHandler = createLxPublicHandler({ DB: database })
      const response = await publicHandler.fetch(request('/api/lx/sources'))
      expect(response.status).toBe(200)
    })
  })
  describe('administrator-published synthetic default', () => {
    const id = 'builtin-kulao-svip'
    it('shows its bundled default to Owner and public readers without seeding D1 on GET', async () => {
      const result = await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as any
      expect(result.sources.find((source:any) => source.id === id)).toMatchObject({name:'Synthetic Managed Source', enabled:true, managed:true})
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
      const body = await (await createLxPublicHandler({DB:database}).fetch(request('/api/lx/sources'))).json() as any
      expect(body.managedSource).toMatchObject({id,enabled:true})
      expect((await database.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').first<any>())?.n).toBe(0)
    })
    it('Owner changes materialise one immutable snapshot and stop the old local fallback when disabled', async () => {
      const response = await createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'PATCH',body:JSON.stringify({enabled:false,name:'Managed Synthetic Source',priority:25})}))
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.source).toMatchObject({id,name:'Managed Synthetic Source',priority:25,enabled:false})
      expect(body.revision).toBe(2)
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_source_snapshots WHERE source_id=?').bind(id).first<any>())?.n).toBe(1)
      const published=await (await createLxPublicHandler({DB:database}).fetch(request('/api/lx/sources'))).json() as any
      expect(published.managedSource).toMatchObject({id,enabled:false,status:'disabled'})
      expect(published.sources).toEqual([])
      expect((await createLxPublicHandler({DB:database}).fetch(request('/api/lx/sources/'+id+'/script?sha256='+body.source.sha256))).status).toBe(404)
    })
    it('serves only the exact released default and preserves its snapshot across reviewed replacement and rollback', async () => {
      const initial = await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as {sources:Array<{id:string;sha256:string}>}
      const original = initial.sources.find(source => source.id === id)!
      const publicHandler = createLxPublicHandler({DB:database})
      const response = await publicHandler.fetch(request(`/api/lx/sources/${id}/script?sha256=${original.sha256}`))
      expect(response.status).toBe(200)
      expect(await sha256Hex(await response.text())).toBe(original.sha256)
      expect((await publicHandler.fetch(request(`/api/lx/sources/${id}/script?sha256=${'f'.repeat(64)}`))).status).toBe(409)
      const replacementSha = await sha256Hex(GOOD_SCRIPT)
      const adopted = await createHandler().fetch(request(`/api/admin/lx/sources/${id}/adopt`, {method:'POST',body:JSON.stringify({sha256:replacementSha,script:GOOD_SCRIPT})}))
      expect(adopted.status).toBe(200)
      expect((await adopted.json() as any).source.snapshots).toHaveLength(2)
      expect((await publicHandler.fetch(request(`/api/lx/sources/${id}/script?sha256=${original.sha256}`))).status).toBe(409)
      const rollback = await createHandler().fetch(request(`/api/admin/lx/sources/${id}/adopt`, {method:'POST',body:JSON.stringify({sha256:original.sha256})}))
      expect(rollback.status).toBe(200)
      expect((await rollback.json() as any).source).toMatchObject({sha256:original.sha256,enabled:true})
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_source_snapshots WHERE source_id=?').bind(id).first<{n:number}>())?.n).toBe(2)
    })
    it('materialises verification notes atomically with an audited revision instead of reporting a no-op as success', async () => {
      const result=await createHandler().fetch(request(`/api/admin/lx/sources/${id}/verify`,{method:'POST',body:JSON.stringify({ok:true,note:'Owner sandbox test'})}))
      expect(result.status).toBe(200)
      expect((await result.json() as any).source).toMatchObject({lastCheckNote:'Owner sandbox test',lastCheckedAt:NOW})
      expect((await database.prepare('SELECT revision FROM lx_global_registry WHERE id=1').first<{revision:number}>())?.revision).toBe(2)
      expect((await database.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='lx_source.verify'").first<{n:number}>())?.n).toBe(1)
    })
    it('reorders the virtual default using the same published order as other sources', async () => {
      const created=await (await createHandler().fetch(request('/api/admin/lx/sources',{method:'POST',body:JSON.stringify({script:GOOD_SCRIPT})}))).json() as any
      const result=await createHandler().fetch(request('/api/admin/lx/sources/order',{method:'POST',body:JSON.stringify({ids:[created.source.id,id]})}))
      expect(result.status).toBe(200)
      const list=await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as any
      expect(list.sources.map((source:any)=>source.id)).toEqual([created.source.id,id])
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_source_snapshots WHERE source_id=?').bind(id).first<{n:number}>())?.n).toBe(1)
    })
    it.each([false,true])('deletes the default and persists revocation without resurrection (materialised=%s)',async(materialised)=>{
      if(materialised) {
        expect((await createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'PATCH',body:JSON.stringify({name:'Owner Synthetic Source'})}))).status).toBe(200)
      }
      const response = await createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'DELETE'}))
      expect(response.status).toBe(200)
      expect((await response.json() as any).revision).toBe(materialised ? 3 : 2)
      const list = await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as any
      expect(list.sources.some((source:any)=>source.id===id)).toBe(false)
      const publicHandler = createLxPublicHandler({DB:database})
      const publication = await (await publicHandler.fetch(request('/api/lx/sources'))).json() as any
      expect(publication.managedSource).toMatchObject({id,enabled:false,status:'disabled',deleted:true})
      expect((await publicHandler.fetch(request(`/api/lx/sources/${id}/script?sha256=${publication.managedSource.sha256}`))).status).toBe(404)
      expect((await database.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='lx_source.delete'").first<any>())?.n).toBe(1)
      // Removing audit history must never restore the release-provided fallback.
      await database.prepare('DELETE FROM admin_audit_log').run()
      const reloaded = await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as any
      expect(reloaded.sources.some((source:any)=>source.id===id)).toBe(false)
      expect((await createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'DELETE'}))).status).toBe(404)
      owner=false
      expect((await createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'PATCH',body:JSON.stringify({enabled:false})}))).status).toBe(403)
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_sources').first<any>())?.n).toBe(0)
      expect((await database.prepare('SELECT COUNT(*) AS n FROM lx_global_source_snapshots WHERE source_id=?').bind(id).first<any>())?.n).toBe(0)
    })
    it('rolls back managed deletion and its revocation when the audit insertion fails', async()=>{
      await database.prepare("CREATE TRIGGER refuse_lx_delete_audit BEFORE INSERT ON admin_audit_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END").run()
      await expect(createHandler().fetch(request('/api/admin/lx/sources/'+id,{method:'DELETE'}))).rejects.toThrow()
      const list = await (await createHandler().fetch(request('/api/admin/lx/sources'))).json() as any
      expect(list.sources.find((source:any)=>source.id===id)).toMatchObject({enabled:true})
    })
  })

})

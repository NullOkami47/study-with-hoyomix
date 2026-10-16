import { describe, expect, it, vi } from 'vitest'

import { createAdminRepository } from './client'

const response = (body: unknown, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

describe('admin repository session result', () => {
  it('reports an authorised admin or owner session', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const fetcher = vi.fn().mockResolvedValue(response({ user: { id: 'user-1', role } }))
      const repo = createAdminRepository({ fetch: fetcher as typeof fetch })
      await expect(repo.checkSession()).resolves.toEqual({ status: 'authorised', role })
    }
  })

  it('reports unauthorised for no session, denials, and ordinary roles', async () => {
    for (const [body, status] of [
      [{ user: null }, 401],
      [{ error: 'forbidden' }, 403],
      [{ user: { id: 'user-1', role: 'user' } }, 200],
      [{ user: { id: 'user-1', role: 'moderator' } }, 200],
    ] as const) {
      const fetcher = vi.fn().mockResolvedValue(response(body, status))
      const repo = createAdminRepository({ fetch: fetcher as typeof fetch })
      await expect(repo.checkSession()).resolves.toEqual({ status: 'unauthorised' })
    }
  })

  it('reports unavailable for network, server, and malformed backend responses', async () => {
    const cases: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error('network failure')),
      () => Promise.resolve(response({ error: 'unavailable' }, 503)),
      () => Promise.resolve(response('not json', 200)),
      () => Promise.resolve(response(null, 200)),
      () => Promise.resolve(response({ user: 'invalid' }, 200)),
    ]
    for (const makeResponse of cases) {
      const fetcher = vi.fn(makeResponse)
      const repo = createAdminRepository({ fetch: fetcher as typeof fetch })
      await expect(repo.checkSession()).resolves.toEqual({ status: 'unavailable' })
    }
  })
})

describe('admin repository provider settings', () => {
  it('updates only the ChKSz Owner fallback flag through the exact same-origin endpoint', async () => {
    const projection = {
      ownerKeyConfigured: true,
      ownerFallbackEnabled: true,
      ownerFallbackUsable: true,
    }
    const fetcher = vi.fn().mockResolvedValue(response(projection))
    const repo = createAdminRepository({ fetch: fetcher as typeof fetch })

    await expect(repo.updateChkszOwnerFallback(true)).resolves.toEqual(projection)
    expect(fetcher).toHaveBeenCalledOnce()
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/admin/providers/chksz/owner-fallback')
    expect(init.method).toBe('PUT')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true })
    expect(new Headers(init.headers).get('origin')).toBe(window.location.origin)
  })

  it('updates provider order through PUT /api/admin/providers/order', async () => {
    const providers = [
      { key: 'jellyfin', priority: 10, adminEnabled: true, deploymentAvailable: true, effectiveEnabled: true },
      { key: 'chksz', priority: 20, adminEnabled: true, deploymentAvailable: true, effectiveEnabled: true },
      { key: 'lx', priority: 30, adminEnabled: true, deploymentAvailable: true, effectiveEnabled: true },
    ]
    const fetcher = vi.fn().mockResolvedValue(response({ providers }))
    const repo = createAdminRepository({ fetch: fetcher as typeof fetch })

    const result = await repo.updateProviderOrder(['jellyfin', 'chksz', 'lx'])
    expect(result).toEqual(providers)
    expect(fetcher).toHaveBeenCalledOnce()
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/admin/providers/order')
    expect(init.method).toBe('PUT')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(String(init.body))).toEqual({ providerIds: ['jellyfin', 'chksz', 'lx'] })
    expect(new Headers(init.headers).get('origin')).toBe(window.location.origin)
  })
})


describe('catalogue review client',()=>{
  it('saves an edit with its observed review revision, returns server state and never publishes', async () => {
    const edited = { batchId: 'batch', reviewRevision: 8, changes: [{ after: { title: 'Server title' }, decision: 'pending' }] }
    const fetcher = vi.fn(async () => response(edited))
    const repo = createAdminRepository({ fetch: fetcher })
    const after = { track_id: 'track-a', title: 'Manual title' }
    await expect(repo.editCatalogueChange('batch', 'change', after, 7)).resolves.toEqual(edited)
    expect(fetcher).toHaveBeenCalledOnce()
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/admin/catalogue/batches/batch/changes/change')
    expect(init.method).toBe('PATCH')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('origin')).toBe(window.location.origin)
    expect(JSON.parse(String(init.body))).toEqual({ after, reviewRevision: 7 })
  })
  it('sends explicit Owner R2 approval with the observed review revision', async () => {
    const fetcher = vi.fn(async () => response({ batchId: 'batch', reviewRevision: 8 }))
    const repo = createAdminRepository({ fetch: fetcher })
    await repo.approveCatalogueR2AsOwner('batch', 'change', 7)
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/admin/catalogue/batches/batch/changes/change/approve-r2-owner')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ reviewRevision: 7 })
  })
  it('does not include server error details or credentials in an edit failure', async () => {
    const repo = createAdminRepository({
      fetch: vi.fn(async () => response({ error: 'PRIVATE KEY server-secret' }, 409)),
    })
    await expect(repo.editCatalogueChange('batch', 'change', { title: 'Edited' }, 1))
      .rejects.toThrow(/^admin_409$/)
  })
  it('uses same-origin credentials and mutation headers with typed review endpoints',async()=>{
    const calls:{path:string;init?:RequestInit}[]=[]
    const fetcher=vi.fn(async(path:string|URL|Request,init?:RequestInit)=>{calls.push({path:String(path),init});return response({batchId:'batch'})})
    const repo=createAdminRepository({fetch:fetcher})
    await repo.getCatalogueStatus();await repo.syncCatalogue();await repo.exportCatalogueSheet();await repo.getCatalogueBatch('batch');await repo.decideCatalogueChange('batch','change','approved',4);await repo.approveCatalogueHighConfidence('batch',5);await repo.publishCatalogueBatch('batch',6)
    expect(calls.map(c=>c.path)).toEqual(['/api/admin/catalogue/status','/api/admin/catalogue/sync','/api/admin/catalogue/export-sheet','/api/admin/catalogue/batches/batch','/api/admin/catalogue/batches/batch/changes/change','/api/admin/catalogue/batches/batch/approve-high-confidence','/api/admin/catalogue/batches/batch/publish'])
    expect(calls.every(c=>c.init?.credentials==='same-origin')).toBe(true)
    for(const c of calls.filter(c=>c.init?.method))expect(new Headers(c.init?.headers).get('origin')).toBe(window.location.origin)
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({decision:'approved',reviewRevision:4})
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({reviewRevision:5})
    expect(JSON.parse(String(calls[6].init?.body))).toEqual({reviewRevision:6})
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createGlobalLxSourceRepository } from './globalSourceRepository'

describe('global registry download recovery', () => {
  it('retries a failed script at the same registry revision and retains successful digest caches', async () => {
    const script = 'globalThis.lx = {}'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))
    const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    let bodies = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/script?')) {
        bodies++
        return bodies === 1 ? new Response('temporary failure', { status: 503 }) : new Response(script)
      }
      return Response.json({ revision: 5, sources: [{ id: 'test', name: 'Test', version: null, sha256, priority: 1, requiredOrigins: [] }] })
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    expect(await repo.list()).toEqual([])
    expect(await repo.list()).toMatchObject([{ id: 'global:test', sha256, script }])
    expect(await repo.list()).toHaveLength(1)
    expect(bodies).toBe(2)
    expect(repo.revision()).toBe(5)
  })
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const script = 'globalThis.lx = {}'
async function publishedSource(id = 'test') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))
  const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return { id, name: 'Test', version: null, sha256, priority: 1, requiredOrigins: [] as string[] }
}

describe('global registry safety', () => {
  it.each([
    { revision: 5 },
    { revision: 5, sources: null },
    { revision: 5, sources: [null] },
    { revision: 5, sources: [{ id: 'malformed' }] },
    { revision: -1, sources: [] },
    { revision: 1.5, sources: [] },
  ])('fails closed on malformed registry data before a cached revision is reused: %j', async (malformed) => {
    const source = await publishedSource()
    let reads = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/script?')) return new Response(script)
      reads++
      return Response.json(reads === 2 ? malformed : { revision: 5, sources: [source] })
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    expect(await repo.list()).toHaveLength(1)
    expect(await repo.list()).toEqual([])
    expect(repo.revision()).toBe(5)
    expect(await repo.list()).toHaveLength(1)
  })

  it('does not restore a disabled source from a later response with an older revision', async () => {
    const source = await publishedSource()
    const lists = [
      { revision: 5, sources: [source] },
      { revision: 6, sources: [] },
      { revision: 5, sources: [source] },
      { revision: 6, sources: [] },
    ]
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/script?') ? new Response(script) : Response.json(lists.shift()))
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    expect(await repo.list()).toHaveLength(1)
    expect(await repo.list()).toEqual([])
    expect(await repo.list()).toEqual([])
    expect(repo.revision()).toBe(6)
    expect(await repo.list()).toEqual([])
  })

  it('fails closed on a registry error and reuses verified bodies when the same revision recovers', async () => {
    const source = await publishedSource()
    let registryReads = 0
    let bodyReads = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/script?')) { bodyReads++; return new Response(script) }
      registryReads++
      if (registryReads === 2) return new Response('unavailable', { status: 503 })
      return Response.json({ revision: 5, sources: [source] })
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    expect(await repo.list()).toMatchObject([{ id: 'global:test', script }])
    expect(await repo.list()).toEqual([])
    expect(await repo.list()).toMatchObject([{ id: 'global:test', script }])
    expect(bodyReads).toBe(1)
  })

  it('shares a pending revalidation after a revision is already cached', async () => {
    const source = await publishedSource()
    const delayed = deferred<Response>()
    let registryReads = 0
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/script?')) return Promise.resolve(new Response(script))
      registryReads++
      return registryReads === 1
        ? Promise.resolve(Response.json({ revision: 5, sources: [source] }))
        : delayed.promise
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    await repo.list()
    const first = repo.list()
    const second = repo.list()
    expect(registryReads).toBe(2)
    delayed.resolve(Response.json({ revision: 5, sources: [source] }))
    expect(await first).toMatchObject([{ id: 'global:test' }])
    expect(await second).toMatchObject([{ id: 'global:test' }])
  })

  it('does not allow an invalidated registry request to return or restore old state or clear a newer flight', async () => {
    const source = { ...await publishedSource('old'), requiredOrigins: ['https://not-allowed.example'] }
    const oldList = deferred<Response>()
    const newList = deferred<Response>()
    let registryReads = 0
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/script?')) return Promise.resolve(new Response(script))
      registryReads++
      return registryReads === 1 ? oldList.promise : newList.promise
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    const old = repo.list()
    repo.invalidate()
    const fresh = repo.list()
    oldList.resolve(Response.json({ revision: 5, sources: [source] }))
    expect(await old).toEqual([])
    const concurrent = repo.list()
    expect(registryReads).toBe(2)
    expect(repo.revision()).toBe(-1)
    expect(repo.pendingApproval()).toEqual([])
    newList.resolve(Response.json({ revision: 6, sources: [] }))
    expect(await fresh).toEqual([])
    expect(await concurrent).toEqual([])
    expect(repo.revision()).toBe(6)
  })

  it('discards an invalidated body download and does not cache it for a later list', async () => {
    const source = await publishedSource('old')
    const oldBody = deferred<Response>()
    const bodyStarted = deferred<void>()
    let listReads = 0
    let bodyReads = 0
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/script?')) {
        bodyReads++
        if (bodyReads === 1) { bodyStarted.resolve(); return oldBody.promise }
        return Promise.resolve(new Response(script))
      }
      listReads++
      return Promise.resolve(Response.json({ revision: listReads, sources: [source] }))
    })
    const repo = createGlobalLxSourceRepository({ fetch: fetchImpl as typeof fetch })
    const old = repo.list()
    await bodyStarted.promise
    repo.invalidate()
    oldBody.resolve(new Response(script))
    expect(await old).toEqual([])
    expect(repo.revision()).toBe(-1)
    expect(repo.pendingApproval()).toEqual([])
    expect(await repo.list()).toMatchObject([{ id: 'global:old', script }])
    expect(bodyReads).toBe(2)
  })
})


it('honours managed Kulao metadata independently of ordinary published sources',async()=>{
 const source=await publishedSource('builtin-kulao-svip')
 const repo=createGlobalLxSourceRepository({fetch:vi.fn(async(url:string|URL|Request)=>String(url).includes('/script?')?new Response(script):Response.json({revision:1,sources:[],managedSource:{...source,enabled:false,status:'disabled'}})) as typeof fetch})
 expect(await repo.list()).toEqual([])
 expect(repo.managesBundledSource).toBe(true)
 expect(repo.managedSource?.()).toMatchObject({id:'builtin-kulao-svip',enabled:false})
})


describe('administrator-managed default authority', () => {
  it('accepts a durable deleted policy and does not download or restore its body', async () => {
    const source=await publishedSource('builtin-kulao-svip')
    const fetchImpl=vi.fn(async()=>Response.json({revision:3,sources:[],managedSource:{...source,enabled:false,status:'disabled',deleted:true}}))
    const repo=createGlobalLxSourceRepository({fetch:fetchImpl as typeof fetch})
    expect(await repo.list()).toEqual([])
    expect(repo.managedSource?.()).toMatchObject({deleted:true,enabled:false})
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('verifies the active body, then honours disablement and preserves authority during a registry outage', async () => {
    const source = await publishedSource('builtin-kulao-svip')
    let state: 'active' | 'disabled' | 'outage' = 'active'
    let bodies = 0
    const repo = createGlobalLxSourceRepository({ fetch: vi.fn(async (url) => {
      if (String(url).includes('/script?')) { bodies++; return new Response(script) }
      if (state === 'outage') throw new Error('offline')
      return Response.json({revision:state === 'active' ? 1 : 2,sources:[],managedSource:{...source,enabled:state === 'active',status:state}})
    }) as typeof fetch })
    expect(await repo.list()).toMatchObject([{id:'global:builtin-kulao-svip',script,sha256:source.sha256}])
    state = 'disabled'
    expect(await repo.list()).toEqual([])
    expect(repo.managedSource?.()).toMatchObject({enabled:false,status:'disabled'})
    state = 'outage'
    expect(await repo.list()).toEqual([])
    expect(repo.managesBundledSource).toBe(true)
    expect(repo.managedSource?.()).toMatchObject({enabled:false})
    expect(bodies).toBe(1)
  })

  it('rejects a reserved source smuggled into the custom list alongside its disabled policy', async () => {
    const source = await publishedSource('builtin-kulao-svip')
    const fetchImpl=vi.fn(async()=>Response.json({revision:1,sources:[source],managedSource:{...source,enabled:false,status:'disabled'}}))
    const repo=createGlobalLxSourceRepository({fetch:fetchImpl as typeof fetch})
    expect(await repo.list()).toEqual([])
    expect(repo.revision()).toBe(-1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

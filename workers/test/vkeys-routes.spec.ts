import { describe, it, expect, vi } from 'vitest'
import { createVkeysHandler as createHandler } from '../providers/vkeysRoutes'
import { deploymentAvailable, readProviderStates, type ProviderEnv } from '../providers/config'
const createVkeysHandler = (env: ProviderEnv, dependencies: Parameters<typeof createHandler>[1] = {}) => createHandler(env, {
  identities: [{trackId:'synthetic-track',neteaseId:'900000001',tencentMid:'SYNTHETICMID01',title:'Synthetic Study Track',titleAliases:[],artists:['Synthetic Artist'],durationSeconds:149}],
  ...dependencies,
})
const origin='https://study.example'
const track='synthetic-track'
const mid='SYNTHETICMID01'
const info={songMID:mid,title:'Synthetic Study Track',singer:'Synthetic Artist',interval:149,pay:'免费',qualityInfo:[{type:6,size:2393516}]}
const env=(flag='true',enabled=1)=>({PUBLIC_ORIGIN:origin,VKEYS_ENABLED:flag,DB:{prepare:()=>({all:async()=>({results:[{providerKey:'vkeys',enabled,priority:50,status:'unknown',updatedAt:0}]})})}} as unknown as ProviderEnv)
const request=(body:unknown={externalId:track},extra:RequestInit={})=>new Request(origin+'/api/providers/vkeys/resolve',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body),...extra})
const allow={limit:async()=>({success:true})}
const fixture=()=>{const entries=new Map<string,Response>();return{match:async(input:RequestInfo|URL)=>entries.get(input instanceof Request?input.url:String(input))?.clone(),put:async(input:RequestInfo|URL,response:Response)=>{entries.set(input instanceof Request?input.url:String(input),response.clone())}}}
const upstream=()=>vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);return Response.json({code:0,data:url.includes('/info?')?info:{songMID:mid,kbps:'128kbps',url:'http://stream.qqmusic.qq.com/sample.mp3?vkey=private-signature'}})}) as unknown as typeof fetch
describe('Vkeys catalogue-bound routes',()=>{
 it('requires both deployment opt-in and administrator enablement',async()=>{const fetch=vi.fn();for(const e of [env('',1),env('true',0)]){expect((await createVkeysHandler(e,{fetch,cache:fixture(),limiter:allow,globalLimiter:allow}).fetch(request())).status).toBe(503)}expect(fetch).not.toHaveBeenCalled();expect(deploymentAvailable('vkeys',env(''))).toBe(false);expect((await readProviderStates(env().DB,env())).find(x=>x.id==='vkeys')?.priority).toBe(50)})
 it('rejects cross-origin, arbitrary metadata and unknown track IDs before upstream',async()=>{const fetch=vi.fn();const h=createVkeysHandler(env(),{fetch,cache:fixture(),limiter:allow,globalLimiter:allow});expect((await h.fetch(request(undefined,{headers:{origin:'https://elsewhere.example','content-type':'application/json'}}))).status).toBe(400);expect((await h.fetch(request({externalId:track,title:'user controlled'}))).status).toBe(400);expect((await h.fetch(request({externalId:'no-such-track'}))).status).toBe(404);expect(fetch).not.toHaveBeenCalled()})
 it('rate limits resolve calls without spending upstream requests',async()=>{const fetch=vi.fn();const response=await createVkeysHandler(env(),{fetch,cache:fixture(),limiter:{limit:async()=>({success:false,retryAfter:45})},globalLimiter:allow}).fetch(request());expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('45');expect(fetch).not.toHaveBeenCalled()})
 it('returns a same-origin nonce and re-resolves on the next request',async()=>{const fetch=upstream();let now=1000000;const cache=fixture();const h=createVkeysHandler(env(),{fetch,cache,now:()=>now,limiter:allow,globalLimiter:allow});const first=await h.fetch(request());expect(first.status).toBe(200);const value=await first.json() as {url:string;mimeType:string};expect(value.mimeType).toBe('audio/mpeg');expect(value.url).toMatch(/^\/api\/providers\/vkeys\/media\/synthetic-track\/[A-Za-z0-9_-]{32}$/);expect(JSON.stringify(value)).not.toContain('private-signature');now+=121000;expect((await h.fetch(new Request(origin+value.url))).status).toBe(410);const second=await h.fetch(request());expect(second.status).toBe(200);expect((await second.json() as {url:string}).url).not.toBe(value.url);expect(fetch).toHaveBeenCalledTimes(4)})
 it('does not issue tickets for mismatched identity or missing cache',async()=>{const fetch=vi.fn(async()=>Response.json({code:0,data:{...info,singer:'Other artist'}}));expect((await createVkeysHandler(env(),{fetch,cache:fixture(),limiter:allow,globalLimiter:allow}).fetch(request())).status).toBe(502);expect(fetch).toHaveBeenCalledTimes(1)})
})

describe('Vkeys resolve expiry contract', () => {
  it.each([
    [undefined, 120_000],
    [60_000, 30_000],
    [300_000, 120_000],
  ])('returns the effective ticket expiry when upstream lifetime is %s', async (lifetime, expectedLifetime) => {
    const now = 1_800_000_000_000
    const mediaUrl = 'https://stream.qqmusic.qq.com/sample.mp3?vkey=private-signature'
      + (lifetime === undefined ? '' : '&expires=' + (now + lifetime) / 1000)
    const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json({
      code: 0,
      data: String(input).includes('/info?') ? info : { songMID: mid, kbps: '128kbps', url: mediaUrl },
    }))
    const cache = fixture()
    const handler = createVkeysHandler(env(), { fetch, cache, now: () => now, limiter: allow, globalLimiter: allow })
    const response = await handler.fetch(request())
    expect(response.status).toBe(200)
    const prepared = await response.json() as { url: string; mimeType: string; expiresAt: number }
    expect(prepared.expiresAt).toBe(now + expectedLifetime)
    const stored = await cache.match(origin + prepared.url)
    expect((await stored!.json() as { expiresAt: number }).expiresAt).toBe(prepared.expiresAt)
    expect(JSON.stringify(prepared)).not.toContain('private-signature')
  })
})

it('public default identities fail closed without contacting the upstream', async () => {
  const fetch = vi.fn()
  const response = await createHandler(env(), { fetch, cache: fixture(), limiter: allow, globalLimiter: allow }).fetch(request())
  expect(response.status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

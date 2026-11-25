import {afterEach,describe,expect,it,vi,type Mock} from 'vitest'
import {createNeteaseArtworkHandler} from '../providers/neteaseArtwork'
import {createProviderHandler} from '../providers/routes'
import type {ProviderEnv} from '../providers/config'

const ORIGIN='https://study.example'
const ID='2155423467'
const PATH=`/api/providers/lx/artwork/${ID}`
const IMAGE='https://p2.music.126.net/exact-id-cover.jpg'
const image=()=>new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpg; charset=UTF-8','content-length':'4'}})
const metadata=(override:unknown={code:200,songs:[{id:Number(ID),album:{picUrl:IMAGE}}]})=>Response.json(override)
const request=(path=PATH,method='GET')=>new Request(ORIGIN+path,{method})
const setup=(fetchImpl:Mock<typeof fetch>=vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(image()),enabled=true)=>({fetchImpl,handle:createNeteaseArtworkHandler({providerId:'lx',publicOrigin:ORIGIN,isEnabled:async()=>enabled,fetch:fetchImpl})})
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
describe('LX artwork exact-ID proxy',()=>{
 it('fetches exact NetEase metadata then a bounded HTTPS thumbnail without other provider credentials',async()=>{
  const {handle,fetchImpl}=setup();const response=await handle(request())
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('image/jpeg')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');expect((await response.arrayBuffer()).byteLength).toBe(4)
  const [metaUrl,metaInit]=fetchImpl.mock.calls[0]!;const meta=new URL(String(metaUrl))
  expect(meta.origin+meta.pathname).toBe('https://music.163.com/api/song/detail/');expect(meta.searchParams.get('id')).toBe(ID);expect(meta.searchParams.get('ids')).toBe(`[${ID}]`)
  const [imageUrl,imageInit]=fetchImpl.mock.calls[1]!;expect(new URL(String(imageUrl)).searchParams.get('param')).toBe('512y512')
  for(const init of [metaInit,imageInit]){expect(init?.redirect).toBe('manual');const headers=new Headers(init?.headers);for(const name of ['authorization','cookie','referer','x-auth-key'])expect(headers.has(name)).toBe(false)}
 })
 it('HEAD validates metadata and image headers without reading an image body',async()=>{
  const {handle,fetchImpl}=setup();const response=await handle(request(PATH,'HEAD'));expect(response.status).toBe(200);expect(await response.text()).toBe('');expect(fetchImpl.mock.calls[1]![1]?.method).toBe('HEAD')
 })
 it('does no upstream work when the LX provider is disabled',async()=>{const {handle,fetchImpl}=setup(undefined,false);const r=await handle(request());expect(r.status).toBe(503);expect(fetchImpl).not.toHaveBeenCalled();expect(r.headers.get('cache-control')).toBe('no-store')})
 it.each(['../1','1/2','1%2f2','abc','1?url=https://evil.example','1?x=1','1#x','123456789012345678901'])('rejects invalid or extra request input %s',async(id)=>{const {handle,fetchImpl}=setup();expect((await handle(request('/api/providers/lx/artwork/'+id))).status).toBe(400);expect(fetchImpl).not.toHaveBeenCalled()})
 it('rejects another request origin and non-read methods',async()=>{const {handle,fetchImpl}=setup();expect((await handle(new Request('https://evil.example'+PATH))).status).toBe(400);expect((await handle(request(PATH,'POST'))).status).toBe(405);expect(fetchImpl).not.toHaveBeenCalled()})
 it.each([
  ['wrong id',{code:200,songs:[{id:123,album:{picUrl:IMAGE}}]},404],
  ['duplicate id',{code:200,songs:[{id:Number(ID),album:{picUrl:IMAGE}},{id:Number(ID),album:{picUrl:IMAGE}}]},502],
  ['no image',{code:200,songs:[{id:Number(ID),album:{}}]},404],
  ['unsafe image',{code:200,songs:[{id:Number(ID),album:{picUrl:'https://evil.example/cover.jpg'}}]},502],
  ['plaintext image',{code:200,songs:[{id:Number(ID),album:{picUrl:'http://p2.music.126.net/cover.jpg'}}]},502],
  ['credential image',{code:200,songs:[{id:Number(ID),album:{picUrl:'https://name:secret@p2.music.126.net/cover.jpg'}}]},502],
 ])('rejects %s without an image fetch',async(_label,payload,status)=>{const {handle,fetchImpl}=setup(vi.fn<typeof fetch>().mockResolvedValue(metadata(payload)));expect((await handle(request())).status).toBe(status);expect(fetchImpl).toHaveBeenCalledTimes(1)})
 it.each(['text/html','image/svg+xml','application/octet-stream','image/jpeg; surprise=1'])('refuses image MIME %s',async mime=>{const {handle}=setup(vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response('not-safe',{headers:{'content-type':mime}})));expect((await handle(request())).status).toBe(502)})
 it.each(['metadata','image'])('never follows %s redirects',async stage=>{const redirect=new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),fetchImpl=stage==='metadata'?vi.fn<typeof fetch>().mockResolvedValue(redirect):vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(redirect);const {handle}=setup(fetchImpl);expect((await handle(request())).status).toBe(502);expect(fetchImpl).toHaveBeenCalledTimes(stage==='metadata'?1:2)})
 it.each(['declared','streamed'])('rejects %s metadata over one MiB',async kind=>{const large=' '.repeat(1024*1024+1);const response=new Response(large,{headers:{'content-type':'application/json',...(kind==='declared'?{'content-length':String(large.length)}:{})}});const {handle,fetchImpl}=setup(vi.fn<typeof fetch>().mockResolvedValue(response));expect((await handle(request())).status).toBe(502);expect(fetchImpl).toHaveBeenCalledTimes(1)})
 it.each(['declared','streamed'])('rejects %s artwork over five MiB',async kind=>{const large=new Uint8Array(5*1024*1024+1),response=new Response(large,{headers:{'content-type':'image/jpeg',...(kind==='declared'?{'content-length':String(large.length)}:{})}});const {handle}=setup(vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(response));expect((await handle(request())).status).toBe(502)})
 it('bounds a stalled artwork request to eight seconds rather than the audio metadata budget',async()=>{
  vi.useFakeTimers();const stalled=vi.fn<typeof fetch>((_url,init)=>new Promise<Response>((_r,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))))
  const {handle}=setup(vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockImplementationOnce(stalled));const pending=handle(request());let settled=false;void pending.then(()=>{settled=true})
  await vi.advanceTimersByTimeAsync(4001);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(4000);expect((await pending).status).toBe(504)
 })
 it('mounts under the existing LX gate with disabled Jellyfin and ChKSz',async()=>{
  const rows=[{providerKey:'lx',enabled:1,priority:20,status:'unknown',updatedAt:0},{providerKey:'jellyfin',enabled:0,priority:30,status:'unknown',updatedAt:0},{providerKey:'chksz',enabled:0,priority:10,status:'unknown',updatedAt:0}]
  const DB={prepare:()=>({all:async()=>({results:rows}),bind:()=>({all:async()=>({results:rows}),first:async()=>null})})}
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(image());const handler=createProviderHandler({PUBLIC_ORIGIN:ORIGIN,DB} as unknown as ProviderEnv,{fetch:fetchImpl})
  expect((await handler.fetch(request())).status).toBe(200);expect(fetchImpl).toHaveBeenCalledTimes(2)
 })
})


describe('LX artwork fixed metadata endpoint MIME contract', () => {
  const exactBody = JSON.stringify({
    code: 200,
    songs: [{ id: Number(ID), album: { picUrl: IMAGE } }],
  })
  const metadataResponse = (mime: string | undefined, body = exactBody) => {
    const response = new Response(body, { headers: mime === undefined ? {} : { 'content-type': mime } })
    if (mime === undefined) response.headers.delete('content-type')
    return response
  }

  it.each([
    'text/plain;charset=UTF-8',
    'text/plain',
    'TEXT/PLAIN; charset=utf-8',
    'application/json',
    'application/json; charset=UTF-8',
    'application/json; charset="UTF-8"',
  ])('accepts exact-ID JSON from the fixed endpoint marked %s', async mime => {
    const upstream = metadataResponse(mime)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(upstream).mockResolvedValueOnce(image())
    const { handle } = setup(fetchImpl)
    const response = await handle(request())
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).origin).toBe('https://music.163.com')
    expect(upstream.bodyUsed).toBe(true)
    expect((await response.arrayBuffer()).byteLength).toBe(4)
  })

  it.each([
    undefined,
    'text/html',
    'text/html; charset=UTF-8',
    'application/octet-stream',
    'application/javascript',
    'application/problem+json',
    'text/plain; boundary=unsafe',
    'text/plain; charset=utf 8',
    'text/plain; charset="UTF-8',
    'text/plain; charset=UTF-8; boundary=unsafe',
    'application/json; boundary=unsafe',
    'application/json, text/plain',
  ])('rejects metadata MIME %s even when its body is valid JSON', async mime => {
    const { handle, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValueOnce(metadataResponse(mime)))
    const response = await handle(request())
    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['text/plain;charset=UTF-8', '{"code":200,"songs":'],
    ['text/plain;charset=UTF-8', '<html>upstream failure</html>'],
    ['application/json', '{"code":200,"songs":'],
  ])('rejects malformed metadata body with %s', async (mime, body) => {
    const { handle, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValueOnce(metadataResponse(mime, body)))
    expect((await handle(request())).status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['declared', 'streamed'])('keeps the one-MiB bound for %s plain metadata', async kind => {
    const oversized = JSON.stringify({ ...JSON.parse(exactBody), padding: 'x'.repeat(1024 * 1024) })
    const upstream = new Response(oversized, {
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        ...(kind === 'declared' ? { 'content-length': String(oversized.length) } : {}),
      },
    })
    const { handle, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValueOnce(upstream))
    expect((await handle(request())).status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})


describe('independent GD Studio artwork gate', () => {
  it.each([true, false])('uses only the GD Studio effective gate when enabled=%s', async (enabled) => {
    const rows = [
      { providerKey: 'gd-studio', enabled: enabled ? 1 : 0, priority: 40, status: 'unknown', updatedAt: 0 },
      { providerKey: 'lx', enabled: 0, priority: 20, status: 'unknown', updatedAt: 0 },
      { providerKey: 'jellyfin', enabled: 0, priority: 30, status: 'unknown', updatedAt: 0 },
    ]
    const DB = { prepare: () => ({ all: async () => ({ results: rows }), bind: () => ({ first: async () => null }) }) }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(image())
    const handler = createProviderHandler({
      PUBLIC_ORIGIN: ORIGIN, DB,
      GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
      GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net,m801.music.126.net',
    } as unknown as ProviderEnv, { fetch: fetchImpl })
    const response = await handler.fetch(request('/api/providers/gd-studio/artwork/' + ID))
    expect(response.status).toBe(enabled ? 200 : 503)
    expect(fetchImpl).toHaveBeenCalledTimes(enabled ? 2 : 0)
  })
})

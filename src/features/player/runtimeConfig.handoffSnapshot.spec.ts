import { describe, expect, it, vi } from 'vitest'
import { createRuntimeProviderRepository } from './runtimeConfig'

const endpoint = new URL('/api/providers/config', window.location.origin).toString()
function response() {
  const r = Response.json({version:1,providers:[{id:'gd-studio',available:true,enabled:true,automaticEligible:true,priority:1}]})
  Object.defineProperty(r,'url',{value:endpoint})
  return r
}
function setup() {
  let now=1000, preferences=0, credentials=0
  const fetcher=vi.fn(async()=>response())
  const repository=createRuntimeProviderRepository({fetch:fetcher,now:()=>now,
    providerPreferences:{isDisabled:()=>false,revision:()=>preferences},
    chkszCredentials:{key:()=>null,revision:()=>credentials},
  })
  return {repository,fetcher,time:(v:number)=>{now=v},preferences:()=>{preferences++},credentials:()=>{credentials++}}
}
describe('synchronous handoff registry snapshot',()=>{
  it('returns only the current successful cached registry without starting a request',async()=>{
    const {repository,fetcher}=setup();expect(repository.peek?.()).toBeUndefined()
    const registry=await repository.load();const calls=fetcher.mock.calls.length
    expect(repository.peek?.()).toBe(registry);expect(fetcher).toHaveBeenCalledTimes(calls)
  })
  it('refuses expired cached configuration without silently refreshing it',async()=>{
    const s=setup();await s.repository.load();expect(s.repository.peek?.()).toBeDefined()
    s.time(6000);const calls=s.fetcher.mock.calls.length
    expect(s.repository.peek?.()).toBeUndefined();expect(s.fetcher).toHaveBeenCalledTimes(calls)
  })
  it.each(['preferences','credentials'] as const)('refuses a cached source after %s changed',async key=>{
    const s=setup();await s.repository.load();expect(s.repository.peek?.()).toBeDefined()
    s[key]();expect(s.repository.peek?.()).toBeUndefined()
  })
  it('refuses a snapshot while an explicit refresh is pending',async()=>{
    const s=setup();await s.repository.load();expect(s.repository.peek?.()).toBeDefined()
    let finish!:(r:Response)=>void
    s.fetcher.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
    const pending=s.repository.load({forceRefresh:true})
    expect(s.repository.peek?.()).toBeUndefined()
    finish(response());const refreshed=await pending
    expect(s.repository.peek?.()).toBe(refreshed)
  })
  it('does not expose a failed configuration fetch as a usable snapshot',async()=>{
    const s=setup();s.fetcher.mockResolvedValueOnce(new Response('',{status:503}))
    await s.repository.load();expect(s.repository.peek?.()).toBeUndefined()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/preferences', () => ({ usePreferences: () => ({ locale: ref('en') }) }))
vi.mock('../player/lx/probeScript', () => ({probeLxScript:async()=>({ok:true,platforms:['wy']})}))
import LxGlobalSourceManager from './LxGlobalSourceManager.vue'
import type { AdminLxSource, AdminRepository } from './client'

const managedSource = (): AdminLxSource => ({
  id:'builtin-kulao-svip', managed:true, name:'Kulao', version:'1.0.0', originKind:'url',
  originUrl:'https://example.com/kulao.js', sha256:'a'.repeat(64), enabled:true,priority:10,
  status:'active',requiredOrigins:[],pendingOrigins:[],createdAt:0,updatedAt:0,
  lastCheckedAt:null,lastCheckNote:null,snapshots:[],
})

describe('administrator-published source controls', () => {
  it('discards a preview response that arrives after the input changed',async()=>{
    let resolve!: (value:unknown)=>void
    const repository={listLxSources:async()=>({revision:2,sources:[]}),previewLxSource:()=>new Promise(done=>{resolve=done})} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository}})
    await flushPromises()
    await wrapper.get('[data-lx-source-url]').setValue('https://example.com/first.js')
    await wrapper.get('[data-lx-source-preview]').trigger('click')
    await wrapper.get('[data-lx-source-url]').setValue('https://example.com/second.js')
    resolve({sha256:'a'.repeat(64),script:'old',credentialKeys:['token'],requiredOrigins:[],headerOrigins:[]})
    await flushPromises()
    expect(wrapper.find('[data-lx-source-disclosure-confirm]').exists()).toBe(false)
    expect(wrapper.find('[data-lx-source-preview-result]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('requires a separate digest-bound modal confirmation for updates and stored snapshot rollback',async()=>{
    const source={...managedSource(),snapshots:[
      {sha256:'a'.repeat(64),version:'1',createdAt:0,note:null,active:true},
      {sha256:'c'.repeat(64),version:'old',createdAt:0,note:null,active:false,credentialKeys:['token']},
    ]}
    const adoptLxSource=vi.fn(async()=>source)
    const repository={listLxSources:async()=>({revision:2,sources:[source]}),adoptLxSource,
      checkLxSourceUpdate:async()=>({hasUpdate:true,candidateSha256:'b'.repeat(64),candidateScript:'candidate',credentialKeys:['token']})} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository},attachTo:document.body})
    await flushPromises()
    await wrapper.get('[data-lx-source-check-update]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-lx-source-adopt]').trigger('click')
    expect(adoptLxSource).not.toHaveBeenCalled()
    await wrapper.get('[data-lx-disclosure-confirm]').trigger('click')
    await flushPromises()
    expect(adoptLxSource).toHaveBeenLastCalledWith(source.id,'b'.repeat(64),'candidate','b'.repeat(64))
    await wrapper.get('[data-lx-source-snapshots-toggle]').trigger('click')
    await wrapper.get('[data-lx-source-rollback]').trigger('click')
    expect(adoptLxSource).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-lx-disclosure-confirm]').trigger('click')
    await flushPromises()
    expect(adoptLxSource).toHaveBeenLastCalledWith(source.id,'c'.repeat(64),undefined,'c'.repeat(64))
    wrapper.unmount()
  })
  it('requires digest-bound disclosure consent and clears it when the source changes', async()=>{
    const previewLxSource=vi.fn(async()=>({sha256:'b'.repeat(64),script:'candidate',credentialKeys:['token'],requiredOrigins:[],headerOrigins:[],name:'Candidate',version:null,byteLength:9}))
    const createLxSource=vi.fn(async()=>managedSource())
    const repository={listLxSources:async()=>({revision:2,sources:[]}),previewLxSource,createLxSource} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository}})
    await flushPromises()
    await wrapper.get('[data-lx-source-url]').setValue('https://example.com/first.js')
    await wrapper.get('[data-lx-source-preview]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-lx-source-disclosure]').text()).toContain('token')
    expect((wrapper.get('[data-lx-source-add]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('[data-lx-source-disclosure-confirm]').setValue(true)
    await wrapper.get('[data-lx-source-add]').trigger('click')
    await flushPromises()
    expect(createLxSource).toHaveBeenCalledWith({url:'https://example.com/first.js',credentialDisclosureSha256:'b'.repeat(64)})
    await wrapper.get('[data-lx-source-url]').setValue('https://example.com/second.js')
    await wrapper.get('[data-lx-source-preview]').trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-lx-source-disclosure-confirm]').element as HTMLInputElement).checked).toBe(false)
    await wrapper.get('[data-lx-source-disclosure-confirm]').setValue(true)
    await wrapper.get('[data-lx-source-url]').setValue('https://example.com/changed.js')
    expect(wrapper.find('[data-lx-source-disclosure-confirm]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('explains HTTP branches and unsupported IP APIs instead of suggesting an IP allow-list', async()=>{
    const source={...managedSource(),status:'pending_network_approval',requiredOrigins:['https://103.79.184.97'],pendingOrigins:['https://103.79.184.97'],plaintextOrigins:['http://nmobi.kuwo.cn']}
    const repository={listLxSources:async()=>({revision:2,sources:[source]})} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository}})
    await flushPromises()
    expect(wrapper.get('[data-lx-source-ip-warning]').text()).toContain('working HTTPS domain')
    expect(wrapper.get('[data-lx-source-plaintext-warning]').text()).toContain('remain blocked')
    wrapper.unmount()
  })
  it('lets the Owner rename and disable Kulao while retaining its revocation policy',async()=>{
    let source=managedSource()
    const updateLxSource=vi.fn(async(_id:string,patch:Partial<AdminLxSource>)=>{source={...source,...patch};return source})
    const deleteLxSource=vi.fn()
    const repository={listLxSources:async()=>({revision:2,sources:[source]}),updateLxSource,deleteLxSource} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository}})
    await flushPromises()
    expect(wrapper.text()).toContain('Admin-published')
    expect(wrapper.find('[data-lx-source-delete]').exists()).toBe(true)
    await wrapper.get('[data-lx-source-edit-name]').trigger('click')
    await wrapper.get('[data-lx-source-name-input]').setValue('Owner Kulao')
    await wrapper.get('form[data-lx-source-name-form]').trigger('submit')
    await flushPromises()
    expect(updateLxSource).toHaveBeenCalledWith(source.id,{name:'Owner Kulao'})
    expect(wrapper.text()).toContain('Owner Kulao')
    await wrapper.get('[data-lx-source-enabled]').setValue(false)
    await flushPromises()
    expect(updateLxSource).toHaveBeenLastCalledWith(source.id,{enabled:false})
    expect(deleteLxSource).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('lets the Owner confirm deletion of the release-provided source', async()=>{
    let sources=[managedSource()]
    const deleteLxSource=vi.fn(async()=>{sources=[];return 3})
    const repository={listLxSources:async()=>({revision:2,sources}),deleteLxSource} as unknown as AdminRepository
    const wrapper=mount(LxGlobalSourceManager,{props:{repository},attachTo:document.body})
    await flushPromises()
    await wrapper.get('[data-lx-source-delete]').trigger('click')
    await flushPromises()
    const confirm=document.querySelector('[data-lx-source-delete-confirm]') as HTMLButtonElement
    expect(confirm).not.toBeNull()
    confirm.click()
    await flushPromises()
    expect(deleteLxSource).toHaveBeenCalledWith('builtin-kulao-svip')
    expect(wrapper.find('[data-lx-source-id="builtin-kulao-svip"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

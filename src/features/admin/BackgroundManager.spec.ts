import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { createAdminRepository, type AdminBackground } from './client'
import BackgroundManager from './BackgroundManager.vue'

const item = (status: AdminBackground['status'] = 'draft'): AdminBackground => ({
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  status,
  kind: 'image',
  contentType: 'image/png',
  byteSize: 33,
  width: 1920,
  height: 1080,
  durationMs: null,
  mediaUrl: '/api/admin/backgrounds/11111111-1111-4111-8111-111111111111/media',
  posterUrl: null,
  rightsStatus: 'not-reviewed',
  createdAt: 1,
  updatedAt: 1,
  publishedAt: status === 'published' ? 2 : null,
  archivedAt: status === 'archived' ? 3 : null,
})

describe('BackgroundManager', () => {
  it.each([
    [true, 'published', false],
    [true, 'tombstoned', false],
    [true, 'archived', false],
    [false, 'draft', true],
    [false, 'published', true],
    [false, 'archived', false],
  ] as const)('offers media replacement for shipped=%s status=%s: %s', async (isShipped, status, visible) => {
    const repo = createAdminRepository()
    // The shipped catalogue also returns tombstones, although the shared
    // uploaded-background status type currently has only its three states.
    const background = { ...item(), isShipped, status } as AdminBackground
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([background])
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()

    expect(wrapper.find('[data-background-id] .background-manager__replace input[type="file"]').exists()).toBe(visible)
    wrapper.unmount()
  })

  it.each(['draft', 'published'] as const)('replaces uploaded %s media through the existing repository flow', async (status) => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([{ ...item(status), isShipped: false }])
    const replace = vi.spyOn(repo, 'replaceBackground').mockResolvedValue(item(status))
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()
    const input = wrapper.get('.background-manager__replace input[type="file"]')
    const file = new File([new Uint8Array([1, 2, 3])], 'replacement.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()

    expect(replace).toHaveBeenCalledWith(item().id, file)
    expect(wrapper.find('[data-background-id]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ends cancellable compression before sending an upload mutation', async () => {
    const repo=createAdminRepository();vi.spyOn(repo,'listBackgrounds').mockResolvedValue([])
    let finish!: (value:AdminBackground)=>void
    vi.spyOn(repo,'uploadBackground').mockImplementation((_file,options)=>{options?.onProgress?.(0.8);options?.onStage?.('uploading');return new Promise(resolve=>{finish=resolve})})
    const wrapper=mount(BackgroundManager,{props:{repository:repo}});await flushPromises()
    const input=wrapper.get('[data-background-upload]');Object.defineProperty(input.element,'files',{value:[new File(['video'],'scene.mp4',{type:'video/mp4'})]})
    await input.trigger('change');await flushPromises()
    expect(wrapper.find('[data-background-conversion]').exists()).toBe(false)
    expect(input.attributes('disabled')).toBeDefined()
    finish(item());await flushPromises();wrapper.unmount()
  })
  it('shows video conversion progress, prevents concurrent uploads and supports cancellation', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo,'listBackgrounds').mockResolvedValue([])
    let rejectUpload!: (error: Error) => void
    const upload = vi.spyOn(repo,'uploadBackground').mockImplementation((_file, options) => {
      options?.onProgress?.(0.5)
      return new Promise((_resolve,reject) => { rejectUpload=reject })
    })
    const wrapper=mount(BackgroundManager,{props:{repository:repo}})
    await flushPromises()
    const input=wrapper.get('[data-background-upload]')
    Object.defineProperty(input.element,'files',{value:[new File(['video'],'scene.mp4',{type:'video/mp4'})]})
    await input.trigger('change');await flushPromises()
    expect(wrapper.get('progress').attributes('value')).toBe('50')
    await input.trigger('change')
    expect(upload).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-background-conversion] button').trigger('click')
    expect(upload.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    rejectUpload(new Error('video_conversion_cancelled'));await flushPromises()
    expect(wrapper.find('progress').exists()).toBe(false)
    wrapper.unmount()
  })
  it('renders a truthful empty state and current video validation boundary', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()
    expect(wrapper.find('[data-background-empty]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No background media')
    expect(wrapper.text()).toContain('1080p')
    expect(wrapper.find('[data-background-upload]').attributes('accept')).toContain('video/mp4')
  })

  it('uploads an image draft and refreshes the list', async () => {
    const repo = createAdminRepository()
    const list = vi.spyOn(repo, 'listBackgrounds')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item()])
    const upload = vi.spyOn(repo, 'uploadBackground').mockResolvedValue(item())
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()
    const input = wrapper.find('[data-background-upload]')
    const file = new File([new Uint8Array([1, 2, 3])], 'scene.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(upload).toHaveBeenCalledWith(file)
    expect(list).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-background-id]').attributes('data-background-status')).toBe('draft')
  })

  it('offers only valid lifecycle actions and confirms permanent purge', async () => {
    const repo = createAdminRepository()
    const list = vi.spyOn(repo, 'listBackgrounds')
    list.mockResolvedValueOnce([item('archived')]).mockResolvedValueOnce([])
    const purge = vi.spyOn(repo, 'purgeBackground').mockResolvedValue(undefined)
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()
    expect(wrapper.find('[data-background-restore]').exists()).toBe(true)
    expect(wrapper.find('[data-background-publish]').exists()).toBe(false)
    expect(wrapper.find('[data-background-archive]').exists()).toBe(false)
    await wrapper.find('[data-background-purge]').trigger('click')
    expect(wrapper.find('[data-background-purge-confirm]').exists()).toBe(true)
    expect(purge).not.toHaveBeenCalled()
    await wrapper.find('[data-background-purge-confirm]').trigger('click')
    await flushPromises()
    expect(purge).toHaveBeenCalledWith(item().id)
  })

  it('publishes drafts and archives published media through the repository', async () => {
    const repo = createAdminRepository()
    const list = vi.spyOn(repo, 'listBackgrounds')
    list.mockResolvedValueOnce([item('draft')]).mockResolvedValueOnce([item('published')]).mockResolvedValueOnce([item('archived')])
    vi.spyOn(repo, 'publishBackground').mockResolvedValue(item('published'))
    vi.spyOn(repo, 'archiveBackground').mockResolvedValue(item('archived'))
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()
    await wrapper.find('[data-background-publish]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-background-archive]').exists()).toBe(true)
    await wrapper.find('[data-background-archive]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-background-restore]').exists()).toBe(true)
  })

  it('prevents duplicate destructive purge submissions while awaiting server', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([item('archived')])
    let resolvePurge!: () => void
    const purgePromise = new Promise<void>((resolve) => {
      resolvePurge = resolve
    })
    const purgeSpy = vi.spyOn(repo, 'purgeBackground').mockImplementation(() => purgePromise)

    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()

    await wrapper.find('[data-background-purge]').trigger('click')
    expect(wrapper.find('[data-background-purge-confirm]').exists()).toBe(true)

    // First confirm click starts the async purge
    await wrapper.find('[data-background-purge-confirm]').trigger('click')

    // Confirm button must now be disabled while loading
    expect(wrapper.find('[data-background-purge-confirm]').attributes('disabled')).toBeDefined()

    // Repeated confirm trigger attempt (e.g. click or form submission) while loading
    await wrapper.find('[data-background-purge-confirm]').trigger('click')
    const form = wrapper.find('[data-background-purge-dialog] form')
    if (form.exists()) {
      await form.trigger('submit')
    }

    // Repository must have been called exactly ONCE
    expect(purgeSpy).toHaveBeenCalledTimes(1)

    // Resolve deferred promise
    resolvePurge()
    await flushPromises()

    // Dialog closes and success message is displayed
    expect(wrapper.find('[data-background-purge-confirm]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Background permanently purged.')
  })

  it('describes the real video pipeline and never claims video upload is unavailable', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()

    const boundary = wrapper.get('[data-background-video-boundary]').text()
    // The Worker accepts video through the multipart transcode contract, so the
    // guidance has to describe that path rather than deny it exists.
    expect(boundary).toMatch(/converted in this browser/i)
    expect(boundary).toMatch(/server re-validates/i)
    expect(boundary).toMatch(/WebCodecs/i)
    expect(boundary).not.toMatch(/unavailable|not available|disabled/i)
    // The picker keeps offering video because the pipeline supports it.
    expect(wrapper.get('[data-background-upload]').attributes('accept')).toContain('video/mp4')
    wrapper.unmount()
  })

  it('names an unconfigured media store instead of reporting a generic upload failure', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
    vi.spyOn(repo, 'uploadBackground').mockRejectedValue(new Error('admin_503'))
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()

    const input = wrapper.find('[data-background-upload]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1, 2, 3])], 'scene.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('no background media store configured')
    expect(wrapper.text()).not.toContain('Upload failed. Existing backgrounds are unchanged.')
    wrapper.unmount()
  })

  it('reports an unsupported media type precisely rather than as a generic failure', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
    vi.spyOn(repo, 'uploadBackground').mockRejectedValue(new Error('admin_415'))
    const wrapper = mount(BackgroundManager, { props: { repository: repo } })
    await flushPromises()

    const input = wrapper.find('[data-background-upload]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1, 2, 3])], 'scene.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('That file type is not accepted')
    wrapper.unmount()
  })
})

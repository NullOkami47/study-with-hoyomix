import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { createBackgroundStore } from './store'
import type { BackgroundRepository, PublicBackground } from './types'
import BackgroundGallery from './BackgroundGallery.vue'

const item = (id: string): PublicBackground => ({
  id,
  revision: 1,
  status: 'published',
  kind: 'image',
  contentType: 'image/png',
  byteSize: 33,
  width: 1920,
  height: 1080,
  durationMs: null,
  mediaUrl: `/api/backgrounds/${id}/media`,
  posterUrl: null,
  rightsStatus: 'not-reviewed',
  createdAt: 1,
  updatedAt: 1,
  publishedAt: 1,
  archivedAt: null,
})

const curated = (id: string, collection: string): PublicBackground => ({
  ...item(id),
  title: `Synthetic scene ${collection}`,
  kind: 'video',
  contentType: 'video/mp4',
  durationMs: 20_000,
  posterUrl: `/backgrounds/zzz/${collection}/posters/${id}.jpg`,
  mediaUrl: `/backgrounds/zzz/${collection}/${id}.mp4`,
  game: 'zzz',
  collection,
  fps: 24,
})

const storage = () => ({ getItem: () => null, setItem: vi.fn() })

describe('BackgroundGallery', () => {
  it('offers a saved 1440p switch with 1080p as the default', async () => {
    const store = createBackgroundStore({ storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()
    const quality = wrapper.get('[data-background-quality]')
    expect(quality.attributes('role')).toBe('switch')
    expect((quality.element as HTMLInputElement).checked).toBe(false)
    await quality.setValue(true)
    expect(store.qualityMode.value).toBe('1440p')
    await quality.setValue(false)
    expect(store.qualityMode.value).toBe('auto')
    store.destroy()
  })
  it('omits the obsolete source-review badge', async () => {
    const store = createBackgroundStore({ repository: { list: async () => [item('a')], getAccountSelection: async () => null, saveAccountSelection: async s => s }, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'zh-Hant', signedIn: false } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('來源尚未審核')
    wrapper.unmount(); store.destroy()
  })
  it('explains the two playback versions without offering an uncapped native override', async () => {
    const store = createBackgroundStore({ repository: { list: async () => [item('a')], getAccountSelection: async () => null, saveAccountSelection: async s => s }, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'zh-Hant', signedIn: false } })
    await flushPromises()
    expect((wrapper.get('[data-background-quality]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('1080p')
    expect(wrapper.text()).toContain('1440p')
    wrapper.unmount(); store.destroy()
  })
  it('keeps the default-quality note but drops the fallback explanation in every locale', async () => {
    const repo: BackgroundRepository = {
      list: async () => [item('a')],
      getAccountSelection: async () => null,
      saveAccountSelection: async s => s,
    }
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const store = createBackgroundStore({ repository: repo, storage: storage() })
      const wrapper = mount(BackgroundGallery, { props: { store, locale, signedIn: false } })
      await flushPromises()
      const note = wrapper.get('.background-gallery__quality-note').text()
      // Retained: default 1080p, the 30 fps cap, and the optional 1440p mode.
      expect(note).toContain('1080p')
      expect(note).toContain('1440p')
      expect(note).toMatch(/30 fps/)
      // Removed: the upscaling / frame-drop fallback explanation.
      expect(note).not.toMatch(/upscaled/i)
      expect(note).not.toMatch(/放大/)
      expect(note).not.toMatch(/fall back/i)
      expect(note).not.toMatch(/退回/)
      expect(note).not.toMatch(/frame drops/i)
      expect(note).not.toMatch(/丟幀|丢帧/)
      wrapper.unmount(); store.destroy()
    }
  })
  it('loads published choices and persists selection, auto-rotate, and interval controls', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([item('a'), item('b')]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()
    expect(wrapper.findAll('[data-background-choice]')).toHaveLength(2)
    // First-use defaults: Random order, twenty minutes, four minute-long choices.
    expect((wrapper.find('[data-background-playback-mode]').element as HTMLSelectElement).value).toBe('random')
    const intervalSelect = wrapper.find('[data-background-interval]').element as HTMLSelectElement
    expect([...intervalSelect.options].map((option) => option.value)).toEqual(['600', '1200', '1800', '3600'])
    expect(intervalSelect.value).toBe('1200')
    await wrapper.find('[data-background-choice="a"] input').setValue(true)
    await wrapper.find('[data-background-choice="b"] input').setValue(true)
    await wrapper.find('[data-background-interval]').setValue('1800')
    await wrapper.find('[data-background-auto-rotate]').setValue(false)
    expect(store.selection.value).toEqual({ selectedIds: ['a', 'b'], autoRotate: false, intervalSeconds: 1_800 })
    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)
    store.destroy()
  })

  it('describes automatic account sync without a manual action', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([item('a')]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    store.toggle('a', true)
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: true } })
    await flushPromises()
    await wrapper.find('[data-background-choice="a"] input').setValue(true)
    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)
    await flushPromises()
    expect(repo.saveAccountSelection).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('synchronise automatically')
    store.destroy()
  })

  it('keeps the current selection when the public API is unavailable', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockRejectedValue(new Error('offline')),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()
    expect(wrapper.find('[data-background-unavailable]').exists()).toBe(true)
    expect(wrapper.text()).toContain('current background remains selected')
    store.destroy()
  })

  it('waits for published backgrounds before syncing without erasing local or remote choices', async () => {
    let resolveList!: (items: PublicBackground[]) => void
    const repo: BackgroundRepository = {
      list: vi.fn(() => new Promise<PublicBackground[]>((resolve) => { resolveList = resolve })),
      getAccountSelection: vi.fn().mockResolvedValue({
        selectedIds: ['remote'], autoRotate: true, intervalSeconds: 30,
      }),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const localStorage = {
      getItem: () => JSON.stringify({ selectedIds: ['local'], autoRotate: true, intervalSeconds: 30 }),
      setItem: vi.fn(),
    }
    const store = createBackgroundStore({ repository: repo, storage: localStorage })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: true } })

    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)
    const sync = store.pullAuthenticated()
    expect(repo.saveAccountSelection).not.toHaveBeenCalled()

    resolveList([item('local'), item('remote')])
    await sync
    await flushPromises()

    expect(repo.saveAccountSelection).not.toHaveBeenCalled()
    expect(await sync).toEqual({ selectedIds: ['remote'], autoRotate: true, intervalSeconds: 30 })
    expect(store.selection.value.selectedIds).toEqual(['local'])
    store.destroy()
  })

  it('groups curated backgrounds under localised headings and offers a playback order', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([
        curated('zzz-urban-stroll-anby-billy', 'urban-stroll'),
        curated('zzz-belle-lofi-girl', 'lofi-girl'),
        item('api-image'),
      ]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'zh-Hans', signedIn: false } })
    await flushPromises()

    expect(wrapper.findAll('[data-background-choice]')).toHaveLength(3)
    expect(wrapper.findAll('[data-background-group]')).toHaveLength(1)
    expect(wrapper.findAll('[data-background-collection]')).toHaveLength(2)
    expect(wrapper.text()).toContain('绝区零')
    expect(wrapper.text()).toContain('城市漫步')
    expect(wrapper.text()).toContain('Synthetic scene urban-stroll')
    expect(wrapper.text()).toContain('Synthetic scene lofi-girl')
    // API rows without a curated title still get a translated label.
    expect(wrapper.text()).toContain('已发布背景')

    await wrapper.find('[data-background-playback-mode]').setValue('random')
    expect(store.playbackMode.value).toBe('random')
    expect((wrapper.find('[data-background-playback-mode]').element as HTMLSelectElement).value).toBe('random')
    store.destroy()
  })

  it('shows a group heading for an administrator-created collection that has no curated label', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([
        { ...item('custom-group-1'), game: 'genshin', collection: 'cyberpunk-study' },
      ]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()

    expect(wrapper.findAll('[data-background-choice]')).toHaveLength(1)
    // Without a curated translation the stored group name is still shown, so an
    // administrator never ends up with an unlabelled cluster in the gallery.
    expect(wrapper.find('[data-background-group]').text()).toBe('Genshin')
    expect(wrapper.find('[data-background-collection]').text()).toBe('Cyberpunk Study')
    store.destroy()
  })

  it('orders a group by the display order the public API carries, not by response order', async () => {
    const repo: BackgroundRepository = {
      // Deliberately reverse-alphabetical so only `displayOrder` can produce
      // the expected result: the API does not promise a sorted payload.
      list: vi.fn().mockResolvedValue([
        { ...item('zzz-later'), game: 'genshin', collection: 'study-room', displayOrder: 9, title: 'Later' },
        { ...item('aaa-earlier'), game: 'genshin', collection: 'study-room', displayOrder: 1, title: 'Earlier' },
      ]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()

    expect(wrapper.findAll('[data-background-choice]').map((entry) => entry.attributes('data-background-choice')))
      .toEqual(['aaa-earlier', 'zzz-later'])
    expect(wrapper.find('[data-background-group]').text()).toBe('Genshin')
    expect(wrapper.find('[data-background-collection]').text()).toBe('Study Room')
    store.destroy()
  })

  it('orders administrator-created groups by the earliest display order inside them', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([
        { ...item('b-1'), game: 'hsr', collection: 'dreamscape', displayOrder: 5 },
        { ...item('a-1'), game: 'genshin', collection: 'study-room', displayOrder: 2 },
      ]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const store = createBackgroundStore({ repository: repo, storage: storage() })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()

    expect(wrapper.findAll('[data-background-group]').map((entry) => entry.text())).toEqual(['Genshin', 'Hsr'])
    store.destroy()
  })

  it('shows an older stored interval as an extra choice and replaces it with a canonical one', async () => {
    const repo: BackgroundRepository = {
      list: vi.fn().mockResolvedValue([item('a')]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    }
    const localStorage = {
      getItem: (key: string) => key === 'study-with-hoyomix.background-selection'
        ? JSON.stringify({ selectedIds: ['a'], autoRotate: true, intervalSeconds: 300 })
        : null,
      setItem: vi.fn(),
    }
    const store = createBackgroundStore({ repository: repo, storage: localStorage })
    const wrapper = mount(BackgroundGallery, { props: { store, locale: 'en', signedIn: false } })
    await flushPromises()

    const intervalSelect = wrapper.find('[data-background-interval]').element as HTMLSelectElement
    expect(intervalSelect.value).toBe('300')
    expect([...intervalSelect.options].map((option) => option.value)).toEqual(['600', '1200', '1800', '3600', '300'])
    // 300s has always been "5 minutes", and anything of a minute or longer is
    // still described in minutes.
    expect(intervalSelect.options[4].text).toBe('5 minutes')
    expect(intervalSelect.options[0].text).toBe('10 minutes')

    await wrapper.find('[data-background-interval]').setValue('1200')
    expect(store.selection.value.intervalSeconds).toBe(1_200)
    store.destroy()
  })
})

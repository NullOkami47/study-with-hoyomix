import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogueTrackBrowser from './CatalogueTrackBrowser.vue'
import { createAdminRepository, type AdminCatalogueTrack, type AdminCatalogueTrackDetail } from './client'
import { usePreferences } from '../../stores/preferences'

const track = (id: string, overrides: Partial<AdminCatalogueTrack> = {}): AdminCatalogueTrack => ({
  id,
  title: `Title ${id}`,
  album: 'Album A',
  releaseDate: '2024-01-01',
  workGroupId: `work-${id}`,
  vocalStatus: 'instrumental',
  tabs: ['focus'],
  games: ['genshin'],
  needsClassification: false,
  updatedAt: 1,
  ...overrides,
})

const detailOf = (value: AdminCatalogueTrack): AdminCatalogueTrackDetail => ({
  ...value,
  metadataConfidence: 1,
  evidence: null,
  notes: null,
  relations: [],
  aliases: {},
  sources: [
    {
      sourceRowId: `src-${value.id}`,
      provider: 'jellyfin',
      externalId: 'a'.repeat(32),
      sourceType: 'stream',
      sourceStatus: 'active',
      rightsStatus: 'owner-authorised',
      evidence: null,
      notes: null,
    },
  ],
})

const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => {
  usePreferences().setLocale('en')
})
afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers.length = 0
})

function setup(tracks: AdminCatalogueTrack[]) {
  const repo = createAdminRepository()
  const list = vi.spyOn(repo, 'listCatalogueTracks').mockResolvedValue({
    revision: 7,
    albums: [...new Set(tracks.map((t) => t.album).filter((a): a is string => !!a))].sort(),
    tracks,
  })
  const get = vi
    .spyOn(repo, 'getCatalogueTrack')
    .mockImplementation(async (id) => detailOf(tracks.find((t) => t.id === id)!))
  const update = vi.spyOn(repo, 'updateCatalogueTrack').mockImplementation(async (id, changes) => {
    const current = tracks.find((t) => t.id === id)!
    const next: AdminCatalogueTrack = {
      ...current,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.vocal_status !== undefined ? { vocalStatus: changes.vocal_status } : {}),
      ...(changes.focus !== undefined
        ? { tabs: changes.focus ? [...new Set([...current.tabs, 'focus' as const])] : current.tabs.filter((t) => t !== 'focus') }
        : {}),
    }
    return { revision: 8, track: detailOf(next) }
  })
  const wrapper = mount(CatalogueTrackBrowser, { props: { repository: repo }, attachTo: document.body })
  wrappers.push(wrapper)
  return { repo, wrapper, list, get, update }
}

describe('CatalogueTrackBrowser', () => {
  it('loads the catalogue once and filters client-side without refetching', async () => {
    const { wrapper, list } = setup([
      track('genshin-la-vaguelette', { title: 'La vaguelette' }),
      track('hsr-hope-is-the-thing-with-feathers', { title: 'Hope Is the Thing With Feathers', games: ['hsr'] }),
      track('zzz-tiny-giant', { title: 'Tiny Giant', games: ['zzz'] }),
    ])
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(3)

    const search = wrapper.get('[data-catalogue-track-search]')
    await search.setValue('vaguelette')
    await flushPromises()
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(1)
    expect(wrapper.get('[data-catalogue-track-row]').attributes('data-catalogue-track-row')).toBe(
      'genshin-la-vaguelette',
    )

    // Typing is pure client-side: the index is never re-fetched.
    await search.setValue('hope')
    await flushPromises()
    await search.setValue('')
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(3)
  })

  it('filters by game and album and bounds the rendered page', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      track(`track-${String(index).padStart(3, '0')}`, { album: index < 10 ? 'Album A' : 'Album B' }),
    )
    const { wrapper } = setup(many)
    await flushPromises()
    // Bounded rendering: only one page of rows exists in the DOM at a time.
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(25)
    expect(wrapper.get('[data-catalogue-track-page]').text()).toContain('1 / 2')

    await wrapper.get('[data-catalogue-track-next]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(5)

    await wrapper.get('[data-catalogue-track-prev]').trigger('click')
    await wrapper.get('[data-catalogue-track-album]').setValue('Album B')
    await flushPromises()
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(20)
    expect(wrapper.get('[data-catalogue-track-page]').text()).toContain('1 / 1')

    await wrapper.get('[data-catalogue-track-album]').setValue('all')
    await wrapper.get('[data-catalogue-track-game]').setValue('zzz')
    await flushPromises()
    expect(wrapper.findAll('[data-catalogue-track-row]')).toHaveLength(0)
    expect(wrapper.find('[data-catalogue-track-empty]').exists()).toBe(true)
  })

  it('shows the current catalogue state for the selected track', async () => {
    const { wrapper, get } = setup([track('zzz-tiny-giant', { title: 'Tiny Giant', tabs: ['chill'] })])
    await flushPromises()
    await wrapper.get('[data-catalogue-track-row]').trigger('click')
    await flushPromises()
    expect(get).toHaveBeenCalledWith('zzz-tiny-giant')
    const detail = wrapper.get('[data-catalogue-track-detail]')
    expect(detail.text()).toContain('Tiny Giant')
    expect(detail.text()).toContain('zzz-tiny-giant')
    expect(detail.text()).toContain('chill')
    expect(detail.text()).toContain('jellyfin')
  })

  it('saves only the changed fields against the loaded revision', async () => {
    const { wrapper, update } = setup([track('zzz-tiny-giant')])
    await flushPromises()
    await wrapper.get('[data-catalogue-track-row]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-catalogue-track-edit]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-catalogue-track-field="title"]').setValue('Renamed')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(update).toHaveBeenCalledWith('zzz-tiny-giant', { title: 'Renamed' }, 7)
    expect(wrapper.find('[data-catalogue-track-saved]').exists()).toBe(true)
  })

  it('lets a focus track keep a vocal status — the two dimensions are independent', async () => {
    const { wrapper, update } = setup([track('zzz-tiny-giant')])
    await flushPromises()
    await wrapper.get('[data-catalogue-track-row]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-catalogue-track-edit]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-catalogue-track-field="vocal_status"]').setValue('vocal')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(update).toHaveBeenCalledWith('zzz-tiny-giant', { vocal_status: 'vocal' }, 7)
    expect(wrapper.find('[data-catalogue-track-save-error]').exists()).toBe(false)
  })

  it('surfaces a rejected save instead of silently failing', async () => {
    const { wrapper, repo } = setup([track('zzz-tiny-giant')])
    vi.spyOn(repo, 'updateCatalogueTrack').mockRejectedValue(new Error('admin_409'))
    await flushPromises()
    await wrapper.get('[data-catalogue-track-row]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-catalogue-track-edit]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-catalogue-track-field="title"]').setValue('Renamed')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-catalogue-track-save-error]').text()).toContain('changed while you were editing')
  })

  it('reports a catalogue load failure', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'listCatalogueTracks').mockRejectedValue(new Error('admin_503'))
    const wrapper = mount(CatalogueTrackBrowser, { props: { repository: repo }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.get('[data-catalogue-track-error]').text()).toContain('could not be loaded')
  })
})

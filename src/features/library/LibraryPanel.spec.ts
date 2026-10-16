import { flushPromises, mount } from '@vue/test-utils'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { usePreferences } from '../../stores/preferences'
import { createLocalLibraryRepository } from './localRepository'
import LibraryPanel from './LibraryPanel.vue'

const track: Track = {
  id: 'track-a',
  title: 'A New Day',
  aliases: {},
  games: ['hsr'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'work-a',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
}

async function settleIndexedDb(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

describe('anonymous local library panel', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('lets an anonymous listener favourite a catalogue track and add it to a private playlist', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-panel-actions',
      now: () => '2026-08-11T07:00:00.000Z',
    })
    const wrapper = mount(LibraryPanel, {
      props: {
        repository,
        tracks: [track],
        playlistIdFactory: () => 'playlist-focus',
      },
    })
    await settleIndexedDb()

    await wrapper.get('[aria-label="Track for library action"]').setValue(track.id)
    await wrapper.get('button[aria-label="Add selected track to favourites"]').trigger('click')
    expect((await repository.exportLocalLibrary()).favourites).toHaveLength(1)
    await settleIndexedDb()
    await wrapper.get('[aria-label="Private playlist name"]').setValue('Focus list')
    wrapper.get('button[aria-label="Create private playlist"]')
    await wrapper.get('form').trigger('submit')
    expect((await repository.exportLocalLibrary()).playlists.map(({ id }) => id)).toEqual(['playlist-focus'])
    await settleIndexedDb()
    await wrapper.get('[aria-label="Track for Focus list"]').setValue(track.id)
    await wrapper.get('button[aria-label="Add track to Focus list"]').trigger('click')
    await settleIndexedDb()

    expect(wrapper.text()).toContain('A New Day')
    expect(wrapper.text().toLowerCase()).not.toContain('sign in')
    const exported = await repository.exportLocalLibrary()
    expect(exported.favourites.map(({ trackId }) => trackId)).toEqual(['track-a'])
    expect(exported.playlists[0]?.trackIds).toEqual(['track-a'])
  })

  it('keeps history disabled by default and exposes clear plus JSON export controls', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-panel-privacy',
    })
    const createObjectURL = vi.fn(() => 'blob:local-library')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mount(LibraryPanel, { props: { repository, tracks: [track] } })
    await settleIndexedDb()

    const historyToggle = wrapper.get<HTMLInputElement>('[aria-label="Save recent listening history on this device"]')
    expect(historyToggle.element.checked).toBe(false)
    await wrapper.get('button[aria-label="Clear local listening history"]').trigger('click')
    await settleIndexedDb()
    await wrapper.get('button[aria-label="Export local library as JSON"]').trigger('click')
    await settleIndexedDb()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-library')
    anchorClick.mockRestore()
    vi.unstubAllGlobals()
  })

  it('discloses the session-only fallback when IndexedDB is unavailable', async () => {
    const deniedFactory = {
      open() {
        throw new DOMException('Denied by browser policy', 'SecurityError')
      },
    } as unknown as IDBFactory
    const repository = createLocalLibraryRepository({
      indexedDB: deniedFactory,
      databaseName: 'library-panel-denied',
    })

    const wrapper = mount(LibraryPanel, { props: { repository, tracks: [track] } })
    await settleIndexedDb()

    expect(wrapper.text()).toContain('Browser storage is unavailable. Changes last only for this tab.')
  })

  it('updates the notice when an external history write loses IndexedDB access', async () => {
    const actual = new IDBFactory()
    let denied = false
    const switchingFactory = {
      open(name: string, version?: number) {
        if (denied) throw new DOMException('Denied by browser policy', 'SecurityError')
        return actual.open(name, version)
      },
    } as IDBFactory
    const repository = createLocalLibraryRepository({
      indexedDB: switchingFactory,
      databaseName: 'library-panel-runtime-denied',
      now: () => '2026-08-11T08:00:00.000Z',
    })
    await repository.setHistoryEnabled(true)
    const wrapper = mount(LibraryPanel, { props: { repository, tracks: [track] } })
    await settleIndexedDb()

    denied = true
    await repository.recordRecent(track.id)
    await settleIndexedDb()

    expect(wrapper.text()).toContain('Browser storage is unavailable. Changes last only for this tab.')
  })

  it('plays and removes known playlist items while keeping unknown canonical IDs visible but disabled', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-panel-playlist-items',
      now: () => '2026-08-11T11:00:00.000Z',
    })
    await repository.createPlaylist({ id: 'focus', name: 'Focus list' })
    await repository.setPlaylistOrder('focus', [track.id, 'track-unknown'])
    const wrapper = mount(LibraryPanel, { props: { repository, tracks: [track] } })
    await settleIndexedDb()

    await wrapper.get('button[aria-label="Play A New Day from Focus list"]').trigger('click')
    expect(wrapper.emitted('play-now')?.[0]).toEqual([track])
    expect(wrapper.get<HTMLButtonElement>('button[aria-label="Play track-unknown from Focus list"]').element.disabled).toBe(true)

    await wrapper.get('button[aria-label="Remove A New Day from Focus list"]').trigger('click')
    await settleIndexedDb()
    expect((await repository.exportLocalLibrary()).playlists[0]?.trackIds).toEqual(['track-unknown'])
    expect(wrapper.text()).toContain('track-unknown')
  })

  it('revokes an export URL and reports failure even when the synthetic download click throws', async () => {
    const repository = createLocalLibraryRepository({ indexedDB: new IDBFactory(), databaseName: 'library-export-failure' })
    const wrapper = mount(LibraryPanel, { props: { repository, tracks: [track] } })
    await settleIndexedDb()
    const createObjectURL = vi.fn(() => 'blob:failed-export')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download blocked')
    })

    await wrapper.get('button[aria-label="Export local library as JSON"]').trigger('click')
    // IndexedDB completion can exceed the helper's fixed 20 ms under a full
    // suite. Wait for the real operation result, then assert resource cleanup.
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain('could not be completed'))

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-export')
    expect(wrapper.get('[role="status"]').text()).toContain('could not be completed')
    anchorClick.mockRestore()
    vi.unstubAllGlobals()
  })
})

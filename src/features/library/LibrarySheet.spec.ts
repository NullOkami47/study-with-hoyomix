import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { createLocalLibraryRepository } from './localRepository'
import { createPlaybackStore } from '../player/store'
import { usePreferences } from '../../stores/preferences'
import LibrarySheet from './LibrarySheet.vue'
import { libraryFixtureTracks } from '../../test/fixtures/libraryCatalogue'

describe('LibrarySheet', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('renders the catalogue browser without the retired device-local library', () => {
    const library = createLocalLibraryRepository()
    const player = createPlaybackStore()
    const wrapper = mount(LibrarySheet, {
      props: { library, player, tracks: libraryFixtureTracks() },
    })

    // The Library is now strictly the catalogue browser; the legacy device-local section is removed.
    expect(wrapper.find('[data-library-catalogue]').exists()).toBe(true)
    expect(wrapper.find('[data-music-library-search]').exists()).toBe(true)
    expect(wrapper.find('[data-library-local]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Your local library')

    wrapper.unmount()
    library.destroy()
  })

  it('keeps the queue, source, diagnostics and sleep surfaces out of the Library', () => {
    const library = createLocalLibraryRepository()
    const player = createPlaybackStore()
    const wrapper = mount(LibrarySheet, {
      props: { library, player, tracks: [] },
    })

    // These belong to other Control Centre categories. Browsing must not grow a second
    // queue panel, source picker, diagnostics readout or sleep timer.
    expect(wrapper.find('[data-library-queue]').exists()).toBe(false)
    expect(wrapper.find('[data-library-source]').exists()).toBe(false)
    expect(wrapper.find('[data-playback-diagnostics]').exists()).toBe(false)
    expect(wrapper.find('[data-library-sleep]').exists()).toBe(false)

    wrapper.unmount()
    library.destroy()
  })

  it('renders with an empty catalogue without crashing', () => {
    const library = createLocalLibraryRepository()
    const player = createPlaybackStore()
    const wrapper = mount(LibrarySheet, { props: { library, player, tracks: [] } })

    expect(wrapper.find('[data-library-panel="all"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-track-row]')).toHaveLength(0)

    wrapper.unmount()
    library.destroy()
  })
})

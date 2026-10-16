import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { usePreferences } from '../../stores/preferences'
import {
  applyAccountPreferences, captureAccountPreferences,
  createAccountPreferencesRepository,
} from './accountPreferences'
import AccountPreferenceSync from './AccountPreferenceSync.vue'

const preferences = () => {
  const value = usePreferences()
  value.setLocale('zh-Hant')
  value.setLowPower(true)
  value.setBackgroundMode('ambient')
  value.setVisualStyle('cinematic')
  value.setStudioBlur(16)
  value.setStudioGlassGray(26)
  value.setStudioEdge(68)
  value.setStudyTipsEnabled(true)
  return value
}

function volumeControl() {
  const volume = ref(.4)
  return { volume, setVolume: vi.fn((value: number) => { volume.value = value }) }
}

describe('scoped account preferences', () => {
  it('explicitly negotiates the retired-field-free v2 wire format on reads and writes', async () => {
    const snapshot = captureAccountPreferences(preferences(), volumeControl())
    const fetcher = vi.fn(async () => Response.json({ preferences: snapshot }))
    const repository = createAccountPreferencesRepository(fetcher)
    await repository.load()
    await repository.save(snapshot)
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(new Headers(init.headers).get('x-account-preferences-schema')).toBe('2')
      if (init.body) expect(JSON.parse(String(init.body)).preferences).not.toHaveProperty('lowPower')
    }
  })
  it('captures only live language, volume, low-power, appearance and tip preferences', () => {
    const snapshot = captureAccountPreferences(preferences(), volumeControl())
    expect(snapshot.locale).toBe('zh-Hant')
    expect(snapshot.volume).toBe(.4)
    expect(snapshot).not.toHaveProperty('lowPower')
    for (const key of ['favourites', 'playlists', 'recentHistory', 'apiKey', 'queue', 'token']) {
      expect(snapshot).not.toHaveProperty(key)
    }
  })

  it('applies valid restored preferences using the existing UI and player setters', () => {
    const current = preferences()
    const player = volumeControl()
    const saved = captureAccountPreferences(current, player)
    current.setLocale('en')
    current.setLowPower(false)
    player.setVolume(1)
    applyAccountPreferences(current, player, saved)
    expect(current.locale.value).toBe('zh-Hant')
    expect(current.lowPower.value).toBe(false)
    expect(player.volume.value).toBe(.4)
  })

  it('rejects extra fields rather than uploading unrelated library or credential data', async () => {
    const fetcher = vi.fn(async () => Response.json({ preferences: captureAccountPreferences(preferences(), volumeControl()) })) as typeof fetch
    const repository = createAccountPreferencesRepository(fetcher)
    await expect(repository.save({
      ...captureAccountPreferences(preferences(), volumeControl()),
      favourites: [{ trackId: 'secret' }],
    } as never)).rejects.toThrow('invalid_synced_user_preferences')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('describes automatic sync without owning requests or manual controls', async () => {
    const player = volumeControl()
    const repository = { load: vi.fn(async () => null), save: vi.fn(async (value: ReturnType<typeof captureAccountPreferences>) => value) }
    const wrapper = mount(AccountPreferenceSync, { props: { player, repository } })
    await flushPromises()
    expect(wrapper.find('[data-account-preferences-save]').exists()).toBe(false)
    expect(wrapper.find('[data-account-preferences-load]').exists()).toBe(false)
    expect(wrapper.text()).toContain('自動同步')
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

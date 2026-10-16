import { computed, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.doUnmock('./chineseTitleConverter'); vi.resetModules() })

describe('on-demand title dictionaries', () => {
  it('refreshes an already-rendered label after the cold chunk loads', async () => {
    vi.resetModules()
    const { resolveDisplayTitle, loadChineseTitleConverter } = await import('./displayTitle')
    const track = { title: 'Dawn Winery Theme', aliases: { 'zh-Hans': ['晨曦酒庄'] } }
    const label = computed(() => resolveDisplayTitle(track, 'zh-Hant'))
    expect(label.value).toBe('晨曦酒庄')
    const first = loadChineseTitleConverter()
    expect(loadChineseTitleConverter()).toBe(first)
    await first
    await nextTick()
    expect(label.value).toBe('晨曦酒莊')
    expect(track.aliases['zh-Hans']).toEqual(['晨曦酒庄'])
  })
  it('keeps exact aliases and English independent of the chunk, and retains the original on failure', async () => {
    vi.resetModules()
    const factory = vi.fn(() => { throw new Error('offline chunk') })
    vi.doMock('./chineseTitleConverter', factory)
    const { resolveDisplayTitle, loadChineseTitleConverter } = await import('./displayTitle')
    const track = { title: 'Dawn Winery Theme', aliases: { 'zh-Hans': ['晨曦酒庄'] } }
    expect(resolveDisplayTitle(track, 'en')).toBe('Dawn Winery Theme')
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('晨曦酒庄')
    expect(factory).not.toHaveBeenCalled()
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒庄')
    await expect(loadChineseTitleConverter()).rejects.toThrow()
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒庄')
    expect(factory).toHaveBeenCalledTimes(1)
  })
})

import { beforeAll, describe, expect, it } from 'vitest'

import { hasLocalisedTitle, loadChineseTitleConverter, resolveDisplayTitle } from './displayTitle'

beforeAll(() => loadChineseTitleConverter())

describe('resolveDisplayTitle', () => {
  it('prefers an alias registered for the exact locale', () => {
    const track = { title: 'Dawn Winery Theme', aliases: { 'zh-Hant': ['晨曦酒莊'], 'zh-Hans': ['晨曦酒庄'] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('晨曦酒庄')
  })

  it('returns the canonical title for English, because that is the canonical string', () => {
    const track = { title: 'Dawn Winery Theme', aliases: { 'zh-Hant': ['晨曦酒莊'] } }
    expect(resolveDisplayTitle(track, 'en')).toBe('Dawn Winery Theme')
  })

  it('never cross-serves English as a Chinese alias or the reverse', () => {
    // An English alias must not be served to a Chinese interface: they are different languages,
    // and the canonical title is already the correct English fallback.
    const track = { title: 'Canonical', aliases: { en: ['English Alias'], 'zh-Hant': [] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('Canonical')
    expect(resolveDisplayTitle(track, 'en')).toBe('English Alias')
  })

  it('converts the opposite Chinese script for presentation', () => {
    // Missing exact aliases use readable script conversion, without changing stored data.
    const traditionalOnly = { title: 'Canonical', aliases: { 'zh-Hant': ['晨曦酒莊'] } }
    expect(resolveDisplayTitle(traditionalOnly, 'zh-Hans')).toBe('晨曦酒庄')

    const simplifiedOnly = { title: 'Canonical', aliases: { 'zh-Hans': ['晨曦酒庄'] } }
    expect(resolveDisplayTitle(simplifiedOnly, 'zh-Hant')).toBe('晨曦酒莊')
  })

  it('prefers the exact locale over the script-compatible fallback', () => {
    const track = {
      title: 'Canonical',
      aliases: { 'zh-Hant': ['繁'], 'zh-Hans': ['简'] },
    }
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('简')
  })

  it('uses the canonical title when no alias exists at all', () => {
    expect(resolveDisplayTitle({ title: 'Canonical' }, 'zh-Hant')).toBe('Canonical')
    expect(resolveDisplayTitle({ title: 'Canonical', aliases: {} }, 'zh-Hant')).toBe('Canonical')
  })

  it('never invents a translation or transliteration', () => {
    // The whole point: a missing alias yields the English title, not a guess.
    const track = { title: 'Sway to My Beat in Cosmos', aliases: { ja: ['コスモス'] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('Sway to My Beat in Cosmos')
  })

  it('skips empty and whitespace-only alias entries instead of rendering a blank label', () => {
    const track = { title: 'Canonical', aliases: { 'zh-Hant': ['', '   ', '晨曦酒莊'] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
  })

  it('falls through to the canonical title when every alias in the locale is empty', () => {
    const track = { title: 'Canonical', aliases: { 'zh-Hant': ['', '  '] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('Canonical')
  })

  it('trims the chosen alias', () => {
    const track = { title: 'Canonical', aliases: { 'zh-Hant': ['  晨曦酒莊  '] } }
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
  })

  it('tolerates a malformed alias map without throwing', () => {
    expect(resolveDisplayTitle({ title: 'Canonical', aliases: { 'zh-Hant': 'not-an-array' } as never }, 'zh-Hant')).toBe('Canonical')
    expect(resolveDisplayTitle({ title: 'Canonical', aliases: { 'zh-Hant': [1, null] } as never }, 'zh-Hant')).toBe('Canonical')
  })

  it('returns the caller fallback when the track or its title is unusable', () => {
    expect(resolveDisplayTitle(null, 'zh-Hant', 'No track')).toBe('No track')
    expect(resolveDisplayTitle(undefined, 'zh-Hant', 'No track')).toBe('No track')
    expect(resolveDisplayTitle({ title: '   ' }, 'zh-Hant', 'No track')).toBe('No track')
  })

  it('prefers a usable alias over an empty canonical title', () => {
    const track = { title: '', aliases: { 'zh-Hant': ['晨曦酒莊'] } }
    expect(resolveDisplayTitle(track, 'zh-Hant', 'Fallback')).toBe('晨曦酒莊')
  })

  it('returns an empty string rather than throwing when nothing is available and no fallback is given', () => {
    expect(resolveDisplayTitle({ title: '' }, 'en')).toBe('')
  })

  it('is a pure function: the same input always yields the same output and the track is not mutated', () => {
    const track = { title: 'Canonical', aliases: { 'zh-Hant': ['晨曦酒莊'] } }
    const snapshot = JSON.stringify(track)
    const first = resolveDisplayTitle(track, 'zh-Hant')
    const second = resolveDisplayTitle(track, 'zh-Hant')
    expect(first).toBe(second)
    expect(JSON.stringify(track)).toBe(snapshot)
  })
})

describe('hasLocalisedTitle', () => {
  it('reports only what is stored in the exact locale', () => {
    const traditionalOnly = { title: 'Canonical', aliases: { 'zh-Hant': ['繁'] } }
    expect(hasLocalisedTitle(traditionalOnly, 'zh-Hant')).toBe(true)
    // A stored alias exists in the other script, but not in this exact locale.
    expect(hasLocalisedTitle(traditionalOnly, 'zh-Hans')).toBe(false)
    expect(hasLocalisedTitle(traditionalOnly, 'en')).toBe(false)
  })

  it('ignores empty alias entries', () => {
    expect(hasLocalisedTitle({ title: 'Canonical', aliases: { 'zh-Hant': ['  '] } }, 'zh-Hant')).toBe(false)
  })

  it('is false for a missing track or a missing alias map', () => {
    expect(hasLocalisedTitle(null, 'zh-Hant')).toBe(false)
    expect(hasLocalisedTitle({ title: 'Canonical' }, 'zh-Hant')).toBe(false)
  })
})

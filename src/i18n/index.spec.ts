import { describe, expect, it } from 'vitest'

import { mapBrowserLocale, resolveLocale, translate } from './index'
import en from './messages/en'
import zhHans from './messages/zh-Hans'
import zhHant from './messages/zh-Hant'

describe('locale resolution', () => {
  it('maps zh-TW to Traditional Chinese instead of falling back to English', () => {
    expect(mapBrowserLocale('zh-TW')).toBe('zh-Hant')
  })

  it('maps zh-CN to Simplified Chinese instead of selecting Traditional Chinese', () => {
    expect(mapBrowserLocale('zh-CN')).toBe('zh-Hans')
  })

  it('keeps an explicit Simplified script even when the region is Hong Kong', () => {
    expect(mapBrowserLocale('zh-Hans-HK')).toBe('zh-Hans')
  })

  it('keeps an explicit Traditional script even when the region is China', () => {
    expect(mapBrowserLocale('zh-Hant-CN')).toBe('zh-Hant')
  })

  it('falls back to English for an unsupported browser locale', () => {
    expect(mapBrowserLocale('fr-FR')).toBe('en')
  })

  it('uses a valid persisted override instead of the browser locale', () => {
    expect(resolveLocale('zh-TW', 'en')).toBe('en')
  })
})

describe('translations', () => {
  it('names only the Control Centre playback destination Playback in all locales', () => {
    expect(translate('zh-Hant', 'controlCentre.section.music')).toBe('播放')
    expect(translate('zh-Hans', 'controlCentre.section.music')).toBe('播放')
    expect(translate('en', 'controlCentre.section.music')).toBe('Playback')
    expect(translate('zh-Hant', 'controlCentre.group.music')).toBe('音樂')
    expect(translate('en', 'controlCentre.group.music')).toBe('Music')
  })
  it('resolves stable domain keys instead of exposing display strings as keys', () => {
    expect(translate('zh-Hant', 'nav.library')).toBe('音樂庫')
    expect(translate('zh-Hans', 'player.play')).toBe('播放')
    expect(translate('en', 'timer.sleep')).toBe('Sleep timer')
    expect(translate('en', 'chat.title')).toBe('Study chat')
  })

  it('keeps every locale catalogue on the exact same runtime key set', () => {
    const expectedKeys = Object.keys(en).sort()

    expect(Object.keys(zhHant).sort()).toEqual(expectedKeys)
    expect(Object.keys(zhHans).sort()).toEqual(expectedKeys)
  })

  /**
   * The three-provider Playback surface retired the legacy automatic providers. Their
   * labels must not linger in any catalogue: a leftover key would render as a live label
   * the moment a legacy identity reached a template again.
   */
  it('retires the legacy provider labels from every catalogue', () => {
    const retired = [
      'settings.playback.source.r2',
      'settings.playback.source.meting',
      'settings.playback.source.piped',
      'settings.playback.source.invidious',
      'settings.playback.source.lx-huibq',
      'settings.playback.source.lx-ikun',
      'settings.playback.source.lx-juhe',
      'settings.playback.source.lx-qdy',
      'settings.playback.source.lx-flower',
      'settings.playback.source.lx-lx',
      'settings.playback.source.lx-grass',
      'settings.playback.source.lx-sixyin',
    ]

    for (const catalogue of [en, zhHans, zhHant]) {
      for (const key of retired) {
        expect(catalogue).not.toHaveProperty(key)
      }
    }
  })
})

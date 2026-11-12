import { describe, expect, it, vi } from 'vitest'

import {
  backgroundTitle,
  BACKGROUND_BUCKET_ORIGIN,
  BACKGROUND_COLLECTIONS,
  bucketMediaUrl,
  collectionLabelKey,
  gameLabelKey,
  isBucketMediaUrl,
  listStaticBackgrounds,
} from './catalogue'
import {
  STATIC_BACKGROUND_DEFINITIONS,
  STATIC_BACKGROUND_IDS,
  STATIC_BACKGROUND_RIGHTS_STATUS,
  isStaticBackgroundId,
  staticBackgroundDefinition,
} from './staticDefinitions'
import { createPublicBackground, createStaticBackgroundFixture } from '../../test/fixtures/publicBackgrounds'

// The public distribution deliberately has no authorised media. Synthetic
// definitions are supplied only inside the opt-in catalogue test below.
describe('public shipped background catalogue', () => {
  it.each(['constructor', '__proto__', 'toString'])('treats custom game %s as an uncurated heading', (game) => {
    expect(gameLabelKey(game)).toBeNull()
  })

  it('leaves shipped media, ID indexes and rights approval empty by default', () => {
    expect(listStaticBackgrounds()).toEqual([])
    expect(STATIC_BACKGROUND_DEFINITIONS).toEqual([])
    expect(STATIC_BACKGROUND_IDS).toEqual([])
    expect(STATIC_BACKGROUND_RIGHTS_STATUS).toBe('not-reviewed')
    expect(gameLabelKey('zzz')).toBe('game.zzz')
    expect(BACKGROUND_COLLECTIONS.map(({ collection }) => collection)).toEqual(['urban-stroll', 'lofi-girl', 'other'])
    expect(collectionLabelKey('zzz', 'urban-stroll')).toBe('settings.backgrounds.collection.urbanStroll')
    expect(collectionLabelKey('fixture-game', 'fixture-collection')).toBeNull()
  })

  it('does not register assets or grant shipped identity through an override', () => {
    const fixture = createPublicBackground()
    expect(listStaticBackgrounds(new Map([[fixture.id, { id: fixture.id, status: 'published' }]]))).toEqual([])
    for (const id of [fixture.id, '../fixture-scene', 'FIXTURE-SCENE', 'constructor', '__proto__']) {
      expect(isStaticBackgroundId(id)).toBe(false)
      expect(staticBackgroundDefinition(id)).toBeNull()
    }
  })

  it('has no bucket origin or trusted bucket media until configured by an operator', () => {
    expect(BACKGROUND_BUCKET_ORIGIN).toBe('')
    expect(bucketMediaUrl('fixture/scene.mp4')).toBe('')
    for (const url of ['', '/__test__/backgrounds/scene.mp4', 'https://media.example.invalid/backgrounds/catalog/scene.mp4']) {
      expect(isBucketMediaUrl(url)).toBe(false)
    }
  })

  it('preserves explicit titles and localises missing titles in every supported locale', () => {
    const titles = { en: 'Published background', 'zh-Hans': '已发布背景', 'zh-Hant': '已發佈背景' } as const
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      expect(backgroundTitle(createPublicBackground('fixture-titled', { title: 'Synthetic study scene' }), locale)).toBe('Synthetic study scene')
      for (const title of [null, undefined]) {
        expect(backgroundTitle(createPublicBackground('fixture-untitled', { title }), locale)).toBe(titles[locale])
      }
    }
  })

  it('maps explicitly injected synthetic masters to capped playback, localised titles and administrator overrides', async () => {
    const fixture = createStaticBackgroundFixture()
    vi.resetModules()
    vi.doMock('./staticDefinitions', async () => ({
      ...await vi.importActual<typeof import('./staticDefinitions')>('./staticDefinitions'),
      ...fixture,
    }))
    try {
      const catalogue = await import('./catalogue')
      const items = catalogue.listStaticBackgrounds()
      expect(items.map(({ id }) => id)).toEqual(fixture.STATIC_BACKGROUND_IDS)
      for (const [index, item] of items.entries()) {
        const definition = fixture.STATIC_BACKGROUND_DEFINITIONS[index]!
        expect(item).toMatchObject({
          status: 'published', kind: 'video', contentType: 'video/mp4', mediaSource: 'static',
          rightsStatus: 'not-reviewed', mediaUrl: definition.playbackVersion!.mediaUrl,
          width: 1920, height: 1080, fps: 24, byteSize: 100, durationMs: 20_000,
          highQualityVersion: definition.highQualityVersion, posterUrl: definition.posterUrl,
        })
        expect(item.highQualityVersion!.width).toBeLessThanOrEqual(2560)
        expect(item.highQualityVersion!.height).toBeLessThanOrEqual(1440)
        expect(item.highQualityVersion!.fps).toBeLessThanOrEqual(30)
        expect(item.durationMs).toBeLessThanOrEqual(120_000)
      }
      for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
        const titles = items.map(item => catalogue.backgroundTitle(item, locale))
        expect(new Set(titles).size).toBe(items.length)
        expect(titles.every(title => title.length > 0 && !title.startsWith('settings.'))).toBe(true)
        expect(catalogue.backgroundTitle({ ...items[0]!, title: 'Administrator title' }, locale)).toBe('Administrator title')
      }
      expect(catalogue.backgroundTitle(items[0]!, 'en')).toBe('Urban Stroll')
      expect(catalogue.backgroundTitle(items[0]!, 'zh-Hant')).toBe('城市漫步')
      const id = items[0]!.id
      expect(catalogue.listStaticBackgrounds(new Map([[id, { id, status: 'archived' }]])).map(item => item.id)).toEqual(fixture.STATIC_BACKGROUND_IDS.slice(1))
    } finally {
      vi.doUnmock('./staticDefinitions')
      vi.resetModules()
    }
    expect(STATIC_BACKGROUND_DEFINITIONS).toEqual([])
    expect(listStaticBackgrounds()).toEqual([])
  })
})

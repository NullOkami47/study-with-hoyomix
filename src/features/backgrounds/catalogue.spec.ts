import { describe, expect, it } from 'vitest'
import { backgroundTitle, gameLabelKey, listStaticBackgrounds, isBucketMediaUrl, BACKGROUND_BUCKET_ORIGIN } from './catalogue'
import { STATIC_BACKGROUND_IDS, isStaticBackgroundId, staticBackgroundDefinition } from './staticDefinitions'
import type { PublicBackground } from './types'

describe('public background catalogue', () => {
  it('ships no third-party media or hosted media origin', () => {
    expect(listStaticBackgrounds()).toEqual([])
    expect(STATIC_BACKGROUND_IDS).toEqual([])
    expect(BACKGROUND_BUCKET_ORIGIN).toBe('')
    expect(isBucketMediaUrl('https://media.example.invalid/video.mp4')).toBe(false)
    expect(isStaticBackgroundId('missing')).toBe(false)
    expect(staticBackgroundDefinition('missing')).toBeNull()
  })
  it.each(['constructor', '__proto__', 'toString'])('treats custom game %s as an uncurated heading', game => {
    expect(gameLabelKey(game)).toBeNull()
  })
  it('retains operator-supplied titles and translated empty-title fallback', () => {
    const entry = { id: 'synthetic', title: 'Original study scene' } as PublicBackground
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      expect(backgroundTitle(entry, locale)).toBe('Original study scene')
      expect(backgroundTitle({ ...entry, title: undefined }, locale)).toBeTruthy()
    }
  })
})

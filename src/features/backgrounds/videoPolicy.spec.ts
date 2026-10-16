import { describe, expect, it } from 'vitest'
import { backgroundVideoSize } from './videoPolicy'
describe('background video playback envelope', () => {
  it.each([[3840,2160,1920,1080],[1920,1080,1920,1080],[2160,3840,606,1080],[3000,1000,1920,640]])('fits %sx%s without stretching/upscaling', (w,h,width,height) => {
    expect(backgroundVideoSize(w,h)).toEqual({width,height})
  })
  it('rejects invalid dimensions', () => { expect(() => backgroundVideoSize(NaN,1080)).toThrow() })
  it('also produces a separately bounded high-quality version without upscaling', () => {
    expect(backgroundVideoSize(3840, 2160, 'high')).toEqual({ width: 2560, height: 1440 })
    expect(backgroundVideoSize(1280, 720, 'high')).toEqual({ width: 1280, height: 720 })
  })
})

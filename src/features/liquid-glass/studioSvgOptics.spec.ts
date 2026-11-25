import { describe, expect, it } from 'vitest'
import { studioSvgRefractionScale, STUDIO_SVG_OPTICS } from './studioSvgOptics'

describe('Studio native backdrop optics', () => {
  it('maps the existing default Edge 68 setting to restrained visible scale 48', () => {
    expect(studioSvgRefractionScale(68)).toBe(48)
    expect(studioSvgRefractionScale(68, 56)).toBe(48)
  })
  it('has a true off endpoint and a bounded, monotonic adjustment', () => {
    expect(studioSvgRefractionScale(0)).toBe(0)
    expect(studioSvgRefractionScale(-10)).toBe(0)
    expect(studioSvgRefractionScale(100)).toBe(STUDIO_SVG_OPTICS.maxScale)
    expect(studioSvgRefractionScale(1000)).toBe(STUDIO_SVG_OPTICS.maxScale)
    const scales = Array.from({ length: 101 }, (_, edge) => studioSvgRefractionScale(edge))
    expect(scales.every((value, index) => Number.isFinite(value) && value >= 0 && (index === 0 || value >= scales[index - 1]!))).toBe(true)
  })
  it('does not amplify a weak tile profile and cannot exceed the Studio cap', () => {
    expect(studioSvgRefractionScale(68, 28)).toBe(24)
    expect(studioSvgRefractionScale(68, 112)).toBe(48)
    expect(studioSvgRefractionScale(68, 0)).toBe(0)
  })
  it('falls back safely for non-finite settings or invalid tile scale', () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(studioSvgRefractionScale(value)).toBe(48)
      expect(studioSvgRefractionScale(68, value)).toBe(0)
    }
    expect(studioSvgRefractionScale(68, -10)).toBe(0)
  })
})

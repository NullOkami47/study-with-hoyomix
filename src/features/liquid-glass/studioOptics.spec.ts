import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { studioFragmentMainShader } from './shaders/studio-fragment-main.glsl'
import {
  STUDIO_OPTICS,
  studioCornerRadiusCss,
  studioCssPixelsToUv,
  studioDispersionCssPx,
  studioEdgeDispersion,
  studioRefractionCssPx,
  studioRimMask,
} from './studioOptics'

describe('studio edge dispersion policy', () => {
  it('maps the settings slider onto the dispersion control and keeps zero off', () => {
    expect(studioEdgeDispersion(0)).toBe(0)
    expect(studioEdgeDispersion(-4)).toBe(0)
    expect(studioEdgeDispersion(Number.NaN)).toBe(0)
    expect(studioEdgeDispersion(50)).toBeCloseTo(STUDIO_OPTICS.dispersionCeiling / 2, 5)
    expect(studioEdgeDispersion(100)).toBe(STUDIO_OPTICS.dispersionCeiling)
    expect(studioEdgeDispersion(140)).toBe(STUDIO_OPTICS.dispersionCeiling)
  })

  it('disables dispersion for the no-effect and non-finite controls', () => {
    expect(studioDispersionCssPx(0, 0, 20)).toBe(0)
    expect(studioDispersionCssPx(-2, 0, 20)).toBe(0)
    expect(studioDispersionCssPx(Number.NaN, 0, 20)).toBe(0)
    expect(studioDispersionCssPx(7, Number.POSITIVE_INFINITY, 20)).toBe(0)
    expect(studioRimMask(Number.NaN, 20)).toBe(0)
    expect(studioRefractionCssPx(Number.NaN, 1)).toBe(0)
    expect(studioCssPixelsToUv(2, Number.NaN, 1000)).toBe(0)
    expect(studioCssPixelsToUv(2, 2, 0)).toBe(0)
  })

  it('is strongest on the rim and recombined at the centre', () => {
    const edge = studioDispersionCssPx(7, 0, 20)
    const mid = studioDispersionCssPx(7, 10, 20)
    const centre = studioDispersionCssPx(7, 20, 20)
    expect(edge).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(centre)
    expect(centre).toBe(0)
    expect(edge).toBeCloseTo(STUDIO_OPTICS.maxDispersionCssPx, 5)
  })

  it('caps a high setting below a rainbow fringe', () => {
    const high = studioDispersionCssPx(100, 0, 20)
    expect(high).toBeLessThanOrEqual(STUDIO_OPTICS.dispersionCapCssPx)
    expect(high).toBeCloseTo(
      Math.min(
        STUDIO_OPTICS.maxDispersionCssPx * (STUDIO_OPTICS.dispersionCeiling / STUDIO_OPTICS.referenceDispersion),
        STUDIO_OPTICS.dispersionCapCssPx,
      ),
      5,
    )
    expect(studioRefractionCssPx(40, 1)).toBe(STUDIO_OPTICS.maxRefractionCssPx)
  })

  it('keeps the UV conversion finite and resolution-aware', () => {
    expect(studioCssPixelsToUv(2.6, 2, 2000)).toBeCloseTo(2.6 * 2 / 2000, 6)
    expect(studioCssPixelsToUv(2.6, 1, 1000)).toBeGreaterThan(studioCssPixelsToUv(2.6, 1, 2000))
  })

  it('shares its caps with the fragment shader and never disperses a foreground sampler', () => {
    for (const value of [
      STUDIO_OPTICS.maxRefractionCssPx,
      STUDIO_OPTICS.maxDispersionCssPx,
      STUDIO_OPTICS.referenceDispersion,
      STUDIO_OPTICS.dispersionCapCssPx,
      STUDIO_OPTICS.dispersionCeiling,
      STUDIO_OPTICS.rimPower,
    ]) {
      expect(studioFragmentMainShader).toContain(value.toString())
    }
    expect(studioFragmentMainShader).toContain('disperseUv')
    expect(studioFragmentMainShader).toContain('textureLod(u_bg, sampleUv, 0.0)')
    expect(studioFragmentMainShader).toContain('textureLod(u_blurredBg, sampleUv, 0.0)')
    expect(studioFragmentMainShader).not.toContain('u_foreground')
    expect(studioFragmentMainShader).toContain('isnan')
  })
})

describe('studio capsule radius', () => {
  it('clamps a pill radius so a short bar cannot collapse to its centre line', () => {
    expect(studioCornerRadiusCss(999, 480, 84)).toBe(42)
    expect(studioCornerRadiusCss(999, 84, 480)).toBe(42)
    expect(studioCornerRadiusCss(24, 800, 700)).toBe(24)
    expect(studioCornerRadiusCss(Number.NaN, 200, 40)).toBe(12)
    expect(studioCornerRadiusCss(8, 10, 0)).toBe(0)
  })
})

describe('studio CSS fallback rim', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

  it('suppresses the flat geometric stroke only while the shader owns the surface', () => {
    expect(css).toContain('[data-studio-glass-rendered="true"]::before')
    expect(css).toContain('content: none')
  })

  it('keeps a restrained cool-to-warm rim for the CSS fallback', () => {
    expect(css).toContain('rgb(186 220 255 / 22%)')
    expect(css).toContain('rgb(255 186 170 / 18%)')
    expect(css).not.toContain('rainbow')
  })
})

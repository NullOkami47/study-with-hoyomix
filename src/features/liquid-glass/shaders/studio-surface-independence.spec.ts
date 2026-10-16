import { describe, expect, it } from 'vitest'
import { sdfLib } from './sdf.glsl'

/**
 * The Studio material composes several independent windows -- a top bar, a player, a chat
 * window, a modal hub -- into one signed distance field. That composition is the only
 * thing deciding whether the user sees separate rounded rectangles or one irregular blob,
 * so it is pinned here rather than left to whichever union operator was convenient.
 *
 * The upstream reference this shader was adapted from renders a cluster of decorative
 * blobs that are *supposed* to fuse, and so it unions them with a smooth minimum. This
 * project renders application chrome. Two surfaces 4px apart are 4px apart because a
 * designer put them 4px apart, and a smooth union spends that gap filling itself in.
 * "Liquid Glass" names the material, not a licence to merge the layout.
 */
describe('studio SDF surface independence', () => {
  const unionCalls = sdfLib.match(/result = \w+\(result,/gu) ?? []

  it('unions surfaces with a hard minimum so distinct surfaces stay distinct', () => {
    expect(unionCalls).toHaveLength(1)
    for (const call of unionCalls) expect(call).toBe('result = min(result,')
  })

  it('carries no smooth-union operator or merge radius at all', () => {
    // Kept as an absence rather than an unused declaration: a dormant smin() plus a
    // dormant u_mergeRate is an invitation to reintroduce the blob, and the uniform
    // would also re-enter the pixel signature and cost frames that change nothing.
    expect(sdfLib).not.toContain('smin')
    expect(sdfLib).not.toContain('u_mergeRate')
  })

  it('still caps the field at both array capacity and the uploaded shape count', () => {
    expect(sdfLib).toContain('const int MAX_SHAPES = 16;')
    expect(sdfLib).toContain('for (int index = 0; index < MAX_SHAPES; ++index)')
    expect(sdfLib).toContain('if (index >= u_shapeCount) break;')
  })

  it('keeps the rounded-rect field itself untouched, so corners stay superellipses', () => {
    expect(sdfLib).toContain('float superellipseCornerSDF(vec2 p, float r, float n)')
    expect(sdfLib).toContain('float roundedRectSDF(')
  })
})

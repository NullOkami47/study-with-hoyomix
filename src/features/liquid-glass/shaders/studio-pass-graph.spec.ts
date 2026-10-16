import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sdfLib } from './sdf.glsl'
import { studioFragmentBgShader } from './studio-fragment-bg.glsl'
import { studioFragmentBgHblurShader } from './studio-fragment-bg-hblur.glsl'
import { studioFragmentBgVblurShader } from './studio-fragment-bg-vblur.glsl'
import { studioFragmentMainShader } from './studio-fragment-main.glsl'

const SHAPE_UNIFORMS = ['u_shapeCount', 'u_shapeCenters', 'u_shapeSizes', 'u_shapeRadius', 'u_shapeRoundness']
const studioGlassSource = readFileSync(resolve(process.cwd(), 'src/features/liquid-glass/StudioGlassCanvas.vue'), 'utf8')

/**
 * These tests exist to stop a specific wrong optimisation.
 *
 * A four-pass chain that looks like scene -> blur -> composite invites caching
 * the background and blur passes and rerunning only the main pass when glass
 * geometry moves. That is invalid here: the background pass subtracts a drop
 * shadow derived from the shape SDF, so its output moves with the geometry, and
 * both blur passes consume that output. Caching them across a geometry-only
 * change would leave the shadow behind at its previous position.
 *
 * If a future change genuinely makes the background chain geometry-independent
 * (for example by moving the shadow into the main pass), these tests should fail
 * and be rewritten deliberately -- not deleted to make caching look safe.
 */
describe('studio pass graph dependencies', () => {
  it('declares the shape uniforms the SDF loop reads', () => {
    for (const uniform of SHAPE_UNIFORMS) expect(sdfLib).toContain(uniform)
    expect(sdfLib).toContain('float mainSDF(')
  })

  it('keeps the background pass geometry-dependent through its shadow term', () => {
    // The shadow is a function of the merged shape SDF, so background output is
    // not reusable across a geometry-only change.
    expect(studioFragmentBgShader).toContain('mainSDF(gl_FragCoord.xy)')
    expect(studioFragmentBgShader).toContain('u_shadowExpand')
    expect(studioFragmentBgShader).toContain('u_shadowFactor')
    for (const uniform of SHAPE_UNIFORMS) expect(studioFragmentBgShader).toContain(uniform)
  })

  it('keeps both blur passes downstream of the geometry-dependent background', () => {
    for (const shader of [studioFragmentBgVblurShader, studioFragmentBgHblurShader]) {
      expect(shader).toContain('u_prevPassTexture')
      expect(shader).toContain('u_blurRadius')
      expect(shader).toContain('u_blurWeights')
    }
  })

  it('evaluates the shape SDF in the main pass for the material and its normals', () => {
    expect(studioFragmentMainShader).toContain('mainSDF(gl_FragCoord.xy)')
    expect(studioFragmentMainShader).toContain('getNormal(')
    for (const uniform of SHAPE_UNIFORMS) expect(studioFragmentMainShader).toContain(uniform)
  })

  it('caps the SDF loop at the shape count the component uploads', () => {
    expect(sdfLib).toContain('const int MAX_SHAPES = 16;')
    // Both bounds are required: inactive/stale array tails must not contribute,
    // and a caller's excessive count must not read beyond the uploaded arrays.
    expect(sdfLib).toContain('for (int index = 0; index < MAX_SHAPES; ++index)')
    expect(sdfLib).toContain('if (index >= u_shapeCount) break;')
  })
})

/**
 * The background shader declares u_shadowPosition and deliberately does not read
 * it, so the shadow it draws is centred on each shape rather than offset. That is a
 * knowing divergence from the attributed upstream revision, kept because applying
 * the offset would change rendered output and needs its own decision.
 *
 * These tests pin all three halves of that state so it cannot drift silently:
 * the declaration stays (it records the upstream contract), the read stays absent
 * (output is unchanged), and the cull margin keeps budgeting for the offset (so
 * honouring it later cannot under-reach). Verified against a real WebGL2 context:
 * the uniform is not among the linked program's active uniforms, its location is
 * null, and stripping the declaration is byte-identical across a full four-pass
 * render. If you are here because you want the offset applied, that is a rendered
 * output change: get it approved, then rewrite these tests on purpose.
 */
describe('studio shadow offset contract', () => {
  it('declares the upstream shadow-position uniform', () => {
    expect(studioFragmentBgShader).toContain('uniform vec2 u_shadowPosition;')
  })

  it('does not offset the shadow by it, so the declaration costs no output change', () => {
    // The shadow term reads the merged SDF at the raw fragment coordinate. Any
    // offset would have to appear here, and there is nothing else it could apply to.
    expect(studioFragmentBgShader).toContain('float merged = mainSDF(gl_FragCoord.xy) / u_dpr;')
    const shadowTerm = studioFragmentBgShader
      .split('\n')
      .filter((line) => line.includes('u_shadow') && !line.trim().startsWith('uniform'))
    expect(shadowTerm).toHaveLength(1)
    expect(shadowTerm[0]).not.toContain('u_shadowPosition')
  })

  it('budgets the declared offset into the off-canvas cull margin', () => {
    // The component derives OFFSCREEN_MARGIN from the shader's own shadow constants
    // including the offset, so the margin stays correct whether or not the shader
    // honours it. Erring wide only ever keeps a surface that could have been culled.
    expect(studioGlassSource).toContain('const SHADOW_POSITION: [number, number] = [0, 10]')
    expect(studioGlassSource).toContain('Math.abs(SHADOW_POSITION[1])')
  })
})

/**
 * The corner edge is antialiased from the SDF's own screen-space gradient, and this
 * pins the two properties that made the shipped version look jagged. Both were
 * measured with the real shader at device pixel ratios 1.0, 1.25, 1.5 and 2.0.
 *
 * A fixed smoothstep band in CSS pixels widened with the ratio -- about one device
 * pixel at 1.0 but three at 2.0 -- so a sharper display got a softer edge. And
 * because the superellipse field is not Euclidean, its gradient falls from 1.0 on
 * the axes to about 0.84 on the diagonal, so a fixed band in field units covered
 * more pixels there: the ramp ran 1 to 3 device pixels around a single arc at 1.25.
 * Uneven edge width around one corner is what the eye reads as jagged.
 *
 * Dividing the field by its own gradient length converts it to a true distance in
 * device pixels, which fixes both at once and needs no band constant.
 */
describe('studio corner antialiasing contract', () => {
  const mainBody = studioFragmentMainShader.slice(studioFragmentMainShader.indexOf('void main()'))

  it('derives edge coverage from the field gradient rather than a fixed band', () => {
    expect(mainBody).toContain('float coverage = clamp(0.5 - merged / max(gradient, 1e-5), 0.0, 1.0);')
    // A constant band is the defect, in either pixel space. Reintroducing one would
    // restore the ratio-dependent softness this replaced.
    expect(mainBody).not.toMatch(/smoothstep\(\s*-?\d/u)
    expect(mainBody).not.toContain('filmTint')
    expect(mainBody).toContain('split - baseScene')
    expect(mainBody).toContain('textureLod(u_blurredBg, sampleUv + disperseUv, 0.0)')
    expect(mainBody).toContain('dispersionSetting')
  })

  it('computes the gradient before the early-out so it stays defined', () => {
    // Derivatives are evaluated across a 2x2 quad, and a fragment outside the shape
    // is a helper invocation for its neighbours inside it. Taking the derivative
    // after a discarding return puts it in non-uniform control flow, where GLSL ES
    // leaves the result undefined -- which shows up as speckled corner pixels on
    // some drivers and nothing at all on others.
    const gradientLine = mainBody.indexOf('float gradient = length(vec2(dFdx(merged), dFdy(merged)))')
    const earlyOut = mainBody.indexOf('return;')
    expect(gradientLine).toBeGreaterThan(-1)
    expect(earlyOut).toBeGreaterThan(gradientLine)
  })

  it('keeps the early-out cull that skips fragments outside every shape', () => {
    // Coverage reaches zero before the cull distance, so the cull still costs no
    // visible edge. It is load-bearing for performance and must survive.
    expect(mainBody).toMatch(/if \(merged >= 1\.0\) \{[^}]*return; \}/u)
  })
})

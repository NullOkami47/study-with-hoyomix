/**
 * Numeric policy for Studio Liquid Glass edge refraction and chromatic dispersion.
 * The fragment shader inlines the same constants. Keep the two in step: the shader
 * test fails if a constant here disappears from the GLSL.
 *
 * Distances are CSS pixels. Multiplying by device pixel ratio and dividing by the
 * framebuffer resolution converts them to UV, so a high-DPI screen does not grow
 * the physical fringe.
 */
export const STUDIO_OPTICS = {
  maxRefractionCssPx: 5.5,
  maxDispersionCssPx: 5,
  referenceDispersion: 7,
  dispersionCapCssPx: 5.5,
  dispersionCeiling: 12,
  rimPower: 1.2,
} as const

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * CSS reports the specified radius, so a pill authored as 999px is not clamped.
 * A rounded-rect field treats that as a real corner radius. On a short capsule the
 * corners then sit outside the box and the only pixels still inside are the centre
 * line. The used radius is what CSS actually paints: half the shorter side.
 */
export function studioCornerRadiusCss(specifiedCssPx: number, widthCssPx: number, heightCssPx: number): number {
  const width = finite(widthCssPx)
  const height = finite(heightCssPx)
  if (width === null || height === null || width <= 0 || height <= 0) return 0
  const limit = Math.min(width, height) / 2
  const specified = finite(specifiedCssPx)
  if (specified === null || specified < 0) return Math.min(12, limit)
  return Math.min(specified, limit)
}

/**
 * Settings percentage (0..100) to the shader's dispersion control.
 * Zero stays zero so the slider can turn the rim off. Values above 100 clamp.
 */
export function studioEdgeDispersion(percent: number): number {
  const value = finite(percent)
  if (value === null || value <= 0) return 0
  return (Math.min(100, value) / 100) * STUDIO_OPTICS.dispersionCeiling
}

/** 1 at the glass boundary, 0 once the surface is a full thickness inside. */
export function studioRimMask(depthCssPx: number, thicknessCssPx: number): number {
  const depth = finite(depthCssPx)
  const thickness = finite(thicknessCssPx)
  if (depth === null || thickness === null || thickness <= 0) return 0
  const rim = Math.min(1, Math.max(0, 1 - Math.max(0, depth) / thickness))
  return rim ** STUDIO_OPTICS.rimPower
}

/**
 * R-to-B separation at this point, in CSS pixels.
 * Zero when dispersion is off, at the centre, or given a non-finite input.
 */
export function studioDispersionCssPx(
  refDispersion: number,
  depthCssPx: number,
  thicknessCssPx: number,
  calm = 1,
): number {
  const setting = finite(refDispersion)
  const calmFactor = finite(calm)
  if (setting === null || setting <= 0 || calmFactor === null || calmFactor <= 0) return 0
  const scaled = Math.min(setting, STUDIO_OPTICS.dispersionCeiling) / STUDIO_OPTICS.referenceDispersion
  const pixels = STUDIO_OPTICS.maxDispersionCssPx * scaled * studioRimMask(depthCssPx, thicknessCssPx) * Math.min(calmFactor, 1)
  if (!Number.isFinite(pixels) || pixels <= 0) return 0
  return Math.min(pixels, STUDIO_OPTICS.dispersionCapCssPx)
}

/** Refraction displacement along the outward-opposite normal, capped in CSS pixels. */
export function studioRefractionCssPx(edgeFactor: number, rim: number): number {
  const factor = finite(edgeFactor)
  const mask = finite(rim)
  if (factor === null || mask === null || factor <= 0 || mask <= 0) return 0
  const pixels = Math.min(factor * 7.5, STUDIO_OPTICS.maxRefractionCssPx) * Math.min(mask, 1)
  return Number.isFinite(pixels) ? pixels : 0
}

/** Device-pixel UV delta for a CSS-pixel offset. Never NaN. */
export function studioCssPixelsToUv(cssPixels: number, dpr: number, resolution: number): number {
  const pixels = finite(cssPixels) ?? 0
  const ratio = finite(dpr)
  const size = finite(resolution)
  if (ratio === null || size === null || ratio <= 0 || size <= 0) return 0
  const uv = pixels * ratio / Math.max(size, 1)
  return Number.isFinite(uv) ? uv : 0
}

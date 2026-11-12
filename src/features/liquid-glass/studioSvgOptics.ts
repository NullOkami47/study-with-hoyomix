/** Original Studio native-backdrop optical policy (GPL-3.0); no upstream code. */
export const STUDIO_SVG_OPTICS = Object.freeze({
  defaultEdge: 68,
  defaultScale: 48,
  maxScale: 64,
  referenceTileScale: 56,
})

/**
 * Map the existing Edge setting to feDisplacementMap's scale, in CSS pixels.
 * The same-origin rim tiles have neutral centres; do not rescale/rebuild them.
 * The SVG displacement equation multiplies this by (channel - 0.5), so the
 * default maximum offset is about 24px and the ceiling about 32px, not 48/64px.
 * This adjusts pixels only; StudioGlassEnvironment remains the sole lifecycle owner.
 */
export function studioSvgRefractionScale(edgePercent: number, baseScale = 56): number {
  if (!Number.isFinite(baseScale) || baseScale <= 0) return 0
  const edge = Number.isFinite(edgePercent) ? Math.min(100, Math.max(0, edgePercent)) : STUDIO_SVG_OPTICS.defaultEdge
  const scale = edge <= STUDIO_SVG_OPTICS.defaultEdge
    ? edge / STUDIO_SVG_OPTICS.defaultEdge * STUDIO_SVG_OPTICS.defaultScale
    : STUDIO_SVG_OPTICS.defaultScale + (edge - STUDIO_SVG_OPTICS.defaultEdge)
      / (100 - STUDIO_SVG_OPTICS.defaultEdge) * (STUDIO_SVG_OPTICS.maxScale - STUDIO_SVG_OPTICS.defaultScale)
  return scale * Math.min(1, baseScale / STUDIO_SVG_OPTICS.referenceTileScale)
}

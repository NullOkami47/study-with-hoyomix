/**
 * Adapted from liquid-glass-studio src/shaders/lib/sdf.glsl at
 * d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
export const sdfLib = `const int MAX_SHAPES = 16;
uniform int u_shapeCount;
uniform vec2 u_shapeCenters[16];
uniform vec2 u_shapeSizes[16];
uniform float u_shapeRadius[16];
uniform float u_shapeRoundness[16];

float superellipseCornerSDF(vec2 p, float r, float n) { p = abs(p); return pow(pow(p.x, n) + pow(p.y, n), 1.0 / n) - r; }
float roundedRectSDF(vec2 p, vec2 center, float width, float height, float cornerRadius, float n) {
  p -= center;
  vec2 halfSize = vec2(width, height) * 0.5;
  // A 999px pill radius is larger than a short capsule. Unclamped, the corner
  // centres leave the box and only the centre line stays inside.
  float cr = min(max(cornerRadius, 0.0), min(halfSize.x, halfSize.y));
  vec2 d = abs(p) - halfSize;
  if (cr > 0.5 && d.x > -cr && d.y > -cr) {
    vec2 cornerCenter = sign(p) * (halfSize - vec2(cr));
    return superellipseCornerSDF(p - cornerCenter, cr, n);
  }
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
/*
 * Hard union, deliberately. The reference this was adapted from unions a cluster of
 * decorative blobs that are meant to flow together, and a smooth minimum is right for
 * that. Here the shapes are application windows -- a top bar, a player, a chat window, a
 * modal hub -- and a smooth minimum spends the gaps between them filling itself in.
 *
 * The cost was measurable rather than theoretical. The field is evaluated in device
 * pixels while the merge radius was passed in CSS pixels, so at dpr 1 (which low-power
 * and reduced-motion both force) a 4px gap resolved to a half-opaque bridge and a 2px gap
 * to a fully opaque one: two surfaces became one irregular polygon with concave fillets
 * at the seams. min() has no radius to get wrong and no unit to disagree about.
 *
 * Surfaces that genuinely overlap still share pixels, which is the union working. Which
 * surface owns an overlapped region is decided before this shader sees the shapes -- see
 * collectGlassShapes in StudioGlassCanvas.vue -- because one field cannot express two
 * layers, and a layer is exactly what a modal above the workspace is.
 */
float mainSDF(vec2 p) {
  float result = 1e6;
  // One uniform-bounded loop keeps the field evaluation in source order without
  // duplicating sixteen copies of the corner material in every normal sample.
  // Keep the fixed array cap even if a caller supplies an excessive shape count.
  for (int index = 0; index < MAX_SHAPES; ++index) {
    if (index >= u_shapeCount) break;
    result = min(result, roundedRectSDF(p, u_shapeCenters[index], u_shapeSizes[index].x, u_shapeSizes[index].y, u_shapeRadius[index], u_shapeRoundness[index]));
  }
  return result;
}
`

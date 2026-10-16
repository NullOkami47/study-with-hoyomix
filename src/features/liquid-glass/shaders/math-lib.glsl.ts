/**
 * GLSL math helpers adapted from liquid-glass-studio
 * src/shaders/lib/math.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
export const mathLib = `float safeAsin(float x) {
  return asin(clamp(x, -1.0, 1.0));
}
`

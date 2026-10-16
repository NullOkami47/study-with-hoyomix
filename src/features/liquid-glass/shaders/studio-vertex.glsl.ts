/**
 * Full-screen quad vertex shader adapted from liquid-glass-studio
 * src/shaders/vertex.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
export const studioVertexShader = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

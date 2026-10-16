/**
 * Studio horizontal background blur shader adapted from liquid-glass-studio
 * src/shaders/fragment-bg-hblur.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
export const studioFragmentBgHblurShader = `#version 300 es
precision highp float;

#define MAX_BLUR_RADIUS (200)

in vec2 v_uv;

uniform sampler2D u_prevPassTexture;
uniform vec2 u_resolution;
uniform int u_blurRadius;
uniform float u_blurWeights[MAX_BLUR_RADIUS + 1];

out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / u_resolution;
  vec4 color = texture(u_prevPassTexture, v_uv) * u_blurWeights[0];
  for (int i = 1; i <= u_blurRadius; ++i) {
    float w = u_blurWeights[i];
    vec2 offset = vec2(float(i)) * texelSize;
    color += texture(u_prevPassTexture, v_uv + vec2(offset.x, 0.0)) * w;
    color += texture(u_prevPassTexture, v_uv - vec2(offset.x, 0.0)) * w;
  }
  fragColor = color;
}
`

/**
 * Studio background shader adapted from liquid-glass-studio
 * src/shaders/fragment-bg.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 *
 * On `u_shadowPosition`: it is declared and deliberately never read, so this port
 * draws a shadow centred on each shape instead of the upstream offset one. It is
 * kept rather than deleted because it records the upstream contract this file is
 * attributed to, and because applying the offset changes rendered output, which
 * wants its own decision rather than arriving as a silent cleanup. Keeping it costs
 * nothing: verified against a real WebGL2 context, it is absent from the linked
 * program's active uniforms, its location is null, and stripping the declaration is
 * byte-identical across a full four-pass render, so `setUniform` finds no location
 * and returns without touching the GPU. `StudioGlassCanvas.vue` still budgets the
 * offset into its off-canvas cull margin so that honouring it later cannot
 * under-reach. All three facts are pinned by `studio-pass-graph.spec.ts`; the
 * reasoning is in `the original development notes`.
 */
import { sdfLib } from './sdf.glsl'

export const studioFragmentBgShader = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_shadowExpand;
uniform float u_shadowFactor;
uniform vec2 u_shadowPosition; // declared, deliberately unread: see the file header
uniform sampler2D u_sceneTexture;
uniform vec2 u_sceneTextureSize;

${sdfLib}

void main() {
  vec2 u_resolution1x = u_resolution.xy / u_dpr;
  // Sample the scene image (cover-fit) so the glass refraction has real content to work with.
  float canvasAspect = u_resolution.x / u_resolution.y;
  float texAspect = u_sceneTextureSize.x / u_sceneTextureSize.y;
  vec2 uv = v_uv;
  if (canvasAspect > texAspect) {
    float scale = texAspect / canvasAspect;
    uv.y = uv.y * scale + 0.5 - 0.5 * scale;
  } else {
    float scale = canvasAspect / texAspect;
    uv.x = uv.x * scale + 0.5 - 0.5 * scale;
  }
  // Match SceneBackdrop's scale(1.01) so glass and DOM samples share landmarks.
  uv = (uv - 0.5) / 1.01 + 0.5;
  vec3 bgColor = texture(u_sceneTexture, uv).rgb;


  // Compute shadow under glass shapes
  float merged = mainSDF(gl_FragCoord.xy) / u_dpr;
  float shadow = exp(-1.0 / u_shadowExpand * abs(merged)) * 0.6 * u_shadowFactor;

  fragColor = vec4(bgColor - vec3(shadow), 1.0);
}
`

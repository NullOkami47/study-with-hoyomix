/**
 * Production refraction material adapted from liquid-glass-studio
 * src/shaders/fragment-main.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 *
 * Edge chromatic dispersion is part of the backdrop sample, not a stroke. The
 * numeric caps live in ../studioOptics.ts and are inlined below so a unit test
 * can pin them. Foreground UI is DOM above this canvas and is never sampled.
 */
import { sdfLib } from './sdf.glsl'
import { mathLib } from './math-lib.glsl'
import { STUDIO_OPTICS } from '../studioOptics'

const glslFloat = (value: number): string => Number.isInteger(value) ? value.toFixed(1) : String(value)

export const studioFragmentMainShader = `#version 300 es
precision highp float;
#define PI 3.14159265359
in vec2 v_uv;
uniform sampler2D u_blurredBg;
uniform sampler2D u_bg;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform vec4 u_tint;
uniform float u_refThickness;
uniform float u_refFactor;
uniform float u_refDispersion;
uniform float u_refFresnelRange;
uniform float u_refFresnelFactor;
uniform float u_refFresnelHardness;
uniform float u_glareRange;
uniform float u_glareConvergence;
uniform float u_glareOppositeFactor;
uniform float u_glareFactor;
uniform float u_glareHardness;
uniform float u_glareAngle;
uniform int u_blurEdge;
uniform int u_blurRadius;
// Neutral-grey wash over the refracted colour, 0..1. Owner-approved appearance
// control; see docs and the Settings "Glass grey" slider. Applied to the material
// colour only, so the specular fresnel and glare terms below stay bright.
uniform float u_glassGray;
out vec4 fragColor;
${sdfLib}
${mathLib}
const float OPTIC_MAX_REFRACTION_CSS_PX = ${glslFloat(STUDIO_OPTICS.maxRefractionCssPx)};
const float OPTIC_MAX_DISPERSION_CSS_PX = ${glslFloat(STUDIO_OPTICS.maxDispersionCssPx)};
const float OPTIC_REFERENCE_DISPERSION = ${glslFloat(STUDIO_OPTICS.referenceDispersion)};
const float OPTIC_DISPERSION_CAP_CSS_PX = ${glslFloat(STUDIO_OPTICS.dispersionCapCssPx)};
const float OPTIC_DISPERSION_CEILING = ${glslFloat(STUDIO_OPTICS.dispersionCeiling)};
const float OPTIC_RIM_POWER = ${glslFloat(STUDIO_OPTICS.rimPower)};

vec2 getNormal(vec2 p) {
  float e = max(1.0, u_dpr);
  float dx = mainSDF(p + vec2(e, 0.0)) - mainSDF(p - vec2(e, 0.0));
  float dy = mainSDF(p + vec2(0.0, e)) - mainSDF(p - vec2(0.0, e));
  vec2 gradient = vec2(dx, dy);
  float gradientLength = length(gradient);
  return gradientLength > 0.00001 ? gradient / gradientLength : vec2(0.0);
}
float normalAngle(vec2 normal) {
  float angle = atan(normal.y, normal.x);
  return angle < 0.0 ? angle + 2.0 * PI : angle;
}
void main() {
  float merged = mainSDF(gl_FragCoord.xy) / u_dpr;
  // Screen-space gradient of the field, taken before the cull below because
  // derivatives are undefined in non-uniform control flow: an outside fragment is
  // still a helper invocation for the 2x2 quad of an inside one.
  float gradient = length(vec2(dFdx(merged), dFdy(merged)));
  if (merged >= 1.0) { fragColor = vec4(0.0); return; }

  float depth = max(-merged, 0.0);
  float thickness = max(u_refThickness, 0.001);
  // Once rim displacement and both lighting terms are exactly zero, the body
  // is the blurred scene plus its existing tint/grey mixes. Repeating normal,
  // refraction and wavelength samples cannot change it. Keep the derivative
  // above all divergent branches, and retain the full material for lit bodies.
  // pow(x, 5.0) is undefined GLSL for x < 0, even with an odd exponent.
  // Clamping the base first preserves clamp(x^5, 0, 1) for finite real x,
  // while preventing a backend's magnitude power from lighting deep bodies.
  float fresnelRange = max(u_refFresnelRange, 0.001);
  float fresnelGeo = clamp(pow(max(1.0 + merged / 1500.0 * pow(500.0 / fresnelRange, 2.0) + u_refFresnelHardness, 0.0), 5.0), 0.0, 1.0);
  float glareRange = max(u_glareRange, 0.001);
  float glareGeo = clamp(pow(max(1.0 + merged / 1500.0 * pow(500.0 / glareRange, 2.0) + u_glareHardness, 0.0), 5.0), 0.0, 1.0);
  // Both framebuffer inputs contain only level zero and use LINEAR for min/mag.
  // Explicit LOD preserves that sampling while avoiding implicit derivatives in
  // the material's divergent branches (and their helper-invocation work).
  if (depth >= thickness && fresnelGeo == 0.0 && glareGeo == 0.0) {
    vec3 colour = textureLod(u_blurredBg, v_uv, 0.0).rgb;
    colour = mix(colour, u_tint.rgb, clamp(u_tint.a * 0.8, 0.0, 1.0));
    colour = mix(colour, vec3(0.5), clamp(u_glassGray, 0.0, 1.0) * 0.55);
    float coverage = clamp(0.5 - merged / max(gradient, 1e-5), 0.0, 1.0);
    fragColor = vec4(clamp(colour, 0.0, 1.0), coverage);
    return;
  }
  float ratio = 1.0 - depth / thickness;
  float thetaI = safeAsin(ratio * ratio);
  float thetaT = safeAsin(sin(thetaI) / max(u_refFactor, 1.001));
  float edgeFactor = depth >= thickness ? 0.0 : max(-tan(thetaT - thetaI), 0.0);
  vec2 normal = getNormal(gl_FragCoord.xy);
  float rim = clamp(1.0 - depth / thickness, 0.0, 1.0);
  float rimMask = pow(max(rim, 0.0), OPTIC_RIM_POWER);
  float body = clamp(depth / thickness, 0.0, 1.0);

  float refractionCss = min(edgeFactor * 7.5, OPTIC_MAX_REFRACTION_CSS_PX) * rimMask;
  refractionCss += min(edgeFactor * 1.35, 1.15) * rim * (1.0 - body);

  float dispersionSetting = clamp(u_refDispersion, 0.0, OPTIC_DISPERSION_CEILING);
  if (u_refDispersion <= 0.0) dispersionSetting = 0.0;
  // The shipped blur is 16. Penalising that made the default fringe invisible.
  float blurCalm = clamp(1.0 - max(float(u_blurRadius) - 18.0, 0.0) / 36.0, 0.75, 1.0);
  float greyCalm = clamp(1.0 - u_glassGray * 0.35, 0.65, 1.0);
  float dispersionCss = min(
    OPTIC_MAX_DISPERSION_CSS_PX * (dispersionSetting / OPTIC_REFERENCE_DISPERSION) * rimMask * blurCalm * greyCalm,
    OPTIC_DISPERSION_CAP_CSS_PX
  );

  vec2 pxToUv = u_dpr / max(u_resolution, vec2(1.0));
  vec2 refractUv = -normal * refractionCss * pxToUv;
  vec2 disperseUv = -normal * dispersionCss * pxToUv;
  vec2 sampleUv = v_uv + refractUv;
  if (any(isnan(sampleUv)) || any(isinf(sampleUv))) sampleUv = v_uv;
  if (any(isnan(disperseUv)) || any(isinf(disperseUv))) disperseUv = vec2(0.0);

  // Wavelength split follows the rim normal. Red and blue move opposite ways;
  // green stays on the geometric sample so the body recombines.
  vec3 sharp = vec3(
    textureLod(u_bg, sampleUv + disperseUv * 0.55, 0.0).r,
    textureLod(u_bg, sampleUv, 0.0).g,
    textureLod(u_bg, sampleUv - disperseUv * 0.45, 0.0).b
  );
  vec3 soft = vec3(
    textureLod(u_blurredBg, sampleUv + disperseUv * 0.20, 0.0).r,
    textureLod(u_blurredBg, sampleUv, 0.0).g,
    textureLod(u_blurredBg, sampleUv - disperseUv * 0.16, 0.0).b
  );
  // The dispersion lives on the rim, and that fringe has to be the blurred
  // plate. A sharp rim sample kept the separated colours crisp.
  float blurMix = u_blurEdge > 0 ? 1.0 : body;
  vec3 refracted = mix(sharp, soft, clamp(blurMix, 0.0, 1.0));
  vec3 colour = mix(refracted, u_tint.rgb, clamp(u_tint.a * 0.8, 0.0, 1.0));
  // 0.55 keeps the strongest setting a smoked grey rather than a flat opaque panel.
  colour = mix(colour, vec3(0.5), clamp(u_glassGray, 0.0, 1.0) * 0.55);

  float fresnel = max(fresnelGeo, pow(rimMask, 0.72));
  float facing = clamp((-normal.x * 0.42 + normal.y * 0.91) * 0.5 + 0.5, 0.0, 1.0);
  float fresnelGain = fresnel * clamp(u_refFresnelFactor, 0.0, 1.0) * (0.34 + 0.66 * facing);
  colour += vec3(0.72, 0.80, 0.88) * fresnelGain * 0.24;

  float glareAngle = (normalAngle(normal) - PI / 4.0 + u_glareAngle) * 2.0;
  bool farSide = glareAngle > PI * 1.5 && glareAngle < PI * 3.5;
  float glare = (0.5 + sin(glareAngle) * 0.5) * (farSide ? u_glareOppositeFactor : 1.0) * u_glareFactor;
  glare = clamp(pow(max(glare, 0.0), 0.1 + u_glareConvergence * 2.0), 0.0, 1.0) * glareGeo;
  colour = mix(colour, vec3(1.0), glare * 0.72);

  // The fringe is the blurred backdrop, split along the rim normal. A new
  // picture still changes the colours, but the separated light is soft.
  vec3 baseScene = textureLod(u_blurredBg, sampleUv, 0.0).rgb;
  vec3 redScene = textureLod(u_blurredBg, sampleUv + disperseUv, 0.0).rgb;
  vec3 blueScene = textureLod(u_blurredBg, sampleUv - disperseUv, 0.0).rgb;
  vec3 split = vec3(redScene.r, baseScene.g, blueScene.b);
  float backdropChange = clamp(length(redScene - blueScene) * 6.0, 0.0, 1.0);
  float dispersionMix = u_refDispersion <= 0.0 ? 0.0 : clamp(dispersionSetting / OPTIC_REFERENCE_DISPERSION, 0.0, 1.6);
  float rimWeight = pow(max(rimMask, 0.0), 1.4);
  colour = mix(colour, split, clamp(rimWeight * min(dispersionMix, 1.0), 0.0, 0.85));
  colour += (split - baseScene) * rimWeight * backdropChange * dispersionMix * 2.5;

  // Dividing the field by its own gradient converts it into a true distance in
  // device pixels, so the edge is one device pixel wide at every ratio and at every
  // angle around a corner. The superellipse field alone is neither: its gradient
  // varies about 16% between the axes and the diagonal, and it is scaled to CSS
  // pixels, so any constant band drew a wider, more uneven edge the sharper the
  // display got. Centred on 0.5 rather than starting there, so the visible edge sits
  // on the geometric boundary instead of half a pixel inside it.
  float coverage = clamp(0.5 - merged / max(gradient, 1e-5), 0.0, 1.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0), coverage);
}
`

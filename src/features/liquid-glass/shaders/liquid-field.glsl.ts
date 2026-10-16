/** Original single-pass procedural field for the Study with HOYO-MiX integration. */
export const liquidFieldFragmentShader = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;

float glow(vec2 point, vec2 centre, float radius) {
  float distanceFromCentre = length(point - centre);
  return 1.0 - smoothstep(0.0, radius, distanceFromCentre);
}

void main() {
  vec2 point = v_uv - 0.5;
  point.x *= u_resolution.x / max(u_resolution.y, 1.0);

  float phase = u_time * 0.12;
  float cyan = glow(point, vec2(sin(phase) * 0.42, cos(phase * 0.73) * 0.22), 0.72);
  float violet = glow(point, vec2(cos(phase * 0.81) * -0.48, sin(phase * 0.61) * -0.28), 0.64);
  float pearl = glow(point, vec2(sin(phase * 0.37) * 0.18, cos(phase * 0.49) * 0.34), 0.42);

  vec3 colour = vec3(0.018, 0.028, 0.055);
  colour += vec3(0.035, 0.34, 0.31) * cyan * 0.7;
  colour += vec3(0.20, 0.10, 0.42) * violet * 0.62;
  colour += vec3(0.21, 0.36, 0.43) * pearl * 0.28;

  float vignette = 1.0 - smoothstep(0.18, 0.92, length(v_uv - 0.5));
  fragColor = vec4(colour * (0.72 + vignette * 0.28), 1.0);
}
`

/**
 * Original WGSL equivalent of this feature's single-pass procedural field.
 * Its device/context/pipeline shape follows liquid-glass-studio's GPUUtils.ts;
 * attribution for that adapted integration pattern is retained in ../NOTICE.md.
 */
export const liquidFieldWgslShader = `
struct Globals {
  resolution: vec2f,
  time: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> globals: Globals;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let position = positions[vertexIndex];
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = position * 0.5 + vec2f(0.5);
  return output;
}

fn glow(point: vec2f, centre: vec2f, radius: f32) -> f32 {
  return 1.0 - smoothstep(0.0, radius, length(point - centre));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  var point = input.uv - vec2f(0.5);
  point.x *= globals.resolution.x / max(globals.resolution.y, 1.0);

  let phase = globals.time * 0.12;
  let cyan = glow(point, vec2f(sin(phase) * 0.42, cos(phase * 0.73) * 0.22), 0.72);
  let violet = glow(point, vec2f(cos(phase * 0.81) * -0.48, sin(phase * 0.61) * -0.28), 0.64);
  let pearl = glow(point, vec2f(sin(phase * 0.37) * 0.18, cos(phase * 0.49) * 0.34), 0.42);

  var colour = vec3f(0.018, 0.028, 0.055);
  colour += vec3f(0.035, 0.34, 0.31) * cyan * 0.7;
  colour += vec3f(0.20, 0.10, 0.42) * violet * 0.62;
  colour += vec3f(0.21, 0.36, 0.43) * pearl * 0.28;

  let vignette = 1.0 - smoothstep(0.18, 0.92, length(input.uv - vec2f(0.5)));
  return vec4f(colour * (0.72 + vignette * 0.28), 1.0);
}
`

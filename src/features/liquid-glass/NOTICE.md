# Liquid Glass renderer notice

This feature contains a limited port from **liquid-glass-studio**:

- Repository: <https://github.com/iyinchao/liquid-glass-studio>
- Adapted source revision: [`d13c3e53813ebc1d8b52d878071b63212a550ebc`](https://github.com/iyinchao/liquid-glass-studio/tree/d13c3e53813ebc1d8b52d878071b63212a550ebc)
- Upstream licence: MIT
- Upstream copyright: Copyright (c) 2024 Charles Yin

## Adapted upstream pieces

The adapted files are listed below. Every materially adapted renderer or shader source file carries an inline source header with the upstream revision; this directory notice retains the complete licence terms and the file mapping.

- `src/utils/GLUtils.ts` shader/program, framebuffer, render-pass, texture-uniform, and multipass lifecycle -> `renderer/MultiPassRenderer.ts`, with project-specific cleanup, failure containment, texture detection, and resource-boundary changes.
- `src/shaders/vertex.glsl` -> `shaders/studio-vertex.glsl.ts`.
- `src/shaders/fragment-bg.glsl` -> `shaders/studio-fragment-bg.glsl.ts`, adapted to sample the project scene texture.
- `src/shaders/fragment-bg-vblur.glsl` -> `shaders/studio-fragment-bg-vblur.glsl.ts`.
- `src/shaders/fragment-bg-hblur.glsl` -> `shaders/studio-fragment-bg-hblur.glsl.ts`.
- `src/shaders/fragment-main.glsl` -> `shaders/studio-fragment-main.glsl.ts`; the production shader keeps the final refraction/blur/fresnel/glare material path rather than the upstream editor's debug-step branches, and renders only inside semantic DOM glass shapes.
- `src/shaders/lib/color.glsl` -> `shaders/color-lib.glsl.ts`.
- `src/shaders/lib/math.glsl` -> `shaders/math-lib.glsl.ts`.
- `src/shaders/lib/sdf.glsl` -> `shaders/sdf.glsl.ts`; the shape array is statically unrolled to 16 project semantic surfaces for WebGL driver compatibility.
- The earlier single-pass renderer adaptations remain in `renderer/WebGlRenderer.ts`, `renderer/WebGpuRenderer.ts`, and `shaders/fullscreen.glsl.ts`.

`StudioGlassCanvas.vue` and its CSS are original Vue integration code. They map existing semantic controls to shader shapes, load the project scene asset, lower render density for low-power or `prefers-reduced-motion`, suspend scheduled rendering while the document is hidden, and retain a CSS fallback whenever WebGL2, shader compilation/linking, texture allocation, or rendering fails.

No upstream images, video, demo media, React controls/components, or editor UI are included. The multipass renderer and shader material code listed above **are** adapted upstream code and are covered by the attribution in this notice.

The combined Study with HOYO-MiX work is distributed under GPL-3.0. The following MIT notice is retained for the adapted upstream portions.

## MIT License

Copyright (c) 2024 Charles Yin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Studio native renderer

## Ownership and integration

`StudioGlassEnvironment.vue` replaces (does not wrap) `GlassEnvironment.vue` for
Studio in AppShell. Props: `enabled = true`, `edge = 68`, `blurRadius = 16`,
`glassGray = 26`. AppShell passes the existing preference values. It consumes the
shared resolver and `REFRACTION_DEFAULT_ON`; reduced transparency, increased
contrast and forced colours block refraction in that resolver.

Both `StudioGlassCanvas` mounts and the FocusBar/PlayerBar `useGlassRefraction`
calls are removed. Their refs and `data-glass-hero` attributes remain. The
retained Canvas module has a tested `enabled=false` lifecycle
guard for historical callers; it is not a fallback used by the new renderer.

The controller discovers heroes, overlay sheets, advanced filters, chat windows,
queue drawers and sleep popovers, plus `[data-studio-glass-surface]`. Only visible,
positioned shells are selected, capped at six. Nested scrolling cards remain
native CSS; a descendant popover wholly outside its parent's painted box has its
own optical shell. A scrolled shell temporarily returns to CSS. The overlay is
an absolutely positioned non-interactive child, not a layout wrapper.

### CSS contract

Only after all same-origin tiles decode and the filter exists does a host receive
`data-studio-glass-ready="true"`. While ready:

- Host background must be transparent and both backdrop-filter properties none,
  including removal of older `!important` rules. Do not give the host opacity<1.
- Keep its existing positioning/stacking context. The overlay is `inset:0`,
  `z-index:-1`, pointer-events:none and aria-hidden; it never changes host geometry.
- The theme applies a 22% neutral tint and restrained directional highlight to
  the overlay, with a feathered centre tint below foreground content.
- `--studio-native-blur` maps the Blur preference to one eighth of its value,
  capped at 4px (2px at the default). Heavy blur erases rim detail.
- Component publishes/restores `--studio-blur` (px), `--studio-gray` (0..1), plus
  legacy `--studio-glass-blur`, `--studio-glass-gray-strength`,
  `--studio-edge-strength` aliases. Studio material tokens are scoped in glass.css.
- Old `data-glass-refract=ready` is never set. Do not apply its url filters too.

## Optical/privacy/CSP implementation

One SVG displacement pass samples the live browser backdrop. Dynamic geometry
assembles at most eight existing first-party `/glass/refraction/*.png` tiles per
surface. Nearest-radius corner tiles are uniformly scaled to the actual clamped
radius; edges use the same bezel scaling. This supports arbitrary dialog sizes
without a new decoder, frame readback, media CORS changes, or full-screen texture.
The centre is neutral; a component-transfer half-byte correction makes 128/255
exactly 0.5 before displacement. No RGB channel separation/rainbow shader.

No `data:`/`blob:` resource, HTML capture, canvas, WebGL, scene sampler, telemetry,
external runtime resource, or animation loop. At most one bounded resize timer
coalesces events; six ResizeObserver targets and a filtered mutation observer.
Tile decode failures are cached for the controller lifetime (no retry storms).
Visibility, disable, removal, stale asynchronous decode and unmount release
readiness/filters/overlays/listeners. Edge=0 updates scale without engine restart.
Firefox/WebKit use the shared native CSS fallback; no alternate WebGL backend.

### Integrated lifecycle and optics (2026-11-01)

The integrated mapping uses `defaultScale = 48`, `maxScale = 64`. Product optical
tests require an edge-band difference of at least 3 and centre difference at most
0.5, with ON/OFF/ON captures checking scene drift. The scale-24 synthetic fixture
below is historical, separate evidence.

Direct host scrolling clears ready synchronously. Ancestor reveal and transition
completion trigger discovery; removing a selector releases its existing record.
A startup-failure latch selects `native-css` without repeated allocations.
Cinematic owns its original renderer independently; an abort signal stops pending
WebGPU initialisation or fallback allocation after that owner unmounts.

## Pinned candidate evaluation

Inspected `lucaperullo/simple-liquid-glass` at
`39b75a897b78b13f7f8a01162ad433bce7dbcad0` (package version 5.6.0):

| Source at that exact revision | Finding and decision |
| --- | --- |
| `package.json`, `LICENSE` | MIT, copyright 2025 lucaperullo; React peers optional and a framework-neutral Web Component exists. Rejecting it merely because this app is Vue would be incorrect. |
| `src/web-component/index.ts` | Registers `<liquid-glass>` with shadow-root holder/glass/border/filter elements and style injection; generates data-URI displacement maps; offers SVG and WebGL paths. This is not a drop-in overlay on existing shells. |
| `src/core/renderer.ts` | `supportsSvgBackdrop` limits URL filters to Chromium; `wantsWebGL` selects WebGL for non-SVG engines even when the requested renderer is SVG, unless effect is blur/off. Different from our required native-only fallback. |
| `src/core/DisplacementFilter.tsx` | Uses data-URI map images and optional RGB dispersion/material stages. Our strict `img-src 'self'` does not admit these images. |
| `src/backdrop/capture.ts` | Source review only: captures HTML and live media through canvas, image decoding and data URLs; explicitly sets image crossOrigin anonymous. This is not the executed Web Component's captured module chain, nor proof of compatibility with this app's cross-origin video. |
| `src/core/webgl/directScene.ts` | Source review only, outside the executed Web Component bundle: can consume existing video/canvas and requestVideoFrameCallback. It is incorrect to claim every upstream path creates a second decoder; this path still adds WebGL textures/buffers/frame work and origin-clean constraints. |
| `src/core/webgl/source.ts` | HTML capture/cache/section refresh machinery adds scope and lifecycle ownership absent from our no-capture compositor approach. |

### Actual primary-candidate execution: three bounded configurations

The standalone Web Component experiment is now complete, superseding the earlier
source-only evaluation. `npm pack simple-liquid-glass@5.6.0 --ignore-scripts`
provided the extracted, unmodified `dist/web-component.esm.js`; no global install,
upstream code incorporation or CSP change was made. Tarball integrity matched:

`sha512-0cDJXREWqI9mA1CxE2VGvXDQsfWQWz1ogwxQCf7iJdyX8y3fg+ced9G/BkMSdsHXqTtG31rWBNmptN7Hu2D6qA==`

The executed bundle's SHA-256 was
`f46a18151c5c08eaf17c504826b899665225e294ec2c54890e978872925cf218`.
The npm metadata supplied no `gitHead`: do not claim it established the commit.
Instead, all **36 project-source contents** in its source map matched the exact
repository revision above byte-for-byte. Eight dependency-source entries were
outside that comparison; this was not a reproducible-build verification.

Chrome 156.0.8078.74, 1024x600, DPR 1 ran the public Web Component API over one
origin-clean synthetic live video, with a native CSS reference alongside it.
The sibling video was already playing before the candidate was appended.
Every configuration made four loopback requests; external runtime requests were
blocked. The HTTP policy retained `script-src 'self'; style-src 'self';
img-src 'self'`, with no nonce/hash, inline-style, data or blob exemption.

| Configuration | Observed strategy / reason | Actual CSP violations | Actual candidate glass box |
| --- | --- | --- | --- |
| `renderer=svg`, `effect-mode=svg` | `svg` / none | `style-src-elem: inline`; `img-src: data` | 420x0, `position: static` |
| `renderer=svg`, `effect-mode=blur` | `blur` / none | `style-src-elem: inline` | 420x0, `position: static` |
| `renderer=webgl`, `effect-mode=svg` | `blur` / `capture-failed` | `style-src-elem: inline`; `img-src: data` | 420x0, `position: static` |

The injected shadow `<style>` was blocked, so the glass layer lost its absolute
positioning and height. SVG's self-reported strategy did not prove successful
refraction. Even the package's blur fallback retained the blocked style
dependency. The WebGL attempt really allocated a context/canvas but failed to
produce active refraction under this policy. Its executed chain included
`src/core/webgl/runtime.ts`, `src/core/webgl/source.ts` and
`src/vendor/ybouane/HtmlCapture.ts`.

The native CSS reference measured 420x300 with the expected blur in every case.
All three videos had `readyState=4`, `paused=false` and advancing currentTime;
each page contained exactly one video. This demonstrates the CSP incompatibility
of the unmodified candidate, **not** a second decoder or a CORS failure. The
source was origin-clean; arbitrary cross-origin media, native Firefox/WebKit
and a Vue wrapper were not tested. No relaxed-policy beauty/performance ranking
is claimed.

### Gentpan source review versus the existing paths

`gentpan/liquidglass` was inspected at
`068ad226f53e1ca62d857f78bdc32f58f3c5fce7` (MIT, copyright 2026 gentpan).
This was **pinned source review only**, not a fourth executable experiment:

- `lib/liquid-glass.js` defaults to filtering an element's own pixels; aligned
  image copies provide its cross-browser image refraction. Its `lensMap()` uses
  `canvas.toDataURL('image/png')` and image preloading for `feImage`. A conflict
  with self-only image CSP is an inference from this source and the primary
  experiment, not a captured gentpan violation.
- `lib/components.js` distinguishes image-copy, Chromium backdrop and native-blur
  fallback paths. Image-copy support is not evidence of arbitrary live-video
  backdrop support.
- `lib/glass-webgl.js` provides a separate video/canvas renderer, uploads source
  pixels to textures and redraws through RAF when started. Its source explicitly
  requires CORS/crossorigin for cross-origin media. It can accept an existing
  video; a second decoder is not inherent.

The old StudioGlassCanvas multipass/image-texture path is historical and must
not run beside the native engine. The current first-party path instead keeps
same-origin tiles, one native backdrop displacement pass and CSS fallback without
media readback. Gentpan's native-backdrop concept is relevant, but its unmodified
data-map/video-WebGL paths do not meet this task's constraints. That is an
architecture/policy assessment, not a measured performance rejection.

Decision: retain the useful native-compositor concept, but use the project's own
same-origin tile assets and a small original overlay controller. No code/assets
from either candidate were copied into the implementation or product bundle, so
no new upstream attribution is required.
The existing historical renderer NOTICE and MIT headers remain intact.

## Historical native synthetic capture: scale 24, not current-product proof

`node src/features/liquid-glass/studioNativeRenderer.browser.mjs` bundles only the
controller, serves a loopback fixture under unchanged `script-src 'self';
style-src 'self'; img-src 'self'` restrictions and drives installed Chrome. It
uses one synthetic live video (test canvas captureStream, never production
capture), freezes it for Edge=68/0 A/B, then resumes it. Results/screenshots go
to this directory's untracked `.validation/`.

The preserved pre-commit capture used an earlier baseline implementation
of scale 24, not a post-change rerun:
**Edge=68, displacement scale=24**
(then `defaultScale=24`, `maxScale=32`), compared against Edge=0. Chrome
156.0.8078.74 measured mean absolute RGB differences: rim 61.17, centre 0.00,
moving rim 101.94; zero CSP violations, all 12 requests loopback, one video,
zero renderer canvases.

These figures describe only that captured geometric synthetic video. They must
not be relabelled as results for the parent's current scale 48/64, the actual
product band threshold, or subsequent lifecycle fixes. They establish the old
fixture's live refraction and neutral centre, not final product contrast, GPU
cost or premium visual quality. A rerun after changing scale is new evidence,
not a refresh of the old measurements. Product bright/dark/live scenes,
modal/scrolling/isolation behaviour and final tests remain the integration
owner's acceptance gates. Desktop default was not enabled on this fixture's
strength, and this docs-only update runs no browser tests.

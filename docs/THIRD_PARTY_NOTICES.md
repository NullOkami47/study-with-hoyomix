# Third-party notices

## Combined work licence

Study with HOYO-MiX is a derivative work of StudyWithMiku and is distributed under the GNU General Public License, version 3.0. The complete GPL-3.0 text is supplied in the repository's [LICENSE](../LICENSE). Any incorporated Liquid Glass Studio renderer code remains attributed under its MIT terms; the combined distributed work remains GPL-3.0.

## StudyWithMiku

- Repository: <https://github.com/shshouse/StudyWithMiku>
- Imported source revision: [`7b094632d08a6599a1b334e6c6af41dc10ea6495`](https://github.com/shshouse/StudyWithMiku/tree/7b094632d08a6599a1b334e6c6af41dc10ea6495)
- Licence: [GNU General Public License v3.0](https://github.com/shshouse/StudyWithMiku/blob/main/LICENSE)
- Copyright notice: Copyright (c) shshouse. The upstream README identifies shshouse as the project lead.

## liquid-glass-studio

- Repository: <https://github.com/iyinchao/liquid-glass-studio>
- Adapted source revision: [`d13c3e53813ebc1d8b52d878071b63212a550ebc`](https://github.com/iyinchao/liquid-glass-studio/tree/d13c3e53813ebc1d8b52d878071b63212a550ebc)
- Licence: [MIT License](https://github.com/iyinchao/liquid-glass-studio/blob/main/LICENSE)
- Copyright notice: Copyright (c) 2024 Charles Yin.
- Adapted paths: `src/utils/GLUtils.ts`, `src/utils/GPUUtils.ts`, `src/shaders/vertex.glsl`, `src/shaders/fragment-bg*.glsl`, `src/shaders/fragment-main.glsl`, and `src/shaders/lib/{color,math,sdf}.glsl`.
- Feature notice and retained MIT terms: [`src/features/liquid-glass/NOTICE.md`](../src/features/liquid-glass/NOTICE.md).

Only the limited renderer/shader pieces named above are adapted. No upstream sample image, video, demo media, React component, studio control, or editor code is included.

## Upstream acknowledgements

StudyWithMiku credits APlayer (https://github.com/DIYgod/APlayer) and Meting
(https://github.com/qijie233/MetingApi-qijie). The legacy APlayer bundles and
standalone Meting compatibility service are not included in this distribution.

## quickjs-emscripten (LX source sandbox)

The LX source sandbox executes third-party LX user scripts inside a dedicated Web Worker hosting a QuickJS WebAssembly runtime. Two direct dependencies provide it, and a third MIT package is pulled in transitively by both.

- Packages: `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-asyncify` (both pinned to version `0.32.0`)
- Upstream project: <https://github.com/justjake/quickjs-emscripten>
- Licence: [MIT License](https://github.com/justjake/quickjs-emscripten/blob/main/LICENSE)
- Copyright notice: quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis
- Transitive package: `@jitl/quickjs-ffi-types` `0.32.0`, same upstream project and MIT licence. It is a dependency of both packages above and is not used directly by this project.
- Usage: `quickjs-emscripten-core` supplies the QuickJS runtime API and `@jitl/quickjs-wasmfile-release-asyncify` supplies the asyncify WebAssembly build it loads. Both are consumed as unmodified npm dependencies; no upstream source is copied into this repository. The sandbox is reached only through `src/features/player/lx/runtime/` (typed RPC client, module Worker, QuickJS host) and is bounded by the memory, stack, call-timeout, RPC-payload, and bridged-response limits fixed in `src/features/player/lx/runtime/protocol.ts`.

## Mediabunny

Admin background video conversion and server MP4 inspection use
[Mediabunny](https://github.com/Vanilagy/mediabunny), version 1.61.1, by Vanilagy,
under the Mozilla Public License 2.0 (MPL-2.0). Its complete licence is retained in
[the dependency licence collection](licenses/runtime-dependencies.txt). Encoding
uses the browser's WebCodecs implementation, in an admin-only dedicated Worker.


## OpenCC JavaScript

- Package: `opencc-js`, pinned to `1.4.2`, by The nk2028 Project.
- Upstream: https://github.com/nk2028/opencc-js
- Code licence: MIT, copyright (c) 2020-2021 The nk2028 Project.
- Dictionary data: generated from `opencc-data`, under Apache License 2.0.
- Usage: unmodified browser ESM core and Chinese/Hong Kong dictionary subpaths,
  loaded on demand for presentation-only track title script conversion. No DOM
  converter, Japanese dictionary, native binary or runtime CDN fetch is used.
- Licence texts: [MIT](licenses/opencc-js-MIT.txt) and
  [upstream third-party notices / Apache 2.0](licenses/opencc-js-THIRD-PARTY.txt).

## Public source edition

Modified on 2026-10-16 for a standalone public source distribution; see the root
NOTICE for upstream attribution and modification information. No soundtrack,
artwork or game wallpaper is included. Media integration code is supplied for
operators to use only with content and services they are entitled to use.

The search-fold mapping in `src/features/catalog/hanFold.ts` is generated using
OpenCC over fixed public Unicode BMP CJK ranges, independently of any catalogue. The OpenCC MIT and Apache 2.0 dictionary notices above also apply to that
mapping. Its generator is a maintenance aid rather than a media dataset.
## Locked runtime dependency notices

Complete MIT, ISC, BSD and MPL texts for the installed direct and transitive
runtime packages are preserved in [runtime-dependencies.txt](licenses/runtime-dependencies.txt).
This includes Vue/VueUse, Lucide (ISC and Feather-derived MIT portions), QuickJS
and quickjs-emscripten, Mediabunny, and the supporting runtime packages. OpenCC
Apache dictionary terms are additionally retained in the separate notice above.
These notices retain upstream authorship information required by their licences.

Mediabunny 1.61.1 is used unmodified under MPL-2.0, not MIT. Its source files are
included in the versioned npm package installed by `npm ci`, at
`node_modules/mediabunny/src/`. Corresponding upstream source and licence are
available at https://github.com/Vanilagy/mediabunny/tree/v1.61.1 and the exact npm
source distribution at https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.1.tgz.
Recipients may obtain and modify that source under MPL-2.0. No additional
restriction is imposed on the MPL-covered portions. The application source is
GPL-3.0; dependency portions retain their applicable original licence notices.
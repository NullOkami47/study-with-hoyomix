<div align="center">

<img src="public/pwa-icon.svg" width="128" height="128" alt="Study with HOYO-MiX icon" />

# Study with HOYO-MiX

**An unofficial, non-commercial fan-made study & focus music workspace featuring HOYO-MiX soundtracks.**

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh_CN.md">简体中文</a> |
  <a href="./README.zh_TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/NullOkami47/study-with-hoyomix/commits/main"><img src="https://img.shields.io/github/last-commit/NullOkami47/study-with-hoyomix/main?style=flat-square" alt="GitHub last commit" /></a>
  <a href="https://github.com/NullOkami47/study-with-hoyomix/stargazers"><img src="https://img.shields.io/github/stars/NullOkami47/study-with-hoyomix?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://app.study-with-hoyomix.workers.dev"><img src="https://img.shields.io/badge/Live_App-app.study--with--hoyomix.workers.dev-32b8c6?style=flat-square" alt="Live App" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white" alt="Vue 3.5" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.6" />
  <img src="https://img.shields.io/badge/Vite-8.3-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 8.3" />
  <img src="https://img.shields.io/badge/Cloudflare-Workers_%26_D1-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers & D1" />
</p>

<p align="center">
  <a href="#screenshots">Screenshots</a> •
  <a href="#capabilities">Capabilities</a> •
  <a href="#implemented">Implemented</a> •
  <a href="#planned-features">Planned Features</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#project-layout">Project Layout</a> •
  <a href="#credits">Credits</a> •
  <a href="#links">Links</a> •
  <a href="#license">License</a>
</p>

</div>

---

## 📝 Project Description

**Study with HOYO-MiX** ([`NullOkami47/study-with-hoyomix`](https://github.com/NullOkami47/study-with-hoyomix)) is the public open-source release of [`NullOkami47/hoyomix_web_player`](https://github.com/NullOkami47/hoyomix_web_player) — a calm, dark-mode study and focus web workspace built around a WebGPU / WebGL2 / CSS **Liquid Glass** interface, durable Pomodoro & sleep timers, multi-provider playback orchestration, anonymous-first local `IndexedDB` storage with optional OAuth cloud sync, and a Cloudflare Workers + D1 + R2 + Durable Objects edge backend.

The public production app is **[Study with HOYO-MiX](https://app.study-with-hoyomix.workers.dev)**, served by the Cloudflare Worker `app`.

- [Build & Local Setup Guide (`BUILDING.txt`)](https://github.com/NullOkami47/study-with-hoyomix/blob/main/BUILDING.txt)
- [Source & Licence Notices (`NOTICE`)](https://github.com/NullOkami47/study-with-hoyomix/blob/main/NOTICE)
- [Third-Party Open-Source Notices (`docs/THIRD_PARTY_NOTICES.md`)](docs/THIRD_PARTY_NOTICES.md)

> [!IMPORTANT]
> **Unofficial Fan Project & Public Open-Source Distribution Notice**
>
> - **Unofficial & Non-Commercial**: Study with HOYO-MiX is an independent, fan-made, non-commercial study companion. It is **not** affiliated with, endorsed, sponsored, or approved by HoYoverse / miHoYo / Cognosphere or HOYO-MiX. Game titles, characters, and music trademarks belong to their respective rightsholders.
> - **Media & Credentials Excluded**: The public source release deliberately includes **no soundtrack library, copyrighted artwork, animated game wallpapers, user records, default third-party music-source scripts, or live service credentials**. Its shipped initial catalogue (`src/features/catalog/catalog.production.json` and `src/features/catalog/catalog.sample.json`) and static background definitions (`src/features/backgrounds/staticDefinitions.ts`) are empty by default so self-hosting operators can supply media and service credentials they are entitled to use.

> [!WARNING]
> **Third-Party Music Sources & External Services**
>
> Third-party music sources (including user's personal ChKSz API keys, and opt-in external resolvers) depend on external services outside this project's control. Endpoints may fail due to rate limits, regional restrictions, DNS/certificate errors, or upstream changes. Importing or enabling third-party sources is entirely at the user's own discretion and responsibility; please comply with local law, platform terms of service, and music copyright.

<a id="screenshots"></a>
<a id="en-screenshots"></a>

## 📸 Screenshots

### Desktop screenshots

| Main page | Music library |
| :---: | :---: |
| ![Main page](docs/screenshots/desktop-workspace.png) | ![Music library](docs/screenshots/desktop-library.png) |

### Mobile screenshots

| Main page | Playback queue |
| :---: | :---: |
| ![Main page](docs/screenshots/mobile-workspace.png) | ![Playback queue](docs/screenshots/mobile-queue.png) |

<a id="capabilities"></a>
<a id="en-capabilities"></a>

## ⚡ Capabilities

| Area | What you can do |
| :--- | :--- |
| **Liquid Glass Workspace** | Study over a dual-slot crossfade video/poster backdrop (`1080p30` default, optional `1440p30` companion with automatic frame-drop fallback) rendered beneath a multi-pass WebGPU / WebGL2 optical refraction shader (`StudioGlassCanvas`, `LiquidGlassCanvas`) with resilient CSS fallback |
| **Durable Timers & Focus Logs** | Run monotonic-clock Pomodoro cycles (`focus`, `short-break`, `long-break`) with an optional break pause-lease for the player, configure a durable sleep timer (`15` / `30` / `45` / `60` / `90` min or custom), and review daily streaks in `StudyCalendar` |
| **Catalogue & Smart Queue** | Filter tracks by game (`genshin`, `hsr`, `zzz`), listening mode (`sleep`, `focus`, `chill`), and relation (`place`, `character`, `npc`, `faction`, `event`), search titles/aliases across Simplified & Traditional Chinese via `opencc-js`, and reorder a virtualised non-modal queue |
| **Multi-Provider Playback** | Resolve tracks across Worker-governed and client providers (`r2`, `jellyfin`, `youtube`, `chksz`, `meting`, `gd-studio`, `huanyin`, `qijie`, `piped`, `invidious`, `lx`, `lx-user`) with automatic fallback, MediaSession controls, and live latency/error diagnostics |
| **QuickJS Custom Source Sandbox** | Import LX Music-compatible JavaScript sources and execute them inside an isolated Web Worker + `quickjs-emscripten-core` WebAssembly runtime (`src/features/player/lx/runtime/`) with strict memory, stack, timeout, and payload ceilings |
| **Local-First Library & OAuth Sync** | Persist favourites, custom playlists, recent playback history (opt-in, capped at 100 entries), and preferences in native `IndexedDB` / `localStorage`, or sign in with **Google**, **GitHub**, and **LINUX DO** to sync across devices via Cloudflare D1 |
| **Realtime Presence & Admin Console** | See live online listener counts and chat via the `OnlineCounter` Cloudflare Durable Object, and manage catalogue revisions, Google Sheets imports, R2 background transcoding (`mediabunny` + WebCodecs), notices, and provider health in `AdminShell` |

<a id="implemented"></a>
<a id="en-implemented"></a>

## ✨ Implemented

#### Player, Queue & Quality Model

- **Compact & Expandable `PlayerBar`**: Single-row default with provenance-safe artwork, canonical track title, active provider badge, play/pause, and next; expands in-place to reveal seek bar, buffer progress, volume, queue trigger, source selector, and `PlaybackDiagnostics`.
- **Non-Modal Resizable `QueuePanel`**: Retains `Shuffle` and `Repeat` states in the header, renders `Previously Played` above a fixed `Now Playing` row, virtualises `Up Next` for long queues, and supports 44 px pointer/keyboard reordering plus desktop width/height resizing.
- **Sheet Suspension Invariant**: Opening modal sheets (`SettingsSheet`, `LibrarySheet`, `ControlCentre`) cleanly suspends active official YouTube IFrame media and restores playback intent on close without layout shift or duplicate resume events.
- **Quality Selection (`src/features/player/qualityPreferences.ts`)**:
  - **ChKSz tiers (`src/shared/chksz.ts`)**: `standard`, `exhigh`, `lossless`, `hires`, `jyeffect`, `sky`, `jymaster`.
  - **LX tiers**: `standard`, `high`, `lossless`, `hires`.
  - Unavailable target tiers degrade gracefully to playable resources while reporting the actual resolved quality metadata.

#### Third-Party Music Sources & Security Boundaries

- **Local Consent Gate**: Third-party resolvers (`chksz`, `lx-user`, etc.) require explicit local user agreement (`ThirdPartyAgreement.vue`) and can be toggled in Settings.
- **QuickJS WASM Runtime (`src/features/player/lx/runtime/`)**: Executes user scripts inside a dedicated module Worker using `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-asyncify` (`0.32.0`), enforcing deterministic memory, stack, call-timeout, and bridged-response limits defined in `protocol.ts`.
- **ChKSz Personal Credential Support**: Supports user-supplied `chksz_` API keys (registered via `api.chksz.com` with a LinuxDo account) alongside Worker-side SSRF/origin validation (`src/shared/chksz.ts`).

<a id="planned-features"></a>
<a id="en-planned-features"></a>

## 🗂️ Planned Features (Creating New Folder...)

- **Chatroom**: Real-time study lounge chatroom & interactive community features
- **More Tracks (including Fan-Made Music)**: Expanded soundtrack selection including fan-made arrangements
- **More Third-Party Music Providers**: Add support for more third-party music providers, such as LX Music
- **Better Liquid Glass UI**: Enhanced optical refraction shaders, surface depth, and visual polish
- **ZZZ TV UI Style**: Zenless Zone Zero CRT / TV-array inspired retro-futuristic interface theme
- **Genshin Impact UI Style**: A Genshin Impact-inspired interface theme
- **Honkai: Star Rail UI Style**: A Honkai: Star Rail-inspired interface theme
- **Smooth Transitions **: Seamless audio crossfades and visual transitions across tracks and scenes
- **Smart Mixing **: Intelligent tempo/envelope-aware track mixing (AutoMix)

<a id="tech-stack"></a>
<a id="en-tech-stack"></a>

## 🛠️ Tech Stack

| Layer | Implementation |
| :--- | :--- |
| **UI & Reactivity** | Vue 3.5 (Composition API, `<script setup>`), `@vueuse/core`, TypeScript 5.6, Vite 8.3 |
| **Glass & Styling** | Custom CSS Design Tokens (`src/styles/tokens.css`), Multi-Pass WebGPU / WebGL2 Shaders (`src/features/liquid-glass/`), Lucide Vue Next |
| **Playback & Media** | `HTMLAudioElement`, Official YouTube IFrame Player API, MediaSession API, `mediabunny` 1.61.1 (WebCodecs MP4 inspection & transcode) |
| **Custom Source Sandbox** | Web Worker + QuickJS WebAssembly (`quickjs-emscripten-core` & `@jitl/quickjs-wasmfile-release-asyncify` `0.32.0`) |
| **Search & Localisation** | Trilingual i18n (`en`, `zh-Hans`, `zh-Hant`), `opencc-js` 1.4.2 + precomputed CJK Han-folding (`src/features/catalog/hanFold.ts`) |
| **Local Persistence** | Native browser `IndexedDB` (`src/features/library/localRepository.ts`, `src/features/focus/localRepository.ts`), `localStorage` (`src/utils/safeStorage.ts`), PWA (`vite-plugin-pwa`) |
| **Edge Backend & Storage** | Cloudflare Workers (`workers/index.ts`), Durable Objects (`workers/online-counter.js`), Cloudflare D1 (SQLite), Cloudflare R2 |
| **Authentication & Security** | OAuth 2.0 / OIDC (Google, GitHub, LINUX DO), HMAC-SHA256 Session Cookies & Media Tickets, Strict Origin / CSRF / SSRF Guards |
| **Testing & Tooling** | Vitest, `@vue/test-utils`, `fake-indexeddb`, `jsdom`, Miniflare, Wrangler 4 |

<a id="quick-start"></a>
<a id="en-quick-start"></a>

## 🚀 Quick Start

#### 1. Prerequisites

- **Node.js** `22.18.0` or newer (**Node.js 24 LTS** recommended)
- **npm** (bundled with Node.js)
- **Git**

#### 2. Install & Run Frontend Development

```bash
# Install exact locked dependencies from package-lock.json
npm ci

# Start the local Vite development server (automatically decodes PWA icons & generates build info)
npm run dev
```

Common verification and build scripts:

```bash
npm run typecheck     # Generate build info and run vue-tsc + tsc type checking
npm test              # Run frontend unit and component tests via Vitest
npm run test:workers  # Run Cloudflare Worker + D1 integration tests via Miniflare/Vitest
npm run build         # Decode PWA icons, generate build info, and build production bundle into dist/
npm run preview       # Preview the built frontend locally
npm run verify        # Run typecheck, frontend tests, Worker tests, and production build
```

#### 3. Local Sign-In Button Preview (`HOYOMIX_DEV_AUTH_PREVIEW`)

Normal `npm run dev` leaves authentication requests to the downstream backend. To preview all three sign-in buttons (`Google`, `GitHub`, `LINUX DO`) without authenticating, explicitly set `HOYOMIX_DEV_AUTH_PREVIEW=1` in the development server's process environment:

```powershell
$env:HOYOMIX_DEV_AUTH_PREVIEW = '1'
try { npm run dev } finally { Remove-Item Env:HOYOMIX_DEV_AUTH_PREVIEW }
```

```sh
HOYOMIX_DEV_AUTH_PREVIEW=1 npm run dev
```

Only the exact value `1` enables this mock; absent, `0`, and `true` leave it off. Do not add it to checked-in environment files; Vite `.env` files do not enable it. It applies only to the Vite development server in `development` mode, never production or staging builds, deployed environments, or `npm run preview`, even when the flag is set.

The mock handles only exact `GET /api/auth/providers` (three available providers), `GET /api/session` (signed-out `401`), and `GET /api/auth/{google,github,linuxdo}/start` (plain-text `501` stating OAuth did not occur). Query strings, including identity-linking queries, are accepted. Responses carry `X-Hoyomix-Dev-Auth-Mock: 1`; JSON responses also contain `mock: true`. Starts do not redirect, create cookies or tokens, sign in, or link identities. Other methods and routes, including trailing slashes and callbacks, continue downstream.

#### 4. Recreate the PWA Icons

The install icons are stored in Git as text-only Base64 sources (`scripts/pwa-icons/pwa-icon-192.png.base64.txt` and `scripts/pwa-icons/pwa-icon-512.png.base64.txt`) so code-review systems that reject binary patches can still carry the complete PWA change. The generated PNG files are intentionally ignored.

Run the decoder directly when you need the raster files:

```bash
npm run generate:pwa-icons
```

`npm run dev` and `npm run build` run the decoder automatically. The decoder validates the Base64 syntax, PNG signature, declared dimensions, and SHA-256 digest before writing `public/pwa-icon-192.png` and `public/pwa-icon-512.png`.

#### 5. Complete Local Worker + D1 Backend Environment

To run the complete local Cloudflare Worker + frontend environment:

1. Copy `.dev.vars.example` to `.dev.vars` (ignored by Git).
2. Generate independent `SESSION_HMAC_SECRET` and `OAUTH_STATE_SECRET` values in `.dev.vars`, each at least 32 random bytes. Never use client-side `VITE_` variables for secrets.
3. Optional OAuth & Owner bootstrap: configure provider credentials (`GOOGLE_*`, `GITHUB_*`, `LINUXDO_*`) in `workers/auth/types.ts` / `workers/index.ts` and explicit owner identity via `OWNER_PROVIDER` and `OWNER_SUBJECT`, or leave them unset to keep sign-in providers disabled.
4. Initialise the local D1 database, build the frontend, and start Wrangler:

```bash
npm run d1:migrate:local
npm run build
npm run dev:worker
```

Open `http://localhost:8787`. The checked-in `wrangler.toml` identifies local resources only.

#### 6. Supplying Your Own Media (Open-Source Release)

Because the public release deliberately ships with an empty catalogue and background list:

- **Music Catalogue**: Populate `src/features/catalog/catalog.production.json` (and `catalog.sample.json`) conforming to `src/features/catalog/schema.ts`, or administer catalogue revisions and optional Google Sheets imports through `workers/catalogue/`. To regenerate the optional Han folding table after adding catalogue text, run `node scripts/generate-han-fold-table.mjs`.
- **Music Providers**: Configure opt-in server-side providers in `src/features/player/providers/registry.ts`, `workers/providers/routing.ts`, `workers/providers/config.ts`, and `workers/index.ts` with your own Jellyfin, R2, or resolver resources.
- **Background Stage**: To add redistributable static backgrounds, update `src/features/backgrounds/staticDefinitions.ts` and place the referenced files under `public/`. Uploaded dynamic backgrounds require an explicitly configured `BACKGROUND_BUCKET` R2 binding.

<a id="project-layout"></a>
<a id="en-project-layout"></a>

## 📁 Project Layout

```text
study-with-hoyomix/
├── docs/
│   ├── licenses/                 # MIT, Apache-2.0 & runtime dependency licence texts
│   └── THIRD_PARTY_NOTICES.md    # Upstream & third-party attribution notices
├── migrations/                   # Cloudflare D1 SQLite migrations (0001–0028)
├── public/                       # PWA manifests, robots.txt, SVG icon & title cache helper
├── scripts/
│   ├── pwa-icons/                # Base64-encoded 192px & 512px PNG icon sources
│   ├── generate-build-info.mjs   # Build metadata generator
│   ├── generate-han-fold-table.mjs # OpenCC CJK search-folding table generator
│   ├── generate-pwa-icons.mjs    # Verified Base64-to-PNG icon decoder
│   └── public-notices.ts         # Vite plugin serving /legal/*.txt notices
├── src/
│   ├── components/shell/         # Accessible AppShell landmark & skip-link frame
│   ├── features/
│   │   ├── account/              # OAuth session, identity linking & D1 preference/library sync
│   │   ├── admin/                # AdminShell, catalogue/background/notice/provider managers
│   │   ├── backgrounds/          # Dual-slot video/poster store, overrides & staticDefinitions.ts
│   │   ├── catalog/              # Schema validation, multi-dimensional filters, OpenCC & Han fold
│   │   ├── chat/                 # FloatingChatWindow & safe-dock layout geometry
│   │   ├── focus/                # Pomodoro recorder, StudyCalendar & local/remote repositories
│   │   ├── legal/                # FanProjectNotice store & component
│   │   ├── library/              # MusicLibrary, AlbumCard, IndexedDB repository & merge dialog
│   │   ├── liquid-glass/         # WebGPU/WebGL2 multi-pass shaders, StudioGlassCanvas & NOTICE.md
│   │   ├── notices/              # System NoticeCentre & NoticeHistory
│   │   ├── player/               # PlayerBar, QueuePanel, QuickJS LX sandbox & provider adapters
│   │   ├── settings/             # Unified 8-section SettingsSheet, LxSourceManager & agreements
│   │   ├── timers/               # Durable monotonic-clock Pomodoro & SleepTimer stores
│   │   └── workspace/            # StudyWorkspace root, FocusBar, ControlCentre, SceneBackdrop
│   ├── i18n/                     # Trilingual messages (en, zh-Hans, zh-Hant)
│   ├── pwa/                      # Service worker registration, install & update status
│   ├── shared/                   # Shared ChKSz validation, matcher & version signature logic
│   ├── stores/                   # Workspace preferences store
│   ├── styles/                   # Liquid Glass CSS custom properties (tokens.css)
│   ├── test/                     # Frontend unit, attribution, runtime & Vite config specs
│   ├── types/                    # TypeScript environment declarations
│   └── utils/                    # Safe storage wrapper
├── tests/fixtures/               # Tiny synthetic MP4 & poster fixtures for video validation tests
├── workers/
│   ├── account/                  # User preference sync handlers
│   ├── admin/                    # Role-gated admin API routes & authorization
│   ├── auth/                     # Google, GitHub & LINUX DO OAuth/OIDC flows & session signing
│   ├── backgrounds/              # R2 background media & MP4 bitstream validation routes
│   ├── catalogue/                # D1 catalogue staging, diffing, publication & Google Sheets import
│   ├── focus/                    # Focus session sync routes
│   ├── library/                  # Cloud library sync routes
│   ├── providers/                # Server-side audio provider config, SSRF guards & routes
│   ├── test/                     # Miniflare Worker + D1 security & integration test suites
│   ├── index.ts                  # Main Cloudflare Worker fetch & scheduled handler
│   ├── online-counter.js         # OnlineCounter Durable Object (WebSocket presence & chat)
│   └── presence.ts               # Presence routing helpers
├── BUILDING.txt                  # Local development and Worker setup instructions
├── LICENSE                       # GNU General Public License v3.0
├── NOTICE                        # Source, modification & copyright notices
└── wrangler.toml                 # Local Cloudflare Workers, D1, R2 & Durable Objects config
```

<a id="credits"></a>
<a id="en-credits"></a>

## 🙏 Credits

- https://github.com/lladlam/MeloX-Android
- https://github.com/iyinchao/liquid-glass-studio
- https://github.com/shshouse/StudyWithMiku

<a id="links"></a>
<a id="en-links"></a>

## 🔗 Links

- [LINUX DO](https://linux.do/)

<a id="license"></a>
<a id="en-license"></a>

## 📄 License & Attribution

The implementation baseline is derived from [StudyWithMiku](https://github.com/shshouse/StudyWithMiku) at commit [`7b094632d08a6599a1b334e6c6af41dc10ea6495`](https://github.com/shshouse/StudyWithMiku/tree/7b094632d08a6599a1b334e6c6af41dc10ea6495). Study with HOYO-MiX is licensed under **GPL-3.0**; see [LICENSE](LICENSE), [NOTICE](https://github.com/NullOkami47/study-with-hoyomix/blob/main/NOTICE), and [third-party notices](docs/THIRD_PARTY_NOTICES.md).

The post-MVP LLM classification system is intentionally separated from the MVP plans. No upstream media is included until its provenance is independently verified and recorded.

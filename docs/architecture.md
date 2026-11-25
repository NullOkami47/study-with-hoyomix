# Study with HOYO-MiX — Architecture Overview

This document describes the architecture of the public open-source distribution of **Study with HOYO-MiX**.

## 1. Frontend Architecture (`src/`)

The client is a Vue 3.5 + TypeScript single-page application bundled with Vite 8 and offline-capable PWA support (`vite-plugin-pwa`).

- **Workspace & Responsive Shell (`src/components/shell/`, `src/features/workspace/`)**:
  - `AppShell` provides accessible landmarks and skip navigation.
  - `StudyWorkspace` coordinates the ambient background stage (`SceneBackdrop`), focus bar (`FocusBar`), glass control centre (`ControlCentre`), floating/docked chat surface, and modal/drawer sheets (`SettingsSheet`, `LibrarySheet`, `QueueDrawer`).
- **Liquid Glass Rendering (`src/features/liquid-glass/`, `src/features/glass/`)**:
  - Supports multi-pass optical refraction shaders built on **WebGPU** (`WebGpuRenderer`) and **WebGL2** (`WebGlRenderer`) via `StudioGlassCanvas` / `LiquidGlassCanvas` / `AdaptiveGlassSurface`, plus a baked tile fallback (`public/glass/refraction/*.png`) and pure CSS custom-property fallback (`src/styles/tokens.css`) when GPU acceleration or reduced-transparency settings dictate it.
- **Music Player, Queue & Transitions (`src/features/player/`)**:
  - **Store (`store.ts`)**: Generation-fenced playback state machine with queue history, Fisher-Yates shuffle, repeat modes (`off`, `all`, `one`), monotonic pause/play intent preservation, transient retry scheduling, next-track preparation (`preloadPolicy.ts`), and unified same-track recovery (`requestSourceRecovery`: bounded 10-second URL renewal via `renewMedia` followed by fallback chain progression).
  - **Transitions (`transitionEngine.ts`)**: Supports `off`, `crossfade`, and `smart-mix` transitions (2–12 s configurable duration) with gain-envelope scheduling and immediate cancellation on user interruption, seek, backgrounding, or element mismatch.
  - **Dual-Element Native Handover (`PlayerBar.vue`)**: Manages active/standby `<audio>` elements, Android/mobile webkit background handoff watchdogs, Media Session metadata/action handlers, album artwork blob caching (`artworkCache.ts` + OPFS/Cache storage limits), and `PlaybackDiagnostics` attempt telemetry.
  - **QuickJS Custom Source Sandbox (`src/features/player/lx/`)**: Runs LX Music-compatible scripts inside an isolated module Web Worker (`quickjsHost.ts`) using `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-asyncify` with strict memory, stack, timer, payload, and CSP origin (`lxCspPolicy.ts`) enforcement.
- **Catalogue, Library & Search (`src/features/catalog/`, `src/features/library/`)**:
  - `schema.ts` validates tracks (`games`, `relationIds`, `tabs`, `vocalStatus`, `needsClassification`, `sources`). Note the Vocal tab filters vocal-classified tracks while Focus eligibility remains independent.
  - `opencc-js` (`chineseTitleConverter.ts`) + precomputed BMP Han folding (`hanFold.ts`) enable Simplified/Traditional Chinese title and alias matching without external API calls.
  - Personal favourites, playlists, and bounded playback history persist offline-first in `IndexedDB` (`library/localRepository.ts`), syncing optionally with D1 when authenticated.
- **Focus & Sleep Timers (`src/features/timers/`, `src/features/focus/`)**:
  - Monotonic-clock Pomodoro timer (`focus`, `short-break`, `long-break`) with break pause-lease integration and `StudyCalendar` / `focus/localRepository.ts` streak records.
  - Durable `SleepTimer` (presets and custom countdowns) that pauses playback cleanly without conflicting with recovery timers.
- **Admin Console (`src/features/admin/`)**:
  - Role-gated views (`owner`, `admin`, `moderator`) for managing provider order/health (`ProviderControls.vue`), global LX scripts (`LxGlobalSourceManager.vue`), D1 catalogue versions/diffs (`CatalogueManager.vue`), discovery triage & staging (`CatalogueDiscovery.vue`), R2 background video transcoding via WebCodecs + `mediabunny` (`backgroundTranscode.worker.ts`), notices, and chat moderation.

## 2. Cloudflare Worker Backend (`workers/`)

`workers/index.ts` handles authenticated reverse-proxy ingress (`proxyIngress.ts`), API security headers (`Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`), routing, and scheduled cron tasks.

- **Auth & Sessions (`workers/auth/`)**:
  - OAuth 2.0 / OIDC login flows for Google, GitHub, and LINUX DO with signed state tokens (`OAUTH_STATE_SECRET`), `__Host-session` HMAC-SHA256 cookies (`SESSION_HMAC_SECRET`), `AUTH_START_LIMITER` rate limiting, multi-identity linking, and RBAC (`owner`, `admin`, `moderator`, `user`).
- **Active Audio Providers (`workers/providers/`)**:
  - Active canonical providers: **ChKSz BYOK** (`chksz`), **LX Music** (`lx` via worker/global scripts or user scripts), and opt-in **GD Studio** (`gd-studio`).
  - Fully retired providers (`jellyfin`, `vkeys`) are excluded from active config, user preferences, and routing (`404`).
  - Legacy proxy/discovery adapters (`meting`, `piped`, `invidious`, `qijie`, `r2`, `lx-huanyin`, `lx-huibq`, `lx-ikun`) remain unregistered in the default client playback runtime (`runtimeConfig.ts`) and disabled unless explicitly configured; Worker routing/config entries are retained strictly for security-contract tests and D1 catalogue/discovery compatibility.
  - Server-side SSRF validation (`resolverMediaUrl.ts`), header redaction, same-origin transient media/artwork tickets (`transientMedia.ts`, `neteaseArtwork.ts`), and GD Studio container/MIME reconciliation (`gdStudio.ts`).
- **Global LX Registry (`workers/lx/`)**:
  - Owner-managed versioned LX source storage in D1 (`0031_lx_global_sources.sql`), `acorn` metadata header tokenisation (`globalSources.ts`), SHA-256 content hashes, and explicit origin allow-listing (`LX_ALLOWED_ORIGINS`).
- **Community Chat & Realtime Presence (`workers/chat/`, `workers/presence.ts`)**:
  - `ChatRoom` (SQLite-backed Durable Object, migration `community-chat-v1`) manages WebSocket fan-out, rate limiting, and alarm-driven retention/purge (`chat-retention`), backed by D1 tables (`0029_community_chat.sql`, `0030_chat_retention.sql`) for messages, versions, reports, user blocks, regex/keyword filters, bans, idempotency receipts, and audit logs (`chat.retention.update`).
  - `OnlinePresence` Durable Object (`presence-v1`) tracks anonymous/signed-in online listener counts and owner session revalidation independently of chat.
- **Catalogue Revisions, Discovery & Staging (`workers/catalogue/`, `migrations/`)**:
  - D1 migrations `0001`–`0033` govern user accounts, focus sessions, library sync, provider health, backgrounds, D1 catalogue revisions, LX global sources, chat moderation/retention, and discovery automation ledgers.
  - `tools/catalog-sync/` provides standalone Python CLI tooling (`catalog-sync`, `catalog-discover`) to inspect public music metadata into staging candidates without bundling proprietary datasets or cloud secrets.

## 3. Public Edition Boundaries

- **Empty Data Defaults**: `src/features/catalog/catalog.production.json`, `catalog.sample.json`, `public/catalogue/v1.json`, and `src/features/backgrounds/staticDefinitions.ts` ship empty by default.
- **No Private Infrastructure**: Deployment-specific Wrangler files (`wrangler.remote.toml`, `wrangler.staging.toml`), Azure scanner services, R2 media buckets, and live analytics/sheets credentials are omitted and replaced by explicit environment variables documented in `.dev.vars.example` and `.env.example`.

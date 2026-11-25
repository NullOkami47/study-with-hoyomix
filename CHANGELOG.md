# Changelog

All notable changes in the public open-source distribution of **Study with HOYO-MiX** are documented in this file.

## [2026-11-25] Public Synchronisation & Cleanup

### Added
- **Liquid Glass Studio Renderer & Adaptive Surfaces**: WebGPU / WebGL2 multi-pass optical refraction shaders (`StudioGlassCanvas`, `LiquidGlassCanvas`, `AdaptiveGlassSurface`), baked fallback refraction tiles (`public/glass/refraction/`), generator verification script (`scripts/generate-glass-refraction-tiles.mjs`), and adaptive reduced-transparency controls.
- **Background Playback & Handover Improvements**: Native `<audio>` element continuity and stall/handover recovery handling for mobile browsers (physical-device acceptance remains separately required per target device).
- **Track Preparation, Crossfade & Smart Mix**: Configurable `transitionEngine` (`off`, `crossfade`, `smart-mix`, 2–12 s) with gain-envelope scheduling and interruption cancellation, plus freshness-checked track preloading.
- **Community Chat & Durable Moderation**: `ChatRoom` SQLite Durable Object (`workers/chat/`), responsive & floating chat windows (`src/features/chat/`), idempotent send receipts, edit history, user blocks, bounded regex word filters, reporting, moderator role (`moderator`), and guarded D1/DO retention/purge recovery (`0029_community_chat.sql`, `0030_chat_retention.sql`).
- **Global LX Source Registry**: Owner-managed shared LX scripts with immutable content hashes, `acorn` (`8.15.0`, MIT) metadata extraction, rollback/versioning (`0031_lx_global_sources.sql`), and explicit build/Worker CSP origin gating (`LX_ALLOWED_ORIGINS`).
- **Vocal Tab & Catalogue Discovery Tooling**: Independent vocal classification filtering (`0023_focus_classification_independent.sql`), D1 discovery/staging schema & admin workflows (`0032_catalogue_discovery.sql`, `0033_catalogue_discovery_automation.sql`), GD Studio container/MIME verification, album artwork blob caching, and standalone Python metadata discovery package (`tools/catalog-sync/`).
- **Regression & Property Tests**: Expanded unit, `fast-check` property-based preservation, Miniflare D1/DO integration, and secret/dist bundle scanning scripts (`scripts/secret-scan.sh`, `scripts/dist-secret-scan.sh`).

### Changed
- **Unified Playback Recovery (`requestSourceRecovery`)**: Replaced Jellyfin-specific stall fallback hooks with provider-agnostic media URL renewal (`renewMedia`, 10-second cooldown) and automatic provider fallback chain progression (`chksz`, `lx`, `gd-studio`).
- **Realtime Presence Split**: Replaced legacy `OnlineCounter` Durable Object with `OnlinePresence` + `ChatRoom`.
- **Dependency & Build Maintenance**: Removed unused `@vueuse/core` dependency; added `acorn` (`8.15.0`) and `fast-check` (`4.10.2`); updated `vite-plugin-pwa` to `1.3.0`; updated documentation (`README*.md`, `BUILDING.txt`, `NOTICE`, `docs/THIRD_PARTY_NOTICES.md`, `docs/architecture.md`, `.dev.vars.example`, `.env.example`).

### Removed
- **Retired Jellyfin Runtime Paths**: Removed runtime Jellyfin provider adapters, routes, env configuration fields (`JELLYFIN_*`), UI toggles/diagnostics references, and automatic recovery paths (preserving `LegacyProviderId`, migration history `0021`, and catalogue validation compatibility for historical rows).
- **Private & Redundant Assets**: Excluded private deployment configs, operator scripts, local datasets/dumps, legacy `OnlineCounter`, private workflow tests (`test_workflow.py`), non-redistributable media, and internal references.

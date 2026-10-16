<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderAttempt, ResolveFailureCode } from './providers/types'
import type { PlaybackStore } from './store'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'

const props = defineProps<{ player: PlaybackStore }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

const enabledSources = computed(() => {
  const ids = props.player.manualProviderIds
    ? [...props.player.manualProviderIds.value]
    : (props.player.currentTrack.value?.sources
        .map(({ provider }) => provider)
        .filter((provider, index, sources) => new Set(props.player.enabledProviderIds.value).has(provider) && sources.indexOf(provider) === index) ?? [])
  // Retain an active override in selectable IDs so the dropdown preserves and displays
  // the user's manual choice even when the provider is in an error or unavailable state.
  const currentOverride = props.player.sourceOverride.value
  if (currentOverride && !ids.includes(currentOverride)) {
    ids.push(currentOverride)
  }
  return ids
})

// Presentation-only projection of the canonical provider ids. Attempt records keep the raw
// ids; the labels are brand names and are deliberately identical in every locale.
function providerName(id: string): string {
  if (id === 'chksz') return 'ChKSz BYOK'
  if (id === 'lx') return 'LX Music'
  if (id === 'jellyfin') return 'Jellyfin'
  if (id === 'youtube') return 'YouTube'
  if (id === 'r2') return 'R2'
  if (id === 'gd-studio') return 'GD Studio'
  if (id === 'lx-huanyin') return '幻音'
  return id
}

const LX_SUB_ATTEMPT_PREFIX = 'LX'
const MAX_SOURCE_NAME_LENGTH = 64

/**
 * A source name is read from an imported script's `@name` header, so it is untrusted input.
 * Strip control and format characters and angle brackets, collapse whitespace, and bound the
 * length so a hostile script cannot inject markup, spoof other lines, or flood the panel.
 */
function sanitizeSourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > MAX_SOURCE_NAME_LENGTH
    ? cleaned.slice(0, MAX_SOURCE_NAME_LENGTH)
    : cleaned
}

/**
 * Top-level attempts use the provider brand label. The composite LX provider records one
 * attempt per LX sub-source, shown as `LX / <source name>`; without a usable source name the
 * attempt degrades to the plain `LX Music` label.
 */
function attemptLabel(attempt: ProviderAttempt): string {
  if (attempt.providerId === 'lx') {
    const sourceName = sanitizeSourceName(attempt.sourceName)
    if (sourceName) return `${LX_SUB_ATTEMPT_PREFIX} / ${sourceName}`
  }
  return providerName(attempt.providerId)
}

// ChKSz failures carry more actionable copy than a bare status word, because each one implies a
// different next step for the listener. Other providers keep the compact label.
const CHKSZ_FAILURE_COPY: Partial<Record<ResolveFailureCode, TranslationKey>> = {
  invalid_credential: 'player.chkszErrorInvalidCredential',
  quota_exhausted: 'player.chkszErrorQuotaExhausted',
  forbidden: 'player.chkszErrorForbidden',
  rate_limited: 'player.chkszErrorRateLimited',
  unavailable: 'player.chkszErrorUnavailable',
  not_found: 'player.chkszErrorNotFound',
}

function attemptStatus(providerId: string, ok: boolean, code?: ResolveFailureCode): string {
  if (ok) return text('player.statusReady')
  if (providerId === 'chksz' && code) {
    const chkszCopy = CHKSZ_FAILURE_COPY[code]
    if (chkszCopy) return text(chkszCopy)
  }
  const keys: Record<ResolveFailureCode, TranslationKey> = {
    invalid_response: 'player.statusInvalid',
    not_mapped: 'player.statusNotMapped',
    rate_limited: 'player.statusRateLimited',
    timeout: 'player.statusTimeout',
    unavailable: 'player.statusUnavailable',
    credential_required: 'player.statusCredentialRequired',
    invalid_credential: 'player.statusInvalidCredential',
    quota_exhausted: 'player.statusQuotaExhausted',
    forbidden: 'player.statusForbidden',
    not_found: 'player.statusNotFound',
  }
  return text(code ? keys[code] : 'player.statusUnavailable')
}

function onSourceChange(event: Event): void {
  void props.player.setSourceOverride((event.target as HTMLSelectElement).value || undefined)
}
</script>

<template>
  <section
    class="playback-diagnostics"
    data-playback-diagnostics
    aria-labelledby="playback-diagnostics-title"
  >
    <h3 id="playback-diagnostics-title">{{ text('library.sourceSection') }}</h3>
    <label>
      <span>{{ text('player.sourceLabel') }}</span>
      <select
        :value="player.sourceOverride.value ?? player.activeProviderId.value ?? ''"
        :disabled="!player.currentTrack.value"
        @change="onSourceChange"
      >
        <option value="">{{ text('player.automatic') }}</option>
        <option v-for="provider in enabledSources" :key="provider" :value="provider">{{ providerName(provider) }}</option>
      </select>
    </label>
    <div v-if="player.attempts.value.length" class="playback-diagnostics__attempts">
      <h4>{{ text('library.attempts') }}</h4>
      <ul>
        <li v-for="(attempt, index) in player.attempts.value" :key="`${attempt.providerId}-${index}`">
          {{ attemptLabel(attempt) }} · {{ attemptStatus(attempt.providerId, attempt.ok, attempt.code) }}
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.playback-diagnostics { display: grid; gap: 0.75rem; }
.playback-diagnostics h3 { margin: 0; font-size: 1rem; }
.playback-diagnostics h4,
.playback-diagnostics label span { margin: 0; color: var(--colour-text-muted); font-size: 0.875rem; }
.playback-diagnostics label { display: grid; gap: 0.5rem; }
.playback-diagnostics select { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.playback-diagnostics select:hover { filter: var(--control-hover-filter); }
.playback-diagnostics select:active { transform: translateY(var(--decorative-displacement)); filter: var(--control-active-filter); }
.playback-diagnostics select:focus-visible { filter: var(--control-hover-filter); }
.playback-diagnostics select:disabled { cursor: not-allowed; opacity: 0.6; }
.playback-diagnostics__attempts ul { display: grid; gap: 0.25rem; margin: 0.5rem 0 0; padding-inline-start: 1.25rem; color: var(--colour-text-muted); font-size: 0.875rem; }
</style>

<script setup lang="ts">
/**
 * Export, share and clear controls for the debug log (task 41.8). Rendered only in Settings About,
 * so the log stays reachable when the player itself is broken. The file is built from the
 * redacted in-memory buffer only.
 */
import type { PlaybackStore } from './store'
import { computed, ref } from 'vue'
import { translate, type Locale, type TranslationKey } from '../../i18n'
import { canShareDebugLog, clearDebugLog, runDebugLogExport, type DebugLogExportKind } from './debugLog'
import { usePreferences } from '../../stores/preferences'

/** `locale` is given by a host that owns its preferences (Settings); otherwise the shared one. */
const props = defineProps<{ player?: PlaybackStore; locale?: Locale }>()
const shared = usePreferences()
const locale = computed<Locale>(() => props.locale ?? shared.locale.value)
const text = (key: TranslationKey): string => translate(locale.value, key)
const canShare = canShareDebugLog()
const rootElement = ref<HTMLElement | null>(null)
const context = () => ({ player: props.player, locale: locale.value, host: rootElement.value })
// Every action reports its outcome here, so a blocked download or share is never silent.
const status = ref<TranslationKey | null>(null)
const manualText = ref<string | null>(null)
const busy = ref(false)
async function run(kind: DebugLogExportKind): Promise<void> {
  if (busy.value) return
  busy.value = true
  manualText.value = null
  try {
    const result = await runDebugLogExport(kind, context())
    if (result.ok) {
      status.value = result.method === 'download' ? 'player.diagnostics.exportedStatus'
        : result.method === 'share' ? 'player.diagnostics.sharedStatus'
          : result.method === 'cancelled' ? 'player.diagnostics.cancelledStatus'
            : 'player.diagnostics.copiedStatus'
    } else if (result.reason === 'manual_copy') {
      manualText.value = result.text
      status.value = 'player.diagnostics.manualCopyStatus'
    } else {
      status.value = 'player.diagnostics.failedStatus'
    }
  } finally {
    busy.value = false
  }
}
function selectAll(event: Event): void {
  (event.target as HTMLTextAreaElement).select()
}
function clear(): void {
  clearDebugLog()
  status.value = null
  manualText.value = null
}
</script>

<template>
  <div ref="rootElement" class="debug-log-controls" data-debug-log>
    <button type="button" data-debug-log-export @click="run('download')">{{ text('player.diagnostics.exportLog') }}</button>
    <button v-if="canShare" type="button" data-debug-log-share @click="run('share')">{{ text('player.diagnostics.shareLog') }}</button>
    <button type="button" data-debug-log-copy @click="run('copy')">{{ text('player.diagnostics.copyLog') }}</button>
    <button type="button" data-debug-log-clear @click="clear()">{{ text('player.diagnostics.clearLog') }}</button>
    <div class="debug-log-controls__status" role="status" data-debug-log-status>{{ status ? text(status) : '' }}</div>
    <textarea v-if="manualText !== null" class="debug-log-controls__text" readonly data-debug-log-text :value="manualText" :aria-label="text('player.diagnostics.copyLog')" @focus="selectAll" @click="selectAll"></textarea>
  </div>
</template>

<style scoped>
.debug-log-controls__status { flex-basis: 100%; margin: 0; min-height: 1.25rem; }
.debug-log-controls__text { flex-basis: 100%; min-height: 8rem; font: 0.75rem/1.4 ui-monospace, monospace; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; }
.debug-log-controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.debug-log-controls button { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.debug-log-controls button:hover,
.debug-log-controls button:focus-visible { filter: var(--control-hover-filter); }
.debug-log-controls button:active { transform: translateY(var(--decorative-displacement)); filter: var(--control-active-filter); }
</style>

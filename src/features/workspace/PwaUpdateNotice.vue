<script setup lang="ts">
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import type { PwaUpdateStatus } from '../../pwa/updateStatus'
const props = defineProps<{ status: PwaUpdateStatus }>()
const { locale } = usePreferences()
const text = (key: TranslationKey) => translate(locale.value, key)
</script>
<template>
  <aside v-if="props.status.visible.value" class="pwa-update surface-glass" data-pwa-update-notice role="status" aria-live="polite" :aria-label="text('pwa.update.notice')">
    <p>{{ text(props.status.state.value === 'needRefresh' ? 'pwa.update.available' : 'pwa.update.offlineReady') }}</p>
    <div>
      <button v-if="props.status.state.value === 'needRefresh'" data-pwa-update type="button" @click="void props.status.applyUpdate()">{{ text('pwa.update.apply') }}</button>
      <button v-if="props.status.state.value === 'needRefresh'" data-pwa-later type="button" @click="props.status.later()">{{ text('pwa.update.later') }}</button>
      <button data-pwa-dismiss type="button" @click="props.status.dismiss()">{{ text('pwa.update.dismiss') }}</button>
    </div>
  </aside>
</template>
<style scoped>
.pwa-update {
  position: fixed;
  /* Clear of the chat window's default corner. The window is draggable, so this is the
     resting scene rather than a guarantee; the notice is dismissible and the window
     moves, so neither one traps the other. */
  right: calc(var(--workspace-edge-inset) + var(--workspace-chat-window-inline-size) + var(--workspace-edge-inset));
  bottom: var(--workspace-edge-inset);
  z-index: 1002;
  display: grid;
  max-width: min(24rem, calc(100vw - (2 * var(--workspace-edge-inset))));
  gap: .75rem;
  padding: 1rem;
  border-radius: var(--radius-surface);
  /* The card does not swallow presses; only its own controls do. Fixed cards stack in the
     narrow layout -- this notice is lifted clear of the player, which puts it right against
     the bottom of the fan-project notice -- and a transient status must never be what stops
     a one-time legal notice from being dismissed. The fan notice states the same policy for
     the same reason, so the two can share pixels without either trapping the other. */
  pointer-events: none;
}
.pwa-update p { margin: 0; color: var(--colour-text-primary); line-height: 1.5; }
.pwa-update div { display: flex; flex-wrap: wrap; gap: .5rem; }
.pwa-update button { pointer-events: auto; min-height: 2.75rem; padding: .5rem .75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: .5rem; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
.pwa-update button:hover { filter: var(--control-hover-filter); }
.pwa-update button:active { transform: scale(.96); }

@media (max-width: 63.99rem) {
  .pwa-update {
    right: auto;
    bottom: calc(var(--workspace-edge-inset) + var(--workspace-player-control-reserve));
    left: var(--workspace-edge-inset);
    max-width: 17rem;
  }
}
</style>

<style>
/*
 * The notice is fixed above the workspace, so it would otherwise sit over whatever the
 * top bar disclosed. It yields to both of the bar's surfaces: the advanced-filter
 * popover, and the Control Center -- the hit area's aria-expanded is the modal's state,
 * so the same shape of selector serves both.
 */
.study-workspace:has([data-advanced-trigger][aria-expanded="true"]) .pwa-update,
.study-workspace:has([data-focus-control-centre][aria-expanded="true"]) .pwa-update {
  visibility: hidden;
  pointer-events: none;
}
</style>

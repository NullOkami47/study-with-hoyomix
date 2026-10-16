<script setup lang="ts">
import { Info } from 'lucide-vue-next'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { useFanProjectNotice, type FanProjectNoticeStore } from './fanProjectNotice'

const props = defineProps<{ store?: FanProjectNoticeStore }>()
const store = props.store ?? useFanProjectNotice()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
</script>

<template>
  <!--
    Informational only. This is deliberately not a dialog and not a clickwrap: it takes no
    focus, blocks nothing, and the app is fully usable anonymously whether or not it is
    dismissed. Dismissal is local-device state, never account state.
  -->
  <aside
    v-if="store.visible.value"
    class="fan-notice surface-glass"
    data-fan-notice
    role="region"
    aria-labelledby="fan-notice-title"
  >
    <div class="fan-notice__heading">
      <Info :size="20" aria-hidden="true" />
      <h2 id="fan-notice-title">{{ text('legal.fanNotice.title') }}</h2>
    </div>
    <div
      class="fan-notice__body"
      data-fan-notice-body
      tabindex="0"
      role="group"
      :aria-label="text('legal.fanNotice.title')"
    >
      <p>{{ text('legal.fanNotice.affiliation') }}</p>
      <p>{{ text('legal.fanNotice.rights') }}</p>
      <p class="fan-notice__detail">{{ text('legal.fanNotice.licences') }}</p>
    </div>
    <button type="button" data-fan-notice-dismiss @click="store.dismiss()">
      {{ text('legal.fanNotice.dismiss') }}
    </button>
  </aside>
</template>

<style scoped>
.fan-notice {
  position: fixed;
  inset-block-start: 9rem;
  inset-inline-start: 50%;
  z-index: 1001;
  display: grid;
  width: min(26rem, calc(100vw - 2rem));
  gap: 0.5rem;
  padding: 1rem;
  overflow: hidden;
  border-radius: var(--radius-surface);
  transform: translateX(-50%);
  pointer-events: none;
}
.fan-notice__body {
  display: grid;
  gap: 0.5rem;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}
.fan-notice__heading { display: flex; gap: 0.75rem; align-items: center; min-width: 0; }
.fan-notice svg { flex: 0 0 auto; color: var(--colour-accent-strong); }
.fan-notice h2,
.fan-notice p { margin: 0; color: var(--colour-text-primary); }
.fan-notice h2 { font-size: 1rem; }
.fan-notice p { font-size: 0.875rem; line-height: 1.5; }
.fan-notice__detail { color: var(--colour-text-muted); }
.fan-notice button {
  min-height: 2.75rem;
  justify-self: start;
  pointer-events: auto;
  padding: 0.5rem 0.9rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}
.fan-notice button:hover { filter: var(--control-hover-filter); }
.fan-notice button:active { transform: scale(0.96); }
@media (max-width: 47.99rem) {
  .fan-notice {
    inset-block-start: var(--workspace-mobile-notice-block-start);
    max-height: max(0px, calc(var(--workspace-mobile-notice-block-end, 100dvh) - var(--workspace-mobile-notice-block-start) - var(--workspace-mobile-notice-chat-reserve, 0px)));
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto minmax(0, 1fr);
    padding: 0.5rem;
  }
  .fan-notice__heading { grid-column: 1; grid-row: 1; gap: 0.5rem; }
  .fan-notice__body { grid-column: 1 / -1; grid-row: 2; }
  .fan-notice button { grid-column: 2; grid-row: 1; align-self: center; padding: 0.5rem; }
}
@media (prefers-reduced-motion: reduce) {
  .fan-notice button { transition: none; }
  .fan-notice button:active { transform: none; }
}
@media (max-width: 47.99rem) and (max-height: 44rem) {
  .fan-notice { padding: 0.25rem; gap: 0.25rem; }
}
</style>

<script setup lang="ts">
import { SkipForward } from 'lucide-vue-next'
import { translate, type Locale } from '../../i18n'
import type { BackgroundStore } from './store'

defineProps<{ store: BackgroundStore; locale: Locale; inert?: boolean }>()
</script>

<template>
  <button
    type="button"
    class="background-switcher liquid-shell"
    :aria-label="translate(locale, 'settings.backgrounds.next')"
    :title="translate(locale, 'settings.backgrounds.next')"
    data-background-next
    :disabled="inert || store.backgrounds.value.length < 2"
    @click="store.nextBackground()"
  >
    <SkipForward :size="18" aria-hidden="true" />
    <span>{{ translate(locale, 'settings.backgrounds.next') }}</span>
  </button>
</template>

<style scoped>
.background-switcher {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  border: 0;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  transition: filter var(--motion-duration) ease;
}
.background-switcher:hover:not(:disabled) { filter: var(--control-hover-filter); }
.background-switcher:active:not(:disabled) { filter: var(--control-active-filter); }
.background-switcher:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 47.99rem) {
  .background-switcher { width: 44px; height: 44px; min-height: 44px; padding: 0; justify-content: center; }
  .background-switcher span { display: none; }
}
</style>

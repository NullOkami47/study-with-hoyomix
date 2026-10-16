<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { Moon, Pause, Play, Square } from 'lucide-vue-next'

import { createSleepTimerStore, SLEEP_PRESETS, type SleepPlayerCommands, type SleepTimerStore } from './store'
import { translate, type TranslationKey } from '../../../i18n'
import { usePreferences } from '../../../stores/preferences'

const props = withDefaults(defineProps<{
  embedded?: boolean
  player?: SleepPlayerCommands
  store?: SleepTimerStore
}>(), { embedded: false })
const ownsStore = !props.store
const store = props.store ?? createSleepTimerStore({ player: props.player ?? { pause() {}, stop() {} } })
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

function updateCustom(event: Event): void {
  store.setCustomDuration(Number((event.target as HTMLInputElement).value))
}

onBeforeUnmount(() => {
  if (ownsStore) store.destroy()
})
</script>

<template>
  <component
    :is="props.embedded ? 'div' : 'section'"
    class="sleep-timer"
    :class="{ 'liquid-popover': !props.embedded }"
    :aria-label="props.embedded ? undefined : text('timer.sleep')"
    :data-sleep-timer-embedded="props.embedded ? '' : undefined"
  >
    <header>
      <Moon :size="18" aria-hidden="true" />
      <h2 v-if="!props.embedded">{{ text('timer.sleep') }}</h2>
      <output data-testid="sleep-status" aria-live="polite">{{ store.formattedTime.value }}</output>
    </header>

    <div class="sleep-timer__presets" :aria-label="text('sleep.presets')">
      <button
        v-for="minutes in SLEEP_PRESETS"
        :key="minutes"
        data-testid="sleep-preset"
        type="button"
        :aria-pressed="store.selectedMinutes.value === minutes"
        @click="store.selectDuration(minutes)"
      >{{ minutes }}</button>
    </div>

    <label>
      <span>{{ text('sleep.customMinutes') }}</span>
      <input data-testid="sleep-custom" type="number" min="1" max="1440" :value="store.customMinutes.value" @change="updateCustom" />
    </label>

    <div class="sleep-timer__controls">
      <button v-if="store.status.value === 'paused'" type="button" @click="store.resume"><Play :size="18" aria-hidden="true" />{{ text('sleep.resume') }}</button>
      <button v-else data-testid="sleep-start" type="button" @click="store.start"><Play :size="18" aria-hidden="true" />{{ text('sleep.start') }}</button>
      <button v-if="store.status.value === 'running'" type="button" @click="store.pause"><Pause :size="18" aria-hidden="true" />{{ text('sleep.pause') }}</button>
      <button type="button" @click="store.cancel"><Square :size="18" aria-hidden="true" />{{ text('sleep.cancel') }}</button>
    </div>
  </component>
</template>

<style scoped>
.sleep-timer { display: grid; gap: 0.75rem; padding: 1rem; border-radius: var(--radius-surface); }
header { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
h2, output { margin: 0; }
h2 { flex: 1; font-size: 1rem; }
output { color: var(--colour-accent-strong); font-family: "Courier New", monospace; font-weight: 700; }
.sleep-timer__presets, .sleep-timer__controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
button { display: inline-flex; min-width: 2.75rem; min-height: 2.75rem; gap: 0.5rem; align-items: center; justify-content: center; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
button[aria-pressed="true"] { color: var(--colour-background); background: var(--colour-accent); }
button:hover { filter: var(--control-hover-filter); }
button:active { transform: scale(0.96); filter: var(--control-active-filter); }
label { display: grid; gap: 0.25rem; color: var(--colour-text-muted); font-size: 0.875rem; }
input { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; }
.sleep-timer { border-radius: var(--liquid-radius-popover); font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif; }
.sleep-timer[data-sleep-timer-embedded] { background: transparent; border: 0; box-shadow: none; }
.sleep-timer output { color: var(--liquid-text-primary); font-family: inherit; font-variant-numeric: tabular-nums; }
.sleep-timer button { border: 0; border-radius: var(--liquid-radius-control); background: transparent; }
.sleep-timer button:hover { background: rgb(255 255 255 / 9%); filter: none; }
.sleep-timer button[aria-pressed="true"] { color: var(--liquid-text-primary); background: var(--liquid-selected); }
.sleep-timer input { border: 0; border-radius: var(--liquid-radius-control); background: rgb(255 255 255 / 9%); }
.sleep-timer__controls { padding-top: 0.5rem; border-top: 1px solid var(--liquid-separator); }
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { Pause, Play, RotateCcw } from 'lucide-vue-next'

import type { PomodoroStore } from './store'
import { translate, type TranslationKey } from '../../../i18n'
import { usePreferences } from '../../../stores/preferences'

const props = defineProps<{ store: PomodoroStore }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const phaseKey = computed<TranslationKey>(() => `pomodoro.phase.${props.store.phase.value}` as TranslationKey)

</script>

<template>
  <section class="pomodoro-timer" :aria-label="text('pomodoro.title')">
    <div class="pomodoro-timer__readout">
      <p>{{ text(phaseKey) }}</p>
      <output data-testid="pomodoro-readout" aria-live="polite">{{ store.formattedTime.value }}</output>
      <p>{{ text(`pomodoro.status.${store.status.value}` as TranslationKey) }}</p>
    </div>

    <div class="pomodoro-timer__controls">
      <button v-if="store.status.value === 'idle'" data-testid="pomodoro-start" type="button" @click="store.start">
        <Play :size="18" aria-hidden="true" />{{ text('pomodoro.start') }}
      </button>
      <button v-else-if="store.status.value === 'running'" data-testid="pomodoro-pause" type="button" @click="store.pause">
        <Pause :size="18" aria-hidden="true" />{{ text('pomodoro.pause') }}
      </button>
      <button v-else data-testid="pomodoro-resume" type="button" @click="store.resume">
        <Play :size="18" aria-hidden="true" />{{ text('pomodoro.resume') }}
      </button>
      <button data-testid="pomodoro-reset" type="button" @click="store.reset">
        <RotateCcw :size="18" aria-hidden="true" />{{ text('pomodoro.reset') }}
      </button>
    </div>

  </section>
</template>

<style scoped>
.pomodoro-timer { display: grid; gap: 1rem; color: var(--colour-text-primary); }
.pomodoro-timer__readout { display: grid; gap: 0.25rem; justify-items: center; }
.pomodoro-timer__readout p { margin: 0; color: var(--colour-text-muted); font-size: 0.875rem; }
.pomodoro-timer__readout output { font-family: "Courier New", monospace; font-size: clamp(1.25rem, 5vw, 1.75rem); font-weight: 700; line-height: 1.2; }
.pomodoro-timer__controls { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: center; }
button { display: inline-flex; min-height: 2.75rem; gap: 0.5rem; align-items: center; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
button:hover { filter: var(--control-hover-filter); }
button:active { transform: scale(0.96); filter: var(--control-active-filter); }
</style>

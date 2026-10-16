<script setup lang="ts">
import { computed } from 'vue'
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import type { PlaybackStore } from './store'
import { playbackCommands } from './commands'
import { formatPlaybackTime, playbackPresentationFor } from './presentation'

const props = defineProps<{ store: PlaybackStore }>()
const { locale } = usePreferences()
const text = (key: TranslationKey) => translate(locale.value, key)
const presentation = computed(() => playbackPresentationFor(props.store))
const title = computed(() => resolveDisplayTitle(props.store.currentTrack.value, locale.value, text('player.noTrack')))
const details = computed(() => [
  props.store.currentTrack.value?.album,
  props.store.currentTrack.value?.games.map(game => text(`game.${game}`)).join(' · '),
].filter(Boolean).join(' · '))
const status = computed(() => {
  const keys: Record<typeof props.store.status.value, TranslationKey> = {
    idle: 'player.statusChoose', resolving: 'player.statusResolving', ready: 'player.statusReady',
    playing: 'player.statusPlaying', paused: 'player.statusPaused', buffering: 'player.statusBuffering',
    ended: 'player.statusEnded', error: 'player.statusNoSource',
  }
  return text(keys[props.store.status.value])
})
function toggle(): void {
  if (props.store.playable.value?.kind === 'youtube') return
  if (props.store.playbackIntent.value === 'playing') playbackCommands.pause()
  else playbackCommands.play()
}
let seekGesture: { generation: number; trackId?: string } | undefined
function beginSeek(event: Event): void {
  if (event instanceof KeyboardEvent && event.repeat) return
  seekGesture = { generation: props.store.playbackGeneration.value, trackId: props.store.currentTrack.value?.id }
}
function endSeek(): void { seekGesture = undefined }
const seekHandler = computed(() => {
  const generation = props.store.playbackGeneration.value
  const trackId = props.store.currentTrack.value?.id
  return (event: Event): void => {
    if (generation !== props.store.playbackGeneration.value || trackId !== props.store.currentTrack.value?.id) return
    if (seekGesture && (seekGesture.generation !== generation || seekGesture.trackId !== trackId)) return
    if (!presentation.value.canSeek.value) return
    playbackCommands.seek?.(Number((event.target as HTMLInputElement).value))
  }
})
</script>

<template>
  <section class="compact-playback" data-compact-playback :aria-label="text('player.nowPlaying')">
    <div class="compact-playback__identity">
      <div class="compact-playback__artwork" aria-hidden="true">
        <img v-if="presentation.artworkUrl.value" :src="presentation.artworkUrl.value" alt="" />
        <Music2 v-else :size="28" />
      </div>
      <div class="compact-playback__copy">
        <h3 data-compact-title>{{ title }}</h3>
        <p v-if="details">{{ details }}</p>
        <p data-compact-status role="status">{{ status }}</p>
      </div>
    </div>
    <div class="compact-playback__transport">
      <button type="button" data-compact-previous :aria-label="text('player.previous')" @click="playbackCommands.previous?.()"><SkipBack :size="20" aria-hidden="true" /></button>
      <button type="button" data-compact-play :disabled="store.playable.value?.kind === 'youtube'" :aria-label="text(store.playbackIntent.value === 'playing' ? 'player.pause' : 'player.play')" @click="toggle">
        <Pause v-if="store.playbackIntent.value === 'playing'" :size="24" aria-hidden="true" /><Play v-else :size="24" aria-hidden="true" />
      </button>
      <button type="button" data-compact-next :aria-label="text('player.next')" @click="playbackCommands.next?.()"><SkipForward :size="20" aria-hidden="true" /></button>
    </div>
    <input type="range" data-compact-seek min="0" :max="presentation.duration.value || 1" step="0.1"
      :value="presentation.currentTime.value" :disabled="!presentation.canSeek.value" :aria-label="text('player.seek')"
      :aria-valuetext="formatPlaybackTime(presentation.currentTime.value) + ' / ' + (presentation.duration.value > 0 ? formatPlaybackTime(presentation.duration.value) : '--:--')"
      @pointerdown="beginSeek" @pointerup="endSeek" @pointercancel="endSeek" @lostpointercapture="endSeek"
      @keydown="beginSeek" @keyup="endSeek" @blur="endSeek" @input="seekHandler" />
    <div class="compact-playback__time" dir="ltr">
      <span data-compact-elapsed :aria-label="text('player.elapsed')">{{ formatPlaybackTime(presentation.currentTime.value) }}</span>
      <span data-compact-duration :aria-label="text('player.duration')">{{ presentation.duration.value > 0 ? formatPlaybackTime(presentation.duration.value) : '--:--' }}</span>
    </div>
  </section>
</template>

<style scoped>
.compact-playback { display: grid; gap: 0.375rem; min-width: 0; padding-block: 0.5rem 1rem; border-bottom: 1px solid var(--liquid-separator); }
.compact-playback__identity { display: flex; align-items: center; gap: 0.875rem; min-width: 0; }
.compact-playback__artwork { display: grid; place-items: center; flex: 0 0 4rem; width: 4rem; aspect-ratio: 1; overflow: hidden; border-radius: var(--liquid-radius-control); background: var(--liquid-selected); color: var(--colour-accent-strong); }
.compact-playback__artwork img { width: 100%; height: 100%; object-fit: cover; }
.compact-playback__copy { min-width: 0; }
h3, p { margin: 0; overflow-wrap: anywhere; }
h3 { color: var(--liquid-text-primary); font-size: 1rem; font-weight: 690; }
p { margin-top: 0.25rem; color: var(--liquid-text-secondary); font-size: 0.875rem; }
.compact-playback__transport { display: flex; justify-content: center; gap: 0.75rem; }
button { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0; color: var(--liquid-text-primary); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
button:hover { background: var(--liquid-selected); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--colour-focus); outline-offset: 2px; }
input { width: 100%; min-height: 2.75rem; margin: 0; accent-color: var(--colour-accent-strong); cursor: pointer; }
input:disabled { opacity: 0.5; cursor: default; }
.compact-playback__time { display: flex; justify-content: space-between; color: var(--liquid-text-secondary); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
</style>

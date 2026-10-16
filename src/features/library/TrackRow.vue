<script setup lang="ts">
/**
 * One catalogue track, with its three explicit actions.
 *
 * Every action here is a direct call into the playback store handed down by the parent.
 * This component owns no state and derives nothing about the queue, so browsing can never
 * change what is playing: the only way a queue or play action happens is a press on one of
 * these buttons.
 */
import { computed } from 'vue'
import { ListPlus, Play, SkipForward } from 'lucide-vue-next'

import { translate, type Locale, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import type { Track } from '../catalog/types'
import { placeholderArtwork, useArtwork } from './artwork'

const props = withDefaults(
  defineProps<{
    track: Track
    locale: Locale
    /** Album title to show under the track, when the catalogue stores one. */
    album?: string
    /** Game label to show, when the track belongs to a game. */
    game?: string
  }>(),
  { album: undefined, game: undefined },
)

const emit = defineEmits<{
  (event: 'play', track: Track): void
  (event: 'enqueue', track: Track): void
  (event: 'play-next', track: Track): void
}>()

const text = (key: TranslationKey): string => translate(props.locale, key)
const format = (key: TranslationKey, values: Record<string, string>): string => {
  let result = text(key)
  for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value)
  return result
}

/** Display-only. Identity stays `track.id`, so a language switch cannot change the target. */
const displayTitle = computed(() => resolveDisplayTitle(props.track, props.locale, props.track.title))
/** Shown only when the localised title differs, so the canonical name is never lost. */
const canonicalTitle = computed(() => props.track.title)
const showsCanonical = computed(() => canonicalTitle.value !== displayTitle.value)
const artworkStyle = computed(() => ({ '--artwork': placeholderArtwork(props.album ?? props.track.id) }))
const meta = computed(() => [props.album, props.game].filter((value) => Boolean(value)).join(' · '))

const artworkKey = computed(() =>
  props.album ? `album:${props.album}` : `track:${props.track.id}`,
)
const { artworkUrl, isLoaded, hasFailed, onLoad, onError } = useArtwork(
  artworkKey,
  computed(() => props.track),
)
</script>

<template>
  <li
    class="track-row"
    data-track-row
    :data-track-id="track.id"
  >
    <span class="track-row__artwork" aria-hidden="true" :style="artworkStyle">
      <img
        v-if="artworkUrl && !hasFailed"
        :src="artworkUrl"
        alt=""
        loading="lazy"
        decoding="async"
        class="track-row__image"
        :class="{ 'is-loaded': isLoaded }"
        data-track-artwork
        @load="onLoad"
        @error="onError"
      />
    </span>
    <span class="track-row__identity">
      <span class="track-row__title" data-track-title>{{ displayTitle }}</span>
      <span v-if="showsCanonical" class="track-row__canonical" data-track-canonical>{{ canonicalTitle }}</span>
      <span v-if="meta" class="track-row__meta" data-track-meta>{{ meta }}</span>
    </span>
    <span class="track-row__actions">
      <button
        type="button"
        class="track-row__action"
        data-track-play
        :aria-label="format('musicLibrary.trackPlay', { title: displayTitle })"
        @click="emit('play', track)"
      >
        <Play :size="16" aria-hidden="true" />
        <span>{{ text('queue.playNow') }}</span>
      </button>
      <button
        type="button"
        class="track-row__action"
        data-track-enqueue
        :aria-label="format('musicLibrary.trackEnqueue', { title: displayTitle })"
        @click="emit('enqueue', track)"
      >
        <ListPlus :size="16" aria-hidden="true" />
        <span>{{ text('catalog.addToQueue') }}</span>
      </button>
      <button
        type="button"
        class="track-row__action"
        data-track-play-next
        :aria-label="format('musicLibrary.trackPlayNext', { title: displayTitle })"
        @click="emit('play-next', track)"
      >
        <SkipForward :size="16" aria-hidden="true" />
        <span>{{ text('queue.playNext') }}</span>
      </button>
    </span>
  </li>
</template>

<style scoped>
.track-row {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  min-width: 0;
  padding: 0.5rem 0;
  border-block-end: 1px solid var(--liquid-separator);
}
.track-row__artwork {
  position: relative;
  overflow: hidden;
  inline-size: 2.5rem;
  block-size: 2.5rem;
  background: var(--artwork, var(--liquid-selected));
  border-radius: 0.5rem;
  box-shadow: var(--liquid-inner-light);
}
.track-row__image {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity var(--liquid-motion) var(--liquid-easing);
}
.track-row__image.is-loaded {
  opacity: 1;
}
.track-row__identity { display: grid; gap: 0.0625rem; min-width: 0; }
.track-row__title,
.track-row__canonical,
.track-row__meta {
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
}
.track-row__title { color: var(--liquid-text-primary); font-size: 0.9375rem; }
.track-row__canonical { color: var(--liquid-text-secondary); font-size: 0.75rem; }
.track-row__meta { color: var(--liquid-text-secondary); font-size: 0.75rem; }
.track-row__actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 0.25rem; justify-content: flex-end; }
.track-row__action {
  display: inline-flex;
  gap: 0.25rem;
  align-items: center;
  min-height: 2.75rem;
  padding: 0.375rem 0.625rem;
  color: var(--liquid-text-primary);
  background: var(--liquid-selected);
  border: 0;
  border-radius: var(--liquid-radius-control);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  transition: filter var(--liquid-motion) var(--liquid-easing);
}
.track-row__action:hover { filter: var(--control-hover-filter); }
.track-row__action:active { filter: var(--control-active-filter); }

/*
 * Narrow screens stack the row: the artwork and identity stay on one line, and the actions
 * drop beneath them at full width so every control keeps its 44px target without pushing
 * the row into horizontal overflow.
 */
@media (max-width: 34rem) {
  .track-row { grid-template-columns: 2.5rem minmax(0, 1fr); }
  .track-row__actions { grid-column: 1 / -1; justify-content: flex-start; }
  .track-row__action { flex: 1 1 auto; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .track-row__action,
  .track-row__image { transition-duration: 0ms; }
}
</style>

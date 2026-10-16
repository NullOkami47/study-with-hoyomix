<script setup lang="ts">
/**
 * One album, as a card. The whole card is a single button, so the album is reachable and
 * openable by keyboard without a nested control, and its accessible name spells out the
 * title, the game and the track count rather than relying on the artwork.
 */
import { computed } from 'vue'

import { translate, type Locale, type TranslationKey } from '../../i18n'
import { placeholderArtwork, useAlbumArtwork } from './artwork'
import { gameLabel, type AlbumEntry } from './catalogueIndex'

const props = defineProps<{ album: AlbumEntry; locale: Locale }>()

const emit = defineEmits<{ (event: 'open', album: AlbumEntry): void }>()

const text = (key: TranslationKey): string => translate(props.locale, key)
const format = (key: TranslationKey, values: Record<string, string>): string => {
  let result = text(key)
  for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value)
  return result
}

const artworkStyle = computed(() => ({ '--artwork': placeholderArtwork(props.album.id) }))
const game = computed(() => (props.album.game ? gameLabel(props.album.game, props.locale) : ''))
const trackCount = computed(() =>
  format('musicLibrary.trackCount', { count: String(props.album.trackCount) }),
)
const openLabel = computed(() =>
  format('musicLibrary.openAlbum', { album: props.album.title }),
)

const { artworkUrl, isLoaded, hasFailed, onLoad, onError } = useAlbumArtwork(
  computed(() => props.album),
)
</script>

<template>
  <li class="album-card" data-album-card :data-album-id="album.id">
    <button
      type="button"
      class="album-card__button"
      data-album-open
      :aria-label="openLabel"
      @click="emit('open', album)"
    >
      <span class="album-card__artwork" aria-hidden="true" :style="artworkStyle">
        <img
          v-if="artworkUrl && !hasFailed"
          :src="artworkUrl"
          alt=""
          loading="lazy"
          decoding="async"
          class="album-card__image"
          :class="{ 'is-loaded': isLoaded }"
          data-album-artwork
          @load="onLoad"
          @error="onError"
        />
      </span>
      <span class="album-card__title" data-album-title>{{ album.title }}</span>
      <span v-if="game" class="album-card__game" data-album-game>{{ game }}</span>
      <span class="album-card__count" data-album-count>{{ trackCount }}</span>
    </button>
  </li>
</template>

<style scoped>
.album-card { min-width: 0; }
.album-card__button {
  display: grid;
  gap: 0.25rem;
  align-content: start;
  inline-size: 100%;
  min-width: 0;
  padding: 0.5rem;
  color: var(--liquid-text-primary);
  text-align: start;
  background: var(--liquid-selected);
  border: 0;
  border-radius: var(--liquid-radius-control);
  cursor: pointer;
  font: inherit;
  transition: filter var(--liquid-motion) var(--liquid-easing);
}
.album-card__button:hover { filter: var(--control-hover-filter); }
.album-card__button:active { filter: var(--control-active-filter); }
.album-card__artwork {
  position: relative;
  overflow: hidden;
  inline-size: 100%;
  aspect-ratio: 1 / 1;
  background: var(--artwork, var(--liquid-selected));
  border-radius: 0.5rem;
  box-shadow: var(--liquid-inner-light);
}
.album-card__image {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity var(--liquid-motion) var(--liquid-easing);
}
.album-card__image.is-loaded {
  opacity: 1;
}
.album-card__title {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.875rem;
  font-weight: 600;
}
.album-card__game,
.album-card__count { color: var(--liquid-text-secondary); font-size: 0.75rem; }
@media (prefers-reduced-motion: reduce) {
  .album-card__button,
  .album-card__image { transition-duration: 0ms; }
}
</style>

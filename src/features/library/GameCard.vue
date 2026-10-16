<script setup lang="ts">
/**
 * One game, as a card. Like the album card the whole surface is a single button, so the
 * accessible name carries the game and its size instead of leaving that to the colour.
 */
import { computed } from 'vue'

import { translate, type Locale, type TranslationKey } from '../../i18n'
import { placeholderArtwork } from './artwork'
import { gameLabel, type GameEntry } from './catalogueIndex'

const props = defineProps<{ game: GameEntry; locale: Locale }>()

const emit = defineEmits<{ (event: 'open', game: GameEntry): void }>()

const text = (key: TranslationKey): string => translate(props.locale, key)
const format = (key: TranslationKey, values: Record<string, string>): string => {
  let result = text(key)
  for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value)
  return result
}

const name = computed(() => gameLabel(props.game.id, props.locale))
const artworkStyle = computed(() => ({ '--artwork': placeholderArtwork(`game:${props.game.id}`) }))
const counts = computed(() =>
  format('musicLibrary.gameCounts', {
    albums: String(props.game.albumIds.length),
    tracks: String(props.game.trackCount),
  }),
)
const openLabel = computed(() => format('musicLibrary.browseGame', { game: name.value }))
</script>

<template>
  <li class="game-card" data-game-card :data-game-id="game.id">
    <button
      type="button"
      class="game-card__button"
      data-game-open
      :aria-label="openLabel"
      @click="emit('open', game)"
    >
      <span class="game-card__artwork" aria-hidden="true" :style="artworkStyle" />
      <span class="game-card__name" data-game-name>{{ name }}</span>
      <span class="game-card__counts" data-game-counts>{{ counts }}</span>
    </button>
  </li>
</template>

<style scoped>
.game-card { min-width: 0; }
.game-card__button {
  display: grid;
  gap: 0.25rem;
  align-content: start;
  inline-size: 100%;
  min-width: 0;
  padding: 0.625rem;
  color: var(--liquid-text-primary);
  text-align: start;
  background: var(--liquid-selected);
  border: 0;
  border-radius: var(--liquid-radius-control);
  cursor: pointer;
  font: inherit;
  transition: filter var(--liquid-motion) var(--liquid-easing);
}
.game-card__button:hover { filter: var(--control-hover-filter); }
.game-card__button:active { filter: var(--control-active-filter); }
.game-card__artwork {
  inline-size: 100%;
  aspect-ratio: 16 / 9;
  background: var(--artwork, var(--liquid-selected));
  border-radius: 0.5rem;
  box-shadow: var(--liquid-inner-light);
}
.game-card__name { min-width: 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 650; }
.game-card__counts { color: var(--liquid-text-secondary); font-size: 0.75rem; }
@media (prefers-reduced-motion: reduce) {
  .game-card__button { transition-duration: 0ms; }
}
</style>

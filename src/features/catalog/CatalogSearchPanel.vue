<script setup lang="ts">
import { computed, ref } from 'vue'
import { translate, type Locale, type TranslationKey } from '../../i18n'
import type { PlaybackStore } from '../player/store'
import { resolveDisplayTitle } from './displayTitle'
import type { Track } from './types'

const props = defineProps<{ tracks: Track[]; player: Pick<PlaybackStore, 'playNow' | 'enqueue'>; locale: Locale }>()
const text = (key: TranslationKey): string => translate(props.locale, key)
const query = ref('')
const shown = ref(40)
const indexed = computed(() => props.tracks.map((track, index) => ({
  track,
  index,
  title: track.title.toLocaleLowerCase(),
  aliases: Object.values(track.aliases).flat().map((alias) => alias.toLocaleLowerCase()),
})))
const matches = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return []
  return indexed.value.flatMap((entry) => {
    const names = [entry.title, ...entry.aliases]
    const rank = names.some((name) => name === needle) ? 0
      : names.some((name) => name.startsWith(needle)) ? 1
        : names.some((name) => name.includes(needle)) ? 2 : -1
    return rank < 0 ? [] : [{ ...entry, rank }]
  }).sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title) || a.track.id.localeCompare(b.track.id))
})
const visible = computed(() => matches.value.slice(0, shown.value))
function onSearch(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  shown.value = 40
}
</script>

<template>
  <section class="catalog-search" data-catalog-search :aria-label="text('catalog.searchLabel')">
    <h2>{{ text('catalog.searchLabel') }}</h2>
    <label class="catalog-search__input">
      <span>{{ text('catalog.searchLabel') }}</span>
      <input type="search" :value="query" :placeholder="text('catalog.searchPlaceholder')" autocomplete="off" data-catalog-search-input @input="onSearch" />
    </label>
    <p v-if="!query.trim()" class="catalog-search__message" data-catalog-search-prompt>{{ text('catalog.searchPrompt') }}</p>
    <p v-else-if="matches.length === 0" class="catalog-search__message" data-catalog-search-empty>{{ text('catalog.noSearchResults') }}</p>
    <template v-else>
      <p class="catalog-search__count" data-catalog-search-count aria-live="polite">{{ matches.length }} {{ text('catalog.trackCount') }}</p>
      <ol class="catalog-search__results" data-catalog-search-results>
        <li v-for="entry in visible" :key="entry.track.id" class="catalog-search__row" data-catalog-search-result>
          <div class="catalog-search__identity">
            <span class="catalog-search__title">{{ resolveDisplayTitle(entry.track, locale, entry.track.title) }}</span>
            <span v-if="resolveDisplayTitle(entry.track, locale) !== entry.track.title" class="catalog-search__canonical">{{ entry.track.title }}</span>
          </div>
          <div class="catalog-search__actions">
            <button type="button" :aria-label="translate(locale, 'catalog.playNow', { title: resolveDisplayTitle(entry.track, locale) })" data-search-play @click="void player.playNow(entry.track)">{{ text('queue.playNow') }}</button>
            <button type="button" :aria-label="translate(locale, 'catalog.enqueue', { title: resolveDisplayTitle(entry.track, locale) })" data-search-enqueue @click="player.enqueue(entry.track)">{{ text('catalog.addToQueue') }}</button>
          </div>
        </li>
      </ol>
      <button v-if="shown < matches.length" type="button" class="catalog-search__more" data-search-show-more @click="shown += 40">{{ text('catalog.showMore') }}</button>
    </template>
  </section>
</template>

<style scoped>
.catalog-search { display: grid; gap: 0.75rem; margin-block-end: 1.5rem; color: var(--liquid-text-primary); }
.catalog-search h2 { margin: 0; font-size: 1rem; }
.catalog-search__input { display: grid; gap: 0.375rem; font-size: 0.8125rem; color: var(--liquid-text-secondary); }
.catalog-search__input input { width: 100%; min-height: 2.75rem; padding: 0.625rem 0.875rem; color: var(--liquid-text-primary); background: rgb(255 255 255 / 9%); border: 0; border-radius: var(--liquid-radius-control); font: inherit; }
.catalog-search__message, .catalog-search__count { margin: 0; color: var(--liquid-text-secondary); font-size: 0.875rem; }
.catalog-search__results { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.catalog-search__row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-width: 0; padding: 0.5rem 0; border-block-end: 1px solid var(--liquid-separator); }
.catalog-search__identity { display: grid; gap: 0.125rem; min-width: 0; }
.catalog-search__title, .catalog-search__canonical { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-search__canonical { color: var(--liquid-text-secondary); font-size: 0.75rem; }
.catalog-search__actions { display: flex; flex: 0 0 auto; gap: 0.25rem; }
.catalog-search button { min-height: 2.75rem; padding: 0.5rem 0.625rem; color: var(--liquid-text-primary); background: var(--liquid-selected); border: 0; border-radius: var(--liquid-radius-control); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.catalog-search button:hover { filter: var(--control-hover-filter); }
.catalog-search__more { justify-self: start; }
@media (max-width: 35rem) { .catalog-search__row { align-items: stretch; flex-direction: column; } .catalog-search__actions button { flex: 1; } }
</style>

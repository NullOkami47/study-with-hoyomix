<script setup lang="ts">
import { computed, watch } from 'vue'

import { createCatalogFilterState, type CatalogFilterState } from './filterState'
import type { GameId, RelationKind, TabId, Track } from './types'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'

const props = defineProps<{ tracks: Track[]; state?: CatalogFilterState }>()
const emit = defineEmits<{ (event: 'filtered', tracks: Track[]): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const gameKey: Record<GameId, TranslationKey> = { genshin: 'game.genshin', hsr: 'game.hsr', zzz: 'game.zzz' }
const tabKey: Record<TabId, TranslationKey> = { sleep: 'tab.sleep', focus: 'tab.focus', chill: 'tab.chill' }
const relationKey: Record<RelationKind, TranslationKey> = {
  place: 'relation.place',
  character: 'relation.character',
  npc: 'relation.npc',
  faction: 'relation.faction',
  event: 'relation.event',
}

const state = props.state ?? createCatalogFilterState(props.tracks, {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
})
const relationOptions = computed(() =>
  [...new Set(props.tracks.flatMap(({ relationIds }) => relationIds))].sort(),
)

function relationLabel(relation: string): string {
  const [kind, ...idParts] = relation.split(':') as [RelationKind, ...string[]]
  const id = idParts.join(':')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(' ')
  return text('catalog.relationLabel')
    .replace('{kind}', text(relationKey[kind]))
    .replace('{id}', id)
}

function setSearch(event: Event): void {
  state.setSearch((event.target as HTMLInputElement).value)
}

watch(state.filteredTracks, (value) => emit('filtered', value), { immediate: true })
</script>

<template>
  <section class="catalog-filters" aria-labelledby="catalog-filter-title">
    <div class="catalog-filters__heading">
      <div>
        <p class="catalog-filters__eyebrow">{{ text('catalog.canonical') }}</p>
        <h2 id="catalog-filter-title">{{ text('catalog.title') }}</h2>
      </div>
      <p class="catalog-filters__count" aria-live="polite">{{ state.filteredTracks.value.length }} {{ text('catalog.trackCount') }}</p>
    </div>

    <label class="catalog-filters__search">
      <span>{{ text('catalog.searchLabel') }}</span>
      <input :value="state.search.value" type="search" autocomplete="off" :placeholder="text('catalog.searchPlaceholder')" @input="setSearch" />
    </label>

    <fieldset>
      <legend>{{ text('catalog.games') }}</legend>
      <div class="catalog-filters__choices">
        <button
          v-for="game in (['genshin', 'hsr', 'zzz'] as GameId[])"
          :key="game"
          type="button"
          :aria-pressed="state.games.value.includes(game)"
          :data-filter-game="game"
          @click="state.toggleGame(game)"
        >
          {{ text(gameKey[game]) }}
        </button>
      </div>
    </fieldset>

    <fieldset>
      <legend>{{ text('catalog.modes') }}</legend>
      <div class="catalog-filters__choices">
        <button type="button" :aria-pressed="state.mode.value === null" data-filter-tab="all" @click="state.setMode(null)">{{ text('catalog.allModes') }}</button>
        <button
          v-for="tab in (['sleep', 'focus', 'chill'] as TabId[])"
          :key="tab"
          type="button"
          :aria-pressed="state.mode.value === tab"
          :data-filter-tab="tab"
          @click="state.setMode(tab)"
        >
          {{ text(tabKey[tab]) }}
        </button>
      </div>
    </fieldset>

    <fieldset v-if="relationOptions.length > 0">
      <legend>{{ text('catalog.relations') }}</legend>
      <div class="catalog-filters__choices">
        <button
          v-for="relation in relationOptions"
          :key="relation"
          type="button"
          :aria-pressed="state.relationIds.value.includes(relation)"
          :data-filter-relation="relation"
          @click="state.toggleRelation(relation)"
        >
          {{ relationLabel(relation) }}
        </button>
      </div>
    </fieldset>
  </section>
</template>

<style scoped>
.catalog-filters { display: grid; gap: 1rem; }
.catalog-filters__heading { display: flex; gap: 1rem; align-items: end; justify-content: space-between; }
.catalog-filters__eyebrow, .catalog-filters__count { margin: 0; color: var(--colour-accent); font-size: 0.75rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; }
h2 { margin: 0.25rem 0 0; font-size: 1.25rem; line-height: 1.2; }
.catalog-filters__search { display: grid; gap: 0.5rem; color: var(--colour-text-muted); font-size: 0.875rem; font-weight: 650; }
input { min-height: 2.75rem; padding: 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; transition: filter var(--motion-duration) ease; }
input:hover { filter: var(--control-hover-filter); }
input:active { filter: var(--control-active-filter); }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 0.5rem; color: var(--colour-text-muted); font-size: 0.875rem; font-weight: 650; }
.catalog-filters__choices { display: flex; flex-wrap: wrap; gap: 0.5rem; }
button { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; cursor: pointer; font: inherit; text-transform: capitalize; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
button:hover { filter: brightness(1.15); }
button:active { transform: translateY(0.125rem); }
button[aria-pressed="true"] { color: var(--colour-background); background: var(--colour-accent); border-color: var(--colour-accent-strong); }
</style>

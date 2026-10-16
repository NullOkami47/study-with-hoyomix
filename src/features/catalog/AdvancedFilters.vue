<script setup lang="ts">
import { computed, ref } from 'vue'

import { CANONICAL_GAME_IDS, type CatalogFilterState } from './filterState'
import { relationLabel } from './filterLabels'
import type { GameId, RelationKind, TabId, Track } from './types'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'

const props = defineProps<{ id: string; state: CatalogFilterState; tracks: Track[] }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const tabKey: Record<TabId, TranslationKey> = { sleep: 'tab.sleep', focus: 'tab.focus', chill: 'tab.chill' }
const gameKey: Record<GameId, TranslationKey> = { genshin: 'game.genshin', hsr: 'game.hsr', zzz: 'game.zzz' }
const hasActiveFilters = computed(() => props.state.games.value.length !== CANONICAL_GAME_IDS.length
  || props.state.mode.value !== null || props.state.search.value !== ''
  || props.state.relationIds.value.length > 0)
const relationKey: Record<RelationKind, TranslationKey> = {
  character: 'relation.character', npc: 'relation.npc', place: 'relation.place', faction: 'relation.faction', event: 'relation.event',
}
const relationKinds: RelationKind[] = ['character', 'npc', 'place', 'faction', 'event']
// Fixed filter choices keep All reachable even when no tracks have mode tags.
const tabs: TabId[] = ['chill', 'focus', 'sleep']
const optionSearch = ref('')
const optionLimit = ref(40)
const relations = computed(() => [...new Set(props.tracks.flatMap((track) => track.relationIds))].sort())
const matchingRelations = computed(() => relations.value.filter((id) => relationLabel(id, locale.value).toLocaleLowerCase().includes(optionSearch.value.toLocaleLowerCase())))
const visibleRelations = computed(() => matchingRelations.value.slice(0, optionLimit.value))
const hasMoreOptions = computed(() => matchingRelations.value.length > optionLimit.value)

function clearAll(): void {
  for (const game of CANONICAL_GAME_IDS) {
    if (!props.state.games.value.includes(game)) props.state.toggleGame(game)
  }
  props.state.setMode(null)
  props.state.setSearch('')
  for (const relation of props.state.relationIds.value) props.state.toggleRelation(relation)
}
</script>

<template>
  <section :id="id" class="advanced-filters" data-advanced-filters :aria-label="text('catalog.filters')">
    <header>
      <h2>{{ text('catalog.filters') }}</h2>
      <div class="advanced-filters__header-actions">
        <button v-if="hasActiveFilters" type="button" data-filter-clear-all @click="clearAll">{{ text('catalog.clearAll') }}</button>
        <button type="button" data-advanced-close @click="emit('close')">{{ text('catalog.closeFilters') }}</button>
      </div>
    </header>

    <div class="advanced-filters__body" data-advanced-body>
      <fieldset data-filter-games>
        <legend>{{ text('catalog.games') }}</legend>
        <button v-for="game in CANONICAL_GAME_IDS" :key="game" type="button" :aria-pressed="state.games.value.includes(game)" :data-focus-game="game" @click="state.toggleGame(game)">{{ text(gameKey[game]) }}</button>
      </fieldset>

      <fieldset data-advanced-tabs>
        <legend>{{ text('catalog.modes') }}</legend>
        <button type="button" :aria-pressed="state.mode.value === null" data-filter-tab="all" @click="state.setMode(null)">{{ text('catalog.allModes') }}</button>
        <button v-for="tab in tabs" :key="tab" type="button" :aria-pressed="state.mode.value === tab" :data-filter-tab="tab" @click="state.setMode(tab)">{{ text(tabKey[tab]) }}</button>
      </fieldset>

      <label v-if="relations.length > 40" class="advanced-filters__search">
        <span>{{ text('catalog.filterOptions') }}</span>
        <input v-model="optionSearch" type="search" autocomplete="off" :placeholder="text('catalog.filterOptions')" @input="optionLimit = 40" />
      </label>
      <fieldset v-for="kind in relationKinds.filter((item) => visibleRelations.some((relation) => relation.startsWith(`${item}:`)))" :key="kind" :data-relation-kind="kind">
          <legend>{{ text(relationKey[kind]) }}</legend>
          <button v-for="relation in visibleRelations.filter((item) => item.startsWith(`${kind}:`))" :key="relation" type="button" :aria-pressed="state.relationIds.value.includes(relation)" :data-filter-relation="relation" @click="state.toggleRelation(relation)">{{ relationLabel(relation, locale) }}</button>
      </fieldset>
      <button v-if="hasMoreOptions" type="button" data-filter-more-options @click="optionLimit += 40">{{ text('catalog.showMore') }}</button>
    </div>
  </section>
</template>

<style scoped>
.advanced-filters {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.75rem;
}
.advanced-filters__body {
  display: grid;
  gap: 0.625rem;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-inline-end: 0.25rem;
  scrollbar-width: thin;
  scrollbar-color: rgb(255 255 255 / 20%) transparent;
}
@supports not (scrollbar-color: auto) {
  .advanced-filters__body::-webkit-scrollbar {
    width: 6px;
  }
  .advanced-filters__body::-webkit-scrollbar-track {
    background: transparent;
  }
  .advanced-filters__body::-webkit-scrollbar-thumb {
    background: rgb(255 255 255 / 20%);
    border-radius: 9999px;
  }
}
header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-block-end: 0.25rem;
  border-block-end: 1px solid rgb(255 255 255 / 10%);
}
h2, p { margin: 0; }
h2 { font-size: 0.9375rem; font-weight: 650; }
fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
legend, label {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
  font-weight: 650;
}
legend { width: 100%; margin-bottom: 0.25rem; }
input, button {
  min-height: 2.25rem;
  padding: 0.375rem 0.625rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.375rem;
  font: inherit;
  font-size: 0.875rem;
}
button { cursor: pointer; }
button[aria-pressed="true"] {
  color: var(--colour-background);
  background: var(--colour-accent);
  border-color: var(--colour-accent-strong);
}
.advanced-filters {
  gap: 0;
  padding: 1rem;
  border: 0;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
}
.advanced-filters__body { gap: 1rem; padding-block: 0.75rem; }
header { padding-block-end: 0.75rem; border-color: var(--liquid-separator); }
h2 { font-size: 1rem; font-weight: 680; }
.advanced-filters__header-actions { display: flex; gap: 0.25rem; align-items: center; }
fieldset { gap: 0.375rem; }
legend { margin-bottom: 0.5rem; color: var(--liquid-text-secondary); font-size: 0.75rem; letter-spacing: 0.04em; }
.advanced-filters__search { display: grid; gap: 0.375rem; }
.advanced-filters__search input {
  width: 100%;
  min-height: 2.75rem;
  padding-inline: 0.875rem;
  border: 0;
  border-radius: var(--liquid-radius-control);
  background: rgb(255 255 255 / 9%);
}
button {
  min-height: 2.75rem;
  border: 0;
  border-radius: var(--liquid-radius-control);
  background: transparent;
  transition: background var(--liquid-motion) var(--liquid-easing), transform var(--liquid-motion) var(--liquid-easing);
}
button:hover { background: rgb(255 255 255 / 9%); }
button[aria-pressed="true"] { color: var(--liquid-text-primary); background: var(--liquid-selected); border: 0; }
@media (max-width: 47.99rem) {
  .advanced-filters { padding: 1rem 1rem max(1rem, env(safe-area-inset-bottom)); }
}
</style>

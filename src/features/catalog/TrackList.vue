<script setup lang="ts">
import { computed } from 'vue'

import WorkGroup from './WorkGroup.vue'
import type { Track } from './types'
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'

const props = defineProps<{ tracks: Track[] }>()
const emit = defineEmits<{
  (event: 'enqueue', track: Track): void
  (event: 'play-now', track: Track): void
}>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

const groups = computed(() => {
  const grouped = new Map<string, Track[]>()
  for (const track of props.tracks) {
    const entries = grouped.get(track.workGroupId)
    if (entries) entries.push(track)
    else grouped.set(track.workGroupId, [track])
  }
  return [...grouped.entries()].map(([id, tracks]) => ({ id, tracks }))
})

function fullTrack(track: Pick<Track, 'id'>): Track | undefined {
  return props.tracks.find(({ id }) => id === track.id)
}
</script>

<template>
  <section class="track-list" :aria-label="text('catalog.tracksLabel')">
    <p v-if="groups.length === 0" class="track-list__empty" role="status">{{ text('catalog.noResults') }}</p>
    <WorkGroup
      v-for="group in groups"
      :key="group.id"
      :tracks="group.tracks"
      @play-now="(track) => { const value = fullTrack(track); if (value) emit('play-now', value) }"
      @enqueue="(track) => { const value = fullTrack(track); if (value) emit('enqueue', value) }"
    />
  </section>
</template>

<style scoped>
.track-list { display: grid; gap: 0.75rem; }
.track-list__empty { margin: 0; padding: 1rem; color: var(--colour-text-muted); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: var(--radius-surface); }
</style>

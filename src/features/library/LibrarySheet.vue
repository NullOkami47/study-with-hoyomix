<script setup lang="ts">
import type { Track } from '../catalog/types'
import { usePreferences } from '../../stores/preferences'
import MusicLibrary from './MusicLibrary.vue'
import type { LocalLibraryRepository } from './localRepository'
import type { PlaybackStore } from '../player/store'

const props = withDefaults(defineProps<{
  tracks: Track[]
  library?: LocalLibraryRepository
  player: PlaybackStore
}>(), {
  library: undefined,
})
const { locale } = usePreferences()
</script>

<template>
  <div class="library-sheet" data-library-sheet>
    <MusicLibrary :tracks="tracks" :player="player" :locale="locale" />
  </div>
</template>

<style scoped>
.library-sheet { display: grid; gap: 1rem; padding: 1rem; }
</style>

<script setup lang="ts">
import { ListPlus, Play } from 'lucide-vue-next'

import type { Track } from './types'
import { translate, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from './displayTitle'
import { usePreferences } from '../../stores/preferences'

/**
 * `aliases` is optional here: the resolver already treats a missing alias map as "no localised
 * title available" and falls back to the canonical title, and callers that only care about identity
 * should not be forced to supply an empty map.
 */
type WorkGroupTrack = Pick<Track, 'id' | 'title' | 'needsClassification'> & { aliases?: Track['aliases'] }

defineProps<{ tracks: WorkGroupTrack[] }>()
const emit = defineEmits<{
  (event: 'enqueue', track: WorkGroupTrack): void
  (event: 'play-now', track: WorkGroupTrack): void
}>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
/** Display-only localised label; identity and playback still use the untouched track. */
const label = (track: WorkGroupTrack): string => resolveDisplayTitle(track, locale.value, track.title)
const formatTitle = (key: 'catalog.playNow' | 'catalog.enqueue', title: string): string => text(key).replace('{title}', title)
</script>

<template>
  <article v-if="tracks.length" class="work-group surface-glass" data-work-group>
    <header>
      <div>
        <p>{{ text('catalog.work') }}</p>
        <h3>{{ tracks[0] ? label(tracks[0]) : '' }}</h3>
      </div>
      <span>{{ tracks.length }} {{ text(tracks.length === 1 ? 'catalog.release' : 'catalog.versions') }}</span>
    </header>
    <ul>
      <li v-for="track in tracks" :key="track.id" data-track-version>
        <div>
          <strong>{{ label(track) }}</strong>
          <span v-if="track.needsClassification" data-unclassified>{{ text('catalog.needsClassification') }}</span>
        </div>
        <div class="work-group__actions">
          <button type="button" :aria-label="formatTitle('catalog.playNow', label(track))" @click="emit('play-now', track)">
            <Play :size="16" aria-hidden="true" />
          </button>
          <button type="button" :aria-label="formatTitle('catalog.enqueue', label(track))" @click="emit('enqueue', track)">
            <ListPlus :size="16" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>
  </article>
</template>

<style scoped>
.work-group { padding: 1rem; border-radius: var(--radius-surface); }
header, li { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; }
header { padding-bottom: 0.75rem; border-bottom: var(--glass-border); }
header p, header h3 { margin: 0; }
header p, header > span, [data-unclassified] { color: var(--colour-text-muted); font-size: 0.75rem; }
header h3 { margin-top: 0.25rem; font-size: 1rem; }
ul { display: grid; gap: 0.5rem; margin: 0.75rem 0 0; padding: 0; list-style: none; }
li > div:first-child { display: grid; gap: 0.25rem; min-width: 0; }
strong { overflow: hidden; font-size: 0.875rem; text-overflow: ellipsis; white-space: nowrap; }
[data-unclassified] { color: var(--colour-accent-strong); }
.work-group__actions { display: flex; gap: 0.5rem; }
button { display: grid; width: 2.75rem; height: 2.75rem; padding: 0; place-items: center; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 50%; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
button:hover { filter: brightness(1.15); }
button:active { transform: scale(0.94); }
</style>

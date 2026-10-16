<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { ArrowDown, ArrowUp } from 'lucide-vue-next'

import type { Track } from '../catalog/types'
import { translate, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import { usePreferences } from '../../stores/preferences'
import { getDefaultLocalLibraryRepository, type LocalLibraryRepository } from './localRepository'
import { createEmptyLocalLibrary, type LibraryExport, type LocalPlaylist } from './types'

const props = withDefaults(
  defineProps<{
    repository?: LocalLibraryRepository
    tracks?: readonly Track[]
    playlistIdFactory?: () => string
  }>(),
  {
    repository: () => getDefaultLocalLibraryRepository(),
    tracks: () => [],
    playlistIdFactory: () =>
      globalThis.crypto?.randomUUID?.() ?? `playlist-${Date.now().toString(36)}`,
  },
)

const emit = defineEmits<{ (event: 'play-now', track: Track): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
/**
 * Display-only localised label.
 *
 * The `<option :value="track.id">` binding is the identity; the label is a separate concern, so a
 * language switch can never change which track an add-to-playlist control actually selects.
 */
const label = (track: Track): string => resolveDisplayTitle(track, locale.value, track.title)
const format = (key: TranslationKey, values: Record<string, string>): string => {
  let result = text(key)
  for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value)
  return result
}

const library = shallowRef<LibraryExport>(createEmptyLocalLibrary())
const selectedTrackId = ref('')
const playlistName = ref('')
const playlistTrackSelections = reactive<Record<string, string>>({})
const status = ref('')
const storageMode = ref<'persistent' | 'memory'>('persistent')
const trackById = computed(() => new Map(props.tracks.map((track) => [track.id, track])))
const historyEnabled = computed(() => library.value.preferences.historyEnabled)
const favouriteTracks = computed(() =>
  library.value.favourites.map(({ trackId }) => {
    const track = trackById.value.get(trackId)
    // `displayTitle` (not `title`) so every call site is self-evidently a
    // localised display value rather than the canonical recording title.
    // `trackId` remains the identity, so a language switch cannot change which
    // track a control acts on.
    return {
      trackId,
      displayTitle: track ? resolveDisplayTitle(track, locale.value, track.title) : trackId,
      track,
    }
  }),
)

function trackTitle(trackId: string): string {
  const track = trackById.value.get(trackId)
  // Display-only, same rationale as `label()`.
  return track ? resolveDisplayTitle(track, locale.value, track.title) : trackId
}

function catalogTrack(trackId: string): Track | undefined {
  return trackById.value.get(trackId)
}

function playPlaylistTrack(trackId: string): void {
  const track = catalogTrack(trackId)
  if (track) emit('play-now', track)
}

async function refresh(): Promise<void> {
  try {
    library.value = await props.repository.exportLocalLibrary()
    storageMode.value = props.repository.storageMode()
  } catch {
    status.value = text('library.actionFailed')
  }
}

async function runLibraryAction(action: () => Promise<unknown>): Promise<void> {
  status.value = ''
  try {
    await action()
    await refresh()
  } catch {
    status.value = text('library.actionFailed')
  }
}

async function addFavourite(): Promise<void> {
  if (selectedTrackId.value) await runLibraryAction(() => props.repository.addFavourite(selectedTrackId.value))
}

async function createPlaylist(): Promise<void> {
  const name = playlistName.value.trim()
  if (!name) return
  await runLibraryAction(() => props.repository.createPlaylist({ id: props.playlistIdFactory(), name }))
  playlistName.value = ''
}

async function addToPlaylist(playlist: LocalPlaylist): Promise<void> {
  const trackId = playlistTrackSelections[playlist.id]
  if (trackId) await runLibraryAction(() => props.repository.setPlaylistOrder(playlist.id, [...playlist.trackIds, trackId]))
}

async function moveTrack(playlist: LocalPlaylist, index: number, direction: -1 | 1): Promise<void> {
  const destination = index + direction
  if (destination < 0 || destination >= playlist.trackIds.length) return
  const reordered = [...playlist.trackIds]
  ;[reordered[index], reordered[destination]] = [reordered[destination], reordered[index]]
  await runLibraryAction(() => props.repository.setPlaylistOrder(playlist.id, reordered))
}

async function removeFromPlaylist(playlist: LocalPlaylist, trackId: string): Promise<void> {
  await runLibraryAction(() =>
    props.repository.setPlaylistOrder(
      playlist.id,
      playlist.trackIds.filter((candidate) => candidate !== trackId),
    ),
  )
}

async function setHistoryEnabled(event: Event): Promise<void> {
  await runLibraryAction(() => props.repository.setHistoryEnabled((event.target as HTMLInputElement).checked))
}

async function exportJson(): Promise<void> {
  let url: string | undefined
  try {
    const exported = await props.repository.exportLocalLibrary()
    url = URL.createObjectURL(new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'study-with-hoyomix-library.json'
    anchor.click()
    status.value = text('library.exportReady')
  } catch {
    status.value = text('library.actionFailed')
  } finally {
    const exportUrl = url
    if (exportUrl) setTimeout(() => URL.revokeObjectURL(exportUrl), 0)
  }
}

let unsubscribe: () => void = () => undefined
onMounted(() => {
  unsubscribe = props.repository.subscribe((nextLibrary) => {
    library.value = nextLibrary
    storageMode.value = props.repository.storageMode()
  })
  void refresh()
})
onBeforeUnmount(() => unsubscribe())
</script>

<template>
  <section class="library-panel surface-glass" :aria-label="text('library.title')">
    <header class="library-panel__header">
      <div>
        <h2>{{ text('library.title') }}</h2>
        <p>{{ text('library.anonymousNotice') }}</p>
        <p v-if="storageMode === 'memory'" class="library-panel__storage-notice" role="status">
          {{ text('library.memoryOnlyNotice') }}
        </p>
      </div>
      <button type="button" :aria-label="text('library.export')" @click="exportJson">{{ text('library.export') }}</button>
    </header>

    <div class="library-panel__picker">
      <label>
        <span>{{ text('library.trackPicker') }}</span>
        <select v-model="selectedTrackId" :aria-label="text('library.trackPicker')">
          <option value="">—</option>
          <option v-for="track in tracks" :key="track.id" :value="track.id">{{ label(track) }}</option>
        </select>
      </label>
      <button type="button" :aria-label="text('library.addFavourite')" :disabled="!selectedTrackId" @click="addFavourite">
        {{ text('library.addFavourite') }}
      </button>
    </div>

    <section class="library-panel__section" aria-labelledby="library-favourites-heading">
      <h3 id="library-favourites-heading">{{ text('library.favourites') }}</h3>
      <p v-if="favouriteTracks.length === 0">{{ text('library.favouritesEmpty') }}</p>
      <ul v-else class="library-panel__list">
        <li v-for="favourite in favouriteTracks" :key="favourite.trackId">
          <span>{{ favourite.displayTitle }}</span>
          <div class="library-panel__actions">
            <button v-if="favourite.track" type="button" :aria-label="format('library.playFavourite', { title: favourite.displayTitle })" @click="emit('play-now', favourite.track)">
              {{ text('player.play') }}
            </button>
            <button type="button" :aria-label="format('library.removeFavourite', { title: favourite.displayTitle })" @click="runLibraryAction(() => repository.removeFavourite(favourite.trackId))">
              {{ text('library.removeFavourite').replace('{title}', '') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section class="library-panel__section" aria-labelledby="library-playlists-heading">
      <h3 id="library-playlists-heading">{{ text('library.playlists') }}</h3>
      <form class="library-panel__picker" @submit.prevent="createPlaylist">
        <label>
          <span>{{ text('library.playlistName') }}</span>
          <input v-model="playlistName" :aria-label="text('library.playlistName')" maxlength="80" />
        </label>
        <button type="submit" :aria-label="text('library.createPlaylist')" :disabled="!playlistName.trim()">{{ text('library.createPlaylist') }}</button>
      </form>
      <p v-if="library.playlists.length === 0">{{ text('library.playlistsEmpty') }}</p>
      <article v-for="playlist in library.playlists" :key="playlist.id" class="library-panel__playlist">
        <header>
          <h4>{{ playlist.name }}</h4>
          <button type="button" :aria-label="format('library.deletePlaylist', { name: playlist.name })" @click="runLibraryAction(() => repository.deletePlaylist(playlist.id))">
            {{ text('library.deletePlaylist').replace('{name}', '') }}
          </button>
        </header>
        <ol class="library-panel__ordered-list">
          <li v-for="(trackId, index) in playlist.trackIds" :key="trackId">
            <span>{{ trackTitle(trackId) }}</span>
            <div class="library-panel__actions">
              <button
                type="button"
                :aria-label="format('library.playPlaylistTrack', { title: trackTitle(trackId), name: playlist.name })"
                :disabled="!catalogTrack(trackId)"
                @click="playPlaylistTrack(trackId)"
              >
                {{ text('player.play') }}
              </button>
              <button
                type="button"
                :aria-label="format('library.removePlaylistTrack', { title: trackTitle(trackId), name: playlist.name })"
                @click="removeFromPlaylist(playlist, trackId)"
              >
                {{ text('library.removePlaylistTrack').replace('{title}', '').replace('{name}', '') }}
              </button>
              <button type="button" :aria-label="format('library.moveUp', { title: trackTitle(trackId), name: playlist.name })" :disabled="index === 0" @click="moveTrack(playlist, index, -1)">
                <ArrowUp :size="18" aria-hidden="true" />
              </button>
              <button type="button" :aria-label="format('library.moveDown', { title: trackTitle(trackId), name: playlist.name })" :disabled="index === playlist.trackIds.length - 1" @click="moveTrack(playlist, index, 1)">
                <ArrowDown :size="18" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ol>
        <div class="library-panel__picker">
          <label>
            <span>{{ format('library.trackForPlaylist', { name: playlist.name }) }}</span>
            <select v-model="playlistTrackSelections[playlist.id]" :aria-label="format('library.trackForPlaylist', { name: playlist.name })">
              <option value="">—</option>
              <option v-for="track in tracks" :key="track.id" :value="track.id">{{ label(track) }}</option>
            </select>
          </label>
          <button type="button" :aria-label="format('library.addToPlaylist', { name: playlist.name })" :disabled="!playlistTrackSelections[playlist.id]" @click="addToPlaylist(playlist)">
            {{ format('library.addToPlaylist', { name: playlist.name }) }}
          </button>
        </div>
      </article>
    </section>

    <section class="library-panel__section" aria-labelledby="library-history-heading">
      <h3 id="library-history-heading">{{ text('library.history') }}</h3>
      <label class="library-panel__toggle">
        <input type="checkbox" :checked="historyEnabled" :aria-label="text('library.historyOptIn')" @change="setHistoryEnabled" />
        <span>{{ text('library.historyOptIn') }}</span>
      </label>
      <p>{{ library.recentHistory.length }} {{ text('library.historyCount') }}</p>
      <button type="button" :aria-label="text('library.clearHistory')" @click="runLibraryAction(() => repository.clearHistory())">{{ text('library.clearHistory') }}</button>
    </section>

    <p class="library-panel__status" role="status" aria-live="polite">{{ status }}</p>
  </section>
</template>

<style scoped>
.library-panel { display: grid; gap: 1rem; padding: 1rem; border-radius: var(--radius-surface); color: var(--colour-text-primary); }
.library-panel__header,
.library-panel__playlist > header,
.library-panel__list li,
.library-panel__ordered-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.library-panel h2, .library-panel h3, .library-panel h4, .library-panel p { margin: 0; }
.library-panel__header p, .library-panel__section > p { color: var(--colour-text-muted); font-size: 0.875rem; }
.library-panel__header .library-panel__storage-notice { color: var(--colour-accent-strong); }
.library-panel__picker { display: grid; gap: 0.75rem; }
.library-panel__picker label { display: grid; gap: 0.5rem; color: var(--colour-text-muted); font-size: 0.875rem; }
.library-panel__section, .library-panel__playlist { display: grid; gap: 0.75rem; }
.library-panel__section { padding-block-start: 1rem; border-block-start: var(--glass-border); }
.library-panel__playlist { padding: 0.75rem; background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; }
.library-panel__list, .library-panel__ordered-list { display: grid; gap: 0.5rem; margin: 0; padding-inline-start: 1.25rem; }
.library-panel__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.library-panel button, .library-panel select, .library-panel input { min-height: 2.75rem; padding: 0.5rem 0.75rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; font: inherit; }
.library-panel button { cursor: pointer; transition: transform var(--motion-duration), filter var(--motion-duration); }
.library-panel select { cursor: pointer; transition: transform var(--motion-duration), filter var(--motion-duration); }
.library-panel select:hover { filter: var(--control-hover-filter); }
.library-panel select:active { transform: translateY(var(--decorative-displacement)); filter: var(--control-active-filter); }
.library-panel select:focus-visible { filter: var(--control-hover-filter); }
.library-panel button:hover:not(:disabled) { filter: var(--control-hover-filter); }
.library-panel button:active:not(:disabled) { transform: translateY(var(--decorative-displacement)); filter: var(--control-active-filter); }
.library-panel button:disabled { cursor: not-allowed; opacity: 0.55; }
.library-panel__toggle { display: flex; align-items: center; gap: 0.75rem; min-height: 2.75rem; }
.library-panel__toggle input { width: 2.75rem; min-height: 2.75rem; }
.library-panel__status { min-height: 1.5rem; color: var(--colour-accent-strong); }
</style>

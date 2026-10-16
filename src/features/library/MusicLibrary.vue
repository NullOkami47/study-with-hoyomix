<script setup lang="ts">
/**
 * The Music Library: a browser over the canonical catalogue.
 *
 * ## What it browses
 *
 * All Tracks, Games and Albums, all derived from the `tracks` the workspace already holds —
 * there is no second catalogue here and no fetch. `buildCatalogueIndex` derives the album and
 * game structure once per catalogue revision; everything below reads from it.
 *
 * ## Queue isolation
 *
 * This component reaches the playback store through exactly three functions, all of which are
 * called only from a track row's own button: {@link playTrack}, {@link enqueueTrack} and
 * {@link playNextTrack}. Nothing in the browsing path — changing section, opening a game,
 * opening an album, typing a query — touches the store at all. That is the whole mechanism:
 * there is no watcher, no effect, and no shared state between the browser and the queue, so
 * browsing cannot add, clear, reorder or rebuild what is playing.
 *
 * The store is passed in as a narrow `Pick`, so this file cannot reach the rest of the player
 * even by accident.
 *
 * ## Performance
 *
 * The catalogue is thousands of tracks. Three things keep browsing cheap:
 *
 *   1. The index and every searchable string are built once per catalogue revision, not per
 *      render or per keystroke.
 *   2. Only a page of rows is rendered at a time (40 tracks, 24 albums). A query that matches
 *      two thousand tracks reports the true count and renders one page of them.
 *   3. Nothing is fetched. The catalogue is already in memory, so there is no request to
 *      debounce and no D1 read to ration.
 */

import { computed, ref, watch } from 'vue'
import { ArrowLeft } from 'lucide-vue-next'

import { translate, type Locale, type TranslationKey } from '../../i18n'
import type { Track } from '../catalog/types'
import type { PlaybackStore } from '../player/store'
import AlbumCard from './AlbumCard.vue'
import GameCard from './GameCard.vue'
import TrackRow from './TrackRow.vue'
import {
  albumTracks,
  buildCatalogueIndex,
  gameAlbums,
  gameLabel,
  gameTracks,
  type AlbumEntry,
  type GameEntry,
} from './catalogueIndex'
import { searchCatalogue } from './catalogueSearch'
import {
  createLibraryBrowsingState,
  LIBRARY_SECTIONS,
  type LibrarySection,
} from './libraryBrowsingState'

const props = defineProps<{
  tracks: Track[]
  /**
   * The only part of the playback store this component may use. Narrow on purpose: browsing
   * needs to act on a track the user pressed, and nothing else.
   */
  player: Pick<PlaybackStore, 'enqueue' | 'playNow' | 'playNext'>
  locale: Locale
}>()

const text = (key: TranslationKey): string => translate(props.locale, key)
const format = (key: TranslationKey, values: Record<string, string>): string => {
  let result = text(key)
  for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value)
  return result
}

/** Rows rendered per page. Bounds rendering, never the reported count. */
const TRACKS_PER_PAGE = 40
const ALBUMS_PER_PAGE = 24

const browsing = createLibraryBrowsingState()
const query = ref('')
const shownTracks = ref(TRACKS_PER_PAGE)
const shownAlbums = ref(ALBUMS_PER_PAGE)

const index = computed(() => buildCatalogueIndex(props.tracks))
const results = computed(() => searchCatalogue(index.value, query.value))
const searchActive = computed(() => results.value.needle.length > 0)

// A new query or a new location starts at the first page. Paging further does not reset,
// because the pagination refs are not themselves watched.
watch(
  [query, () => browsing.section.value, () => browsing.gameId.value, () => browsing.albumId.value],
  () => {
    shownTracks.value = TRACKS_PER_PAGE
    shownAlbums.value = ALBUMS_PER_PAGE
  },
)

const activeGame = computed<GameEntry | null>(() => {
  const id = browsing.gameId.value
  return id === null ? null : (index.value.games.find((game) => game.id === id) ?? null)
})
const activeAlbum = computed<AlbumEntry | null>(() => {
  const id = browsing.albumId.value
  return id === null ? null : (index.value.albumById.get(id) ?? null)
})

const allTracks = computed(() => index.value.tracks)
const allAlbums = computed(() => index.value.albums)
const gameAlbumList = computed(() => (activeGame.value ? gameAlbums(index.value, activeGame.value.id) : []))
const gameTrackList = computed(() => (activeGame.value ? gameTracks(index.value, activeGame.value.id) : []))
const albumTrackList = computed(() =>
  activeAlbum.value ? albumTracks(index.value, activeAlbum.value.id) : [],
)

const visibleAllTracks = computed(() => allTracks.value.slice(0, shownTracks.value))
const visibleSearchTracks = computed(() => results.value.tracks.slice(0, shownTracks.value))
const visibleSearchAlbums = computed(() => results.value.albums.slice(0, shownAlbums.value))
const visibleAlbums = computed(() => allAlbums.value.slice(0, shownAlbums.value))
const visibleGameAlbums = computed(() => gameAlbumList.value.slice(0, shownAlbums.value))
const visibleGameTracks = computed(() => gameTrackList.value.slice(0, shownTracks.value))
const visibleAlbumTracks = computed(() => albumTrackList.value.slice(0, shownTracks.value))

const sectionLabelKey: Record<LibrarySection, TranslationKey> = {
  all: 'musicLibrary.section.tracks',
  games: 'musicLibrary.section.games',
  albums: 'musicLibrary.section.albums',
}

const totalTrackCount = computed(() =>
  format('musicLibrary.trackCount', { count: String(allTracks.value.length) }),
)
const totalAlbumCount = computed(() =>
  format('musicLibrary.albumCount', { count: String(allAlbums.value.length) }),
)
const searchSummary = computed(() =>
  format('musicLibrary.resultCount', { count: String(results.value.total) }),
)
const activeGameCounts = computed(() =>
  activeGame.value
    ? format('musicLibrary.gameCounts', {
        albums: String(activeGame.value.albumIds.length),
        tracks: String(activeGame.value.trackCount),
      })
    : '',
)
const activeAlbumCounts = computed(() =>
  activeAlbum.value
    ? format('musicLibrary.trackCount', { count: String(activeAlbum.value.trackCount) })
    : '',
)

/** Album title to show under a row, or `undefined` when the catalogue stores none. */
function albumTitleFor(track: Track): string | undefined {
  const albumId = index.value.albumIdByTrackId.get(track.id)
  return albumId === undefined ? undefined : index.value.albumById.get(albumId)?.title
}

/** Game label to show under a row, or `undefined` when the track belongs to no game. */
function gameTitleFor(track: Track): string | undefined {
  const game = track.games[0]
  return game === undefined ? undefined : gameLabel(game, props.locale)
}

// --- The only three calls into the playback store, each from an explicit press. ---

function playTrack(track: Track): void {
  void props.player.playNow(track)
}

function enqueueTrack(track: Track): void {
  props.player.enqueue(track)
}

function playNextTrack(track: Track): void {
  props.player.playNext(track)
}

// --- Browsing. None of these touch the playback store. ---

function onSearchInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
}

function clearSearch(): void {
  query.value = ''
}

function openGame(game: GameEntry): void {
  // Opening a destination from a search result ends the search: the user picked somewhere to
  // go, and leaving a stale query in the box would keep the browser showing results instead
  // of the game they just asked for.
  query.value = ''
  browsing.setGame(game.id)
  browsing.setSection('games')
}

function closeGame(): void {
  browsing.setGame(null)
}

function openAlbum(album: AlbumEntry): void {
  query.value = ''
  if (album.game !== null) browsing.setGame(album.game)
  browsing.setAlbum(album.id)
  browsing.setSection('albums')
}

function closeAlbum(): void {
  browsing.setAlbum(null)
}

function showMoreTracks(): void {
  shownTracks.value += TRACKS_PER_PAGE
}

function showMoreAlbums(): void {
  shownAlbums.value += ALBUMS_PER_PAGE
}
</script>

<template>
  <section class="music-library" data-music-library data-library-catalogue :aria-label="text('musicLibrary.title')">
    <h3 class="music-library__title">{{ text('musicLibrary.title') }}</h3>

    <div class="music-library__search">
      <label class="music-library__search-field">
        <span>{{ text('musicLibrary.searchLabel') }}</span>
        <input
          type="search"
          data-music-library-search
          :value="query"
          :placeholder="text('musicLibrary.searchPlaceholder')"
          autocomplete="off"
          @input="onSearchInput"
        />
      </label>
      <button
        v-if="query"
        type="button"
        class="music-library__control"
        data-music-library-search-clear
        @click="clearSearch"
      >
        {{ text('musicLibrary.clearSearch') }}
      </button>
    </div>

    <template v-if="searchActive">
      <p class="music-library__note" data-music-library-search-summary aria-live="polite">
        {{ searchSummary }}
      </p>
      <p
        v-if="results.total === 0"
        class="music-library__note"
        data-music-library-search-empty
        role="status"
      >
        {{ text('musicLibrary.searchEmpty') }}
      </p>

      <template v-else>
        <section
          v-if="results.games.length > 0"
          class="music-library__group"
          data-search-group="games"
          :aria-label="text('musicLibrary.games')"
        >
          <h4 class="music-library__group-title" data-search-count="games">
            {{ text('musicLibrary.games') }} · {{ results.games.length }}
          </h4>
          <ul class="music-library__games" data-search-games>
            <GameCard
              v-for="hit in results.games"
              :key="hit.game.id"
              :game="hit.game"
              :locale="locale"
              @open="openGame"
            />
          </ul>
        </section>

        <section
          v-if="results.albums.length > 0"
          class="music-library__group"
          data-search-group="albums"
          :aria-label="text('musicLibrary.albums')"
        >
          <h4 class="music-library__group-title" data-search-count="albums">
            {{ text('musicLibrary.albums') }} · {{ results.albums.length }}
          </h4>
          <ul class="music-library__albums" data-search-albums>
            <AlbumCard
              v-for="hit in visibleSearchAlbums"
              :key="hit.album.id"
              :album="hit.album"
              :locale="locale"
              @open="openAlbum"
            />
          </ul>
          <button
            v-if="results.albums.length > shownAlbums"
            type="button"
            class="music-library__control music-library__more"
            data-search-more-albums
            @click="showMoreAlbums"
          >
            {{ text('catalog.showMore') }}
          </button>
        </section>

        <section
          v-if="results.tracks.length > 0"
          class="music-library__group"
          data-search-group="tracks"
          :aria-label="text('musicLibrary.tracks')"
        >
          <h4 class="music-library__group-title" data-search-count="tracks">
            {{ text('musicLibrary.tracks') }} · {{ results.tracks.length }}
          </h4>
          <ul class="music-library__tracks" data-search-tracks>
            <TrackRow
              v-for="hit in visibleSearchTracks"
              :key="hit.track.id"
              :track="hit.track"
              :locale="locale"
              :album="albumTitleFor(hit.track)"
              :game="gameTitleFor(hit.track)"
              @play="playTrack"
              @enqueue="enqueueTrack"
              @play-next="playNextTrack"
            />
          </ul>
          <button
            v-if="results.tracks.length > shownTracks"
            type="button"
            class="music-library__control music-library__more"
            data-search-more-tracks
            @click="showMoreTracks"
          >
            {{ text('catalog.showMore') }}
          </button>
        </section>
      </template>
    </template>

    <template v-else>
      <div
        class="music-library__sections"
        role="group"
        :aria-label="text('musicLibrary.sectionsLabel')"
      >
        <button
          v-for="section in LIBRARY_SECTIONS"
          :key="section"
          type="button"
          class="music-library__control"
          :class="{ 'music-library__section--current': browsing.section.value === section }"
          :data-library-section="section"
          :data-library-tab="section"
          :aria-pressed="browsing.section.value === section ? 'true' : 'false'"
          @click="browsing.setSection(section)"
        >
          {{ text(sectionLabelKey[section]) }}
        </button>
      </div>

      <section
        v-if="browsing.section.value === 'all'"
        class="music-library__panel"
        data-library-panel="all"
        :aria-label="text('musicLibrary.section.tracks')"
      >
        <p class="music-library__note" data-library-track-count>{{ totalTrackCount }}</p>
        <p v-if="allTracks.length === 0" class="music-library__note" role="status">
          {{ text('musicLibrary.noTracks') }}
        </p>
        <ul v-else class="music-library__tracks" data-library-tracks>
          <TrackRow
            v-for="track in visibleAllTracks"
            :key="track.id"
            :track="track"
            :locale="locale"
            :album="albumTitleFor(track)"
            :game="gameTitleFor(track)"
            @play="playTrack"
            @enqueue="enqueueTrack"
            @play-next="playNextTrack"
          />
        </ul>
        <button
          v-if="allTracks.length > shownTracks"
          type="button"
          class="music-library__control music-library__more"
          data-library-more-tracks
          @click="showMoreTracks"
        >
          {{ text('catalog.showMore') }}
        </button>
      </section>

      <section
        v-else-if="browsing.section.value === 'games'"
        class="music-library__panel"
        data-library-panel="games"
        :aria-label="text('musicLibrary.section.games')"
      >
        <template v-if="activeGame">
          <button
            type="button"
            class="music-library__control music-library__back"
            data-library-back
            @click="closeGame"
          >
            <ArrowLeft :size="16" aria-hidden="true" />
            <span>{{ text('musicLibrary.backToGames') }}</span>
          </button>
          <h4 class="music-library__group-title" data-active-game-name>
            {{ gameLabel(activeGame.id, locale) }}
          </h4>
          <p class="music-library__note" data-active-game-counts>{{ activeGameCounts }}</p>

          <h5 class="music-library__group-title">{{ text('musicLibrary.albums') }}</h5>
          <p v-if="gameAlbumList.length === 0" class="music-library__note" role="status">
            {{ text('musicLibrary.noAlbums') }}
          </p>
          <ul v-else class="music-library__albums" data-game-albums>
            <AlbumCard
              v-for="album in visibleGameAlbums"
              :key="album.id"
              :album="album"
              :locale="locale"
              @open="openAlbum"
            />
          </ul>
          <button
            v-if="gameAlbumList.length > shownAlbums"
            type="button"
            class="music-library__control music-library__more"
            data-game-more-albums
            @click="showMoreAlbums"
          >
            {{ text('catalog.showMore') }}
          </button>

          <h5 class="music-library__group-title">{{ text('musicLibrary.tracks') }}</h5>
          <ul class="music-library__tracks" data-game-tracks>
            <TrackRow
              v-for="track in visibleGameTracks"
              :key="track.id"
              :track="track"
              :locale="locale"
              :album="albumTitleFor(track)"
              :game="gameTitleFor(track)"
              @play="playTrack"
              @enqueue="enqueueTrack"
              @play-next="playNextTrack"
            />
          </ul>
          <button
            v-if="gameTrackList.length > shownTracks"
            type="button"
            class="music-library__control music-library__more"
            data-game-more-tracks
            @click="showMoreTracks"
          >
            {{ text('catalog.showMore') }}
          </button>
        </template>

        <ul v-else class="music-library__games" data-library-games>
          <GameCard
            v-for="game in index.games"
            :key="game.id"
            :game="game"
            :locale="locale"
            @open="openGame"
          />
        </ul>
      </section>

      <section
        v-else
        class="music-library__panel"
        data-library-panel="albums"
        :aria-label="text('musicLibrary.section.albums')"
      >
        <template v-if="activeAlbum">
          <button
            type="button"
            class="music-library__control music-library__back"
            data-library-back
            @click="closeAlbum"
          >
            <ArrowLeft :size="16" aria-hidden="true" />
            <span>{{ text('musicLibrary.backToAlbums') }}</span>
          </button>
          <h4 class="music-library__group-title" data-active-album-title>{{ activeAlbum.title }}</h4>
          <p class="music-library__note" data-active-album-counts>
            <span>{{ activeAlbumCounts }}</span>
            <template v-if="activeAlbum.game"> · {{ gameLabel(activeAlbum.game, locale) }}</template>
          </p>
          <ul class="music-library__tracks" data-album-tracks>
            <TrackRow
              v-for="track in visibleAlbumTracks"
              :key="track.id"
              :track="track"
              :locale="locale"
              :album="activeAlbum.title"
              :game="gameTitleFor(track)"
              @play="playTrack"
              @enqueue="enqueueTrack"
              @play-next="playNextTrack"
            />
          </ul>
          <button
            v-if="albumTrackList.length > shownTracks"
            type="button"
            class="music-library__control music-library__more"
            data-album-more-tracks
            @click="showMoreTracks"
          >
            {{ text('catalog.showMore') }}
          </button>
        </template>

        <template v-else>
          <p class="music-library__note" data-library-album-count>{{ totalAlbumCount }}</p>
          <p v-if="allAlbums.length === 0" class="music-library__note" role="status">
            {{ text('musicLibrary.noAlbums') }}
          </p>
          <ul v-else class="music-library__albums" data-library-albums>
            <AlbumCard
              v-for="album in visibleAlbums"
              :key="album.id"
              :album="album"
              :locale="locale"
              @open="openAlbum"
            />
          </ul>
          <button
            v-if="allAlbums.length > shownAlbums"
            type="button"
            class="music-library__control music-library__more"
            data-library-more-albums
            @click="showMoreAlbums"
          >
            {{ text('catalog.showMore') }}
          </button>
        </template>
      </section>
    </template>
  </section>
</template>

<style scoped>
.music-library {
  display: grid;
  gap: 0.875rem;
  min-width: 0;
  color: var(--liquid-text-primary);
}
.music-library__title { margin: 0; font-size: 1rem; }
.music-library__search { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; }
.music-library__search-field {
  display: grid;
  flex: 1 1 12rem;
  gap: 0.25rem;
  min-width: 0;
  color: var(--liquid-text-secondary);
  font-size: 0.8125rem;
}
.music-library__search-field input {
  inline-size: 100%;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  color: var(--liquid-text-primary);
  background: rgb(255 255 255 / 9%);
  border: 0;
  border-radius: var(--liquid-radius-control);
  font: inherit;
}
.music-library__control {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--liquid-text-primary);
  background: var(--liquid-selected);
  border: 0;
  border-radius: var(--liquid-radius-control);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  transition: filter var(--liquid-motion) var(--liquid-easing);
}
.music-library__control:hover { filter: var(--control-hover-filter); }
.music-library__control:active { filter: var(--control-active-filter); }
.music-library__section--current {
  font-weight: 650;
  background: rgb(255 255 255 / 20%);
  box-shadow: var(--liquid-inner-light);
}
.music-library__sections { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.music-library__back {
  display: inline-flex;
  justify-self: start;
  gap: 0.375rem;
  align-items: center;
}
.music-library__more { justify-self: start; }
.music-library__panel,
.music-library__group { display: grid; gap: 0.625rem; min-width: 0; }
.music-library__group-title,
.music-library__note { margin: 0; min-width: 0; }
.music-library__group-title { font-size: 0.9375rem; overflow-wrap: anywhere; }
.music-library__note { color: var(--liquid-text-secondary); font-size: 0.8125rem; }
.music-library__albums {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 9rem), 1fr));
  gap: 0.625rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.music-library__games {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr));
  gap: 0.625rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.music-library__tracks { display: grid; min-width: 0; margin: 0; padding: 0; list-style: none; }
@media (prefers-reduced-motion: reduce) {
  .music-library__control { transition-duration: 0ms; }
}
</style>

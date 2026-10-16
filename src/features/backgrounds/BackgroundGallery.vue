<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { translate, type Locale, type TranslationKey } from '../../i18n'
import { backgroundTitle, BACKGROUND_COLLECTIONS, collectionLabelKey, gameLabelKey } from './catalogue'
import type { BackgroundStore } from './store'
import {
  BACKGROUND_INTERVAL_CHOICES,
  BACKGROUND_INTERVAL_VALUES,
} from './types'
import type { BackgroundIntervalSeconds, BackgroundPlaybackMode, PublicBackground } from './types'

const props = defineProps<{
  store: BackgroundStore
  locale: Locale
  signedIn: boolean
}>()

interface GalleryGroup {
  key: string
  gameLabel: string | null
  collectionLabel: string | null
  items: PublicBackground[]
}

const text = (key: TranslationKey) => translate(props.locale, key)
const selectedCount = computed(() => props.store.selection.value.selectedIds.length)
const titleFor = (background: PublicBackground) => backgroundTitle(background, props.locale)
const preferredMedia = (background: PublicBackground) => props.store.qualityMode.value === '1440p'
  ? background.highQualityVersion ?? background : background

/**
 * Heading for a group an administrator created that has no curated translation.
 * A slug-like value (`cyberpunk-study`) is spaced and title-cased so it reads as
 * a name; anything already written with spaces is shown exactly as stored. This
 * is display-only: the raw value still travels untouched everywhere else.
 */
function groupHeading(value: string): string {
  if (/\s/u.test(value)) return value
  return value
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Order a group's items by the administrator's display order. The sort is
 * stable, so every background that still carries the default order keeps the
 * catalogue order it already had; only an explicit order moves an item.
 */
function orderItems(items: PublicBackground[]): PublicBackground[] {
  return [...items].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0))
}

const minDisplayOrder = (items: PublicBackground[]): number =>
  items.reduce((lowest, item) => Math.min(lowest, item.displayOrder ?? 0), Number.POSITIVE_INFINITY)

// Curated groups keep their manifest order; anything else (published API rows)
// follows afterwards so the selector never depends on a hard-coded item count.
// Within a group the administrator's display order wins, which is how a
// metadata edit in the admin catalogue reaches the public gallery.
const groups = computed<GalleryGroup[]>(() => {
  const items = props.store.backgrounds.value
  const buckets = new Map<string, PublicBackground[]>()
  const ungrouped: PublicBackground[] = []
  for (const item of items) {
    if (!item.game || !item.collection) {
      ungrouped.push(item)
      continue
    }
    const key = `${item.game}/${item.collection}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  const ordered: GalleryGroup[] = []
  const seenGames = new Set<string>()
  const pushGroup = (game: string, collection: string, bucket: PublicBackground[]) => {
    const gameKey = gameLabelKey(game)
    const collectionKey = collectionLabelKey(game, collection)
    const showGame = !seenGames.has(game)
    seenGames.add(game)
    ordered.push({
      key: `${game}/${collection}`,
      gameLabel: showGame ? (gameKey ? text(gameKey) : groupHeading(game)) : null,
      collectionLabel: collectionKey ? text(collectionKey) : groupHeading(collection),
      items: orderItems(bucket),
    })
  }

  for (const entry of BACKGROUND_COLLECTIONS) {
    const key = `${entry.game}/${entry.collection}`
    const bucket = buckets.get(key)
    if (!bucket) continue
    buckets.delete(key)
    pushGroup(entry.game, entry.collection, bucket)
  }
  // Custom groups an administrator created follow the curated ones, ordered by
  // the earliest display order inside each so a group can be lifted too.
  const custom = [...buckets.entries()].sort(
    ([, left], [, right]) => minDisplayOrder(left) - minDisplayOrder(right),
  )
  for (const [key, bucket] of custom) {
    const [game, collection] = key.split('/')
    pushGroup(game, collection, bucket)
  }
  if (ungrouped.length) {
    ordered.push({ key: 'ungrouped', gameLabel: null, collectionLabel: null, items: orderItems(ungrouped) })
  }
  return ordered
})

function toggle(id: string, event: Event): void {
  props.store.toggle(id, (event.target as HTMLInputElement).checked)
}

function setInterval(event: Event): void {
  const seconds = Number((event.target as HTMLSelectElement).value)
  if (BACKGROUND_INTERVAL_VALUES.includes(seconds as BackgroundIntervalSeconds)) {
    props.store.setInterval(seconds as BackgroundIntervalSeconds)
  }
}

function setPlaybackMode(event: Event): void {
  const mode = (event.target as HTMLSelectElement).value
  if (mode === 'random' || mode === 'sequential') {
    props.store.setPlaybackMode(mode as BackgroundPlaybackMode)
  }
}

// The four minute-long choices are the whole user-facing menu. A stored value
// from an older build is appended so the control still shows what rotation is
// actually using; picking any canonical choice replaces it and persists the
// canonical value.
const intervalOptions = computed<BackgroundIntervalSeconds[]>(() => {
  const stored = props.store.selection.value.intervalSeconds
  const choices: BackgroundIntervalSeconds[] = [...BACKGROUND_INTERVAL_CHOICES]
  if (!choices.includes(stored)) choices.push(stored)
  return choices
})

function intervalLabel(seconds: BackgroundIntervalSeconds): string {
  // Anything of a minute or more is described in minutes, so 300 stays the
  // "5 minutes" it has always been and 600 becomes "10 minutes".
  if (seconds >= 300) return text('settings.backgrounds.minutes').replace('{count}', String(seconds / 60))
  return text('settings.backgrounds.seconds').replace('{count}', String(seconds))
}

onMounted(() => { void props.store.load() })
</script>

<template>
  <div class="background-gallery" data-background-gallery>
    <div class="background-gallery__heading">
      <h4>{{ text('settings.backgrounds.title') }}</h4>
      <p>{{ text('settings.backgrounds.description') }}</p>
      <label class="background-gallery__quality-toggle">
        <input
          data-background-quality
          type="checkbox"
          role="switch"
          :checked="store.qualityMode.value === '1440p'"
          :aria-checked="store.qualityMode.value === '1440p'"
          @change="store.setQualityMode(($event.target as HTMLInputElement).checked ? '1440p' : 'auto')"
        />
        <span>{{ text('settings.backgrounds.highQuality') }}</span>
      </label>
      <p class="background-gallery__quality-note">{{ text('settings.backgrounds.playbackCap') }}</p>
    </div>
    <!-- Offline/degraded: the shipped catalogue is still selectable, so the
         failure is surfaced as a non-blocking notice instead of replacing the
         choices the user can already play. -->
    <div
      v-if="store.status.value === 'unavailable' && store.backgrounds.value.length > 0"
      class="background-gallery__offline"
      data-background-offline
    >
      <p>{{ text('settings.backgrounds.unavailable') }}</p>
      <button type="button" @click="store.load">Retry</button>
    </div>
    <p v-if="store.status.value === 'loading' && store.backgrounds.value.length === 0" role="status">Loading...</p>
    <div v-else-if="store.status.value === 'unavailable' && store.backgrounds.value.length === 0" data-background-unavailable>
      <p>{{ text('settings.backgrounds.unavailable') }}</p>
      <button type="button" @click="store.load">Retry</button>
    </div>
    <p v-else-if="store.backgrounds.value.length === 0">{{ text('settings.backgrounds.empty') }}</p>
    <fieldset v-else class="background-gallery__choices">
      <legend>{{ text('settings.backgrounds.selection').replace('{count}', String(selectedCount)) }}</legend>
      <template v-for="group in groups" :key="group.key">
        <p v-if="group.gameLabel" class="background-gallery__group" data-background-group>{{ group.gameLabel }}</p>
        <p v-if="group.collectionLabel" class="background-gallery__collection" data-background-collection>{{ group.collectionLabel }}</p>
        <label
          v-for="background in group.items"
          :key="background.id"
          class="background-gallery__choice"
          :data-background-choice="background.id"
        >
          <img :src="background.posterUrl ?? background.mediaUrl" :alt="titleFor(background)" loading="lazy" />
          <span>
            <input
              type="checkbox"
              :checked="store.selection.value.selectedIds.includes(background.id)"
              @change="toggle(background.id, $event)"
            />
            <span>
              <strong>{{ titleFor(background) }}</strong>
              <small>{{ background.kind }} · {{ preferredMedia(background).width }} × {{ preferredMedia(background).height }}</small>
            </span>
          </span>
        </label>
      </template>
    </fieldset>
    <p v-if="store.error.value === 'selection_limit'" role="alert">{{ text('settings.backgrounds.selectionLimit') }}</p>
    <div class="background-gallery__controls">
      <label>
        <input
          data-background-auto-rotate
          type="checkbox"
          :checked="store.selection.value.autoRotate"
          @change="store.setAutoRotate(($event.target as HTMLInputElement).checked)"
        />
        <span>{{ text('settings.backgrounds.autoRotate') }}</span>
      </label>
      <label>
        <span>{{ text('settings.backgrounds.interval') }}</span>
        <select
          data-background-interval
          :value="store.selection.value.intervalSeconds"
          :disabled="!store.selection.value.autoRotate"
          @change="setInterval"
        >
          <option v-for="seconds in intervalOptions" :key="seconds" :value="seconds">
            {{ intervalLabel(seconds) }}
          </option>
        </select>
      </label>
      <label>
        <span>{{ text('settings.backgrounds.playbackMode') }}</span>
        <select data-background-playback-mode :value="store.playbackMode.value" @change="setPlaybackMode">
          <option value="sequential">{{ text('settings.backgrounds.modeSequential') }}</option>
          <option value="random">{{ text('settings.backgrounds.modeRandom') }}</option>
        </select>
      </label>
    </div>
<p v-if="signedIn">{{ text('account.preferenceSync.description') }}</p>
  </div>
</template>

<style scoped>
.background-gallery { display: grid; gap: 0.75rem; padding-top: 0.75rem; border-top: var(--glass-border); }
.background-gallery p, .background-gallery h4 { margin: 0; }
.background-gallery__heading { display: grid; gap: 0.25rem; }
.background-gallery__quality-toggle { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.background-gallery__choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: 0.75rem; min-width: 0; margin: 0; padding: 0; border: 0; }
.background-gallery__choices legend { grid-column: 1 / -1; padding: 0; font-weight: 650; }
.background-gallery__group,
.background-gallery__collection { grid-column: 1 / -1; margin: 0; }
.background-gallery__group { font-weight: 650; }
.background-gallery__collection { color: var(--colour-text-muted); font-size: 0.875rem; }
.background-gallery__choice { display: grid; align-content: start; gap: 0.5rem; padding: 0.5rem; background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; }
.background-gallery__choice img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 0.375rem; background: var(--colour-background); }
.background-gallery__choice > span { display: flex; align-items: flex-start; gap: 0.5rem; }
.background-gallery__choice > span > span { display: grid; gap: 0.25rem; min-width: 0; }
.background-gallery__choice > span small { color: var(--colour-text-muted); }
.background-gallery__choice input { flex: 0 0 auto; min-height: 1.25rem; }
.background-gallery__choice small { color: var(--colour-text-muted); }
.background-gallery__controls { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); }
.background-gallery__controls label { display: grid; gap: 0.5rem; }
</style>

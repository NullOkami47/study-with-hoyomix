import { computed, ref, type Ref } from 'vue'
import type { PlaybackStore } from './store'

export interface PlaybackPresentation {
  currentTime: Readonly<Ref<number>>
  duration: Readonly<Ref<number>>
  canSeek: Readonly<Ref<boolean>>
  artworkUrl: Readonly<Ref<string | undefined>>
}

const presentations = new WeakMap<PlaybackStore, {
  source: { currentTime: Ref<number>; duration: Ref<number>; canSeek: Ref<boolean>; artworkUrl: Ref<string | undefined> }
  view: PlaybackPresentation
}>()

function entry(store: PlaybackStore) {
  let existing = presentations.get(store)
  if (!existing) {
    const source = { currentTime: ref(0), duration: ref(0), canSeek: ref(false), artworkUrl: ref<string>() }
    existing = { source, view: {
      currentTime: computed(() => source.currentTime.value), duration: computed(() => source.duration.value),
      canSeek: computed(() => source.canSeek.value), artworkUrl: computed(() => source.artworkUrl.value),
    } }
    presentations.set(store, existing)
  }
  return existing
}

/** The sole PlayerBar publishes native-media observations; secondary views only read them. */
export function publishPlaybackPresentation(store: PlaybackStore, snapshot: {
  currentTime: number; duration: number; canSeek: boolean; artworkUrl?: string
}): void {
  const { source } = entry(store)
  source.currentTime.value = snapshot.currentTime
  source.duration.value = snapshot.duration
  source.canSeek.value = snapshot.canSeek
  source.artworkUrl.value = snapshot.artworkUrl
}

export function playbackPresentationFor(store: PlaybackStore): PlaybackPresentation {
  return entry(store).view
}

export function formatPlaybackTime(value: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(value) ? value : 0))
  const minutes = Math.floor(seconds / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getDefaultBackgroundStore, type BackgroundStore } from '../backgrounds/store'
import type { PublicBackground } from '../backgrounds/types'
import { staticBackgroundDefinition } from '../backgrounds/staticDefinitions'

const props = defineProps<{ mode: 'still' | 'ambient'; lowPower: boolean; store?: BackgroundStore }>()
const store = props.store ?? getDefaultBackgroundStore()
interface SaveDataConnection {
  saveData?: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
}
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
const connection = (navigator as Navigator & { connection?: SaveDataConnection }).connection
const reducedMotion = ref(motionQuery?.matches ?? false)
const saveData = ref(connection?.saveData === true)
const stillPolicy = computed(() => props.mode === 'still' || props.lowPower || reducedMotion.value || saveData.value)
const nativeFailures = ref(new Set<string>())
const originalSource = (entry: PublicBackground) => staticBackgroundDefinition(entry.id)?.mediaUrl ?? entry.mediaUrl
const sourceFor = (entry: PublicBackground | null): string | null => {
  if (entry?.kind !== 'video') return null
  const original = originalSource(entry)
  if (store.qualityMode.value === 'native' && !nativeFailures.value.has(original)) return original
  if (store.qualityMode.value === '1440p') {
    const high = entry.highQualityVersion?.mediaUrl
    if (high && !nativeFailures.value.has(high)) return high
    return entry.playbackFallback?.mediaUrl ?? entry.mediaUrl
  }
  return (store.qualityMode.value === 'auto' || nativeFailures.value.has(entry.mediaUrl)) && entry.playbackFallback
    ? entry.playbackFallback.mediaUrl : entry.mediaUrl
}
const recoverySourceFor = (entry: PublicBackground | null, source: string | null): string | null => {
  if (!entry || !source) return null
  if (source === originalSource(entry) && source !== entry.mediaUrl) return entry.mediaUrl
  if (source === entry.highQualityVersion?.mediaUrl && source !== entry.mediaUrl) return entry.mediaUrl
  return source === entry.mediaUrl ? entry.playbackFallback?.mediaUrl ?? null : null
}
const videoSource = computed(() => stillPolicy.value || store.usingPoster.value ? null : sourceFor(store.current.value))
const nextSource = computed(() => !videoSource.value || store.next.value?.id === store.current.value?.id ? null : sourceFor(store.next.value))
const imageSource = computed(() => {
  const current = store.current.value
  if (current?.kind === 'image') return current.mediaUrl
  // The poster remains beneath both video slots throughout loading and recovery.
  return current?.posterUrl ?? null
})
const slots = ref([{ src: videoSource.value, hasFrame: false }, { src: null as string | null, hasFrame: false }])
const activeSlot = ref(0)
const pendingSlot = ref<number | null>(null)
const elements: (HTMLVideoElement | null)[] = [null, null]
let video: HTMLVideoElement | null = null
let disposed = false
let generation = 0
let playPending = false
let blocked = false
let recoveryUsed = false
let lastTime = 0
let qualitySample: { at: number; total: number; dropped: number } | undefined
let poorQualityWindows = 0
let recoveryTimer: ReturnType<typeof setTimeout> | undefined
let transitionTimer: ReturnType<typeof setTimeout> | undefined
let retiringSlot: number | null = null
let gestureCleanup: (() => void) | null = null
const STALL_GRACE_MS = 8_000
const QUALITY_WINDOW_MS = 5_000
const CROSSFADE_MS = 400
const targetSlot = () => pendingSlot.value ?? activeSlot.value

function clearRecovery(): void {
  if (recoveryTimer !== undefined) clearTimeout(recoveryTimer)
  recoveryTimer = undefined
}
function release(element: HTMLVideoElement): void {
  element.pause(); element.removeAttribute('src'); element.load()
}
function syncNativeSource(element: HTMLVideoElement, source: string): void {
  // Immediate release removes the native attribute. Vue may batch null → the
  // same URL and skip its unchanged virtual src, so restore it before loading.
  if (element.getAttribute('src') !== source) element.setAttribute('src', source)
}
function unload(index: number): void {
  slots.value[index].src = null; slots.value[index].hasFrame = false
  const element = elements[index]
  if (element) release(element)
}
function setVideoRef(index: number, element: unknown): void {
  const previous = elements[index]
  if (!element && previous) release(previous)
  elements[index] = (element as HTMLVideoElement | null) ?? null
}
function finishTransition(): void {
  if (transitionTimer !== undefined) clearTimeout(transitionTimer)
  transitionTimer = undefined
  if (retiringSlot !== null) unload(retiringSlot)
  retiringSlot = null
}
async function prepareNext(): Promise<void> {
  if (disposed || !videoSource.value || slots.value[activeSlot.value].src !== videoSource.value || !slots.value[activeSlot.value].hasFrame || pendingSlot.value !== null || retiringSlot !== null || document.visibilityState === 'hidden') return
  const index = 1 - activeSlot.value, source = nextSource.value
  if (slots.value[index].src === source) return
  unload(index); slots.value[index].src = source
  await nextTick()
  if (disposed || !source || slots.value[index].src !== source || targetSlot() === index) return
  // Preload data and the initial frame only. The idle slot never autoplays.
  const next = elements[index]
  if (next) { syncNativeSource(next, source); next.load() }
}
function requestGestureRetry(): void {
  if (gestureCleanup) return
  const retry = () => { gestureCleanup?.(); blocked = false; play(); armRecovery() }
  gestureCleanup = () => {
    window.removeEventListener('pointerdown', retry); window.removeEventListener('keydown', retry); gestureCleanup = null
  }
  window.addEventListener('pointerdown', retry, { once: true }); window.addEventListener('keydown', retry, { once: true })
}
function play(): void {
  const element = video
  if (disposed || !element || playPending || blocked || document.visibilityState === 'hidden') return
  element.muted = true
  const token = generation
  playPending = true
  void Promise.resolve(element.play()).catch((error: unknown) => {
    if (token !== generation) return
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      blocked = true; clearRecovery(); requestGestureRetry()
    } else armRecovery()
  }).finally(() => { if (token === generation) playPending = false })
}
function armRecovery(): void {
  if (!video || blocked || recoveryTimer !== undefined || document.visibilityState === 'hidden') return
  const token = generation, observedTime = video.currentTime
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined
    if (token !== generation || !video || blocked || document.visibilityState === 'hidden') return
    if (video.currentTime !== observedTime && !video.paused) return
    const current = store.current.value
    if (recoverySourceFor(current, videoSource.value)) {
      nativeFailures.value = new Set([...nativeFailures.value, videoSource.value!]); return
    }
    if (recoveryUsed) { store.onVideoError(); return }
    // load() discards the decoder's current frame. Reveal the poster first.
    slots.value[targetSlot()].hasFrame = false
    recoveryUsed = true; playPending = false; video.load(); play(); armRecovery()
  }, STALL_GRACE_MS)
}
function isTarget(index: number): boolean {
  const element = elements[index], source = slots.value[index].src
  return index === targetSlot() && source === videoSource.value && Boolean(source) &&
    (!element?.currentSrc || new URL(element.currentSrc, document.baseURI).href === new URL(source!, document.baseURI).href)
}
function onUnavailable(index: number): void {
  if (!isTarget(index)) return
  // A buffered/paused frame may stay visible; an empty decoder must not cover
  // the poster with an opaque black video element.
  if (!video || video.readyState < 2 || video.error) slots.value[index].hasFrame = false
  armRecovery()
}
function onProgress(index: number): void {
  if (!isTarget(index) || !video || video.readyState < 2) return
  if (pendingSlot.value === null) slots.value[index].hasFrame = true
  if (video.currentTime !== lastTime) { lastTime = video.currentTime; clearRecovery() }
  const current = store.current.value
  if (!recoverySourceFor(current, videoSource.value) || !video.getVideoPlaybackQuality) return
  const at = performance.now()
  if (qualitySample && at - qualitySample.at < QUALITY_WINDOW_MS) return
  const quality = video.getVideoPlaybackQuality()
  if (qualitySample) {
    const total = quality.totalVideoFrames - qualitySample.total, dropped = quality.droppedVideoFrames - qualitySample.dropped
    poorQualityWindows = total >= 30 && dropped / total > 0.1 ? poorQualityWindows + 1 : 0
    if (poorQualityWindows >= 2) nativeFailures.value = new Set([...nativeFailures.value, videoSource.value!])
  }
  qualitySample = { at, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }
}
function onLoaded(index: number): void {
  if (isTarget(index)) onProgress(index)
  else if (index !== activeSlot.value && index !== retiringSlot) elements[index]?.pause()
}
function onPlaying(index: number): void {
  if (!isTarget(index)) { if (index !== retiringSlot) elements[index]?.pause(); return }
  if (!video || video.readyState < 2) return
  if (pendingSlot.value === index) {
    const old = activeSlot.value
    activeSlot.value = index; pendingSlot.value = null; slots.value[index].hasFrame = true; retiringSlot = old
    // Overlap only during the fade. Release the old decoder, then refill the
    // paused spare slot for the next manual/timed switch.
    transitionTimer = setTimeout(() => { finishTransition(); void prepareNext() }, reducedMotion.value ? 0 : CROSSFADE_MS)
  }
  onProgress(index); clearRecovery(); void prepareNext()
}
function onPause(index: number): void {
  if (isTarget(index) && document.visibilityState !== 'hidden' && videoSource.value && !blocked) { play(); armRecovery() }
}
function syncPolicy(): void {
  reducedMotion.value = motionQuery?.matches ?? false; saveData.value = connection?.saveData === true
  store.setPlaybackPolicy({ lowPower: props.lowPower || props.mode === 'still', reducedMotion: reducedMotion.value, saveData: saveData.value })
}
function syncVisibility(): void {
  const visible = document.visibilityState !== 'hidden'
  store.setVisible(visible)
  if (!visible) { clearRecovery(); finishTransition(); elements.forEach(element => element?.pause()) }
  else if (videoSource.value) { play(); armRecovery(); void prepareNext() }
}
watch(() => [props.lowPower, props.mode], syncPolicy)
watch(() => store.qualityMode.value, () => { nativeFailures.value = new Set() })
watch(nextSource, () => { void prepareNext() }, { flush: 'post' })
watch(videoSource, async source => {
  const token = ++generation
  clearRecovery(); gestureCleanup?.(); finishTransition()
  playPending = false; blocked = false; recoveryUsed = false; lastTime = 0; qualitySample = undefined; poorQualityWindows = 0
  if (!source) { pendingSlot.value = null; video = null; unload(0); unload(1); return }
  const active = activeSlot.value
  const index = slots.value[active].src === source || !slots.value[active].hasFrame ? active : 1 - active
  if (pendingSlot.value !== null && pendingSlot.value !== index) unload(pendingSlot.value)
  pendingSlot.value = index === active ? null : index
  const reused = slots.value[index].src === source
  if (!reused) { unload(index); slots.value[index].src = source }
  await nextTick()
  if (token !== generation || disposed) return
  video = elements[index]
  if (!video) return
  video.muted = true
  syncNativeSource(video, source)
  if (!reused || video.readyState === 0) video.load()
  play(); armRecovery(); void prepareNext()
}, { immediate: true, flush: 'post' })
onMounted(() => {
  syncPolicy(); syncVisibility()
  motionQuery?.addEventListener?.('change', syncPolicy); connection?.addEventListener?.('change', syncPolicy)
  document.addEventListener('visibilitychange', syncVisibility); void store.load()
})
onBeforeUnmount(() => {
  disposed = true; generation++; clearRecovery(); gestureCleanup?.(); finishTransition()
  motionQuery?.removeEventListener?.('change', syncPolicy); connection?.removeEventListener?.('change', syncPolicy)
  document.removeEventListener('visibilitychange', syncVisibility)
  video = null; elements.forEach(element => { if (element) release(element) })
})
</script>

<template>
  <div class="scene-backdrop" data-scene-backdrop aria-hidden="true">
    <picture v-if="imageSource"><img :src="imageSource" alt="" decoding="async" draggable="false" data-background-poster="true" :data-background-active="!videoSource ? true : undefined" /></picture>
    <template v-if="videoSource">
      <video
        v-for="(slot, index) in slots" :key="index" :ref="element => setVideoRef(index, element)"
        class="scene-backdrop__video"
        :class="{ 'scene-backdrop__video--active': index === activeSlot && slot.hasFrame, 'scene-backdrop__video--empty': !slot.hasFrame }"
        :data-background-slot="index" :data-background-active="index === activeSlot"
        :src="slot.src ?? undefined" :autoplay="index === activeSlot || index === pendingSlot"
        preload="auto" loop muted playsinline
        @loadeddata="onLoaded(index)" @timeupdate="onProgress(index)" @playing="onPlaying(index)"
        @canplay="isTarget(index) && play()" @waiting="onUnavailable(index)"
        @stalled="onUnavailable(index)" @pause="onPause(index)" @error="onUnavailable(index)"
      />
    </template>
    <div class="scene-backdrop__veil" />
  </div>
</template>

<style scoped>
.scene-backdrop { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; background: var(--colour-background); }
.scene-backdrop picture, .scene-backdrop img, .scene-backdrop video, .scene-backdrop__veil { position: absolute; inset: 0; width: 100%; height: 100%; }
.scene-backdrop img, .scene-backdrop video { object-fit: cover; object-position: center; }
.scene-backdrop__video { opacity: 0; transition: opacity var(--background-crossfade-duration) ease; }
.scene-backdrop__video--active { opacity: 1; }
.scene-backdrop__video--empty { opacity: 0; transition: none; }
.scene-backdrop__veil { background: linear-gradient(180deg, rgb(5 9 17 / 14%), rgb(5 9 17 / 44%)), radial-gradient(circle at 50% 45%, transparent 26%, rgb(3 7 13 / 36%) 100%); }
@media (prefers-reduced-motion: reduce) { .scene-backdrop__video { transition: none; } }
</style>

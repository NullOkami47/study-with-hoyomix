<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isYouTubeVideoId } from './providers/youtube'
import {
  loadYouTubeIframeApi,
  type YouTubePlayerInstance,
} from './youtubeIframeApi'

const props = withDefaults(
  defineProps<{
    title?: string
    videoId: string
  }>(),
  { title: 'Official YouTube player' },
)

const emit = defineEmits<{
  (event: 'error', code: number): void
  (event: 'ready'): void
  (event: 'state', state: number): void
  (event: 'teardown'): void
}>()

const mountPoint = ref<HTMLElement | null>(null)
let player: YouTubePlayerInstance | null = null
let disposed = false

function setIframeTitle(): void {
  player?.getIframe().setAttribute('title', props.title)
}

function play(): void {
  player?.playVideo()
}

function pause(): void {
  player?.pauseVideo()
}

function setVolume(value: number): void {
  const volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7
  player?.setVolume(Math.round(volume * 100))
}

defineExpose({ pause, play, setVolume })

watch(
  () => props.videoId,
  (videoId) => {
    if (!isYouTubeVideoId(videoId)) {
      emit('error', 0)
      return
    }
    player?.loadVideoById(videoId)
  },
)

watch(
  () => props.title,
  () => setIframeTitle(),
)

onMounted(async () => {
  if (!isYouTubeVideoId(props.videoId)) {
    emit('error', 0)
    return
  }

  const element = mountPoint.value
  if (!element) return

  try {
    const youtube = await loadYouTubeIframeApi()
    if (disposed) return
    if (!isYouTubeVideoId(props.videoId)) {
      emit('error', 0)
      return
    }

    player = new youtube.Player(element, {
      videoId: props.videoId,
      playerVars: {
        controls: 1,
        origin: window.location.origin,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          setIframeTitle()
          emit('ready')
        },
        onStateChange: ({ data }) => emit('state', data),
        onError: ({ data }) => emit('error', data),
      },
    })
  } catch {
    if (!disposed) emit('error', 0)
  }
})

onBeforeUnmount(() => {
  disposed = true
  player?.destroy()
  player = null
  emit('teardown')
})
</script>

<template>
  <div class="youtube-player">
    <div
      class="youtube-player__viewport"
      role="region"
      :aria-label="title"
    >
      <div ref="mountPoint" class="youtube-player__mount"></div>
    </div>
  </div>
</template>

<style scoped>
.youtube-player {
  width: 100%;
  overflow: hidden;
  background: var(--colour-background);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
  box-shadow: var(--glass-shadow);
}

.youtube-player:focus-within {
  box-shadow: var(--focus-ring);
}

.youtube-player__viewport {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--colour-background);
}

.youtube-player__mount,
.youtube-player__viewport :deep(iframe) {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
</style>

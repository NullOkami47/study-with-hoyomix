<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  cappedDevicePixelRatio,
  initialiseGlassRenderer,
  type GlassRenderer,
} from './renderer/Renderer'
import type { GlassCapability } from './renderer/capabilities'

const props = defineProps<{
  lowPower: boolean
  backgroundUrl?: string
  albumArtUrl?: string
}>()

const host = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const capability = ref<GlassCapability>('css')

let activeCanvas: HTMLCanvasElement | null = null
let animationFrame: number | null = null
let disposed = false
let renderer: GlassRenderer | null = null
let resizeObserver: ResizeObserver | null = null
let reducedMotion = false
let reducedMotionQuery: MediaQueryList | null = null

function stopAnimation(): void {
  if (animationFrame === null) return
  cancelAnimationFrame(animationFrame)
  animationFrame = null
}

function disposeRendererSafely(target: GlassRenderer | null): void {
  if (!target) return
  try {
    target.dispose()
  } catch {
    // Cleanup failures must not block fallback or component teardown.
  }
}

function releaseRenderer(): void {
  const target = renderer
  renderer = null
  disposeRendererSafely(target)
}

function useCssFallback(): void {
  stopAnimation()
  capability.value = 'css'
  if (activeCanvas) activeCanvas.dataset.active = 'false'
  releaseRenderer()
}

function isDocumentHidden(): boolean {
  return document.hidden || document.visibilityState === 'hidden'
}

function renderFrame(timestamp: number): void {
  if (!renderer || isDocumentHidden()) return
  try {
    renderer.render(timestamp)
  } catch {
    useCssFallback()
  }
}

function scheduleAnimation(): void {
  if (
    animationFrame !== null ||
    !renderer ||
    props.lowPower ||
    reducedMotion ||
    isDocumentHidden()
  ) {
    return
  }

  animationFrame = requestAnimationFrame((timestamp) => {
    animationFrame = null
    renderFrame(timestamp)
    scheduleAnimation()
  })
}

function resizeRenderer(width?: number, height?: number): void {
  if (!renderer || !host.value) return
  const bounds = host.value.getBoundingClientRect()
  const cssWidth = width ?? bounds.width
  const cssHeight = height ?? bounds.height
  renderer.resize(Math.max(1, cssWidth), Math.max(1, cssHeight), cappedDevicePixelRatio(props.lowPower))
}

function onVisibilityChange(): void {
  if (isDocumentHidden()) {
    stopAnimation()
    return
  }

  renderFrame(performance.now())
  scheduleAnimation()
}

function onReducedMotionChange(event: MediaQueryListEvent): void {
  reducedMotion = event.matches
  if (reducedMotion) {
    stopAnimation()
    renderFrame(performance.now())
    return
  }
  scheduleAnimation()
}

function onWindowResize(): void {
  resizeRenderer()
}

watch(
  () => props.lowPower,
  (lowPower) => {
    resizeRenderer()
    if (lowPower) {
      stopAnimation()
      renderFrame(performance.now())
      return
    }
    renderFrame(performance.now())
    scheduleAnimation()
  },
)

onMounted(async () => {
  if (!host.value || !canvasRef.value) return

  if (typeof window.matchMedia === 'function') {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = reducedMotionQuery.matches
    reducedMotionQuery.addEventListener('change', onReducedMotionChange)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) resizeRenderer(entry.contentRect.width, entry.contentRect.height)
    })
    resizeObserver.observe(host.value)
  } else {
    window.addEventListener('resize', onWindowResize)
  }

  const initialised = await initialiseGlassRenderer(canvasRef.value)
  if (disposed) {
    disposeRendererSafely(initialised.renderer)
    return
  }

  activeCanvas = initialised.canvas
  canvasRef.value = initialised.canvas
  renderer = initialised.renderer
  capability.value = initialised.capability
  activeCanvas.dataset.active = String(renderer !== null)

  if (!renderer) return
  resizeRenderer()
  renderFrame(performance.now())
  scheduleAnimation()
})

onBeforeUnmount(() => {
  disposed = true
  stopAnimation()
  resizeObserver?.disconnect()
  resizeObserver = null
  reducedMotionQuery?.removeEventListener('change', onReducedMotionChange)
  reducedMotionQuery = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', onWindowResize)
  releaseRenderer()
})
</script>

<template>
  <div
    ref="host"
    class="liquid-glass"
    :class="{ 'liquid-glass--low-power': lowPower }"
    :data-capability="capability"
    aria-hidden="true"
    style="pointer-events: none"
  >
    <canvas
      ref="canvasRef"
      class="liquid-glass__canvas"
      :data-active="capability !== 'css'"
      aria-hidden="true"
      style="pointer-events: none"
    />
    <div
      class="liquid-glass__fallback"
      :data-active="capability === 'css'"
      aria-hidden="true"
      style="pointer-events: none"
    />
  </div>
</template>

<style scoped src="./LiquidGlassCanvas.css"></style>

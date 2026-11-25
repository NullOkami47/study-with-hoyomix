<script setup lang="ts">
// Sole Studio optical owner. The old GlassEnvironment/hero hooks and both
// StudioGlassCanvas mounts must be absent from this mode (see RENDERER.md).
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { applyGlassEnvironment, clearGlassEnvironment, glassEnvironment, GLASS_MEDIA_QUERIES, readGlassProbe, REFRACTION_ENABLED, REFRACTION_DEFAULT_ON, resolveGlassEnvironment } from '../glass/glassEnvironment'
import { refractionPreference } from '../glass/refractionPreference'
import { createStudioNativeRenderer } from './studioNativeRenderer'
import { DEFAULT_STUDIO_BLUR, DEFAULT_STUDIO_EDGE, DEFAULT_STUDIO_GLASS_GRAY, MIN_STUDIO_BLUR, MAX_STUDIO_BLUR } from '../../stores/preferences'

const props = withDefaults(defineProps<{ enabled?: boolean; edge?: number; blurRadius?: number; glassGray?: number }>(), {
  enabled: true, edge: DEFAULT_STUDIO_EDGE, blurRadius: DEFAULT_STUDIO_BLUR, glassGray: DEFAULT_STUDIO_GLASS_GRAY,
})
let renderer: ReturnType<typeof createStudioNativeRenderer> | undefined
let mounted = false
let rendererFailed = false
const queries: MediaQueryList[] = []
const oldVariables = new Map<string, { value: string; priority: string }>()
const clamp = (value: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback
function preferences() {
  const style = document.documentElement.style
  const values: Record<string, string> = {
    '--studio-blur': `${Math.max(MIN_STUDIO_BLUR, clamp(props.blurRadius, MAX_STUDIO_BLUR, DEFAULT_STUDIO_BLUR))}px`,
    '--studio-gray': String(clamp(props.glassGray, 100, DEFAULT_STUDIO_GLASS_GRAY) / 100),
    '--studio-glass-blur': `${Math.max(MIN_STUDIO_BLUR, clamp(props.blurRadius, MAX_STUDIO_BLUR, DEFAULT_STUDIO_BLUR))}px`,
    '--studio-glass-gray-strength': String(clamp(props.glassGray, 100, DEFAULT_STUDIO_GLASS_GRAY) / 100),
    '--studio-edge-strength': String(clamp(props.edge, 100, DEFAULT_STUDIO_EDGE) / 100),
  }
  for (const [key, value] of Object.entries(values)) {
    if (!oldVariables.has(key)) oldVariables.set(key, { value: style.getPropertyValue(key), priority: style.getPropertyPriority(key) })
    style.setProperty(key, value)
  }
  renderer?.setEdge(props.edge)
}
function resolve() {
  if (!mounted) return
  const probe = readGlassProbe()
  const config = { enabled: props.enabled && REFRACTION_ENABLED,
    defaultOn: REFRACTION_DEFAULT_ON, stored: refractionPreference.value }
  let env = resolveGlassEnvironment({ ...probe, resizeObserver: probe.resizeObserver && typeof MutationObserver === 'function' && !rendererFailed }, config)
  if (env.refraction === 'svg') {
    try { renderer ??= createStudioNativeRenderer(props.edge) } catch {
      // A failed optional enhancement must not break settings or the player, and
      // must not turn resize events into repeated allocation attempts.
      rendererFailed = true
      env = resolveGlassEnvironment({ ...probe, resizeObserver: false }, config)
    }
  }
  if (env.refraction !== 'svg') { renderer?.destroy(); renderer = undefined }
  // Unlike a decorative animation, native backdrop refraction needs no JS frame
  // loop under reduced motion. Accessibility opacity and contrast are hard stops.
  glassEnvironment.value = env
  applyGlassEnvironment(env)
  document.documentElement.dataset.studioGlassEngine = env.refraction === 'svg' ? 'native-svg' : 'native-css'
  preferences()
}
watch(() => [props.enabled, props.edge, props.blurRadius, props.glassGray, refractionPreference.value], resolve)
onMounted(() => {
  mounted = true
  for (const query of Object.values(GLASS_MEDIA_QUERIES)) {
    try { const list = window.matchMedia(query); list.addEventListener?.('change', resolve); queries.push(list) } catch { /* unsupported media query */ }
  }
  window.addEventListener('resize', resolve)
  resolve()
})
onBeforeUnmount(() => {
  mounted = false; renderer?.destroy(); renderer = undefined
  for (const list of queries) list.removeEventListener?.('change', resolve)
  window.removeEventListener('resize', resolve)
  clearGlassEnvironment(); glassEnvironment.value = null
  delete document.documentElement.dataset.studioGlassEngine
  const style = document.documentElement.style
  for (const [key, previous] of oldVariables) {
    if (previous.value) style.setProperty(key, previous.value, previous.priority)
    else style.removeProperty(key)
  }
})
</script>

<template><!-- No layout wrapper; only the controller-owned SVG/overlays. --></template>

<style src="./StudioGlassEnvironment.css"></style>

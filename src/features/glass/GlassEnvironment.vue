<script setup lang="ts">
// Original implementation for Study with HOYO-MiX (GPL-3.0). Convex-bezel displacement tiles for
// backdrop-filter refraction; not derived from liquid-glass-studio source.
//
// Mounted by AppShell in the cinematic style only. Owns the capability probe and its attributes on
// <html>, the scene tone sampler, and the hidden SVG filter defs for the two hero surfaces.
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import {
  applyGlassEnvironment,
  clearGlassEnvironment,
  GLASS_MEDIA_QUERIES,
  glassEnvironment,
  readGlassProbe,
  REFRACTION_DEFAULT_ON,
  REFRACTION_ENABLED,
  resolveGlassEnvironment,
} from './glassEnvironment'
import { refractionPreference } from './refractionPreference'
import { tileUrls, type GlassHeroId, type TileSet } from './refractionTiles'
import { createSceneToneSampler, SCENE_TONE_SAMPLING_ENABLED, type SceneToneSampler } from './sceneTone'
import { glassHeroStates } from './useGlassRefraction'

interface Tile { key: string; href: string; x: number; y: number; width: number; height: number }
interface HeroFilter { id: GlassHeroId; width: number; height: number; scale: number; tiles: Tile[] }

function filterTiles(width: number, height: number, set: TileSet): Tile[] {
  const urls = tileUrls(set)
  const r = set.radius
  const b = set.bezel
  const tiles: Tile[] = [
    { key: 'tl', href: urls.tl, x: 0, y: 0, width: r, height: r },
    { key: 'tr', href: urls.tr, x: width - r, y: 0, width: r, height: r },
    { key: 'bl', href: urls.bl, x: 0, y: height - r, width: r, height: r },
    { key: 'br', href: urls.br, x: width - r, y: height - r, width: r, height: r },
  ]
  // An edge is omitted when its length is <= 0 (pills have no straight vertical edge).
  if (width - 2 * r > 0) {
    tiles.push({ key: 't', href: urls.t, x: r, y: 0, width: width - 2 * r, height: b })
    tiles.push({ key: 'b', href: urls.b, x: r, y: height - b, width: width - 2 * r, height: b })
  }
  if (height - 2 * r > 0) {
    tiles.push({ key: 'l', href: urls.l, x: 0, y: r, width: b, height: height - 2 * r })
    tiles.push({ key: 'r', href: urls.r, x: width - b, y: r, width: b, height: height - 2 * r })
  }
  return tiles
}

const refractionActive = computed(() => glassEnvironment.value?.refraction === 'svg')

const filters = computed<HeroFilter[]>(() => {
  if (!refractionActive.value) return []
  const list: HeroFilter[] = []
  for (const [id, state] of glassHeroStates()) {
    if (state.phase !== 'resolved' && state.phase !== 'ready') continue
    list.push({ id, width: state.w, height: state.h, scale: state.set.scale, tiles: filterTiles(state.w, state.h, state.set) })
  }
  return list
})

let sampler: SceneToneSampler | undefined
let samplerLowPower = false
let resizeTimer: ReturnType<typeof setTimeout> | undefined
const mediaLists: MediaQueryList[] = []

function stopSampler(): void {
  sampler?.stop()
  sampler = undefined
}

function syncSampler(): void {
  const env = glassEnvironment.value
  if (!env || env.reducedTransparency || !SCENE_TONE_SAMPLING_ENABLED) {
    stopSampler()
    // No sampling under reduced transparency, or while sampling is switched off (design R2): the tone
    // stays on the bright defaults.
    delete document.documentElement.dataset.sceneTone
    return
  }
  const lowPower = env.power === 'low'
  if (sampler && samplerLowPower === lowPower) return
  stopSampler()
  samplerLowPower = lowPower
  sampler = createSceneToneSampler({ lowPower })
  sampler.start()
}

function resolveNow(): void {
  const env = resolveGlassEnvironment(readGlassProbe(), {
    enabled: REFRACTION_ENABLED,
    defaultOn: REFRACTION_DEFAULT_ON,
    stored: refractionPreference.value,
  })
  glassEnvironment.value = env
  applyGlassEnvironment(env)
  syncSampler()
}

function onResize(): void {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined
    resolveNow()
  }, 200)
}

watch(refractionPreference, () => resolveNow())

onMounted(() => {
  resolveNow()
  if (typeof window.matchMedia === 'function') {
    for (const query of Object.values(GLASS_MEDIA_QUERIES)) {
      try {
        const list = window.matchMedia(query)
        list.addEventListener?.('change', resolveNow)
        mediaLists.push(list)
      } catch {
        // An unsupported query simply never changes.
      }
    }
  }
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  stopSampler()
  for (const list of mediaLists.splice(0)) list.removeEventListener?.('change', resolveNow)
  window.removeEventListener('resize', onResize)
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = undefined
  clearGlassEnvironment()
  glassEnvironment.value = null
  delete document.documentElement.dataset.sceneTone
})
</script>

<template>
  <svg v-if="refractionActive" class="lg-filter-defs" aria-hidden="true" focusable="false" data-glass-filter-defs>
    <defs>
      <filter
        v-for="hero in filters"
        :id="`lg-refract-${hero.id}`"
        :key="hero.id"
        x="0"
        y="0"
        :width="hero.width"
        :height="hero.height"
        filterUnits="userSpaceOnUse"
        primitiveUnits="userSpaceOnUse"
        color-interpolation-filters="sRGB"
      >
        <feFlood flood-color="rgb(128,128,128)" flood-opacity="1" result="n" />
        <feImage
          v-for="tile in hero.tiles"
          :key="tile.key"
          :href="tile.href"
          :x="tile.x"
          :y="tile.y"
          :width="tile.width"
          :height="tile.height"
          preserveAspectRatio="none"
          :result="tile.key"
        />
        <feMerge result="map">
          <feMergeNode in="n" />
          <feMergeNode v-for="tile in hero.tiles" :key="tile.key" :in="tile.key" />
        </feMerge>
        <feDisplacementMap in="SourceGraphic" in2="map" :scale="hero.scale" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </defs>
  </svg>
</template>

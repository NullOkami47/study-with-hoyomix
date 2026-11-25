// Original implementation for Study with HOYO-MiX (GPL-3.0). Convex-bezel displacement tiles for
// backdrop-filter refraction; not derived from liquid-glass-studio source.
//
// The fixed list of tile sets the two hero surfaces can use. Tiles depend only on the corner radius
// and the bezel width (scripts/generate-glass-refraction-tiles.mjs writes them to
// public/glass/refraction/). A surface whose live geometry matches no set keeps plain blur.

export type GlassHeroId = 'player' | 'focus'
export type RefractionProfile = 'wide' | 'compact'

export interface TileSet {
  hero: GlassHeroId
  profile: RefractionProfile
  /** Corner radius in CSS px. */
  radius: number
  /** Bezel (displaced rim band) width in CSS px. */
  bezel: number
  /** `feDisplacementMap` scale. 56 on every set: the heroes displace an 8 px blur (glass.css), and the
   * design's 12-18 left the rim band below the AC-3 visibility threshold. */
  scale: number
}

function set(hero: GlassHeroId, profile: RefractionProfile, radius: number, bezel: number, scale: number): TileSet {
  return Object.freeze({ hero, profile, radius, bezel, scale })
}

export const REFRACTION_TILE_SETS: readonly TileSet[] = Object.freeze([
  // Focus bar: a 52 px pill (R = h/2), or the 1.5rem radius inside a narrow focus zone.
  set('focus', 'wide', 26, 16, 56),
  set('focus', 'wide', 24, 16, 56),
  set('focus', 'compact', 26, 16, 56),
  set('focus', 'compact', 24, 16, 56),
  // Player bar: the collapsed pill (84 px / 76 px tall) and the expanded 2.5rem shell.
  set('player', 'wide', 42, 22, 56),
  set('player', 'wide', 40, 22, 56),
  set('player', 'compact', 38, 20, 56),
  set('player', 'compact', 40, 20, 56),
])

export const REFRACTION_TILE_BASE = '/glass/refraction/'

export const COMPACT_PROFILE_QUERY = '(max-width: 47.99rem)'

export interface TileUrls {
  tl: string
  tr: string
  bl: string
  br: string
  t: string
  b: string
  l: string
  r: string
}

export function tileUrls(tileSet: Pick<TileSet, 'radius' | 'bezel'>): TileUrls {
  const corner = (name: string) => `${REFRACTION_TILE_BASE}c-r${tileSet.radius}-b${tileSet.bezel}-${name}.png`
  const edge = (name: string) => `${REFRACTION_TILE_BASE}e-b${tileSet.bezel}-${name}.png`
  return {
    tl: corner('tl'),
    tr: corner('tr'),
    bl: corner('bl'),
    br: corner('br'),
    t: edge('t'),
    b: edge('b'),
    l: edge('l'),
    r: edge('r'),
  }
}

/** `compact` follows the CSS breakpoint that sizes the bars; everything wider is `wide`. */
export function currentProfile(): RefractionProfile {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_PROFILE_QUERY).matches ? 'compact' : 'wide'
  } catch {
    return 'wide'
  }
}

const MIN_SIZE = 24
const MAX_SIZE = 4096

/**
 * Picks the tile set for a hero's border box. `parsedRadius` is the computed
 * `border-top-left-radius` in px (a `999px` pill clamps to h/2). Returns null when the size is
 * out of range or no set's radius is within 1 px of the effective radius.
 */
export function matchTileSet(hero: GlassHeroId, profile: RefractionProfile, width: number, height: number, parsedRadius: number): TileSet | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(parsedRadius)) return null
  if (width < MIN_SIZE || height < MIN_SIZE || width > MAX_SIZE || height > MAX_SIZE) return null
  const radius = Math.round(Math.min(parsedRadius, height / 2, width / 2))
  for (const candidate of REFRACTION_TILE_SETS) {
    if (candidate.hero !== hero || candidate.profile !== profile) continue
    if (Math.abs(radius - candidate.radius) > 1) continue
    if (candidate.bezel > radius) continue
    return candidate
  }
  return null
}

/**
 * A small, hand-built catalogue for the Music Library tests.
 *
 * It is deliberately shaped like the real data rather than like a convenient mock:
 *
 *   - three games, with several albums each, so game grouping is non-trivial
 *   - album titles that repeat across games, so album identity cannot be the title alone
 *   - one album title in Han (极限委托), so album search has a Chinese case
 *   - aliases stored under `zh-CN` (Simplified) while the UI locale is `zh-Hant`, which is
 *     the real localisation gap the search has to bridge
 *   - one track with no album, because the catalogue allows it and browsing must cope
 *   - a multi-word album title whose punctuation differs from the obvious query
 */

import type { GameId, Track } from '../../features/catalog/types'

interface TrackSeed {
  id: string
  title: string
  game: GameId
  album?: string
  aliases?: Record<string, string[]>
  workGroupId?: string
}

const SEEDS: TrackSeed[] = [
  {
    id: 'demo-fontaine-daydream',
    title: 'Demo Fontaine Daydream',
    game: 'genshin',
    album: 'Genshin Impact - Demo Fountain (Original Game Soundtrack)',
    aliases: { 'zh-CN': ['示范白日梦'] },
    workGroupId: 'work_group_genshin_fontaine',
  },
  {
    id: 'demo-fontaine-nightfall',
    title: 'Demo Nightfall over Fontaine',
    game: 'genshin',
    album: 'Genshin Impact - Demo Fountain (Original Game Soundtrack)',
    workGroupId: 'work_group_genshin_fontaine',
  },
  {
    id: 'demo-liyue',
    title: 'Liyue',
    game: 'genshin',
    album: 'Genshin Impact - Demo Moon (Original Game Soundtrack)',
    aliases: { 'zh-CN': ['璃月'] },
    workGroupId: 'work_group_genshin_liyue',
  },
  {
    id: 'demo-moon-in-ones-cup',
    title: "Demo Moon in One's Cup",
    game: 'genshin',
    album: 'Genshin Impact - Demo Moon (Original Game Soundtrack)',
    workGroupId: 'work_group_genshin_liyue',
  },
  {
    // No album: the catalogue permits it, and such a track must stay reachable.
    id: 'demo-genshin-study',
    title: 'Demo Genshin Study',
    game: 'genshin',
    aliases: { 'zh-CN': ['示范练习'], 'zh-TW': ['示範練習'] },
    workGroupId: 'work_group_genshin_singles',
  },
  {
    id: 'demo-hsr-hope',
    title: 'Demo HSR Study',
    game: 'hsr',
    album: 'INSIDE - EP',
    aliases: { 'zh-CN': ['示范星轨练习'] },
    workGroupId: 'work_group_hsr_penacony',
  },
  {
    id: 'demo-hsr-sway',
    title: 'Demo Cosmic Rhythm',
    game: 'hsr',
    album: 'INSIDE - EP',
    workGroupId: 'work_group_hsr_penacony',
  },
  {
    id: 'demo-zzz-study',
    title: 'Demo ZZZ Study',
    game: 'zzz',
    album: '极限委托',
    aliases: { 'zh-CN': ['示范巨人'] },
    workGroupId: 'work_group_zzz_singles',
  },
]

function toTrack(seed: TrackSeed, index: number): Track {
  const track: Track = {
    id: seed.id,
    title: seed.title,
    aliases: seed.aliases ?? {},
    games: [seed.game],
    relationIds: [],
    tabs: [],
    workGroupId: seed.workGroupId ?? `work-${seed.id}`,
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [
      { provider: 'chksz', externalId: String(100001 + index) },
      { provider: 'jellyfin', externalId: `ext-${seed.id}` },
    ],
  }
  if (seed.album !== undefined) track.album = seed.album
  return track
}

/** The catalogue, in catalogue order. */
export function libraryFixtureTracks(): Track[] {
  return SEEDS.map(toTrack)
}

/** Ids of the fixture's tracks, in catalogue order. */
export const LIBRARY_FIXTURE_IDS: readonly string[] = SEEDS.map((seed) => seed.id)

export const FONTAINE_ALBUM = 'Genshin Impact - Demo Fountain (Original Game Soundtrack)'
export const LIYUE_ALBUM = 'Genshin Impact - Demo Moon (Original Game Soundtrack)'
export const INSIDE_ALBUM = 'INSIDE - EP'
export const HAN_ALBUM = '极限委托'

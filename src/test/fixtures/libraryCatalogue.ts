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
    id: 'genshin-fontaine-daydream',
    title: 'Fontaine Daydream',
    game: 'genshin',
    album: 'Genshin Impact - Fountain of Belleau (Original Game Soundtrack)',
    aliases: { 'zh-CN': ['枫丹白日梦'] },
    workGroupId: 'work_group_genshin_fontaine',
  },
  {
    id: 'genshin-fontaine-nightfall',
    title: 'Nightfall over Fontaine',
    game: 'genshin',
    album: 'Genshin Impact - Fountain of Belleau (Original Game Soundtrack)',
    workGroupId: 'work_group_genshin_fontaine',
  },
  {
    id: 'genshin-liyue',
    title: 'Liyue',
    game: 'genshin',
    album: 'Genshin Impact - Jade Moon Upon a Sea of Clouds (Original Game Soundtrack)',
    aliases: { 'zh-CN': ['璃月'] },
    workGroupId: 'work_group_genshin_liyue',
  },
  {
    id: 'genshin-moon-in-ones-cup',
    title: "Moon in One's Cup",
    game: 'genshin',
    album: 'Genshin Impact - Jade Moon Upon a Sea of Clouds (Original Game Soundtrack)',
    workGroupId: 'work_group_genshin_liyue',
  },
  {
    // No album: the catalogue permits it, and such a track must stay reachable.
    id: 'genshin-la-vaguelette',
    title: 'La vaguelette',
    game: 'genshin',
    aliases: { 'zh-CN': ['轻涟'], 'zh-TW': ['輕漣'] },
    workGroupId: 'work_group_genshin_singles',
  },
  {
    id: 'hsr-hope',
    title: 'Hope Is the Thing With Feathers',
    game: 'hsr',
    album: 'INSIDE - EP',
    aliases: { 'zh-CN': ['使一颗心免于哀伤'] },
    workGroupId: 'work_group_hsr_penacony',
  },
  {
    id: 'hsr-sway',
    title: 'Sway to My Beat in Cosmos',
    game: 'hsr',
    album: 'INSIDE - EP',
    workGroupId: 'work_group_hsr_penacony',
  },
  {
    id: 'zzz-tiny-giant',
    title: 'Tiny Giant',
    game: 'zzz',
    album: '极限委托',
    aliases: { 'zh-CN': ['微小的巨人'] },
    workGroupId: 'work_group_zzz_singles',
  },
]

function toTrack(seed: TrackSeed): Track {
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
    sources: [{ provider: 'jellyfin', externalId: `ext-${seed.id}` }],
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

export const FONTAINE_ALBUM = 'Genshin Impact - Fountain of Belleau (Original Game Soundtrack)'
export const LIYUE_ALBUM = 'Genshin Impact - Jade Moon Upon a Sea of Clouds (Original Game Soundtrack)'
export const INSIDE_ALBUM = 'INSIDE - EP'
export const HAN_ALBUM = '极限委托'

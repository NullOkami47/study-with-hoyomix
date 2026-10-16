/**
 * Regression guard for the Task 15 Phase 18 requirement:
 *
 *   "language switch must NOT alter track_id / Jellyfin ID / ChKSz ID / LX candidate"
 *
 * Localisation is a display concern. These tests assert the *seam* — that resolving a localised
 * label is a pure read that cannot reach the identity or playback path — rather than only asserting
 * that a label renders. A test that only checked the label would pass even if the localised value
 * had leaked into the track object itself.
 */

import { describe, expect, it } from 'vitest'

import { deriveLxCandidates } from '../../features/player/lx/candidates'
import type { Track } from '../../features/catalog/types'
import { resolveDisplayTitle } from './displayTitle'

const track: Track = {
  id: 'genshin-dawn-winery-theme',
  title: 'Dawn Winery Theme',
  aliases: { 'zh-Hant': ['晨曦酒莊'], 'zh-Hans': ['晨曦酒庄'] },
  games: ['genshin'],
  relationIds: [],
  tabs: ['sleep'],
  workGroupId: 'work-group-genshin-dawn-winery-theme',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [
    { provider: 'jellyfin', externalId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' },
    { provider: 'chksz', externalId: '1315196858' },
    { provider: 'lx', externalId: 'wy:1901371647' },
  ],
}

/** A structural snapshot of everything that must be language-invariant. */
const identitySnapshot = (value: Track) => ({
  id: value.id,
  sources: value.sources.map((source) => ({ provider: source.provider, externalId: source.externalId })),
  candidates: deriveLxCandidates(value),
  games: value.games,
  workGroupId: value.workGroupId,
  vocalStatus: value.vocalStatus,
})

describe('localisation is display-only', () => {
  it('produces different labels in different locales', () => {
    // The premise: localisation must actually do something, otherwise the rest is vacuous.
    expect(resolveDisplayTitle(track, 'en')).toBe('Dawn Winery Theme')
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('晨曦酒庄')
    expect(new Set([
      resolveDisplayTitle(track, 'en'),
      resolveDisplayTitle(track, 'zh-Hant'),
      resolveDisplayTitle(track, 'zh-Hans'),
    ]).size).toBe(3)
  })

  it('leaves track_id, Jellyfin id, ChKSz id and LX candidates identical across locales', () => {
    const before = identitySnapshot(track)

    // Resolve in every locale, exactly as the UI does on each render.
    for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
      resolveDisplayTitle(track, locale)
    }

    const after = identitySnapshot(track)
    expect(after).toEqual(before)
  })

  it('does not mutate the track object', () => {
    const snapshot = JSON.stringify(track)
    for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
      resolveDisplayTitle(track, locale)
    }
    expect(JSON.stringify(track)).toBe(snapshot)
  })

  it('keeps the provider ids resolvable rather than rewriting them to the localised title', () => {
    // A regression of exactly the kind this guards: someone "helpfully" localising externalId.
    const jellyfinId = track.sources.find((s) => s.provider === 'jellyfin')!.externalId
    const chkszId = track.sources.find((s) => s.provider === 'chksz')!.externalId

    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
    expect(track.sources.find((s) => s.provider === 'jellyfin')!.externalId).toBe(jellyfinId)
    expect(track.sources.find((s) => s.provider === 'chksz')!.externalId).toBe(chkszId)
  })

  it('derives the same LX candidates regardless of the locale used for display', () => {
    const candidates = deriveLxCandidates(track)
    expect(candidates).toEqual([
      { source: 'wy', id: '1315196858' },
      { source: 'wy', id: '1901371647' },
    ])

    for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
      resolveDisplayTitle(track, locale)
      expect(deriveLxCandidates(track)).toEqual(candidates)
    }
  })

  it('falls back to the canonical English title for a locale with no alias, without altering identity', () => {
    const before = identitySnapshot(track)
    // `en` has no alias entry, so the canonical title is used — not a conversion of the Chinese one.
    expect(resolveDisplayTitle(track, 'en')).toBe('Dawn Winery Theme')
    expect(identitySnapshot(track)).toEqual(before)
  })
})

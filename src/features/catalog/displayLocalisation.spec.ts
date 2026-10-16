/**
 * Regression guard: every UI site that renders a track title must go through
 * `resolveDisplayTitle()` (or `label()` / `trackTitle()`, which delegate to it).
 *
 * Why a source-level test rather than a rendering test: the failure mode found
 * during Task 15 was a display site that read `track.title` directly and was
 * therefore never localised — `LibraryPanel`'s favourites list and
 * `trackTitle()` helper. That bug renders fine in English and is invisible in
 * every behavioural test; it only shows up when a `zh-Hant` user sees an English
 * title.
 *
 * This test is intentionally blunt: it reads the component sources and fails if
 * a title is interpolated straight from a track-shaped object. It is cheap and
 * catches the whole class.
 *
 * IMPORTANT: `lxUser.ts` is deliberately EXEMPT. It builds a provider request
 * payload (`musicInfo.name` / `musicInfo.title`) sent to the LX 褲佬 playback
 * service. That payload must carry the canonical recording title — localising it
 * would push a display string into the playback path and break the identity
 * invariance contract that `localisationInvariance.spec.ts` protects.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')

/** Component files that render catalogue tracks to the user. */
const DISPLAY_COMPONENTS = [
  'features/catalog/WorkGroup.vue',
  'features/catalog/TrackList.vue',
  'features/catalog/CatalogFilters.vue',
  'features/catalog/AdvancedFilters.vue',
  'features/library/LibraryPanel.vue',
  'features/library/MusicLibrary.vue',
  'features/library/TrackRow.vue',
  'features/player/PlayerBar.vue',
  'features/player/QueuePanel.vue',
]

/**
 * Files exempt from the display-localisation rule, with the reason.
 * Provider payload builders are not display surfaces.
 */
const EXEMPT = new Map<string, string>([
  ['features/player/providers/lxUser.ts', 'provider request payload, not a display surface'],
])

/**
 * Patterns that indicate a raw *track* title is being rendered or bound.
 *
 * Deliberately narrow. An earlier, broader version flagged `{{ playlist.name }}`
 * and the already-correct `trackTitle(trackId)` call, producing false positives
 * that would have trained the reader to ignore this test. Only track-shaped
 * receivers are matched:
 *
 *   {{ track.title }}  {{ favourite.title }}  {{ currentTrack.title }}
 *
 * `playlist.name` / `tip.title` are not catalogue tracks and are not matched.
 */
const TRACK_RECEIVERS = [
  'track',
  't',
  'tracks',
  'favourite',
  'entry',
  'item',
  'currentTrack',
  'nowPlaying',
  'candidate',
]

const RAW_TITLE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: new RegExp(
      String.raw`\{\{\s*(?:\w+\.)*(${TRACK_RECEIVERS.join('|')})(?:\?\.[\w$]+|\.\w+)*\.title\s*\}\}`,
    ),
    why: 'interpolates a raw track title directly',
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[^\w.])(${TRACK_RECEIVERS.join('|')})(?:\?\.[\w$]+|\.\w+)*\.title\b(?!\s*[,)])`,
    ),
    why: 'reads a raw track title outside a localisation helper',
  },
]

describe('every display site localises the track title', () => {
  it('has no component rendering a raw track title', () => {
    const offenders: string[] = []

    for (const relative of DISPLAY_COMPONENTS) {
      if (EXEMPT.has(relative)) continue
      const source = readFileSync(join(SRC, relative), 'utf8')

      for (const { pattern, why } of RAW_TITLE_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${relative}: ${why}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('routes the known display helpers through resolveDisplayTitle', () => {
    // These helpers exist specifically to funnel titles through localisation.
    // If one stops delegating, the guarantee above becomes vacuous.
    const expectations: Array<[string, RegExp]> = [
      ['features/catalog/WorkGroup.vue', /resolveDisplayTitle/],
      ['features/library/LibraryPanel.vue', /resolveDisplayTitle/],
      ['features/library/TrackRow.vue', /resolveDisplayTitle/],
      ['features/player/PlayerBar.vue', /resolveDisplayTitle/],
      ['features/player/QueuePanel.vue', /resolveDisplayTitle/],
    ]

    for (const [relative, pattern] of expectations) {
      const source = readFileSync(join(SRC, relative), 'utf8')
      expect(source, `${relative} should use resolveDisplayTitle`).toMatch(pattern)
    }
  })

  it('keeps the provider payload exempt, so identity is not localised', () => {
    // Assert the exemption is still justified: the file must be building a
    // provider request payload rather than rendering UI.
    const source = readFileSync(join(SRC, 'features/player/providers/lxUser.ts'), 'utf8')
    expect(source).toMatch(/musicInfo/)
    expect(source).not.toMatch(/resolveDisplayTitle/)
  })
})

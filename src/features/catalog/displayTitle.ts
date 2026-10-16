import { shallowRef } from 'vue'
import type { Locale } from '../../i18n'
import { prepareConverterCache } from '../../pwa/converterCache'

/** Read-only track shape; no catalogue/schema or provider writes are possible here. */
export interface LocalisableTrack {
  title: string
  aliases?: Record<string, string[]> | undefined
}

type Converters = typeof import('./chineseTitleConverter')
const converters = shallowRef<Converters>()
let loading: Promise<void> | undefined

/** One on-demand chunk. Failed loads leave the original readable title intact. */
export function loadChineseTitleConverter(): Promise<void> {
  return loading ??= prepareConverterCache().then(() => import('./chineseTitleConverter')).then(value => { converters.value = value })
}

function firstNonEmpty(values: readonly string[] | undefined): string | null {
  if (!Array.isArray(values)) return null
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

// Han is necessary, never sufficient: the alias language supplies provenance.
// Kana, Hangul and other letter scripts veto conversion, including mixed titles.
function safeChinese(value: string, aliases: LocalisableTrack['aliases']): boolean {
  if (!/\p{Script=Han}/u.test(value)) return false
  for (const character of value) {
    if (/[\p{L}\p{M}]/u.test(character) && !/[\p{Script=Han}\p{Script=Latin}\p{Script=Common}]/u.test(character)) return false
  }
  return !Object.entries(aliases ?? {}).some(([tag, values]) =>
    !/^zh(?:-|$)/i.test(tag) && Array.isArray(values) && values.some(alias => typeof alias === 'string' && alias.trim() === value),
  )
}

function convert(value: string, locale: 'zh-Hant' | 'zh-Hans'): string {
  // Read the ref even on the cold path so all Vue title surfaces refresh once
  // dictionaries arrive. Never modify queue, playback, search or source objects.
  const engine = converters.value
  if (engine) return locale === 'zh-Hant' ? engine.toTraditional(value) : engine.toSimplified(value)
  void loadChineseTitleConverter().catch(() => { /* retain original on chunk failure */ })
  return value
}

/**
 * Presentation only: exact alias (unchanged) → safe generic zh (converted) →
 * opposite-script alias (converted only when safe) → canonical with matching
 * Chinese alias provenance (converted only when safe) → canonical/fallback.
 * English never cross-serves Chinese. Exact aliases remain official, even when
 * their spelling differs from generated HK forms. No Han search folding here.
 */
export function resolveDisplayTitle(
  track: LocalisableTrack | null | undefined,
  locale: Locale,
  fallback = '',
): string {
  if (!track) return fallback
  const canonical = typeof track.title === 'string' ? track.title.trim() : ''
  const aliases = track.aliases
  const exact = firstNonEmpty(aliases?.[locale])
  if (exact) return exact
  if (locale !== 'en') {
    const generic = firstNonEmpty(aliases?.zh)
    if (generic && safeChinese(generic, aliases)) return convert(generic, locale)
    const opposite = firstNonEmpty(aliases?.[locale === 'zh-Hant' ? 'zh-Hans' : 'zh-Hant'])
    if (opposite) return safeChinese(opposite, aliases) ? convert(opposite, locale) : opposite
    const chineseProvenance = Object.entries(aliases ?? {}).some(([tag, values]) =>
      /^zh(?:-|$)/i.test(tag) && Array.isArray(values) && values.some(value => typeof value === 'string' && value.trim() === canonical),
    )
    if (chineseProvenance && safeChinese(canonical, aliases)) return convert(canonical, locale)
  }
  return canonical || fallback
}

/** Stored exact aliases only; generated fallback presentation is not localisation data. */
export function hasLocalisedTitle(track: LocalisableTrack | null | undefined, locale: Locale): boolean {
  return firstNonEmpty(track?.aliases?.[locale]) !== null
}

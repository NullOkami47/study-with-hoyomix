/**
 * Validate that alias locale tags can actually be reached by the UI.
 *
 * ## Why this exists
 *
 * Display selects exact locale aliases or a safe generic zh fallback.
 * The three exact UI locales are supported, plus safe generic zh fallback.
 * Other locale tags are not directly selected and are reported for review.
 *
 * Task 15 found exactly this: `data/catalog/staging_aliases.csv` uses `zh-CN` and `fr-FR`, neither
 * of which is a `Locale`. The workbook's own `Instructions` sheet says aliases should use
 * "a valid locale such as en, zh-Hant, or zh-Hans", so the CSV and the contract disagree.
 *
 * Silent invisibility is the failure mode worth guarding against: nothing errors, the data is
 * present, and the user simply sees English. A structural validator cannot catch it because
 * `zh-CN` is a perfectly well-formed string.
 *
 * ## What this module does NOT do
 *
 * It does not rewrite the locale. Mapping `zh-CN` to `zh-Hans` would be a plausible guess, but the
 * value stored under `zh-CN` is Simplified while a `zh-Hant` interface needs Traditional, so the
 * choice between `zh-Hans` and `zh-Hant` is a data decision, not a mechanical one. It reports and
 * leaves the decision to review.
 */

import type { Locale } from '../../i18n'

/** The locales the UI can look up. Kept as a runtime list so validation and the type cannot drift. */
export const REACHABLE_ALIAS_LOCALES: readonly Locale[] = ['en', 'zh-Hant', 'zh-Hans']

/**
 * Locale tags that are well-formed and plausibly intended for a Chinese interface, but which the
 * UI cannot reach. Reported with the likely intended locale so a reviewer has a starting point
 * rather than just a rejection.
 */
const UNREACHABLE_CHINESE_LOCALES: Record<string, Locale | null> = {
  // Region tags. The script is not encoded in the tag, so the correct target is genuinely
  // ambiguous — either Chinese locale is possible and only the stored value can settle it.
  'zh-CN': null,
  'zh-SG': null,
  // Script-explicit tags that name a script the app does not expose are a different problem:
  // the intended target IS determinable from the tag itself.
  'zh-Hant-TW': 'zh-Hant',
  'zh-Hant-HK': 'zh-Hant',
  'zh-Hant-MO': 'zh-Hant',
  'zh-Hans-CN': 'zh-Hans',
  'zh-Hans-SG': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-HK': 'zh-Hant',
  'zh-MO': 'zh-Hant',
}

export type AliasLocaleIssue = {
  trackId: string
  /** The locale tag as stored. */
  storedLocale: string
  /**
   * The locale that most likely should have been used, or `null` when the tag does not determine
   * one. `null` means a human must decide; it does not mean "no problem".
   */
  likelyLocale: Locale | null
  /** Number of alias values stored under the unreachable tag. */
  valueCount: number
}

export type AliasLocaleReport = {
  /** Distinct unreachable locale tags encountered, in first-seen order. */
  unreachableLocales: string[]
  issues: AliasLocaleIssue[]
  /** Rows skipped because the locale is reachable — these are fine. */
  reachableAliasCount: number
}

/** Minimal shape needed: an id plus an alias map. */
export interface AliasedTrack {
  id: string
  aliases?: Record<string, string[]> | undefined
}

/**
 * Find every alias whose locale the UI cannot look up.
 *
 * Results are deterministic: tracks are visited in input order and locales in the order they
 * appear on each track, so the report is stable across runs and diffable.
 */
export function validateAliasLocales(tracks: readonly AliasedTrack[]): AliasLocaleReport {
  const issues: AliasLocaleIssue[] = []
  const seenLocales = new Set<string>()
  const unreachableLocales: string[] = []
  let reachableAliasCount = 0

  for (const track of tracks) {
    const aliases = track.aliases
    if (!aliases) continue

    for (const [locale, values] of Object.entries(aliases)) {
      const count = Array.isArray(values) ? values.length : 0

      if ((REACHABLE_ALIAS_LOCALES as readonly string[]).includes(locale) || locale === 'zh') {
        reachableAliasCount += count
        continue
      }

      // A locale with no values cannot render anything, so it is not a rendering bug. Report it
      // only when it actually holds data, to keep the signal about lost content.
      if (count === 0) continue

      if (!seenLocales.has(locale)) {
        seenLocales.add(locale)
        unreachableLocales.push(locale)
      }

      issues.push({
        trackId: track.id,
        storedLocale: locale,
        likelyLocale: isChineseLocaleTag(locale)
          ? UNREACHABLE_CHINESE_LOCALES[locale] ?? null
          : null,
        valueCount: count,
      })
    }
  }

  return { unreachableLocales, issues, reachableAliasCount }
}

/**
 * Whether a tag is Chinese and therefore *probably* intended for a Chinese interface.
 *
 * Used only to sharpen the report. A non-Chinese tag such as `fr-FR` is unreachable too, but
 * mapping it to a `Locale` is not even a candidate, because the app has no French interface.
 */
export function isChineseLocaleTag(locale: string): boolean {
  return typeof locale === 'string' && /^zh\b/i.test(locale.trim())
}

/** Human-readable rendering of the report, for a CLI or a review artefact. */
export function renderAliasLocaleReport(report: AliasLocaleReport): string {
  const lines: string[] = []
  lines.push('=== alias locale validation ===')
  lines.push(`reachable alias values   : ${report.reachableAliasCount}`)
  lines.push(`unreachable locale tags  : ${report.unreachableLocales.length === 0 ? 'none' : report.unreachableLocales.join(', ')}`)
  lines.push(`affected track/locale pairs : ${report.issues.length}`)
  lines.push('')

  if (report.issues.length === 0) {
    lines.push('Every stored alias is reachable by the UI.')
    return `${lines.join('\n')}\n`
  }

  lines.push('These aliases will never render, because the UI cannot look up their locale:')
  lines.push('')
  for (const issue of report.issues) {
    const suggestion = issue.likelyLocale
      ? `-> likely intended: ${issue.likelyLocale}`
      : isChineseLocaleTag(issue.storedLocale)
        ? '-> target locale ambiguous from the tag; the stored script decides'
        : '-> the app has no interface for this locale; the alias cannot be shown'
    lines.push(`  ${issue.trackId}  [${issue.storedLocale}]  ${issue.valueCount} value(s)  ${suggestion}`)
  }
  lines.push('')
  lines.push('This module does not rewrite the locale: the correct mapping must be reviewed.')
  return `${lines.join('\n')}\n`
}

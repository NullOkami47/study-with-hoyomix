/**
 * The single normalisation both the catalogue index and the search query use.
 *
 * Search folds a query and a precomputed haystack into the same form and then compares
 * them. Keeping the transform in one place is what makes that comparison sound: if the
 * index and the query normalised differently, a correct query would silently miss.
 *
 * ## What the transform does, and why each step is there
 *
 * 1. **NFKD** — canonical decomposition, so compatibility characters (full-width digits
 *    and Latin, ligatures, CJK compatibility ideographs) become their canonical form.
 * 2. **Strip combining marks** — removes the accents NFKD just separated, so `café` and
 *    `cafe` match. Safe for Han, which has no combining marks.
 * 3. **Lower-case** — case-insensitive search.
 * 4. **Drop everything that is not a letter or a number** — this is the step that makes
 *    the comparison tolerant of punctuation *and* whitespace at once: `Hope Is the Thing
 *    With Feathers`, `hope-is-the-thing`, and `HopeIsTheThing` all collapse to the same
 *    string, and so do `One's Cup` / `ones cup` / `ones-cup`. It also removes emoji,
 *    symbols and stray separators for free.
 * 5. **Han fold** — maps Traditional characters to their Simplified counterparts so a
 *    Traditional query can match a Simplified title and vice versa. See `hanFold.ts`.
 *
 * The result is a single squashed token string, so matching is a plain `includes`.
 *
 * ## Cost
 *
 * This runs once per catalogue field when the index is built, never per keystroke. The
 * per-keystroke work is the `includes` scan itself, which is why the index stores the
 * normalised form rather than the raw text.
 *
 * ## Deliberate limitation
 *
 * Squashing word boundaries means a query can match across two words that were separate
 * in the source (`thething` finds `the thing`). That is the trade that buys punctuation
 * tolerance without a tokeniser, and it only ever produces extra low-ranked matches, never
 * a miss.
 */

import { foldHan } from './hanFold'

const NOT_LETTER_OR_NUMBER = /[^\p{L}\p{N}]+/gu
const COMBINING_MARKS = /\p{M}+/gu

export function normaliseSearchText(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  return foldHan(
    value
      .normalize('NFKD')
      .replace(COMBINING_MARKS, '')
      .toLowerCase()
      .replace(NOT_LETTER_OR_NUMBER, ''),
  )
}

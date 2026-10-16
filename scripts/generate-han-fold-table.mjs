/**
 * Generate generic Han search folds from public Unicode BMP code points using
 * the locked OpenCC dependency. No private or published music dataset is read.
 *
 * Run: npm ci && node scripts/generate-han-fold-table.mjs
 * OpenCC code/dictionary notices are retained in docs/licenses/ and bundled legal
 * notices. The generated table has no runtime dependency on the converter.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Converter } from 'opencc-js/t2cn'
import { collectHanCorpus, hanCorpusDigest } from './han-fold-corpus.mjs'

const convert = Converter({ from: 't', to: 'cn' })
const corpus = collectHanCorpus()
const pairs = new Map()
for (const character of corpus) {
  const simplified = convert(character)
  // This table represents only single BMP-character mappings. Phrase conversion
  // belongs to the separate presentation converter; search remains a simple fold.
  if (simplified.length === 1 && simplified !== character) pairs.set(character, simplified)
}

// Resolve any conversion chains to keep the search key fold idempotent.
for (const [character, target] of pairs) {
  const seen = new Set([character])
  let canonical = target
  while (pairs.has(canonical)) {
    if (seen.has(canonical)) throw new Error('OpenCC fold contains a conversion cycle')
    seen.add(canonical)
    canonical = pairs.get(canonical)
  }
  pairs.set(character, canonical)
}
const entries = [...pairs.entries()].sort(([a], [b]) => a.charCodeAt(0) - b.charCodeAt(0))
const sources = entries.map(([from]) => from).join('')
const targets = entries.map(([, to]) => to).join('')
const digest = hanCorpusDigest(corpus)
const output = `/**
 * Generated generic Han search folds; do not edit by hand.
 * Regenerate: npm ci && node scripts/generate-han-fold-table.mjs
 *
 * The public edition covers complete Unicode BMP CJK Extension A, Unified and
 * Compatibility Ideographs ranges using OpenCC. No private catalogue is used.
 * Only single-character mappings are stored; astral characters pass unchanged.
 * OpenCC MIT/Apache dictionary notices: docs/licenses/opencc-js-*.txt.
 * Corpus characters: ${corpus.length}; fold pairs: ${entries.length}.
 */
const FOLD_SOURCES = ${JSON.stringify(sources)}
const FOLD_TARGETS = ${JSON.stringify(targets)}
const HAN_FOLD: ReadonlyMap<string, string> = new Map(
  [...FOLD_SOURCES].map((character, index) => [character, FOLD_TARGETS[index]]),
)
export const HAN_FOLD_CORPUS_DIGEST = '${digest}'
export const HAN_FOLD_PAIR_COUNT = ${entries.length}

/** Fold Han search keys independently of the currently loaded catalogue. */
export function foldHan(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return value
  let folded = ''
  for (const character of value) folded += HAN_FOLD.get(character) ?? character
  return folded
}
`
const outFile = resolve('src/features/catalog/hanFold.ts')
writeFileSync(outFile, output, 'utf8')
console.log(`Generic Han fold: ${entries.length} pairs, ${corpus.length} BMP code points, digest ${digest}`)
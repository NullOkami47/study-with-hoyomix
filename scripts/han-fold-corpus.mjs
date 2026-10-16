/**
 * Public, catalogue-independent corpus for the generated search fold table.
 *
 * The public edition covers the complete Unicode BMP CJK Extension A, Unified
 * Ideographs and Compatibility Ideographs ranges. It never reads a music
 * catalogue, account data or source deployment inventory. Fixed code-point ranges
 * make regeneration deterministic across Node/Unicode property-table versions.
 * Astral characters remain unchanged by the runtime fold, as before.
 */
import { createHash } from 'node:crypto'

export function collectHanCorpus() {
  const characters = []
  for (const [first, last] of [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]) {
    for (let codePoint = first; codePoint <= last; codePoint++) characters.push(String.fromCodePoint(codePoint))
  }
  return characters
}

/** No catalogue phrases are consumed by the public generator. */
export function collectHanStrings() {
  return []
}

export function hanCorpusDigest(characters) {
  return createHash('sha256').update(characters.join('')).digest('hex')
}
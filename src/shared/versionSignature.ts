/**
 * Shared version-signature logic (Task 16 / Phase B shared runtime).
 *
 * Implements structural detection of version qualifiers in track titles:
 * - Brackets: (...), [...], 【...】, （...）
 * - Trailing separator clauses: "Song - Instrumental"
 * - Trailing CJK markers: "Song 伴奏"
 *
 * Distinguishes version families (instrumental, accompaniment, harmonic accompaniment,
 * live, remix, alternate language, etc.) from base song identity.
 */

export interface VersionMarkerRule {
  key: string
  res: RegExp[]
}

const MARKERS: VersionMarkerRule[] = [
  { key: 'harmonic_accompaniment', res: [/harmonic\s+accompaniment/i, /和聲伴奏/, /和声伴奏/] },
  {
    key: 'instrumental',
    res: [
      /instrumental/i, /off[\s-]?vocal/i, /\baccompaniment\b/i, /karaoke/i,
      /\binst\./i, /伴奏/, /卡拉\s*OK/i, /卡拉/, /無人聲/, /无人声/, /純器樂/, /纯器乐/,
    ],
  },
  { key: 'backing_vocal', res: [/backing\s+vocals?/i, /伴唱/] },
  { key: 'live', res: [/\blive\b/i, /\bconcert\b/i, /現場/, /现场/, /演唱會/, /演唱会/] },
  { key: 'acoustic', res: [/\bacoustic\b/i, /\bunplugged\b/i, /不插電/, /不插电/] },
  { key: 'remix', res: [/\bremix\b/i, /\brmx\b/i, /重混/, /混音版/] },
  { key: 'orchestral', res: [/\borchestral\b/i, /\borchestra\b/i, /交響/, /交响/, /管弦樂/, /管弦乐/] },
  { key: 'short_ver', res: [/\bshort\s*(?:version|ver)\b/i, /\btv[\s-]?size\b/i, /\btv[\s-]?ver\b/i, /短版/] },
  { key: 'full_ver', res: [/\bfull\s*(?:version|ver)\b/i, /完整版/] },
  { key: 'english_ver', res: [/\benglish\s*(?:version|ver)\b/i, /\beng\.?\s*ver\b/i, /\benglish\b/i, /英文版/, /英語版/, /英语版/, /英文/] },
  { key: 'chinese_ver', res: [/\bchinese\s*(?:version|ver)\b/i, /\bchi\.?\s*ver\b/i, /\bchinese\b/i, /中文版/, /國語版/, /国语版/, /漢語版/, /汉语版/, /中文/, /國語/, /国语/] },
  { key: 'japanese_ver', res: [/\bjapanese\s*(?:version|ver)\b/i, /\bjp\.?\s*ver\b/i, /\bjapanese\b/i, /日文版/, /日本語版/, /日语版/, /日文/] },
  { key: 'korean_ver', res: [/\bkorean\s*(?:version|ver)\b/i, /\bkor\.?\s*ver\b/i, /\bkorean\b/i, /韓文版/, /韩文版/, /韓文/, /韩文/, /한국어/] },
  { key: 'variation', res: [/\bvariations?\b/i, /\bvar\./i, /變奏曲/, /变奏曲/, /變奏/, /变奏/] },
  { key: 'ensemble', res: [/\bensemble\b/i, /合奏/] },
  { key: 'performance_version', res: [/perform(?:ance)?\s*(?:version|ver)/i, /演奏版/, /演出(?:版|版本)/] },
  { key: 'piano', res: [/\bpiano\b/i, /\bpf\./i, /鋼琴/, /钢琴/] },
  { key: 'guitar', res: [/\bguitar\b/i, /吉他/] },
  { key: 'solo', res: [/\bsolo\b/i, /獨奏/, /独奏/] },
  { key: 'reprise', res: [/\breprise\b/i, /重奏/] },
  { key: 'demo', res: [/\bdemo\b/i, /試聽/, /试听/] },
  { key: 'take_version', res: [/\b\d+(?:st|nd|rd|th)?\s*take\b/i, /\btake\s*(?:version|ver)\b/i] },
  { key: 'encore', res: [/\bencore\b/i, /安可/] },
  { key: 'pure_version', res: [/純享版/, /纯享版/] },
  { key: 'alt_arrangement', res: [/\balternate\b/i, /\balternative\b/i, /\barrangement\b/i, /改編/, /改编/] },
  { key: 'theme_remake', res: [/\bremake\b/i, /\bre-?master(?:ed)?\b/i, /重製/, /重制/] },
]

const LATIN_FILLER = [
  'version', 'ver', 'mix', 'no', 'st', 'nd', 'rd', 'th', 'take', 'key', 'male', 'female',
  'part', 'vol', 'and', 'with', 'in', 'the', 'a', 'of', 'for', 'from', 'to', 'style',
  'edit', 'type', 'edition', 'size', 'track', 'disc',
  'original', 'soundtrack', 'sound', 'ost', 'ep',
]

const CJK_FILLER = [
  '版本', '版', '和聲', '和声', '人聲', '人声', '純', '纯', '器樂', '器乐',
  '男調', '男调', '女調', '女调', '調', '调', '之', '的', '與', '与', '及', '和',
  '曲', '加', '長', '长', '樂', '乐', '無', '无', '聲', '声', '語', '语', '伴', '唱',
  '原聲帶', '原声带',
]

const BRACKET_RE = /[（(\[【]([^）)\]】]*)[）)\]】]/g
const SEPARATOR_TAIL_RE = /\s[-–—]\s*([^-–—]+)$/

interface ScannedMarker {
  key: string
  text: string
  index: number
  length: number
}

const asGlobal = (re: RegExp): RegExp => (re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`))

function scanMarkers(text: string): ScannedMarker[] {
  const s = String(text || '')
  if (!s) return []
  const candidates: ScannedMarker[] = []
  for (const { key, res } of MARKERS) {
    for (const re of res) {
      const r = asGlobal(re)
      let m: RegExpExecArray | null
      while ((m = r.exec(s)) !== null) {
        if (m[0].length === 0) { r.lastIndex += 1; continue }
        candidates.push({ key, text: m[0], index: m.index, length: m[0].length })
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length || a.index - b.index)

  const taken = new Array(s.length).fill(false)
  const out: ScannedMarker[] = []
  for (const c of candidates) {
    let free = true
    for (let i = c.index; i < c.index + c.length; i += 1) if (taken[i]) { free = false; break }
    if (!free) continue
    for (let i = c.index; i < c.index + c.length; i += 1) taken[i] = true
    out.push(c)
  }
  return out.sort((a, b) => a.index - b.index)
}

const FILLER_WORDS_DESC = [...new Set([...CJK_FILLER, ...LATIN_FILLER])].sort((a, b) => b.length - a.length)

export function stripFillerWords(residual: string): string {
  let r = String(residual || '')
  for (;;) {
    const hit = FILLER_WORDS_DESC.find((w) => w && r.startsWith(w))
    if (!hit) return r
    r = r.slice(hit.length)
  }
}

function stripFiller(text: string): string {
  let r = String(text || '').normalize('NFKC').toLowerCase()
  r = r.replace(/[\s\u3000]+/g, '')
  r = r.replace(/[!?.,:;·・、。，！？：；\-–—_/\\|'"“”‘’()（）\[\]【】&+~<>《》「」『』]/g, '')
  r = r.replace(/\d+/g, '')
  return stripFillerWords(r)
}

function isQualifierGroup(groupText: string, markers: ScannedMarker[]): boolean {
  if (!markers.length) return false
  let residual = String(groupText || '')
  for (const m of [...markers].sort((a, b) => b.index - a.index)) {
    residual = residual.slice(0, m.index) + residual.slice(m.index + m.length)
  }
  return stripFiller(residual) === ''
}

function separatorMarkers(title: string): string[] {
  const m = SEPARATOR_TAIL_RE.exec(String(title || ''))
  if (!m) return []
  const clause = m[1]
  const markers = scanMarkers(clause)
  return isQualifierGroup(clause, markers) ? markers.map((x) => x.key) : []
}

function trailingCjkMarkers(title: string): string[] {
  const t = String(title || '').normalize('NFKC').replace(/[\s\u3000]+$/g, '')
  const out = new Set<string>()
  for (const { key, res } of MARKERS) {
    for (const re of res) {
      if (!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(re.source)) continue
      const literal = re.source.replace(/[\\^$.*+?()[\]{}|]/g, '')
      if (!literal) continue
      if (t.endsWith(literal) || new RegExp(`${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:版|版本)$`).test(t)) {
        out.add(key)
      }
    }
  }
  return [...out]
}

export function detectVersionMarkers(title: string): string[] {
  const s = String(title || '')
  if (!s.trim()) return []
  const keys = new Set<string>()

  for (const m of s.matchAll(BRACKET_RE)) {
    const groupText = m[1]
    const markers = scanMarkers(groupText)
    if (isQualifierGroup(groupText, markers)) for (const x of markers) keys.add(x.key)
  }

  for (const k of separatorMarkers(s)) keys.add(k)
  for (const k of trailingCjkMarkers(s)) keys.add(k)

  return [...keys].sort()
}

export function versionSignature(title: string): string {
  const keys = detectVersionMarkers(title)
  return keys.length ? keys.join('+') : 'none'
}

export const hasVersionQualifier = (title: string): boolean => detectVersionMarkers(title).length > 0

export const sameVersionFamily = (a: string, b: string): boolean => versionSignature(a) === versionSignature(b)

const LANGUAGE_SCRIPT = [
  { key: 'chinese_ver', re: /[\u3400-\u4dbf\u4e00-\u9fff]/ },
  { key: 'japanese_ver', re: /[\u3040-\u309f\u30a0-\u30ff]/ },
  { key: 'korean_ver', re: /[\uac00-\ud7af\u1100-\u11ff]/ },
  { key: 'english_ver', re: /[^\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff]/ },
]

const LANGUAGE_KEYS = new Set(LANGUAGE_SCRIPT.map((x) => x.key))

function scriptSatisfies(title: string, key: string): boolean {
  const rule = LANGUAGE_SCRIPT.find((x) => x.key === key)
  if (!rule) return false
  if (key === 'english_ver') {
    return !/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff]/.test(String(title || ''))
  }
  return rule.re.test(String(title || ''))
}

export function versionCompatible(a: string, b: string): boolean {
  const sigA = versionSignature(a)
  const sigB = versionSignature(b)
  if (sigA === sigB) return true
  const keysA = new Set(detectVersionMarkers(a))
  const keysB = new Set(detectVersionMarkers(b))
  const diff = [...keysA, ...keysB].filter((k) => !(keysA.has(k) && keysB.has(k)))
  if (!diff.length || !diff.every((k) => LANGUAGE_KEYS.has(k))) return false
  for (const k of diff) {
    const missingSide = keysA.has(k) ? b : a
    if (!scriptSatisfies(missingSide, k)) return false
  }
  return true
}

export interface SplitTitleQualifiersResult {
  base: string
  groups: Array<{ text: string; kind: 'bracket' }>
}

export function splitTitleQualifiers(title: string): SplitTitleQualifiersResult {
  const s = String(title || '')
  const groups: Array<{ text: string; kind: 'bracket' }> = []
  for (const m of s.matchAll(BRACKET_RE)) groups.push({ text: m[1], kind: 'bracket' })
  const base = s.replace(BRACKET_RE, ' ').replace(/\s+/g, ' ').trim()
  return { base, groups }
}

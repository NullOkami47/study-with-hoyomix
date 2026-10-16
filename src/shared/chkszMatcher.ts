/**
 * ChKSz identity matcher — `chksz-identity-v1`.
 *
 * Deterministically evaluates candidates returned by ChKSz search against canonical HOYO-MiX metadata.
 * Optimised for identity safety under upstream rate-limited conditions: a wrong recording is worse
 * than no recording, so every gate fails closed.
 *
 * Full 1:1 TypeScript port of `scripts/chksz-identity-matcher.mjs`.
 */

import {
  detectVersionMarkers,
  versionCompatible,
} from './versionSignature.ts'
import {
  CHKSZ_DISCOVERY_CONFIDENCE,
  CHKSZ_MATCHER_VERSION,
  isChkszDenied,
  RUNTIME_DENYLIST,
  type ChkszConfidenceClass,
  type ChkszRuntimeDenylist,
} from './chkszDiscovery.ts'

export const MATCHER_VERSION = CHKSZ_MATCHER_VERSION

export const CONFIDENCE = CHKSZ_DISCOVERY_CONFIDENCE

export const DURATION = Object.freeze({
  EXACT_MAX_S: 0.05,
  NEAR_MAX_S: 0.5,
  ACCEPTABLE_MAX_S: 2.0,
  SUSPICIOUS_MAX_S: 5.0,
})

export const THRESHOLDS = Object.freeze({
  EXACT_SCORE: 70,
  HIGH_SCORE: 55,
  HIGH_MARGIN: 15,
  AMBIGUOUS_MARGIN: 10,
})

const INSTRUMENTAL_KEYS = new Set([
  'instrumental',
  'harmonic_accompaniment',
  'backing_vocal',
  'pure_version',
  'performance_version',
])

const LANGUAGE_KEYS = new Set(['english_ver', 'chinese_ver', 'japanese_ver', 'korean_ver'])

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/u
const HANGUL_RE = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u

const hasHan = (s: string) => CJK_RE.test(s)
const hasKana = (s: string) => KANA_RE.test(s)
const hasHangul = (s: string) => HANGUL_RE.test(s)
const hasAnyCjk = (s: string) => hasHan(s) || hasKana(s) || hasHangul(s)

export function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function looseTokens(value: unknown): string[] {
  return normalizeTitle(value)
    .replace(/[^\p{L}\p{N}!]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
}

function tokenOverlap(a: unknown, b: unknown): number {
  const ta = looseTokens(a)
  const tb = looseTokens(b)
  if (!ta.length || !tb.length) return 0
  const setB = new Set(tb)
  let hit = 0
  for (const t of ta) if (setB.has(t)) hit += 1
  return hit / Math.max(ta.length, tb.length)
}

export function durationCategory(
  canonicalSeconds?: number | null,
  candidateMs?: number | null,
): 'exact' | 'near' | 'acceptable' | 'suspicious' | 'incompatible' | 'unknown' {
  if (typeof canonicalSeconds !== 'number' || !Number.isFinite(canonicalSeconds)) return 'unknown'
  if (typeof candidateMs !== 'number' || !Number.isFinite(candidateMs) || candidateMs <= 0) return 'unknown'
  const delta = Math.abs(canonicalSeconds - candidateMs / 1000)
  if (delta <= DURATION.EXACT_MAX_S) return 'exact'
  if (delta <= DURATION.NEAR_MAX_S) return 'near'
  if (delta <= DURATION.ACCEPTABLE_MAX_S) return 'acceptable'
  if (delta <= DURATION.SUSPICIOUS_MAX_S) return 'suspicious'
  return 'incompatible'
}

export function durationDeltaSeconds(
  canonicalSeconds?: number | null,
  candidateMs?: number | null,
): number | null {
  if (typeof canonicalSeconds !== 'number' || !Number.isFinite(canonicalSeconds)) return null
  if (typeof candidateMs !== 'number' || !Number.isFinite(candidateMs) || candidateMs <= 0) return null
  return Math.abs(canonicalSeconds - candidateMs / 1000)
}

export { isChkszDenied as isDenied }

export interface CanonicalTrackInput {
  track_id?: string
  id?: string
  title: string
  album?: string | null
  vocal_status?: string | null
  vocalStatus?: string | null
  duration_s?: number | null
  aliases?: Array<string | { alias: string }> | null
  official_zh_hant_title?: string | null
  official_zh_hans_title?: string | null
  [key: string]: unknown
}

export interface ChkszCandidateInput {
  id: string | number
  name: string
  artists?: string | null
  album?: string | null
  durationMs?: number | null
  duration_ms?: number | null
  searchRank?: number | null
  [key: string]: unknown
}

function canonicalIdentityStrings(canonical: CanonicalTrackInput): string[] {
  const out: string[] = []
  if (canonical.title) out.push(String(canonical.title))
  for (const a of canonical.aliases ?? []) {
    const v = typeof a === 'string' ? a : a?.alias
    if (v) out.push(String(v))
  }
  if (canonical.official_zh_hant_title) out.push(String(canonical.official_zh_hant_title))
  if (canonical.official_zh_hans_title) out.push(String(canonical.official_zh_hans_title))
  return out.filter(Boolean)
}

function versionGate(
  canonicalStrings: string[],
  candidateName: string,
): { pass: boolean; via?: string; reason?: string } {
  for (const s of canonicalStrings) {
    if (versionCompatible(s, candidateName)) return { pass: true, via: s }
  }
  return { pass: false, reason: 'version_signature_incompatible' }
}

export function baseTitle(value: unknown): string {
  let s = String(value ?? '').normalize('NFKC')
  s = s.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')
  const m = /\s+[-–—]\s*([^-–—]+)$/.exec(s)
  if (m) {
    const tail = m[1].trim()
    const markers = detectVersionMarkers(`(${tail})`)
    if (markers.length > 0) {
      s = s.slice(0, m.index)
    }
  }
  return normalizeTitle(s)
}

function languageGate(
  canonical: CanonicalTrackInput,
  candidateName: string,
  exactHit: boolean,
): { pass: boolean; via?: string; reason?: string } {
  if (exactHit) return { pass: true, via: 'exact_identity_string' }
  const canon = canonicalIdentityStrings(canonical)
  const candBase = baseTitle(candidateName)
  const candIsCjk = hasAnyCjk(candBase || candidateName)
  const candIsLatin = !candIsCjk

  const canonBases = canon.map((s) => baseTitle(s)).filter(Boolean)
  const anyCanonicalCjk = canonBases.some((s) => hasAnyCjk(s))
  const anyCanonicalLatin = canonBases.some((s) => !hasAnyCjk(s))

  if (anyCanonicalCjk && anyCanonicalLatin) return { pass: true, via: 'dual_script_canonical' }

  if (!anyCanonicalCjk && anyCanonicalLatin) {
    if (candIsCjk) return { pass: false, reason: 'language_script_mismatch' }
    return { pass: true, via: 'latin_ok' }
  }

  if (anyCanonicalCjk && !anyCanonicalLatin) {
    if (candIsLatin) return { pass: false, reason: 'language_script_mismatch' }
    return { pass: true, via: 'cjk_ok' }
  }

  if (candIsCjk && !anyCanonicalCjk) return { pass: false, reason: 'language_script_mismatch' }
  void candIsLatin
  return { pass: true, via: 'fallback' }
}

function vocalGate(
  canonical: CanonicalTrackInput,
  candidateName: string,
  versionVia?: string,
): { pass: boolean; via?: string; reason?: string } {
  const canonMarkers = new Set<string>()
  for (const s of canonicalIdentityStrings(canonical)) {
    for (const k of detectVersionMarkers(s)) canonMarkers.add(k)
  }
  const canonicalVocal = canonical.vocal_status ?? canonical.vocalStatus
  if (canonicalVocal === 'instrumental') canonMarkers.add('instrumental')

  const candMarkers = new Set(detectVersionMarkers(candidateName))
  const candInstrumental = [...candMarkers].some((k) => INSTRUMENTAL_KEYS.has(k))
  const canonInstrumental = [...canonMarkers].some((k) => INSTRUMENTAL_KEYS.has(k))

  if (canonicalVocal === 'vocal' && candInstrumental && !canonInstrumental) {
    return { pass: false, reason: 'candidate_instrumental_for_vocal_canonical' }
  }
  if (canonicalVocal === 'instrumental' && !candInstrumental) {
    if (versionVia) {
      const viaMarkers = detectVersionMarkers(versionVia)
      if (viaMarkers.some((k) => INSTRUMENTAL_KEYS.has(k))) {
        return { pass: true, via: 'version_via_marked_identity' }
      }
    }
    return { pass: false, reason: 'canonical_instrumental_requires_candidate_marker' }
  }
  return { pass: true, via: 'ok' }
}

export interface CandidateScoreEvidence {
  title: string | null
  version_via?: string
  language_via?: string
  vocal_via?: string
  album_hit: boolean
  artist_hoyo_mix: boolean
  search_rank: number | null
  version_markers_canonical: string[]
  version_markers_candidate: string[]
}

export interface CandidatePoints {
  title: number
  duration: number
  album: number
  artist: number
  rank: number
}

export interface ScoredCandidate {
  rejected: boolean
  reason?: string
  detail?: string
  external_id: string
  name: string
  artists?: string
  album?: string
  duration_ms?: number | null
  duration_delta_s?: number | null
  duration_category?: string
  score?: number
  title_kind?: string | null
  gate?: string
  evidence?: CandidateScoreEvidence
  points?: CandidatePoints
  searchRank?: number
}

export interface CandidateScoreOptions {
  denylist?: ChkszRuntimeDenylist
}

export function scoreCandidate(
  canonical: CanonicalTrackInput,
  candidate: ChkszCandidateInput,
  options: CandidateScoreOptions = {},
): ScoredCandidate {
  const denylist = options.denylist ?? RUNTIME_DENYLIST
  const trackId = String(canonical.track_id ?? canonical.id ?? '')
  const externalId = String(candidate.id ?? candidate.netease_id ?? '')
  const name = String(candidate.name ?? '')

  const denied = isChkszDenied(trackId, externalId, denylist)
  if (denied.blocked) {
    return {
      rejected: true,
      reason: 'denylisted',
      detail: denied.reason ?? undefined,
      external_id: externalId,
      name,
      gate: 'denylist',
    }
  }

  const canonicalStrings = canonicalIdentityStrings(canonical)
  if (!canonicalStrings.length || !name) {
    return { rejected: true, reason: 'insufficient_identity', external_id: externalId, name }
  }

  const normName = normalizeTitle(name)
  const normCanonSet = canonicalStrings.map((s) => ({ raw: s, norm: normalizeTitle(s) }))

  const exact = normCanonSet.find((c) => c.norm === normName) ?? null

  const candMarkers = new Set(detectVersionMarkers(name))
  const candInstrumental = [...candMarkers].some((k) => INSTRUMENTAL_KEYS.has(k))

  const canonicalVocal = canonical.vocal_status ?? canonical.vocalStatus

  if (canonicalVocal === 'instrumental' && !candInstrumental) {
    return {
      rejected: true,
      reason: 'canonical_instrumental_requires_candidate_marker',
      external_id: externalId,
      name,
      gate: 'vocal',
    }
  }

  if (canonicalVocal === 'vocal' && candInstrumental) {
    const canonInstrumental = canonicalStrings.some((s) =>
      detectVersionMarkers(s).some((k) => INSTRUMENTAL_KEYS.has(k)),
    )
    if (!canonInstrumental) {
      return {
        rejected: true,
        reason: 'candidate_instrumental_for_vocal_canonical',
        external_id: externalId,
        name,
        gate: 'vocal',
      }
    }
  }

  const vg = versionGate(canonicalStrings, name)
  if (!vg.pass) {
    return { rejected: true, reason: vg.reason, external_id: externalId, name, gate: 'version' }
  }

  const lg = languageGate(canonical, name, Boolean(exact))
  if (!lg.pass) {
    return { rejected: true, reason: lg.reason, external_id: externalId, name, gate: 'language' }
  }

  const vocal = vocalGate(canonical, name, vg.via)
  if (!vocal.pass) {
    return { rejected: true, reason: vocal.reason, external_id: externalId, name, gate: 'vocal' }
  }

  const candAlbum = String(candidate.album ?? '')
  const candArtists = String(candidate.artists ?? '')
  const COVER_RE = /\b(?:covers?|cover\s+collection|tribute)\b|翻唱/i
  if (COVER_RE.test(name) || COVER_RE.test(candAlbum) || COVER_RE.test(candArtists)) {
    return {
      rejected: true,
      reason: 'candidate_is_cover_recording',
      external_id: externalId,
      name,
      gate: 'performer',
    }
  }

  const candLangMarkers = [...candMarkers].filter((k) => LANGUAGE_KEYS.has(k))
  const GENERIC_LANG_VER_RE =
    /[（(\[【]\s*([a-zA-Z\u4e00-\u9fa5]+)\s*(?:version|ver\.?|版|版本)\s*[）)\]】]/i
  const genericLangMatch = GENERIC_LANG_VER_RE.exec(name)
  const isCandidateLanguageVersion =
    candLangMarkers.length > 0 ||
    (genericLangMatch && !INSTRUMENTAL_KEYS.has(genericLangMatch[1].toLowerCase()))

  if (isCandidateLanguageVersion) {
    const canonHasLang = canonicalStrings.some((s) => {
      const sMarkers = detectVersionMarkers(s)
      return sMarkers.some((k) => LANGUAGE_KEYS.has(k)) || GENERIC_LANG_VER_RE.test(s)
    })
    if (!canonHasLang && !exact) {
      return {
        rejected: true,
        reason: 'candidate_alternate_language_version',
        external_id: externalId,
        name,
        gate: 'language',
      }
    }
  }

  const canonAlbum = normalizeTitle(canonical.album)
  const normCandAlbum = normalizeTitle(candAlbum)
  const albumHit = Boolean(
    canonAlbum &&
      normCandAlbum &&
      (normCandAlbum.includes(canonAlbum) ||
        canonAlbum.includes(normCandAlbum) ||
        (canonAlbum.length > 8 &&
          normCandAlbum.length > 8 &&
          tokenOverlap(canonical.album, candAlbum) >= 0.6)),
  )

  const OFFICIAL_ARTIST_RE =
    /hoyo[\s-]?mix|mihoyo|米哈游|三z[\s-]?studio|3z[\s-]?studio|san\s*z\s*studio/i
  const hasOfficialArtist =
    OFFICIAL_ARTIST_RE.test(candArtists) ||
    OFFICIAL_ARTIST_RE.test(name) ||
    OFFICIAL_ARTIST_RE.test(candAlbum)

  if (!hasOfficialArtist && !albumHit) {
    return {
      rejected: true,
      reason: 'candidate_lacks_official_artist_corroboration',
      external_id: externalId,
      name,
      gate: 'performer',
    }
  }

  const candidateDurationMs =
    typeof candidate.durationMs === 'number'
      ? candidate.durationMs
      : typeof candidate.duration_ms === 'number'
        ? candidate.duration_ms
        : null

  const delta = durationDeltaSeconds(canonical.duration_s, candidateDurationMs)
  const dur = durationCategory(canonical.duration_s, candidateDurationMs)
  if (dur === 'incompatible') {
    return {
      rejected: true,
      reason: 'duration_incompatible',
      external_id: externalId,
      name,
      gate: 'duration',
      duration_delta_s: delta,
    }
  }

  let titleKind: string | null = null
  let titleScore = 0
  if (exact) {
    titleKind =
      canonical.title && normalizeTitle(canonical.title) === normName
        ? 'title_exact'
        : 'identity_string_exact'
    titleScore = 60
  } else {
    const canonBase = baseTitle(canonical.title)
    const candBase = baseTitle(name)
    if (canonBase && canonBase === candBase) {
      titleKind = 'base_match'
      titleScore = 40
    } else if (normName.includes(normCanonSet[0].norm) || normCanonSet[0].norm.includes(normName)) {
      titleKind = 'containment'
      titleScore = 30
    } else {
      const overlap = tokenOverlap(canonical.title, name)
      if (overlap >= 0.85) {
        titleKind = 'token_overlap_high'
        titleScore = 20
      } else if (overlap >= 0.6) {
        titleKind = 'token_overlap_mid'
        titleScore = 10
      }
    }
  }

  const durationPointsMap: Record<string, number> = {
    exact: 20,
    near: 15,
    acceptable: 8,
    suspicious: 0,
    unknown: 0,
  }
  const durationPoints = durationPointsMap[dur] ?? 0

  const searchRank = candidate.searchRank ?? 0
  const score =
    titleScore +
    durationPoints +
    (albumHit ? 10 : 0) +
    (hasOfficialArtist ? 5 : 0) +
    (searchRank === 0 ? 3 : 0)

  return {
    rejected: false,
    external_id: externalId,
    name,
    artists: candArtists,
    album: candidate.album ?? '',
    duration_ms: candidateDurationMs,
    duration_delta_s: delta,
    duration_category: dur,
    score,
    title_kind: titleKind,
    evidence: {
      title: titleKind,
      version_via: vg.via,
      language_via: lg.via,
      vocal_via: vocal.via,
      album_hit: albumHit,
      artist_hoyo_mix: hasOfficialArtist,
      search_rank: candidate.searchRank ?? null,
      version_markers_canonical: canonicalStrings
        .flatMap((s) => detectVersionMarkers(s))
        .filter((v, i, a) => a.indexOf(v) === i),
      version_markers_candidate: detectVersionMarkers(name),
    },
    points: {
      title: titleScore,
      duration: durationPoints,
      album: albumHit ? 10 : 0,
      artist: hasOfficialArtist ? 5 : 0,
      rank: searchRank === 0 ? 3 : 0,
    },
    searchRank,
  }
}

export interface ClassifyResult {
  confidence: ChkszConfidenceClass
  matcher_version: string
  accepted_external_id: string | null
  reason: string
  accepted?: ScoredCandidate | null
  scored: ScoredCandidate[]
  rejected: ScoredCandidate[]
  margin: number | null
  collision_group?: string[]
}

export function classifyCandidates(
  canonical: CanonicalTrackInput,
  candidates: ChkszCandidateInput[],
  options: CandidateScoreOptions = {},
): ClassifyResult {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) {
    return {
      confidence: CONFIDENCE.NO_MATCH,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: null,
      reason: 'no_candidates_returned',
      scored: [],
      rejected: [],
      margin: null,
    }
  }

  const scored: ScoredCandidate[] = []
  const rejected: ScoredCandidate[] = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const r = scoreCandidate(canonical, { ...c, searchRank: c.searchRank ?? i }, options)
    if (r.rejected) rejected.push(r)
    else scored.push(r)
  }

  if (scored.length === 0) {
    const hard = rejected.find((r) => r.gate) ?? rejected[0]
    return {
      confidence: CONFIDENCE.CONFLICT,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: null,
      reason: hard ? `all_candidates_rejected:${hard.reason}` : 'all_candidates_rejected',
      scored,
      rejected,
      margin: null,
    }
  }

  scored.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      String(a.external_id).localeCompare(String(b.external_id)),
  )
  const top = scored[0]
  const second = scored[1] ?? null
  const margin = second ? (top.score ?? 0) - (second.score ?? 0) : Number.POSITIVE_INFINITY

  const byNormName = new Map<string, ScoredCandidate[]>()
  for (const s of scored) {
    const k = normalizeTitle(s.name)
    if (!byNormName.has(k)) byNormName.set(k, [])
    byNormName.get(k)!.push(s)
  }
  for (const group of byNormName.values()) {
    if (group.length < 2) continue
    const durKnown = group.filter(
      (g) => g.duration_category !== 'unknown' && g.duration_category !== 'incompatible',
    )
    const clearlyBetter = durKnown.filter(
      (g) => g.duration_category === 'exact' || g.duration_category === 'near',
    )
    if (
      clearlyBetter.length === 1 &&
      group.every(
        (g) =>
          g === clearlyBetter[0] ||
          g.duration_category === 'suspicious' ||
          g.duration_category === 'unknown' ||
          g.duration_category === 'acceptable',
      )
    ) {
      const othersNear = group.some(
        (g) =>
          g !== clearlyBetter[0] &&
          (g.duration_category === 'exact' || g.duration_category === 'near'),
      )
      if (!othersNear) continue
    }
    if (
      group.some((g) => g.duration_category === 'exact' || g.duration_category === 'near') &&
      group.filter((g) => g.duration_category === 'exact' || g.duration_category === 'near')
        .length > 1
    ) {
      return {
        confidence: CONFIDENCE.AMBIGUOUS,
        matcher_version: MATCHER_VERSION,
        accepted_external_id: null,
        reason: 'identical_normalized_title_with_compatible_durations',
        scored,
        rejected,
        margin,
        collision_group: group.map((g) => g.external_id),
      }
    }
    if (group.length > 1 && clearlyBetter.length !== 1) {
      return {
        confidence: CONFIDENCE.AMBIGUOUS,
        matcher_version: MATCHER_VERSION,
        accepted_external_id: null,
        reason: 'identical_normalized_title_not_separated_by_duration',
        scored,
        rejected,
        margin,
        collision_group: group.map((g) => g.external_id),
      }
    }
  }

  const exactEvidence =
    top.title_kind === 'title_exact' || top.title_kind === 'identity_string_exact'
  const durationStrong = top.duration_category === 'exact' || top.duration_category === 'near'
  const durationOk =
    durationStrong ||
    top.duration_category === 'acceptable' ||
    top.duration_category === 'unknown'

  if (
    second &&
    margin <= THRESHOLDS.AMBIGUOUS_MARGIN &&
    exactEvidence &&
    (second.title_kind === 'title_exact' || second.title_kind === 'identity_string_exact')
  ) {
    return {
      confidence: CONFIDENCE.AMBIGUOUS,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: null,
      reason: 'multiple_exact_title_candidates',
      scored,
      rejected,
      margin,
    }
  }

  if (exactEvidence && durationStrong && (top.score ?? 0) >= THRESHOLDS.EXACT_SCORE) {
    if (
      second &&
      (second.score ?? 0) >= THRESHOLDS.EXACT_SCORE &&
      margin <= THRESHOLDS.AMBIGUOUS_MARGIN
    ) {
      return {
        confidence: CONFIDENCE.AMBIGUOUS,
        matcher_version: MATCHER_VERSION,
        accepted_external_id: null,
        reason: 'top_two_within_ambiguous_margin',
        scored,
        rejected,
        margin,
      }
    }
    return {
      confidence: CONFIDENCE.EXACT,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: top.external_id,
      reason: 'exact_identity_with_duration_agreement',
      accepted: top,
      scored,
      rejected,
      margin,
    }
  }

  const strongSoft =
    top.title_kind === 'base_match' ||
    top.title_kind === 'containment' ||
    top.title_kind === 'token_overlap_high'

  if (
    exactEvidence &&
    top.duration_category === 'unknown' &&
    canonical.album &&
    top.evidence?.album_hit &&
    (top.score ?? 0) >= THRESHOLDS.EXACT_SCORE
  ) {
    return {
      confidence: CONFIDENCE.EXACT,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: top.external_id,
      reason: 'exact_identity_duration_unknown_album_corroborated',
      accepted: top,
      scored,
      rejected,
      margin,
    }
  }

  if (
    (exactEvidence || strongSoft) &&
    durationOk &&
    (top.score ?? 0) >= THRESHOLDS.HIGH_SCORE &&
    (!second || margin >= THRESHOLDS.HIGH_MARGIN)
  ) {
    return {
      confidence: CONFIDENCE.HIGH_CONFIDENCE,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: top.external_id,
      reason: exactEvidence
        ? 'exact_identity_duration_not_near'
        : 'strong_corroborated_identity',
      accepted: top,
      scored,
      rejected,
      margin,
    }
  }

  if (second && margin <= THRESHOLDS.AMBIGUOUS_MARGIN) {
    return {
      confidence: CONFIDENCE.AMBIGUOUS,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: null,
      reason: 'top_two_within_ambiguous_margin',
      scored,
      rejected,
      margin,
    }
  }

  if (
    (top.score ?? 0) >= THRESHOLDS.HIGH_SCORE &&
    durationOk &&
    (exactEvidence || strongSoft)
  ) {
    return {
      confidence: CONFIDENCE.HIGH_CONFIDENCE,
      matcher_version: MATCHER_VERSION,
      accepted_external_id: top.external_id,
      reason: 'strong_corroborated_identity',
      accepted: top,
      scored,
      rejected,
      margin,
    }
  }

  return {
    confidence: CONFIDENCE.NO_MATCH,
    matcher_version: MATCHER_VERSION,
    accepted_external_id: null,
    reason: `no_candidate_reached_threshold(top_score=${top.score ?? 0})`,
    accepted: null,
    scored,
    rejected,
    margin,
  }
}

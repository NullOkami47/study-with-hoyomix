import { normalizeTitle } from '../../../src/shared/chkszMatcher'
import { sameVersionFamily } from '../../../src/shared/versionSignature'
import { canonicalId, relationId, validDate } from '../validation'
import type { CatalogueSnapshot } from '../types'
import type {
  ClassificationSuggestion,
  Discovery,
  DiscoveryManifest,
} from './types'
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 500): v is string =>
  typeof v === 'string' &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v)
const strings = (v: unknown, max = 100): v is string[] =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((x) => text(x, 1000)) &&
  new Set(v).size === v.length
const allowed = (v: unknown, values: string[], max = 100): v is string[] =>
  strings(v, max) && v.every((x) => values.includes(x))
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).every((k) => names.includes(k))
export function assertSafeDiscovery(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafeDiscovery)
    return
  }
  if (record(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (
        /authorization|cookies?|headers|streamingdata|credential|private.?key|api.?key/i.test(
          k,
        )
      )
        throw new Error('unsafe_discovery')
      assertSafeDiscovery(v)
    }
    return
  }
  if (typeof value === 'string') {
    if (/videoplayback|googlevideo\.com|BEGIN PRIVATE KEY/i.test(value))
      throw new Error('unsafe_discovery')
    for (const match of value.matchAll(/https?:\/\/[^\s]+/g)) {
      const url = new URL(match[0])
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((k) =>
          /^(x-amz-|x-goog-)|^(sig|signature|token|expire|expires|credential|key)$/i.test(
            k,
          ),
        )
      )
        throw new Error('unsafe_discovery')
    }
  }
}
export function parseDiscoveryManifest(value: unknown): DiscoveryManifest {
  assertSafeDiscovery(value)
  if (
    !record(value) ||
    !keys(value, ['schemaVersion', 'runId', 'discoveries']) ||
    value.schemaVersion !== 1 ||
    !text(value.runId, 120) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value.runId) ||
    !Array.isArray(value.discoveries) ||
    value.discoveries.length > 100
  )
    throw new Error('invalid_manifest')
  const discoveries = value.discoveries.map((v) => {
    if (
      !record(v) ||
      !keys(v, [
        'videoId',
        'title',
        'album',
        'games',
        'artistChannelId',
        'albumBrowseId',
        'releaseDate',
        'durationSeconds',
        'evidence',
      ]) ||
      !text(v.videoId) ||
      !/^[-_a-zA-Z0-9]{11}$/.test(v.videoId) ||
      !text(v.title) ||
      !text(v.album) ||
      !allowed(v.games, ['genshin', 'hsr', 'zzz'], 3) ||
      !v.games.length ||
      !text(v.artistChannelId, 120) ||
      !/^UC[-_a-zA-Z0-9]{22}$/.test(v.artistChannelId) ||
      !text(v.albumBrowseId, 160) ||
      !strings(v.evidence, 10) ||
      !v.evidence.length ||
      ('releaseDate' in v &&
        (!text(v.releaseDate) || !validDate(v.releaseDate))) ||
      ('durationSeconds' in v &&
        (typeof v.durationSeconds !== 'number' ||
          !Number.isFinite(v.durationSeconds) ||
          v.durationSeconds < 0 ||
          v.durationSeconds > 86400))
    )
      throw new Error('invalid_manifest')
    return v as unknown as Discovery
  })
  const seen = new Map<string, string>()
  for (const d of discoveries) {
    const serial = JSON.stringify(d)
    if (seen.has(d.videoId) && seen.get(d.videoId) !== serial)
      throw new Error('discovery_identity_conflict')
    seen.set(d.videoId, serial)
  }
  return {
    schemaVersion: 1,
    runId: value.runId,
    discoveries: [
      ...new Map(discoveries.map((d) => [d.videoId, d])).values(),
    ].sort((a, b) => a.videoId.localeCompare(b.videoId)),
  }
}
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('')
}
export async function candidateIdentity(videoId: string): Promise<string> {
  return 'hoyo-' + (await digest('youtube:' + videoId)).slice(0, 32)
}
export function classifyDeterministically(
  d: Discovery,
  trackId: string,
): ClassificationSuggestion {
  return {
    games: [...d.games],
    album: d.album,
    aliases: {},
    relation_ids: [],
    work_group_id: 'work-' + trackId,
    vocal_status: 'uncertain',
    tabs: [],
    evidence: [...d.evidence],
    reasons: [
      'Official public release metadata; listening categories and recording relationships require review.',
    ],
    confidence: 0,
    uncertainties: ['listening_review_required'],
    adapter: 'deterministic',
  }
}
export function validateSuggestion(value: unknown): ClassificationSuggestion {
  assertSafeDiscovery(value)
  if (
    !record(value) ||
    !keys(value, [
      'games',
      'album',
      'aliases',
      'relation_ids',
      'work_group_id',
      'vocal_status',
      'tabs',
      'evidence',
      'reasons',
      'confidence',
      'uncertainties',
      'adapter',
    ]) ||
    !allowed(value.games, ['genshin', 'hsr', 'zzz'], 3) ||
    !value.games.length ||
    !text(value.album) ||
    !record(value.aliases) ||
    Object.keys(value.aliases).length > 10 ||
    Object.entries(value.aliases).some(
      ([k, v]) =>
        !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(k) ||
        !strings(v, 20) ||
        v.some((x) => x.length > 500),
    ) ||
    !strings(value.relation_ids) ||
    value.relation_ids.some((x) => !relationId(x)) ||
    typeof value.work_group_id !== 'string' ||
    !canonicalId(value.work_group_id) ||
    !['instrumental', 'vocal', 'uncertain'].includes(
      String(value.vocal_status),
    ) ||
    !allowed(value.tabs, ['focus', 'sleep', 'chill'], 3) ||
    !strings(value.evidence, 10) ||
    !value.evidence.length ||
    !strings(value.reasons, 20) ||
    !value.reasons.length ||
    !strings(value.uncertainties, 20) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !['deterministic', 'gemini-spark', 'meta-muse', 'manual'].includes(
      String(value.adapter),
    )
  )
    throw new Error('invalid_classification')
  return structuredClone(value) as unknown as ClassificationSuggestion
}
export function identityConflicts(
  d: Discovery,
  snapshot: CatalogueSnapshot,
): string[] {
  return snapshot.tracks
    .filter(
      (t) =>
        normalizeTitle(t.title) === normalizeTitle(d.title) &&
        normalizeTitle(t.album) === normalizeTitle(d.album) &&
        sameVersionFamily(t.title, d.title),
    )
    .map((t) => 'possible_existing_recording:' + t.track_id)
}

/** Decimal ownership keys are lossless; provider binding strings stay unchanged. */
function neteaseIdentityKey(id: string): string {
  return 'netease:' + (/^[0-9]+$/.test(id) ? id.replace(/^0+(?=[0-9])/, '') : id)
}

/** Different resolver families can share one underlying recording ID. */
export function platformIdentity(
  provider: string,
  externalId: string,
): string | null {
  if (['youtube', 'piped', 'invidious'].includes(provider))
    return 'youtube:' + externalId
  if (
    ['chksz', 'netease'].includes(provider) &&
    /^[0-9]{1,20}$/.test(externalId)
  )
    return neteaseIdentityKey(externalId)
  const [platform, id] = externalId.split(':')
  if (['gd-studio', 'meting', 'lx-huibq', 'lx-ikun'].includes(provider) && id) {
    if (['netease', 'wy'].includes(platform)) return neteaseIdentityKey(id)
    if (['tencent', 'tx'].includes(platform)) return 'tencent:' + id
  }
  return null
}

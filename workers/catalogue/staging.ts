import type { CatalogueSnapshot, StagedTrack, StagedSource, StagingData, StageError } from './types'
import { SHEET_LIMITS, type Workbook, type SheetTab } from './googleSheets'
import { canonicalId, relationId, validConfidence, validDate, validSourceId } from './validation'
import { isStagingReviewStatus, needsClassification } from '../../src/shared/reviewStatus'
export const SHEET_HEADERS = {
  Tracks: [
    'track_id',
    'title',
    'game',
    'album',
    'release_date',
    'work_group_id',
    'relation_ids',
    'vocal_status',
    'focus',
    'sleep',
    'chill',
    'metadata_confidence',
    'review_status',
    'evidence',
    'notes',
  ],
  Sources: [
    'source_row_id',
    'track_id',
    'provider',
    'external_id',
    'source_type',
    'source_status',
    'source_confidence',
    'rights_status',
    'evidence',
    'notes',
  ],
  Aliases: ['track_id', 'locale', 'alias'],
  Instructions: ['instructions'],
}
export const WORKBOOK_INSTRUCTIONS = [
  'STAGING ONLY: edits never publish D1; an authenticated Admin must review and explicitly publish.',
  'FOCUS and VOCAL STATUS are independent: a focus track may be instrumental or vocal.',
  'SLEEP: calm and low intensity; avoid strong percussion, abrupt transitions and dramatic crescendos.',
  'CHILL: relaxed casual listening; vocals allowed. ALL is not a stored tag.',
  'IDENTITY: same recording across providers shares one canonical track_id. Distinct remixes/live/instrumental/alternate recordings get separate IDs.',
  'Never rename published track_id or move a source to another track. Missing rows are not deletions.',
  'Never invent provider IDs or R2 paths. New provider mappings require evidence and confidence.',
  'Never infer owner-authorised R2 rights. Trusted owner verification is required outside this import workflow.',
  'Use stable work_group_id and comma-separated canonical game and relation IDs.',
  'Confidence is a number from 0 to 1. Boolean fields use TRUE or FALSE. Existing sources remain unless explicitly reviewed.',
  'ChatGPT/Gemini may propose staging edits only, without Admin cookies or production database credentials.',
]
const blank = (v: string) => v || null
const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
export function parseStaging(book: Workbook, published: CatalogueSnapshot): StagingData {
  const result: StagingData = { tracks: [], sources: [], aliases: [], errors: [] }
  function rows(tab: SheetTab): Record<string, string>[] {
    const values = book[tab],
      limit = SHEET_LIMITS[tab],
      headers = SHEET_HEADERS[tab]
    if (
      !Array.isArray(values) ||
      values.length > limit.rows ||
      values.some(
        (row) =>
          !Array.isArray(row) ||
          row.length > limit.columns ||
          row.some(
            (c) =>
              typeof c !== 'string' ||
              c.length > 4000 ||
              /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(c),
          ),
      )
    )
      throw new Error('staging_invalid')
    if (tab === 'Instructions') return []
    if (JSON.stringify(values[0]) !== JSON.stringify(headers)) throw new Error('staging_invalid')
    return values
      .slice(1)
      .filter((row) => row.some((c) => c.trim()))
      .map((row) => Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? '').trim()])))
  }
  const trackRows = rows('Tracks'),
    sourceRows = rows('Sources'),
    aliasRows = rows('Aliases')
  rows('Instructions')
  const error = (
    entityType: StageError['entityType'],
    key: string,
    code: string,
    conflict = false,
  ) => result.errors.push({ entityType, key, code, ...(conflict ? { conflict: true } : {}) })
  const seenTracks = new Set<string>()
  for (const r of trackRows) {
    const key = r.track_id || 'row-' + result.tracks.length
    if (!canonicalId(r.track_id) || seenTracks.has(r.track_id))
      error('track', key, 'invalid_or_duplicate_track_id')
    seenTracks.add(r.track_id)
    if (
      !r.title ||
      r.title.length > 500 ||
      !canonicalId(r.work_group_id) ||
      !validDate(r.release_date) ||
      r.album.length > 500
    )
      error('track', key, 'invalid_metadata')
    const games = list(r.game),
      relations = list(r.relation_ids)
    if (
      !games.length ||
      new Set(games).size !== games.length ||
      games.some((g) => !['genshin', 'hsr', 'zzz'].includes(g)) ||
      relations.length > 100 ||
      new Set(relations).size !== relations.length ||
      relations.some((id) => !relationId(id))
    )
      error('track', key, 'invalid_games_or_relations')
    if (
      !['instrumental', 'vocal', 'uncertain'].includes(r.vocal_status) ||
      ['focus', 'sleep', 'chill'].some((k) => !['true', 'false'].includes(r[k].toLowerCase()))
    )
      error('track', key, 'invalid_classification')
    // `focus` and `vocal_status` are independent dimensions: a focus track may be instrumental
    // or vocal. The former `focus_requires_instrumental` rule rejected 389 legitimate rows that
    // are already published, so it must not block an admin from saving such a track either.
    if (
      !validConfidence(r.metadata_confidence) ||
      !isStagingReviewStatus(r.review_status)
    )
      error('track', key, 'invalid_review_metadata')
    result.tracks.push({
      track_id: r.track_id,
      title: r.title,
      album: blank(r.album),
      release_date: blank(r.release_date),
      work_group_id: r.work_group_id,
      games: games as StagedTrack['games'],
      relations,
      vocal_status: r.vocal_status as StagedTrack['vocal_status'],
      focus: Number(r.focus.toLowerCase() === 'true'),
      sleep: Number(r.sleep.toLowerCase() === 'true'),
      chill: Number(r.chill.toLowerCase() === 'true'),
      needs_classification: Number(needsClassification(r.vocal_status, r.review_status)),
      metadata_confidence: r.metadata_confidence === '' ? null : Number(r.metadata_confidence),
      evidence: blank(r.evidence),
      notes: blank(r.notes),
    })
  }
  const knownTracks = new Set([
    ...published.tracks.map((t) => t.track_id),
    ...result.tracks.map((t) => t.track_id),
  ])
  const seenSources = new Set<string>(),
    bindings = new Set<string>(),
    trackProviders = new Set<string>()
  for (const r of sourceRows) {
    const key = r.source_row_id || 'row-' + result.sources.length,
      binding = r.provider + ':' + r.external_id,
      trackProvider = r.track_id + ':' + r.provider
    if (
      !canonicalId(r.source_row_id) ||
      seenSources.has(r.source_row_id) ||
      bindings.has(binding) ||
      trackProviders.has(trackProvider)
    )
      error('source', key, 'duplicate_or_invalid_source_identity')
    seenSources.add(r.source_row_id)
    bindings.add(binding)
    trackProviders.add(trackProvider)
    if (!knownTracks.has(r.track_id)) error('source', key, 'unknown_track')
    if (
      !validSourceId(r.provider, r.external_id) ||
      r.source_type !== 'audio' ||
      !['active', 'disabled'].includes(r.source_status) ||
      !['unverified', 'owner-authorised', 'public', 'licensed'].includes(r.rights_status) ||
      !validConfidence(r.source_confidence)
    )
      error('source', key, 'invalid_source')
    const existing = published.sources.find((s) => s.source_row_id === r.source_row_id)
    const owner = published.sources.find(
      (s) => s.provider === r.provider && s.external_id === r.external_id,
    )
    if (
      (owner && owner.track_id !== r.track_id) ||
      (existing && (existing.track_id !== r.track_id || existing.provider !== r.provider)) ||
      (owner && owner.source_row_id !== r.source_row_id)
    )
      error('source', key, 'source_identity_conflict', true)
    const unchanged =
      !!existing &&
      existing.provider === r.provider &&
      existing.external_id === r.external_id &&
      existing.track_id === r.track_id
    if (!unchanged && (!r.evidence || r.source_confidence === ''))
      error('source', key, 'source_evidence_required')
    if (r.provider === 'r2' && (!unchanged || existing!.rights_status !== r.rights_status))
      error('source', key, 'r2_owner_verification_required')
    result.sources.push({
      source_row_id: r.source_row_id,
      track_id: r.track_id,
      provider: r.provider,
      external_id: r.external_id,
      source_type: r.source_type,
      source_status: r.source_status as StagedSource['source_status'],
      source_confidence: r.source_confidence === '' ? null : Number(r.source_confidence),
      rights_status: r.rights_status,
      metadata_json: unchanged ? existing!.metadata_json : '{}',
      evidence: blank(r.evidence),
      notes: blank(r.notes),
    })
  }
  const seenAliases = new Set<string>()
  for (const r of aliasRows) {
    const key = r.track_id + ':' + r.locale + ':' + r.alias
    if (
      !knownTracks.has(r.track_id) ||
      !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(r.locale) ||
      !r.alias ||
      r.alias.length > 500 ||
      seenAliases.has(key)
    )
      error('alias', key, 'invalid_or_duplicate_alias')
    seenAliases.add(key)
    result.aliases.push({ track_id: r.track_id, locale: r.locale, alias: r.alias })
  }
  return result
}
export function exportWorkbook(snapshot: CatalogueSnapshot): Workbook {
  const value = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  // Each tab's header row is a **copy** of the shared `SHEET_HEADERS` entry, never the entry
  // itself. Returning the shared array would let a caller that mutates the workbook it was handed
  // (a staging round-trip test does exactly that) permanently rewrite the module-level headers,
  // which then makes every later `exportWorkbook`/`parseStaging` call in the same process fail.
  return {
    Tracks: [
      [...SHEET_HEADERS.Tracks],
      ...snapshot.tracks.map((t) => [
        t.track_id,
        t.title,
        snapshot.games
          .filter((g) => g.track_id === t.track_id)
          .map((g) => g.game)
          .join(','),
        value(t.album),
        value(t.release_date),
        t.work_group_id,
        snapshot.relations
          .filter((r) => r.track_id === t.track_id)
          .map((r) => r.relation_id)
          .join(','),
        t.vocal_status,
        ...[t.focus, t.sleep, t.chill].map((v) => (v ? 'TRUE' : 'FALSE')),
        value(t.metadata_confidence),
        t.needs_classification ? 'pending' : 'reviewed',
        value(t.evidence),
        value(t.notes),
      ]),
    ],
    Sources: [
      [...SHEET_HEADERS.Sources],
      ...snapshot.sources.map((s) => [
        s.source_row_id,
        s.track_id,
        s.provider,
        s.external_id,
        s.source_type,
        s.source_status,
        value(s.source_confidence),
        s.rights_status,
        value(s.evidence),
        value(s.notes),
      ]),
    ],
    Aliases: [
      [...SHEET_HEADERS.Aliases],
      ...snapshot.aliases.map((a) => [a.track_id, a.locale, a.alias]),
    ],
    Instructions: [[...SHEET_HEADERS.Instructions], ...WORKBOOK_INSTRUCTIONS.map((line) => [line])],
  }
}

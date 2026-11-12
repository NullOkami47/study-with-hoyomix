/**
 * The sheet row contract for the unattended round trip.
 *
 * Direction matters and is asymmetric on purpose:
 *
 * - `Discoveries` is Worker-authored and agent-read. It carries the provider IDs the
 *   Worker itself qualified, purely so a human or agent can see what was matched.
 *   Nothing reads a provider ID back out of the sheet.
 * - `Suggestions` is agent-authored and Worker-read. It carries classification fields
 *   only. There is deliberately no provider/external-ID column: an agent cannot assert
 *   a playback source, because an asserted ID is unverifiable. Source qualification
 *   stays in `sources.ts`, which searches and resolves against real providers.
 *
 * Both headers are compared exactly, so adding a column (for instance an attempt to
 * smuggle `external_id` into `Suggestions`) fails closed instead of being ignored.
 */
import type { GameId, TabId, VocalStatus } from '../../../src/features/catalog/types'
import { assertSafeDiscovery, candidateIdentity, digest } from './model'
import type { DiscoveryCandidate } from './types'

/**
 * Maps the sheet's free-text `agent` cell onto the suggestion adapter vocabulary. An
 * unrecognised name records as `manual` rather than being rejected: the adapter label is
 * provenance for the audit trail, not an authorisation, and every row carries the same
 * unreviewed status regardless of which agent wrote it.
 */
const AGENT_ADAPTERS = new Map<string, 'gemini-spark' | 'meta-muse'>([
  ['gemini-spark', 'gemini-spark'],
  ['gemini', 'gemini-spark'],
  ['spark', 'gemini-spark'],
  ['meta-muse', 'meta-muse'],
  ['muse', 'meta-muse'],
])

export const DISCOVERY_SHEET_HEADERS = [
  'video_id',
  'candidate_id',
  'track_id',
  'title',
  'album',
  'games',
  'release_date',
  'duration_seconds',
  'qualified_providers',
  'qualified_ids',
  'suggested_work_group_id',
  'conflicts',
  'cycle_id',
  'exported_at',
  'evidence',
  'instructions',
] as const

export const SUGGESTION_SHEET_HEADERS = [
  'video_id',
  'games',
  'album',
  'work_group_id',
  'vocal_status',
  'focus',
  'sleep',
  'chill',
  'relation_ids',
  'aliases_json',
  'reasons',
  'evidence',
  'confidence',
  'uncertainties',
  'agent',
] as const

/** Shown in the last column of every exported row, for whoever reads the tab. */
export const DISCOVERY_ROW_INSTRUCTIONS =
  'Classify this recording in the Suggestions tab, keyed by video_id. Set games, album, work_group_id, vocal_status, focus/sleep/chill (TRUE or FALSE), relation_ids, aliases_json, reasons, evidence, confidence (0-1), uncertainties, agent. Focus may be vocal. Never assert a playback or provider ID: source qualification is performed by the server and any such column is rejected.'

const BOOLEANS = new Map([
  ['TRUE', true],
  ['FALSE', false],
  ['true', true],
  ['false', false],
])

/** The classification fields handed to `validateSuggestion`, minus server-owned ones. */
export interface SuggestionFields {
  games: GameId[]
  album: string
  work_group_id: string | null
  vocal_status: VocalStatus
  tabs: TabId[]
  relation_ids: string[]
  aliases: Record<string, string[]>
  reasons: string[]
  evidence: string[]
  confidence: number
  uncertainties: string[]
}

export interface ParsedSuggestionRow {
  videoId: string
  /** Candidate identity derived server-side from `videoId`; the sheet never supplies it. */
  candidateId: string
  /**
   * Stable per-row identity for exactly-once processing. Derived from the row's content,
   * so an agent editing a row produces a new key and the corrected row is reprocessed,
   * while an untouched row is never applied twice.
   */
  rowKey: string
  fields: SuggestionFields
  /** Which agent authored the row, mapped onto the suggestion adapter vocabulary. */
  adapter: 'gemini-spark' | 'meta-muse' | 'manual'
  agent: string
}

const cell = (row: string[], index: number) => (row[index] ?? '').trim()
const list = (value: string) =>
  value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)

export function discoveryExportRow(
  candidate: DiscoveryCandidate,
  cycleId: string,
  exportedAt: number,
): string[] {
  const qualified = candidate.sources.filter((s) => s.status === 'valid')
  const row = [
    candidate.discovery.videoId,
    candidate.id,
    candidate.trackId,
    candidate.discovery.title,
    candidate.discovery.album,
    candidate.discovery.games.join(','),
    candidate.discovery.releaseDate ?? '',
    candidate.discovery.durationSeconds === undefined
      ? ''
      : String(candidate.discovery.durationSeconds),
    qualified.map((s) => s.provider).join(','),
    qualified.map((s) => s.provider + ':' + s.externalId).join(','),
    candidate.suggestion.work_group_id,
    candidate.conflicts.join(','),
    cycleId,
    new Date(exportedAt).toISOString(),
    candidate.discovery.evidence.join('\n'),
    DISCOVERY_ROW_INSTRUCTIONS,
  ]
  return row.map((v) => v.slice(0, 4000))
}

export function headerMatches(
  actual: string[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((name, i) => (actual[i] ?? '').trim() === name)
  )
}

/**
 * Parses the agent-authored tab. Throws `automation_sheet_contract` when the header is
 * not exactly as published, so an extra or renamed column can never be silently
 * reinterpreted. Individual malformed rows are rejected rather than coerced, and are
 * returned as `rejected` so the cycle can report them instead of discarding them.
 */
export async function parseSuggestionRows(rows: string[][] | undefined): Promise<{
  accepted: ParsedSuggestionRow[]
  rejected: Array<{ videoId: string; reason: string }>
}> {
  if (!rows || !rows.length) return { accepted: [], rejected: [] }
  if (!headerMatches(rows[0], SUGGESTION_SHEET_HEADERS))
    throw new Error('automation_sheet_contract')
  const accepted: ParsedSuggestionRow[] = []
  const rejected: Array<{ videoId: string; reason: string }> = []
  const counts = new Map<string, number>()
  for (const row of rows.slice(1)) {
    const id = cell(row, 0)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const row of rows.slice(1)) {
    const videoId = cell(row, 0)
    if (!videoId) continue
    const reject = (reason: string) => rejected.push({ videoId, reason })
    if (!/^[-_a-zA-Z0-9]{11}$/.test(videoId)) {
      reject('invalid_video_id')
      continue
    }
    if ((counts.get(videoId) ?? 0) > 1) {
      reject('duplicate_row')
      continue
    }
    if (row.length > SUGGESTION_SHEET_HEADERS.length) {
      reject('unexpected_columns')
      continue
    }
    try {
      assertSafeDiscovery(row)
    } catch {
      reject('unsafe_content')
      continue
    }
    const games = list(cell(row, 1))
    if (
      !games.length ||
      games.length > 3 ||
      games.some((g) => !['genshin', 'hsr', 'zzz'].includes(g))
    ) {
      reject('invalid_games')
      continue
    }
    const album = cell(row, 2)
    if (!album || album.length > 500) {
      reject('invalid_album')
      continue
    }
    const workGroupRaw = cell(row, 3)
    if (workGroupRaw && !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(workGroupRaw)) {
      reject('invalid_work_group_id')
      continue
    }
    const vocal = cell(row, 4)
    if (!['instrumental', 'vocal', 'uncertain'].includes(vocal)) {
      reject('invalid_vocal_status')
      continue
    }
    const flags = [5, 6, 7].map((i) => BOOLEANS.get(cell(row, i)))
    if (flags.some((v) => v === undefined)) {
      reject('invalid_tab_flag')
      continue
    }
    const tabs = (['focus', 'sleep', 'chill'] as const).filter(
      (_, i) => flags[i],
    )
    const relations = list(cell(row, 8))
    if (
      relations.length > 100 ||
      relations.some(
        (r) =>
          !/^(?:place|character|npc|faction|event):[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(
            r,
          ),
      )
    ) {
      reject('invalid_relation_ids')
      continue
    }
    let aliases: Record<string, string[]> = {}
    const aliasRaw = cell(row, 9)
    if (aliasRaw) {
      try {
        const parsed = JSON.parse(aliasRaw)
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length > 10
        )
          throw new Error()
        for (const [locale, values] of Object.entries(parsed)) {
          if (
            !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale) ||
            !Array.isArray(values) ||
            values.length > 20 ||
            values.some(
              (v) => typeof v !== 'string' || !v.trim() || v.length > 500,
            )
          )
            throw new Error()
        }
        aliases = parsed as Record<string, string[]>
      } catch {
        reject('invalid_aliases_json')
        continue
      }
    }
    const reasons = list(cell(row, 10))
    const evidence = list(cell(row, 11))
    if (!reasons.length || !evidence.length) {
      reject('missing_reasons_or_evidence')
      continue
    }
    if (reasons.length > 16 || evidence.length > 10) {
      reject('too_many_reasons_or_evidence')
      continue
    }
    const confidence = Number(cell(row, 12))
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      reject('invalid_confidence')
      continue
    }
    const uncertainties = list(cell(row, 13))
    if (uncertainties.length > 16) {
      reject('too_many_uncertainties')
      continue
    }
    if ((confidence < 1 || vocal === 'uncertain') && !uncertainties.length) {
      reject('uncertain_without_uncertainties')
      continue
    }
    const agent = cell(row, 14)
    if (!agent || agent.length > 120) {
      reject('invalid_agent')
      continue
    }
    accepted.push({
      videoId,
      candidateId: await candidateIdentity(videoId),
      // Content-addressed: an edited row is a new row to process, an untouched one is not.
      rowKey: await digest(
        SUGGESTION_SHEET_HEADERS.map((_, i) => cell(row, i)).join('\u001f'),
      ),
      fields: {
        games: games as GameId[],
        album,
        work_group_id: workGroupRaw || null,
        vocal_status: vocal as VocalStatus,
        tabs: [...tabs],
        relation_ids: relations,
        aliases,
        reasons,
        evidence,
        confidence,
        uncertainties,
      },
      adapter: AGENT_ADAPTERS.get(agent.toLowerCase()) ?? 'manual',
      agent,
    })
  }
  return { accepted, rejected }
}


/** Server-only provenance in the existing ledger JSON; no Sheet or D1 schema change. */
export interface DiscoveryExportIntent {
  version: 1
  row: string[]
  candidateRevision: number
}
export function discoveryExportIntent(candidate: DiscoveryCandidate, row: string[]): DiscoveryExportIntent {
  return { version: 1, row, candidateRevision: candidate.revision }
}
export function readDiscoveryExportIntent(payload: string | null): DiscoveryExportIntent | null {
  try {
    const value = JSON.parse(payload ?? 'null')
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.candidateRevision) || value.candidateRevision < 1 ||
      !Array.isArray(value.row) || value.row.length !== DISCOVERY_SHEET_HEADERS.length ||
      value.row.some((cell: unknown) => typeof cell !== 'string' || cell.length > 4000)) return null
    return value as DiscoveryExportIntent
  } catch { return null }
}
/** Legacy row arrays remain readable for reconciliation, never as approval authority. */
export function discoveryIntentRow(payload: string): string[] | null {
  const bound = readDiscoveryExportIntent(payload)
  if (bound) return bound.row
  try {
    const value = JSON.parse(payload)
    return Array.isArray(value) && value.length === DISCOVERY_SHEET_HEADERS.length &&
      value.every((cell: unknown) => typeof cell === 'string') ? value : null
  } catch { return null }
}

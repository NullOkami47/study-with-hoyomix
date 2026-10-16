import type { GameId, RelationKind, TabId, Track, TrackSource, VocalStatus } from './types'

const GAME_IDS = new Set<GameId>(['genshin', 'hsr', 'zzz'])
const TAB_IDS = new Set<TabId>(['sleep', 'focus', 'chill'])
const RELATION_KINDS = new Set<RelationKind>(['place', 'character', 'npc', 'faction', 'event'])
const VOCAL_STATUSES = new Set<VocalStatus>(['instrumental', 'vocal', 'uncertain'])
const TRACK_KEYS = new Set([
  'id',
  'title',
  'aliases',
  'games',
  'relationIds',
  'tabs',
  'workGroupId',
  'needsClassification',
  'vocalStatus',
  'sources',
  'album',
])
const SOURCE_KEYS = new Set(['provider', 'externalId', 'metadata'])

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

function fail(path: string, message: string): never {
  throw new CatalogValidationError(`${path}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'expected an object')
  return value
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'expected a non-empty string')
  }
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
  return value
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value
}

function parseUniqueStringArray(value: unknown, path: string): string[] {
  const strings = requireArray(value, path).map((item, index) =>
    requireString(item, `${path}[${index}]`),
  )

  if (new Set(strings).size !== strings.length) fail(path, 'contains duplicate values')
  return strings
}

function parseAliases(value: unknown, path: string): Record<string, string[]> {
  const aliases = requireRecord(value, path)
  const parsed: Record<string, string[]> = {}

  for (const [locale, values] of Object.entries(aliases)) {
    requireString(locale, `${path} key`)
    parsed[locale] = parseUniqueStringArray(values, `${path}.${locale}`)
  }

  return parsed
}

function parseEnumArray<T extends string>(
  value: unknown,
  allowedValues: ReadonlySet<T>,
  path: string,
): T[] {
  const values = parseUniqueStringArray(value, path)

  return values.map((item, index) => {
    if (!allowedValues.has(item as T)) fail(`${path}[${index}]`, `unknown value ${JSON.stringify(item)}`)
    return item as T
  })
}

function parseRelationIds(value: unknown, path: string): string[] {
  const relationIds = parseUniqueStringArray(value, path)

  relationIds.forEach((relationId, index) => {
    const separatorIndex = relationId.indexOf(':')
    const kind = relationId.slice(0, separatorIndex) as RelationKind
    const id = relationId.slice(separatorIndex + 1)

    if (separatorIndex <= 0 || id.trim().length === 0) {
      fail(`${path}[${index}]`, 'expected <relation-kind>:<non-empty-id>')
    }
    if (!RELATION_KINDS.has(kind)) {
      fail(`${path}[${index}]`, `unknown relation kind ${JSON.stringify(kind)}`)
    }
  })

  return relationIds
}

function parseMetadata(value: unknown, path: string): Record<string, string> {
  const metadata = requireRecord(value, path)
  const parsed: Record<string, string> = {}

  for (const [key, item] of Object.entries(metadata)) {
    requireString(key, `${path} key`)
    parsed[key] = requireString(item, `${path}.${key}`)
  }

  return parsed
}

function parseSource(value: unknown, path: string): TrackSource {
  const source = requireRecord(value, path)
  rejectUnknownKeys(source, SOURCE_KEYS, path)

  const parsed: TrackSource = {
    provider: requireString(source.provider, `${path}.provider`),
    externalId: requireString(source.externalId, `${path}.externalId`),
  }

  if (source.metadata !== undefined) {
    parsed.metadata = parseMetadata(source.metadata, `${path}.metadata`)
  }

  return parsed
}

/**
 * Album is optional display metadata, so it is parsed leniently on *emptiness* but
 * strictly on *type*.
 *
 * The column it comes from is nullable, and a blank title means "no album" rather than
 * "corrupt row". Rejecting a blank value here would fail the entire catalogue parse —
 * `parseCatalog` is all-or-nothing — and drop the client to the three-track bundled
 * slice over a missing album name. Type errors still fail loudly, because those are a
 * contract violation rather than absent data.
 */
function parseOptionalAlbum(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(path, 'expected a string')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseTrack(value: unknown, path: string): Track {
  const track = requireRecord(value, path)
  rejectUnknownKeys(track, TRACK_KEYS, path)

  const sources = requireArray(track.sources, `${path}.sources`).map((source, index) =>
    parseSource(source, `${path}.sources[${index}]`),
  )
  if (sources.length === 0) fail(`${path}.sources`, 'expected at least one provider mapping')
  const providers = sources.map((source) => source.provider)
  if (new Set(providers).size !== providers.length) {
    fail(`${path}.sources`, 'duplicate provider mapping')
  }

  const games = parseEnumArray(track.games, GAME_IDS, `${path}.games`)
  const needsClassification = requireBoolean(
    track.needsClassification,
    `${path}.needsClassification`,
  )
  if (games.length === 0 && !needsClassification) {
    fail(`${path}.needsClassification`, 'must be true when games is empty')
  }

  const tabs = parseEnumArray(track.tabs, TAB_IDS, `${path}.tabs`)
  const vocalStatus = requireString(track.vocalStatus, `${path}.vocalStatus`) as VocalStatus
  if (!VOCAL_STATUSES.has(vocalStatus)) {
    fail(`${path}.vocalStatus`, `unknown value ${JSON.stringify(vocalStatus)}`)
  }

  // `tabs` and `vocalStatus` are independent dimensions. A track tagged `focus` may legitimately
  // be instrumental *or* vocal, and an instrumental track need not be tagged `focus`.
  //
  // A former `catalog_focus_requires_instrumental` cross-field rule asserted the opposite. That
  // rule was never true of the real catalogue: 389 staging/production rows are legitimately
  // `focus = 1` with `vocal_status = 'vocal'`. Because `parseCatalog` is all-or-nothing, the
  // rule rejected the entire catalogue and dropped the client to the three-track bundled slice.
  //
  // Both dimensions remain validated independently above — unknown tab ids and unknown
  // vocalStatus values are still hard failures — so removing the cross-field dependency does not
  // weaken enum, required-field or unknown-key validation.

  const parsed: Track = {
    id: requireString(track.id, `${path}.id`),
    title: requireString(track.title, `${path}.title`),
    aliases: parseAliases(track.aliases, `${path}.aliases`),
    games,
    relationIds: parseRelationIds(track.relationIds, `${path}.relationIds`),
    tabs,
    workGroupId: requireString(track.workGroupId, `${path}.workGroupId`),
    needsClassification,
    vocalStatus,
    sources,
  }

  // Kept off the object entirely when absent, so a catalogue without albums stays
  // structurally identical to what it was before this field existed.
  const album = parseOptionalAlbum(track.album, `${path}.album`)
  if (album !== undefined) parsed.album = album

  return parsed
}

export function parseCatalog(value: unknown): Track[] {
  const tracks = requireArray(value, 'catalog').map((track, index) =>
    parseTrack(track, `catalog[${index}]`),
  )
  const ids = tracks.map((track) => track.id)
  if (new Set(ids).size !== ids.length) fail('catalog', 'contains duplicate track IDs')
  return tracks
}

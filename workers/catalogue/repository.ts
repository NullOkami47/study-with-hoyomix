import type { D1Database } from '../env'
import type { Track, TabId } from '../../src/features/catalog/types'
import { parseCatalog } from '../../src/features/catalog/schema'
import type { CatalogueSnapshot, PublishedCatalogue } from './types'
export const MAX_CATALOGUE_TRACKS = 10000
const MAX_RELATED_ROWS = 100000

export async function readCatalogueSnapshot(db: D1Database): Promise<CatalogueSnapshot> {
  const queries = [
    'SELECT revision FROM catalogue_state WHERE id=1',
    'SELECT * FROM catalogue_tracks ORDER BY track_id LIMIT 10001',
    'SELECT * FROM catalogue_track_games ORDER BY track_id,game LIMIT 100001',
    'SELECT * FROM catalogue_track_relations ORDER BY track_id,relation_id LIMIT 100001',
    'SELECT * FROM catalogue_sources ORDER BY track_id,provider LIMIT 100001',
    'SELECT * FROM catalogue_aliases ORDER BY track_id,locale,alias LIMIT 100001',
  ]
  const results = await db.batch(queries.map((sql) => db.prepare(sql)))
  if (
    results.length !== 6 ||
    results.some((r) => !r.success) ||
    results[1].results.length > MAX_CATALOGUE_TRACKS ||
    results.slice(2).some((r) => r.results.length > MAX_RELATED_ROWS)
  )
    throw new Error('catalogue_unavailable')
  const revision = results[0].results[0]?.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error('catalogue_unavailable')
  return {
    revision,
    tracks: results[1].results,
    games: results[2].results,
    relations: results[3].results,
    sources: results[4].results,
    aliases: results[5].results,
  } as unknown as CatalogueSnapshot
}

const publicMetadataKeys = new Set([
  'contentType',
  'rightsStatus',
  'ownerMappingConfirmedAt',
  'server',
  'type',
  'quality',
  'bitrate',
])
export function publicSourceMetadata(json: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(json)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([key, value]) =>
          publicMetadataKeys.has(key) && typeof value === 'string' && value.length <= 512,
      ),
    )
  } catch {
    return {}
  }
}
function group<T extends { track_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const list = map.get(row.track_id) ?? []
    list.push(row)
    map.set(row.track_id, list)
  }
  return map
}
export function projectCatalogue(snapshot: CatalogueSnapshot): PublishedCatalogue {
  const games = group(snapshot.games),
    relations = group(snapshot.relations),
    aliases = group(snapshot.aliases),
    sources = group(snapshot.sources)
  const tracks: Track[] = snapshot.tracks.map((row) => ({
    id: row.track_id,
    title: row.title,
    workGroupId: row.work_group_id,
    vocalStatus: row.vocal_status,
    needsClassification: row.needs_classification === 1,
    games: (games.get(row.track_id) ?? []).map((r) => r.game),
    relationIds: (relations.get(row.track_id) ?? []).map((r) => r.relation_id),
    tabs: (['focus', 'sleep', 'chill'] as TabId[]).filter((tab) => row[tab] === 1),
    // `catalogue_tracks.album` has always been stored; it was simply not projected, which
    // left the client with no album to browse by. Omitted rather than set to null when
    // blank, so a track without an album parses exactly as it did before the field existed.
    ...(typeof row.album === 'string' && row.album.trim().length > 0
      ? { album: row.album.trim() }
      : {}),
    aliases: Object.fromEntries(
      [...new Set((aliases.get(row.track_id) ?? []).map((a) => a.locale))].map((locale) => [
        locale,
        (aliases.get(row.track_id) ?? []).filter((a) => a.locale === locale).map((a) => a.alias),
      ]),
    ),
    sources: (sources.get(row.track_id) ?? [])
      .filter((s) => s.source_status === 'active')
      .map((s) => ({
        provider: s.provider,
        externalId: s.external_id,
        metadata: publicSourceMetadata(s.metadata_json),
      })),
  }))
  const result = { revision: String(snapshot.revision), tracks: parseCatalog(tracks) }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 10 * 1024 * 1024)
    throw new Error('catalogue_unavailable')
  return result
}
export async function readPublishedCatalogue(db: D1Database): Promise<PublishedCatalogue> {
  return projectCatalogue(await readCatalogueSnapshot(db))
}

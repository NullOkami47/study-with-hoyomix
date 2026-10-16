import type { CatalogueSnapshot, Proposal, StagedTrack, StagedSource, SourceRow } from './types'

/** Shared staging projection; callers choose the proposals, never the live writes. */
export function projectImportChanges(original: CatalogueSnapshot, changes: Proposal[], now: number) {
  const projected: CatalogueSnapshot = JSON.parse(JSON.stringify(original))
  const affected = new Set<string>(),
    newTracks = new Set<string>(),
    sourceIds = new Set<string>()
  for (const change of changes) {
    if (!change.after) throw new Error('invalid_proposal')
    const value = change.after
    if (change.entityType === 'track') {
      if (value.track_id !== change.entityKey) throw new Error('invalid_proposal')
      const data = value as unknown as StagedTrack
      let row = projected.tracks.find((t) => t.track_id === change.entityKey)
      const { games, relations, ...fields } = data
      if (change.kind === 'new_track') {
        if (row) throw new Error('invalid_proposal')
        row = { ...fields, revision: 1, created_at: now, updated_at: now, published_at: now }
        projected.tracks.push(row)
        newTracks.add(row.track_id)
      } else {
        if (!row) throw new Error('invalid_proposal')
        Object.assign(row, fields)
      }
      if (Array.isArray(games)) {
        projected.games = projected.games.filter((g) => g.track_id !== data.track_id)
        projected.games.push(...games.map((game) => ({ track_id: data.track_id, game })))
      }
      if (Array.isArray(relations)) {
        projected.relations = projected.relations.filter((r) => r.track_id !== data.track_id)
        projected.relations.push(
          ...relations.map((relation_id) => ({ track_id: data.track_id, relation_id })),
        )
      }
      affected.add(data.track_id)
    } else if (change.entityType === 'source') {
      const data = value as unknown as StagedSource
      if (data.source_row_id !== change.entityKey) throw new Error('invalid_proposal')
      const index = projected.sources.findIndex((s) => s.source_row_id === change.entityKey)
      const old = index < 0 ? undefined : projected.sources[index]
      const next: SourceRow = { ...data, created_at: old?.created_at ?? now, updated_at: now }
      if (index < 0) projected.sources.push(next)
      else projected.sources[index] = next
      affected.add(data.track_id)
      sourceIds.add(data.source_row_id)
    } else if (change.entityType === 'alias') {
      const data = value as unknown as CatalogueSnapshot['aliases'][number]
      projected.aliases.push(data)
      affected.add(data.track_id)
    } else throw new Error('invalid_proposal')
  }
  return { projected, affected, newTracks, sourceIds }
}

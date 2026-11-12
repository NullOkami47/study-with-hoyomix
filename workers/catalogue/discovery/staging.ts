import { platformIdentity } from './model'
import type { Workbook } from '../googleSheets'
import { SHEET_HEADERS } from '../staging'
import { validSourceId } from '../validation'
import type { CatalogueSnapshot } from '../types'
import type { DiscoveryAppend, DiscoveryCandidate } from './types'
export const SOURCE_CHECK_TTL_MS = 30 * 60 * 1000
export function planDiscoveryAppend(
  candidates: DiscoveryCandidate[],
  book: Workbook,
  snapshot: CatalogueSnapshot,
  now: number,
): DiscoveryAppend {
  const plan: DiscoveryAppend = { Tracks: [], Sources: [], Aliases: [] }
  for (const tab of ['Tracks', 'Sources', 'Aliases'] as const)
    if (JSON.stringify(book[tab]?.[0]) !== JSON.stringify(SHEET_HEADERS[tab]))
      throw new Error('staging_invalid')
  const trackIds = new Set([
    ...snapshot.tracks.map((t) => t.track_id),
    ...book.Tracks.slice(1).map((r) => r[0]),
  ])
  const sources = [
    ...snapshot.sources.map((s) => [
      s.source_row_id,
      s.track_id,
      s.provider,
      s.external_id,
      s.source_type,
      s.source_status,
    ]),
    ...book.Sources.slice(1),
  ]
  const aliases = new Set([
    ...snapshot.aliases.map((a) =>
      [a.track_id, a.locale, a.alias].join('\u001f'),
    ),
    ...book.Aliases.slice(1).map((a) => a.join('\u001f')),
  ])
  for (const c of candidates) {
    const s = c.suggestion
    const valid = c.sources.filter(
      (x) =>
        x.status === 'valid' &&
        [
          'chksz',
          'gd-studio',
          'youtube',
          'meting',
          'lx-huibq',
          'lx-ikun',
        ].includes(x.provider) &&
        now - x.checkedAt >= 0 &&
        now - x.checkedAt <= SOURCE_CHECK_TTL_MS &&
        validSourceId(x.provider, x.externalId) &&
        !['r2', 'jellyfin'].includes(x.provider),
    )
    if (
      !c.classificationReviewed ||
      c.conflicts.length ||
      s.uncertainties.length ||
      s.vocal_status === 'uncertain'
    )
      throw new Error('candidate_not_ready')
    if (
      !valid.some((x) =>
        ['gd-studio', 'chksz', 'lx-huibq', 'lx-ikun'].includes(x.provider),
      )
    )
      throw new Error('runtime_source_required')
    const evidence = [...s.evidence, ...c.discovery.evidence]
      .filter((x, i, a) => a.indexOf(x) === i)
      .join('\n')
      .slice(0, 3900)
    const notes = JSON.stringify({
      adapter: s.adapter,
      reasons: s.reasons,
      confidence: s.confidence,
      discovery: c.id,
    }).slice(0, 3900)
    const proposedTrack = [
      c.trackId,
      c.discovery.title,
      s.games.join(','),
      s.album,
      c.discovery.releaseDate ?? '',
      s.work_group_id,
      s.relation_ids.join(','),
      s.vocal_status,
      ...['focus', 'sleep', 'chill'].map((t) =>
        s.tabs.includes(t as any) ? 'TRUE' : 'FALSE',
      ),
      String(s.confidence),
      'reviewed',
      evidence,
      notes,
    ]
    const existingRows = book.Tracks.slice(1).filter((r) => r[0] === c.trackId)
    if (existingRows.length > 1) throw new Error('staging_identity_conflict')
    if (
      !snapshot.tracks.some((t) => t.track_id === c.trackId) &&
      existingRows.length &&
      proposedTrack.some((v, i) => v !== (existingRows[0][i] ?? ''))
    )
      throw new Error('staging_identity_conflict')
    if (!trackIds.has(c.trackId)) {
      plan.Tracks.push(proposedTrack)
      trackIds.add(c.trackId)
    }
    for (const source of valid) {
      const identity = platformIdentity(source.provider, source.externalId)
      const platformOwner = sources.find(
        (r) =>
          identity &&
          platformIdentity(r[2], r[3]) === identity &&
          r[1] !== c.trackId,
      )
      if (platformOwner) throw new Error('source_identity_conflict')
      const owner = sources.find(
        (r) => r[2] === source.provider && r[3] === source.externalId,
      )
      const binding = sources.find(
        (r) => r[1] === c.trackId && r[2] === source.provider,
      )
      if (
        (owner && owner[1] !== c.trackId) ||
        (binding && binding[3] !== source.externalId)
      )
        throw new Error('source_identity_conflict')
      if (
        sources.some(
          (r) =>
            r[1] === c.trackId &&
            r[2] === source.provider &&
            r[5] === 'disabled',
        )
      )
        throw new Error('source_disabled_in_staging')
      if (owner || binding) continue
      const id = c.id + '-' + source.provider
      const row = [
        id,
        c.trackId,
        source.provider,
        source.externalId,
        'audio',
        'active',
        String(source.confidence),
        'unverified',
        [
          evidence,
          'Verified ' +
            source.provider +
            ' ID ' +
            source.externalId +
            '; ' +
            source.reason +
            ' at ' +
            new Date(source.checkedAt).toISOString(),
        ]
          .join('\n')
          .slice(0, 4000),
        'discovery:' + c.id,
      ]
      plan.Sources.push(row)
      sources.push(row)
    }
    for (const [locale, values] of Object.entries(s.aliases))
      for (const value of values) {
        const row = [c.trackId, locale, value]
        const key = row.join('\u001f')
        if (!aliases.has(key)) {
          plan.Aliases.push(row)
          aliases.add(key)
        }
      }
  }
  if (plan.Tracks.length + plan.Sources.length + plan.Aliases.length > 150)
    throw new Error('staging_too_many_changes')
  return plan
}

import type { CatalogueSnapshot, ImportBatch, Proposal } from './types'
import { projectImportChanges } from './projection'
import { exportWorkbook, parseStaging } from './staging'

const flags = new Set(['focus', 'sleep', 'chill', 'needs_classification'])
const nullable = new Set(['album', 'release_date', 'evidence', 'notes'])
const immutable = ['track_id', 'source_row_id', 'provider', 'metadata_json']
const ownerVerificationRequired = 'r2_owner_verification_required'
const isExpectedPendingR2Blocker = (proposal: Proposal) => {
  const after = proposal.after
  return proposal.entityType === 'source' &&
    proposal.decision === 'pending' &&
    proposal.validationState === 'error' &&
    proposal.messages.length === 1 &&
    proposal.messages[0] === ownerVerificationRequired &&
    after?.provider === 'r2' &&
    typeof after.evidence === 'string' &&
    after.evidence.trim().length > 0 &&
    after.evidence.length <= 4000 &&
    typeof after.source_confidence === 'number' &&
    Number.isFinite(after.source_confidence) &&
    after.source_confidence >= 0 &&
    after.source_confidence <= 1
}

export function validateProposalEdit(
  batch: ImportBatch,
  proposal: Proposal,
  after: Record<string, unknown>,
  original: CatalogueSnapshot,
  now: number,
): Proposal {
  const previous = proposal.after
  if (!previous || proposal.entityType === 'validation') throw new Error('invalid_proposal_edit')
  const keys = Object.keys(previous)
  // Keep the server-generated field boundary (especially metadata vs classification).
  // Types are checked before workbook conversion, which would otherwise coerce input.
  if (Object.keys(after).length !== keys.length || keys.some((key) => !Object.hasOwn(after, key)))
    throw new Error('invalid_proposal_edit')
  for (const key of keys) {
    const value = after[key]
    const valid = flags.has(key)
      ? value === 0 || value === 1
      : key.endsWith('_confidence')
        ? value === null || (typeof value === 'number' && Number.isFinite(value))
        : Array.isArray(previous[key])
          ? Array.isArray(value) && value.every((v) => typeof v === 'string' && !v.includes(','))
          : typeof value === 'string' || (nullable.has(key) && value === null)
    if (!valid) throw new Error('invalid_proposal_edit')
  }
  if (
    immutable.some((key) => after[key] !== previous[key]) ||
    previous.provider === 'r2' && ['external_id', 'rights_status'].some(
      (key) => after[key] !== previous[key],
    )
  ) throw new Error('invalid_proposal_edit')

  const edited: Proposal = { ...proposal, after, decision: 'pending' }
  const changes = batch.changes
    .map((c) => c.changeId === proposal.changeId ? edited : c)
    .filter((c) => c.after && c.decision !== 'rejected')
  const { projected } = projectImportChanges(original, changes, now)
  const staged = parseStaging(exportWorkbook(projected), original)
  const expectedR2Keys = new Set(
    changes.filter(isExpectedPendingR2Blocker).map((change) => change.entityKey),
  )
  if (staged.errors.some((error) =>
    error.entityType !== 'source' ||
    error.code !== ownerVerificationRequired ||
    !expectedR2Keys.has(error.key),
  )) throw new Error('invalid_proposal_edit')
  const normalised = proposal.entityType === 'track'
    ? staged.tracks.find((t) => t.track_id === after.track_id)
    : proposal.entityType === 'source'
      ? staged.sources.find((s) => s.source_row_id === after.source_row_id)
      : staged.aliases.find((a) =>
          a.track_id === after.track_id && a.locale === String(after.locale).trim()
          && a.alias === String(after.alias).trim())
  if (!normalised) throw new Error('invalid_proposal_edit')
  edited.after = Object.fromEntries(keys.map((key) =>
    [key, (normalised as unknown as Record<string, unknown>)[key]]))
  if (proposal.entityType === 'alias') {
    edited.entityKey = [edited.after.track_id, edited.after.locale, edited.after.alias].join(':')
  }
  edited.confidence = (edited.after.metadata_confidence ?? edited.after.source_confidence
    ?? (proposal.kind === 'classification_change' ? proposal.confidence : null)) as number | null
  const keepsOwnerBlocker = proposal.entityType === 'source' &&
    expectedR2Keys.has(proposal.entityKey) &&
    staged.errors.some((error) =>
      error.entityType === 'source' &&
      error.key === proposal.entityKey &&
      error.code === ownerVerificationRequired)
  edited.validationState = keepsOwnerBlocker ? 'error' : 'valid'
  edited.messages = keepsOwnerBlocker ? [ownerVerificationRequired] : []
  return edited
}

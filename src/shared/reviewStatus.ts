/**
 * The single authoritative review-status contract for the canonical catalogue.
 *
 * Every layer that reads, writes, validates or publishes a track's review status resolves it
 * through this module: the Worker's staging parser, the D1 publisher, the catalogue generator and
 * the regression suite. Before this module existed the accepted set was written out as a literal
 * in three places, and the generator drifted to a value none of them accepted — which silently
 * marked all 3004 canonical tracks as needing classification and made the dataset unable to
 * round-trip through the Sheets staging path. One definition removes that whole failure mode.
 *
 * Provenance of the three values:
 * - `the original development notes`
 * - `the original development notes`
 * - `workers/catalogue/staging.ts` (the enforcing layer)
 *
 * `verified` is deliberately **not** a member. It was invented by the catalogue generator and is
 * not part of the contract; the canonical dataset has since been normalised onto `reviewed`.
 */

/** The canonical review statuses, in ascending order of review strength. */
export const REVIEW_STATUSES = ['pending', 'reviewed', 'approved'] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * The statuses that mean "a reviewer has signed this row off", and therefore that the row does not
 * need classification on the strength of its review status alone.
 *
 * Exported as a set-like tuple so both the Worker and the publisher test membership against the
 * same list rather than each spelling it out.
 */
export const REVIEWED_REVIEW_STATUSES = ['reviewed', 'approved'] as const

/**
 * What the Google Sheets staging sheet may contain in the `review_status` cell.
 *
 * A blank cell is accepted and means "not stated", which is distinct from `pending`: the sheet is
 * a human surface where an untouched cell must not be reported as a malformed one. A blank cell
 * still resolves to needing classification, exactly like `pending`.
 */
export const STAGING_REVIEW_STATUSES = ['pending', 'reviewed', 'approved', ''] as const

const REVIEW_STATUS_SET: ReadonlySet<unknown> = new Set(REVIEW_STATUSES)
const REVIEWED_REVIEW_STATUS_SET: ReadonlySet<unknown> = new Set(REVIEWED_REVIEW_STATUSES)
const STAGING_REVIEW_STATUS_SET: ReadonlySet<unknown> = new Set(STAGING_REVIEW_STATUSES)

/** True when `value` is one of the canonical review statuses. */
export function isReviewStatus(value: unknown): value is ReviewStatus {
  return REVIEW_STATUS_SET.has(value)
}

/**
 * True when `value` is acceptable in a staging sheet cell.
 *
 * Wider than {@link isReviewStatus} by exactly one value — the empty string — so a staging-only
 * allowance can never be mistaken for a canonical one.
 */
export function isStagingReviewStatus(value: unknown): boolean {
  return STAGING_REVIEW_STATUS_SET.has(value)
}

/** True when `value` means the row has been signed off. */
export function isReviewedStatus(value: unknown): boolean {
  return REVIEWED_REVIEW_STATUS_SET.has(value)
}

/**
 * Whether a track must still be shown as needing classification.
 *
 * Two independent reasons, mirroring `workers/catalogue/staging.ts` and
 * `scripts/publish-catalogue-to-d1.mjs`:
 *
 * 1. the vocal status is explicitly `uncertain`, or
 * 2. the review status is not one that counts as signed off.
 *
 * An absent or unrecognised review status is treated as **not** signed off, so an unknown value
 * fails safe towards surfacing the row for review rather than silently hiding it.
 */
export function needsClassification(vocalStatus: unknown, reviewStatus: unknown): boolean {
  return vocalStatus === 'uncertain' || !isReviewedStatus(reviewStatus)
}

/**
 * Human-readable description of the accepted set, for error messages.
 *
 * Generated from the same array the validators use, so a diagnostic can never advertise a value
 * the code would reject.
 */
export const REVIEW_STATUS_EXPECTATION =
  `one of ${REVIEW_STATUSES.map((status) => `"${status}"`).join(', ')}`

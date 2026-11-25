import { describe, expect, it } from 'vitest'

import {
  REVIEWED_REVIEW_STATUSES,
  REVIEW_STATUSES,
  REVIEW_STATUS_EXPECTATION,
  STAGING_REVIEW_STATUSES,
  isReviewStatus,
  isReviewedStatus,
  isStagingReviewStatus,
  needsClassification,
} from './reviewStatus'

describe('canonical review-status contract', () => {
  it('accepts exactly the three contract values', () => {
    expect([...REVIEW_STATUSES]).toEqual(['pending', 'reviewed', 'approved'])
    for (const status of REVIEW_STATUSES) expect(isReviewStatus(status)).toBe(true)
  })

  it('rejects the historical leaked generator value', () => {
    // Regression: `verified` was emitted by scripts/build-catalogue.mjs but is not part of the
    // contract. Accepting it here would re-open the "all 3004 tracks need classification" defect.
    expect(isReviewStatus('verified')).toBe(false)
    expect(isReviewedStatus('verified')).toBe(false)
    expect(isStagingReviewStatus('verified')).toBe(false)
  })

  it('rejects absent, malformed and non-string values', () => {
    for (const value of [undefined, null, '', 'VERIFIED', 'Reviewed', 'approved ', 1, {}, []]) {
      expect(isReviewStatus(value)).toBe(false)
    }
  })

  it('widens the staging set by exactly the blank cell', () => {
    expect([...STAGING_REVIEW_STATUSES]).toEqual(['pending', 'reviewed', 'approved', ''])
    expect(isStagingReviewStatus('')).toBe(true)
    expect(isReviewStatus('')).toBe(false)
    for (const status of REVIEW_STATUSES) expect(isStagingReviewStatus(status)).toBe(true)
  })

  it('counts only reviewed and approved as signed off', () => {
    expect([...REVIEWED_REVIEW_STATUSES]).toEqual(['reviewed', 'approved'])
    expect(isReviewedStatus('reviewed')).toBe(true)
    expect(isReviewedStatus('approved')).toBe(true)
    expect(isReviewedStatus('pending')).toBe(false)
  })

  it('derives needs-classification from the vocal status or the review status', () => {
    expect(needsClassification('instrumental', 'reviewed')).toBe(false)
    expect(needsClassification('vocal', 'approved')).toBe(false)
    expect(needsClassification('instrumental', 'pending')).toBe(true)
    expect(needsClassification('vocal', 'approved')).toBe(false)
    // An uncertain vocal status always needs classification, whatever the review status says.
    expect(needsClassification('uncertain', 'reviewed')).toBe(true)
    expect(needsClassification('uncertain', 'approved')).toBe(true)
    // Unknown values fail safe towards surfacing the row.
    expect(needsClassification('instrumental', 'verified')).toBe(true)
    expect(needsClassification('instrumental', undefined)).toBe(true)
    expect(needsClassification('instrumental', '')).toBe(true)
  })

  it('advertises only values the validators accept', () => {
    for (const status of REVIEW_STATUSES) {
      expect(REVIEW_STATUS_EXPECTATION).toContain(`"${status}"`)
    }
    expect(REVIEW_STATUS_EXPECTATION).not.toContain('verified')
  })
})

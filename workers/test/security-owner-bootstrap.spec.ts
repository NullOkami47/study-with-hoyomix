import { describe, expect, it } from 'vitest'
import { initialRoleForIdentity } from '../auth/ownerBootstrap'

describe('owner bootstrap security', () => {
  const OWNER_PROVIDER = 'github'
  const OWNER_SUBJECT = 'immutable-subject-id-12345'

  it('grants owner when provider and subject both match exactly', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('owner')
  })

  it('denies owner when provider matches but subject differs', () => {
    const role = initialRoleForIdentity('github', 'different-subject', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner when subject matches but provider differs', () => {
    const role = initialRoleForIdentity('google', 'immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner when both provider and subject differ', () => {
    const role = initialRoleForIdentity('google', 'different-subject', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner when OWNER_PROVIDER is not configured', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345', undefined, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner when OWNER_SUBJECT is not configured', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345', OWNER_PROVIDER, undefined)
    expect(role).toBe('user')
  })

  it('denies owner when neither OWNER_PROVIDER nor OWNER_SUBJECT are configured', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345', undefined, undefined)
    expect(role).toBe('user')
  })

  it('rejects subject with different case (case-sensitive comparison)', () => {
    const role = initialRoleForIdentity('github', 'IMMUTABLE-SUBJECT-ID-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects provider with different case', () => {
    const role = initialRoleForIdentity('GitHub' as 'github', 'immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects subject with leading whitespace', () => {
    const role = initialRoleForIdentity('github', ' immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects subject with trailing whitespace', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345 ', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects subject with internal whitespace variations', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id- 12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects substring prefix match', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-1234', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects substring suffix match', () => {
    const role = initialRoleForIdentity('github', 'mmutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects substring infix match', () => {
    const role = initialRoleForIdentity('github', 'subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects numeric subject when configured subject is string', () => {
    const role = initialRoleForIdentity('github', '12345', 'github', '12345')
    expect(role).toBe('owner') // baseline: exact string match works
    const rejected = initialRoleForIdentity('github', 12345 as unknown as string, 'github', '12345')
    expect(rejected).toBe('user')
  })

  it('rejects empty string subject', () => {
    const role = initialRoleForIdentity('github', '', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('rejects empty string provider', () => {
    const role = initialRoleForIdentity('' as 'github', 'immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('never bootstraps a new Google Owner even when configured for google', () => {
    const role = initialRoleForIdentity('google', 'google-oauth-sub-67890', 'google', 'google-oauth-sub-67890')
    expect(role).toBe('user')
  })

  it('denies owner when swapping github and google providers', () => {
    const githubRole = initialRoleForIdentity('github', 'google-oauth-sub-67890', 'google', 'google-oauth-sub-67890')
    const googleRole = initialRoleForIdentity('google', 'github-id-12345', 'github', 'github-id-12345')
    expect(githubRole).toBe('user')
    expect(googleRole).toBe('user')
  })

  it('denies owner when subject contains Unicode lookalike characters', () => {
    // Cyrillic 'a' (U+0430) looks like Latin 'a' (U+0061)
    const role = initialRoleForIdentity('github', 'immutаble-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner when subject uses URL encoding', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id%2D12345', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('denies owner with null bytes in subject', () => {
    const role = initialRoleForIdentity('github', 'immutable-subject-id-12345\x00', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('never grants owner based on matching display name', () => {
    // This test documents that displayName is NOT used for owner bootstrap
    // The function signature only accepts (provider, subject, configProvider, configSubject)
    // displayName is a mutable profile field and must never grant owner privileges
    const roleWithCorrectSubject = initialRoleForIdentity('github', 'immutable-subject-id-12345', OWNER_PROVIDER, OWNER_SUBJECT)
    const roleWithWrongSubject = initialRoleForIdentity('github', 'attacker-subject', OWNER_PROVIDER, OWNER_SUBJECT)

    expect(roleWithCorrectSubject).toBe('owner')
    expect(roleWithWrongSubject).toBe('user')
    // Even if attacker has same displayName, they cannot become owner
  })

  it('never grants owner based on matching email', () => {
    // This test documents that email is NOT used for owner bootstrap
    // Email is a mutable profile field controlled by the OAuth provider
    const role = initialRoleForIdentity('github', 'attacker-subject-with-target-email', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })

  it('never grants owner based on matching login/username', () => {
    // This test documents that login/username is NOT used for owner bootstrap
    // Username can be changed on the provider and is not immutable
    const role = initialRoleForIdentity('github', 'attacker-subject-with-target-username', OWNER_PROVIDER, OWNER_SUBJECT)
    expect(role).toBe('user')
  })
})

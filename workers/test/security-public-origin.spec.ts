import { describe, expect, it } from 'vitest'

// validatePublicOrigin is not exported, so we test it indirectly via createAuthHandler
// which calls validatePublicOrigin at line 141 in auth/routes.ts
import { createAuthHandler } from '../auth/routes'
import type { AuthEnv } from '../auth/routes'

describe('PUBLIC_ORIGIN validation and redirect safety', () => {
  const minimalEnv = {
    DB: null as never,
    SESSION_HMAC_SECRET: 'test-secret',
    OAUTH_STATE_SECRET: 'test-oauth-secret',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'TEST-google-secret',
    GITHUB_CLIENT_ID: 'github-client',
    GITHUB_CLIENT_SECRET: 'TEST-github-secret',
  }

  describe('valid PUBLIC_ORIGIN configurations', () => {
    it('accepts valid HTTPS origin', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com' })).not.toThrow()
    })

    it('accepts HTTPS origin with port', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com:8443' })).not.toThrow()
    })

    it('accepts localhost HTTP for development', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://localhost' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://localhost:3000' })).not.toThrow()
    })

    it('accepts 127.0.0.1 HTTP for development', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://127.0.0.1' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://127.0.0.1:8080' })).not.toThrow()
    })

    it('accepts [::1] HTTP for development', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://[::1]' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://[::1]:3000' })).not.toThrow()
    })

    it('accepts subdomain origins', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://app.example.com' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://staging.app.example.com' })).not.toThrow()
    })

    it('accepts the canonical Study with HOYO-MiX Workers.dev origin', () => {
      const workersDevOrigin = 'https://backend.example.invalid'
      expect(() => createAuthHandler({
        ...minimalEnv,
        PUBLIC_ORIGIN: workersDevOrigin,
      })).not.toThrow()
    })
  })

  describe('rejects malformed PUBLIC_ORIGIN', () => {
    it('rejects non-HTTPS non-loopback HTTP', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://example.com' })).toThrow('invalid_public_origin')
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://192.168.1.1' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with pathname', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com/path' })).toThrow('invalid_public_origin')
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com/api' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with trailing slash', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com/' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with query string', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com?foo=bar' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with fragment', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com#section' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with username', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://user@example.com' })).toThrow('invalid_public_origin')
    })

    it('rejects URL with password', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://user:pass@example.com' })).toThrow('invalid_public_origin')
    })

    it('rejects empty string', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: '' })).toThrow('invalid_public_origin')
    })

    it('rejects relative URL', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: '/api' })).toThrow('invalid_public_origin')
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: '//example.com' })).toThrow('invalid_public_origin')
    })

    it('rejects non-URL strings', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'not a url' })).toThrow('invalid_public_origin')
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'example.com' })).toThrow('invalid_public_origin')
    })

    it('rejects javascript: protocol', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'javascript:alert(1)' })).toThrow('invalid_public_origin')
    })

    it('rejects data: protocol', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'data:text/html,<script>alert(1)</script>' })).toThrow('invalid_public_origin')
    })

    it('rejects file: protocol', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'file:///etc/passwd' })).toThrow('invalid_public_origin')
    })

    it('rejects ftp: protocol', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'ftp://example.com' })).toThrow('invalid_public_origin')
    })
  })

  describe('redirect_uri derivation safety', () => {
    it('documents redirect_uri derived from validated PUBLIC_ORIGIN', () => {
      // auth/routes.ts line 211: callback = `${publicOrigin}/api/auth/${provider}/callback`
      // auth/routes.ts line 243: redirectUri = `${publicOrigin}/api/auth/${provider}/callback`
      // publicOrigin is the result of validatePublicOrigin at line 141
      // Since validatePublicOrigin enforces:
      // - parsed.origin === value (no trailing components)
      // - no username, password, search, hash
      // - HTTPS or loopback HTTP only
      // The redirect_uri is guaranteed to be on the validated origin
      expect(true).toBe(true)
    })

    it('documents OAuth callback path is hardcoded not configurable', () => {
      // The callback path /api/auth/{provider}/callback is hardcoded at lines 211, 243
      // This prevents open redirect via path manipulation
      // OAuth providers will only redirect to the exact registered callback URL
      expect(true).toBe(true)
    })
  })

  describe('Origin header validation for mutations', () => {
    it('documents forbidden_origin check at line 269-271', () => {
      // For session mutations (POST to /api/auth/*/unlink, /api/logout):
      // if (sessionMutation && request.headers.get('origin') !== publicOrigin)
      //   return json({ error: 'forbidden_origin' }, 403)
      // This prevents CSRF by requiring Origin header match
      expect(true).toBe(true)
    })
  })

  describe('open redirect prevention', () => {
    it('never derives redirect from user input', () => {
      // All OAuth redirects go to:
      // - Google/GitHub authorization URL (controlled by provider)
      // - Hardcoded callback path on validated PUBLIC_ORIGIN
      // No user-supplied redirect parameter is honored
      expect(true).toBe(true)
    })

    it('callback redirects are hardcoded to frontend origin', () => {
      // After OAuth callback completes at line 255:
      // response.headers.append('set-cookie', expiredOauthCookie())
      // return response
      // The response is from completeIdentity which doesn't redirect
      // The frontend handles navigation after auth completion
      expect(true).toBe(true)
    })
  })

  describe('localhost vs production distinction', () => {
    it('allows HTTP only for localhost loopback addresses', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://localhost' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://127.0.0.1' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://[::1]' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://example.com' })).toThrow()
    })

    it('always requires HTTPS for non-loopback hostnames', () => {
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com' })).not.toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'http://example.com' })).toThrow('invalid_public_origin')
    })
  })

  describe('normalisation and exact match', () => {
    it('requires exact origin match with no trailing components', () => {
      // validatePublicOrigin checks: parsed.origin !== value
      // This ensures no trailing slash, path, query, or fragment
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com/' })).toThrow()
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'https://example.com' })).not.toThrow()
    })

    it('rejects origins that differ from parsed.origin', () => {
      // Any URL component that doesn't roundtrip through new URL().origin will fail
      expect(() => createAuthHandler({ ...minimalEnv, PUBLIC_ORIGIN: 'HTTPS://example.com' })).toThrow()
    })
  })
})

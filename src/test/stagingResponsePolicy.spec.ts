// @vitest-environment node
import { it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildContentSecurityPolicy, buildHeadersFile, readDefaultResponsePolicyEnvironment } from '../../vite.config'

it('caches shipped background media while keeping documents revalidated', () => {
  const headers = buildHeadersFile({})
  expect(headers).toMatch(/^\/backgrounds\/\*\n {2}! Cache-Control\n {2}Cache-Control: public, max-age=604800, stale-while-revalidate=86400$/m)
  expect(headers).toMatch(/^\/\*\n(?: {2}.+\n)* {2}Cache-Control: no-cache$/m)
})

it('builds staging CSP only from explicit inputs and ignores local operator files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-policy-'))
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  try {
    fs.writeFileSync(path.join(root, 'wrangler.remote.toml'), '[vars]\nR2_BASE_URL="https://production.example.com/"\n')
    fs.writeFileSync(path.join(root, 'wrangler.staging.toml'), '[vars]\nR2_BASE_URL="https://untrusted-file.example.com/"\n')
    const inputs = {
      RESPONSE_POLICY_PUBLIC_ORIGIN: 'https://staging-app.example.com',
      RESPONSE_POLICY_R2_BASE_URL: 'https://staging.example.com/',
      LX_ALLOWED_ORIGINS: '',
    }
    const policy = buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('staging', inputs))
    expect(policy).toContain("media-src 'self' https://staging.example.com")
    expect(policy).toContain("connect-src 'self' https://staging.example.com")
    expect(policy).not.toContain('production.example.com')
    expect(policy).not.toContain('untrusted-file.example.com')
    fs.unlinkSync(path.join(root, 'wrangler.staging.toml'))
    expect(buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('staging', inputs))).toBe(policy)
    expect(() => readDefaultResponsePolicyEnvironment('staging', {})).toThrow(/RESPONSE_POLICY_PUBLIC_ORIGIN/)
    expect(() => readDefaultResponsePolicyEnvironment('staging', {
      RESPONSE_POLICY_PUBLIC_ORIGIN: inputs.RESPONSE_POLICY_PUBLIC_ORIGIN,
    })).toThrow(/RESPONSE_POLICY_R2_BASE_URL/)
  } finally {
    cwd.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

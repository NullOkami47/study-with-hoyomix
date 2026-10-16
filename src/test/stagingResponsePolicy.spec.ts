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

it('builds staging CSP from its own config rather than a production config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-policy-'))
  const restore = { ...process.env }
  delete process.env.R2_BASE_URL
  delete process.env.R2_ALLOWED_HOSTNAMES
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  try {
    fs.writeFileSync(path.join(root, 'wrangler.remote.toml'), '[vars]\nR2_BASE_URL="https://production.example.com/"\nR2_ALLOWED_HOSTNAMES="production.example.com"\n')
    fs.writeFileSync(path.join(root, 'wrangler.staging.toml'), '[vars]\nR2_BASE_URL="https://staging.example.com/"\nR2_ALLOWED_HOSTNAMES="staging.example.com"\n')
    const policy = buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('staging'))
    expect(policy).toContain("media-src 'self' https://staging.example.com")
    expect(policy).toContain("connect-src 'self' https://staging.example.com")
    expect(policy).not.toContain('production.example.com')
    fs.unlinkSync(path.join(root, 'wrangler.staging.toml'))
    expect(buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('staging'))).not.toContain('production.example.com')
  } finally {
    cwd.mockRestore()
    process.env = restore
    fs.rmSync(root, { recursive: true, force: true })
  }
})

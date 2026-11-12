// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function assetsTable(toml: string): string {
  return toml.split(/^\[assets\][^\S\r\n]*\r?\n/m)[1]?.split(/^\[/m)[0] ?? ''
}

function apiPatterns(toml: string): RegExp[] {
  const rules = assetsTable(toml).match(/^run_worker_first\s*=\s*(\[[^\r\n]*\])\s*$/m)?.[1]
  if (!rules) throw new Error('assets.run_worker_first is required')
  const globs = JSON.parse(rules) as string[]
  return globs.map(glob => new RegExp(`^${glob.split('*').map(part =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('.*')}$`))
}

const configFile = new URL('../../wrangler.toml', import.meta.url)

describe('public Worker same-origin API routing', () => {
  it('keeps the Worker API boundary ahead of the static SPA without an external proxy', () => {
    expect(existsSync(configFile), 'Public local deployment needs an explicit Worker routing boundary').toBe(true)
    const config = readFileSync(configFile, 'utf8')
    const topLevel = config.split(/^\[/m)[0]
    const assets = assetsTable(config)
    expect(topLevel).toMatch(/^main\s*=\s*"workers\/index\.ts"$/m)
    expect(assets).toMatch(/^directory\s*=\s*"\.\/dist"$/m)
    expect(assets).toMatch(/^not_found_handling\s*=\s*"single-page-application"$/m)
    expect(assets).toMatch(/^run_worker_first\s*=\s*\["\/api\/\*"\]$/m)
    expect(existsSync(new URL('../../workers/index.ts', import.meta.url))).toBe(true)
    const patterns = apiPatterns(config)
    for (const pathname of ['/api/session', '/api/auth/github/callback']) {
      expect(patterns.some(pattern => pattern.test(pathname))).toBe(true)
    }
    for (const pathname of ['/assets/app.js', '/account', '/apiculture']) {
      expect(patterns.some(pattern => pattern.test(pathname))).toBe(false)
    }
    expect(config).not.toMatch(/https?:\/\/(?!localhost)/)
  })

  it('rejects an API rule moved outside the assets table', () => {
    const config = readFileSync(configFile, 'utf8')
    const misplaced = config.replace(/^run_worker_first\s*=.*\r?\n/m, '')
      + '\n[env.fixture]\nrun_worker_first = ["/api/*"]\n'
    expect(() => apiPatterns(misplaced)).toThrow('assets.run_worker_first is required')
  })
})

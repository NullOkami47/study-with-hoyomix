import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const SELF = 'src/test/repositoryHygiene.spec.ts'
const CODE = /\.(?:[cm]?[jt]s|vue|json|toml|ya?ml|html)$/u

const filesUnder = (directory: string): string[] => {
  const absolute = resolve(root, directory)
  if (!existsSync(absolute)) return []
  return (readdirSync(absolute, { recursive: true }) as string[])
    .map(name => join(absolute, name))
    .filter(path => !path.split(sep).includes('node_modules') && statSync(path).isFile())
    .map(path => relative(root, path).split(sep).join('/'))
}
const rootFiles = () => readdirSync(root).filter(name => statSync(resolve(root, name)).isFile())
const referencing = (paths: string[], needle: string) =>
  paths.filter(path => path !== SELF && CODE.test(path) && readFileSync(resolve(root, path), 'utf8').includes(needle))
const SCAN_TIMEOUT_MS = 60_000

describe('Public repository hygiene', () => {
  it('L-14: workers/online-counter.js is absent and unreferenced', () => {
    expect(existsSync(resolve(root, 'workers/online-counter.js'))).toBe(false)
    const code = [...['workers', 'src', 'scripts', '.github'].flatMap(filesUnder), ...rootFiles()]
    expect(referencing(code, 'online-counter')).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('L-17: workers/proxyIngress.ts takes its origins from env, not tracked config or literals', () => {
    const source = readFileSync(resolve(root, 'workers/proxyIngress.ts'), 'utf8')
    expect(source).not.toMatch(/config\/production\.json/u)
    expect(source).not.toMatch(/https:\/\/[a-z0-9.-]+\.(?:vercel\.app|workers\.dev)/iu)
    expect(source).toContain('BACKEND_ORIGIN')
    expect(source).toContain('PROXY_FRONTEND_ORIGIN')
  })

  it.each([
    '.vercel/.env.preview.local', '.dev.vars', '.env.local',
    'workers/buildInfo.json', 'workers/buildInfo.ts',
    'wrangler.remote.toml', 'wrangler.staging.toml',
    'vite.config.ts.timestamp-1700000000000-abc.mjs',
  ])('L-18: git check-ignore covers %s', (path) => {
    let ignored = true
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore' })
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
      ignored = false
    }
    expect(ignored, `${path} must be ignored`).toBe(true)
  })

  it('L-18: legacy non-runtime root files are absent', () => {
    const legacy = ['GiveMeYourHeart.mjs', 'DEPLOYMENT_REPORT.md', 'ADMIN_SCROLLING_FIX.md',
      'DENSITY_REDUCTION_PLAN.md', 'STUDIO_GLASS_DEBUG.md', 'tasks_ver2.md', 'soundtrack_temp.md']
    expect(legacy.filter(name => existsSync(resolve(root, name)))).toEqual([])
  })

  it('P95-08: no file under src/ references resolveChatSheetLayout', () => {
    expect(referencing(filesUnder('src'), 'resolveChatSheetLayout')).toEqual([])
  }, SCAN_TIMEOUT_MS)
})

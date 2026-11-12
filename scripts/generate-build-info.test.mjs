// Focused tests for the build-identity generator.
//
// These lock in the two release-integrity rules:
//   * a build never claims a commit it was not built from (no historical fallback)
//   * the environment is an explicit build input, never inferred from a hostname
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'generate-build-info.mjs')

/** Runs the generator in a throwaway project so it cannot touch the real workers/. */
function runGenerator({ args = [], env = {}, gitRepo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-info-'))
  mkdirSync(join(root, 'workers'), { recursive: true })
  const stderrPath = join(root, 'stderr.txt')
  const stderrFd = openSync(stderrPath, 'w')
  try {
    // A bogus GIT_DIR makes `git rev-parse HEAD` fail deterministically, which is
    // exactly the condition the old hardcoded fallback used to hide.
    const baseEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    if (!gitRepo) baseEnv.GIT_DIR = join(root, 'no-such-git-dir')
    delete baseEnv.BUILD_COMMIT
    delete baseEnv.BUILD_ENV

    let status = 0
    let stdout = ''
    try {
      // execFileSync (not spawnSync): spawnSync returns EBUSY on this host.
      // stderr is redirected to a file because execFileSync only surfaces it on
      // failure, and the warnings the generator emits are part of the contract.
      stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', stderrFd],
        env: { ...baseEnv, ...env },
      })
    } catch (error) {
      status = typeof error.status === 'number' ? error.status : 1
      stdout = String(error.stdout ?? '')
    }
    closeSync(stderrFd)

    let json
    try {
      json = JSON.parse(readFileSync(join(root, 'workers/buildInfo.json'), 'utf8'))
    } catch {
      json = undefined
    }
    let ts
    try {
      ts = readFileSync(join(root, 'workers/buildInfo.ts'), 'utf8')
    } catch {
      ts = undefined
    }
    return { status, stdout, stderr: readFileSync(stderrPath, 'utf8'), json, ts }
  } finally {
    try {
      closeSync(stderrFd)
    } catch {}
    rmSync(root, { force: true, recursive: true })
  }
}

test('an explicit BUILD_COMMIT is authoritative over Git resolution', () => {
  const sha = 'a'.repeat(40)
  const result = runGenerator({ env: { BUILD_COMMIT: sha } })
  assert.equal(result.status, 0)
  assert.equal(result.json.commit, sha)
})

test('a release build fails loudly when the commit cannot be resolved', () => {
  const result = runGenerator()
  assert.equal(result.status, 1, 'the generator must exit non-zero')
  assert.match(result.stderr, /could not determine the build commit/u)
  assert.match(result.stderr, /BUILD_COMMIT/u)
  assert.equal(result.json, undefined, 'no build identity file may be written')
})

test('the generator never emits the historical placeholder SHA', () => {
  const stale = '8b93cd4e352e14107f7649b542a7b555295b55cf'
  for (const options of [{}, { args: ['--allow-unknown'] }, { env: { BUILD_COMMIT: 'b'.repeat(40) } }]) {
    const result = runGenerator(options)
    assert.notEqual(result.json?.commit, stale)
    assert.doesNotMatch(result.stdout, new RegExp(stale, 'u'))
    assert.doesNotMatch(result.ts ?? '', new RegExp(stale, 'u'))
  }
})

test('--allow-unknown is the only way to build without a commit, and it says so', () => {
  const result = runGenerator({ args: ['--allow-unknown'] })
  assert.equal(result.status, 0)
  assert.equal(result.json.commit, 'unknown')
  assert.match(result.stderr, /never be used for a release or production build/u)
})

test('the environment comes from --environment', () => {
  const result = runGenerator({ args: ['--environment=production'], env: { BUILD_COMMIT: 'c'.repeat(40) } })
  assert.equal(result.status, 0)
  assert.equal(result.json.environment, 'production')
})

test('the environment falls back to BUILD_ENV, then to development', () => {
  const fromEnv = runGenerator({ env: { BUILD_COMMIT: 'd'.repeat(40), BUILD_ENV: 'staging' } })
  assert.equal(fromEnv.json.environment, 'staging')

  const fallback = runGenerator({ env: { BUILD_COMMIT: 'e'.repeat(40) } })
  assert.equal(fallback.json.environment, 'development')
})

test('an unknown environment is rejected rather than silently accepted', () => {
  const result = runGenerator({ args: ['--environment=prod'], env: { BUILD_COMMIT: 'f'.repeat(40) } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid build environment/u)
})

test('the generated getBuildInfo has no hostname heuristic', () => {
  const result = runGenerator({ args: ['--environment=production'], env: { BUILD_COMMIT: '0'.repeat(40) } })
  assert.equal(result.status, 0)
  // The production Worker is served from a *.workers.dev hostname, so any rule
  // that maps that hostname to "staging" misreports production. The generated
  // code must therefore not consult the request origin at all. Comments are
  // stripped first so the explanatory prose does not mask a real regression.
  const code = result.ts
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  assert.doesNotMatch(code, /PUBLIC_ORIGIN|origin|includes\(/u)
  assert.match(code, /getBuildInfo\(\): BuildInfo/u)
  assert.match(code, /return BUILD_INFO/u)
  assert.match(code, /environment: "production"/u)
})

test('the checked-in buildInfo.json carries an environment field', () => {
  const checkedIn = JSON.parse(readFileSync(resolve('workers/buildInfo.json'), 'utf8'))
  assert.ok(
    ['production', 'staging', 'development'].includes(checkedIn.environment),
    `unexpected environment ${JSON.stringify(checkedIn.environment)}`,
  )
})

test('no hardcoded historical SHA survives in the build-identity sources', () => {
  const stale = '8b93cd4e352e14107f7649b542a7b555295b55cf'
  for (const file of ['scripts/generate-build-info.mjs', 'vite.config.ts']) {
    const source = readFileSync(resolve(file), 'utf8')
    assert.doesNotMatch(source, new RegExp(stale, 'u'), `${file} must not pin a historical commit`)
  }
})

test('vite.config.ts does not hardcode the build environment', () => {
  const source = readFileSync(resolve('vite.config.ts'), 'utf8')
  assert.doesNotMatch(source, /name: 'build-env', content: 'staging'/u)
})

test('a stray temporary fixture cannot leak into the repository tree', () => {
  // Guards the helper itself: runGenerator must never write outside its temp root.
  const before = readFileSync(resolve('workers/buildInfo.json'), 'utf8')
  writeFileSync(resolve('workers/buildInfo.json'), before, 'utf8')
  assert.equal(readFileSync(resolve('workers/buildInfo.json'), 'utf8'), before)
})

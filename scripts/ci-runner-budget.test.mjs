import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { concurrencyBudget, recordElapsed, runnerProfile, timeBudget } from './ci-runner-budget.mjs'

const SELF_HOSTED = { CI_RUNNER_PROFILE: 'self-hosted' }
const ORIGINAL = {
  realWranglerRelease: [180_000, 360_000],
  realWranglerBackgroundTransition: [90_000, 240_000],
  authCrossDeviceSync: [120_000, 300_000],
  socialAuthVisual: [120_000, 300_000],
  preferencesModuleReload: [5_000, 20_000],
}

test('raised budgets apply only to the self-hosted profile', () => {
  for (const [name, [hosted, selfHosted]] of Object.entries(ORIGINAL)) {
    assert.equal(timeBudget(name, {}), hosted, `${name} unset profile`)
    assert.equal(timeBudget(name, { CI_RUNNER_PROFILE: 'github-hosted' }), hosted, `${name} hosted`)
    assert.equal(timeBudget(name, { CI_RUNNER_PROFILE: 'Self-Hosted' }), hosted, `${name} is exact-match only`)
    assert.equal(timeBudget(name, SELF_HOSTED), selfHosted, `${name} self-hosted`)
  }
  assert.equal(runnerProfile({}), 'hosted')
  assert.equal(runnerProfile(SELF_HOSTED), 'self-hosted')
})

test('unknown budget names are rejected instead of falling back to a default', () => {
  assert.throws(() => timeBudget('toString', SELF_HOSTED), RangeError)
  assert.throws(() => timeBudget('missing', {}), RangeError)
})

test('Worker-suite concurrency is lowered only for the self-hosted profile', () => {
  assert.equal(concurrencyBudget('workerTests', {}), 3)
  assert.equal(concurrencyBudget('workerTests', { CI_RUNNER_PROFILE: 'Self-Hosted' }), 3)
  assert.equal(concurrencyBudget('workerTests', SELF_HOSTED), 2)
  assert.throws(() => concurrencyBudget('toString', SELF_HOSTED), RangeError)
  assert.throws(() => concurrencyBudget('realWranglerRelease', SELF_HOSTED), RangeError)
})

test('elapsed times are appended as JSON lines only when CI_ELAPSED_LOG is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-runner-budget-'))
  try {
    const file = join(dir, 'nested', 'elapsed.jsonl')
    recordElapsed('no log', 'socialAuthVisual', performance.now(), {})
    recordElapsed('first', 'realWranglerRelease', performance.now() - 1500, { ...SELF_HOSTED, CI_ELAPSED_LOG: file })
    recordElapsed('second', 'realWranglerRelease', performance.now(), { CI_ELAPSED_LOG: file })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map(({ label, profile, budgetMs }) => ({ label, profile, budgetMs })), [
      { label: 'first', profile: 'self-hosted', budgetMs: 360_000 },
      { label: 'second', profile: 'hosted', budgetMs: 180_000 },
    ])
    assert.ok(lines[0].elapsedMs >= 1500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

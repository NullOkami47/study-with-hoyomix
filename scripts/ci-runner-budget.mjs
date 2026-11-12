/**
 * Time budgets keyed by the CI runner profile (P95-06).
 *
 * Some tests had their budgets raised to absorb load on the one shared WSL
 * self-hosted runner. Those raised values apply only where they were needed:
 * self-hosted CI jobs set CI_RUNNER_PROFILE=self-hosted. GitHub-hosted runners
 * and local runs keep the original budget, so a genuine slowdown still fails
 * at the old limit there. Do not raise a budget again without a recorded
 * duration profile (the Vitest and Playwright JSON reports and the elapsed-time
 * log below are uploaded as CI artefacts for that purpose).
 *
 * This is the only non-test module that reads CI_RUNNER_PROFILE
 * (scripts/self-hosted-runner-policy.test.mjs, Property 34).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const BUDGETS = Object.freeze({
  // The three real-Wrangler release integration tests (chat, presence, presence continuation).
  realWranglerRelease: Object.freeze({ hosted: 180_000, selfHosted: 360_000 }),
  // Each of the two real-Wrangler background-transition dry-runs.
  realWranglerBackgroundTransition: Object.freeze({ hosted: 90_000, selfHosted: 240_000 }),
  // tests/e2e/auth.spec.ts two-device settings, backgrounds and Focus sync.
  authCrossDeviceSync: Object.freeze({ hosted: 120_000, selfHosted: 300_000 }),
  // tests/e2e/social-auth-visual.spec.ts style passes at two viewports.
  socialAuthVisual: Object.freeze({ hosted: 120_000, selfHosted: 300_000 }),
  // src/stores/preferences.spec.ts bounds tests that re-import the module graph seven times.
  preferencesModuleReload: Object.freeze({ hosted: 5_000, selfHosted: 20_000 }),
})

/**
 * Test-runner concurrency keyed by the same profile. Lowering concurrency on the
 * self-hosted runner only trades wall-clock time for memory; it never widens a
 * timeout or changes an assertion.
 */
const CONCURRENCY = Object.freeze({
  // vitest.workers.config.ts: every spec starts Miniflare (and a workerd child) from its
  // hooks. Vitest 5 runs each file in a forked Node process instead of Vitest 0.34's threads
  // in one process, so 3 forks plus their workerd children push the 4 GB WSL runner into
  // swap. On PR #100 the suite took 577 s and then 1770 s on consecutive heads, failing on a
  // different timing-sensitive test each time, the last one a workerd socket closed
  // mid-request (UND_ERR_SOCKET); the same specs pass alone on an idle host.
  workerTests: Object.freeze({ hosted: 3, selfHosted: 2 }),
})

export function runnerProfile(env = process.env) {
  return env.CI_RUNNER_PROFILE === 'self-hosted' ? 'self-hosted' : 'hosted'
}

export function timeBudget(name, env = process.env) {
  const budget = Object.hasOwn(BUDGETS, name) ? BUDGETS[name] : undefined
  if (!budget) throw new RangeError(`Unknown time budget ${JSON.stringify(name)}`)
  return runnerProfile(env) === 'self-hosted' ? budget.selfHosted : budget.hosted
}

export function concurrencyBudget(name, env = process.env) {
  const budget = Object.hasOwn(CONCURRENCY, name) ? CONCURRENCY[name] : undefined
  if (!budget) throw new RangeError(`Unknown concurrency budget ${JSON.stringify(name)}`)
  return runnerProfile(env) === 'self-hosted' ? budget.selfHosted : budget.hosted
}

/**
 * Appends one JSON line with a script test's elapsed time to the file named by
 * CI_ELAPSED_LOG. Without that variable (local runs) nothing is written.
 */
export function recordElapsed(label, budgetName, startedAt, env = process.env) {
  const file = env.CI_ELAPSED_LOG
  if (!file) return
  const elapsedMs = Math.round(performance.now() - startedAt)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({
    label, budget: budgetName, budgetMs: timeBudget(budgetName, env), profile: runnerProfile(env), elapsedMs,
    finishedAt: new Date().toISOString(),
  }) + '\n')
}

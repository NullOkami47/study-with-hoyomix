import { defineConfig } from 'vitest/config'
import { concurrencyBudget } from './scripts/ci-runner-budget.mjs'

/**
 * Concurrency is pinned deliberately instead of being derived from the host CPU count.
 *
 * Vitest defaults BOTH `maxThreads` and `minThreads` to `availableParallelism() - 1` and never
 * consults available memory. Every spec in this suite starts a Miniflare instance from a hook, and
 * most do so per test, so peak memory tracks the thread count rather than the amount of work.
 * Measured on a 12-logical-CPU host with 4 GB usable (this suite: 46 files / 1489 tests):
 *
 *   threads        result                 hook timeouts   peak node+workerd   min free RAM
 *   11 (default)   20/46 files failed     64              2824 MB              33 MB
 *    6              3/46 files failed      3              2357 MB             166 MB
 *    4              2/46 files failed      1              2561 MB             182 MB
 *    3              3/3 runs 46/46 passed  0              1617-1707 MB        358-766 MB
 *
 * 3 is therefore the largest concurrency at which this suite was reproducibly stable, and it is
 * also what the 4-vCPU CI runner already derives, so pinning it costs nothing in CI while stopping
 * the default from scaling into the measured-unstable region on hosts with more CPUs.
 *
 * Those measurements were taken with Vitest 0.34's threads pool. Vitest 5 runs each file in a
 * forked Node process (`maxWorkers`), which costs more memory per slot, so the self-hosted WSL
 * runner (4 GB) uses 2 slots while hosted runners and local runs keep 3. The value comes from the
 * CI_RUNNER_PROFILE helper; see `workerTests` in scripts/ci-runner-budget.mjs for the evidence.
 */
const workerSlots = concurrencyBudget('workerTests')
// CI sets VITEST_JSON_REPORT to keep per-test durations as a run artefact (P95-06).
const jsonReport = process.env.VITEST_JSON_REPORT

export default defineConfig({
  test: {
    environment: 'node',
    include: ['workers/test/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: workerSlots,
    ...(jsonReport ? { reporters: ['default', 'json'], outputFile: { json: jsonReport } } : {}),
  },
})

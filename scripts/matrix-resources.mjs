// Numeric-only machine diagnostics. Never serialise errors, environment or process arguments.
import os from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const REPORT = 'test-results/matrix-resource-report.json'
const LIMIT = 2701 // Initial sample plus 45 minutes at 1 Hz.
const MAX_BYTES = 8 * 1024 * 1024
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null
function procValues(path, keys) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    return Object.fromEntries(keys.map(key => {
      const line = lines.find(value => value.startsWith(`${key} `) || value.startsWith(`${key}:`))
      return [key, line ? numeric(line.trim().split(/\s+/)[1]) : null]
    }))
  } catch { return null }
}
function pressure(kind) {
  try {
    const lines = readFileSync(`/proc/pressure/${kind}`, 'utf8').trim().split('\n')
    return Object.fromEntries(['some', 'full'].map(type => {
      const line = lines.find(value => value.startsWith(`${type} `))
      const fields = Object.fromEntries((line?.split(' ').slice(1) ?? []).map(value => value.split('=')))
      return [type, line ? Object.fromEntries(['avg10', 'avg60', 'avg300', 'total'].map(key => [key, numeric(fields[key])])) : null]
    }))
  } catch { return null }
}
export function readResources({ platform = process.platform } = {}) {
  const cpuTimesMs = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  const cpus = os.cpus()
  for (const cpu of cpus) for (const key of Object.keys(cpuTimesMs)) cpuTimesMs[key] += cpu.times[key]
  const memory = platform === 'linux' ? procValues('/proc/meminfo', ['MemAvailable', 'SwapTotal', 'SwapFree']) : null
  return {
    totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    availableMemoryBytes: memory?.MemAvailable == null ? null : memory.MemAvailable * 1024,
    cpuCount: cpus.length, cpuTimesMs, loadAverage: platform === 'win32' ? null : os.loadavg(),
    linux: platform === 'linux' ? {
      memoryKiB: memory,
      vm: procValues('/proc/vmstat', ['pswpin', 'pswpout', 'pgmajfault', 'oom_kill']),
      pressure: { cpu: pressure('cpu'), memory: pressure('memory'), io: pressure('io') },
    } : null,
  }
}
export function installedVersions() {
  const versions = { node: process.version, playwright: null, engines: null }
  try {
    versions.playwright = require('@playwright/test/package.json').version
    const manifest = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'))
    const { chromium, firefox, webkit } = require('playwright-core')
    versions.engines = Object.fromEntries(Object.entries({ chromium, firefox, webkit }).map(([name, engine]) => {
      const record = manifest.browsers.find(browser => browser.name === name)
      return [name, { version: record?.browserVersion ?? null, revision: record?.revision ?? null, executablePresent: existsSync(engine.executablePath()), versionSource: 'installed-playwright-manifest' }]
    }))
  } catch { versions.error = 'version-metadata-unavailable' }
  return versions
}
export function createCollector({ maxSamples = LIMIT, read = readResources, versions = installedVersions(), setTimer = setInterval, clearTimer = clearInterval, write = value => {
  mkdirSync('test-results', { recursive: true })
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > MAX_BYTES) throw Error('report-size-limit')
  writeFileSync(REPORT, json)
} } = {}) {
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sampleIntervalMs: 1000, maxSamples: Number.isFinite(maxSamples) ? Math.min(LIMIT, Math.max(1, Math.floor(maxSamples))) : LIMIT, versions, samples: [], truncated: false }
  let stopped = false, previous = null
  function sample() {
    if (stopped) return
    if (report.samples.length >= report.maxSamples) { report.truncated = true; return }
    const timestamp = new Date().toISOString()
    try {
      const resources = read()
      const cpuDeltaMs = previous && resources.cpuTimesMs ? Object.fromEntries(Object.entries(resources.cpuTimesMs).map(([key, value]) => [key, Math.max(0, value - previous[key])])) : null
      previous = resources.cpuTimesMs
      report.samples.push({ timestamp, ...resources, cpuDeltaMs })
    } catch { report.samples.push({ timestamp, error: 'resource-read-failed' }) }
  }
  sample()
  const timer = setTimer(sample, 1000)
  timer?.unref?.()
  return { stop(outcome) {
    if (stopped) return
    stopped = true
    clearTimer(timer)
    report.endedAt = new Date().toISOString()
    report.outcome = outcome
    write(report)
  } }
}
// Observe the original runner child lifecycle without intercepting parent signals or
// taking ownership of Playwright's separate browser process groups. Hard parent
// termination can prevent this in-process collector from flushing its report.
export async function runChild({ spawnChild, collector, warn = message => console.error(message) }) {
  let outcome = { code: null, signal: null, error: null }
  try {
    outcome = await new Promise((resolve, reject) => {
      const child = spawnChild()
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal, error: null }))
    })
  } catch (error) {
    outcome.error = 'child-process-error'
    throw error
  } finally {
    try { collector?.stop(outcome) }
    catch { warn('Matrix resource report could not be written.') }
  }
  if (outcome.signal) throw new Error(`Playwright exited from signal ${outcome.signal}`)
  return outcome.code ?? 1
}

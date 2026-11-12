import { test as nodeTest } from 'node:test'
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createCollector, runChild, readResources } from './matrix-resources.mjs'

test('collector bounds samples, stops timer, flushes once and sanitises read errors', () => {
  let tick, cleared = 0, writes = 0, reads = 0, payload
  const collector = createCollector({ maxSamples: 2, versions: {}, read: () => { reads++; throw Error('SECRET host user request') }, setTimer: fn => { tick = fn; return 1 }, clearTimer: () => cleared++, write: value => { writes++; payload = value } })
  for (let index = 0; index < 10_000; index++) tick()
  collector.stop({ code: 7 }); collector.stop({ code: 0 }); tick()
  assert.equal(reads, 2); assert.equal(cleared, 1); assert.equal(writes, 1)
  assert.equal(payload.samples.length, 2); assert.equal(payload.truncated, true)
  assert.equal(payload.outcome.code, 7)
  assert.equal(payload.samples[0].error, 'resource-read-failed')
  assert.ok(!JSON.stringify(payload).includes('SECRET'))
})

test('resource read exposes unavailable Linux metrics explicitly', () => {
  const value = readResources({ platform: 'win32' })
  assert.equal(value.linux, null)
  assert.ok(value.totalMemoryBytes > 0)
  assert.ok(value.cpuTimesMs.idle >= 0)
})

for (const code of [0, 23]) {
  test(`real portable child preserves exit ${code} and report contains no inherited secret`, async () => {
    let report, cleared = 0
    const collector = createCollector({ setTimer: () => 1, clearTimer: () => cleared++, write: value => { report = value } })
    const actual = await runChild({ collector, spawnChild: () => spawn(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore', env: { ...process.env, DIAGNOSTICS_SECRET: 'unique-sensitive-marker' } }) })
    assert.equal(actual, code); assert.equal(report.outcome.code, code)
    assert.equal(cleared, 1)
    assert.ok(report.samples.length > 0)
    assert.ok(!JSON.stringify(report).includes('unique-sensitive-marker'))
  })
}

test('original exit event settles without waiting for close and flushes before returning', async () => {
  const child = new EventEmitter(); let report
  const result = runChild({ spawnChild: () => child, collector: { stop: value => { report = value } } })
  child.emit('exit', 17, null)
  assert.equal(await result, 17)
  assert.equal(report.code, 17)
})

test('original unexpected signal rejection is retained after report flush', async () => {
  const child = new EventEmitter(); let report
  const result = runChild({ spawnChild: () => child, collector: { stop: value => { report = value } } })
  child.emit('exit', null, 'SIGKILL')
  await assert.rejects(result, /Playwright exited from signal SIGKILL/)
  assert.equal(report.signal, 'SIGKILL')
})

for (const synchronous of [true, false]) {
  test(`${synchronous ? 'synchronous' : 'asynchronous'} spawn error stops collector with sanitised outcome`, async () => {
    const child = new EventEmitter(); const originalError = Error('private-spawn-detail')
    let report, cleared = 0
    const collector = createCollector({ versions: {}, read: () => ({}), setTimer: () => 1, clearTimer: () => cleared++, write: value => { report = value } })
    const result = runChild({ collector, spawnChild: () => { if (synchronous) throw originalError; return child } })
    if (!synchronous) child.emit('error', originalError)
    await assert.rejects(result, error => error === originalError)
    assert.equal(cleared, 1)
    assert.equal(report.outcome.error, 'child-process-error')
    assert.ok(!JSON.stringify(report).includes('private-spawn-detail'))
  })
}

for (const code of [0, 23]) {
  test(`report write failure warns without changing child exit ${code}`, async () => {
    const child = new EventEmitter(); const warnings = []; let cleared = 0
    const collector = createCollector({ versions: {}, read: () => ({}), setTimer: () => 1, clearTimer: () => cleared++, write: () => { throw Error('private-write-detail') } })
    const result = runChild({ spawnChild: () => child, collector, warn: value => warnings.push(value) })
    child.emit('exit', code, null)
    assert.equal(await result, code)
    assert.equal(cleared, 1)
    assert.deepEqual(warnings, ['Matrix resource report could not be written.'])
  })
}

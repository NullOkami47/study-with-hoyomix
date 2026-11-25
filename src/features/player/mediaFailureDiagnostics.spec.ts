import { afterEach, expect, it, vi } from 'vitest'
import { describeMediaFailure } from './mediaFailureDiagnostics'

afterEach(() => vi.restoreAllMocks())
it('reports the latest matching native response without exposing a temporary URL', () => {
  const element = document.createElement('audio')
  element.src = '/api/providers/gd-studio/media/track/private-ticket?token=secret'
  Object.defineProperty(element, 'error', { value: { code: 4 } })
  const entries = [{ startTime: 10, responseStatus: 206, duration: 12, workerStart: 0 },
    { startTime: 20, responseStatus: 410, duration: 4.8, workerStart: 1 }]
  const lookup = vi.fn(() => entries as unknown as PerformanceEntry[])
  const result = describeMediaFailure(element, { getEntriesByName: lookup })
  expect(result).toEqual({ classification: 'source-or-response', status: 410, requestDurationMs: 5, serviceWorkerTiming: true })
  expect(lookup).toHaveBeenCalledWith(element.src, 'resource')
  expect(JSON.stringify(result)).not.toMatch(/ticket|secret|providers|https?:/)
})
it('does not fabricate a response or a codec diagnosis when timing data is unavailable', () => {
  const element = document.createElement('audio')
  Object.defineProperty(element, 'error', { value: { code: 4 } })
  expect(describeMediaFailure(element, { getEntriesByName: () => [] })).toEqual({
    classification: 'source-or-response', status: null, requestDurationMs: null, serviceWorkerTiming: null,
  })
})
it.each([[1, 'aborted'], [2, 'network'], [3, 'decode'], [null, 'unknown']] as const)('classifies native code %s conservatively', (code, classification) => {
  const element = document.createElement('audio')
  Object.defineProperty(element, 'error', { value: code === null ? null : { code } })
  expect(describeMediaFailure(element, { getEntriesByName: () => { throw new Error('unsupported') } }).classification).toBe(classification)
})

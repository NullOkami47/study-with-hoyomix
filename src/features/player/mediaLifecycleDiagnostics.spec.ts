import { afterEach, describe, expect, it } from 'vitest'
import { recordMediaLifecycle } from './mediaLifecycleDiagnostics'
import { playbackLog } from './playbackLog'

afterEach(() => playbackLog.clear())
describe('media lifecycle diagnostic boundaries', () => {
  it('distinguishes same-path ticket revisions and replacement elements without exporting secrets', () => {
    const element = document.createElement('audio')
    element.src = 'https://media.invalid/song?ticket=first-private-value'
    recordMediaLifecycle('media.app.source.after', element, { site: 'test' })
    recordMediaLifecycle('media.native.play', element, { site: 'test' })
    element.src = 'https://media.invalid/song?ticket=second-private-value'
    recordMediaLifecycle('media.app.source.after', element, { site: 'test' })
    const replacement = document.createElement('audio')
    replacement.src = element.src
    recordMediaLifecycle('media.native.pause', replacement, { site: 'test' })
    const [first, same, renewed, replaced] = playbackLog.snapshot()
    expect(same.elementId).toBe(first.elementId)
    expect(same.sourceRevision).toBe(first.sourceRevision)
    expect(renewed.elementId).toBe(first.elementId)
    expect(renewed.sourceRevision).toBe(Number(first.sourceRevision) + 1)
    expect(replaced.elementId).not.toBe(first.elementId)
    expect(playbackLog.exportJson()).not.toMatch(/first-private|second-private|ticket=/)
  })
  it('bounds TimeRanges and tolerates inaccessible native properties', () => {
    const element = document.createElement('audio')
    Object.defineProperty(element, 'buffered', { configurable: true, value: {
      length: 1000, start: (i: number) => i * 2, end: (i: number) => i * 2 + 1,
    } })
    recordMediaLifecycle('media.native.pause', element, {})
    expect(playbackLog.snapshot().at(-1)?.buffered).toBe('0-1;2-3;4-5')
    Object.defineProperty(element, 'buffered', { get: () => { throw new Error('detached') } })
    expect(() => recordMediaLifecycle('media.native.pause', element, {})).not.toThrow()
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { debugLog } from '../player/debugLog'
import { classifySyncError, traceSync } from './syncTrace'

describe('classifySyncError', () => {
  it.each([
    [new Error('account_preferences_http_400'), 'http_400', 400],
    [new Error('background_selection_http_503'), 'http_503', 503],
    [new Error('http_500'), 'http_500', 500],
    [new DOMException('t', 'TimeoutError'), 'timeout', null],
    [new DOMException('a', 'AbortError'), 'timeout', null],
    [new TypeError('Failed to fetch'), 'network', null],
    [new Error('account_preferences_invalid_response'), 'invalid_response', null],
    [new Error('invalid_synced_user_preferences'), 'invalid_preferences', null],
    [new Error('account_session_changed'), 'account_changed', null],
    [new Error('focus_session_account_changed'), 'account_changed', null],
    [new Error('backgrounds_unavailable'), 'backgrounds_unavailable', null],
    [new Error('backgrounds_quarantined'), 'backgrounds_quarantined', null],
    [new Error('focus_session_conflict'), 'focus_conflict', null],
    [new DOMException('q', 'QuotaExceededError'), 'storage', null],
    [new Error('something with token=abc'), 'other', null],
    ['nope', 'other', null],
  ])('classifies %s', (error, errorClass, httpStatus) => {
    expect(classifySyncError(error)).toEqual({ errorClass, httpStatus })
  })

  it('does not carry the message of an unknown error', () => {
    expect(JSON.stringify(classifySyncError(new Error('user@example.com Bearer abc123')))).not.toMatch(/example|abc123/u)
  })
})

describe('traceSync', () => {
  beforeEach(() => debugLog.clear())

  it('prefixes the type and records into the debug log export', () => {
    traceSync('channel', { channel: 'preferences', ok: false, errorClass: 'http_400', httpStatus: 400, durationMs: 85 })
    const entry = debugLog.snapshot().at(-1)!
    expect(entry).toMatchObject({ type: 'sync.channel', channel: 'preferences', ok: false, errorClass: 'http_400', httpStatus: 400, durationMs: 85 })
  })

  it('keeps planted secrets out of the exported JSON', () => {
    traceSync('state', { authorization: 'Bearer SECRET-TOKEN', cookie: 'session=SECRET-COOKIE', password: 'SECRET-PW', note: 'mail a@b.example token=SECRET-QUERY' })
    const json = debugLog.exportJson()
    expect(json).not.toContain('SECRET')
    expect(json).not.toContain('a@b.example')
  })
})

import { vi } from 'vitest'

/**
 * Replaces `HTMLMediaElement.prototype.play` with a mock that rejects with
 * a `NotAllowedError` DOMException, simulating browser autoplay restrictions.
 *
 * Call {@link mockPlaySuccess} or rely on the global afterEach cleanup to
 * restore the default behaviour after the test.
 */
export function mockAutoplayRejection(): void {
  HTMLMediaElement.prototype.play = vi.fn(() =>
    Promise.reject(new DOMException('play() request was interrupted by a call to pause().', 'NotAllowedError')),
  )
}

/**
 * Replaces `HTMLMediaElement.prototype.play` with a mock that rejects with
 * an `AbortError` DOMException, simulating a load interruption (e.g. a new
 * `src` was set while the previous media was still loading).
 */
export function mockAbortError(): void {
  HTMLMediaElement.prototype.play = vi.fn(() =>
    Promise.reject(new DOMException('The play() request was interrupted because the media was removed from the document.', 'AbortError')),
  )
}

/**
 * Replaces `HTMLMediaElement.prototype.play` with a mock that rejects with
 * a generic `Error`, simulating a genuine media failure (decode error, network
 * failure, etc.).
 */
export function mockPlayFailure(): void {
  HTMLMediaElement.prototype.play = vi.fn(() =>
    Promise.reject(new Error('media playback failed')),
  )
}

/**
 * Restores `HTMLMediaElement.prototype.play` to the default mock that
 * resolves successfully.
 */
export function mockPlaySuccess(): void {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
}

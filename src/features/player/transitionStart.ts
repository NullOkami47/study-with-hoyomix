/**
 * Confirm the native transport, separately from the play command. A fulfilled promise alone
 * cannot authorise fading out another song after a queued pause, source change or media error.
 * This observer creates no audio graph and never changes volume, sources or playback itself.
 */
export function confirmTransitionStart(
  element: HTMLMediaElement,
  requestPlay: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Transition cancelled', 'AbortError'))
  const source = element.getAttribute('src')
  return new Promise((resolve, reject) => {
    let playing = false
    let permitted = false
    let done = false
    const finish = (error?: unknown) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      element.removeEventListener('playing', onPlaying)
      element.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (!playing || !permitted) return
      if (signal.aborted || !source || element.getAttribute('src') !== source ||
        element.paused || element.ended || element.error || element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        finish(new DOMException('Transition no longer playable', 'AbortError'))
      } else finish()
    }
    const onPlaying = () => { playing = true; check() }
    const onError = () => finish(new Error('Transition media failed'))
    const onAbort = () => finish(new DOMException('Transition cancelled', 'AbortError'))
    const deadline = setTimeout(() => finish(new DOMException('Transition did not start', 'TimeoutError')), 1500)
    element.addEventListener('playing', onPlaying)
    element.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      void Promise.resolve(requestPlay()).then(() => { permitted = true; check() }, finish)
    } catch (error) { finish(error) }
  })
}

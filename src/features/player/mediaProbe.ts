/**
 * Proves a media URL is actually loadable before a provider commits to it.
 *
 * Uses a detached `<audio>` element rather than `fetch`. That is not a style choice: the audio CDN
 * is allowed by `media-src` but *not* by `connect-src`, so a `fetch` probe is refused by the
 * document policy even though the element itself can play the very same URL. An earlier version of
 * this check used `fetch` and reported nine perfectly playable URLs as dead.
 *
 * The probe resolves on `loadedmetadata`, which means the element got real audio metadata — a
 * better signal than a status code, and it costs one bounded request that the player would have
 * made anyway.
 */
export const MEDIA_PROBE_TIMEOUT_MS = 10_000

export type MediaProbe = (url: string, signal?: AbortSignal) => Promise<boolean>

export function createMediaProbe(timeoutMs: number = MEDIA_PROBE_TIMEOUT_MS): MediaProbe {
  return (url, signal) =>
    new Promise<boolean>((resolve) => {
      // Outside a browser (unit tests, SSR) there is nothing to probe with, and refusing the URL
      // would make the provider untestable. Accept it; the caller's own policy checks still apply.
      if (typeof document === 'undefined' || typeof Audio === 'undefined') {
        resolve(true)
        return
      }

      const audio = new Audio()
      let settled = false

      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        audio.removeEventListener('loadedmetadata', onLoaded)
        audio.removeEventListener('error', onError)
        audio.removeAttribute('src')
        try {
          // Releasing the source cancels the in-flight metadata request instead of letting it run
          // on after we have already moved to the next source.
          audio.load()
        } catch {
          // ignore
        }
        resolve(ok)
      }

      const onLoaded = (): void => finish(true)
      const onError = (): void => finish(false)
      const onAbort = (): void => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)

      audio.preload = 'metadata'
      audio.muted = true
      audio.addEventListener('loadedmetadata', onLoaded, { once: true })
      audio.addEventListener('error', onError, { once: true })

      if (signal) {
        if (signal.aborted) {
          finish(false)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      audio.src = url
    })
}

export const probeMediaPlayable: MediaProbe = createMediaProbe()

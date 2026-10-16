const YOUTUBE_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api'
const YOUTUBE_IFRAME_API_TIMEOUT_MS = 15_000
const YOUTUBE_IFRAME_API_MAX_ATTEMPTS = 2

export interface YouTubeEvent<T> {
  data: T
}

export interface YouTubePlayerInstance {
  destroy(): void
  getIframe(): HTMLIFrameElement
  loadVideoById(videoId: string): void
  pauseVideo(): void
  playVideo(): void
  setVolume(volume: number): void
}

export interface YouTubePlayerOptions {
  events: {
    onError(event: YouTubeEvent<number>): void
    onReady(): void
    onStateChange(event: YouTubeEvent<number>): void
  }
  playerVars: {
    controls: 1
    origin: string
    playsinline: 1
  }
  videoId: string
}

export interface YouTubeApi {
  Player: new (element: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayerInstance
}

interface YouTubeWindow extends Window {
  YT?: YouTubeApi
  onYouTubeIframeAPIReady?: () => void
}

let loadingPromise: Promise<YouTubeApi> | null = null
let attempts = 0

function youtubeWindow(): YouTubeWindow {
  return window as YouTubeWindow
}

function loadedApi(target: YouTubeWindow): YouTubeApi | null {
  return target.YT?.Player ? target.YT : null
}

export function loadYouTubeIframeApi(): Promise<YouTubeApi> {
  const target = youtubeWindow()
  const loaded = loadedApi(target)
  if (loaded) return Promise.resolve(loaded)
  if (loadingPromise) return loadingPromise
  if (attempts >= YOUTUBE_IFRAME_API_MAX_ATTEMPTS) {
    return Promise.reject(new Error('YouTube IFrame API attempt limit reached'))
  }

  attempts += 1
  const attempt = new Promise<YouTubeApi>((resolve, reject) => {
    const previousReady = target.onYouTubeIframeAPIReady
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${YOUTUBE_IFRAME_API_SRC}"]`,
    )
    const script = existingScript ?? document.createElement('script')
    let settled = false

    const restoreCallback = (): void => {
      if (target.onYouTubeIframeAPIReady !== handleReady) return
      if (previousReady) target.onYouTubeIframeAPIReady = previousReady
      else Reflect.deleteProperty(target, 'onYouTubeIframeAPIReady')
    }

    const cleanup = (removeScript: boolean): void => {
      clearTimeout(timeout)
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
      restoreCallback()
      if (removeScript) script.remove()
    }

    const succeed = (api: YouTubeApi): void => {
      if (settled) return
      settled = true
      cleanup(false)
      resolve(api)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup(true)
      reject(error)
    }

    function handleReady(): void {
      if (settled) return
      try {
        previousReady?.()
      } catch {
        // Another consumer's callback cannot prevent this loader from settling.
      }
      const api = loadedApi(target)
      if (api) succeed(api)
      else fail(new Error('YouTube IFrame API initialised without Player'))
    }

    function handleLoad(): void {
      const api = loadedApi(target)
      if (api) succeed(api)
      // The official iframe_api bootstrap loads www-widgetapi.js asynchronously.
      // A successful bootstrap load is therefore not an error while Player is
      // still pending; the official callback or the bounded timeout settles us.
    }

    function handleError(): void {
      fail(new Error('Unable to load the YouTube IFrame API'))
    }

    const timeout = setTimeout(
      () => fail(new Error('YouTube IFrame API load timed out')),
      YOUTUBE_IFRAME_API_TIMEOUT_MS,
    )

    target.onYouTubeIframeAPIReady = handleReady
    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })

    if (!existingScript) {
      script.async = true
      script.src = YOUTUBE_IFRAME_API_SRC
      document.head.append(script)
    }
  })

  loadingPromise = attempt
  void attempt.then(
    () => {
      if (loadingPromise === attempt) loadingPromise = null
    },
    () => {
      if (loadingPromise === attempt) loadingPromise = null
    },
  )
  return attempt
}

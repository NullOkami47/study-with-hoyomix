import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const API_SRC = 'https://www.youtube.com/iframe_api'

function youtubeWindow(): Window & {
  YT?: { Player: new (...args: never[]) => unknown }
  onYouTubeIframeAPIReady?: () => void
} {
  return window as never
}

function installApi(): void {
  youtubeWindow().YT = { Player: class FakePlayer {} as never }
}

beforeEach(() => {
  vi.resetModules()
  document.querySelectorAll(`script[src="${API_SRC}"]`).forEach((script) => script.remove())
  Reflect.deleteProperty(youtubeWindow(), 'YT')
  Reflect.deleteProperty(youtubeWindow(), 'onYouTubeIframeAPIReady')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('YouTube IFrame API loader', () => {
  it('returns an already loaded API without adding or replacing global callbacks', async () => {
    const previousReady = vi.fn()
    youtubeWindow().onYouTubeIframeAPIReady = previousReady
    installApi()
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    await expect(loadYouTubeIframeApi()).resolves.toBe(youtubeWindow().YT)
    expect(document.querySelector(`script[src="${API_SRC}"]`)).toBeNull()
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBe(previousReady)
  })

  it('shares one loading promise and existing script across concurrent components', async () => {
    const existingScript = document.createElement('script')
    existingScript.src = API_SRC
    document.head.append(existingScript)
    const previousReady = vi.fn()
    youtubeWindow().onYouTubeIframeAPIReady = previousReady
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    const first = loadYouTubeIframeApi()
    const second = loadYouTubeIframeApi()
    expect(first).toBe(second)
    expect(document.querySelectorAll(`script[src="${API_SRC}"]`)).toHaveLength(1)

    installApi()
    youtubeWindow().onYouTubeIframeAPIReady?.()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(previousReady).toHaveBeenCalledOnce()
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBe(previousReady)
  })

  it('recognises an existing script load event and cleans up its callback', async () => {
    const existingScript = document.createElement('script')
    existingScript.src = API_SRC
    document.head.append(existingScript)
    const previousReady = vi.fn()
    youtubeWindow().onYouTubeIframeAPIReady = previousReady
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    const loading = loadYouTubeIframeApi()
    installApi()
    existingScript.dispatchEvent(new Event('load'))

    await expect(loading).resolves.toBe(youtubeWindow().YT)
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBe(previousReady)
  })

  it('waits for the official second-stage widget callback after the bootstrap script loads', async () => {
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    const loading = loadYouTubeIframeApi()
    const bootstrap = document.querySelector<HTMLScriptElement>(`script[src="${API_SRC}"]`)
    bootstrap?.dispatchEvent(new Event('load'))

    expect(bootstrap?.isConnected).toBe(true)
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBeTypeOf('function')

    installApi()
    youtubeWindow().onYouTubeIframeAPIReady?.()

    await expect(loading).resolves.toBe(youtubeWindow().YT)
  })

  it('cleans up after an error, retries once, and then fails closed at the attempt bound', async () => {
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    const first = loadYouTubeIframeApi()
    const firstScript = document.querySelector<HTMLScriptElement>(`script[src="${API_SRC}"]`)
    const staleCallback = youtubeWindow().onYouTubeIframeAPIReady
    firstScript?.dispatchEvent(new Event('error'))
    await expect(first).rejects.toThrow()
    expect(firstScript?.isConnected).toBe(false)
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBeUndefined()

    const second = loadYouTubeIframeApi()
    const secondScript = document.querySelector<HTMLScriptElement>(`script[src="${API_SRC}"]`)
    expect(secondScript).not.toBe(firstScript)
    staleCallback?.()
    expect(youtubeWindow().onYouTubeIframeAPIReady).not.toBe(staleCallback)
    secondScript?.dispatchEvent(new Event('error'))
    await expect(second).rejects.toThrow()

    await expect(loadYouTubeIframeApi()).rejects.toThrow(/attempt/i)
    expect(document.querySelector(`script[src="${API_SRC}"]`)).toBeNull()
  })

  it('times out a hanging script and removes stale global state', async () => {
    vi.useFakeTimers()
    const { loadYouTubeIframeApi } = await import('./youtubeIframeApi')

    const loading = loadYouTubeIframeApi()
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(loading).rejects.toThrow(/timed out/i)
    expect(document.querySelector(`script[src="${API_SRC}"]`)).toBeNull()
    expect(youtubeWindow().onYouTubeIframeAPIReady).toBeUndefined()
  })
})

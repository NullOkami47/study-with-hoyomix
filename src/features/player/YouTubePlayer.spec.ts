import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import YouTubePlayer from './YouTubePlayer.vue'

interface PlayerEvents {
  onError(event: { data: number }): void
  onReady(): void
  onStateChange(event: { data: number }): void
}

interface PlayerOptions {
  events: PlayerEvents
  playerVars: { controls: number; origin: string; playsinline: number }
  videoId: string
}

const destroy = vi.fn()
const loadVideoById = vi.fn()
const pauseVideo = vi.fn()
const playVideo = vi.fn()
const setVolume = vi.fn()
let options: PlayerOptions
let iframe: HTMLIFrameElement
let playerCount = 0

beforeEach(() => {
  vi.clearAllMocks()
  iframe = document.createElement('iframe')
  options = undefined as unknown as PlayerOptions
  playerCount = 0

  class FakePlayer {
    constructor(element: HTMLElement, received: PlayerOptions) {
      playerCount += 1
      options = received
      iframe.src = `https://www.youtube.com/embed/${received.videoId}`
      element.replaceWith(iframe)
    }

    destroy = destroy
    getIframe = () => iframe
    loadVideoById = loadVideoById
    pauseVideo = pauseVideo
    playVideo = playVideo
    setVolume = setVolume
  }

  Object.assign(window, { YT: { Player: FakePlayer } })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'YT')
})

describe('YouTubePlayer', () => {
  it('mounts a visible official IFrame with native controls and a descriptive title', async () => {
    const wrapper = mount(YouTubePlayer, {
      props: { title: 'HOYO-MiX official YouTube player', videoId: 'abcdefghijk' },
    })
    await flushPromises()
    options.events.onReady()

    expect(options.videoId).toBe('abcdefghijk')
    expect(options.playerVars).toMatchObject({
      controls: 1,
      origin: window.location.origin,
      playsinline: 1,
    })
    expect(wrapper.get('.youtube-player__viewport').attributes('aria-label')).toBe(
      'HOYO-MiX official YouTube player',
    )
    expect(wrapper.get('.youtube-player__viewport > iframe').attributes('title')).toBe(
      'HOYO-MiX official YouTube player',
    )
    expect(wrapper.find('.youtube-player__mount').exists()).toBe(false)
    expect(wrapper.find('[data-player-overlay]').exists()).toBe(false)
  })

  it('exposes play and pause commands and forwards ready and state events', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    options.events.onReady()
    options.events.onStateChange({ data: 1 })
    ;(wrapper.vm as unknown as { pause(): void; play(): void }).play()
    ;(wrapper.vm as unknown as { pause(): void; play(): void }).pause()

    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(wrapper.emitted('state')).toEqual([[1]])
    expect(playVideo).toHaveBeenCalledOnce()
    expect(pauseVideo).toHaveBeenCalledOnce()
  })

  it('maps the persisted 0..1 volume to the IFrame API 0..100 scale', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    ;(wrapper.vm as unknown as { setVolume(value: number): void }).setVolume(0.45)
    expect(setVolume).toHaveBeenCalledWith(45)
  })

  it('forwards official player errors without exposing media URLs', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    options.events.onError({ data: 100 })
    expect(wrapper.emitted('error')).toEqual([[100]])
  })

  it('loads a replacement videoId through the existing official player', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    await wrapper.setProps({ videoId: 'lmnopqrstuv' })
    expect(loadVideoById).toHaveBeenCalledWith('lmnopqrstuv')
  })

  it('fails closed before constructing the player for an invalid initial videoId', async () => {
    const wrapper = mount(YouTubePlayer, {
      props: { videoId: 'https://youtu.be/abcdefghijk' },
    })
    await flushPromises()

    expect(playerCount).toBe(0)
    expect(wrapper.emitted('error')).toEqual([[0]])
    expect(JSON.stringify(wrapper.emitted('error'))).not.toContain('http')
  })

  it('rejects an invalid replacement videoId without forwarding it to the IFrame', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    await wrapper.setProps({ videoId: 'invalid' })
    expect(loadVideoById).not.toHaveBeenCalled()
    expect(wrapper.emitted('error')).toEqual([[0]])
    expect(JSON.stringify(wrapper.emitted('error'))).not.toContain('invalid')
  })

  it('destroys the player and emits teardown when unmounted', async () => {
    const wrapper = mount(YouTubePlayer, { props: { videoId: 'abcdefghijk' } })
    await flushPromises()

    wrapper.unmount()
    expect(destroy).toHaveBeenCalledOnce()
    expect(wrapper.emitted('teardown')).toHaveLength(1)
  })
})

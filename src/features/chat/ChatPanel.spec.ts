import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createChatClient } from './client'
import ChatPanel from './ChatPanel.vue'
import { useAccountSession, resetAccountSession } from '../account/session'
import { usePreferences } from '../../stores/preferences'
beforeEach(() => {
  resetAccountSession()
  vi.spyOn(useAccountSession(), 'ensure').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
})
const make = () => {
  const client = createChatClient()
  vi.spyOn(client, 'start').mockImplementation(() => {})
  vi.spyOn(client, 'stop').mockImplementation(() => {})
  vi.spyOn(client, 'restart').mockImplementation(() => {})
  return client
}
describe('ChatPanel', () => {
  it.each([
    ['chat_banned', 'chat.errorBanned'],
    ['authentication_required', 'chat.errorSession'],
    ['edit_limit', 'chat.errorEditLimit'],
    ['edit_window_expired', 'chat.errorEditExpired'],
    ['invalid_text', 'chat.errorInvalid'],
  ])('explains the server refusal %s and preserves the draft', async (code, key) => {
    usePreferences().setLocale('en')
    const client = make()
    client.viewer.value = { userId: 'u', role: 'user' }
    client.state.value = 'connected'
    vi.spyOn(client, 'send').mockRejectedValue(new Error(code))
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    await wrapper.get('[data-chat-composer]').setValue('Keep this draft')
    await wrapper.get('[data-chat-send]').trigger('submit')
    await flushPromises()
    const { translate } = await import('../../i18n')
    expect(wrapper.get('[role="alert"]').text()).toBe(translate('en', key as Parameters<typeof translate>[1]))
    expect((wrapper.get('[data-chat-composer]').element as HTMLTextAreaElement).value).toBe('Keep this draft')
    wrapper.unmount()
  })
  it('shows account action for anonymous readers and releases transport on close', () => {
    usePreferences().setLocale('en')
    const client = make()
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    expect(wrapper.text()).toContain('Sign in')
    expect(wrapper.find('[data-chat-composer]').exists()).toBe(false)
    wrapper.unmount()
    expect(client.stop).toHaveBeenCalledOnce()
  })
  it('preserves composition and clears draft only after acknowledgement', async () => {
    const client = make()
    client.viewer.value = { userId: 'u', role: 'user' }
    client.state.value = 'connected'
    let resolve!: () => void
    vi.spyOn(client, 'send').mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    const input = wrapper.get('[data-chat-composer]')
    await input.setValue('你好')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(client.send).not.toHaveBeenCalled()
    await input.trigger('keydown', { key: 'Enter' })
    expect(client.send).toHaveBeenCalledOnce()
    expect((input.element as HTMLTextAreaElement).value).toBe('你好')
    resolve()
    await flushPromises()
    expect((input.element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })
})

it('preserves the history scroll anchor and does not follow live messages while reading', async () => {
  let receive!: WebSocket['onmessage']
  const socket = {
    onmessage: null as WebSocket['onmessage'],
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  }
  const client = createChatClient({
    socket: () => socket,
    request: async () => Response.json({ messages: [], nextCursor: null }),
  })
  const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
  receive = socket.onmessage
  receive?.call(
    socket as unknown as WebSocket,
    new MessageEvent('message', {
      data: JSON.stringify({
        type: 'snapshot',
        messages: [],
        nextCursor: 'older',
        viewer: null,
      }),
    }),
  )
  await flushPromises()
  const list = wrapper.get('[data-chat-log]').element as HTMLElement
  let height = 1000
  Object.defineProperty(list, 'scrollHeight', { get: () => height })
  Object.defineProperty(list, 'clientHeight', { value: 200 })
  list.scrollTop = 100
  await wrapper.get('[data-chat-log]').trigger('scroll')
  vi.spyOn(client, 'loadOlder').mockImplementation(async () => {
    height = 1300
  })
  await wrapper.get('[data-chat-history]').trigger('click')
  await flushPromises()
  expect(list.scrollTop).toBe(400)
  receive?.call(
    socket as unknown as WebSocket,
    new MessageEvent('message', {
      data: JSON.stringify({
        type: 'message',
        message: {
          id: 'new',
          userId: 'u',
          displayName: 'User',
          role: 'user',
          content: 'hello',
          type: 'text',
          createdAt: new Date().toISOString(),
        },
      }),
    }),
  )
  await flushPromises()
  expect(list.scrollTop).toBe(400)
  expect(wrapper.find('[data-chat-jump-latest]').exists()).toBe(true)
  await wrapper.get('[data-chat-jump-latest]').trigger('click')
  expect(list.scrollTop).toBe(1300)
  wrapper.unmount()
})
it('reconnects on session transitions without opening another chat surface', async () => {
  const client = make()
  const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
  const { useAccountSession } = await import('../account/session')
  useAccountSession().publish(true, 'new-user')
  expect(client.restart).toHaveBeenCalled()
  useAccountSession().publish(false)
  expect(client.restart).toHaveBeenCalledTimes(2)
  expect(wrapper.findAll('[data-chat-panel]')).toHaveLength(1)
  wrapper.unmount()
})
it('keeps Shift+Enter multiline and enforces 500 Unicode code points', async () => {
  const client = make()
  client.viewer.value = { userId: 'u', role: 'user' }
  client.state.value = 'connected'
  vi.spyOn(client, 'send').mockResolvedValue()
  const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
  const input = wrapper.get('[data-chat-composer]')
  await input.setValue('𠮷'.repeat(500))
  expect(wrapper.get('[data-chat-send]').attributes('disabled')).toBeUndefined()
  await input.trigger('keydown', { key: 'Enter', shiftKey: true })
  expect(client.send).not.toHaveBeenCalled()
  await input.setValue('𠮷'.repeat(501))
  expect(wrapper.get('[data-chat-send]').attributes('disabled')).toBeDefined()
  expect(input.attributes('aria-invalid')).toBe('true')
  expect(input.attributes('aria-describedby')).toContain('chat-composer-validation')
  expect(wrapper.get('[data-chat-validation]').text()).toContain('501')
  expect(wrapper.get('[data-chat-validation]').text()).toContain('500')
  await input.trigger('keydown', { key: 'Enter' })
  expect(client.send).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('sends allowlisted stickers and canonical current tracks without provider data', async () => {
  const client = make()
  client.viewer.value = { userId: 'u', role: 'user' }
  client.state.value = 'connected'
  vi.spyOn(client, 'send').mockResolvedValue()
  const currentTrack = {
    id: 'canonical-track',
    title: 'Study song',
    aliases: {},
    games: [],
    relationIds: [],
    tabs: [],
    workGroupId: 'work',
    needsClassification: false,
    vocalStatus: 'instrumental' as const,
    sources: [],
  }
  const wrapper = mount(ChatPanel, {
    props: { client, tracks: [currentTrack], currentTrack },
  })
  await wrapper.get('[data-chat-stickers]').trigger('click')
  await wrapper.get('[data-chat-sticker="tea"]').trigger('click')
  await flushPromises()
  expect(client.send).toHaveBeenCalledWith({
    type: 'sticker',
    text: '',
    stickerId: 'tea',
    showLocation: false,
  })
  await wrapper.get('[data-chat-share-track]').trigger('click')
  await flushPromises()
  expect(client.send).toHaveBeenCalledWith({
    type: 'track',
    text: '',
    trackId: 'canonical-track',
    showLocation: false,
  })
  wrapper.unmount()
})
it('localises sign-in controls in both Chinese locales', () => {
  for (const [locale, label] of [
    ['zh-Hant', '登入'],
    ['zh-Hans', '登录'],
  ] as const) {
    usePreferences().setLocale(locale)
    const wrapper = mount(ChatPanel, { props: { client: make(), tracks: [] } })
    expect(wrapper.text()).toContain(label)
    wrapper.unmount()
  }
  usePreferences().setLocale('en')
})

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
  it.each(['en', 'zh-Hant', 'zh-Hans'] as const)('shows connecting feedback during the authenticated handshake in %s', async (locale) => {
    usePreferences().setLocale(locale)
    useAccountSession().publish(true, 'known-user')
    const client = make()
    client.state.value = 'connecting'
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    const { translate } = await import('../../i18n')
    expect(wrapper.get('[data-chat-connecting]').text()).toBe(translate(locale, 'chat.connecting'))
    expect(wrapper.find('.chat-panel__signin').exists()).toBe(false)
    expect(wrapper.find('[data-chat-composer]').exists()).toBe(false)
    client.state.value = 'connected'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-chat-connecting]').exists()).toBe(false)
    // A verified account does not grant chat posting: the server viewer still decides.
    expect(wrapper.find('[data-chat-composer]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the account action available to anonymous readers while connecting', () => {
    usePreferences().setLocale('en')
    const client = make()
    client.state.value = 'connecting'
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    expect(wrapper.find('[data-chat-connecting]').exists()).toBe(true)
    expect(wrapper.find('.chat-panel__signin').exists()).toBe(true)
    wrapper.unmount()
  })

  it('still exposes a connection failure without a redundant connected row', () => {
    usePreferences().setLocale('en')
    const client = make()
    client.state.value = 'disconnected'
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })
    expect(wrapper.get('[role="alert"]').text()).toContain('Disconnected')
    wrapper.unmount()
  })
  it('omits redundant presence and moderation status while keeping chat usable', () => {
    usePreferences().setLocale('en')
    const client = make()
    client.viewer.value = { userId: 'owner', role: 'owner' }
    client.state.value = 'connected'
    client.participants.value = 3
    client.ownerOnline.value = true
    client.adminOnline.value = true

    const wrapper = mount(ChatPanel, { props: { client, tracks: [] } })

    expect(wrapper.find('[data-chat-presence]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Manage chat room')
    expect(wrapper.text()).not.toContain('Connected')
    expect(wrapper.text()).not.toContain('3 in the lounge')
    expect(wrapper.text()).not.toContain('Owner online')
    expect(wrapper.find('[data-chat-composer]').exists()).toBe(true)
    wrapper.unmount()
  })

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
  useAccountSession().publish(true, 'new-user')
  expect(client.restart).toHaveBeenCalledTimes(1)
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

describe('StudyWithMiku-style chat log', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 24, 8, minutes)).toISOString()
  const message = (id: string, userId: string | null, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, userId, displayName: userId ? userId.toUpperCase() : '', role: 'user', content: `text ${id}`,
    type: 'text', stickerId: null, trackId: null, location: null, replyToId: null,
    createdAt: at(minutes), updatedAt: null, deletedAt: null, ...extra,
  })
  function connected(messages: unknown[], viewer: { userId: string; role: string } | null = { userId: 'me', role: 'user' }) {
    usePreferences().setLocale('en')
    window.localStorage.clear()
    const socket = { onmessage: null as ((event: MessageEvent) => void) | null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn(), readyState: 1 }
    const client = createChatClient({
      socket: () => socket as never,
      request: async () => Response.json({ messages: [], nextCursor: null }),
    })
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] }, attachTo: document.body })
    const deliver = (data: unknown) => socket.onmessage?.call(socket as never, new MessageEvent('message', { data: JSON.stringify(data) }))
    deliver({ type: 'snapshot', messages, nextCursor: null, viewer })
    return { client, wrapper, deliver }
  }

  it('groups consecutive messages from one author within ten minutes under one header', async () => {
    const { wrapper } = connected([
      message('a1', 'alice', 0), message('a2', 'alice', 3), message('b1', 'bob', 4),
      message('a3', 'alice', 5), message('a4', 'alice', 30), message('d1', null, 31), message('d2', null, 32),
    ])
    await flushPromises()
    const groups = wrapper.findAll('[data-chat-group]')
    expect(groups.map((group) => group.findAll('[data-chat-message]').length)).toEqual([2, 1, 1, 1, 1, 1])
    expect(groups[0]!.findAll('.chat-group__name')).toHaveLength(1)
    expect(groups[0]!.get('[data-chat-avatar]').text()).toBe('A')
    // The same author always gets the same avatar colour.
    expect(groups[0]!.get('[data-chat-avatar]').attributes('style'))
      .toBe(groups[2]!.get('[data-chat-avatar]').attributes('style'))
    wrapper.unmount()
  })

  it('replies with a quote and sends the replied message id', async () => {
    const { client, wrapper } = connected([message('a1', 'alice', 0, { content: 'What are you studying?' })])
    await flushPromises()
    const send = vi.spyOn(client, 'send').mockResolvedValue()
    await wrapper.get('[data-chat-reply="a1"]').trigger('click')
    expect(wrapper.get('[data-chat-replying]').text()).toContain('Replying to ALICE')
    expect(wrapper.get('[data-chat-replying]').text()).toContain('What are you studying?')
    await wrapper.get('[data-chat-composer]').setValue('Maths')
    await wrapper.get('form.chat-panel__composer').trigger('submit')
    await flushPromises()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', text: 'Maths', replyToId: 'a1' }))
    expect(wrapper.find('[data-chat-replying]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the quoted message, or says it is unavailable, and cancels a reply with Escape', async () => {
    const { wrapper } = connected([
      message('a1', 'alice', 0, { content: 'Original question' }),
      message('m1', 'me', 1, { content: 'Answer', replyToId: 'a1' }),
      message('m2', 'me', 2, { content: 'Old answer', replyToId: 'gone' }),
    ])
    await flushPromises()
    expect(wrapper.get('[data-chat-quote="a1"]').text()).toContain('Original question')
    expect(wrapper.get('[data-chat-quote="gone"]').text()).toBe('The original message is unavailable')
    await wrapper.get('[data-chat-reply="a1"]').trigger('click')
    await wrapper.get('[data-chat-composer]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-chat-replying]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('counts unread messages from others on the jump control while reading history', async () => {
    const { wrapper, deliver } = connected([message('a1', 'alice', 0), message('a2', 'alice', 1)])
    await flushPromises()
    const list = wrapper.get('[data-chat-log]').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
    list.scrollTop = 0
    await wrapper.get('[data-chat-log]').trigger('scroll')
    deliver({ type: 'message', message: message('b1', 'bob', 2) })
    deliver({ type: 'message', message: message('m1', 'me', 3) })
    deliver({ type: 'message', message: message('b2', 'bob', 4) })
    await flushPromises()
    const jump = wrapper.get('[data-chat-jump-latest]')
    expect(jump.attributes('data-chat-unread')).toBe('2')
    expect(jump.attributes('aria-label')).toBe('2 new messages')
    await jump.trigger('click')
    expect(list.scrollTop).toBe(2000)
    expect(wrapper.find('[data-chat-jump-latest]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('starts a new header when the location shown for a message changes', async () => {
    const { wrapper } = connected([
      message('a1', 'alice', 0, { location: 'TW' }), message('a2', 'alice', 1, { location: null }),
      message('a3', 'alice', 2, { location: null }),
    ])
    await flushPromises()
    expect(wrapper.findAll('[data-chat-group]').map((group) => group.findAll('[data-chat-message]').length)).toEqual([1, 2])
    wrapper.unmount()
  })

  it('loads older pages to restore a reading position beyond the first page', async () => {
    usePreferences().setLocale('en')
    window.localStorage.clear()
    window.localStorage.setItem('study-with-hoyomix.chat-reading.v1', JSON.stringify({
      atBottom: false, anchorId: 'old1', anchorOffset: 0, lastSeenId: 'old1', savedAt: Date.now(),
    }))
    const socket = { onmessage: null as ((event: MessageEvent) => void) | null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn(), readyState: 1 }
    const request = vi.fn(async () => Response.json({ messages: [message('old1', 'bob', 0)], nextCursor: null }))
    const client = createChatClient({ socket: () => socket as never, request })
    const wrapper = mount(ChatPanel, { props: { client, tracks: [] }, attachTo: document.body })
    socket.onmessage?.call(socket as never, new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', messages: [message('new1', 'alice', 30)], nextCursor: 'older', viewer: null }),
    }))
    await flushPromises()
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-chat-message="old1"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('loads older messages when the reader scrolls up to the top', async () => {
    const { client, wrapper } = connected([message('a1', 'alice', 0)])
    client.nextCursor.value = 'older'
    await flushPromises()
    const loadOlder = vi.spyOn(client, 'loadOlder').mockResolvedValue()
    const list = wrapper.get('[data-chat-log]').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
    list.scrollTop = 500
    await wrapper.get('[data-chat-log]').trigger('scroll')
    list.scrollTop = 20
    await wrapper.get('[data-chat-log]').trigger('scroll')
    await flushPromises()
    expect(loadOlder).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('chatThread helpers', async () => {
  const { avatarInitial, avatarHue, truncateSummary } = await import('./chatThread')
  it('takes the first user-perceived character and a stable hue', () => {
    expect(avatarInitial('élan')).toBe('É')
    expect(avatarInitial('👩‍💻 dev')).toBe('👩‍💻')
    expect(avatarInitial('  ')).toBe('?')
    expect(avatarHue('alice')).toBe(avatarHue('alice'))
    expect(avatarHue('alice') % 30).toBe(0)
  })
  it('summarises long quotes without splitting characters', () => {
    expect(truncateSummary('a\n b')).toBe('a b')
    expect(truncateSummary('x'.repeat(41))).toBe(`${'x'.repeat(40)}…`)
  })
})

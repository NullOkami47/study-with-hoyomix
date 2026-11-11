import { describe, expect, it, vi, afterEach } from 'vitest'
import { createChatClient, type ChatMessage } from './client'
class Socket {
  static instances: Socket[] = []
  onmessage: WebSocket['onmessage'] = null
  onclose: WebSocket['onclose'] = null
  onerror: WebSocket['onerror'] = null
  close = vi.fn()
  send = vi.fn()
  readyState = 1
  constructor() {
    Socket.instances.push(this)
  }
  receiveRaw(data: string) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent('message', { data }),
    )
  }
  receive(value: unknown) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent('message', { data: JSON.stringify(value) }),
    )
  }
}
const message = (id: string, content = id): ChatMessage => ({
  id,
  userId: 'u',
  displayName: 'Reader',
  role: 'user',
  content,
  type: 'text',
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: null,
  deletedAt: null,
  location: null,
})
describe('community transport', () => {
  afterEach(() => {
    vi.useRealTimers()
    Socket.instances = []
  })
  it('deduplicates broadcasts, keeps edits over racing history and applies deletions', async () => {
    let resolve!: (value: Response) => void
    const client = createChatClient({
      socket: () => new Socket(),
      request: () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    })
    client.start()
    const ws = Socket.instances[0]!
    ws.receive({
      type: 'snapshot',
      messages: [message('b')],
      nextCursor: 'older',
      viewer: { userId: 'u', role: 'user' },
      blockedUserIds: [],
      participants: 2,
    })
    const history = client.loadOlder()
    ws.receive({ type: 'message', message: message('a', 'edited') })
    ws.receive({ type: 'delete', id: 'b' })
    resolve(
      Response.json({
        messages: [message('a', 'old'), message('b')],
        nextCursor: null,
      }),
    )
    await history
    expect(client.messages.value.map((m) => m.content)).toEqual(['edited'])
    client.stop()
    expect(ws.close).toHaveBeenCalledOnce()
  })
  it('waits for server acknowledgement and keeps failed sends out of the log', async () => {
    const client = createChatClient({
      socket: () => new Socket(),
      request: async () =>
        Response.json({ error: 'rate_limited' }, { status: 429 }),
    })
    client.start()
    Socket.instances[0]!.receive({
      type: 'snapshot',
      messages: [],
      viewer: { userId: 'u', role: 'user' },
    })
    await expect(client.send({ type: 'text', text: 'hello' })).rejects.toThrow(
      'rate_limited',
    )
    expect(client.messages.value).toEqual([])
    client.stop()
  })
  it('closes the old socket on account transitions and stops reconnect after close', () => {
    vi.useFakeTimers()
    const client = createChatClient({ socket: () => new Socket() })
    client.start()
    client.restart()
    expect(Socket.instances[0]!.close).toHaveBeenCalledOnce()
    expect(Socket.instances).toHaveLength(2)
    Socket.instances[1]!.onclose?.call(
      Socket.instances[1] as unknown as WebSocket,
      new CloseEvent('close'),
    )
    client.stop()
    vi.runAllTimers()
    expect(Socket.instances).toHaveLength(2)
  })
})

it('uses a hibernation heartbeat and releases it on close', () => {
  vi.useFakeTimers()
  const socket = new Socket()
  const client = createChatClient({ socket: () => socket })
  client.start()
  socket.receive({ type: 'snapshot', messages: [] })
  vi.advanceTimersByTime(30000)
  expect(socket.send).toHaveBeenCalledWith('ping')
  socket.receiveRaw('pong')
  expect(client.state.value).toBe('connected')
  client.stop()
  socket.send.mockClear()
  vi.advanceTimersByTime(90000)
  expect(socket.send).not.toHaveBeenCalled()
  vi.useRealTimers()
})
it('reuses the request ID after an ambiguous send failure', async () => {
  const bodies: string[] = []
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body))
    if (bodies.length === 1) throw new Error('network')
    return Response.json({ message: message('ack') })
  })
  const client = createChatClient({ request })
  await expect(client.send({ type: 'text', text: 'hello' })).rejects.toThrow()
  await client.send({ type: 'text', text: 'hello' })
  expect(JSON.parse(bodies[0]!).requestId).toBe(
    JSON.parse(bodies[1]!).requestId,
  )
  client.stop()
})
it('replaces stale loaded messages with the authoritative reconnect snapshot', () => {
  const client = createChatClient({ socket: () => new Socket() })
  client.start()
  Socket.instances
    .at(-1)!
    .receive({ type: 'snapshot', messages: [message('a'), message('b')] })
  Socket.instances
    .at(-1)!
    .receive({ type: 'snapshot', messages: [message('c')] })
  expect(client.messages.value.map((m) => m.id)).toEqual(['c'])
  client.stop()
})

it('fences stale history and block requests across an account switch', async () => {
  let resolve!: (value: Response) => void
  const client = createChatClient({
    socket: () => new Socket(),
    request: () =>
      new Promise<Response>((r) => {
        resolve = r
      }),
  })
  client.start()
  Socket.instances.at(-1)!.receive({
    type: 'snapshot',
    messages: [message('old')],
    viewer: { userId: 'old-user', role: 'user' },
    nextCursor: 'older',
  })
  const pending = client.loadOlder()
  client.restart()
  Socket.instances.at(-1)!.receive({
    type: 'snapshot',
    messages: [message('new')],
    viewer: { userId: 'new-user', role: 'user' },
  })
  resolve(Response.json({ messages: [message('leak')], nextCursor: 'private' }))
  await pending
  expect(client.messages.value.map((m) => m.id)).toEqual(['new'])
  expect(client.nextCursor.value).toBeNull()
  const block = client.block('blocked')
  client.restart()
  resolve(Response.json({ ok: true }))
  await block
  expect(client.blockedUserIds.value).toEqual([])
  client.stop()
})
it('hides blocked authors and restores them after an acknowledged unblock', async () => {
  const client = createChatClient({
    socket: () => new Socket(),
    request: async () => Response.json({ ok: true }),
  })
  client.start()
  Socket.instances.at(-1)!.receive({
    type: 'snapshot',
    messages: [message('hidden')],
    blockedUserIds: ['u'],
  })
  expect(client.messages.value).toEqual([])
  Socket.instances
    .at(-1)!
    .receive({ type: 'message', message: message('hidden') })
  expect(client.announcement.value).toBe('')
  await client.block('u', false)
  expect(client.messages.value.map((m) => m.id)).toEqual(['hidden'])
  client.stop()
})
it('retries a socket that never returns its initial snapshot', () => {
  vi.useFakeTimers()
  const initial = Socket.instances.length
  const client = createChatClient({ socket: () => new Socket() })
  client.start()
  vi.advanceTimersByTime(16000)
  expect(Socket.instances.length).toBeGreaterThan(initial + 1)
  client.stop()
  vi.useRealTimers()
})
it('preserves an ambiguous send receipt across server reset resynchronisation', async () => {
  const bodies: string[] = []
  const client = createChatClient({
    socket: () => new Socket(),
    request: async (_url, init) => {
      bodies.push(String(init?.body))
      if (bodies.length === 1) throw new Error('network')
      return Response.json({ message: message('ack') })
    },
  })
  client.start()
  await expect(client.send({ type: 'text', text: 'same' })).rejects.toThrow(
    'network',
  )
  Socket.instances.at(-1)!.receive({ type: 'reset' })
  await client.send({ type: 'text', text: 'same' })
  expect(JSON.parse(bodies[0]!).requestId).toBe(
    JSON.parse(bodies[1]!).requestId,
  )
  client.stop()
})

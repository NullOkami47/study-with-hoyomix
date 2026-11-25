// Wave E exploration (task 17, M-10 / design Property 7). The catch-up cap encodes the expected
// behaviour and FAILS on the unfixed tree, which pages up to 200 times after one reconnect. The
// merge-equivalence and blocked-author properties pin the original sort-based merge() as the
// oracle that the fixed insert-merge must still equal; they hold on the unfixed tree by design.
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  receive(value: unknown) {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data: JSON.stringify(value) }))
  }
  drop() {
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close'))
  }
}

const CATCH_UP_PAGE_CAP = 3
const message = (id: string, createdAt: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  userId: 'u',
  displayName: 'Reader',
  role: 'user',
  content: id,
  type: 'text',
  createdAt,
  updatedAt: null,
  deletedAt: null,
  location: null,
  ...extra,
})
const at = (second: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, second)).toISOString()

/** The original sort-based merge() from client.ts, kept verbatim as the test oracle (design H-02, M-10). */
function oracleMerge(current: ChatMessage[], incoming: ChatMessage[], deleted: Set<string>): ChatMessage[] {
  const map = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) {
    if (!m || typeof m.id !== 'string' || !m.id || !['text', 'sticker', 'track'].includes(m.type)) continue
    if (m.deletedAt) {
      map.delete(m.id)
      deleted.add(m.id)
    } else if (!deleted.has(m.id)) map.set(m.id, m)
  }
  return [...map.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-10000)
}

const settle = async (count: () => number) => {
  let previous = -1
  for (let stable = 0; stable < 10;) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (count() === previous) stable++
    else { stable = 0; previous = count() }
  }
}

describe('chat client catch-up is bounded and merge is order-preserving (Property 7)', () => {
  afterEach(() => {
    vi.useRealTimers()
    Socket.instances = []
  })

  it(`issues at most catchUpPageCap = ${CATCH_UP_PAGE_CAP} history requests per reconnect`, async () => {
    let historyRequests = 0
    const client = createChatClient({
      socket: () => new Socket(),
      request: async (input) => {
        if (String(input).includes('before=')) {
          historyRequests++
          // A long gap: no page ever reaches the message the client last saw.
          return Response.json({ messages: [message(`older-${historyRequests}`, at(10))], nextCursor: `cursor-${historyRequests}` })
        }
        return Response.json({})
      },
    })
    client.start()
    Socket.instances[0]!.receive({
      type: 'snapshot',
      messages: [message('seen-1', at(20)), message('seen-latest', at(21))],
      nextCursor: null,
      viewer: null,
      blockedUserIds: [],
      participants: 1,
    })
    vi.useFakeTimers()
    Socket.instances[0]!.drop()
    // The reconnect backoff for the first attempt is at most 1.2 s.
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    expect(Socket.instances).toHaveLength(2)
    Socket.instances[1]!.receive({
      type: 'snapshot',
      messages: [message('after-gap', at(500))],
      nextCursor: 'cursor-0',
      viewer: null,
      blockedUserIds: [],
      participants: 1,
    })
    await settle(() => historyRequests)
    client.stop()
    expect(historyRequests).toBeLessThanOrEqual(CATCH_UP_PAGE_CAP)
  })

  it('for any stream of snapshot and broadcast messages, the client list equals the sort-based merge() oracle', () => {
    const arbitraryMessage = fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
      second: fc.integer({ min: 0, max: 5 }),
      deleted: fc.boolean(),
      content: fc.string({ maxLength: 4 }),
    }).map(({ id, second, deleted, content }) => message(id, at(second), { content, deletedAt: deleted ? at(59) : null }))
    fc.assert(
      fc.property(fc.array(arbitraryMessage, { maxLength: 20 }), fc.array(arbitraryMessage, { maxLength: 40 }), (snapshot, stream) => {
        Socket.instances = []
        const client = createChatClient({ socket: () => new Socket(), request: async () => Response.json({}) })
        client.start()
        const ws = Socket.instances[0]!
        ws.receive({ type: 'snapshot', messages: snapshot, nextCursor: null, viewer: null, blockedUserIds: [], participants: 1 })
        const deleted = new Set<string>()
        let expected = oracleMerge([], snapshot, deleted)
        for (const item of stream) {
          ws.receive({ type: 'message', message: item })
          expected = oracleMerge(expected, [item], deleted)
        }
        const actual = client.messages.value.map((m) => `${m.id}@${m.createdAt}:${m.content}`)
        client.stop()
        expect(actual).toEqual(expected.map((m) => `${m.id}@${m.createdAt}:${m.content}`))
      }),
      { numRuns: 200 },
    )
  })

  it('keeps the newest 10,000 messages, de-duplicated by ID', () => {
    const client = createChatClient({ socket: () => new Socket(), request: async () => Response.json({}) })
    client.start()
    const many = Array.from({ length: 10_050 }, (_, index) => message(`m-${String(index).padStart(5, '0')}`, at(0)))
    Socket.instances[0]!.receive({ type: 'snapshot', messages: [...many, many[10_049]], nextCursor: null, viewer: null, blockedUserIds: [], participants: 1 })
    const ids = client.messages.value.map((m) => m.id)
    client.stop()
    expect(ids).toHaveLength(10_000)
    expect(ids[0]).toBe('m-00050')
    expect(ids.at(-1)).toBe('m-10049')
  })

  it('hides exactly the authors in blockedUserIds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.uuid(), author: fc.constantFrom('u1', 'u2', 'u3', null) }), { maxLength: 30 }),
        fc.subarray(['u1', 'u2', 'u3']),
        (rows, blocked) => {
          Socket.instances = []
          const client = createChatClient({ socket: () => new Socket(), request: async () => Response.json({}) })
          client.start()
          const items = rows.map((row, index) => message(row.id, at(index % 60), { userId: row.author }))
          Socket.instances[0]!.receive({ type: 'snapshot', messages: items, nextCursor: null, viewer: null, blockedUserIds: blocked, participants: 1 })
          const shown = new Set(client.messages.value.map((m) => m.id))
          client.stop()
          const expected = new Set(oracleMerge([], items, new Set()).filter((m) => !m.userId || !blocked.includes(m.userId)).map((m) => m.id))
          expect(shown).toEqual(expected)
        },
      ),
      { numRuns: 100 },
    )
  })
})

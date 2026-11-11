import { computed, ref } from 'vue'
export interface ChatMessage {
  id: string
  userId: string | null
  displayName: string
  role: string
  content: string
  type: 'text' | 'sticker' | 'track'
  stickerId?: string | null
  trackId?: string | null
  location: string | null
  createdAt: string
  updatedAt: string | null
  deletedAt: string | null
}
type ChatSocket = Pick<
  WebSocket,
  'onmessage' | 'onclose' | 'onerror' | 'close' | 'send' | 'readyState'
>
interface Page {
  messages: ChatMessage[]
  nextCursor: string | null
}
export interface ChatPayload {
  type: 'text' | 'sticker' | 'track'
  text: string
  stickerId?: string
  trackId?: string
  showLocation?: boolean
}
export function createChatClient(
  deps: {
    socket?: () => ChatSocket
    request?: typeof fetch
    handshakeTimeoutMs?: number
  } = {},
) {
  const messages = ref<ChatMessage[]>([]),
    state = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const viewer = ref<{ userId: string; role: string } | null>(null),
    blockedUserIds = ref<string[]>([]),
    participants = ref(0),
    ownerOnline = ref(false),
    adminOnline = ref(false)
  const nextCursor = ref<string | null>(null),
    loadingHistory = ref(false)
  const request =
    deps.request ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let socket: ChatSocket | undefined,
    active = false,
    epoch = 0,
    attempts = 0,
    timer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController(),
    sequence = 0
  let handshake: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined,
    heartbeatAt = 0
  let retryPayload: { key: string; requestId: string } | undefined
  const announcement = ref('')
  const touched = new Map<string, number>(),
    deleted = new Set<string>()
  function merge(incoming: ChatMessage[], historyAt?: number) {
    const map = new Map(messages.value.map((m) => [m.id, m]))
    for (const m of incoming) {
      if (
        !m ||
        typeof m.id !== 'string' ||
        !m.id ||
        !['text', 'sticker', 'track'].includes(m.type)
      )
        continue
      if (
        historyAt !== undefined &&
        ((touched.get(m.id) ?? 0) > historyAt || deleted.has(m.id))
      )
        continue
      if (m.deletedAt) {
        map.delete(m.id)
        deleted.add(m.id)
      } else if (!deleted.has(m.id)) map.set(m.id, m)
    }
    messages.value = [...map.values()]
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
      .slice(-10000)
  }
  async function http(path: string, init: RequestInit = {}) {
    const scope = controller.signal,
      local = new AbortController(),
      abort = () => local.abort()
    const timeout = setTimeout(abort, 15000)
    scope.addEventListener('abort', abort, { once: true })
    try {
      const response = await request('/api/chat' + path, {
        ...init,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: local.signal,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401 && scope === controller.signal) {
          viewer.value = null
          restart()
        }
        throw new Error(
          typeof body.error === 'string' ? body.error : 'unavailable',
        )
      }
      return body
    } finally {
      clearTimeout(timeout)
      scope.removeEventListener('abort', abort)
    }
  }
  async function page(cursor: string): Promise<Page> {
    return http('?limit=50&before=' + encodeURIComponent(cursor))
  }
  async function loadOlder() {
    if (loadingHistory.value || !nextCursor.value) return
    const generation = epoch,
      cursor = nextCursor.value,
      at = sequence
    loadingHistory.value = true
    try {
      const result = await page(cursor)
      if (generation !== epoch) return
      merge(result.messages, at)
      nextCursor.value = result.nextCursor
    } finally {
      if (generation === epoch) loadingHistory.value = false
    }
  }
  function disconnect() {
    epoch++
    clearTimeout(handshake)
    handshake = undefined
    clearInterval(heartbeat)
    heartbeat = undefined
    clearTimeout(timer)
    timer = undefined
    controller.abort()
    controller = new AbortController()
    loadingHistory.value = false
    if (socket) {
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
      socket = undefined
    }
  }
  function retry() {
    if (!active || timer) return
    disconnect()
    state.value = 'disconnected'
    viewer.value = null
    timer = setTimeout(
      () => {
        timer = undefined
        connect()
      },
      Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) *
        (0.8 + Math.random() * 0.4),
    )
  }
  function connect() {
    if (!active || socket) return
    const generation = epoch
    state.value = 'connecting'
    try {
      const connection =
        deps.socket?.() ??
        new WebSocket(
          new URL('/api/chat/socket', location.href.replace(/^http/, 'ws')),
        )
      socket = connection
      handshake = setTimeout(retry, deps.handshakeTimeoutMs ?? 12000)
      connection.onclose = retry
      connection.onerror = retry
      connection.onmessage = (event) => {
        if (generation !== epoch) return
        heartbeatAt = Date.now()
        if (event.data === 'pong') return
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'snapshot') {
            clearTimeout(handshake)
            handshake = undefined
            const previousLatest = messages.value.at(-1)?.id
            messages.value = []
            touched.clear()
            deleted.clear()
            merge(data.messages ?? [])
            nextCursor.value = data.nextCursor ?? null
            viewer.value = data.viewer ?? null
            blockedUserIds.value = data.blockedUserIds ?? []
            state.value = 'connected'
            attempts = 0
            clearInterval(heartbeat)
            heartbeatAt = Date.now()
            heartbeat = setInterval(() => {
              if (Date.now() - heartbeatAt > 65000) {
                retry()
                return
              }
              try {
                if (connection.readyState === 1) connection.send('ping')
              } catch {
                retry()
              }
            }, 25000)
            if (
              previousLatest &&
              !data.messages.some(
                (m: ChatMessage) => m.id === previousLatest,
              ) &&
              nextCursor.value
            ) {
              void (async () => {
                let cursor = nextCursor.value
                let count = 0
                while (cursor && generation === epoch && count++ < 200) {
                  const at = sequence
                  const result = await page(cursor)
                  if (generation !== epoch) return
                  merge(result.messages, at)
                  nextCursor.value = result.nextCursor
                  if (result.messages.some((m) => m.id === previousLatest))
                    break
                  cursor = result.nextCursor
                }
              })().catch(retry)
            }
          }
          if (data.type === 'snapshot' || data.type === 'presence') {
            participants.value = Math.max(0, Number(data.participants) || 0)
            ownerOnline.value = data.ownerOnline === true
            adminOnline.value = data.adminOnline === true
          }
          if (data.type === 'message') {
            if (!blockedUserIds.value.includes(data.message.userId))
              announcement.value =
                data.message.displayName +
                ': ' +
                (data.message.type === 'text' ? data.message.content : '')
            touched.set(data.message.id, ++sequence)
            merge([data.message])
          }
          if (data.type === 'delete') {
            deleted.add(data.id)
            touched.set(data.id, ++sequence)
            messages.value = messages.value.filter((m) => m.id !== data.id)
          }
          if (data.type === 'reset') restart(true)
        } catch {
          retry()
        }
      }
    } catch {
      retry()
    }
  }
  function start() {
    if (active) return
    active = true
    connect()
  }
  function restart(preserveReceipt = false) {
    announcement.value = ''
    if (!preserveReceipt) retryPayload = undefined
    disconnect()
    viewer.value = null
    messages.value = []
    blockedUserIds.value = []
    nextCursor.value = null
    touched.clear()
    deleted.clear()
    if (active) connect()
  }
  function stop() {
    active = false
    disconnect()
    state.value = 'disconnected'
    viewer.value = null
  }
  async function send(payload: ChatPayload) {
    const generation = epoch
    const key = JSON.stringify(payload)
    if (retryPayload?.key !== key)
      retryPayload = { key, requestId: crypto.randomUUID() }
    const result = await http('/messages', {
      method: 'POST',
      body: JSON.stringify({ ...payload, requestId: retryPayload.requestId }),
    })
    if (generation !== epoch) throw new Error('stale_session')
    if (result.message) {
      retryPayload = undefined
      touched.set(result.message.id, ++sequence)
      merge([result.message])
    } else throw new Error('invalid_ack')
  }
  async function edit(id: string, text: string) {
    const generation = epoch
    const result = await http('/messages/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    })
    if (generation !== epoch) throw new Error('stale_session')
    if (result.message) {
      touched.set(id, ++sequence)
      merge([result.message])
    } else throw new Error('invalid_ack')
  }
  async function remove(id: string) {
    const generation = epoch
    await http('/messages/' + encodeURIComponent(id), { method: 'DELETE' })
    if (generation === epoch) {
      deleted.add(id)
      messages.value = messages.value.filter((m) => m.id !== id)
    }
  }
  async function report(messageId: string, reason: string) {
    await http('/reports', {
      method: 'POST',
      body: JSON.stringify({ messageId, reason }),
    })
  }
  async function block(userId: string, blocked = true) {
    const generation = epoch
    await http('/blocks' + (blocked ? '' : '/' + encodeURIComponent(userId)), {
      method: blocked ? 'POST' : 'DELETE',
      body: blocked ? JSON.stringify({ userId }) : undefined,
    })
    if (generation === epoch)
      blockedUserIds.value = blocked
        ? [...new Set([...blockedUserIds.value, userId])]
        : blockedUserIds.value.filter((id) => id !== userId)
  }
  return {
    announcement,
    messages: computed(() =>
      messages.value.filter(
        (m) => !m.userId || !blockedUserIds.value.includes(m.userId),
      ),
    ),
    state,
    viewer,
    participants,
    ownerOnline,
    adminOnline,
    blockedUserIds,
    nextCursor,
    loadingHistory,
    start,
    stop,
    restart,
    loadOlder,
    send,
    edit,
    remove,
    report,
    block,
  }
}
export type ChatClient = ReturnType<typeof createChatClient>

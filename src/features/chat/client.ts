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
  /** The message this one answers, when it is a reply. Older servers omit it. */
  replyToId?: string | null
  createdAt: string
  updatedAt: string | null
  deletedAt: string | null
}
/**
 * Mirrors `replyTextLimit` in workers/chat/protocol.ts: the stored reply marker shares the
 * 500-character content budget, so a reply's own text is slightly shorter.
 */
export const CHAT_MESSAGE_LIMIT = 500
export const replyTextLimit = (replyToId: string): number =>
  CHAT_MESSAGE_LIMIT - '\u001freply:'.length - replyToId.length - 1
type ChatSocket = Pick<
  WebSocket,
  'onmessage' | 'onclose' | 'onerror' | 'close' | 'send' | 'readyState'
>
interface Page {
  messages: ChatMessage[]
  nextCursor: string | null
}
/** History pages fetched automatically after a reconnect; older ones load on demand (M-10). */
export const CATCH_UP_PAGE_CAP = 3
/** How account deletion anonymises retained rows (workers/library/repository.ts). */
const DELETED_AUTHOR = { userId: null, displayName: 'Deleted user', role: 'user', location: null }
// Same order as the server history: createdAt, then id.
const compareMessages = (a: ChatMessage, b: ChatMessage) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
/** First index whose message does not sort before `m` (binary search over a sorted list). */
function lowerBound(list: ChatMessage[], m: ChatMessage): number {
  let low = 0,
    high = list.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareMessages(list[middle]!, m) < 0) low = middle + 1
    else high = middle
  }
  return low
}
export interface ChatPayload {
  type: 'text' | 'sticker' | 'track'
  text: string
  stickerId?: string
  trackId?: string
  showLocation?: boolean
  replyToId?: string
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
    loadingHistory = ref(false),
    // True when reconnect catch-up stopped at CATCH_UP_PAGE_CAP before reaching the last
    // message seen: the older messages are behind the "load older" history control.
    catchUpGap = ref(false),
    // Delta state from the room (H-02): this viewer's ban, and the public send interval.
    ban = ref<{ until: string | null } | null>(null),
    intervalMs = ref<number | null>(null)
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
  let refreshTimer: ReturnType<typeof setTimeout> | undefined,
    resetAttempts = 0,
    lastResetAt = 0
  let retryPayload: { key: string; requestId: string } | undefined
  const announcement = ref('')
  const touched = new Map<string, number>(),
    deleted = new Set<string>()
  /**
   * Insert-merge into the already sorted list (M-10): each accepted message is placed by binary
   * search instead of re-sorting everything. Same result as the former sort-based merge: IDs are
   * unique, the newest 10,000 are kept, and a deleted ID never comes back.
   */
  function merge(incoming: ChatMessage[], historyAt?: number) {
    const list = messages.value.slice()
    let byId: Map<string, ChatMessage> | undefined
    const index = () => (byId ??= new Map(list.map((m) => [m.id, m])))
    const take = (existing: ChatMessage) => {
      let at = lowerBound(list, existing)
      if (list[at] !== existing) at = list.indexOf(existing)
      if (at >= 0) list.splice(at, 1)
      index().delete(existing.id)
    }
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
      const existing = index().get(m.id)
      if (m.deletedAt) {
        if (existing) take(existing)
        deleted.add(m.id)
      } else if (!deleted.has(m.id)) {
        if (existing) take(existing)
        list.splice(lowerBound(list, m), 0, m)
        index().set(m.id, m)
      }
    }
    if (list.length > 10000) list.splice(0, list.length - 10000)
    messages.value = list
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
      if (!result.nextCursor) catchUpGap.value = false
    } finally {
      if (generation === epoch) loadingHistory.value = false
    }
  }
  /**
   * `refresh`/`pruned` (H-02): after a random 0-10 s delay, refetch the first history page over
   * HTTP and replace the list with it, keeping the socket open. Socket updates that arrived
   * meanwhile win over the page, as with any history merge.
   */
  function scheduleRefresh() {
    if (refreshTimer) return
    const generation = epoch
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (generation !== epoch) return
      const at = sequence
      void http('')
        .then((result: Page) => {
          if (generation !== epoch) return
          messages.value = messages.value.filter((m) => (touched.get(m.id) ?? 0) > at)
          merge(result.messages ?? [], at)
          nextCursor.value = result.nextCursor ?? null
          catchUpGap.value = false
        })
        .catch(() => {
          /* The next snapshot (reconnect) converges the list. */
        })
    }, Math.random() * 10000)
  }
  function disconnect() {
    epoch++
    clearTimeout(refreshTimer)
    refreshTimer = undefined
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
          // `deltas=1` announces delta-event support, so the room stops sending `reset`.
          new URL('/api/chat/socket?deltas=1', location.href.replace(/^http/, 'ws')),
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
            catchUpGap.value = false
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
                // Bounded catch-up (M-10): at most CATCH_UP_PAGE_CAP pages; anything older
                // stays behind the on-demand "load older" control (catchUpGap).
                let cursor = nextCursor.value
                let count = 0
                while (cursor && generation === epoch && count < CATCH_UP_PAGE_CAP) {
                  count++
                  const at = sequence
                  const result = await page(cursor)
                  if (generation !== epoch) return
                  merge(result.messages, at)
                  nextCursor.value = result.nextCursor
                  if (result.messages.some((m) => m.id === previousLatest)) return
                  cursor = result.nextCursor
                }
                if (generation === epoch && cursor) catchUpGap.value = true
              })().catch(retry)
            }
          }
          if (data.type === 'snapshot' || data.type === 'presence') {
            participants.value = Math.max(0, Number(data.participants) || 0)
            ownerOnline.value = data.ownerOnline === true
            adminOnline.value = data.adminOnline === true
          }
          if (data.type === 'message') {
            if (!new Set(blockedUserIds.value).has(data.message.userId))
              announcement.value =
                data.message.displayName +
                ': ' +
                (data.message.type === 'text' ? data.message.content : '')
            touched.set(data.message.id, ++sequence)
            merge([data.message])
          }
          if (data.type === 'delete' || data.type === 'message_removed') {
            deleted.add(data.id)
            touched.set(data.id, ++sequence)
            messages.value = messages.value.filter((m) => m.id !== data.id)
          }
          // Targeted deltas (H-02); the socket stays open.
          if (data.type === 'viewer') {
            viewer.value = data.viewer ?? null
            blockedUserIds.value = Array.isArray(data.blockedUserIds) ? data.blockedUserIds : []
            if (!viewer.value) ban.value = null
          }
          if (data.type === 'author_removed' && typeof data.userId === 'string') {
            messages.value = messages.value.map((m) =>
              // L-21 (D7): account deletion also clears the text of retained messages.
              m.userId === data.userId ? { ...m, ...DELETED_AUTHOR, content: '' } : m,
            )
          }
          if (data.type === 'ban' && data.userId === viewer.value?.userId)
            ban.value = data.banned ? { until: data.until ?? null } : null
          if (data.type === 'settings' && Number.isFinite(Number(data.intervalMs)))
            intervalMs.value = Number(data.intervalMs)
          if (data.type === 'refresh' || data.type === 'pruned') scheduleRefresh()
          if (data.type === 'reset') resync()
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
    catchUpGap.value = false
    ban.value = null
    touched.clear()
    deleted.clear()
    if (active) connect()
  }
  /**
   * Server `reset` (older rooms, or sockets the room treats as legacy): drop the privileged view
   * now, then reconnect after a full-jitter exponential backoff (1 s base, 30 s cap) so a
   * room-wide reset does not make every client reconnect at once. The list stays visible until
   * the new snapshot replaces it; the ambiguous send receipt is kept.
   */
  function resync() {
    const now = Date.now()
    if (now - lastResetAt > 60000) resetAttempts = 0
    lastResetAt = now
    const delay = Math.random() * Math.min(30000, 1000 * 2 ** Math.min(resetAttempts++, 5))
    announcement.value = ''
    disconnect()
    viewer.value = null
    ban.value = null
    nextCursor.value = null
    catchUpGap.value = false
    if (!active) return
    state.value = 'connecting'
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
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
    const pending = retryPayload
    let result
    try {
      result = await http('/messages', {
        method: 'POST',
        body: JSON.stringify({ ...payload, requestId: pending.requestId }),
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'request_id_expired' &&
          generation === epoch && retryPayload === pending) retryPayload = undefined
      throw error
    }
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
    messages: computed(() => {
      const hidden = new Set(blockedUserIds.value)
      return messages.value.filter((m) => !m.userId || !hidden.has(m.userId))
    }),
    state,
    viewer,
    participants,
    ownerOnline,
    adminOnline,
    blockedUserIds,
    nextCursor,
    loadingHistory,
    catchUpGap,
    ban,
    intervalMs,
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

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAccountSession } from '../account/session'

/** One lifecycle per mounted FocusBar. Browser-local random ID deduplicates tabs; no fingerprint. */
export function usePresence() {
  const count = ref<number | null>(null)
  const ownerOnline = ref(false)
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stopped = true
  let generation = 0
  let attempt = 0
  let lastMessage = 0
  const unavailable = () => { count.value = null; ownerOnline.value = false }
  const clear = () => {
    if (retry) clearTimeout(retry)
    if (heartbeat) clearInterval(heartbeat)
    retry = undefined; heartbeat = undefined
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); socket = undefined }
    unavailable()
  }
  const schedule = () => {
    if (stopped || retry) return
    retry = setTimeout(() => { retry = undefined; void connect() }, Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 500)
  }
  const connect = async () => {
    const current = ++generation
    clear()
    if (stopped || typeof WebSocket === 'undefined') return
    try {
      let visitor = ''
      try {
        visitor = localStorage.getItem('hoyomix-presence-visitor') ?? ''
        if (!/^[a-f0-9-]{36}$/.test(visitor)) { visitor = crypto.randomUUID(); localStorage.setItem('hoyomix-presence-visitor', visitor) }
      } catch { /* Server cookie still deduplicates tabs when storage is blocked. */ }
      const response = await fetch('/api/presence/visitor', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'text/plain' }, body: visitor })
      if (!response.ok) throw new Error('presence_unavailable')
      if (stopped || current !== generation) return
      const url = new URL('/api/presence', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const active = new WebSocket(url)
      socket = active
      active.onopen = () => {
        attempt = 0; lastMessage = Date.now()
        active.send('ping')
        active.send('refresh')
        heartbeat = setInterval(() => {
          if (Date.now() - lastMessage > 75_000) { clear(); schedule(); return }
          if (active.readyState === WebSocket.OPEN) active.send('ping')
        }, 25_000)
      }
      active.onmessage = (event) => {
        lastMessage = Date.now()
        if (event.data === 'pong') return
        try {
          const data = JSON.parse(event.data) as { type?: string; count?: number; ownerOnline?: boolean }
          if (data.type !== 'presence' || !Number.isSafeInteger(data.count) || data.count! < 0 || typeof data.ownerOnline !== 'boolean') return
          count.value = data.count!; ownerOnline.value = data.ownerOnline
        } catch { /* Untrusted messages cannot replace a valid aggregate. */ }
      }
      active.onclose = active.onerror = () => { if (socket !== active) return; clear(); schedule() }
    } catch { if (current === generation && !stopped) schedule() }
  }
  const refresh = () => { if (!stopped) void connect() }
  const onOffline = () => { generation++; clear() }
  const stopSessionWatch = watch(useAccountSession().revision, () => {
    try { localStorage.setItem('hoyomix-presence-auth', `${Date.now()}-${Math.random()}`) } catch { /* Optional cross-tab hint. */ }
    refresh()
  })
  const onPageHide = () => { stopped = true; generation++; clear() }
  const onPageShow = () => { if (stopped) { stopped = false; void connect() } }
  const onStorage = (event: StorageEvent) => { if (event.key === 'hoyomix-presence-auth') refresh() }
  onMounted(() => {
    stopped = false
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', onOffline)
    window.addEventListener('storage', onStorage)
    void connect()
  })
  onBeforeUnmount(() => {
    stopped = true; generation++; clear(); stopSessionWatch()
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', refresh)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('storage', onStorage)
  })
  return { count: computed(() => count.value), ownerOnline: computed(() => ownerOnline.value) }
}

import { onBeforeUnmount, onMounted, ref } from 'vue'
import { dayKeyAt } from './statistics'

/** Refresh calendar-day statistics without making timer ticks rerender the UI. */
export function useFocusNow(timeZone: () => string) {
  const now = ref(new Date().toISOString())
  let timer: ReturnType<typeof setInterval> | undefined
  function refresh() {
    const next = new Date().toISOString()
    if (dayKeyAt(next, timeZone()) !== dayKeyAt(now.value, timeZone())) now.value = next
  }
  onMounted(() => {
    // One cheap day comparison per minute also handles an open summary at midnight.
    timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
  })
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  })
  return () => {
    // Day changes invalidate consumers; session changes still read the actual
    // current instant, including a completion just after midnight.
    void now.value
    return new Date().toISOString()
  }
}

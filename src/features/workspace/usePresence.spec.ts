import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePresence } from './usePresence'
import { resetAccountSession, useAccountSession } from '../account/session'

class MockSocket {
  static OPEN = 1
  static instances: MockSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(public url: URL) { MockSocket.instances.push(this) }
}
beforeEach(() => { vi.useFakeTimers(); resetAccountSession(); MockSocket.instances = []; vi.stubGlobal('WebSocket', MockSocket); vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true })); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const settle = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve() }
function render() {
  return mount(defineComponent({ setup() { return { presence: usePresence() } }, template: '<div>{{ presence.count.value === null ? "unavailable" : presence.count.value }} {{ presence.ownerOnline.value }}</div>' }))
}
it('requests one initial aggregate while subsequent heartbeats only ping', async () => {
  const wrapper = render(); await settle()
  const socket = MockSocket.instances[0]
  socket.onopen!()
  expect(socket.send.mock.calls.map(call => call[0])).toEqual(['ping', 'refresh'])
  socket.onmessage!({ data: 'pong' })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.send.mock.calls.map(call => call[0])).toEqual(['ping', 'refresh', 'ping'])
  wrapper.unmount()
})
it('starts unknown, accepts only valid backend aggregates, and clears stale Owner/count on disconnect', async () => {
  const wrapper = render(); await settle()
  const socket = MockSocket.instances[0]
  expect(wrapper.text()).toBe('unavailable false')
  socket.onopen!()
  socket.onmessage!({ data: JSON.stringify({ type: 'presence', count: 12, ownerOnline: true }) }); await nextTick()
  expect(wrapper.text()).toBe('12 true')
  socket.onmessage!({ data: '{"type":"presence","count":-1,"ownerOnline":true}' }); await nextTick()
  expect(wrapper.text()).toBe('12 true')
  socket.onclose!(); await nextTick()
  expect(wrapper.text()).toBe('unavailable false')
  await vi.advanceTimersByTimeAsync(1600); await settle()
  expect(MockSocket.instances).toHaveLength(2)
  wrapper.unmount()
  expect(MockSocket.instances[1].close).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('refreshes the authenticated socket on session changes and closes on pagehide', async () => {
  const wrapper = render(); await settle()
  useAccountSession().publish(true); await settle()
  expect(MockSocket.instances).toHaveLength(2)
  expect(MockSocket.instances[0].close).toHaveBeenCalled()
  window.dispatchEvent(new Event('pagehide')); await nextTick()
  expect(MockSocket.instances[1].close).toHaveBeenCalled()
  expect(wrapper.text()).toBe('unavailable false')
  window.dispatchEvent(new Event('pageshow')); await settle()
  expect(MockSocket.instances).toHaveLength(3)
  wrapper.unmount()
})

it('drops stale aggregates immediately when the browser reports offline, then reconnects online', async () => {
  const wrapper = render(); await settle()
  const socket = MockSocket.instances[0]
  socket.onmessage!({ data: JSON.stringify({ type: 'presence', count: 12, ownerOnline: true }) })
  await nextTick()
  expect(wrapper.text()).toBe('12 true')
  window.dispatchEvent(new Event('offline')); await nextTick()
  expect(wrapper.text()).toBe('unavailable false')
  expect(socket.close).toHaveBeenCalled()
  window.dispatchEvent(new Event('online')); await settle()
  expect(MockSocket.instances).toHaveLength(2)
  wrapper.unmount()
})

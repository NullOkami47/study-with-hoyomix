import { afterEach, vi } from 'vitest'

import { installTestLifecycle } from './lifecycle'

class TestWebSocket {
  static OPEN = 1
  readonly readyState = TestWebSocket.OPEN

  close() {}

  send() {}
}

if (typeof window !== 'undefined') {
  installTestLifecycle(afterEach)
  vi.stubGlobal('WebSocket', TestWebSocket)

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })

  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: () => Promise.resolve(),
  })
}

// Imported by the generated worker. A conversion on the first visit requests
// control before its dynamic import, so CacheFirst can save the first response.
// This never skips waiting or changes which build the user has accepted.
self.addEventListener('message', event => {
  if (event.data?.type !== 'CLAIM_FOR_CHINESE_TITLE' || !event.source?.id) return
  event.waitUntil(self.clients.claim().then(() => event.ports[0]?.postMessage({ controlled: true })))
})

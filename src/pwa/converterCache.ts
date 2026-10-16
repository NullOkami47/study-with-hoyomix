/** A fresh Chinese visit must load dictionaries through the activated worker.
 * Claim only on an actual conversion request; English installs retain the
 * existing prompt/update lifecycle. No waiting worker is skipped or activated.
 */
export async function prepareConverterCache(): Promise<void> {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return
  const channel = new MessageChannel()
  let timer: ReturnType<typeof setTimeout> | undefined
  let acknowledged = false
  let expired = false
  let controlled = () => {}
  try {
    await Promise.race([
      navigator.serviceWorker.ready.then(registration => new Promise<void>(resolve => {
        if (expired) return
        controlled = () => { if (acknowledged && navigator.serviceWorker.controller) resolve() }
        navigator.serviceWorker.addEventListener('controllerchange', controlled)
        channel.port1.onmessage = () => { acknowledged = true; controlled() }
        registration.active?.postMessage({ type: 'CLAIM_FOR_CHINESE_TITLE' }, [channel.port2])
      })),
      // Never download dictionaries outside worker control on a failed install.
      // Rejection retains the original readable title through the existing catch.
      new Promise<void>((_resolve, reject) => { timer = setTimeout(() => {
        expired = true
        reject(new Error('Chinese title cache controller unavailable'))
      }, 30_000) }),
    ])
  } finally {
    clearTimeout(timer)
    navigator.serviceWorker.removeEventListener('controllerchange', controlled)
    channel.port1.close()
    channel.port2.close()
  }
}

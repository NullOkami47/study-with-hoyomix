/** Bound Vkeys media headers and idle reads while retaining streaming and cancellation. */
export const createVkeysMediaFetch = (fetchImpl: typeof fetch): typeof fetch => async (input, init) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init?.signal?.addEventListener('abort', abort, { once: true })
  if (init?.signal?.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = () => new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('media_timeout')) }, 15_000)
  })
  const cleanup = () => { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort) }
  let response: Response
  try { response = await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }).then(value => {
    if (controller.signal.aborted) { void value.body?.cancel().catch(() => {}); throw new Error('media_timeout') }
    return value
  }), deadline()]) }
  catch { cleanup(); throw new Error('media_unavailable') }
  clearTimeout(timer)
  if (!response.body) { cleanup(); return response }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const chunk = await Promise.race([reader.read(), deadline()])
        clearTimeout(timer)
        if (chunk.done) { cleanup(); stream.close() } else stream.enqueue(chunk.value)
      } catch { cleanup(); controller.abort(); void reader.cancel().catch(() => {}); stream.error(new Error('media_unavailable')) }
    },
    cancel(reason) { cleanup(); controller.abort(); return reader.cancel(reason) },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

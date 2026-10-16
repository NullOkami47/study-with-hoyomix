export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false }

// F3: a response body can fail in materially different ways that previously collapsed into a
// single `{ ok: false }`. Callers that need to localise a failure (GD Studio) can use this
// discriminating result; the legacy `readBoundedJsonResponse` keeps its existing shape.
export type BoundedJsonResponseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'declared_too_large' | 'not_json_mime' | 'body_read' | 'invalid_json' }

export class BoundedJsonRequestError extends Error {}

const declaredLengthFits = (headers: Headers, maximum: number): boolean => {
  const value = headers.get('content-length')
  if (value === null) return true
  if (!/^[0-9]+$/.test(value)) return false
  const length = Number(value)
  return Number.isSafeInteger(length) && length <= maximum
}

const isJsonMime = (headers: Headers): boolean =>
  headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'

const readBoundedBytes = async (
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array | null> => {
  const reader = body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximum) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export const readBoundedJsonRequest = async (
  request: Request,
  maximum: number,
): Promise<unknown> => {
  if (!isJsonMime(request.headers) || !declaredLengthFits(request.headers, maximum)) {
    throw new BoundedJsonRequestError()
  }
  const bytes = await readBoundedBytes(request.body, maximum)
  if (!bytes) throw new BoundedJsonRequestError()
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new BoundedJsonRequestError()
  }
}

export const readBoundedJsonResponse = async (
  response: Response,
  maximum: number,
): Promise<BoundedJsonResult> => {
  const detailed = await readBoundedJsonResponseDetailed(response, maximum)
  return detailed.ok ? detailed : { ok: false }
}

// F3: distinguishes why a bounded response body was rejected. `body_read` covers headers having
// been received but the body failing to be consumed (including an abort mid-stream), which is a
// different boundary from `invalid_json`.
export const readBoundedJsonResponseDetailed = async (
  response: Response,
  maximum: number,
): Promise<BoundedJsonResponseResult> => {
  if (!isJsonMime(response.headers)) return { ok: false, reason: 'not_json_mime' }
  if (!declaredLengthFits(response.headers, maximum)) return { ok: false, reason: 'declared_too_large' }

  const bytes = await readBoundedBytes(response.body, maximum)
  if (!bytes) return { ok: false, reason: 'body_read' }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}
